#!/usr/bin/env bun
import { effectiveDiff } from '../apps/diff';
import { readable } from './text';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { ZodError } from 'zod';
import { Context, type Options } from '../core/context';
import { OmaError, asError, assert } from '../core/errors';
import { dataSchemas, envelopeSchema, type CommandName } from '../schemas';
import { VERSION } from '../core/version';
import { fs, path, json, readEnv, exists } from '../core/fs';
import { platformId, supportTier } from '../platform';
import { doctor } from '../platform/doctor';
import { schedule } from '../platform/scheduler';
import { init } from '../core/init';
import { listManifests, loadManifest } from '../catalog';
import { lintCatalog } from '../catalog/lint';
import {
  install,
  remove,
  lifecycle,
  status,
  verify,
  link,
  domain,
  assignments,
  targets,
} from '../apps';
import { hook } from '../apps/hooks';
import { compose, followLogs, docker } from '../docker';
import {
  backupApp,
  backupBeforeChange,
  initBackup,
  listSnapshots,
  restic,
  restoreData,
  selectSnapshot,
  prune,
  reasons,
} from '../backup';
import { update, selfUpdate } from '../update';
import { heartbeat } from '../core/heartbeat';
import { planFor, mutate } from '../core/operation';
const collect = (value: string | string[], previous: string[]) => [
  ...previous,
  ...(Array.isArray(value) ? value : [value]),
];
const nonnegative = (value: string) => {
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new InvalidArgumentError('Must be a nonnegative number');
  return value;
};
const tailLines = (value: string) => {
  if (value !== 'all' && !/^\d+$/.test(value))
    throw new InvalidArgumentError('Must be a nonnegative integer or all');
  return value;
};
const portNumber = (value: string) => {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new InvalidArgumentError('Port must be an integer from 1 to 65535');
  return value;
};
const positive = (value: string) => {
  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0)
    throw new InvalidArgumentError('Must be a positive number');
  return value;
};
const program = new Command()
  .name('omactl')
  .description('Manage one Open Marketing Agency instance')
  .version(VERSION)
  .option('--json', 'Print a structured JSON envelope')
  .option('--home <path>', 'Instance state directory')
  .option('--plan', 'Print the plan without changes')
  .option('--yes', 'Accept non-destructive prompts')
  .option('--confirm <target>', 'Confirm destructive operation for appId or instance')
  .option('--lock-timeout <seconds>', 'Mutation lock wait timeout', nonnegative, '120')
  .option('--timeout <seconds>', 'Docker and HTTP timeout', positive, '300')
  .option('--verbose', 'Include diagnostic detail')
  .option('--quiet', 'Suppress readable success output')
  .exitOverride();
