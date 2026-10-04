// Exact correction authorized by the supplied screenshot. No bulk rewriting,
// deletion, account reset or guesses about other historical task authors.
const Database=require('better-sqlite3'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
(async()=>{
 const root=process.env.TENANT_DATA_ROOT||'/data';const db=new Database(process.env.SHARED_TASK_DB_PATH||path.join(root,'shared-tasks.db'));
 try{
  assert.equal(db.pragma('quick_check',{simple:true}),'ok');
  const id='ba7a24b2-4a2f-4a04-b042-6168866bd084';
  const row=db.prepare('SELECT body,deleted FROM tasks WHERE id=?').get(id);
  if(!row||row.deleted){console.log(JSON.stringify({attributionRepair:'skipped',reason:'Reported task absent or deleted; no resurrection'}));return;}
  const old=JSON.parse(row.body);
  if(old.createdBy==='wesley'){console.log(JSON.stringify({attributionRepair:'already-correct'}));return;}
  assert.equal(old.createdBy,'marco');assert.equal(old.assignedTo,'carlos');
  assert.equal(old.createdAt,'2026-10-04T18:39:21.238Z');assert.match(old.title,/^Create property search for Adrian Taylor/i);
  const dir=path.join(root,'task-attribution-backups');fs.mkdirSync(dir,{recursive:true});
  const backup=path.join(dir,'before-correction-'+Date.now()+'.db');await db.backup(backup);
  const saved=new Database(backup,{readonly:true});assert.equal(saved.pragma('quick_check',{simple:true}),'ok');assert.equal(saved.prepare('SELECT body FROM tasks WHERE id=?').get(id).body,row.body);saved.close();
  db.transaction(()=>{
   const current=db.prepare('SELECT body,deleted FROM tasks WHERE id=?').get(id);assert.deepEqual(current,row,'Task changed during backup; retry safely');
   const count=db.prepare('SELECT count(*) AS n FROM tasks').get().n;
   const next={...old,createdBy:'wesley',updatedAt:new Date().toISOString()};
   const change=db.prepare('UPDATE tasks SET body=? WHERE id=? AND body=? AND deleted=0').run(JSON.stringify(next),id,row.body);assert.equal(change.changes,1);
   db.prepare('INSERT INTO history(task_id,body,action,at) VALUES(?,?,?,?)').run(id,JSON.stringify(next),'creator_correction',next.updatedAt);
   assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n,count);
   console.log(JSON.stringify({attributionRepair:'passed',corrected:1,creator:'wesley',assignee:'carlos',taskCount:count,backupVerified:true}));
  })();
 }finally{db.close();}
})().catch(()=>{console.error('Attribution repair stopped safely: precondition or backup validation failed');process.exitCode=1;});
