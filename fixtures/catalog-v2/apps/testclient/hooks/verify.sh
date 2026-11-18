#!/bin/sh
set -eu
bun - <<'JS'
const r=await fetch('http://localhost:3000/sync',{method:'POST'});if(!r.ok)throw new Error('sync failed');const data=await r.json();if(!data.written?.body||data.written.body!==data.read?.body)throw new Error('sync mismatch');
JS
