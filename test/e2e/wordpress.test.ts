import { test, expect, beforeAll, afterAll } from 'bun:test';
import { hook } from '../../src/apps/hooks';
import { Context } from '../../src/core/context';
import { docker, compose } from '../../src/docker';
import { fs, path, exists, readEnv, walk } from '../../src/core/fs';
const enabled = process.env.OMA_WORDPRESS_E2E === '1';
const scenario = enabled ? test : test.skip;
const home = path.resolve('.e2e/wordpress-acceptance'),
  ctx = new Context({ home });
let owned = false;
async function cli(args: string[]) {
  const p = Bun.spawn([process.execPath, 'src/cli/index.ts', '--home', home, '--json', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 600000,
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`omactl ${args[0]} failed: ${out} ${err}`);
  return JSON.parse(out).data;
}
async function php(code: string) {
  const r = await compose(ctx, 'wordpress', ['run', '--rm', '-T', 'wpcli', 'sh', '-s'], {
    input: `set -eu\ncd /var/www/html\nwp eval '${code}'\n`,
  });
  return r.stdout.trim();
}
beforeAll(async () => {
  if (!enabled) return;
  const running = await docker(ctx, [
    'ps',
    '-a',
    '--filter',
    'label=oma.managed=true',
    '--format',
    'json',
  ]);
  const volumes = await docker(ctx, ['volume', 'ls', '--format', 'json']);
  if (
    running.stdout.trim() ||
    volumes.stdout
      .split('\n')
      .filter(Boolean)
      .some((v) => /^oma_(wordpress|traefik)_/.test(JSON.parse(v).Name))
  )
    throw new Error(
      'WordPress e2e requires an isolated daemon without existing OMA apps or app volumes',
    );
  owned = true;
  await fs.rm(path.resolve('.e2e/wordpress-repository'), { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
  await cli(['init', '--catalog', 'catalog', '--http-port', '18082']);
}, 600000);
afterAll(async () => {
  if (!owned) return;
  for (const id of ['wordpress', 'traefik'])
    if (await exists(path.join(ctx.appDir(id), 'compose.yml')))
      await compose(ctx, id, ['down', '--volumes'], { allowFailure: true });
  for (const name of [
    'oma_wordpress_html',
    'oma_wordpress_dbdata',
    'oma_wordpress_dump',
    'oma_traefik_config',
    'oma_traefik_dynamic',
    'oma_traefik_acme',
  ])
    await docker(ctx, ['volume', 'rm', name], { allowFailure: true });
}, 600000);
scenario(
  'WordPress installs, preserves credentials, verifies and restores SQL and uploads after database loss',
  async () => {
    await cli(['install', 'wordpress']);
    await cli(['verify', 'wordpress']);
    const env = await readEnv(path.join(ctx.appDir('wordpress'), '.env'));
    await cli(['setup', 'wordpress']);
    await cli(['setup', 'wordpress']);
    expect(
      (await readEnv(path.join(ctx.appDir('wordpress'), '.env'))).WORDPRESS_ADMIN_PASSWORD,
    ).toBe(env.WORDPRESS_ADMIN_PASSWORD);
    const response = await fetch('http://127.0.0.1:18082/?rest_route=/', {
      headers: { Host: 'wordpress.localhost' },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).routes['/wp/v2/posts']).toBeDefined();
    const seeded = JSON.parse(
      await php(
        '$id=wp_insert_post(array("post_title"=>"omactl persistent post","post_content"=>"preserve this content","post_status"=>"draft"),true);if(is_wp_error($id))throw new Exception("Seed failed");$f=wp_upload_bits("omactl-persistent.txt",null,"persistent upload");if($f["error"])throw new Exception("Upload failed");echo json_encode(array("post"=>$id,"file"=>$f["file"]));',
      ),
    );
    await hook(ctx, 'wordpress', 'migrate');
    await cli(['setup', 'wordpress']);
    await cli(['verify', 'wordpress']);
    await cli(['backup', 'init', '--repository', path.resolve('.e2e/wordpress-repository')]);
    const backup = await cli(['backup', 'run', '--app', 'wordpress']);
    const snapshot = backup.results[0].snapshot;
    await php(
      `wp_delete_post(${seeded.post},true);wp_delete_file(${JSON.stringify(seeded.file)});`,
    );
    await compose(ctx, 'wordpress', ['down']);
    await docker(ctx, ['volume', 'rm', 'oma_wordpress_dbdata']);
    await cli(['restore', 'wordpress', '--snapshot', snapshot, '--confirm', 'wordpress']);
    expect(await php(`echo get_post(${seeded.post})->post_content;`)).toBe('preserve this content');
    expect(await php(`echo file_get_contents(${JSON.stringify(seeded.file)});`)).toBe(
      'persistent upload',
    );
    await cli(['verify', 'wordpress']);
    for (const root of [ctx.p('logs'), ctx.p('state', 'ops')])
      for (const name of await walk(root)) {
        const text = await fs.readFile(path.join(root, name), 'utf8');
        for (const [key, value] of Object.entries(env))
          if (/PASSWORD|_KEY$|_SALT$/.test(key)) expect(text).not.toContain(value);
      }
  },
  600000,
);
