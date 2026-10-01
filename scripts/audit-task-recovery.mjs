// Read-only post-deploy proof: verify every retained source ID has an import receipt.
// Log counts only, never task titles, messages, credentials or user emails.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
const root=process.env.TENANT_DATA_ROOT || '/data';
const db=new Database(process.env.SHARED_TASK_DB_PATH || join(root,'shared-tasks.db'),{readonly:true});
assert.equal(db.pragma('quick_check',{simple:true}),'ok');
const paths=new Set([process.env.DB_JSON_PATH,join(root,'db.json'),join(root,'local-dashboard-db.json'),join(root,'tasks.json'),join(root,'marco-tasks.json')].filter(Boolean));
const accounts=join(root,'accounts');
if(existsSync(accounts))for(const dir of readdirSync(accounts,{withFileTypes:true}))if(dir.isDirectory())for(const file of ['db.json','local-dashboard-db.json'])paths.add(join(accounts,dir.name,file));
let sourceRecords=0;
for(const path of paths){if(!existsSync(path))continue;const raw=JSON.parse(readFileSync(path,'utf8'));const tasks=Array.isArray(raw)?raw:raw.commandTasks||[];for(const task of tasks){sourceRecords++;assert(db.prepare('SELECT 1 FROM imports WHERE source=? AND original_id=?').get(path,task.id),'Retained task is missing a recovery receipt');}}
const active=db.prepare('SELECT count(*) AS count FROM tasks WHERE deleted=0').get().count;
const deleted=db.prepare('SELECT count(*) AS count FROM tasks WHERE deleted=1').get().count;
const restored=db.prepare("SELECT count(*) AS count FROM history WHERE action='restore'").get().count;
const byAssignee=db.prepare("SELECT json_extract(body,'$.assignedTo') AS assignee,count(*) AS count FROM tasks WHERE deleted=0 GROUP BY assignee").all();
console.log(JSON.stringify({recoveryAudit:'passed',sourceRecords,restored,active,softDeleted:deleted,byAssignee}));
db.close();
const workPath=join(process.env.HARVEY_WORK_DIR || join(root,'harvey-work'),'work.db');
if(existsSync(workPath)){const work=new Database(workPath,{readonly:true});assert.equal(work.pragma('quick_check',{simple:true}),'ok');console.log(JSON.stringify({workIntegrity:'ok',chats:work.prepare("SELECT count(*) AS count FROM records WHERE kind='chat'").get().count,agents:work.prepare("SELECT count(*) AS count FROM records WHERE kind='schedule'").get().count,messages:work.prepare('SELECT count(*) AS count FROM messages').get().count}));work.close();}
