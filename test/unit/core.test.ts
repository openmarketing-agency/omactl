import { test, expect, describe, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { parse } from 'yaml';
import { Context } from '../../src/core/context';
import { Manifest, envelopeSchema, dataSchemas, type CommandName } from '../../src/schemas';
import { render } from '../../src/catalog/templates';
import { resolveOrder } from '../../src/catalog';
import { acquireLock } from '../../src/core/lock';
import { Secrets } from '../../src/core/secrets';
import { mutate, planFor } from '../../src/core/operation';
import { verifySignature } from '../../src/update/channels';
import { tar, untar } from '../../src/core/tar';
import { writeJson, readEnv, saveEnv, exists, hash } from '../../src/core/fs';
import { initGit, commit } from '../../src/core/history';
import { nightlyMinute, systemdUnits, launchPlist } from '../../src/platform/scheduler';
import { parseDockerJson } from '../../src/docker';
import { OmaError, EXIT } from '../../src/core/errors';
import git from 'isomorphic-git';
import nodefs from 'node:fs';
import Ajv from 'ajv';
const dirs: string[] = [];
async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omactl-unit-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
test('manifest rejects wrong main service, duplicate volumes and malformed app IDs', async () => {
  const input = parse(await Bun.file('fixtures/catalog-v1/apps/testapp/manifest.yml').text());
  expect(Manifest.safeParse(input).success).toBe(true);
  for (const change of [
    { id: '../escape' },
    { main_service: 'other' },
    {
      volumes: [
        { key: 'files', backup: 'files' },
        { key: 'files', backup: 'skip' },
      ],
    },
  ])
    expect(Manifest.safeParse({ ...input, ...change }).success).toBe(false);
});
test('template rendering resolves all namespaces and refuses unknown values', () => {
  const ctx = {
    appId: 'testapp',
    base_domain: 'localhost',
    env: { TOKEN: 'abc' },
    outputs: { KEY: 'xyz' },
    routes: { web: { host: 'app.localhost', url: 'http://app.localhost' } },
    links: { 'notes.api': { url: 'http://testapp:3000' } },
  };
  expect(
    render(
      '{appId} {base_domain} {url:web} {host:web} {env:TOKEN} {output:KEY} {link:notes.api.url}',
      ctx,
    ),
  ).toBe('testapp localhost http://app.localhost app.localhost abc xyz http://testapp:3000');
  expect(() => render('{missing}', ctx)).toThrow('Unresolved');
});
test('install order includes required capability default provider', async () => {
  const ctx = new Context({ home: await temp() });
  await fs.cp('fixtures/catalog-v1', ctx.p('catalog'), { recursive: true });
  expect((await resolveOrder(ctx, ['testclient'])).map((m) => m.id)).toEqual([
    'traefik',
    'testapp',
    'testclient',
  ]);
});
test('dependency cycles fail before any mutation', async () => {
  const ctx = new Context({ home: await temp() });
  await fs.cp('fixtures/catalog-v1', ctx.p('catalog'), { recursive: true });
  const f = ctx.p('catalog', 'system', 'traefik', 'manifest.yml');
  await fs.appendFile(f, 'requires: [testclient]\n');
  await expect(resolveOrder(ctx, ['testclient'])).rejects.toThrow('cycle');
});
test('lock excludes contenders, releases, and takes over dead owners', async () => {
  const home = await temp();
  const owner = {
    pid: process.pid,
    opId: 'first',
    command: 'test',
    started_at: new Date().toISOString(),
  };
  const release = await acquireLock(home, owner, 100);
  await expect(acquireLock(home, { ...owner, opId: 'second' }, 5)).rejects.toMatchObject({
    exitCode: 4,
  });
  await release();
  await fs.mkdir(path.join(home, 'state', 'lock'));
  await writeJson(path.join(home, 'state', 'lock', 'owner.json'), { ...owner, pid: 2147483647 });
  let stale = false;
  const release2 = await acquireLock(home, { ...owner, opId: 'takeover' }, 100, () => {
    stale = true;
  });
  expect(stale).toBe(true);
  await release2();
});
test('plan and missing destructive confirmation do not create the home', async () => {
  const home = path.join(await temp(), 'absent');
  const plan = planFor('restore', ['testapp'], ['wipe'], 'testapp');
  let applied = false;
  expect(
    await mutate(new Context({ home, plan: true }), plan, {}, async () => {
      applied = true;
    }),
  ).toEqual(plan);
  await expect(
    mutate(new Context({ home }), plan, {}, async () => {
      applied = true;
    }),
  ).rejects.toMatchObject({ exitCode: 8 });
  expect(applied).toBe(false);
  expect(await exists(home)).toBe(false);
});
test('journal records steps and errors with secrets redacted and lock released', async () => {
  const ctx = new Context({ home: await temp() });
  ctx.secrets.add('top-secret-value');
  await expect(
    mutate(
      ctx,
      planFor('setup', ['testapp'], ['setup']),
      { token: 'top-secret-value' },
      async (op) =>
        op.step('fails', async () => {
          throw new OmaError('TEST', 'top-secret-value', 5);
        }),
    ),
  ).rejects.toMatchObject({ exitCode: 5 });
  const text = await Bun.file(ctx.p('state', 'ops', `${ctx.opId}.json`)).text();
  expect(text).not.toContain('top-secret-value');
  expect(JSON.parse(text).steps[0].status).toBe('failed');
  expect(await exists(ctx.p('state', 'lock'))).toBe(false);
});
test('redaction handles nested data, overlapping values and JSON strings', () => {
  const s = new Secrets();
  s.add('secret');
  s.add('secret-long');
  expect(s.redact({ a: ['secret-long', 'xxsecretyy'], b: '{"password":"secret"}' })).toEqual({
    a: ['[REDACTED]', 'xx[REDACTED]yy'],
    b: '{"password":"[REDACTED]"}',
  });
});
test('env roundtrip preserves dollars, quotes, spaces, and permissions', async () => {
  const f = path.join(await temp(), '.env');
  const env = { KEY: 'a$B "quoted"\nline', OTHER: "it's fine" };
  await saveEnv(f, env);
  expect(await readEnv(f)).toEqual(env);
  expect((await fs.stat(f)).mode & 0o777).toBe(0o600);
});
test('signature verification accepts exact signed bytes only and untrusted keys fail closed', () => {
  const key = generateKeyPairSync('ed25519'),
    pem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    bytes = Buffer.from('release'),
    sig = sign(null, bytes, key.privateKey);
  expect(verifySignature(bytes, sig, [pem])).toBe(true);
  expect(verifySignature(Buffer.from('tampered'), sig, [pem])).toBe(false);
  expect(verifySignature(bytes, sig, [])).toBe(false);
});
test('tar preserves binary content and rejects traversal, links and truncation', () => {
  const data = Buffer.from([0, 1, 255]);
  expect(untar(tar({ 'data/file': data }))['data/file']).toEqual(data);
  expect(() => tar({ '../evil': 'x' })).toThrow();
  expect(() => untar(tar({ safe: 'x' }).subarray(0, 512))).toThrow('Truncated');
});
test('all output schemas are exported and validate canonical envelopes', async () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const command of Object.keys(dataSchemas) as CommandName[]) {
    const schema = await Bun.file(
      `schemas/output/${command.replaceAll(' ', '-')}.schema.json`,
    ).json();
    const validate = ajv.compile(schema);
    const value = {
      ok: false,
      command,
      op_id: null,
      data: null,
      warnings: [],
      error: { code: 'TEST', message: 'failed', details: {} },
    };
    expect(validate(value)).toBe(true);
    expect(envelopeSchema(command).safeParse(value).success).toBe(true);
  }
});
test('configuration history tracks prescribed files and never .env', async () => {
  const ctx = new Context({ home: await temp() });
  await initGit(ctx);
  await fs.mkdir(ctx.p('apps', 'testapp'), { recursive: true });
  await fs.writeFile(ctx.p('omactl.yml'), 'instance_id: test\n');
  await fs.writeFile(ctx.p('apps', 'testapp', '.env'), 'SECRET=very-private\n');
  await fs.writeFile(ctx.p('apps', 'testapp', 'compose.yml'), 'services: {}\n');
  await commit(ctx, 'test [op]');
  const files = await git.listFiles({ fs: nodefs, dir: ctx.home });
  expect(files).toContain('apps/testapp/compose.yml');
  expect(files).not.toContain('apps/testapp/.env');
});
test('scheduler spreads nightly jobs deterministically and quotes paths safely', () => {
  const minute = nightlyMinute('instance-a', '23:30-01:00');
  expect(minute === nightlyMinute('instance-a', '23:30-01:00')).toBe(true);
  expect(minute >= 1410 || minute < 60).toBe(true);
  const units = systemdUnits('verify', '/home/a b', minute, '/path/a%bin');
  expect(units.service).toContain('"/home/a b"');
  expect(units.service).toContain('a%%bin');
  expect(units.service).toContain('After=docker.service');
  expect(launchPlist('nightly-backup', '/a&b', minute, '/binary')).toContain('/a&amp;b');
});
test('docker JSON accepts arrays, single objects and NDJSON', () => {
  expect(parseDockerJson('[{"ID":"1"}]')).toEqual([{ ID: '1' }]);
  expect(parseDockerJson('{"ID":"1"}\n{"ID":"2"}')).toHaveLength(2);
});
test('stable exit codes cover all ten outcomes', () =>
  expect(Object.values(EXIT).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

test('scheduler adapter uses mocked systemd and launchd without invoking host services', async () => {
  const { schedule } = await import('../../src/platform/scheduler');
  const home = await temp(),
    ctx = new Context({ home });
  await ctx.saveConfig({
    instance_id: 'inst_unit',
    base_domain: 'localhost',
    ingress: { http_port: 18080, https_port: 18443, tls: 'off', acme_email: null },
    channel: 'stable',
    release_url: 'https://example.com',
    updates: 'notify',
    backup: { repository: null, policy: 'self-managed', nightly_window: '01:00-05:00' },
    heartbeat: { url: null },
  });
  const calls: string[][] = [],
    run = async (args: string[]) => {
      calls.push(args);
      return args[0] !== 'print';
    };
  const runtime = {
    dir: path.join(home, 'units'),
    binary: path.join(home, 'omactl'),
    kind: 'linux',
    root: false,
    wsl: false,
    systemd: true,
    uid: 501,
    run,
  };
  await schedule(ctx, 'install', runtime);
  expect(calls.some((a) => a.join(' ') === '--user enable --now oma-nightly-backup.timer')).toBe(
    true,
  );
  expect(await exists(path.join(runtime.dir, 'oma-verify.service'))).toBe(true);
  expect(ctx.warnings.some((w) => w.code === 'LINGERING_REQUIRED')).toBe(true);
  await schedule(ctx, 'remove', runtime);
  expect(await exists(path.join(runtime.dir, 'oma-verify.service'))).toBe(false);
  calls.length = 0;
  const mac = { ...runtime, kind: 'darwin', dir: path.join(home, 'launch') };
  await schedule(ctx, 'install', mac);
  expect(calls.some((a) => a[0] === 'bootstrap' && a[1] === 'gui/501')).toBe(true);
  await schedule(ctx, 'remove', mac);
  await expect(
    schedule(ctx, 'install', { ...runtime, wsl: true, systemd: false }),
  ).rejects.toMatchObject({ exitCode: 3 });
});

test('catalog swap stages on the instance filesystem and retains the downloaded source', async () => {
  const { swapCatalog } = await import('../../src/update');
  const home = await temp(),
    source = path.join(await temp(), 'download'),
    ctx = new Context({ home });
  ctx.opId = 'op_unit';
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'catalog.json'), '{"version":"new"}');
  await fs.mkdir(ctx.p('catalog'), { recursive: true });
  await fs.writeFile(ctx.p('catalog', 'catalog.json'), '{"version":"old"}');
  await swapCatalog(ctx, source, {
    channel: 'stable',
    published_at: new Date().toISOString(),
    omactl: { version: '0.1.0', assets: {} },
    catalog: { version: 'new', url: 'https://example.com/catalog', sha256: 'a'.repeat(64) },
  });
  expect(await exists(path.join(source, 'catalog.json'))).toBe(true);
  expect(JSON.parse(await fs.readFile(ctx.p('catalog', 'catalog.json'), 'utf8')).version).toBe(
    'new',
  );
  expect(await exists(ctx.p('state', 'catalog-old-op_unit'))).toBe(false);
});

