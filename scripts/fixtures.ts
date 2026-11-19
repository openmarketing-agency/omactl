import { fs, path, write, writeJson } from '../src/core/fs';
import { stringify } from 'yaml';
import { TRAEFIK_IMAGE, POSTGRES_IMAGE } from '../src/docker/images';
import { generateKeyPairSync } from 'node:crypto';
const setup = `#!/bin/sh
set -eu
bun - <<'JS'
const response=await fetch('http://localhost:3000/admin/bootstrap',{method:'POST',headers:{'X-Bootstrap-Token':process.env.TESTAPP_BOOTSTRAP_TOKEN}});
if(!response.ok)throw new Error('bootstrap failed');
const data=await response.json();if(!data.api_key)throw new Error('API key missing');
console.log('OMA_OUTPUT TESTAPP_API_KEY='+data.api_key);
JS
`;
const verify = `#!/bin/sh
set -eu
bun - <<'JS'
const base='http://localhost:3000',headers={Authorization:'Bearer '+process.env.TESTAPP_API_KEY,'Content-Type':'application/json'},body='verify-'+crypto.randomUUID();
const create=await fetch(base+'/api/notes',{method:'POST',headers,body:JSON.stringify({body,tag:'oma-verify'})});if(!create.ok)throw new Error('create failed');const note=await create.json();
const read=await fetch(base+'/api/notes/'+note.id,{headers});if(!read.ok||(await read.json()).body!==body)throw new Error('note mismatch');
if(!(await fetch(base+'/api/notes/'+note.id,{method:'DELETE',headers})).ok)throw new Error('delete failed');
const file='verify-'+crypto.randomUUID();if(!(await fetch(base+'/api/files/'+file,{method:'PUT',headers,body})).ok)throw new Error('write failed');const result=await fetch(base+'/api/files/'+file,{headers});if(!result.ok||await result.text()!==body)throw new Error('file mismatch');await fetch(base+'/api/files/'+file,{method:'DELETE',headers});
JS
`;
const clientVerify = `#!/bin/sh
set -eu
bun - <<'JS'
const r=await fetch('http://localhost:3000/sync',{method:'POST'});if(!r.ok)throw new Error('sync failed');const data=await r.json();if(!data.written?.body||data.written.body!==data.read?.body)throw new Error('sync mismatch');
JS
`;
const dump = '#!/bin/sh\nset -eu\npg_dump -U oma -d oma -Fc -f /dump/db.dump\n';
const load =
  '#!/bin/sh\nset -eu\npg_restore -U oma -d oma --clean --if-exists --no-owner /dump/db.dump\n';
