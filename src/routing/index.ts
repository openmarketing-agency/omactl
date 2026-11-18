import { stringify } from 'yaml';
import { Context } from '../core/context';
import type { InstalledApp, AppManifest } from '../schemas';
import { render, type TemplateContext } from '../catalog/templates';
import { write, fs, path, hash } from '../core/fs';
import { OmaError } from '../core/errors';
import { docker, parseDockerJson } from '../docker';
import { writeVolume, syncRouteVolume } from '../docker/volumes';
export async function templateContext(
  ctx: Context,
  m: AppManifest,
  env: Record<string, string> = {},
  links: Record<string, Record<string, string>> = {},
): Promise<TemplateContext> {
  const config = await ctx.config();
  const base: TemplateContext = {
    appId: m.id,
    base_domain: config.base_domain,
    env,
    outputs: env,
    links,
    routes: {},
  };
  for (const r of m.routes) {
    const host = render(r.host, base);
    const secure = config.ingress.tls === 'acme';
    const port = secure ? config.ingress.https_port : config.ingress.http_port;
    base.routes![r.name] = {
      host,
      url: `${secure ? 'https' : 'http'}://${host}${port === (secure ? 443 : 80) ? '' : `:${port}`}`,
    };
  }
  return base;
}
export async function renderRoutes(ctx: Context, app: InstalledApp) {
  const config = await ctx.config();
  const templates = await templateContext(ctx, app.manifest);
  const routers: any = {},
    services: any = {};
  for (const route of app.manifest.routes) {
    const hosts = [templates.routes![route.name].host, ...(app.domains[route.name] ?? [])];
    const key = `${app.id}-${route.name}`;
    routers[key] = {
      rule: hosts.map((h) => `Host(\`${h}\`)`).join(' || '),
      entryPoints: [config.ingress.tls === 'acme' ? 'websecure' : 'web'],
      service: key,
      middlewares: [`${app.id}-identity`],
      ...(config.ingress.tls === 'acme' ? { tls: { certResolver: 'letsencrypt' } } : {}),
    };
    services[key] = {
      loadBalancer: { servers: [{ url: `http://${route.service}:${route.port}` }] },
    };
  }
  const file = ctx.p('system', 'traefik', 'dynamic', `${app.id}.yml`);
  if (app.manifest.routes.length)
    await write(
      file,
      stringify({
        http: {
          routers,
          services,
          middlewares: {
            [`${app.id}-identity`]: {
              headers: {
                customResponseHeaders: {
                  'X-OMA-App': app.id,
                  'X-OMA-Route-Version': hash(JSON.stringify({ routers, services })),
                },
              },
            },
          },
        },
      }),
    );
  else await fs.rm(file, { force: true });
}
export async function syncRoutes(ctx: Context) {
  const files: Record<string, string> = {};
  for (const file of await fs.readdir(ctx.p('system', 'traefik', 'dynamic')).catch(() => []))
    files[file] = await fs.readFile(ctx.p('system', 'traefik', 'dynamic', file), 'utf8');
  await syncRouteVolume(ctx, files);
  const running =
    parseDockerJson(
      (await docker(ctx, ['ps', '--filter', 'label=oma.app=traefik', '--format', 'json'])).stdout,
    ).length > 0;
  if (!running) return;
  const config = await ctx.config();
  for (const app of await ctx.apps())
    if (files[app.id + '.yml']) {
      const { parse } = await import('yaml');
      const expected = parse(files[app.id + '.yml']).http.middlewares[`${app.id}-identity`].headers
        .customResponseHeaders['X-OMA-Route-Version'];
      const t = await templateContext(ctx, app.manifest);
      for (const route of app.manifest.routes) {
        const secure = config.ingress.tls === 'acme',
          port = secure ? config.ingress.https_port : config.ingress.http_port;
        const end = Date.now() + Math.min(ctx.timeout, 15000);
        let ready = false;
        do {
          try {
            const response = await fetch(`${secure ? 'https' : 'http'}://127.0.0.1:${port}/`, {
              method: 'HEAD',
              headers: { Host: t.routes![route.name].host },
              redirect: 'manual',
              signal: AbortSignal.timeout(2000),
              ...(secure ? { tls: { rejectUnauthorized: false } } : {}),
            });
            ready =
              response.headers.get('X-OMA-App') === app.id &&
              response.headers.get('X-OMA-Route-Version') === expected;
            await response.body?.cancel();
          } catch {}
          if (!ready) await Bun.sleep(100);
        } while (!ready && Date.now() < end);
        if (!ready)
          throw new OmaError(
            'ROUTE_NOT_READY',
            `Traefik has not loaded route ${app.id}/${route.name}`,
            1,
          );
      }
    }
}
export async function configureTraefik(ctx: Context) {
  const config = await ctx.config();
  const staticConfig: any = {
    entryPoints: { web: { address: ':80' } },
    ping: { entryPoint: 'health' },
    providers: {
      providersThrottleDuration: '100ms',
      file: { directory: '/etc/traefik/dynamic', watch: true },
    },
    log: { format: 'json' },
    accessLog: { format: 'json' },
  };
  staticConfig.entryPoints.health = { address: ':8082' };
  if (config.ingress.tls === 'acme') {
    staticConfig.entryPoints.websecure = { address: ':443' };
    staticConfig.certificatesResolvers = {
      letsencrypt: {
        acme: {
          email: config.ingress.acme_email,
          storage: '/acme/acme.json',
          httpChallenge: { entryPoint: 'web' },
        },
      },
    };
  }
  const text = stringify(staticConfig);
  await write(ctx.p('system', 'traefik', 'traefik.yml'), text);
  await writeVolume(ctx, 'oma_traefik_config', { 'traefik.yml': text, 'dynamic/.keep': '' });
  await syncRoutes(ctx);
}