test('release publisher stages assets before publishing and skips assets with matching digests', async () => {
  const { publishGithub } = await import('../../scripts/github-release');
  const dir = await temp(),
    file = path.join(dir, 'omactl-test');
  await fs.writeFile(file, 'binary');
  const calls: { url: string; method: string; body: any }[] = [];
  const mocked = async (input: any, options: any = {}) => {
    const url = String(input);
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    if (url.includes('/tags/')) return new Response('', { status: 404 });
    if (url.endsWith('/releases'))
      return Response.json({
        id: 1,
        draft: true,
        assets: [],
        upload_url: 'https://uploads.github.com/assets{?name,label}',
      });
    return Response.json({});
  };
  await publishGithub('example/omactl', 'test-token', 'v0.1.0', [file], mocked);
  expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST', 'PATCH']);
  expect(calls[2].url).toBe('https://uploads.github.com/assets?name=omactl-test');
  expect(Buffer.from(calls[2].body).toString()).toBe('binary');
  expect(JSON.parse(calls[3].body)).toEqual({ draft: false });
  let count = 0;
  const identical = async () => {
    count++;
    return Response.json({
      id: 1,
      draft: false,
      assets: [{ name: 'omactl-test', digest: 'sha256:' + hash('binary') }],
      upload_url: 'https://uploads.github.com/assets{?name,label}',
    });
  };
  await publishGithub('example/omactl', 'test-token', 'v0.1.0', [file], identical);
  expect(count).toBe(1);
});