program.configureOutput({ writeErr: () => {} });
let selected: CommandName = 'version';
let active: Context | undefined;
function command(
  parent: Command,
  syntax: string,
  name: CommandName,
  configure?: (c: Command) => void,
) {
  const c = parent.command(syntax);
  configure?.(c);
  c.action(async (...args: any[]) => {
    selected = name;
    const cmd = args.at(-1) as Command;
    const opts = cmd.optsWithGlobals();
    active = new Context(opts);
    await active.loadSecrets();
    try {
      const data = await dispatch(name, active, args.slice(0, -2), opts);
      const envelope = envelopeSchema(name).parse({
        ok: true,
        command: name,
        op_id: active.opId,
        data: active.secrets.redact(data),
        warnings: active.warnings,
        error: null,
      });
      // credentials is deliberately the one unredacted output.
      if (name === 'credentials') envelope.data = data;
      if (!(name === 'logs' && opts.follow)) emit(envelope, opts);
    } catch (e) {
      report(e, active, name);
    }
  });
  return c;
}
function emit(envelope: any, opts: Options) {
  if (opts.json) process.stdout.write(JSON.stringify(envelope) + '\n');
  else if (!opts.quiet) {
    (envelope.ok ? process.stdout : process.stderr).write(readable(envelope));
    for (const warning of envelope.warnings) process.stderr.write(`Warning: ${warning.message}\n`);
  }
}
function report(error: unknown, ctx: Context, name: CommandName) {
  const e =
    error instanceof ZodError
      ? new OmaError('VALIDATION_FAILED', error.message, 2)
      : asError(error);
  const data = e.exitCode === 8 ? (e.details.plan ?? null) : null;
  const envelope = ctx.secrets.redact({
    ok: false,
    command: name,
    op_id: ctx.opId,
    data,
    warnings: ctx.warnings,
    error: {
      code: e.code,
      message: e.message,
      ...(e.hint ? { hint: e.hint } : {}),
      details: e.details,
    },
  });
  emit(envelope, ctx.opts);
  process.exitCode = e.exitCode;
}
command(program, 'init', 'init', (c) =>
  c
    .option('--base-domain <host>')
    .option('--http-port <port>', 'Ingress port', portNumber)
    .option('--https-port <port>', 'Ingress port', portNumber)
    .option('--tls <mode>')
    .option('--acme-email <email>')
    .option('--channel <channel>')
    .option('--catalog <dir>')
    .option('--release-url <url>'),
);
command(program, 'doctor', 'doctor');
const catalog = program.command('catalog').description('Browse and validate catalog entries');
command(catalog, 'list', 'catalog list');
command(catalog, 'show <app>', 'catalog show');
command(catalog, 'lint <path>', 'catalog lint', (c) => c.option('--allow-local-images'));
command(program, 'install [apps...]', 'install', (c) =>
  c
    .option('--bundle <id>')
    .option('--link <capability=app>', 'Provider selection', collect, [])
    .option('--set <KEY=VALUE>', 'Environment setting', collect, [])
    .option('--domain <host>', 'Extra hostname', collect, []),
);
command(program, 'remove <app>', 'remove', (c) => c.option('--purge').option('--force'));
for (const cmd of ['start', 'stop', 'restart'] as const)
  command(program, `${cmd} [apps...]`, cmd, (c) => c.option('--all'));
command(program, 'status [app]', 'status');
command(program, 'logs <app>', 'logs', (c) =>
  c
    .option('--service <service>')
    .option('--since <time>')
    .option('--tail <lines>', 'Number of lines', tailLines, '100')
    .option('-f, --follow'),
);
command(program, 'verify [apps...]', 'verify', (c) => c.option('--all').option('--repair'));
command(program, 'setup <app>', 'setup');
for (const cmd of ['link', 'unlink'] as const)
  command(program, `${cmd} <consumer> <provider>`, cmd, (c) => c.option('--capability <name>'));
const domains = program.command('domain');
for (const cmd of ['add', 'remove'] as const)
  command(domains, `${cmd} <app> <host>`, `domain ${cmd}`, (c) => c.option('--route <name>'));
command(domains, 'list <app>', 'domain list', (c) => c.option('--route <name>'));
command(program, 'credentials <app>', 'credentials');
command(program, 'exec <app> [cmd...]', 'exec', (c) => c.option('--service <name>'));
command(program, 'overrides [app]', 'overrides');
const backup = program.command('backup');
command(backup, 'init', 'backup init', (c) =>
  c
    .option('--repository <path|url>')
    .option('--env <KEY=VALUE>', 'Backup environment (prefer --env-file)', collect, [])
    .option('--env-file <path>')
    .option('--policy <policy>'),
);
command(backup, 'run', 'backup run', (c) =>
  c
    .option('--app <id...>', 'Apps', collect, [])
    .option('--all')
    .option('--reason <reason>', 'Snapshot reason', 'manual'),
);
command(backup, 'list', 'backup list', (c) => c.option('--app <id>').option('--reason <reason>'));
command(backup, 'check', 'backup check', (c) => c.option('--read-data-subset <fraction>'));
command(backup, 'prune', 'backup prune');
command(program, 'restore <app>', 'restore', (c) =>
  c.option('--snapshot <id>').option('--latest').option('--with-config'),
);
command(program, 'update [apps...]', 'update', (c) =>
  c.option('--check').option('--to <version>').option('--scheduled').option('--allow-local-images'),
);
command(program, 'self-update', 'self-update', (c) =>
  c.option('--check').option('--channel <channel>').option('--to <version>').option('--rollback'),
);
const schedules = program.command('schedule');
for (const cmd of ['install', 'remove', 'status'] as const)
  command(schedules, cmd, `schedule ${cmd}`);
