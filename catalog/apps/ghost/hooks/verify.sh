#!/bin/sh
set -eu
# Match the application's user so the filesystem check exercises its permissions.
gosu node node --input-type=module - <<'JS'
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
const require = createRequire('/var/lib/ghost/current/package.json');
const mysql = require('mysql2/promise');
const connection = await mysql.createConnection({
  host: process.env.database__connection__host,
  port: Number(process.env.database__connection__port),
  user: process.env.database__connection__user,
  password: process.env.database__connection__password,
  database: process.env.database__connection__database,
  connectTimeout: 20000,
});
const marker = 'omactl-verify-' + crypto.randomUUID();
const file = '/var/lib/ghost/content/images/' + marker + '.png';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
try {
  const [settings] = await connection.execute('SELECT value FROM settings WHERE `key` = ?', ['title']);
  if (!settings.length || typeof settings[0].value !== 'string') throw new Error('Ghost database has no site title');
  // Connection-local storage exercises writes without modifying Ghost's schema or content.
  await connection.query('CREATE TEMPORARY TABLE omactl_verify (value VARCHAR(100) NOT NULL)');
  await connection.execute('INSERT INTO omactl_verify (value) VALUES (?)', [marker]);
  const [rows] = await connection.query('SELECT value FROM omactl_verify');
  if (rows.length !== 1 || rows[0].value !== marker) throw new Error('Ghost database readback mismatch');
  await connection.query('DROP TEMPORARY TABLE omactl_verify');
  await mkdir('/var/lib/ghost/content/images', { recursive: true });
  await writeFile(file, image, { flag: 'wx' });
  if (!(await readFile(file)).equals(image)) throw new Error('Ghost content volume readback mismatch');
  const url = new URL(process.env.url);
  const response = await fetch('http://127.0.0.1:2368/content/images/' + marker + '.png', {
    headers: { Host: url.host, 'X-Forwarded-Proto': url.protocol.slice(0, -1) },
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(image)) throw new Error('Ghost image HTTP readback mismatch');
} finally {
  try {
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } finally {
    await connection.end();
  }
}
console.log('Ghost database, content volume and image HTTP checks passed.');
JS