test.skipIf(process.platform !== 'linux')(
  'Linux packaging works without update signing keys',
  async () => {
    const dir = await temp();
    const catalog = '{"version":"test"}\n';
    await fs.mkdir(path.join(dir, 'dist'));
    await fs.mkdir(path.join(dir, 'catalog'));
    await fs.writeFile(path.join(dir, 'dist/omactl-linux-x64'), 'cli');
    await fs.writeFile(path.join(dir, 'catalog/catalog.json'), catalog);
    await fs.writeFile(path.join(dir, 'LICENSE'), 'license');

    const result = Bun.spawnSync([process.execPath, path.resolve('scripts/package-linux.ts')], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.exitCode).toBe(0);
    const archive = 'omactl-linux-x64.tar.gz';
    const files = await fs.readdir(path.join(dir, 'dist'));
    expect(files.sort()).toEqual(['SHA256SUMS', 'omactl-linux-x64', archive]);
    const checksum = hash(await fs.readFile(path.join(dir, 'dist', archive)));
    expect(await fs.readFile(path.join(dir, 'dist/SHA256SUMS'), 'utf8')).toBe(
      `${checksum}  ${archive}\n`,
    );
    expect(Bun.spawnSync(['tar', '-xzf', `dist/${archive}`], { cwd: dir }).exitCode).toBe(0);
    expect((await fs.stat(path.join(dir, 'bin/omactl'))).mode & 0o777).toBe(0o755);
  },
);

test('config templates preserve JSON and block braces while replacing named variables', () => {
  const ctx = { appId: 'testapp', base_domain: 'localhost' };
  expect(render('{"enabled":true,"name":"{appId}"}', ctx)).toBe(
    '{"enabled":true,"name":"testapp"}',
  );
  expect(render('server { listen 3000; }', ctx)).toBe('server { listen 3000; }');
  expect(() => render('{unknown:value}', ctx)).toThrow('Unresolved');
});
test('invalid ingress ports fail as usage errors before touching the instance', async () => {
  const home = path.join(await temp(), 'uncreated');
  for (const port of ['65536', '1.5']) {
    const child = Bun.spawn(
      [process.execPath, 'src/cli/index.ts', '--home', home, '--json', 'init', '--http-port', port],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(status).toBe(2);
    expect(JSON.parse(stdout).error.code).toBe('INVALID_USAGE');
  }
  expect(await exists(home)).toBe(false);
});
test('doctor recognizes a busy port and releases successful probes', async () => {
  const net = await import('node:net');
  const { probePort } = await import('../../src/platform/doctor');
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  expect(await probePort(port)).toBe('fail');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(await probePort(port)).toBe('ok');
});