const health = {
  test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/healthz'],
  interval: '1s',
  timeout: '3s',
  retries: 30,
  start_period: '2s',
};
const hook = (service: string, script: string, timeout = 120) => ({
  service,
  script: 'hooks/' + script,
  timeout,
});
const main = async (root: string, version: string, broken = false) => {
  if (root === 'catalog') {
    for (const entry of [
      'system/traefik',
      'apps/testapp',
      'apps/testclient',
      'bundles/notes-demo.yml',
    ])
      await fs.rm(path.join(root, entry), { recursive: true, force: true });
  } else await fs.rm(root, { recursive: true, force: true });
  await writeJson(path.join(root, 'catalog.json'), {
    version:
      root === 'catalog'
        ? '2026.11.19-4'
        : version === '1.0.0'
          ? '2026.11.17-1'
          : broken
            ? '2026.11.17-broken'
            : '2026.11.17-2',
    min_omactl: '0.1.0',
  });
  const tf = path.join(root, 'system', 'traefik');
  await write(
    path.join(tf, 'manifest.yml'),
    stringify({
      id: 'traefik',
      name: 'Traefik',
      version: '3.6.2',
      description: 'File-provider ingress; never mounts the Docker socket',
      resources: { memory_mb: 128, disk_mb: 128 },
      main_service: 'traefik',
      volumes: ['config', 'dynamic', 'acme'].map((key) => ({ key, backup: 'files' })),
      hooks: { setup: hook('traefik', 'setup.sh'), verify: hook('traefik', 'verify.sh') },
      ready_timeout: 60,
    }),
  );
  await write(
    path.join(tf, 'compose.yml'),
    stringify({
      services: {
        traefik: {
          image: TRAEFIK_IMAGE,
          volumes: ['config:/etc/traefik:ro', 'dynamic:/etc/traefik/dynamic:ro', 'acme:/acme'],
          healthcheck: {
            test: ['CMD', 'traefik', 'healthcheck', '--ping'],
            interval: '1s',
            timeout: '3s',
            retries: 30,
          },
        },
      },
      volumes: Object.fromEntries(
        ['config', 'dynamic', 'acme'].map((k) => [k, { name: `oma_traefik_${k}` }]),
      ),
    }),
  );
  await write(path.join(tf, 'hooks', 'setup.sh'), '#!/bin/sh\nset -eu\ntrue\n');
  await write(
    path.join(tf, 'hooks', 'verify.sh'),
    '#!/bin/sh\nset -eu\ntraefik healthcheck --ping\n',
  );
  const app = path.join(root, 'apps', 'testapp');
  await write(
    path.join(app, 'manifest.yml'),
    stringify({
      id: 'testapp',
      name: 'Test App',
      version,
      description: 'Stateful PostgreSQL and files fixture',
      resources: { memory_mb: 256, disk_mb: 512 },
      requires: ['traefik'],
      main_service: 'testapp',
      routes: [{ name: 'web', service: 'testapp', port: 3000, host: '{appId}.{base_domain}' }],
      volumes: [
        { key: 'files', backup: 'files' },
        { key: 'pgdata', backup: 'skip' },
        { key: 'dump', backup: 'files' },
      ],
      stop_during_backup: false,
      env: [
        { name: 'POSTGRES_PASSWORD', generate: 'password:32', secret: true },
        { name: 'TESTAPP_BOOTSTRAP_TOKEN', generate: 'token:32', secret: true },
        { name: 'PUBLIC_URL', value: '{url:web}' },
      ],
      provides: [
        {
          capability: 'notes.api',
          outputs: { url: 'http://{appId}:3000', api_key: '{output:TESTAPP_API_KEY}' },
        },
      ],
      hooks: {
        setup: hook('testapp', 'setup.sh'),
        verify: hook('testapp', 'verify.sh', 60),
        pre_backup: hook('db', 'dump.sh', 300),
        post_restore: hook('db', 'load.sh', 300),
      },
      ready_timeout: 30,
    }),
  );
  await write(
    path.join(app, 'compose.yml'),
    stringify({
      services: {
        testapp: {
          image: `omactl-testapp:${version}`,
          environment: {
            MODE: 'server',
            PGHOST: 'db',
            PGUSER: 'oma',
            PGDATABASE: 'oma',
            POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}',
            TESTAPP_BOOTSTRAP_TOKEN: '${TESTAPP_BOOTSTRAP_TOKEN}',
            PUBLIC_URL: '${PUBLIC_URL}',
            ...(broken ? { FAIL_MIGRATION: '1' } : {}),
          },
          depends_on: { db: { condition: 'service_healthy' } },
          volumes: ['files:/data/files'],
          healthcheck: health,
        },
        db: {
          image: POSTGRES_IMAGE,
          environment: {
            POSTGRES_USER: 'oma',
            POSTGRES_DB: 'oma',
            POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}',
            PGPASSWORD: '${POSTGRES_PASSWORD}',
          },
          volumes: ['pgdata:/var/lib/postgresql/data', 'dump:/dump'],
          healthcheck: {
            test: ['CMD-SHELL', 'pg_isready -U oma -d oma'],
            interval: '1s',
            timeout: '3s',
            retries: 30,
          },
        },
      },
      volumes: Object.fromEntries(
        ['files', 'pgdata', 'dump'].map((k) => [k, { name: `oma_testapp_${k}` }]),
      ),
    }),
  );
  for (const [file, script] of Object.entries({
    'setup.sh': setup,
    'verify.sh': verify,
    'dump.sh': dump,
    'load.sh': load,
  }))
    await write(path.join(app, 'hooks', file), script);
  const client = path.join(root, 'apps', 'testclient');
  await write(
    path.join(client, 'manifest.yml'),
    stringify({
      id: 'testclient',
      name: 'Test Client',
      version,
      description: 'Capability-link consumer fixture',
      resources: { memory_mb: 128, disk_mb: 64 },
      requires: ['traefik'],
      main_service: 'testclient',
      routes: [{ name: 'web', service: 'testclient', port: 3000, host: '{appId}.{base_domain}' }],
      consumes: [
        {
          capability: 'notes.api',
          required: true,
          env_prefix: 'NOTES_',
          default_provider: 'testapp',
        },
      ],
      hooks: {
        setup: hook('testclient', 'setup.sh'),
        verify: hook('testclient', 'verify.sh', 60),
        on_link: hook('testclient', 'setup.sh'),
      },
      ready_timeout: 30,
    }),
  );
  await write(
    path.join(client, 'compose.yml'),
    stringify({
      services: {
        testclient: {
          image: `omactl-testapp:${version}`,
          environment: {
            MODE: 'client',
            NOTES_URL: '${NOTES_URL}',
            NOTES_API_KEY: '${NOTES_API_KEY}',
          },
          healthcheck: health,
        },
      },
    }),
  );
  await write(path.join(client, 'hooks', 'setup.sh'), '#!/bin/sh\nset -eu\ntrue\n');
  await write(path.join(client, 'hooks', 'verify.sh'), clientVerify);
  await write(
    path.join(root, 'bundles', 'notes-demo.yml'),
    stringify({ id: 'notes-demo', apps: ['testapp', 'testclient'] }),
  );
  for (const dir of [app, client, tf])
    await write(
      path.join(dir, 'README.md'),
      '# ' + path.basename(dir) + '\n\nDevelopment fixture for the omactl acceptance suite.\n',
    );
};
for (const [root, version, broken] of [
  ['catalog', '1.0.0', false],
  ['fixtures/catalog-v1', '1.0.0', false],
  ['fixtures/catalog-v2', '2.0.0', false],
  ['fixtures/catalog-v2-broken', '2.0.0', true],
] as const)
  await main(root, version, broken);
if (!(await Bun.file('fixtures/keys/private.pem').exists())) {
  const keys = generateKeyPairSync('ed25519');
  await write(
    'fixtures/keys/private.pem',
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    0o600,
  );
  await write(
    'fixtures/keys/public.pem',
    keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
}
console.log(
  'Fixture catalogs generated. Test keys are deliberately public and must never be trusted by production builds.',
);
