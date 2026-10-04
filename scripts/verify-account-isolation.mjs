// Real HTTP requests to three separate account processes. No model/provider calls.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
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
const legacy = JSON.stringify({ idCounter: 2, leadsById: { old: {id:'old',name:'Legacy private contact'} }, leadKeyToId:{}, conversationsByLeadId:{}, commandTasks:users.map(u=>({id:"retained-"+u.id,title:u.name+" retained task",assignedTo:u.id,createdBy:u.id,column:"today",status:u.id==="wesley"?"done":"pending",checklist:[{id:"step",text:"Preserve this",done:true}],createdAt:"2026-09-01T00:00:00Z",updatedAt:"2026-09-01T00:00:00Z"})) });
writeFileSync(join(root, 'local-dashboard-db.json'), legacy);
writeFileSync(join(root,'marco-tasks.json'),JSON.stringify([{id:'legacy-personal',title:'Retained personal task',priority:'high',status:'pending',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z'}]));

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
// Exercise the real DM pipeline while intercepting every outbound provider call.
const transport=join(root,'fixture-transport.cjs'), sends=join(root,'fixture-sends.jsonl');
writeFileSync(transport, `const fs=require('node:fs');const original=global.fetch;
global.fetch=async(input,init={})=>{const url=new URL(typeof input==='string'?input:input.url||String(input));
if(['localhost','127.0.0.1'].includes(url.hostname))return original(input,init);
if(url.hostname==='zernio.com'&&url.pathname==='/api/v1/inbox/conversations/fixture-marco/messages'){
 if(init.method==='POST'){fs.appendFileSync(${JSON.stringify(sends)},JSON.stringify({body:JSON.parse(init.body),headers:init.headers})+'\\n');return Response.json({message:{id:'fixture-sent'}});}
 return Response.json({messages:[{direction:'outgoing',text:'Hey, thanks for your comment! Are you buying your first home?'}]});
}throw new Error('Unexpected external request blocked by fixture: '+url.hostname);};`);
let server, logs='';
function start(){
 server=spawn(process.execPath,['--require',transport,'dist/src/server.js'],{env:{...env,TENANT_DATA_ROOT:root,PORT:String(port),ACCOUNT_ISOLATION:'true',SITE_LOGIN_ENABLED:'1',ZERNIO_DM_API_KEY:'fixture-only',ZERNIO_WEBHOOK_SECRET:'fixture-hook-secret',COMMENT_AGENT_ENABLED:'false',HARVEY_WORKER_ENABLED:'false',DOTENV_CONFIG_PATH:join(root,'.missing-env')},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 server.on('exit',(code,signal)=>{logs+='\nServer exit '+code+' '+signal;});
 server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
}
async function stop(){if(server && server.exitCode===null){const done=once(server,'exit');server.send('shutdown');await done;}}
async function request(path, cookie='', method='GET', body, extraHeaders={}){
 const res=await fetch('http://127.0.0.1:'+port+path,{method,headers:{cookie,...extraHeaders,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual'});
 const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:res.status,data,cookie:res.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};
}
async function ready(){for(let i=0;i<900;i++){try{if((await request('/health')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Server failed to start: '+logs.slice(-4000));}
const cookies={}, chats={}, schedules={};let checks=0;
function check(name,fn){fn();console.log('ok',name);checks++;}
try {
 start();await ready();
 for(const user of users){const r=await request('/api/auth/login','','POST',{email:user.email,password:'fixture-only-password'});assert.equal(r.status,200,JSON.stringify(r.data));cookies[user.id]=r.cookie;}
 for(const user of users){const tasks=(await request('/api/tasks',cookies[user.id])).data.tasks;assert(tasks.some(t=>t.id==='retained-'+user.id));assert.equal(tasks.length,user.id==='carlos'?3:1);}
 assert((await request('/api/marco-tasks',cookies.marco)).data.tasks.some(t=>t.id==='legacy-personal'));
 assert(!(await request('/api/marco-tasks',cookies.wesley)).data.tasks.some(t=>t.id==='legacy-personal'));
 const wesleyTask=(await request('/api/tasks',cookies.wesley)).data.tasks[0];assert.equal(wesleyTask.status,'done');assert.equal(wesleyTask.checklist[0].done,true);
 const assigned=await request('/api/tasks',cookies.marco,'POST',{title:'Marco assigns Wesley',column:'today',assignedTo:'wesley',createdBy:'marco'});assert.equal(assigned.status,200);assert.equal(assigned.data.task.createdBy,'marco');
 assert((await request('/api/tasks',cookies.wesley)).data.tasks.some(t=>t.id===assigned.data.task.id));
 assert.equal((await request('/api/tasks/retained-wesley',cookies.marco,'PATCH',{title:'Unauthorized edit'})).status,404);
 const parallel=await Promise.all(users.map(u=>request('/api/tasks',cookies[u.id],'POST',{title:u.name+' simultaneous',column:'today',assignedTo:u.id,createdBy:u.id,expectedActorId:u.id})));assert(parallel.every(r=>r.status===200));
 check('each signed-in account is recorded as creator',()=>{for(let i=0;i<users.length;i++)assert.equal(parallel[i].data.task.createdBy,users[i].id);});
 assert.equal((await request('/api/tasks',cookies.carlos)).data.tasks.length,7);
 const beforeMismatch=JSON.stringify((await request('/api/tasks',cookies.carlos)).data.tasks);
 assert.equal((await request('/api/tasks',cookies.marco,'POST',{title:'Stale Wesley page',column:'today',assignedTo:'carlos',createdBy:'wesley'})).status,409);
 assert.equal((await request('/api/tasks',cookies.carlos,'POST',{title:'Changed session',column:'today',assignedTo:'carlos',createdBy:'carlos',expectedActorId:'wesley'})).status,409);
 assert.equal(JSON.stringify((await request('/api/tasks',cookies.carlos)).data.tasks),beforeMismatch);
 check('stale account pages cannot silently create misattributed tasks or modify existing data',()=>assert.ok(true));
 check('retained tasks restored with status/checklists, cross-account assignment, spoof resistance and concurrent writes',()=>assert.ok(true));
 check('existing account passwords survive provisioning',()=>assert.equal(Object.keys(cookies).length,3));
 check('business credentials and legacy database overrides are not inherited',()=>assert.ok(isolatedEnv.TENANT_DATA_ROOT.includes('accounts')));
 for(const user of users){
   const c=cookies[user.id];const dashboard=await request('/api/dashboard/data?includePhoneless=1',c);
   assert.equal(dashboard.status,200,JSON.stringify(dashboard.data));assert.deepEqual(dashboard.data.leads.map(l=>l.id),user.id==='marco'?['old']:[]);
   const created=await request('/api/crm/lead',c,'POST',{firstName:user.name+' private',phone:'2025550142'});assert.equal(created.status,201,JSON.stringify(created.data));
   const chat=await request('/api/harvey/conversations',c,'POST',{title:user.name+' private chat',mode:'work'});assert.equal(chat.status,201,JSON.stringify(chat.data));chats[user.id]=chat.data.id;
   const schedule=await request('/api/harvey/work/schedules',c,'POST',{chatId:chat.data.id,title:user.name+' agent',prompt:'Return a short greeting',cron:'0 9 * * *',timezone:'America/Chicago',maxCostUsd:0.01});assert.equal(schedule.status,201,JSON.stringify(schedule.data));schedules[user.id]=schedule.data.id;
 }
 check('Marco inherits retained CRM; other CRMs start empty and accept the same phone independently',()=>assert.equal(Object.keys(chats).length,3));
 check('starting account workers does not clear another owner’s chat lock',()=>assert.ok(work.workDb().prepare('SELECT 1 FROM locks WHERE owner=?').get('unrelated-owner')));
 const roster=await request('/api/users',cookies.carlos);assert.deepEqual(roster.data.users.map(u=>u.id),['carlos']);
 const adminRoster=await request('/api/auth/team',cookies.marco);assert.equal(adminRoster.data.users.length,3);assert.ok(adminRoster.data.users.every(u=>!u.passwordHash));
 assert.equal((await request('/api/auth/team',cookies.carlos)).status,403);
 check('CRM roster is personal; account administration remains admin-only',()=>assert.ok(true));
 for(const user of users){
   const c=cookies[user.id], dashboard=await request('/api/dashboard/data?includePhoneless=1',c);
   assert.equal(dashboard.data.leads.length,user.id==='marco'?2:1);assert.equal(dashboard.data.leads[0].name,user.name+' private');
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
 const webhook=await request('/webhook','','POST',{});assert.equal(webhook.status,400);
 const hook={id:'signed-comment-fixture',event:'comment.received',account:{accountId:'wesley-social'},comment:{id:'shared-comment',platformPostId:'fixture-post',platform:'tiktok',text:'Location?',author:{id:'fixture-author'},createdAt:new Date().toISOString()}};
 const signature=createHmac('sha256','fixture-hook-secret').update(JSON.stringify(hook)).digest('hex');
 assert.equal((await request('/api/zernio/webhook','','POST',hook)).status,401);
 const accepted=await request('/api/zernio/webhook','','POST',hook,{'x-zernio-signature':signature});assert.equal(accepted.status,200);
 for(let i=0;i<50;i++){const status=await request('/api/comment-agent/status',cookies.marco);if(status.data.recent?.some(r=>r.commentId==='shared-comment'||r.comment_id==='shared-comment'))break;await new Promise(r=>setTimeout(r,50));}
 const sharedStatus=await request('/api/comment-agent/status',cookies.marco);assert.equal(sharedStatus.data.enabled,false);assert.equal(sharedStatus.data.recent.length,1);
 for(const u of users){const status=await request('/api/comment-agent/status',cookies[u.id]);assert.deepEqual(status.data.recent,sharedStatus.data.recent);assert.equal((await request('/api/dm/stats',cookies[u.id])).status,200);}
 assert.equal((await request('/api/comment-agent/status')).status,401);
 assert.equal((await request('/api/zernio/webhook','','POST',hook,{'x-zernio-signature':signature})).data.duplicate,true);
 check('signed comments reach one shared durable service without login; all team consoles agree; invalid signatures and anonymous console reads remain blocked',()=>assert.ok(true));
 check('anonymous dashboard requests remain blocked; ManyChat reaches its payload validation',()=>assert.ok(true));
 assert.equal((await request('/api/auth/team',cookies.carlos,'POST',{name:'Other',email:'other@example.com'})).status,403);
 assert.equal((await request('/api/users',cookies.carlos,'POST',{name:'Other',email:'other@example.com'})).status,403);
 check('non-admin accounts cannot create accounts or mutate the shared user registry',()=>assert.ok(true));
 const workspaceList=await request('/api/account/workspaces',cookies.carlos);assert.equal(workspaceList.data.workspaces.length,3);
 assert.equal((await request('/api/account/workspace?id=marco',cookies.wesley,'POST')).status,403);
 const selection=await request('/api/account/workspace?id=marco',cookies.carlos,'POST');assert.equal(selection.status,200);
 const delegated=cookies.carlos+'; '+selection.cookie;
 assert.equal((await request('/api/dashboard/data?includePhoneless=1',delegated)).data.leads[0].name,'Marco private');
 assert.equal((await request('/api/harvey/conversations/'+preserved.id,delegated)).data.messages[0].content,'Preserved private message');
 assert.equal((await request('/api/harvey/work/schedules',delegated)).data.schedules[0].id,schedules.marco);
 assert.equal((await request('/api/harvey/work/status',delegated)).status,200);
 assert.equal((await request('/api/harvey/conversations',delegated,'POST',{title:'Forbidden'})).status,403);
 assert.equal((await request('/api/harvey/work/schedules/'+schedules.marco+'/run',delegated,'POST',{})).status,403);
 check('Carlos can view Marco CRM, chats and agents; other users and delegated writes are blocked',()=>assert.ok(true));
 assert.equal((await request('/api/tasks/retained-carlos',cookies.carlos,'DELETE')).status,200);
 await stop();start();await ready();
 const after=(await request('/api/tasks',cookies.carlos)).data.tasks;assert.equal(after.length,6);assert(after.some(t=>t.id===assigned.data.task.id));assert(!after.some(t=>t.id==='retained-carlos'));
 for(const user of users){assert((await request('/api/harvey/conversations/'+chats[user.id],cookies[user.id])).data.id);assert.equal((await request('/api/harvey/work/schedules',cookies[user.id])).data.schedules[0].id,schedules[user.id]);}
 check('tasks, chats and agents survive process restart; restoration is idempotent and respects explicit deletion',()=>assert.ok(true));
 for(const user of users){const dashboard=await request('/api/dashboard/data?includePhoneless=1',cookies[user.id]);assert.equal(dashboard.data.leads[0].name,user.name+' private');}
 check('each CRM persists separately across a complete server restart',()=>assert.ok(true));
 check('legacy shared CRM file is preserved byte-for-byte',()=>assert.equal(readFileSync(join(root,'local-dashboard-db.json'),'utf8'),legacy));
 const dmHook={id:'fixture-marco-event',event:'message.received',account:{accountId:'marco-social',platform:'tiktok'},message:{id:'fixture-inbound',conversationId:'fixture-marco',platform:'tiktok',direction:'incoming',text:'Yes, this is my first home',sender:{id:'fixture-marco-lead',username:'fixture_lead'}},conversation:{id:'fixture-marco',participantId:'fixture-marco-lead'}};
 const dmHeaders={'x-zernio-signature':createHmac('sha256','fixture-hook-secret').update(JSON.stringify(dmHook)).digest('hex')};
 const ackStart=Date.now();assert.equal((await request('/api/zernio/webhook','','POST',dmHook,dmHeaders)).status,200);assert(Date.now()-ackStart<5000);
 let sent=[];for(let i=0;i<200;i++){try{sent=readFileSync(sends,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);if(sent.length)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal(sent.length,1,'DM pipeline must actually send a reply');assert.equal(sent[0].body.accountId,'marco-social');assert(sent[0].body.message.trim());assert.equal(sent[0].headers['Idempotency-Key'],'zernio:fixture-marco-event');
 assert.equal((await request('/api/zernio/webhook','','POST',dmHook,dmHeaders)).data.duplicate,true);
 const dmThreads=(await request('/api/dm/conversations',cookies.marco)).data.conversations;
 const dmThread=dmThreads.find(c=>c.userId==='fixture-marco-lead');assert(dmThread);assert(dmThread.agentMessages>=1);assert.equal(dmThread.userMessages,1);
 await stop();start();await ready();
 assert((await request('/api/dm/conversations',cookies.marco)).data.conversations.some(c=>c.id===dmThread.id&&c.agentMessages>=1));
 assert.equal(readFileSync(sends,'utf8').trim().split('\n').length,1);
 check('Marco DM completes signed intake, fast ACK, real pipeline, correct-account send, duplicate protection and persistent history without dashboard login',()=>assert.ok(true));
 if(process.env.TASK_UI_BROWSER==='true') {
   const {chromium}=await import('playwright');
   const browser=await chromium.launch({headless:true,...(process.env.HARVEY_BROWSER_EXECUTABLE?{executablePath:process.env.HARVEY_BROWSER_EXECUTABLE}:{})});
   try {
     const context=await browser.newContext({viewport:{width:1500,height:1000}});
     const base='http://127.0.0.1:'+port;
     await context.addCookies(delegated.split('; ').map(s=>{const i=s.indexOf('=');return {name:s.slice(0,i),value:s.slice(i+1),url:base};}));
     const recurring=await request('/api/tasks',delegated,'POST',{title:'Visible Wesley recurring',assignedTo:'wesley',column:'today',recurring:true,recurringInterval:'weekly'});
     assert.equal(recurring.status,200);assert.equal(recurring.data.task.createdBy,'carlos');
     const future=await request('/api/tasks',delegated,'POST',{title:'Visible future task',assignedTo:'carlos',column:'this_month',dueDate:'2030-01-15'});assert.equal(future.status,200);
     await context.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());
     const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
     await page.goto(base+'/team-tasks');
     await page.locator('#bars').getByText('Visible Wesley recurring',{exact:true}).waitFor();
     await page.locator('#bars').getByText('Visible future task',{exact:true}).waitFor();
     await page.locator('#allTaskDates').uncheck();await page.locator('#bars').getByText('Visible future task',{exact:true}).waitFor({state:'hidden'});await page.locator('#allTaskDates').check();
     await page.locator('#meChip').click();await page.locator('[data-page="wesley"]').click();
     await page.locator('#quickTitle').fill('Created through the actual task page');await page.locator('#openAdd').click();await page.locator('#tWho').selectOption('wesley');
     const saved=page.waitForResponse(r=>r.url().endsWith('/api/tasks')&&r.request().method()==='POST');await page.locator('#tmSave').click();assert.equal((await saved).status(),200);
     await page.locator('#taskScrim.on').waitFor({state:'hidden'});
     assert((await request('/api/tasks',cookies.wesley)).data.tasks.some(t=>t.title==='Created through the actual task page'));
     await page.locator('[data-tab="done"]').click();await page.locator('#bars').getByText('Wesley retained task',{exact:true}).waitFor();
     await page.locator('[data-tab="active"]').click();await page.locator('#openAdd').click();await page.locator('#tTitle').fill('Keep failed task draft');
     await page.route('**/api/tasks',route=>route.request().method()==='POST'?route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Fixture save rejected'})}):route.continue());
     await page.locator('#tmSave').click();await page.getByText('Fixture save rejected',{exact:true}).waitFor();assert.equal(await page.locator('#tTitle').inputValue(),'Keep failed task draft');assert(await page.locator('#taskScrim.on').isVisible());
     assert.deepEqual(errors,[]);
     check('real task page shows other-member recurring, future and completed tasks; creates assignments while another workspace is selected; rejected saves retain drafts',()=>assert.ok(true));
   } finally {await browser.close();}
 }
 console.log(checks+' account isolation checks passed; no external services were contacted.');
} catch(error){console.error(logs.slice(-5000));throw error;} finally {await stop();work.closeStore();}
