import { test, expect, afterEach } from 'bun:test';
import os from 'node:os';
import { parse } from 'yaml';
import { Context } from '../../src/core/context';
import { fs, path, writeJson, readEnv } from '../../src/core/fs';
import { loadManifest } from '../../src/catalog';
import { renderApp } from '../../src/apps/render';
import { templateContext, renderRoutes } from '../../src/routing';
import { ensureQuickTunnel, removeTunnel, quickUrl, tunnel } from '../../src/tunnel';
import type { docker } from '../../src/docker';
const dirs: string[] = [];
const url = 'https://four-random-words-here.trycloudflare.com';
const started = '2026-11-19T00:00:00Z';
async function context() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oma-tunnel-test-'));
  dirs.push(home);
  const ctx = new Context({ home, timeout: '0.01' });
  await ctx.saveConfig({
    instance_id: 'inst_test',
    base_domain: 'localhost',
    ingress: { tls: 'off', http_port: 18080, https_port: 443, acme_email: null },
    channel: 'stable',
    release_url: 'https://example.com',
    updates: 'notify',
    backup: { repository: null, policy: 'self-managed', nightly_window: '01:00-05:00' },
    heartbeat: { url: null },
  });
  return ctx;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
function runner(
  options: {
    exists?: boolean;
    running?: boolean;
    conflict?: boolean;
    logs?: string;
    inspectError?: string;
  } = {},
) {
  let exists = options.exists ?? false;
  let running = options.running ?? true;
  const calls: string[][] = [];
  const run: typeof docker = async (_ctx, args) => {
    calls.push(args);
    const result = { stdout: '', stderr: '', exitCode: 0 };
    if (args[0] === 'inspect') {
      if (options.inspectError || !exists)
        return {
          ...result,
          exitCode: 1,
          stderr: options.inspectError ?? 'Error: No such object: oma-tunnel-wordpress',
        };
      result.stdout = JSON.stringify([
        {
          Config: {
            Labels: {
              'oma.tunnel.app': 'wordpress',
              'oma.instance': options.conflict ? 'inst_other' : 'inst_test',
            },
          },
          State: { Running: running, StartedAt: started },
        },
      ]);
    }
    if (args[0] === 'run') {
      exists = true;
      running = true;
    }
    if (args[0] === 'rm') exists = false;
    if (args[0] === 'logs')
      result.stderr = options.logs ?? `${url}\nRegistered tunnel connection connIndex=0`;
    return result;
  };
  return { run, calls };
}
test('Quick Tunnel parsing ignores documentation URLs and requires HTTPS trycloudflare hosts', () => {
  expect(quickUrl(`https://developers.cloudflare.com\n| ${url} |`)).toBe(url);
  expect(quickUrl('http://random.trycloudflare.com')).toBeUndefined();
  expect(quickUrl('https://example.com')).toBeUndefined();
});
test('creates a pinned, detached tunnel on the edge network and reads stderr for its URL', async () => {
  const ctx = await context(),
    fake = runner();
  expect(await ensureQuickTunnel(ctx, 'wordpress', fake.run)).toEqual({
    url,
    reused: false,
    started_at: started,
  });
  const create = fake.calls.find((args) => args[0] === 'run')!;
  expect(create).toContain('oma_edge');
  expect(create).toContain('http://traefik:80');
  expect(create.some((arg) => /cloudflare\/cloudflared:.*@sha256:[a-f0-9]{64}$/.test(arg))).toBe(
    true,
  );
  expect(create).not.toContain('--publish');
  expect(fake.calls.find((args) => args[0] === 'logs')).toEqual([
    'logs',
    '--since',
    started,
    'oma-tunnel-wordpress',
  ]);
});
test('repeated calls reuse a running tunnel without creating or removing containers', async () => {
  const ctx = await context(),
    fake = runner({ exists: true });
  expect((await ensureQuickTunnel(ctx, 'wordpress', fake.run)).reused).toBe(true);
  expect((await ensureQuickTunnel(ctx, 'wordpress', fake.run)).url).toBe(url);
  expect(fake.calls.some((args) => ['run', 'rm'].includes(args[0]))).toBe(false);
});
test('stopped tunnels are replaced rather than returning stale URLs', async () => {
  const ctx = await context(),
    fake = runner({ exists: true, running: false });
  expect((await ensureQuickTunnel(ctx, 'wordpress', fake.run)).reused).toBe(false);
  expect(
    fake.calls.filter((args) => ['run', 'rm'].includes(args[0])).map((args) => args[0]),
  ).toEqual(['rm', 'run']);
});
test('foreign containers and daemon errors never trigger container creation or deletion', async () => {
  const ctx = await context();
  for (const fake of [
    runner({ exists: true, conflict: true }),
    runner({ inspectError: 'Cannot connect to Docker daemon' }),
  ]) {
    await expect(ensureQuickTunnel(ctx, 'wordpress', fake.run)).rejects.toThrow();
    await expect(removeTunnel(ctx, 'wordpress', fake.run)).rejects.toThrow();
    expect(fake.calls.every((args) => args[0] === 'inspect')).toBe(true);
  }
});
test('a URL announcement without an established connection times out and cleans up', async () => {
  const ctx = await context(),
    fake = runner({ logs: url });
  await expect(ensureQuickTunnel(ctx, 'wordpress', fake.run)).rejects.toMatchObject({
    code: 'TUNNEL_TIMEOUT',
  });
  expect(fake.calls.at(-1)).toEqual(['rm', '-f', 'oma-tunnel-wordpress']);
});
async function installed(ctx: Context) {
  await fs.cp('catalog', ctx.p('catalog'), { recursive: true });
  await writeJson(ctx.p('state', 'catalog.lock.json'), { version: 'test' });
  return renderApp(ctx, await loadManifest(ctx.p('catalog'), 'wordpress'));
}
test('public HTTPS templates and tunnel router preserve local and ACME routing', async () => {
  const ctx = await context(),
    app = await installed(ctx);
  app.tunnel = { url, started_at: started, configured: true };
  await ctx.saveApp(app);
  expect((await templateContext(ctx, app.manifest)).routes!.web).toEqual({
    host: new URL(url).hostname,
    url,
  });
  expect((await templateContext(ctx, app.manifest, {}, {}, false)).routes!.web.url).toBe(
    'http://wordpress.localhost:18080',
  );
  const config = await ctx.config();
  config.ingress.tls = 'acme';
  config.ingress.acme_email = 'ops@example.com';
  await ctx.saveConfig(config);
  await renderRoutes(ctx, app);
  const routes = parse(
    await fs.readFile(ctx.p('system', 'traefik', 'dynamic', 'wordpress.yml'), 'utf8'),
  ).http;
  expect(routes.routers['wordpress-web'].rule).toBe('Host(`wordpress.localhost`)');
  expect(routes.routers['wordpress-web'].entryPoints).toEqual(['websecure']);
  expect(routes.routers['wordpress-web'].tls.certResolver).toBe('letsencrypt');
  expect(routes.routers['wordpress-tunnel'].rule).toBe(`Host(\`${new URL(url).hostname}\`)`);
  expect(routes.routers['wordpress-tunnel'].entryPoints).toEqual(['web']);
  expect(routes.routers['wordpress-tunnel'].tls).toBeUndefined();
  expect(
    routes.middlewares['wordpress-tunnel-https'].headers.customRequestHeaders['X-Forwarded-Proto'],
  ).toBe('https');
  expect(routes.routers['wordpress-web'].middlewares).not.toContain('wordpress-tunnel-https');
});
test('rendering app definitions preserves tunnel metadata and uses its public URL', async () => {
  const ctx = await context(),
    app = await installed(ctx);
  app.tunnel = { url, configured: true, started_at: started };
  await ctx.saveApp(app);
  // A fresh URL default resolves to the public address; existing credentials survive rendering.
  const { saveEnv } = await import('../../src/core/fs');
  const file = path.join(ctx.appDir(app.id), '.env');
  const env = await readEnv(file),
    password = env.WORDPRESS_ADMIN_PASSWORD;
  delete env.PUBLIC_URL;
  await saveEnv(file, env);
  await renderApp(ctx, app.manifest);
  expect((await ctx.app(app.id)).tunnel).toEqual(app.tunnel);
  expect((await readEnv(file)).PUBLIC_URL).toBe(url);
  expect((await readEnv(file)).WORDPRESS_ADMIN_PASSWORD).toBe(password);
  // Cached URL remains available when Docker has rotated the original announcement out of its logs.
  const fake = runner({ exists: true, logs: '' });
  expect((await ensureQuickTunnel(ctx, 'wordpress', fake.run)).url).toBe(url);
  expect(fake.calls.map((args) => args[0])).toEqual(['inspect']);
});
test('tunnel plans are read-only and stopped apps fail before Docker access', async () => {
  const ctx = await context(),
    app = await installed(ctx);
  ctx.opts.plan = true;
  expect(await tunnel(ctx, app.id)).toMatchObject({ command: 'tunnel', targets: ['wordpress'] });
  expect((await ctx.app(app.id)).tunnel).toBeUndefined();
  app.desired_state = 'stopped';
  await ctx.saveApp(app);
  await expect(tunnel(ctx, app.id)).rejects.toMatchObject({ code: 'APP_NOT_RUNNING' });
});

