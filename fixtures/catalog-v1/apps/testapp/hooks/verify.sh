#!/bin/sh
set -eu
bun - <<'JS'
const base='http://localhost:3000',headers={Authorization:'Bearer '+process.env.TESTAPP_API_KEY,'Content-Type':'application/json'},body='verify-'+crypto.randomUUID();
const create=await fetch(base+'/api/notes',{method:'POST',headers,body:JSON.stringify({body,tag:'oma-verify'})});if(!create.ok)throw new Error('create failed');const note=await create.json();
const read=await fetch(base+'/api/notes/'+note.id,{headers});if(!read.ok||(await read.json()).body!==body)throw new Error('note mismatch');
if(!(await fetch(base+'/api/notes/'+note.id,{method:'DELETE',headers})).ok)throw new Error('delete failed');
const file='verify-'+crypto.randomUUID();if(!(await fetch(base+'/api/files/'+file,{method:'PUT',headers,body})).ok)throw new Error('write failed');const result=await fetch(base+'/api/files/'+file,{headers});if(!result.ok||await result.text()!==body)throw new Error('file mismatch');await fetch(base+'/api/files/'+file,{method:'DELETE',headers});
JS
