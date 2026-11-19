#!/bin/sh
set -eu
bun - <<'JS'
import { unlink } from 'node:fs/promises';
const base = 'http://listmonk:9000';
const cookies = new Map();
async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Cookie', [...cookies].map(([k,v]) => `${k}=${v}`).join('; '));
  if (cookies.has('_csrf')) headers.set('X-CSRF-Token', cookies.get('_csrf'));
  const response = await fetch(base + path, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0], at = pair.indexOf('=');
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return response;
}
async function api(path, method = 'GET', body) {
  const response = await request('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Listmonk ${method} ${path} failed (${response.status})`);
  return (await response.json()).data;
}
await request('/admin/login');
const login = await request('/admin/login', { method: 'POST', body: new URLSearchParams({ username: process.env.LISTMONK_ADMIN_USER, password: process.env.LISTMONK_ADMIN_PASSWORD, next: '/admin' }) });
if (login.status !== 302) throw new Error('Listmonk administrator login failed');
if (['setup', 'on_public_url'].includes(process.env.OMA_HOOK)) {
  try {
    const settings = await api('/settings');
    if (process.env.OMA_HOOK === 'on_public_url' || settings['app.root_url'] === 'http://localhost:9000') {
      settings['app.root_url'] = process.env.PUBLIC_URL;
      await api('/settings', 'PUT', settings);
    }
  } finally {
    await request('/admin/logout');
  }
  console.log('Listmonk settings initialized.');
  process.exit(0);
}
const marker = 'omactl-verify-' + crypto.randomUUID();
const file = '/listmonk/uploads/' + marker + '.txt';
let list, subscriber;
try {
  list = await api('/lists', 'POST', { name: marker, type: 'private', optin: 'single', tags: ['omactl-verify'] });
  if ((await api('/lists/' + list.id)).name !== marker) throw new Error('List readback mismatch');
  subscriber = await api('/subscribers', 'POST', { email: marker + '@example.invalid', name: marker, status: 'enabled', lists: [list.id], preconfirm_subscriptions: true });
  if ((await api('/subscribers/' + subscriber.id)).name !== marker) throw new Error('Subscriber readback mismatch');
  await Bun.write(file, marker);
  if (await Bun.file(file).text() !== marker) throw new Error('Upload volume readback mismatch');
} finally {
  try {
    if (subscriber) await api('/subscribers/' + subscriber.id, 'DELETE');
  } finally {
    try {
      if (list) await api('/lists/' + list.id, 'DELETE');
    } finally {
      await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await request('/admin/logout');
    }
  }
}
console.log('Listmonk login, list/subscriber API and upload volume checks passed.');
JS
