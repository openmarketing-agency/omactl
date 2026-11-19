import { test, expect } from 'bun:test';
import { parse } from 'yaml';
import { fs, path } from '../../src/core/fs';

const scenario = process.env.OMA_UMAMI_E2E === '1' ? test : test.skip;
scenario(
  'Umami secures the administrator, records pageviews and restores analytics after database loss',
  async () => {
    const project = 'omactl-umami-test-' + crypto.randomUUID().slice(0, 8);
    const root = path.resolve('.e2e', project);
    const app = path.resolve('catalog/apps/umami');
    const definition = parse(await fs.readFile(path.join(app, 'compose.yml'), 'utf8'));
    const secrets = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const env = {
      ...process.env,
      POSTGRES_PASSWORD: secrets[0],
      APP_SECRET: secrets[1],
      UMAMI_ADMIN_PASSWORD: secrets[2],
    };
    for (const [key, volume] of Object.entries<any>(definition.volumes))
      volume.name = `${project}_${key}`;
    await fs.mkdir(root, { recursive: true });
    const composeFile = path.join(root, 'compose.json');
    await fs.writeFile(composeFile, JSON.stringify(definition));
    async function command(args: string[], input?: string) {
      const p = Bun.spawn(['docker', ...args], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: input === undefined ? 'ignore' : 'pipe',
      });
      if (input !== undefined) {
        p.stdin!.write(input);
        p.stdin!.end();
      }
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (code !== 0) {
        let message = stdout + stderr;
        for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]');
        throw new Error(message);
      }
      return stdout.trim();
    }
    const compose = (args: string[], input?: string) =>
      command(['compose', '-p', project, '-f', composeFile, ...args], input);
    const hook = async (service: string, name: string) =>
      compose(
        ['exec', '-T', service, 'sh', '-s'],
        `export OMA_HOOK=${name}\n` +
          (await fs.readFile(
            path.join(app, 'hooks', ['setup', 'verify'].includes(name) ? 'app.sh' : name + '.sh'),
            'utf8',
          )),
      );
    const sql = (query: string) =>
      compose(
        [
          'exec',
          '-T',
          'db',
          'psql',
          '-X',
          '-U',
          'umami',
          '-d',
          'umami',
          '-At',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        query,
      );
    const api = (script: string) =>
      compose(
        ['exec', '-T', 'umami', 'node', '--input-type=module', '-'],
        `
let token;
async function api(path, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:3000/api' + path, {
    method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('API request failed (' + response.status + ')');
  return response.json();
}
token = (await api('/auth/login', 'POST', { username: 'admin', password: process.env.UMAMI_ADMIN_PASSWORD })).token;
${script}
`,
      );
    try {
      await compose(['up', '-d', '--wait', '--wait-timeout', '180']);
      await hook('umami', 'setup');
      const passwordHash = await sql('SELECT password FROM "user" WHERE username=\'admin\';');
      await hook('umami', 'setup');
      expect(await sql('SELECT password FROM "user" WHERE username=\'admin\';')).toBe(passwordHash);
      expect(
        await compose(
          ['exec', '-T', 'umami', 'node', '--input-type=module', '-'],
          `
const response = await fetch('http://127.0.0.1:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({username:'admin',password:'umami'}) });
console.log(response.status);
`,
        ),
      ).toBe('401');
      await hook('umami', 'verify');
      expect(await sql("SELECT count(*) FROM website WHERE name LIKE 'omactl-verify-%';")).toBe(
        '0',
      );
      expect(await sql('SELECT count(*) FROM website_event;')).toBe('0');
      const websiteId = await api(`
const website = await api('/websites', 'POST', { name: 'Persistent analytics', domain: 'example.invalid' });
await api('/send', 'POST', { type: 'event', payload: { website: website.id, hostname: 'example.invalid', url: '/persistent', language: 'en-US', screen: '1280x720' } });
console.log(website.id);
`);
      expect(websiteId).toMatch(/^[a-f0-9-]{36}$/);
      await compose(['stop', 'umami']);
      await hook('db', 'dump');
      await compose(['down']);
      await command(['volume', 'rm', `${project}_pgdata`]);
      await compose(['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
      await hook('db', 'load');
      await compose(['up', '-d', '--wait', '--wait-timeout', '180']);
      await hook('umami', 'setup');
      expect(await sql('SELECT password FROM "user" WHERE username=\'admin\';')).toBe(passwordHash);
      const restored = JSON.parse(
        await api(`
const website = await api('/websites/${websiteId}');
const stats = await api('/websites/${websiteId}/stats?startAt=' + (Date.now()-3600000) + '&endAt=' + (Date.now()+60000));
console.log(JSON.stringify({name: website.name, pageviews: stats.pageviews, visitors: stats.visitors}));
`),
      );
      expect(restored).toEqual({ name: 'Persistent analytics', pageviews: 1, visitors: 1 });
      await hook('umami', 'verify');
    } finally {
      await compose(['down', '--volumes', '--remove-orphans']);
    }
  },
  600000,
);
