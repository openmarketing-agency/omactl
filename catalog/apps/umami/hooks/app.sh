#!/bin/sh
set -eu
node --input-type=module - <<'JS'
const base = 'http://127.0.0.1:3000/api';
const password = process.env.UMAMI_ADMIN_PASSWORD;
if (!password || password.length < 8) throw new Error('UMAMI_ADMIN_PASSWORD must contain at least 8 characters');
let token;
async function request(path, method = 'GET', body, authenticated = true) {
  return fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ...(authenticated && token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
}
async function api(path, method = 'GET', body, authenticated = true) {
  const response = await request(path, method, body, authenticated);
  if (!response.ok) throw new Error(`Umami ${method} ${path} failed (${response.status})`);
  return response.json();
}
let login = await request('/auth/login', 'POST', { username: 'admin', password }, false);
if (process.env.OMA_HOOK === 'setup' && login.status === 401) {
  const initial = await api('/auth/login', 'POST', { username: 'admin', password: 'umami' }, false);
  if (!initial.token || !initial.user?.passwordChangeRequired) throw new Error('Umami administrator does not have the initial default password');
  token = initial.token;
  await api('/me/password', 'POST', { currentPassword: 'umami', newPassword: password });
  login = await request('/auth/login', 'POST', { username: 'admin', password }, false);
}
if (!login.ok) throw new Error(`Umami administrator login failed (${login.status})`);
const session = await login.json();
if (!session.token || !session.user?.isAdmin || session.user.passwordChangeRequired) throw new Error('Umami administrator login is incomplete');
token = session.token;
if (process.env.OMA_HOOK === 'setup') {
  console.log('Umami administrator initialized.');
  process.exit(0);
}
const marker = 'omactl-verify-' + crypto.randomUUID();
let website;
try {
  const tracker = await fetch('http://127.0.0.1:3000/script.js', { signal: AbortSignal.timeout(20000) });
  if (!tracker.ok || !(await tracker.text()).includes('website-id')) throw new Error('Umami tracking script unavailable');
  website = await api('/websites', 'POST', { name: marker, domain: 'example.invalid' });
  if (!website.id || (await api('/websites/' + website.id)).name !== marker) throw new Error('Website readback mismatch');
  const startAt = Date.now() - 60000;
  const event = await api('/send', 'POST', { type: 'event', payload: { website: website.id, hostname: 'example.invalid', url: '/omactl-verify', language: 'en-US', screen: '1280x720' } }, false);
  if (!event.sessionId) throw new Error('Umami pageview was not recorded');
  const stats = await api(`/websites/${website.id}/stats?startAt=${startAt}&endAt=${Date.now() + 60000}`);
  if (stats.pageviews !== 1 || stats.visitors !== 1) throw new Error('Analytics pageview readback mismatch');
} finally {
  if (website?.id) await api('/websites/' + website.id, 'DELETE');
}
console.log('Umami login, tracking script, website and pageview analytics checks passed.');
JS
