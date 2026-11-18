import { AppLock } from '../schemas';
import { Context } from '../core/context';
import { fs, path, readEnv, saveEnv, exists, now, write, walk } from '../core/fs';
import { docker, compose, up, ensureVolume } from '../docker';
import { RESTIC_IMAGE, HELPER_IMAGE } from '../docker/images';
import { writeVolume } from '../docker/volumes';
import { hook, verifyApp } from '../apps/hooks';
import { OmaError, assert } from '../core/errors';
import { randomBytes } from 'node:crypto';
import { untar } from '../core/tar';
import { renderRoutes, syncRoutes } from '../routing';
import type { Operation } from '../core/operation';
export const reasons = ['nightly', 'pre-update', 'pre-remove', 'pre-restore', 'manual'] as const;
async function repositoryArgs(ctx: Context) {
  const config = await ctx.config(),
    repository = config.backup.repository;
  assert(repository, 'BACKUP_NOT_CONFIGURED', 'No backup repository configured', 3);
  if (/^(s3:|sftp:|rest:|azure:|gs:|b2:|swift:|rclone:)/.test(repository)) return [];
  return ['--mount', `type=bind,source=${path.resolve(repository)},target=/repository`];
}
export async function restic(
  ctx: Context,
  args: string[],
  mounts: string[] = [],
  options: { allowFailure?: boolean; timeout?: number } = {},
) {
  assert(
    await exists(ctx.p('secrets', 'backup.env')),
    'BACKUP_NOT_CONFIGURED',
    'Run omactl backup init first',
  );
  await ensureVolume(ctx, 'oma_restic_cache');
  return docker(
    ctx,
    [
      'run',
      '--rm',
      '--env-file',
      ctx.p('secrets', 'backup.env'),
      '--mount',
      'type=volume,source=oma_restic_cache,target=/cache',
      ...(await repositoryArgs(ctx)),
      ...mounts,
      RESTIC_IMAGE,
      '--cache-dir',
      '/cache',
      ...(!args.includes('forget') && !args.includes('prune') ? ['--no-lock'] : []),
      ...args,
    ],
    {
      timeout: options.timeout ?? Math.max(ctx.timeout, 900000),
      allowFailure: options.allowFailure,
    },
  );
}
export async function initBackup(
  ctx: Context,
  repository: string | undefined,
  values: Record<string, string>,
) {
  const config = await ctx.config();
  const requested = repository ?? config.backup.repository;
  assert(requested, 'REPOSITORY_REQUIRED', 'Pass --repository <path|s3:...>', 2);
  const remote = /^(s3:|sftp:|rest:|azure:|gs:|b2:|swift:|rclone:)/.test(requested);
  const target = remote ? requested : path.resolve(requested);
  config.backup.repository = target;
  await ctx.saveConfig(config);
  if (!remote) await fs.mkdir(path.resolve(target), { recursive: true, mode: 0o700 });
  const file = ctx.p('secrets', 'backup.env'),
    previous = await readEnv(file);
  const env = {
    ...previous,
    ...values,
    RESTIC_REPOSITORY: remote ? target : '/repository',
    RESTIC_PASSWORD:
      previous.RESTIC_PASSWORD ?? values.RESTIC_PASSWORD ?? randomBytes(32).toString('base64url'),
  };
  for (const v of Object.values(env)) ctx.secrets.add(v);
  for (const [key, value] of Object.entries(env))
    assert(
      /^[A-Z][A-Z0-9_]*$/.test(key) && !/[\r\n]/.test(value),
      'INVALID_BACKUP_ENV',
      'Backup environment must use uppercase keys and single-line values',
      2,
    );
  await write(
    file,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    0o600,
  );
  const probe = await restic(ctx, ['snapshots', '--json'], [], { allowFailure: true });
  if (probe.exitCode !== 0) await restic(ctx, ['init', '--json']);
  await restic(ctx, ['check']);
  return { repository: target, initialized: true };
}
export async function backupApp(ctx: Context, id: string, reason: string, op: Operation) {
  const app = await ctx.app(id),
    config = await ctx.config();
  assert(
    config.backup.repository,
    'BACKUP_NOT_CONFIGURED',
    'A backup repository is required before this change',
    3,
  );
  const pre = app.manifest.hooks.pre_backup;
  const before = await import('../docker').then((d) => d.containers(ctx, id));
  const startDumpService =
    !!pre && !before.some((c) => c.Service === pre.service && c.State === 'running');
  if (startDumpService) await up(ctx, id, [pre!.service]);
  try {
    await hook(ctx, id, 'pre_backup', op);
  } catch (e) {
    if (startDumpService) await compose(ctx, id, ['stop', pre!.service]);
    throw e;
  }
  const stage = `oma_backup_stage_${ctx.opId!.replace(/[^a-zA-Z0-9]/g, '_')}_${id}`;
  let stopped = false;
  try {
    const files: Record<string, Buffer> = {};
    for (const file of await walk(ctx.appDir(id)))
      if (/^(compose(?:\.[^.]+)?\.yml|app\.lock\.json|\.env|hooks\/.*)$/.test(file))
        files[`${id}/${file}`] = await fs.readFile(path.join(ctx.appDir(id), file));
    await writeVolume(ctx, stage, files);
    if (app.manifest.stop_during_backup && app.desired_state === 'running') {
      await compose(ctx, id, ['stop']);
      stopped = true;
    }
    const mounts = ['--mount', `type=volume,source=${stage},target=/config,readonly`];
    const paths = [`/config/${id}`];
    for (const v of app.manifest.volumes)
      if (v.backup === 'files') {
        await ensureVolume(ctx, `oma_${id}_${v.key}`);
        mounts.push(
          '--mount',
          `type=volume,source=oma_${id}_${v.key},target=/backup/${id}/${v.key},readonly`,
        );
        paths.push(`/backup/${id}/${v.key}`);
      }
    const tags = [
      `instance:${config.instance_id}`,
      `app:${id}`,
      `reason:${reason}`,
      `catalog:${app.catalog}`,
      `op:${ctx.opId}`,
    ];
    const result = await restic(
      ctx,
      [
        'backup',
        '--json',
        '--host',
        config.instance_id,
        ...tags.flatMap((t) => ['--tag', t]),
        ...paths,
      ],
      mounts,
    );
    const summary = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((v) => v.message_type === 'summary');
    assert(summary?.snapshot_id, 'BACKUP_FAILED', `${id}: no snapshot was returned`, 1);
    const latest = await ctx.app(id);
    latest.last_backup = {
      snapshot: summary.snapshot_id,
      at: now(),
      size: summary.total_bytes_processed ?? summary.data_added ?? 0,
    };
    await ctx.saveApp(latest);
    await op.snapshot(summary.snapshot_id);
    return { app: id, ok: true, snapshot: summary.snapshot_id };
  } finally {
    if (stopped) await up(ctx, id);
    if (startDumpService) await compose(ctx, id, ['stop', pre!.service]);
    await docker(ctx, ['volume', 'rm', stage], { allowFailure: true }).catch(() => {});
  }
}
export async function backupBeforeChange(
  ctx: Context,
  id: string,
  op: Operation,
  reason = 'manual',
  required = false,
) {
  const configured = (await ctx.config()).backup.repository;
  if (configured) return op.step(`Back up ${id} (${reason})`, () => backupApp(ctx, id, reason, op));
  if (required)
    throw new OmaError(
      'BACKUP_NOT_CONFIGURED',
      'Configure backups before this change',
      3,
      'Run: omactl backup init --repository <path|s3:...>',
    );
  ctx.warn(
    'BACKUP_NOT_CONFIGURED',
    `${id}: no pre-change backup; configure a repository with backup init`,
  );
  return null;
}
export async function listSnapshots(ctx: Context, app?: string, reason?: string) {
  const config = await ctx.config();
  const tags = [
    `instance:${config.instance_id}`,
    ...(app ? [`app:${app}`] : []),
    ...(reason ? [`reason:${reason}`] : []),
  ];
  const result = await restic(ctx, ['snapshots', '--json', '--tag', tags.join(',')]);
  return JSON.parse(result.stdout || '[]') as any[];
}
export async function selectSnapshot(ctx: Context, id: string, snapshot?: string, latest = false) {
  assert(snapshot || latest, 'SNAPSHOT_REQUIRED', 'Pass --snapshot <id> or --latest', 2);
  const snapshots = await listSnapshots(ctx, id);
  const matches = snapshot ? snapshots.filter((s) => s.id.startsWith(snapshot)) : snapshots;
  if (!matches.length) throw new OmaError('SNAPSHOT_NOT_FOUND', `No snapshot found for ${id}`, 9);
  if (snapshot && matches.length !== 1)
    throw new OmaError('AMBIGUOUS_SNAPSHOT', 'Snapshot prefix matches several snapshots', 2);
  return matches.sort((a, b) => a.time.localeCompare(b.time)).at(-1)!;
}
export async function restoreData(
  ctx: Context,
  id: string,
  snapshot: string,
  withConfig: boolean,
  op: Operation,
) {
  const current = await ctx.app(id);
  const snapshotApp = AppLock.parse(
    JSON.parse((await restic(ctx, ['dump', snapshot, `/config/${id}/app.lock.json`])).stdout),
  );
  assert(snapshotApp.id === id, 'SNAPSHOT_APP_MISMATCH', 'Snapshot belongs to another app');
  const app = withConfig ? snapshotApp : current;
  assert(
    app.manifest.volumes
      .filter((v) => v.backup === 'files')
      .every((v) =>
        snapshotApp.manifest.volumes.some((old) => old.key === v.key && old.backup === 'files'),
      ),
    'SNAPSHOT_VOLUME_MISMATCH',
    'Snapshot lacks a current file volume; use --with-config to restore its original definition',
  );
  await compose(ctx, id, ['down']);
  const mounts: string[] = [];
  for (const v of app.manifest.volumes)
    if (v.backup === 'files') {
      const name = `oma_${id}_${v.key}`;
      await ensureVolume(ctx, name);
      await docker(ctx, [
        'run',
        '--rm',
        '--network',
        'none',
        '--mount',
        `type=volume,source=${name},target=/target`,
        HELPER_IMAGE,
        'sh',
        '-c',
        'find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
      ]);
      mounts.push('--mount', `type=volume,source=${name},target=/restore/backup/${id}/${v.key}`);
    }
  await restic(
    ctx,
    ['restore', snapshot, '--target', '/restore', '--include', `/backup/${id}`],
    mounts,
  );
  if (withConfig) {
    const stage = `oma_restore_config_${ctx.opId!.replace(/[^a-zA-Z0-9]/g, '_')}`;
    await ensureVolume(ctx, stage);
    try {
      await restic(
        ctx,
        ['restore', snapshot, '--target', '/restore', '--include', `/config/${id}`],
        ['--mount', `type=volume,source=${stage},target=/restore/config`],
      );
      // Docker cp's tar stream is read as binary, without ever binding host configuration into a container.
      const name = `oma-config-${randomBytes(5).toString('hex')}`;
      await docker(ctx, [
        'create',
        '--name',
        name,
        '--network',
        'none',
        '--mount',
        `type=volume,source=${stage},target=/config`,
        HELPER_IMAGE,
        'true',
      ]);
      try {
        const child = Bun.spawn(['docker', 'cp', `${name}:/config/${id}/.`, '-'], {
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: ctx.timeout,
        });
        const [bytes, error, code] = await Promise.all([
          new Response(child.stdout).arrayBuffer(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code !== 0) throw new OmaError('CONFIG_RESTORE_FAILED', error, 1);
        const configFiles = untar(new Uint8Array(bytes));
        for (const file of await walk(ctx.appDir(id)))
          if (
            /^(compose(?:\.[^.]+)?\.yml|app\.lock\.json|\.env|hooks\/.*)$/.test(file) &&
            !configFiles[file]
          )
            await fs.rm(path.join(ctx.appDir(id), file), { force: true });
        for (const [file, value] of Object.entries(configFiles)) {
          if (!/^(compose(?:\.[^.]+)?\.yml|app\.lock\.json|\.env|hooks\/.*)$/.test(file)) continue;
          await write(path.join(ctx.appDir(id), file), value, file === '.env' ? 0o600 : 0o644);
        }
      } finally {
        await docker(ctx, ['rm', name], { allowFailure: true });
      }
    } finally {
      await docker(ctx, ['volume', 'rm', stage], { allowFailure: true });
    }
  }
  await ctx.loadSecrets();
  const restored = await ctx.app(id);
  restored.last_backup = current.last_backup;
  await ctx.saveApp(restored);
  const post = restored.manifest.hooks.post_restore;
  if (post) {
    await up(ctx, id, [post.service]);
    await hook(ctx, id, 'post_restore', op);
  }
  await up(ctx, id);
  await renderRoutes(ctx, restored);
  await syncRoutes(ctx);
  await verifyApp(ctx, id, op);
  if (restored.desired_state === 'stopped') await compose(ctx, id, ['stop']);
}
export async function prune(ctx: Context) {
  const config = await ctx.config();
  assert(
    config.backup.policy === 'self-managed',
    'CENTRAL_POLICY',
    'Central backup policy forbids instance pruning',
    3,
  );
  // Exclude protected pre-update snapshots from forget; retention still groups by app and host.
  const all = await listSnapshots(ctx),
    cutoff = Date.now() - 14 * 86400000;
  const protectedIds = new Set(
    all
      .filter((s) => s.tags?.includes('reason:pre-update') && Date.parse(s.time) > cutoff)
      .map((s) => s.id),
  );
  const candidates = all.filter((s) => !protectedIds.has(s.id)).map((s) => s.id);
  if (!candidates.length) return { pruned: false, output: 'No eligible snapshots' };
  const result = await restic(ctx, [
    'forget',
    ...candidates,
    '--keep-daily',
    '7',
    '--keep-weekly',
    '4',
    '--keep-monthly',
    '6',
    '--group-by',
    'host,paths',
    '--prune',
    '--json',
  ]);
  return { pruned: true, output: result.stdout };
}
