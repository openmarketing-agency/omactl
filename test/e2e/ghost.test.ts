import { test, expect } from 'bun:test';
import { parse } from 'yaml';
import { fs, path } from '../../src/core/fs';

const scenario = process.env.OMA_GHOST_E2E === '1' ? test : test.skip;
scenario(
  'Ghost setup, content serving and logical restore preserve settings and files after database loss',
  async () => {
    const project = 'omactl-ghost-test-' + crypto.randomUUID().slice(0, 8);
    const root = path.resolve('.e2e', project);
    const app = path.resolve('catalog/apps/ghost');
    const definition = parse(await fs.readFile(path.join(app, 'compose.yml'), 'utf8'));
    const secrets = [crypto.randomUUID(), crypto.randomUUID()];
    const env = {
      ...process.env,
      GHOST_DB_PASSWORD: secrets[0],
      MYSQL_ROOT_PASSWORD: secrets[1],
      PUBLIC_URL: 'http://ghost.example.invalid',
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
        await fs.readFile(path.join(app, 'hooks', name + '.sh'), 'utf8'),
      );
    const sql = (query: string) =>
      compose(
        [
          'exec',
          '-T',
          'db',
          'sh',
          '-c',
          'export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysql --user=ghost --database=ghost --batch --skip-column-names',
        ],
        query,
      );
    try {
      await compose(['up', '-d', '--wait', '--wait-timeout', '180']);
      await hook('ghost', 'setup');
      await hook('ghost', 'setup');
      await hook('ghost', 'verify');
      await compose(['stop', 'ghost']);
      await sql("UPDATE settings SET value='Persistent Ghost title' WHERE `key`='title';");
      await compose(['up', '-d', '--wait', '--wait-timeout', '180']);
      await compose(
        ['exec', '-T', 'ghost', 'sh', '-s'],
        "printf '%s' 'persistent content' > /var/lib/ghost/content/persistent.txt\n",
      );
      await hook('ghost', 'setup');
      expect(await sql("SELECT value FROM settings WHERE `key`='title';")).toBe(
        'Persistent Ghost title',
      );
      await compose(['stop', 'ghost']);
      await hook('db', 'dump');
      await compose(['down']);
      await command(['volume', 'rm', `${project}_dbdata`]);
      await compose(['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
      await hook('db', 'load');
      await compose(['up', '-d', '--wait', '--wait-timeout', '180']);
      expect(await sql("SELECT value FROM settings WHERE `key`='title';")).toBe(
        'Persistent Ghost title',
      );
      expect(
        await compose(['exec', '-T', 'ghost', 'cat', '/var/lib/ghost/content/persistent.txt']),
      ).toBe('persistent content');
      await hook('ghost', 'setup');
      await hook('ghost', 'verify');
      expect(
        await compose(
          ['exec', '-T', 'ghost', 'sh', '-s'],
          'find /var/lib/ghost/content/images -name "omactl-verify-*" -print\n',
        ),
      ).toBe('');
    } catch (error) {
      let logs = await compose(['logs', '--no-color', '--tail', '120']).catch(
        () => 'Container logs unavailable.',
      );
      for (const secret of secrets) logs = logs.replaceAll(secret, '[REDACTED]');
      throw new Error(String(error) + '\nContainer diagnostics:\n' + logs);
    } finally {
      await compose(['down', '--volumes', '--remove-orphans']);
    }
  },
  600000,
);
