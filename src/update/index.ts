import { Context } from '../core/context';
import { fs, path, exists, write, writeJson, walk, hash } from '../core/fs';
import { fetchChannel, checkedDownload, type ChannelRelease } from './channels';
import { extractArchive } from '../core/tar';
import {
  loadManifest,
  fingerprint,
  listManifests,
  catalogMetadata,
  compareVersions,
} from '../catalog';
import { lintCatalog } from '../catalog/lint';
import { renderApp } from '../apps/render';
import { compose, pull, up } from '../docker';
import { hook, verifyApp } from '../apps/hooks';
import { backupBeforeChange, restoreData } from '../backup';
import { renderRoutes, syncRoutes } from '../routing';
import { planFor, mutate, type Operation } from '../core/operation';
import { OmaError, assert, asError } from '../core/errors';
import { definitionFromGit } from '../core/history';
import { VERSION } from '../core/version';
import { binaryPath, platformId, musl, smokeBinary, tempDir } from '../platform';
export async function stageCatalog(ctx: Context, release: ChannelRelease, dir: string) {
  const bytes = await checkedDownload(release.catalog, ctx.timeout);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await extractArchive(bytes, dir);
  const metadata = await catalogMetadata(dir);
  assert(
    metadata.version === release.catalog.version,
    'CATALOG_VERSION_MISMATCH',
    'Catalog metadata differs from signed version',
  );
  assert(
    compareVersions(VERSION, metadata.min_omactl) >= 0,
    'NEW_BINARY_REQUIRED',
    `Catalog requires omactl ${metadata.min_omactl}`,
  );
  await listManifests(dir);
  return bytes;
}
export async function swapCatalog(ctx: Context, dir: string, release: ChannelRelease) {
  const local = ctx.p('state', `catalog-new-${ctx.opId}`);
  if (path.resolve(dir) !== path.resolve(local)) {
    await fs.cp(dir, local, { recursive: true });
    dir = local;
  }
  const old = ctx.p('state', `catalog-old-${ctx.opId}`);
  let installed = false;
  if (await exists(ctx.p('catalog'))) await fs.rename(ctx.p('catalog'), old);
  try {
    await fs.rename(dir, ctx.p('catalog'));
    installed = true;
    await writeJson(ctx.p('state', 'catalog.lock.json'), {
      version: release.catalog.version,
      channel: release.channel,
      sha256: release.catalog.sha256,
      signature: true,
    });
  } catch (e) {
    if (installed) await fs.rm(ctx.p('catalog'), { recursive: true, force: true });
    if (await exists(old)) await fs.rename(old, ctx.p('catalog'));
    throw e;
  }
  await fs.rm(old, { recursive: true, force: true });
}
export async function updateOne(ctx: Context, id: string, op: Operation) {
  const previous = await ctx.app(id);
  const backup = await backupBeforeChange(ctx, id, op, 'pre-update', true);
  previous.last_backup = (await ctx.app(id)).last_backup;
  const committed = await definitionFromGit(ctx, id);
  const saved: Record<string, Buffer> = {};
  for (const file of await walk(ctx.appDir(id)))
    if (file !== 'compose.override.yml')
      saved[file] = await fs.readFile(path.join(ctx.appDir(id), file));
  for (const [file, bytes] of Object.entries(committed))
    if (file !== 'app.lock.json') saved[file] = Buffer.from(bytes);
  try {
    const m = await loadManifest(ctx.p('catalog'), id);
    await op.step(`Render updated ${id}`, () => renderApp(ctx, m));
    await compose(ctx, id, ['config', '--format', 'json']);
    await pull(ctx, id);
    await up(ctx, id);
    await hook(ctx, id, 'migrate', op);
    await hook(ctx, id, 'setup', op);
    await syncRoutes(ctx);
    await verifyApp(ctx, id, op);
    if (previous.desired_state === 'stopped') await compose(ctx, id, ['stop']);
    return { app: id, ok: true };
  } catch (error) {
    const logs = await compose(ctx, id, ['logs', '--no-color', '--tail', '100'], {
      allowFailure: true,
    });
    await op.log('update_failed', {
      app: id,
      error: asError(error).message,
      logs: logs.stdout,
      stderr: logs.stderr,
    });
    try {
      await op.step(`Roll back ${id}`, async () => {
        await compose(ctx, id, ['down'], { allowFailure: true });
        for (const file of await walk(ctx.appDir(id)))
          if (file !== 'compose.override.yml')
            await fs.rm(path.join(ctx.appDir(id), file), { force: true });
        for (const [file, bytes] of Object.entries(saved))
          await write(path.join(ctx.appDir(id), file), bytes, file === '.env' ? 0o600 : 0o644);
        await ctx.saveApp(previous);
        await restoreData(ctx, id, backup!.snapshot!, false, op);
        await renderRoutes(ctx, previous);
        await syncRoutes(ctx);
      });
    } catch (rollback) {
      const app = await ctx.app(id).catch(() => previous);
      app.state = 'needs_human';
      await ctx.saveApp(app);
      throw new OmaError(
        'ROLLBACK_FAILED',
        `${id}: update and rollback failed`,
        7,
        'Human intervention required',
        { update: asError(error).message, rollback: asError(rollback).message },
      );
    }
    return { app: id, ok: false, error: 'Update failed; previous version and data restored' };
  }
}
export async function update(ctx: Context, ids: string[], options: any) {
  const config = await ctx.config();
  if (options.scheduled && config.updates === 'off')
    return {
      current: (await ctx.catalogLock()).version,
      available: (await ctx.catalogLock()).version,
      changed: [],
      scheduled: true,
    };
  const check = options.check || (options.scheduled && config.updates === 'notify');
  const current = (await ctx.catalogLock()).version;
  if (config.channel === 'pinned' && !options.to && options.scheduled)
    return { current, available: current, changed: [], scheduled: true };
  const release = await fetchChannel(ctx, options);
  // Checking a release stages it outside OMA_HOME, so checks and --plan never alter instance state.
  const dir = await fs.mkdtemp(path.join(tempDir(), 'omactl-catalog-'));
  try {
    await stageCatalog(ctx, release, dir);
    const installed = await ctx.apps();
    for (const id of ids) await ctx.app(id);
    const changed: { app: string; from: string; to: string; diff: Record<string, unknown> }[] = [];
    for (const app of installed.filter((a) => !ids.length || ids.includes(a.id))) {
      const next = await loadManifest(dir, app.id);
      if (app.fingerprint !== (await fingerprint(dir, app.id))) {
        const before = await fs.readFile(path.join(ctx.appDir(app.id), 'compose.yml'), 'utf8'),
          after = await fs.readFile(
            path.join(
              await import('../catalog').then((c) => c.appPath(dir, app.id)),
              'compose.yml',
            ),
            'utf8',
          );
        changed.push({
          app: app.id,
          from: app.version,
          to: next.version,
          diff: { manifest: { before: app.manifest, after: next }, compose: { before, after } },
        });
      }
    }
    const report = { current, available: release.catalog.version, changed };
    if (check) {
      if (options.scheduled)
        return mutate(
          ctx,
          planFor(
            'update',
            changed.map((c) => c.app),
            ['Record signed update availability'],
          ),
          { scheduled: true },
          async (op) => {
            await op.log('update_check', report);
            return { ...report, scheduled: true };
          },
        );
      return report;
    }
    return await mutate(
      ctx,
      planFor(
        'update',
        changed.map((c) => c.app),
        [
          'Validate signed catalog and atomically replace catalog',
          ...changed.flatMap((c) => [
            `Back up ${c.app}`,
            `Update ${c.app}; migrate; setup; verify; roll back on failure`,
          ]),
        ],
      ),
      { apps: ids, ...options },
      async (op) => {
        const validation = await lintCatalog(ctx, dir, options.allowLocalImages ?? false);
        assert(validation.valid, 'INVALID_CATALOG', 'Downloaded catalog failed lint', 3);
        await op.log('catalog_lint', validation);
        await swapCatalog(ctx, dir, release);
        const results = [];
        for (const change of changed) results.push(await updateOne(ctx, change.app, op));
        if (results.some((r) => !r.ok))
          throw new OmaError(
            'UPDATE_ROLLED_BACK',
            'One or more updates failed and were rolled back',
            6,
            undefined,
            { results },
          );
        return { ...report, results };
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
export async function selfUpdate(ctx: Context, options: any) {
  const executable = binaryPath(),
    previous = path.join(path.dirname(executable), 'omactl.prev');
  if (options.rollback)
    return mutate(
      ctx,
      planFor('self-update', ['instance'], ['Restore previous binary atomically'], 'instance'),
      options,
      async () => {
        assert(
          await exists(previous),
          'PREVIOUS_BINARY_MISSING',
          'No previous binary is available',
          9,
        );
        const swap = executable + '.rollback';
        await fs.rename(executable, swap);
        try {
          await fs.rename(previous, executable);
          await fs.rename(swap, previous);
        } catch (e) {
          await fs.rename(swap, executable);
          throw e;
        }
        return { current: VERSION, available: 'previous', updated: true, rolled_back: true };
      },
    );
  const release = await fetchChannel(ctx, options);
  const report = { current: VERSION, available: release.omactl.version, updated: false };
  if (options.check || compareVersions(release.omactl.version, VERSION) <= 0) return report;
  return mutate(
    ctx,
    planFor(
      'self-update',
      ['instance'],
      ['Download signed platform asset; check SHA-256; smoke-test; atomically replace executable'],
    ),
    options,
    async () => {
      assert(
        !/^(bun|node)(?:\.exe)?$/.test(path.basename(executable)),
        'COMPILED_BINARY_REQUIRED',
        'Self-update requires a compiled omactl executable',
      );
      const platform = platformId() + (musl() ? '-musl' : '');
      const asset = release.omactl.assets[platform];
      assert(asset, 'ASSET_NOT_FOUND', `No release asset for ${platform}`, 9);
      try {
        await fs.access(path.dirname(executable), fs.constants.W_OK);
      } catch {
        throw new OmaError(
          'BINARY_NOT_WRITABLE',
          'Executable directory is not writable',
          3,
          'Install omactl in a directory writable by this user',
        );
      }
      const file = executable + `.new-${ctx.opId}`;
      try {
        await write(file, await checkedDownload(asset, ctx.timeout), 0o755);
        const version = await smokeBinary(file, ctx.timeout);
        assert(
          version === release.omactl.version,
          'SMOKE_TEST_FAILED',
          'New binary returned an unexpected version',
        );
        await fs.rename(executable, previous);
        try {
          await fs.rename(file, executable);
        } catch (e) {
          await fs.rename(previous, executable);
          throw e;
        }
      } finally {
        await fs.rm(file, { force: true });
      }
      return { ...report, updated: true };
    },
  );
}
