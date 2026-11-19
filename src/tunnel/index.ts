import { Context } from '../core/context';
import { docker, parseDockerJson, up } from '../docker';
import { assert, OmaError } from '../core/errors';
import { mutate, planFor } from '../core/operation';
import { backupBeforeChange } from '../backup';
import { verifyApp } from '../apps/hooks';
import { updatePublicUrl } from './public-url';
import { syncRoutes, templateContext } from '../routing';
import { readEnv, saveEnv, path } from '../core/fs';
import { render } from '../catalog/templates';

// Multi-platform index (linux/amd64 and linux/arm64), resolved from Cloudflare's official image.
export const CLOUDFLARED_IMAGE =
  'cloudflare/cloudflared:latest@sha256:e613aadbc2d9511785d2e67a86b0c8ac18dd63a3f9af0d06faf04cbfdcb35f2d';
export const tunnelName = (id: string) => `oma-tunnel-${id}`;
export function quickUrl(logs: string) {
  return logs.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/)?.[0];
}
type Runner = typeof docker;
async function inspect(ctx: Context, id: string, run: Runner) {
  const result = await run(ctx, ['inspect', tunnelName(id)], { allowFailure: true });
  if (result.exitCode !== 0) {
    assert(
      /No such (object|container)/i.test(result.stderr),
      'TUNNEL_INSPECT_FAILED',
      result.stderr || 'Cannot inspect tunnel container',
    );
    return null;
  }
  const container = parseDockerJson(result.stdout)[0];
  const labels = container?.Config?.Labels;
  assert(
    labels?.['oma.tunnel.app'] === id &&
      labels?.['oma.instance'] === (await ctx.config()).instance_id,
    'TUNNEL_CONTAINER_CONFLICT',
    `${tunnelName(id)} is not a tunnel owned by this instance`,
  );
  return container;
}
export async function removeTunnel(ctx: Context, id: string, run: Runner = docker) {
  if (await inspect(ctx, id, run)) await run(ctx, ['rm', '-f', tunnelName(id)]);
}
export async function ensureQuickTunnel(ctx: Context, id: string, run: Runner = docker) {
  const existing = await inspect(ctx, id, run);
  const reused = !!existing?.State?.Running;
  const saved = (await ctx.app(id).catch(() => null))?.tunnel;
  if (reused && saved && saved.started_at === existing.State.StartedAt)
    return { url: saved.url, reused, started_at: existing.State.StartedAt as string };
  if (existing && !reused) await run(ctx, ['rm', tunnelName(id)]);
  if (!reused) {
    await run(ctx, [
      'run',
      '-d',
      '--name',
      tunnelName(id),
      '--network',
      'oma_edge',
      '--label',
      `oma.tunnel.app=${id}`,
      '--label',
      `oma.instance=${(await ctx.config()).instance_id}`,
      '--label',
      'oma.managed=true',
      '--restart',
      'no',
      '--log-opt',
      'max-size=5m',
      '--log-opt',
      'max-file=2',
      CLOUDFLARED_IMAGE,
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://traefik:80',
    ]);
  }
  const end = Date.now() + Math.min(ctx.timeout, 60000);
  try {
    do {
      const container = await inspect(ctx, id, run);
      if (!container?.State?.Running)
        throw new OmaError(
          'TUNNEL_EXITED',
          'cloudflared exited before the tunnel was ready',
          3,
          `Inspect: docker logs ${tunnelName(id)}`,
        );
      // A restarted container has a new Quick Tunnel: never reuse URLs from an earlier run.
      const logs = await run(ctx, ['logs', '--since', container.State.StartedAt, tunnelName(id)]);
      const output = logs.stdout + '\n' + logs.stderr;
      const url = quickUrl(output);
      if (url && /Registered tunnel connection/.test(output))
        return { url, reused, started_at: container.State.StartedAt as string };
      await Bun.sleep(250);
    } while (Date.now() < end);
    throw new OmaError(
      'TUNNEL_TIMEOUT',
      'cloudflared did not establish a Quick Tunnel in time',
      3,
      `Check Internet connectivity and docker logs ${tunnelName(id)}`,
    );
  } catch (error) {
    if (!reused)
      await run(ctx, ['rm', '-f', tunnelName(id)], { allowFailure: true }).catch(() => {});
    throw error;
  }
}
export async function tunnel(ctx: Context, id: string) {
  await ctx.config();
  const app = await ctx.app(id);
  assert(app.manifest.routes.length > 0, 'ROUTE_NOT_FOUND', `${id} has no web route`, 9);
  assert(
    app.desired_state === 'running',
    'APP_NOT_RUNNING',
    `Start and verify ${id} before creating a tunnel`,
    3,
  );
  return mutate(
    ctx,
    planFor(
      'tunnel',
      [id],
      [
        `Create or reuse a public Cloudflare Quick Tunnel for ${id}`,
        `Back up ${id} if its public URL changes`,
        `Configure its public HTTPS URL, sync routes and verify ${id}`,
      ],
    ),
    { app: id },
    async (op) => {
      const current = await ctx.app(id);
      const result = await op.step('Connect Cloudflare Quick Tunnel', () =>
        ensureQuickTunnel(ctx, id),
      );
      if (current.tunnel?.url === result.url && current.tunnel.configured)
        return { app: id, ...result };
      try {
        await backupBeforeChange(ctx, id, op);
        current.last_backup = (await ctx.app(id)).last_backup;
        current.tunnel = { url: result.url, started_at: result.started_at, configured: false };
        await ctx.saveApp(current);
        const file = path.join(ctx.appDir(id), '.env');
        const env = await readEnv(file);
        const templates = await templateContext(ctx, current.manifest, {
          ...env,
          PUBLIC_URL: result.url,
        });
        const values: Record<string, string> = {};
        for (const env of current.manifest.env)
          if (env.value && /\{(?:url|host):/.test(env.value))
            values[env.name] = render(env.value, templates);
        if (current.manifest.env.some((env) => env.name === 'PUBLIC_URL'))
          values.PUBLIC_URL = result.url;
        await op.step('Configure public URL', async () => {
          // Use the installed definition, retaining local overrides, credentials and links.
          // Do not copy from the catalog or silently upgrade the installed definition.
          await saveEnv(file, { ...(await readEnv(file)), ...values });
          const { renderRoutes } = await import('../routing');
          await renderRoutes(ctx, current);
          await syncRoutes(ctx);
          await up(ctx, id);
          await updatePublicUrl(ctx, id, op);
          await verifyApp(ctx, id, op);
        });
        const configured = await ctx.app(id);
        configured.tunnel = { url: result.url, started_at: result.started_at, configured: true };
        await ctx.saveApp(configured);
        ctx.warn(
          'QUICK_TUNNEL_TEMPORARY',
          'This URL lasts while cloudflared runs. After a machine or Docker restart, rerun this command to configure a new URL.',
        );
        return { app: id, ...result };
      } catch (error) {
        // Retry can finish applying a URL without creating another tunnel.
        if (!result.reused && (await ctx.app(id)).tunnel?.url !== result.url)
          await removeTunnel(ctx, id).catch(() => {});
        ctx.warn('TUNNEL_CONFIGURATION_INCOMPLETE', `Rerun: omactl tunnel ${id}`);
        throw error;
      }
    },
  );
}
