import { parse } from 'yaml';
import { Context } from '../core/context';
import { fs, path, readEnv, saveEnv, safePath, now } from '../core/fs';
import { compose, containers } from '../docker';
import { OmaError } from '../core/errors';
import { templateContext } from '../routing';
import type { Operation } from '../core/operation';
import type { AppManifest } from '../schemas';
export type HookName = keyof AppManifest['hooks'];
const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
export async function hook(ctx: Context, id: string, name: HookName, op?: Operation) {
  const app = await ctx.app(id),
    h = app.manifest.hooks[name];
  if (!h) return [];
  const env = await readEnv(path.join(ctx.appDir(id), '.env'));
  const t = await templateContext(ctx, app.manifest, env);
  const injected: Record<string, string> = {
    OMA_APP_ID: id,
    OMA_HOOK: name,
    OMA_OP_ID: ctx.opId ?? '',
    OMA_BASE_URL: Object.values(t.routes ?? {})[0]?.url ?? '',
  };
  for (const key of app.outputs) if (env[key] !== undefined) injected[key] = env[key];
  const script =
    Object.entries(injected)
      .map(([k, v]) => `export ${k}=${quote(v)}`)
      .join('\n') +
    '\n' +
    (await fs.readFile(safePath(ctx.appDir(id), h.script), 'utf8'));
  const running = (await containers(ctx, id)).some(
    (c) => c.Service === h.service && c.State === 'running',
  );
  const definition = parse(await fs.readFile(path.join(ctx.appDir(id), 'compose.yml'), 'utf8'));
  const oneOff = h.one_off || definition.services[h.service]?.profiles?.includes('tools');
  if (!running && !oneOff)
    throw new OmaError(
      name === 'verify' ? 'VERIFY_FAILED' : 'HOOK_SERVICE_NOT_RUNNING',
      `${id}/${h.service} is not running`,
      name === 'verify' ? 5 : 3,
      `Run: omactl start ${id}`,
    );
  const result = await compose(
    ctx,
    id,
    [
      running && !oneOff ? 'exec' : 'run',
      ...(running && !oneOff ? [] : ['--rm']),
      '-T',
      h.service,
      'sh',
      '-s',
    ],
    { input: script, timeout: h.timeout * 1000, allowFailure: true },
  );
  const outputs: string[] = [];
  for (const line of result.stdout.split('\n')) {
    const m = /^OMA_OUTPUT ([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) {
      ctx.secrets.add(m[2]);
      env[m[1]] = m[2];
      outputs.push(m[1]);
      if (!app.outputs.includes(m[1])) app.outputs.push(m[1]);
    }
  }
  if (outputs.length) {
    await saveEnv(path.join(ctx.appDir(id), '.env'), env);
    await ctx.saveApp(app);
  }
  await op?.log('hook', {
    app: id,
    hook: name,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  if (result.exitCode !== 0)
    throw new OmaError(
      name === 'verify' ? 'VERIFY_FAILED' : 'HOOK_FAILED',
      `${id} ${name} failed: ${ctx.secrets.redact(result.stderr || result.stdout)}`,
      name === 'verify' ? 5 : 1,
      `Run: omactl logs ${id}`,
    );
  return outputs;
}
export async function verifyApp(ctx: Context, id: string, op?: Operation) {
  const app = await ctx.app(id);
  try {
    await hook(ctx, id, 'verify', op);
    app.last_verify = { ok: true, at: now() };
    if (app.state !== 'degraded')
      app.state = app.desired_state === 'running' ? 'running' : 'stopped';
    await ctx.saveApp({ ...(await ctx.app(id)), last_verify: app.last_verify, state: app.state });
  } catch (e) {
    app.last_verify = { ok: false, at: now() };
    app.state = 'failed';
    await ctx.saveApp({ ...(await ctx.app(id)), last_verify: app.last_verify, state: app.state });
    throw e;
  }
}
