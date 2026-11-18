import { test, expect, beforeAll, afterAll } from 'bun:test';
import { fs, path, hash, write, writeJson, readEnv, walk, exists } from '../../src/core/fs';
import { archiveDir } from '../../src/core/tar';
import { build } from '../../scripts/build';
import { sign } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { Context } from '../../src/core/context';
import { docker, compose } from '../../src/docker';
import { acquireLock } from '../../src/core/lock';
import { dataSchemas, type CommandName } from '../../src/schemas';
import Ajv from 'ajv';
// These tests control the one OMA instance on an isolated Docker daemon. They refuse foreign OMA containers.
const enabled = process.env.OMA_E2E === '1';
const scenario = enabled ? test : test.skip;
const home = path.resolve('.e2e/acceptance'),
  ctx = new Context({ home }),
  bin = path.resolve('.e2e/bin/omactl');
const repo = path.resolve('.e2e/repository');
let server: ReturnType<typeof Bun.serve>;
let current = '2026.11.17-1',
  tamper = false;
const catalogs = new Map<string, { bytes: Uint8Array; sha256: string }>();
const responses: any[] = [];
let ownsDaemon = false;
let key: string;
let publicKey: string;
let apiKey: string;
let binaryBytes: Uint8Array;
let freezeRepository = false;
const ajv = new Ajv({ strict: false, validateFormats: false });
const validators = new Map<string, any>();
async function cli(args: string[], code = 0, executable = bin) {
  const child = Bun.spawn([executable, '--home', home, '--json', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 500000,
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let result: any;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`Invalid output (${status}): ${stdout}\n${stderr}`);
  }
  responses.push(result);
  const validate = validators.get(result.command);
  if (validate && !validate(result))
    throw new Error(`Schema mismatch: ${JSON.stringify(validate.errors)}\n${stdout}`);
  if (status !== code)
    throw new Error(
      `omactl ${args.join(' ')}: expected ${code}, got ${status}: ${stdout}\n${stderr}`,
    );
  return result;
}
async function config(patch: Record<string, unknown>) {
  const file = ctx.p('omactl.yml'),
    c = parse(await fs.readFile(file, 'utf8'));
  await write(file, stringify({ ...c, ...patch }));
}
async function api(route: string, options: RequestInit = {}) {
  return fetch('http://127.0.0.1:18080' + route, {
    ...options,
    headers: { Host: 'testapp.localhost', Authorization: `Bearer ${apiKey}`, ...options.headers },
    signal: AbortSignal.timeout(15000),
  });
}
async function releaseV1() {
  current = '2026.11.17-1';
  await cli(['update', 'testapp', '--to', current, '--allow-local-images']);
}
async function releaseV2() {
  current = '2026.11.17-2';
  await cli(['update', 'testapp', '--allow-local-images']);
}
beforeAll(async () => {
  if (!enabled) return;
  const foreign = await docker(ctx, [
    'ps',
    '-a',
    '--filter',
    'label=oma.managed=true',
    '--format',
    'json',
  ]);
  if (foreign.stdout.trim())
    throw new Error('E2E requires an isolated daemon with no existing OMA containers');
  const volumes = await docker(ctx, ['volume', 'ls', '--format', 'json']);
  if (
    volumes.stdout
      .split('\n')
      .filter(Boolean)
      .some((line) => /^oma_(testapp|traefik)_/.test(JSON.parse(line).Name))
  )
    throw new Error('E2E refuses existing fixture volumes; use an isolated daemon');
  ownsDaemon = true;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(repo, { recursive: true, force: true });
  await fs.mkdir(path.dirname(bin), { recursive: true });
  key = await fs.readFile('fixtures/keys/private.pem', 'utf8');
  publicKey = await fs.readFile('fixtures/keys/public.pem', 'utf8');
  for (const command of Object.keys(dataSchemas) as CommandName[])
    validators.set(
      command,
      ajv.compile(
        await Bun.file(`schemas/output/${command.replaceAll(' ', '-')}.schema.json`).json(),
      ),
    );
  for (const [version, dir] of [
    ['2026.11.17-1', 'fixtures/catalog-v1'],
    ['2026.11.17-2', 'fixtures/catalog-v2'],
    ['2026.11.17-broken', 'fixtures/catalog-v2-broken'],
  ]) {
    const bytes = await archiveDir(dir);
    catalogs.set(version, { bytes, sha256: hash(bytes) });
  }
  await build(`bun-${process.platform}-${process.arch}`, bin, '0.1.0', [publicKey]);
  const next = path.resolve('.e2e/bin/omactl-new');
  await build(`bun-${process.platform}-${process.arch}`, next, '0.2.0', [publicKey]);
  binaryBytes = await fs.readFile(next);
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url),
        base = url.origin;
      if (req.method === 'HEAD')
        return new Response('', { headers: { Date: new Date().toUTCString() } });
      if (url.pathname === '/omactl-new') return new Response(Buffer.from(binaryBytes));
      if (url.pathname.startsWith('/catalog/')) {
        const cat = catalogs.get(url.pathname.split('/').at(-1)!);
        return cat
          ? new Response(Buffer.from(cat.bytes))
          : new Response('missing', { status: 404 });
      }
      const m = /^\/(channels\/stable|versions\/([^/]+))\.json(\.sig)?$/.exec(url.pathname);
      if (m) {
        const version = m[2] ?? current,
          cat = catalogs.get(version);
        if (!cat) return new Response('missing', { status: 404 });
        const data = {
          channel: 'stable',
          published_at: new Date(0).toISOString(),
          omactl: {
            version: '0.2.0',
            assets: {
              [`${process.platform}-${process.arch}`]: {
                url: base + '/omactl-new',
                sha256: hash(binaryBytes),
              },
            },
          },
          catalog: { version, url: base + '/catalog/' + version, sha256: cat.sha256 },
        };
        const bytes = Buffer.from(JSON.stringify(data));
        return new Response(m[3] ? (tamper ? Buffer.alloc(64) : sign(null, bytes, key)) : bytes);
      }
      return new Response('not found', { status: 404 });
    },
  });
  // A deterministic test-only rollback failure: monitor the journal and make the local repository unreachable after the snapshot.
}, 600000);
afterAll(async () => {
  if (!enabled || !ownsDaemon) return;
  server?.stop(true);
  if (await exists(home)) {
    for (const id of ['testclient', 'testapp', 'traefik'])
      if (await exists(path.join(ctx.appDir(id), 'compose.yml')))
        await compose(ctx, id, ['down', '--volumes'], { allowFailure: true }).catch(() => {});
  }
  for (const name of [
    'oma_testapp_files',
    'oma_testapp_pgdata',
    'oma_testapp_dump',
    'oma_traefik_config',
    'oma_traefik_dynamic',
    'oma_traefik_acme',
  ])
    await docker(ctx, ['volume', 'rm', name], { allowFailure: true }).catch(() => {});
}, 600000);
scenario('01 doctor passes with a support tier', async () => {
  const r = await cli(['doctor']);
  expect(['1', '2']).toContain(r.data.support_tier);
  expect(r.data.checks.some((c: any) => c.status === 'fail')).toBe(false);
});
scenario('02 init starts Traefik and second init changes nothing', async () => {
  await cli(['init', '--catalog', 'fixtures/catalog-v1', '--http-port', '18080']);
  const before = await fs.readFile(ctx.p('omactl.yml'), 'utf8');
  const r = await cli(['init', '--catalog', 'fixtures/catalog-v1', '--http-port', '18080']);
  expect(r.op_id).toBeNull();
  expect(await fs.readFile(ctx.p('omactl.yml'), 'utf8')).toBe(before);
  expect((await fetch('http://127.0.0.1:18080')).status).toBe(404);
  await config({ release_url: `http://127.0.0.1:${server.port}` });
});
scenario(
  '03 install stores setup outputs, routes requests, verifies, and is idempotent',
  async () => {
    await cli(['install', 'testapp']);
    apiKey = (await cli(['credentials', 'testapp'])).data.values.TESTAPP_API_KEY;
    expect(apiKey.length).toBeGreaterThan(20);
    expect(((await (await api('/api/info')).json()) as any).version).toBe('1.0.0');
    await cli(['verify', 'testapp']);
    const before = await fs.readFile(path.join(ctx.appDir('testapp'), '.env'), 'utf8');
    const r = await cli(['install', 'testapp']);
    expect(r.data.results.every((r: any) => r.skipped)).toBe(true);
    expect(await fs.readFile(path.join(ctx.appDir('testapp'), '.env'), 'utf8')).toBe(before);
  },
);
scenario('04 setup twice keeps the same API key', async () => {
  await cli(['setup', 'testapp']);
  await cli(['setup', 'testapp']);
  expect((await cli(['credentials', 'testapp'])).data.values.TESTAPP_API_KEY).toBe(apiKey);
});
scenario('05 backup/restore recovers a note and file, including deleted pgdata', async () => {
  await cli(['backup', 'init', '--repository', repo]);
  const r = await api('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'persistent-note' }),
  });
  const note = (await r.json()) as any;
  await api('/api/files/persistent', { method: 'PUT', body: 'persistent-file' });
  await cli(['backup', 'run', '--app', 'testapp']);
  await api('/api/notes/' + note.id, { method: 'DELETE' });
  await api('/api/files/persistent', { method: 'DELETE' });
  await cli(['restore', 'testapp', '--latest', '--confirm', 'testapp']);
  expect(((await (await api('/api/notes/' + note.id)).json()) as any).body).toBe('persistent-note');
  expect(await (await api('/api/files/persistent')).text()).toBe('persistent-file');
  // Simulate a lost database. Keep the original snapshot because an empty database cannot supply a pre-restore dump.
  const snapshot = (await cli(['backup', 'list', '--app', 'testapp'])).data.snapshots.find(
    (s: any) => s.tags.includes('reason:manual'),
  ).id;
  await compose(ctx, 'testapp', ['down']);
  await docker(ctx, ['volume', 'rm', 'oma_testapp_pgdata']);
  // A new initialized database is started so the required pre-restore backup remains possible.
  await compose(ctx, 'testapp', ['up', '-d', '--wait', '--wait-timeout', '60']);
  await write(
    path.join(ctx.appDir('testapp'), 'compose.override.yml'),
    'services:\n  testapp:\n    environment:\n      RESTORE_MARKER: changed\n',
  );
  await cli([
    'restore',
    'testapp',
    '--snapshot',
    snapshot,
    '--with-config',
    '--confirm',
    'testapp',
  ]);
  expect(await exists(path.join(ctx.appDir('testapp'), 'compose.override.yml'))).toBe(false);
  expect(((await (await api('/api/notes/' + note.id)).json()) as any).body).toBe('persistent-note');
  expect(await (await api('/api/files/persistent')).text()).toBe('persistent-file');
});
scenario('06 required capabilities auto-link and provider removal is blocked', async () => {
  await cli(['install', 'testclient']);
  await cli(['verify', 'testclient']);
  expect((await cli(['status', 'testclient'])).data.apps[0].links['notes.api']).toBe('testapp');
  await cli(['remove', 'testapp'], 3);
  await cli(['unlink', 'testclient', 'testapp']);
  expect((await cli(['status', 'testclient'])).data.apps[0].state).toBe('degraded');
  await cli(['link', 'testclient', 'testapp']);
  expect((await cli(['status', 'testclient'])).data.apps[0].state).toBe('running');
  await cli(['domain', 'add', 'testapp', 'notes.localhost']);
  expect((await cli(['domain', 'list', 'testapp'])).data.domains.web).toContain('notes.localhost');
  const routed = await fetch('http://127.0.0.1:18080/api/info', {
    headers: { Host: 'notes.localhost', Authorization: `Bearer ${apiKey}` },
  });
  expect(routed.status).toBe(200);
  await cli(['domain', 'remove', 'testapp', 'notes.localhost']);
  expect(
    (await fetch('http://127.0.0.1:18080/', { headers: { Host: 'notes.localhost' } })).status,
  ).toBe(404);
  await cli(['remove', 'testapp', '--force']);
  expect((await cli(['status'])).data.orphaned_volumes).toContain('oma_testapp_pgdata');
  await cli(['install', 'testapp']);
  expect((await cli(['credentials', 'testapp'])).data.values.TESTAPP_API_KEY).toBe(apiKey);
  await cli(['link', 'testclient', 'testapp']);
});
scenario('07 overrides survive updates and remain effective', async () => {
  const override = 'services:\n  testapp:\n    environment:\n      SLOW_START_SECONDS: "2"\n';
  await write(path.join(ctx.appDir('testapp'), 'compose.override.yml'), override);
  expect((await cli(['overrides'])).data.apps[0].effective).toContain('SLOW_START_SECONDS');
  await releaseV2();
  expect(await fs.readFile(path.join(ctx.appDir('testapp'), 'compose.override.yml'), 'utf8')).toBe(
    override,
  );
  const conf = await compose(ctx, 'testapp', ['config', '--format', 'json']);
  expect(JSON.parse(conf.stdout).services.testapp.environment.SLOW_START_SECONDS).toBe('2');
});
scenario('08 signed v1 to v2 update records pre-update snapshot and migrates schema', async () => {
  await releaseV1();
  await releaseV2();
  const info = (await (await api('/api/info')).json()) as any;
  expect(info.schema).toBe(2);
  expect(info.version).toBe('2.0.0');
  const r = await cli(['backup', 'list', '--app', 'testapp', '--reason', 'pre-update']);
  expect(r.data.snapshots.length).toBeGreaterThan(0);
  await cli(['verify', 'testapp']);
});
scenario('09 failed update rolls back both definition and data with exit 6', async () => {
  await releaseV1();
  current = '2026.11.17-broken';
  await cli(['update', 'testapp', '--allow-local-images'], 6);
  expect(((await (await api('/api/info')).json()) as any).version).toBe('1.0.0');
  expect(((await (await api('/api/info')).json()) as any).notes).toBeGreaterThan(0);
  expect(await (await api('/api/files/persistent')).text()).toBe('persistent-file');
  await cli(['verify', 'testapp']);
});
scenario('10 unreachable repository during rollback produces exit 7 and needs_human', async () => {
  const dump = path.join(ctx.appDir('testapp'), 'hooks', 'dump.sh'),
    original = await fs.readFile(dump, 'utf8');
  // Pause immediately after the dump, then wait for the actual pre-update snapshot journal entry.
  const priorOps = new Set(await fs.readdir(ctx.p('state', 'ops')));
  let moved = false,
    watching = true;
  const monitor = (async () => {
    while (watching) {
      for (const file of await fs.readdir(ctx.p('state', 'ops'))) {
        if (priorOps.has(file)) continue;
        const op = await Bun.file(ctx.p('state', 'ops', file))
          .json()
          .catch(() => null);
        if (op?.command === 'update' && op.snapshots?.length && !moved) {
          await fs.rename(repo, repo + '.offline');
          moved = true;
        }
      }
      await Bun.sleep(25);
    }
  })();
  try {
    current = '2026.11.17-broken';
    await cli(['update', 'testapp', '--allow-local-images'], 7);
    expect(moved).toBe(true);
    expect((await cli(['status', 'testapp'])).data.apps[0].state).toBe('needs_human');
  } finally {
    watching = false;
    await monitor;
    if (moved) await fs.rename(repo + '.offline', repo);
    await write(dump, original);
  }
  current = '2026.11.17-1';
  await cli(['verify', 'testapp', '--repair']);
});
scenario(
  '11 reboot simulation repairs running apps and keeps intentionally stopped apps stopped',
  async () => {
    await cli(['stop', 'testclient']);
    for (const app of ['testapp', 'testclient', 'traefik']) await compose(ctx, app, ['down']);
    await cli(['verify', '--all', '--repair']);
    const s = await cli(['status', 'testclient']);
    expect(s.data.apps[0].desired_state).toBe('stopped');
    expect(s.data.apps[0].containers).toHaveLength(0);
    await cli(['start', 'testclient']);
    await cli(['verify', '--all']);
  },
);
scenario('12 concurrent mutations honor lock timeout', async () => {
  const file = path.join(ctx.appDir('testapp'), 'hooks', 'setup.sh'),
    original = await fs.readFile(file, 'utf8');
  await write(file, original + '\nsleep 1\n');
  const first = cli(['setup', 'testapp']);
  try {
    const end = Date.now() + 10000;
    while (!(await exists(ctx.p('state', 'lock'))) && Date.now() < end) await Bun.sleep(5);
    expect(await exists(ctx.p('state', 'lock'))).toBe(true);
    await cli(['setup', 'testapp', '--lock-timeout', '0.1'], 4);
    await first;
  } finally {
    await first.catch(() => {});
    await write(file, original);
  }
});
scenario('13 unconfirmed purge returns its plan and changes nothing', async () => {
  const before = await fs.readFile(path.join(ctx.appDir('testapp'), 'app.lock.json'), 'utf8');
  const r = await cli(['remove', 'testapp', '--purge'], 8);
  expect(r.data.confirmation).toBe('testapp');
  expect(await fs.readFile(path.join(ctx.appDir('testapp'), 'app.lock.json'), 'utf8')).toBe(before);
});
scenario(
  '14 self-update refuses tampering, installs new binary, and supports rollback',
  async () => {
    tamper = true;
    await cli(['self-update', '--check'], 3);
    tamper = false;
    await cli(['self-update']);
    expect((await cli(['version'])).data.version).toBe('0.2.0');
    await cli(['self-update', '--rollback', '--confirm', 'instance']);
    expect((await cli(['version'])).data.version).toBe('0.1.0');
  },
);
scenario('15 every collected JSON envelope validates against its command schema', () => {
  for (const r of responses) {
    const validate = validators.get(r.command);
    expect(validate(r)).toBe(true);
  }
  expect(responses.length).toBeGreaterThan(35);
});
scenario('16 generated secrets never appear in logs or operation journals', async () => {
  const secrets = await readEnv(path.join(ctx.appDir('testapp'), '.env'));
  const backup = await readEnv(ctx.p('secrets', 'backup.env'));
  for (const root of [ctx.p('logs'), ctx.p('state', 'ops')])
    for (const file of await walk(root)) {
      const text = await fs.readFile(path.join(root, file), 'utf8');
      for (const key of ['POSTGRES_PASSWORD', 'TESTAPP_BOOTSTRAP_TOKEN', 'TESTAPP_API_KEY'])
        expect(text).not.toContain(secrets[key]);
      expect(text).not.toContain(backup.RESTIC_PASSWORD);
    }
});
