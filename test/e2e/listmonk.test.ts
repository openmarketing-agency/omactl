import { test, expect } from 'bun:test';
import { parse } from 'yaml';
import { fs, path } from '../../src/core/fs';

const scenario = process.env.OMA_LISTMONK_E2E === '1' ? test : test.skip;
scenario(
  'Listmonk setup, API verification and logical restore preserve subscribers and uploads',
  async () => {
    // Unique projects and volumes allow this test to coexist with installed OMA apps.
    const project = 'omactl-listmonk-test-' + crypto.randomUUID().slice(0, 8);
    const root = path.resolve('.e2e', project);
    const app = path.resolve('catalog/apps/listmonk');
    const definition = parse(await fs.readFile(path.join(app, 'compose.yml'), 'utf8'));
    const secrets = [crypto.randomUUID(), crypto.randomUUID()];
    const env = {
      ...process.env,
      POSTGRES_PASSWORD: secrets[0],
      LISTMONK_ADMIN_USER: 'oma-admin',
      LISTMONK_ADMIN_PASSWORD: secrets[1],
      PUBLIC_URL: 'https://listmonk.example.invalid',
    };
    for (const [key, value] of Object.entries<any>(definition.volumes))
      value.name = `${project}_${key}`;
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
    const hook = async (service: string, name: string) => {
      const scriptName = ['setup', 'verify'].includes(name) ? 'app' : name;
      const script =
        `export OMA_HOOK=${name}\n` +
        (await fs.readFile(path.join(app, 'hooks', scriptName + '.sh'), 'utf8'));
      return compose(
        service === 'verify'
          ? ['run', '--rm', '-T', 'verify', 'sh', '-s']
          : ['exec', '-T', service, 'sh', '-s'],
        script,
      );
    };
    const sql = (query: string) =>
      compose(
        [
          'exec',
          '-T',
          'db',
          'psql',
          '-X',
          '-U',
          'listmonk',
          '-d',
          'listmonk',
          '-At',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        query,
      );
    try {
      await compose(['up', '-d', '--wait', '--wait-timeout', '180']);
      await hook('verify', 'setup');
      expect(await sql("SELECT value #>> '{}' FROM settings WHERE key='app.root_url';")).toBe(
        env.PUBLIC_URL,
      );
      await hook('verify', 'verify');
      await hook('verify', 'setup');
      await hook('verify', 'verify');
      expect(
        await sql("SELECT count(*) FROM subscribers WHERE email LIKE 'omactl-verify-%';"),
      ).toBe('0');
      expect(await sql("SELECT count(*) FROM lists WHERE name LIKE 'omactl-verify-%';")).toBe('0');
      await sql(
        "INSERT INTO subscribers (uuid,email,name) VALUES ('00000000-0000-4000-8000-000000000001','persist@example.invalid','Preserved subscriber');",
      );
      await compose(
        ['exec', '-T', 'listmonk', 'sh', '-s'],
        "printf '%s' 'persistent upload' > /listmonk/uploads/persistent.txt\n",
      );
      await compose(['stop', 'listmonk']);
      await hook('db', 'dump');
      await compose(['down']);
      await command(['volume', 'rm', `${project}_pgdata`]);
      await compose(['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
      await hook('db', 'load');
      await compose(['up', '-d', '--wait', '--wait-timeout', '180']);
      expect(await sql("SELECT name FROM subscribers WHERE email='persist@example.invalid';")).toBe(
        'Preserved subscriber',
      );
      expect(
        await compose(['exec', '-T', 'listmonk', 'cat', '/listmonk/uploads/persistent.txt']),
      ).toBe('persistent upload');
      await hook('verify', 'verify');
    } finally {
      await compose(['down', '--volumes', '--remove-orphans']);
    }
  },
  600000,
);
