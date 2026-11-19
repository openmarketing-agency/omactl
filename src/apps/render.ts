import { randomBytes } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { Context } from '../core/context';
import { fs, path, readEnv, saveEnv, write, safePath, now, exists } from '../core/fs';
import { appPath, fingerprint } from '../catalog';
import { render } from '../catalog/templates';
import { templateContext, renderRoutes, configureTraefik } from '../routing';
import { writeVolume } from '../docker/volumes';
import type { AppManifest, InstalledApp } from '../schemas';
import { OmaError } from '../core/errors';
export async function providerOutputs(ctx: Context, provider: string, capability: string) {
  const app = await ctx.app(provider),
    p = app.manifest.provides.find((p) => p.capability === capability);
  if (!p)
    throw new OmaError('CAPABILITY_NOT_FOUND', `${provider} does not provide ${capability}`, 9);
  const env = await readEnv(path.join(ctx.appDir(provider), '.env'));
  const t = await templateContext(ctx, app.manifest, env);
  return Object.fromEntries(
    Object.entries(p.outputs).map(([k, v]) => [k.toUpperCase(), render(v, t)]),
  );
}
export async function linkedEnv(ctx: Context, m: AppManifest, links: Record<string, string>) {
  const values: Record<string, string> = {},
    templates: Record<string, Record<string, string>> = {};
  for (const c of m.consumes)
    if (links[c.capability]) {
      const outputs = await providerOutputs(ctx, links[c.capability], c.capability);
      templates[c.capability] = Object.fromEntries(
        Object.entries(outputs).map(([k, v]) => [k.toLowerCase(), v]),
      );
      for (const [k, v] of Object.entries(outputs)) {
        values[c.env_prefix + k] = v;
        ctx.secrets.add(v);
      }
    }
  return { values, templates };
}
export async function renderApp(
  ctx: Context,
  m: AppManifest,
  options: {
    set?: Record<string, string>;
    links?: Record<string, string>;
    domains?: string[];
    root?: string;
  } = {},
) {
  const dir = ctx.appDir(m.id),
    root = options.root ?? ctx.p('catalog'),
    source = await appPath(root, m.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const previous = await ctx.app(m.id).catch(() => null),
    version = (await ctx.catalogLock()).version;
  await fs.copyFile(path.join(source, 'compose.yml'), path.join(dir, 'compose.yml'));
  await fs.chmod(path.join(dir, 'compose.yml'), 0o644);
  await fs.rm(path.join(dir, 'hooks'), { recursive: true, force: true });
  await fs.cp(path.join(source, 'hooks'), path.join(dir, 'hooks'), { recursive: true });
  const app: InstalledApp = {
    id: m.id,
    version: m.version,
    catalog: version,
    fingerprint: await fingerprint(root, m.id),
    manifest: m,
    desired_state: previous?.desired_state ?? 'running',
    state: previous?.state ?? 'running',
    links: options.links ?? previous?.links ?? {},
    domains: previous?.domains ?? {},
    tunnel: previous?.tunnel,
    outputs: previous?.outputs ?? [],
    installed_at: previous?.installed_at ?? now(),
    updated_at: now(),
    last_verify: previous?.last_verify ?? null,
    last_backup: previous?.last_backup ?? null,
  };
  for (const domain of options.domains ?? []) {
    const route = m.routes[0];
    if (!route) throw new OmaError('ROUTE_NOT_FOUND', `${m.id} has no routes`, 9);
    app.domains[route.name] = [...new Set([...(app.domains[route.name] ?? []), domain])];
  }
  const env = await readEnv(path.join(dir, '.env'));
  const link = await linkedEnv(ctx, m, app.links);
  Object.assign(env, link.values);
  for (const e of m.env)
    if (env[e.name] === undefined && e.generate) {
      const length = Number(e.generate.split(':')[1]);
      env[e.name] = randomBytes(Math.ceil((length * 3) / 4))
        .toString('base64url')
        .slice(0, length);
    }
  Object.assign(env, options.set ?? {});
  for (let iteration = 0; iteration <= m.env.length; iteration++)
    for (const e of m.env)
      if (env[e.name] === undefined && e.value !== undefined)
        try {
          env[e.name] = render(e.value, await templateContext(ctx, m, env, link.templates));
        } catch (error) {
          if (iteration === m.env.length) throw error;
        }
  for (const e of m.env) if (e.secret && env[e.name]) ctx.secrets.add(env[e.name]);
  await saveEnv(path.join(dir, '.env'), env);
  const compose: any = parse(await fs.readFile(path.join(dir, 'compose.yml'), 'utf8'));
  const services: Record<string, any> = {};
  for (const [name, service] of Object.entries<any>(compose.services)) {
    services[name] = {
      labels: { 'oma.managed': 'true', 'oma.app': m.id, 'oma.catalog': version },
      restart: 'unless-stopped',
    };
    if (name === m.main_service) {
      const networks = Array.isArray(service.networks)
        ? Object.fromEntries(service.networks.map((n: string) => [n, {}]))
        : (service.networks ?? { default: {} });
      services[name].networks = { ...networks, oma_edge: {} };
    }
  }
  if (m.id === 'traefik') {
    const config = await ctx.config();
    services.traefik.ports = [
      `${config.ingress.http_port}:80`,
      ...(config.ingress.tls === 'acme' ? [`${config.ingress.https_port}:443`] : []),
    ];
  }
  await write(
    path.join(dir, 'compose.generated.yml'),
    stringify({ services, networks: { oma_edge: { external: true, name: 'oma_edge' } } }),
  );
  await ctx.saveApp(app);
  await renderRoutes(ctx, app);
  if (m.id === 'traefik') await configureTraefik(ctx);
  for (const file of m.config_files) {
    const content = render(
      await fs.readFile(safePath(source, file.template), 'utf8'),
      await templateContext(ctx, m, env, link.templates),
    );
    await writeVolume(ctx, `oma_${m.id}_${file.volume}`, { [file.path]: content });
  }
  return app;
}
