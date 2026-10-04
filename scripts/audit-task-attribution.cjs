// Read-only: report only attribution for the two user-reported examples and
// non-secret worker identity fields. Never output task bodies or credentials.
const fs=require('fs');const Database=require('/app/node_modules/better-sqlite3');
const users=JSON.parse(fs.readFileSync('/data/users.json','utf8'));
const label=id=>users.find(u=>u.id===id)?.name.split(/\s+/)[0]||'unknown';
const db=new Database('/data/shared-tasks.db',{readonly:true});
console.log(JSON.stringify({integrity:db.pragma('quick_check',{simple:true}),tasks:db.prepare('SELECT count(*) AS n FROM tasks').get().n}));
const matches=db.prepare('SELECT body FROM tasks WHERE deleted=0').all().map(r=>JSON.parse(r.body)).filter(t=>/^test task$/i.test(t.title)||/Create property search for Adrian Taylor/i.test(t.title));
for(const t of matches)console.log(JSON.stringify({example:/^test task$/i.test(t.title)?'reported-test':'reported-property',id:t.id,createdBy:t.createdBy,assignedTo:t.assignedTo,createdAt:t.createdAt,history:db.prepare('SELECT action,body FROM history WHERE task_id=? ORDER BY seq').all(t.id).map(r=>({action:r.action,createdBy:JSON.parse(r.body).createdBy}))}));
for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{const fields=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0');const owner=fields.find(x=>x.startsWith('TENANT_OWNER_ID='));if(owner)console.log(JSON.stringify({workerOwner:label(owner.slice(16)),member:fields.find(x=>x.startsWith('TENANT_MEMBER='))?.slice(14)}));}catch{}}
db.close();
