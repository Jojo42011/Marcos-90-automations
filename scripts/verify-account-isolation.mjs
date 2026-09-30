// Real HTTP requests to three separate account processes. No model/provider calls.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'account-isolation-'));
process.env.TENANT_DATA_ROOT = root;
process.env.HARVEY_WORK_DIR = join(root, 'harvey-work');
const auth = require('../dist/src/core/authStore.js');
auth.setSecurityState('lockdown_marker', '2026-09-25-dashboard-testing');
const users = ['Marco', 'Wesley', 'Carlos'].map(name => ({ id: name.toLowerCase(), name,
  email: name.toLowerCase()+'@example.com', role: name === 'Marco' ? 'admin' : 'agent', active: true,
  passwordHash: auth.hashPassword('fixture-only-password'), createdAt: new Date().toISOString() }));
writeFileSync(join(root, 'users.json'), JSON.stringify(users));
const legacy = JSON.stringify({ idCounter: 2, leadsById: { old: {id:'old',name:'Legacy private contact'} }, leadKeyToId:{}, conversationsByLeadId:{}, commandTasks:[] });
writeFileSync(join(root, 'local-dashboard-db.json'), legacy);
const work = require('../dist/src/harvey/work/store.js');
const { tenantEnvironment } = require('../dist/src/core/tenantGateway.js');
const isolatedEnv = tenantEnvironment('marco', { ...process.env, BRIVITY_API_KEY:'must-not-copy', GMAIL_REFRESH_TOKEN:'must-not-copy', DB_JSON_PATH:join(root,'private-legacy.json'), HARVEY_PUBLIC_URL:'https://example.invalid' });
assert.equal(isolatedEnv.BRIVITY_API_KEY,undefined);assert.equal(isolatedEnv.GMAIL_REFRESH_TOKEN,undefined);assert.equal(isolatedEnv.DB_JSON_PATH,undefined);
assert.equal(isolatedEnv.HARVEY_PUBLIC_URL,'https://example.invalid');
work.lockChat('unrelated-owner','unrelated-chat');
const preserved = work.createChat('marco', {title:'Existing private chat'});
work.append('marco',preserved.id,{role:'user',content:'Preserved private message',at:new Date().toISOString()});
const probe = net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port = probe.address().port;await new Promise(resolve=>probe.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|Path|SystemRoot|WINDIR|COMSPEC|PATHEXT|HOME|USERPROFILE|LOCALAPPDATA|TEMP|TMP)$/.test(k)));
let server, logs='';
function start(){
 server=spawn(process.execPath,['dist/src/server.js'],{env:{...env,TENANT_DATA_ROOT:root,PORT:String(port),ACCOUNT_ISOLATION:'true',SITE_LOGIN_ENABLED:'1',HARVEY_WORKER_ENABLED:'false',DOTENV_CONFIG_PATH:join(root,'.missing-env')},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
}
async function stop(){if(server && server.exitCode===null){const done=once(server,'exit');server.send('shutdown');await done;}}
async function request(path, cookie='', method='GET', body){
 const res=await fetch('http://127.0.0.1:'+port+path,{method,headers:{cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual'});
 const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:res.status,data,cookie:res.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};
}
async function ready(){for(let i=0;i<200;i++){try{if((await request('/health')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Server failed to start: '+logs.slice(-4000));}
const cookies={}, chats={}, schedules={};let checks=0;
function check(name,fn){fn();console.log('ok',name);checks++;}
try {
 start();await ready();
 for(const user of users){const r=await request('/api/auth/login','','POST',{email:user.email,password:'fixture-only-password'});assert.equal(r.status,200,JSON.stringify(r.data));cookies[user.id]=r.cookie;}
 check('existing account passwords survive provisioning',()=>assert.equal(Object.keys(cookies).length,3));
 check('business credentials and legacy database overrides are not inherited',()=>assert.ok(isolatedEnv.TENANT_DATA_ROOT.includes('accounts')));
 for(const user of users){
   const c=cookies[user.id];const dashboard=await request('/api/dashboard/data?includePhoneless=1',c);
   assert.equal(dashboard.status,200,JSON.stringify(dashboard.data));assert.deepEqual(dashboard.data.leads,[]);
   const created=await request('/api/crm/lead',c,'POST',{firstName:user.name+' private',phone:'2025550142'});assert.equal(created.status,201,JSON.stringify(created.data));
   const chat=await request('/api/harvey/conversations',c,'POST',{title:user.name+' private chat',mode:'work'});assert.equal(chat.status,201,JSON.stringify(chat.data));chats[user.id]=chat.data.id;
   const schedule=await request('/api/harvey/work/schedules',c,'POST',{chatId:chat.data.id,title:user.name+' agent',prompt:'Return a short greeting',cron:'0 9 * * *',timezone:'America/Chicago',maxCostUsd:0.01});assert.equal(schedule.status,201,JSON.stringify(schedule.data));schedules[user.id]=schedule.data.id;
 }
 check('all three CRMs start empty and accept the same phone independently',()=>assert.equal(Object.keys(chats).length,3));
 check('starting account workers does not clear another owner’s chat lock',()=>assert.ok(work.workDb().prepare('SELECT 1 FROM locks WHERE owner=?').get('unrelated-owner')));
 const roster=await request('/api/users',cookies.carlos);assert.deepEqual(roster.data.users.map(u=>u.id),['carlos']);
 const adminRoster=await request('/api/auth/team',cookies.marco);assert.equal(adminRoster.data.users.length,3);assert.ok(adminRoster.data.users.every(u=>!u.passwordHash));
 assert.equal((await request('/api/auth/team',cookies.carlos)).status,403);
 check('CRM roster is personal; account administration remains admin-only',()=>assert.ok(true));
 for(const user of users){
   const c=cookies[user.id], dashboard=await request('/api/dashboard/data?includePhoneless=1',c);
   assert.equal(dashboard.data.leads.length,1);assert.equal(dashboard.data.leads[0].name,user.name+' private');
   const tasks=await request('/api/harvey/work/schedules',c);assert.equal(tasks.data.schedules.length,1);assert.equal(tasks.data.schedules[0].id,schedules[user.id]);
   const other=users.find(u=>u.id!==user.id);
   assert.equal((await request('/api/harvey/conversations/'+chats[other.id],c)).status,404);
   assert.equal((await request('/api/harvey/work/schedules/'+schedules[other.id],c,'PATCH',{enabled:false})).status,404);
 }
 check('CRM reads, agent lists and guessed chat/schedule IDs remain account-scoped',()=>assert.ok(true));
 const forged=await request('/api/dashboard/data?owner=marco',cookies.carlos+'; mp_account=marco');assert.equal(forged.data.leads[0].name,'Carlos private');
 check('browser display identity and query parameters cannot switch account ownership',()=>assert.ok(true));
 const restored=await request('/api/harvey/conversations/'+preserved.id,cookies.marco);
 check('existing owner-scoped chats and messages are retained',()=>assert.equal(restored.data.messages[0].content,'Preserved private message'));
 check('another account cannot read that retained chat',()=>assert.ok(true));
 assert.equal((await request('/api/harvey/conversations/'+preserved.id,cookies.carlos)).status,404);
 const anonymous=await request('/api/dashboard/data');assert.equal(anonymous.status,401);
 const webhook=await request('/webhook','','POST',{});assert.equal(webhook.status,401);
 check('anonymous requests and unscoped legacy webhooks cannot access shared business state',()=>assert.ok(true));
 assert.equal((await request('/api/auth/team',cookies.carlos,'POST',{name:'Other',email:'other@example.com'})).status,403);
 assert.equal((await request('/api/users',cookies.carlos,'POST',{name:'Other',email:'other@example.com'})).status,403);
 check('non-admin accounts cannot create accounts or mutate the shared user registry',()=>assert.ok(true));
 await stop();start();await ready();
 for(const user of users){const dashboard=await request('/api/dashboard/data?includePhoneless=1',cookies[user.id]);assert.equal(dashboard.data.leads[0].name,user.name+' private');}
 check('each CRM persists separately across a complete server restart',()=>assert.ok(true));
 check('legacy shared CRM file is preserved byte-for-byte',()=>assert.equal(readFileSync(join(root,'local-dashboard-db.json'),'utf8'),legacy));
 console.log(checks+' account isolation checks passed; no external services were contacted.');
} catch(error){console.error(logs.slice(-5000));throw error;} finally {await stop();work.closeStore();}
