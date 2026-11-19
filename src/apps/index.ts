import { removeTunnel } from '../tunnel';
import { Context } from '../core/context';
import { fs, path, exists, readEnv, saveEnv, now, write } from '../core/fs';
import { resolveOrder, fingerprint } from '../catalog';
import { renderApp, linkedEnv } from './render';
import { docker, compose, pull, up, containers, parseDockerJson } from '../docker';
import { hook, verifyApp } from './hooks';
import { renderRoutes, syncRoutes } from '../routing';
import { backupBeforeChange, selectSnapshot, restic } from '../backup';
import { OmaError, assert, asError } from '../core/errors';
import { planFor, mutate, type Operation } from '../core/operation';
import { AppId, AppLock, type AppManifest, type InstalledApp } from '../schemas';
export function assignments(values: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const i = v.indexOf('=');
    if (i < 1) throw new OmaError('INVALID_ASSIGNMENT', `Expected KEY=VALUE: ${v}`, 2);
    out[v.slice(0, i)] = v.slice(i + 1);
  }
  return out;
}
export function hostname(value: string) {
  if (
    !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
      value,
    )
  )
    throw new OmaError('INVALID_DOMAIN', `Invalid hostname: ${value}`, 2);
  return value.toLowerCase();
}
export async function resolveLinks(
  ctx: Context,
  m: AppManifest,
  selections: Record<string, string>,
) {
  const apps = await ctx.apps(),
    links: Record<string, string> = {};
  for (const c of m.consumes) {
    const available = apps.filter(
      (a) => a.id !== m.id && a.manifest.provides.some((p) => p.capability === c.capability),
    );
    const chosen = selections[c.capability];
    if (chosen) {
      assert(
        available.some((a) => a.id === chosen),
        'PROVIDER_NOT_INSTALLED',
        `Provider ${chosen} not installed`,
      );
      links[c.capability] = chosen;
    } else if (available.length === 1) links[c.capability] = available[0].id;
    else if (c.required)
      throw new OmaError(
        available.length ? 'AMBIGUOUS_PROVIDER' : 'MISSING_PROVIDER',
        `Cannot choose provider of ${c.capability}`,
        3,
      );
  }
  return links;
}
export async function installOne(
  ctx: Context,
  m: AppManifest,
  op: Operation,
  options: {
    set?: Record<string, string>;
    selections?: Record<string, string>;
    domains?: string[];
    force?: boolean;
  } = {},
) {
  const current = await ctx.app(m.id).catch(() => null),
    fp = await fingerprint(ctx.p('catalog'), m.id);
  if (current && current.fingerprint === fp && current.state !== 'failed' && !options.force)
    return { app: m.id, ok: true, skipped: true };
  if (current && current.state !== 'failed') {
    const { updateOne } = await import('../update');
    const result = await updateOne(ctx, m.id, op);
    if (!result.ok) throw new OmaError('UPDATE_ROLLED_BACK', result.error!, 6);
    return result;
  }
  try {
    if (!current && m.volumes.length && !(await exists(path.join(ctx.appDir(m.id), '.env')))) {
      const volumes = parseDockerJson(
        (await docker(ctx, ['volume', 'ls', '--format', 'json'])).stdout,
      );
      if (
        m.volumes.some((v) => volumes.some((existing) => existing.Name === `oma_${m.id}_${v.key}`))
      ) {
        assert(
          (await ctx.config()).backup.repository,
          'ORPHANED_DATA',
          `Existing ${m.id} volumes require their saved credentials`,
          3,
        );
        const snapshot = await selectSnapshot(ctx, m.id, undefined, true);
        const saved = AppLock.parse(
          JSON.parse(
            (await restic(ctx, ['dump', snapshot.id, `/config/${m.id}/app.lock.json`])).stdout,
          ),
        );
        const env = (await restic(ctx, ['dump', snapshot.id, `/config/${m.id}/.env`])).stdout;
        await write(path.join(ctx.appDir(m.id), '.env'), env, 0o600);
        saved.desired_state = 'running';
        await ctx.saveApp(saved);
        await ctx.loadSecrets();
      }
    }
    const links = await resolveLinks(ctx, m, options.selections ?? {});
    await op.step(`Render ${m.id}`, () => renderApp(ctx, m, { ...options, links }));
    await op.step(`Pull ${m.id}`, () => pull(ctx, m.id));
    await op.step(`Start ${m.id}`, () => up(ctx, m.id));
    await op.step(`Set up ${m.id}`, () => hook(ctx, m.id, 'setup', op));
    if (Object.keys(links).length) await hook(ctx, m.id, 'on_link', op);
    await syncRoutes(ctx);
    await op.step(`Verify ${m.id}`, () => verifyApp(ctx, m.id, op));
    return { app: m.id, ok: true };
  } catch (e) {
    const app = await ctx.app(m.id).catch(() => null);
    if (app) {
      app.state = 'failed';
      await ctx.saveApp(app);
      const logs = await compose(ctx, m.id, ['logs', '--no-color', '--tail', '100'], {
        allowFailure: true,
      });
      await op.log('install_failed', { app: m.id, logs: logs.stdout, stderr: logs.stderr });
    }
    throw e;
  }
}
export async function install(ctx: Context, targets: string[], options: any) {
  await ctx.config();
  const selections = assignments(options.link),
    values = assignments(options.set);
  for (const [k, v] of Object.entries(values)) {
    assert(/^[A-Z][A-Z0-9_]*$/.test(k), 'INVALID_ENV', `Invalid environment key ${k}`, 2);
    ctx.secrets.add(v);
  }
  if (options.bundle) {
    AppId.parse(options.bundle);
    const { parse } = await import('yaml');
    const bundle = parse(
      await fs.readFile(ctx.p('catalog', 'bundles', `${options.bundle}.yml`), 'utf8').catch(() => {
        throw new OmaError('BUNDLE_NOT_FOUND', `Bundle ${options.bundle} not found`, 9);
      }),
    );
    assert(Array.isArray(bundle.apps), 'INVALID_BUNDLE', 'Bundle apps must be an array');
    targets = [...targets, ...bundle.apps];
  }
  assert(targets.length, 'APP_REQUIRED', 'Specify apps or --bundle', 2);
  const order = await resolveOrder(ctx, targets, selections);
  const domains = (options.domain ?? []).map(hostname);
  return mutate(
    ctx,
    planFor(
      'install',
      order.map((m) => m.id),
      order.flatMap((m) => [
        `Render ${m.id} with dependencies and links`,
        `Pull and start ${m.id}`,
        `Set up and functionally verify ${m.id}`,
      ]),
    ),
    { apps: targets, ...options },
    async (op) => {
      const { capacity } = await import('../docker/probes');
      const limits = await capacity(ctx, true);
      const installed = await ctx.apps(),
        planned = order.filter((m) => !installed.some((a) => a.id === m.id));
      const memory = [...installed.map((a) => a.manifest), ...planned].reduce(
          (s, m) => s + m.resources.memory_mb,
          0,
        ),
        disk = planned.reduce((s, m) => s + m.resources.disk_mb, 0);
      if (limits) {
        assert(
          limits.memory_mb >= memory,
          'LOW_MEMORY',
          `Need ${memory} MB memory; ${limits.memory_mb} MB available`,
        );
        assert(
          limits.disk_mb >= disk,
          'LOW_DISK',
          `Need ${disk} MB disk; ${limits.disk_mb} MB available`,
        );
        if (limits.disk_mb < disk + 5120)
          ctx.warn('LOW_DISK', `${limits.disk_mb} MB free in Docker`);
      }
      const results = [];
      for (const m of order) {
        if (!(await exists(path.join(ctx.appDir(m.id), 'app.lock.json')))) {
          const info = JSON.parse((await docker(ctx, ['info', '--format', 'json'])).stdout);
          if (info.MemTotal / 1048576 < m.resources.memory_mb)
            throw new OmaError('LOW_MEMORY', `Insufficient Docker memory for ${m.id}`, 3);
        }
        results.push(
          await installOne(ctx, m, op, {
            set: targets.includes(m.id) ? values : {},
            selections,
            domains: targets.includes(m.id) ? domains : [],
          }),
        );
      }
      return { results };
    },
  );
}
export async function targets(ctx: Context, ids: string[], all: boolean, allowStopped = true) {
  const apps = all ? await ctx.apps() : await Promise.all(ids.map((id) => ctx.app(id)));
  assert(apps.length, 'APP_REQUIRED', 'Specify app ids or --all', 2);
  return apps.filter((a) => allowStopped || a.desired_state === 'running');
}
export async function lifecycle(
  ctx: Context,
  command: 'start' | 'stop' | 'restart',
  ids: string[],
  options: any,
) {
  const apps = await targets(ctx, ids, options.all);
  return mutate(
    ctx,
    planFor(
      command,
      apps.map((a) => a.id),
      apps.map((a) => `${command} ${a.id}; set desired_state`),
    ),
    { apps: ids, ...options },
    async (op) => {
      const results = [];
      for (const app of apps) {
        await backupBeforeChange(ctx, app.id, op);
        app.last_backup = (await ctx.app(app.id)).last_backup;
        await op.step(`${command} ${app.id}`, async () => {
          if (command === 'stop') {
            if (app.tunnel) await removeTunnel(ctx, app.id);
            await compose(ctx, app.id, ['stop']);
          } else if (command === 'restart') {
            await compose(ctx, app.id, ['stop']);
            await up(ctx, app.id);
          } else await up(ctx, app.id);
          app.desired_state = command === 'stop' ? 'stopped' : 'running';
          app.state = app.desired_state;
          await ctx.saveApp(app);
        });
        results.push({ app: app.id, ok: true });
      }
      return { results };
    },
  );
}
export async function verify(ctx: Context, ids: string[], options: any) {
  const apps = await targets(ctx, ids, options.all ?? !ids.length);
  return mutate(
    ctx,
    planFor(
      'verify',
      apps.map((a) => a.id),
      apps.map(
        (a) =>
          `${options.repair ? 'Repair if desired_state=running; ' : ''}functionally verify ${a.id}`,
      ),
    ),
    { apps: ids, ...options },
    async (op) => {
      const results = [];
      for (const app of apps) {
        if (app.desired_state === 'stopped') {
          results.push({ app: app.id, ok: true, skipped: true });
          continue;
        }
        try {
          if (options.repair) {
            const cs = await containers(ctx, app.id);
            if (
              cs.length === 0 ||
              cs.some((c) => c.State !== 'running' || (c.Health && c.Health !== 'healthy'))
            )
              await up(ctx, app.id);
          }
          try {
            await verifyApp(ctx, app.id, op);
          } catch (e) {
            if (!options.repair) throw e;
            await backupBeforeChange(ctx, app.id, op);
            await hook(ctx, app.id, 'setup', op);
            await verifyApp(ctx, app.id, op);
          }
          results.push({ app: app.id, ok: true });
        } catch (e) {
          results.push({ app: app.id, ok: false, error: asError(e).message });
        }
      }
      if (results.some((r) => !r.ok))
        throw new OmaError(
          'VERIFY_FAILED',
          'One or more apps failed functional checks',
          5,
          'Inspect logs and history',
          { results },
        );
      return { results };
    },
  );
}
export async function remove(ctx: Context, id: string, options: any) {
  const app = await ctx.app(id),
    consumers = (await ctx.apps()).filter((a) => Object.values(a.links).includes(id));
  assert(
    id !== 'traefik',
    'SYSTEM_APP',
    'Traefik cannot be removed while the instance is initialized',
  );
  return mutate(
    ctx,
    planFor(
      'remove',
      [id],
      [
        `Back up ${id}`,
        `Remove containers and routes for ${id}`,
        options.purge ? 'Delete all app volumes' : 'Keep app volumes as orphaned',
      ],
      options.purge ? id : null,
    ),
    { app: id, ...options },
    async (op) => {
      assert(
        options.force || consumers.length === 0,
        'PROVIDER_IN_USE',
        `${id} has consumers: ${consumers.map((a) => a.id).join(', ')}`,
      );
      await backupBeforeChange(ctx, id, op, 'pre-remove', true);
      if (app.tunnel) await removeTunnel(ctx, id);
      await compose(ctx, id, ['down', ...(options.purge ? ['--volumes'] : [])]);
      if (options.purge)
        for (const v of app.manifest.volumes)
          await docker(ctx, ['volume', 'rm', `oma_${id}_${v.key}`], { allowFailure: true });
      await fs.rm(ctx.p('system', 'traefik', 'dynamic', `${id}.yml`), { force: true });
      await syncRoutes(ctx);
      for (const consumer of consumers) {
        consumer.state = 'degraded';
        await ctx.saveApp(consumer);
      }
      await fs.rm(ctx.appDir(id), { recursive: true, force: true });
      return { app: id, purged: !!options.purge };
    },
  );
}
export async function status(ctx: Context, id?: string) {
  await ctx.config();
  const apps = id ? [await ctx.app(id)] : await ctx.apps();
  const all = await ctx.apps();
  const owned = new Set(all.flatMap((a) => a.manifest.volumes.map((v) => `oma_${a.id}_${v.key}`)));
  const volumes = parseDockerJson(
    (await docker(ctx, ['volume', 'ls', '--format', 'json'])).stdout,
  ).map((v) => v.Name as string);
  return {
    apps: await Promise.all(
      apps.map(async (app) => ({
        ...app,
        containers: await containers(ctx, app.id),
        override: await exists(path.join(ctx.appDir(app.id), 'compose.override.yml')),
      })),
    ),
    orphaned_volumes: volumes.filter(
      (n) =>
        n.startsWith('oma_') &&
        !owned.has(n) &&
        !['oma_restic_cache'].includes(n) &&
        !n.startsWith('oma_backup_stage_'),
    ),
  };
}
export async function chooseCapability(
  ctx: Context,
  consumer: string,
  provider: string,
  capability?: string,
  existing = false,
) {
  const c = await ctx.app(consumer),
    p = await ctx.app(provider);
  const matches = c.manifest.consumes.filter(
    (v) =>
      (!capability || v.capability === capability) &&
      p.manifest.provides.some((x) => x.capability === v.capability) &&
      (!existing || c.links[v.capability] === provider),
  );
  if (!matches.length) throw new OmaError('CAPABILITY_NOT_FOUND', 'No matching capability', 9);
  assert(matches.length === 1, 'AMBIGUOUS_CAPABILITY', 'Pass --capability <name>', 2);
  return { c, p, capability: matches[0].capability };
}
export async function link(
  ctx: Context,
  consumer: string,
  provider: string,
  options: any,
  unlink = false,
) {
  const { c, capability } = await chooseCapability(
    ctx,
    consumer,
    provider,
    options.capability,
    unlink,
  );
  const command = unlink ? 'unlink' : 'link';
  return mutate(
    ctx,
    planFor(
      command,
      [consumer, provider],
      [`Back up ${consumer}`, `${command} ${capability}; recreate consumer; on_link; verify`],
    ),
    { consumer, provider, ...options },
    async (op) => {
      await backupBeforeChange(ctx, consumer, op);
      c.last_backup = (await ctx.app(consumer)).last_backup;
      const env = await readEnv(path.join(ctx.appDir(consumer), '.env'));
      if (unlink) {
        delete c.links[capability];
        const consume = c.manifest.consumes.find((x) => x.capability === capability)!;
        for (const k of Object.keys(env)) if (k.startsWith(consume.env_prefix)) delete env[k];
        if (consume.required) c.state = 'degraded';
      } else {
        c.links[capability] = provider;
        if (
          c.state === 'degraded' &&
          c.manifest.consumes.filter((x) => x.required).every((x) => c.links[x.capability])
        )
          c.state = c.desired_state;
      }
      Object.assign(env, (await linkedEnv(ctx, c.manifest, c.links)).values);
      await saveEnv(path.join(ctx.appDir(consumer), '.env'), env);
      await ctx.saveApp(c);
      await up(ctx, consumer);
      await hook(ctx, consumer, 'on_link', op);
      if (c.state !== 'degraded') await verifyApp(ctx, consumer, op);
      return { consumer, provider, capability };
    },
  );
}
export async function domain(
  ctx: Context,
  command: 'add' | 'remove' | 'list',
  id: string,
  host: string | undefined,
  routeName?: string,
) {
  const app = await ctx.app(id);
  if (command === 'list') {
    if (routeName)
      assert(
        app.manifest.routes.some((r) => r.name === routeName),
        'ROUTE_NOT_FOUND',
        'Route not found',
        9,
      );
    return {
      app: id,
      domains: routeName ? { [routeName]: app.domains[routeName] ?? [] } : app.domains,
    };
  }
  const name = hostname(host!);
  const route = app.manifest.routes.find(
    (r) => r.name === (routeName ?? app.manifest.routes[0]?.name),
  );
  if (!route) throw new OmaError('ROUTE_NOT_FOUND', 'Route not found', 9);
  return mutate(
    ctx,
    planFor(
      `domain ${command}`,
      [id],
      [`Back up ${id}`, `${command} ${name} on ${route.name}; sync routes`],
    ),
    { app: id, host: name, route: route.name },
    async (op) => {
      await backupBeforeChange(ctx, id, op);
      app.last_backup = (await ctx.app(id)).last_backup;
      app.domains[route.name] =
        command === 'add'
          ? [...new Set([...(app.domains[route.name] ?? []), name])]
          : (app.domains[route.name] ?? []).filter((h) => h !== name);
      await ctx.saveApp(app);
      await renderRoutes(ctx, app);
      await syncRoutes(ctx);
      return { app: id, domains: app.domains };
    },
  );
}
