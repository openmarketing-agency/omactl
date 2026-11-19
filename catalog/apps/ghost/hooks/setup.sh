#!/bin/sh
set -eu
node --input-type=module - <<'JS'
const url = new URL(process.env.url);
const response = await fetch('http://127.0.0.1:2368/ghost/api/admin/authentication/setup/', {
  headers: { Host: url.host, 'X-Forwarded-Proto': url.protocol.slice(0, -1) },
  redirect: 'manual', signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`Ghost setup endpoint failed (${response.status})`);
const result = await response.json();
if (typeof result.setup?.[0]?.status !== 'boolean') throw new Error('Unexpected Ghost setup response');
console.log(result.setup[0].status ? 'Ghost owner is already configured.' : 'Ghost is ready. Create the site owner at /ghost/ in your browser.');
JS