test('CLI applies a public URL once, verifies the app, and returns the same URL on retry', async () => {
  const ctx = await context();
  await installed(ctx);
  const bin = ctx.p('fake-bin');
  await fs.mkdir(bin);
  const executable = path.join(bin, 'docker');
  await fs.writeFile(
    executable,
    `#!${process.execPath}
const args = process.argv.slice(2);
const root = process.env.TUNNEL_TEST_ROOT;
const state = root + '/fake-container';
let input = '';
if (args.includes('-i') || args.includes('-T')) input = await Bun.stdin.text();
const { appendFile, writeFile, unlink } = await import('node:fs/promises');
await appendFile(root + '/docker-calls', JSON.stringify({args, input}) + '\\n');
if (input.includes('wp core is-installed') && await Bun.file(root + '/fail-verify').exists()) { console.error('Verification temporarily unavailable'); process.exit(1); }
if (args[0] === 'inspect') {
  if (!await Bun.file(state).exists()) { console.error('Error: No such object'); process.exit(1); }
  console.log(JSON.stringify([{ Config: { Labels: { 'oma.tunnel.app': 'wordpress', 'oma.instance': 'inst_test' } }, State: { Running: true, StartedAt: '${started}' } }]));
} else if (args[0] === 'run' && args.includes('--name')) {
  await writeFile(state, 'running'); console.log('container-id');
} else if (args[0] === 'rm') {
  await unlink(state);
} else if (args[0] === 'logs') {
  console.error('${url}'); console.error('Registered tunnel connection');
} else if (args[0] === 'compose' && args.includes('ps')) {
  console.log(JSON.stringify([{ Service: 'wordpress', State: 'running' }]));
}
`,
  );
  await fs.chmod(executable, 0o755);
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    TUNNEL_TEST_ROOT: ctx.home,
  };
  const invoke = async (expectedExit = 0) => {
    const child = Bun.spawn(
      [process.execPath, 'src/cli/index.ts', '--home', ctx.home, 'tunnel', 'wordpress', '--json'],
      { env, stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toBe('');
    expect(await child.exited).toBe(expectedExit);
    return JSON.parse(stdout);
  };
  expect((await invoke()).data).toEqual({ app: 'wordpress', url, reused: false });
  expect((await readEnv(path.join(ctx.appDir('wordpress'), '.env'))).PUBLIC_URL).toBe(url);
  expect((await ctx.app('wordpress')).tunnel?.configured).toBe(true);
  const before = (await fs.readFile(ctx.p('docker-calls'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(before.some((call) => call.input.includes('wp option update home "$PUBLIC_URL"'))).toBe(
    true,
  );
  expect(before.some((call) => call.input.includes('wp core is-installed'))).toBe(true);
  expect((await invoke()).data).toEqual({ app: 'wordpress', url, reused: true });
  const after = (await fs.readFile(ctx.p('docker-calls'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(after.slice(before.length).map((call) => call.args[0])).toEqual(['inspect']);
  // A pre-feature installed catalog uses the compatibility adapter; a verification
  // failure leaves retryable state and never creates a second tunnel.
  const app = await ctx.app('wordpress');
  delete app.manifest.hooks.on_public_url;
  app.tunnel!.configured = false;
  await ctx.saveApp(app);
  await fs.writeFile(ctx.p('fail-verify'), 'fail');
  expect((await invoke(5)).error.code).toBe('VERIFY_FAILED');
  expect((await ctx.app('wordpress')).tunnel?.configured).toBe(false);
  await fs.unlink(ctx.p('fail-verify'));
  expect((await invoke()).data).toEqual({ app: 'wordpress', url, reused: true });
  expect((await ctx.app('wordpress')).tunnel?.configured).toBe(true);
  expect((await ctx.app('wordpress')).state).toBe('running');
});
