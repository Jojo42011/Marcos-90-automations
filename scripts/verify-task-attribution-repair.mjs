import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=mkdtempSync(join(tmpdir(),'attribution-repair-')),file=join(root,'shared-tasks.db');
const db=new Database(file);db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT,deleted INTEGER);CREATE TABLE history(seq INTEGER PRIMARY KEY,task_id TEXT,body TEXT,action TEXT,at TEXT);');
const old={id:'ba7a24b2-4a2f-4a04-b042-6168866bd084',title:'Create property search for Adrian Taylor - ask me for more info.',createdBy:'marco',assignedTo:'carlos',createdAt:'2026-10-04T18:39:21.238Z',checklist:[{text:'Keep this',done:true}],description:'Retain notes',status:'pending'};
db.prepare('INSERT INTO tasks VALUES(?,?,0)').run(old.id,JSON.stringify(old));db.prepare('INSERT INTO tasks VALUES(?,?,1)').run('deleted','{"keep":"unchanged"}');db.prepare('INSERT INTO history(task_id,body,action,at) VALUES(?,?,?,?)').run(old.id,JSON.stringify(old),'create',old.createdAt);db.close();
for(let i=0;i<2;i++){const r=spawnSync(process.execPath,['scripts/repair-task-attribution.cjs'],{env:{...process.env,TENANT_DATA_ROOT:root,SHARED_TASK_DB_PATH:file},encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);}
const check=new Database(file);const next=JSON.parse(check.prepare('SELECT body FROM tasks WHERE id=?').get(old.id).body);assert.equal(next.createdBy,'wesley');delete next.updatedAt;assert.deepEqual(next,{...old,createdBy:'wesley'});assert.equal(check.prepare('SELECT count(*) n FROM tasks').get().n,2);assert.equal(check.prepare('SELECT body FROM tasks WHERE id=?').get('deleted').body,'{"keep":"unchanged"}');assert.equal(check.prepare('SELECT count(*) n FROM history').get().n,2);assert.equal(check.prepare("SELECT body FROM history WHERE action='create'").get().body,JSON.stringify(old));check.close();assert.equal(readdirSync(join(root,'task-attribution-backups')).length,1);
console.log('Exact attribution correction passed: all other fields/records preserved, verified backup, original history retained, repeat run idempotent.');
