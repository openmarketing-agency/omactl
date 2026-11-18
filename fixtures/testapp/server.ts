import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const mode = process.env.MODE ?? 'server',
  version = process.env.APP_VERSION ?? '1.0.0',
  v2 = version.startsWith('2.');
const sql =
  mode === 'server'
    ? new SQL({
        hostname: process.env.PGHOST ?? 'db',
        port: 5432,
        username: process.env.PGUSER ?? 'oma',
        password: process.env.POSTGRES_PASSWORD,
        database: process.env.PGDATABASE ?? 'oma',
        max: 5,
      })
    : null;
let ready = false;
async function boot() {
  if (sql) {
    await sql`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS notes (id text PRIMARY KEY, body text NOT NULL, created_at timestamptz DEFAULT now())`;
    if (v2) {
      if (process.env.FAIL_MIGRATION === '1') {
        console.error('Injected migration failure');
        process.exit(1);
      }
      await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS tag text`;
    }
    await fs.mkdir('/data/files', { recursive: true });
  }
  await Bun.sleep(Number(process.env.SLOW_START_SECONDS ?? 0) * 1000);
  ready = true;
}
void boot().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });
Bun.serve({
  port: 3000,
  async fetch(req) {
    try {
      const url = new URL(req.url),
        route = url.pathname;
      if (route === '/healthz') {
        if (process.env.FAIL_HEALTH === '1' || !ready) return fail('not ready', 503);
        if (sql) await sql`SELECT 1`;
        return Response.json({ ok: true });
      }
      if (!ready) return fail('not ready', 503);
      if (mode === 'client') {
        if (route === '/sync' && req.method === 'POST') {
          const base = process.env.NOTES_URL,
            key = process.env.NOTES_API_KEY;
          if (!base || !key) return fail('not linked', 503);
          const body = `client-${randomBytes(12).toString('hex')}`;
          const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
          const created = await fetch(base + '/api/notes', {
            method: 'POST',
            headers,
            body: JSON.stringify({ body, tag: 'oma-client' }),
          });
          if (!created.ok) return fail('provider write failed', 502);
          const note = (await created.json()) as any;
          const read = await fetch(base + '/api/notes/' + note.id, { headers });
          const fetched = (await read.json()) as any;
          await fetch(base + '/api/notes/' + note.id, { method: 'DELETE', headers });
          if (!read.ok || fetched.body !== body) return fail('read mismatch', 502);
          return Response.json({ written: { ...note, body }, read: fetched });
        }
        return fail('not found', 404);
      }
      if (route === '/admin/bootstrap' && req.method === 'POST') {
        if (
          !process.env.TESTAPP_BOOTSTRAP_TOKEN ||
          req.headers.get('X-Bootstrap-Token') !== process.env.TESTAPP_BOOTSTRAP_TOKEN
        )
          return fail('unauthorized', 401);
        const key = randomBytes(32).toString('base64url');
        const [row] =
          await sql!`INSERT INTO settings (key,value) VALUES ('api_key',${key}) ON CONFLICT (key) DO UPDATE SET key=EXCLUDED.key RETURNING value`;
        return Response.json({ api_key: row.value });
      }
      const [admin] = await sql!`SELECT value FROM settings WHERE key='api_key'`;
      if (!admin || req.headers.get('Authorization') !== `Bearer ${admin.value}`)
        return fail('unauthorized', 401);
      if (route === '/api/info') {
        const [row] = await sql!`SELECT count(*)::int AS notes FROM notes`;
        return Response.json({ version, schema: v2 ? 2 : 1, notes: row.notes });
      }
      if (route === '/api/notes' && req.method === 'POST') {
        const data = (await req.json()) as any;
        if (typeof data.body !== 'string') return fail('body required');
        const id = randomBytes(12).toString('hex');
        if (v2)
          await sql!`INSERT INTO notes (id,body,tag) VALUES (${id},${data.body},${data.tag ?? null})`;
        else await sql!`INSERT INTO notes (id,body) VALUES (${id},${data.body})`;
        return Response.json({ id }, { status: 201 });
      }
      const note = /^\/api\/notes\/([a-f0-9]+)$/.exec(route);
      if (note) {
        if (req.method === 'DELETE') {
          await sql!`DELETE FROM notes WHERE id=${note[1]}`;
          return Response.json({ deleted: true });
        }
        const [row] = v2
          ? await sql!`SELECT id,body,tag,created_at FROM notes WHERE id=${note[1]}`
          : await sql!`SELECT id,body,created_at FROM notes WHERE id=${note[1]}`;
        return row ? Response.json(row) : fail('not found', 404);
      }
      const file = /^\/api\/files\/([a-zA-Z0-9._-]+)$/.exec(route);
      if (file && file[1] !== '.' && file[1] !== '..') {
        const p = path.join('/data/files', file[1]);
        if (req.method === 'PUT') {
          await fs.writeFile(p, new Uint8Array(await req.arrayBuffer()));
          return Response.json({ written: true });
        }
        if (req.method === 'DELETE') {
          await fs.rm(p, { force: true });
          return Response.json({ deleted: true });
        }
        return (await Bun.file(p).exists()) ? new Response(Bun.file(p)) : fail('not found', 404);
      }
      return fail('not found', 404);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), 500);
    }
  },
});
