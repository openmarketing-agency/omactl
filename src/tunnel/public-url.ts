import { Context } from '../core/context';
import { compose } from '../docker';
import { hook } from '../apps/hooks';
import { OmaError } from '../core/errors';
import type { Operation } from '../core/operation';

// Compatibility for installed catalogs that predate the on_public_url hook.
const wordpress = `set -eu
cd /var/www/html
wp option update home "$PUBLIC_URL"
wp option update siteurl "$PUBLIC_URL"
`;
const listmonk = `set -eu
bun - <<'JS'
const base = 'http://listmonk:9000';
const cookies = new Map();
async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Cookie', [...cookies].map(([k,v]) => k + '=' + v).join('; '));
  if (cookies.has('_csrf')) headers.set('X-CSRF-Token', cookies.get('_csrf'));
  const response = await fetch(base + path, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0], at = pair.indexOf('=');
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return response;
}
await request('/admin/login');
const login = await request('/admin/login', { method: 'POST', body: new URLSearchParams({ username: process.env.LISTMONK_ADMIN_USER, password: process.env.LISTMONK_ADMIN_PASSWORD, next: '/admin' }) });
if (login.status !== 302) throw new Error('Listmonk administrator login failed');
try {
  const response = await request('/api/settings');
  if (!response.ok) throw new Error('Cannot read Listmonk settings');
  const settings = (await response.json()).data;
  settings['app.root_url'] = process.env.PUBLIC_URL;
  const updated = await request('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  if (!updated.ok) throw new Error('Cannot update Listmonk root URL');
} finally { await request('/admin/logout'); }
JS
`;
export async function updatePublicUrl(ctx: Context, id: string, op: Operation) {
  const app = await ctx.app(id);
  if (app.manifest.hooks.on_public_url) return hook(ctx, id, 'on_public_url', op);
  const script = id === 'wordpress' ? wordpress : id === 'listmonk' ? listmonk : undefined;
  if (!script) return;
  const service = app.manifest.hooks.setup.service;
  const result = await compose(ctx, id, ['run', '--rm', '-T', service, 'sh', '-s'], {
    input: script,
    timeout: app.manifest.hooks.setup.timeout * 1000,
    allowFailure: true,
  });
  await op.log('public_url', {
    app: id,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  if (result.exitCode !== 0)
    throw new OmaError(
      'HOOK_FAILED',
      `${id} public URL update failed: ${ctx.secrets.redact(result.stderr || result.stdout)}`,
    );
}
