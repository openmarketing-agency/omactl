#!/bin/sh
set -eu
bun - <<'JS'
const response=await fetch('http://localhost:3000/admin/bootstrap',{method:'POST',headers:{'X-Bootstrap-Token':process.env.TESTAPP_BOOTSTRAP_TOKEN}});
if(!response.ok)throw new Error('bootstrap failed');
const data=await response.json();if(!data.api_key)throw new Error('API key missing');
console.log('OMA_OUTPUT TESTAPP_API_KEY='+data.api_key);
JS