command(program, 'history', 'history', (c) =>
  c.option('--limit <number>', 'Maximum operations', positive, '20').option('--op <opId>'),
);
command(program, 'heartbeat', 'heartbeat');
command(program, 'version', 'version');
// Multi-command scheduled jobs run inside this binary without a host shell.
program
  .command('scheduled <job>', { hidden: true })
  .action(async (job: string, opts: any, cmd: Command) => {
    const ctx = new Context(cmd.optsWithGlobals());
    active = ctx;
    await ctx.loadSecrets();
    const name: CommandName =
      job === 'update-check' ? 'update' : job === 'nightly-backup' ? 'backup run' : 'verify';
    try {
      let data: any;
      if (job === 'boot-repair') {
        const end = Date.now() + 600000;
        let available = false;
        do {
          try {
            available =
              (
                await docker(ctx, ['info', '--format', 'json'], {
                  timeout: 10000,
                  allowFailure: true,
                })
              ).exitCode === 0;
          } catch {}
          if (!available) await Bun.sleep(2000);
        } while (!available && Date.now() < end);
        assert(available, 'DOCKER_UNAVAILABLE', 'Docker did not become available for boot repair');
        data = await verify(ctx, [], { all: true, repair: true });
      } else if (job === 'nightly-backup') {
        data = await dispatch('backup run', ctx, [], { all: true, reason: 'nightly' });
        await dispatch('backup check', ctx, [], { readDataSubset: '1/30' });
        await heartbeat(ctx);
      } else if (job === 'update-check') {
        data = await update(ctx, [], { scheduled: true });
        if ((await ctx.config()).updates === 'auto') await selfUpdate(ctx, {});
      } else if (job === 'verify') {
        try {
          data = await verify(ctx, [], { all: true });
        } finally {
          await heartbeat(ctx);
        }
      } else throw new OmaError('UNKNOWN_JOB', `Unknown job ${job}`, 2);
      emit(
        envelopeSchema(name).parse(
          ctx.secrets.redact({
            ok: true,
            command: name,
            op_id: ctx.opId,
            data,
            warnings: ctx.warnings,
            error: null,
          }),
        ),
        ctx.opts,
      );
    } catch (e) {
      report(e, ctx, name);
    }
  });
async function dispatch(name: CommandName, ctx: Context, args: any[], o: any): Promise<any> {
  if (!['version', 'doctor', 'init', 'catalog lint', 'history'].includes(name)) await ctx.config();
  const id = args[0];
  switch (name) {
    case 'version':
      return {
        version: VERSION,
        catalog: (await ctx.catalogLock().catch(() => null))?.version ?? null,
        platform: platformId(),
        support_tier: await supportTier(),
      };
    case 'doctor': {
      const result = await doctor(ctx);
      if (result.checks.some((c) => c.status === 'fail'))
        throw new OmaError(
          'DOCTOR_FAILED',
          'Doctor found blocking failures',
          3,
          'Resolve failing checks',
          { ...result },
        );
      return result;
    }
    case 'init':
      return init(ctx, o);
    case 'catalog list':
      return {
        version: (await ctx.catalogLock()).version,
        apps: await listManifests(ctx.p('catalog')),
        bundles: (await fs.readdir(ctx.p('catalog', 'bundles')).catch(() => [])).map((f) =>
          f.replace(/\.yml$/, ''),
        ),
      };
    case 'catalog show':
      return loadManifest(ctx.p('catalog'), id);
    case 'catalog lint': {
      const result = await lintCatalog(ctx, path.resolve(id), o.allowLocalImages);
      if (!result.valid)
        throw new OmaError('CATALOG_INVALID', 'Catalog lint failed', 3, undefined, result);
      return result;
    }
    case 'install':
      return install(ctx, id, o);
    case 'remove':
      return remove(ctx, id, o);
    case 'start':
    case 'stop':
    case 'restart':
      return lifecycle(ctx, name, id, o);
    case 'status':
      return status(ctx, id);
    case 'verify':
      return verify(ctx, id, o);
    case 'logs': {
      await ctx.app(id);
      assert(
        !(o.json && o.follow),
        'JSON_FOLLOW_UNSUPPORTED',
        '--follow cannot be used with --json',
        2,
      );
      if (o.follow) {
        await followLogs(ctx, id, [
          '--no-color',
          '--tail',
          o.tail,
          ...(o.since ? ['--since', o.since] : []),
          ...(o.service ? [o.service] : []),
        ]);
        return { app: id, logs: '' };
      }
      const r = await compose(ctx, id, [
        'logs',
        '--no-color',
        '--tail',
        o.tail,
        ...(o.since ? ['--since', o.since] : []),
        ...(o.service ? [o.service] : []),
      ]);
      return { app: id, logs: r.stdout + r.stderr };
    }
    case 'setup': {
      await ctx.app(id);
      return mutate(
        ctx,
        planFor('setup', [id], [`Back up ${id}; rerun idempotent setup`]),
        { app: id },
        async (op) => {
          await backupBeforeChange(ctx, id, op);
          return { app: id, outputs: await hook(ctx, id, 'setup', op) };
        },
      );
    }
    case 'link':
    case 'unlink':
      return link(ctx, id, args[1], o, name === 'unlink');
    case 'domain add':
    case 'domain remove':
    case 'domain list':
      return domain(ctx, name.split(' ')[1] as any, id, args[1], o.route);
    case 'credentials':
      await ctx.app(id);
      return { app: id, values: await readEnv(path.join(ctx.appDir(id), '.env')) };
    case 'exec': {
      const app = await ctx.app(id),
        cmd = args[1];
      assert(cmd.length, 'COMMAND_REQUIRED', 'Pass a command after --', 2);
      return mutate(
        ctx,
        planFor('exec', [id], [`Execute in ${o.service ?? app.manifest.main_service}: ${cmd[0]}`]),
        { app: id, command: cmd[0] },
        async (op) => {
          await backupBeforeChange(ctx, id, op);
          const r = await compose(
            ctx,
            id,
            ['exec', '-T', o.service ?? app.manifest.main_service, ...cmd],
            { allowFailure: true },
          );
          if (r.exitCode !== 0)
            throw new OmaError('EXEC_FAILED', ctx.secrets.redact(r.stderr || r.stdout), 1);
          return { app: id, stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode };
        },
      );
    }
    case 'overrides': {
      const apps = id ? [await ctx.app(id)] : await ctx.apps();
      const rows = [];
      for (const a of apps)
        if (await exists(path.join(ctx.appDir(a.id), 'compose.override.yml'))) {
          const [base, effective] = await Promise.all([
            compose(ctx, a.id, ['config', '--format', 'json'], { override: false }),
            compose(ctx, a.id, ['config', '--format', 'json']),
          ]);
          rows.push({
            app: a.id,
            base: base.stdout,
            effective: effective.stdout,
            diff: effectiveDiff(JSON.parse(base.stdout), JSON.parse(effective.stdout)),
          });
        }
      return { apps: rows };
    }
    case 'backup init': {
      const values = {
        ...(o.envFile ? await readEnv(path.resolve(o.envFile)) : {}),
        ...assignments(o.env),
      };
      for (const v of Object.values(values)) ctx.secrets.add(v);
      return mutate(
        ctx,
        planFor(
          name,
          ['instance'],
          ['Write backup credentials with mode 0600; initialize and check repository'],
        ),
        { repository: o.repository },
        async () => {
          if (o.policy) {
            assert(
              ['central', 'self-managed'].includes(o.policy),
              'INVALID_POLICY',
              'Invalid backup policy',
              2,
            );
            const c = await ctx.config();
            c.backup.policy = o.policy;
            await ctx.saveConfig(c);
          }
          return initBackup(ctx, o.repository, values);
        },
      );
    }
    case 'backup run': {
      assert(reasons.includes(o.reason), 'INVALID_REASON', 'Invalid backup reason', 2);
      const apps = await targets(ctx, o.app ?? [], o.all);
      return mutate(
        ctx,
        planFor(
          name,
          apps.map((a) => a.id),
          apps.map((a) => `Dump and snapshot ${a.id} (${o.reason})`),
        ),
        { apps: apps.map((a) => a.id), reason: o.reason },
        async (op) => {
          const results = [];
          for (const app of apps)
            try {
              results.push(await backupApp(ctx, app.id, o.reason, op));
            } catch (e) {
              results.push({ app: app.id, ok: false, error: asError(e).message });
            }
          if (results.some((r) => !r.ok))
            throw new OmaError('BACKUP_FAILED', 'One or more backups failed', 1, undefined, {
              results,
            });
          return { results };
        },
      );
    }
    case 'backup list':
      return { snapshots: await listSnapshots(ctx, o.app, o.reason) };
    case 'backup check':
      return mutate(
        ctx,
        planFor(name, ['instance'], ['Check restic repository integrity']),
        {},
        async () => ({
          checked: true,
          output: (
            await restic(ctx, [
              'check',
              ...(o.readDataSubset ? ['--read-data-subset', o.readDataSubset] : []),
            ])
          ).stdout,
        }),
      );
    case 'backup prune':
      return mutate(
        ctx,
        planFor(
          name,
          ['instance'],
          [
            'Apply 7 daily, 4 weekly, 6 monthly retention; protect recent pre-update snapshots; prune',
          ],
          'instance',
        ),
        {},
        async () => prune(ctx),
      );
    case 'restore': {
      await ctx.app(id);
      assert(o.snapshot || o.latest, 'SNAPSHOT_REQUIRED', 'Pass --snapshot or --latest', 2);
      return mutate(
        ctx,
        planFor(
          name,
          [id],
          [
            'Back up current state',
            'Stop app; wipe files volumes; restore snapshot',
            ...(o.withConfig ? ['Restore app configuration'] : []),
            'Run post_restore; start; verify',
          ],
          id,
        ),
        { app: id, ...o },
        async (op) => {
          const snapshot = await selectSnapshot(ctx, id, o.snapshot, o.latest);
          await backupBeforeChange(ctx, id, op, 'pre-restore', true);
          await restoreData(ctx, id, snapshot.id, !!o.withConfig, op);
          return { app: id, snapshot: snapshot.id, verified: true };
        },
      );
    }
    case 'update':
      return update(ctx, id, o);
    case 'self-update':
      return selfUpdate(ctx, o);
    case 'schedule status':
      return schedule(ctx, 'status');
    case 'schedule install':
    case 'schedule remove':
      return mutate(ctx, planFor(name, ['instance'], [`${name} native scheduler jobs`]), {}, () =>
        schedule(ctx, name.endsWith('install') ? 'install' : 'remove'),
      );
    case 'history': {
      if (o.op)
        assert(/^op_[0-9TZ]+_[a-f0-9]{4}$/.test(o.op), 'INVALID_OP_ID', 'Invalid operation id', 2);
      let files = (await fs.readdir(ctx.p('state', 'ops')).catch(() => []))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();
      if (o.op) files = files.filter((f) => f === `${o.op}.json`);
      if (o.op && !files.length) throw new OmaError('OP_NOT_FOUND', 'Operation not found', 9);
      return {
        operations: await Promise.all(
          files.slice(0, Number(o.limit)).map((f) => json(ctx.p('state', 'ops', f))),
        ),
      };
    }
    case 'heartbeat':
      return heartbeat(ctx);
  }
}
try {
  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exitCode = 2;
  } else await program.parseAsync(process.argv);
} catch (e) {
  if (
    e instanceof CommanderError &&
    (e.code === 'commander.helpDisplayed' || e.code === 'commander.version')
  ) {
  } else
    report(
      e instanceof CommanderError ? new OmaError('INVALID_USAGE', e.message, 2) : e,
      active ?? new Context({ json: process.argv.includes('--json') }),
      selected,
    );
}
