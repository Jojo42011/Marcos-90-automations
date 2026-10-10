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
const root = mkdtempSync(join(tmpdir(), 'team-access-'));console.log('Fixture directory:',root);
process.env.TENANT_DATA_ROOT = root;
process.env.HARVEY_WORK_DIR = join(root, 'harvey-work');
const auth = require('../dist/src/core/authStore.js');
auth.setSecurityState('lockdown_marker', '2026-09-25-dashboard-testing');
const users = ['Marco', 'Wesley', 'Carlos'].map(name => ({ id: name.toLowerCase(), name,
  email: name.toLowerCase()+'@example.com', role: name === 'Marco' ? 'admin' : 'agent', active: true,
  passwordHash: auth.hashPassword('old-password'), createdAt: new Date().toISOString() }));
writeFileSync(join(root, 'users.json'), JSON.stringify(users));
const retainedTeam=JSON.stringify({chats:[{id:'retained-message',from:'wesley',to:'carlos',text:'Keep this message',at:'2026-09-01T00:00:00Z'}],notifications:[],dueNotified:[]});
writeFileSync(join(root,'team.json'),retainedTeam);
const legacy = JSON.stringify({ idCounter: 2, leadsById: { old: {id:'old',name:'Legacy private contact'} }, leadKeyToId:{}, conversationsByLeadId:{}, commandTasks:users.map(u=>({id:"retained-"+u.id,title:u.name+" retained task",assignedTo:u.id,createdBy:u.id,column:"today",status:u.id==="wesley"?"done":"pending",checklist:[{id:"step",text:"Preserve this",done:true}],createdAt:"2026-09-01T00:00:00Z",updatedAt:"2026-09-01T00:00:00Z"})) });
writeFileSync(join(root, 'local-dashboard-db.json'), legacy);
writeFileSync(join(root,'marco-tasks.json'),JSON.stringify([{id:'legacy-personal',title:'Retained personal task',priority:'high',status:'pending',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z'}]));

const work = require('../dist/src/harvey/work/store.js');
const { tenantEnvironment } = require('../dist/src/core/tenantGateway.js');
const isolatedEnv = tenantEnvironment('marco', { ...process.env, BRIVITY_API_KEY:'must-not-copy', GMAIL_REFRESH_TOKEN:'must-not-copy', DB_JSON_PATH:join(root,'private-legacy.json'), HARVEY_PUBLIC_URL:'https://example.invalid' });
assert.equal(isolatedEnv.BRIVITY_API_KEY,undefined);assert.equal(isolatedEnv.GMAIL_REFRESH_TOKEN,undefined);assert.equal(isolatedEnv.DB_JSON_PATH,undefined);
assert.equal(isolatedEnv.HARVEY_PUBLIC_URL,'https://example.invalid');
const retainedAccountTeam=JSON.stringify({chats:[{id:'retained-account-message',from:'marco',to:'carlos',text:'Keep account message',at:'2026-09-02T00:00:00Z'}],notifications:[],dueNotified:[]});
writeFileSync(join(isolatedEnv.TENANT_DATA_ROOT,'team.json'),retainedAccountTeam);
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
 return Response.json({messages:[{id:'fixture-opener',direction:'outgoing',message:'Hey, thanks for your comment! Are you buying your first home?',createdAt:'2026-09-01T10:00:00Z'},{id:'fixture-inbound',direction:'incoming',message:'Yes, this is my first home',createdAt:'2026-09-01T10:01:00Z'}],pagination:{hasMore:false}});
}throw new Error('Unexpected external request blocked by fixture: '+url.hostname);};`);
const bridgeCheck=join(root,'bridge-check.json');
writeFileSync(transport,readFileSync(transport,'utf8')+`
process.on('message',m=>{if(m?.type==='account-bridge' && process.env.TENANT_MEMBER==='carlos')setImmediate(async()=>{try{const result=await require(${JSON.stringify(join(process.cwd(),'dist/src/harvey/platformTools.js'))}).executePlatformTool('crm_api',{method:'GET',path:'/api/dashboard/data?includePhoneless=1',select:['totals','accountSummaries']});fs.writeFileSync(${JSON.stringify(bridgeCheck)},JSON.stringify({ok:result.ok,leads:result.response?.totals?.leads,error:result.error,status:result.status,hasLeads:Array.isArray(result.response?.leads),owners:result.response?.accountSummaries?.length}));}catch(e){fs.writeFileSync(${JSON.stringify(bridgeCheck)},JSON.stringify({error:e.message}));}});});`);
let server, logs='';
function start(){
 server=spawn(process.execPath,['--require',transport,'dist/src/server.js'],{env:{...env,TENANT_DATA_ROOT:root,PORT:String(port),ACCOUNT_ISOLATION:'true',SITE_LOGIN_ENABLED:'1',ZERNIO_DM_API_KEY:'fixture-only',ZERNIO_WEBHOOK_SECRET:'fixture-hook-secret',COMMENT_AGENT_ENABLED:'false',HARVEY_WORKER_ENABLED:'false',DOTENV_CONFIG_PATH:join(root,'.missing-env')},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 server.on('exit',(code,signal)=>{logs+='\nServer exit '+code+' '+signal;});
 server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
}
async function stop(){if(server && server.exitCode===null){const done=once(server,'exit');server.send('shutdown');await done;}}
async function request(path, cookie='', method='GET', body, extraHeaders={}){
 const res=await fetch('http://127.0.0.1:'+port+path,{method,headers:{cookie,...extraHeaders,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:AbortSignal.timeout(60000)});
 const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:res.status,data,cookie:res.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};
}
async function ready(){for(let i=0;i<900;i++){try{if((await request('/health')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Server failed to start: '+logs.slice(-4000));}
const cookies={},chats={},leads={};let checks=0;
function check(name){checks++;console.log('ok',name);}
async function api(user,path,method='GET',body,headers={}){
 const r=await request(path,cookies[user],method,body,headers);assert(r.status>=200&&r.status<300,`${user} ${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);return r.data;
}
try{
 start();await ready();
 for(const user of users){const r=await request('/api/auth/login','','POST',{email:user.email.toUpperCase(),password:'1234'});assert.equal(r.status,200,JSON.stringify(r.data));cookies[user.id]=r.cookie;}
 const repaired=JSON.parse(readFileSync(join(root,'users.json'),'utf8'));assert.deepEqual(repaired.map(u=>u.id),users.map(u=>u.id));
 assert.equal(JSON.parse(readFileSync(join(root,'users.json.before-team-access'),'utf8'))[0].passwordHash,users[0].passwordHash);
 check('three requested logins, case normalization, preserved identity IDs and pre-repair backup');
 let bridge;for(let i=0;i<100;i++){try{bridge=JSON.parse(readFileSync(bridgeCheck,'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal(bridge?.ok,true,JSON.stringify(bridge));assert(bridge.leads>=1);assert.equal(bridge.hasLeads,false);assert.equal(bridge.owners,3);
 check('Carlos’s real worker-to-gateway CRM tool bridge retrieves Marco’s retained contacts');
 for(const user of users){const tasks=(await api(user.id,'/api/tasks')).tasks;assert(tasks.some(t=>t.id==='retained-'+user.id));assert.equal(tasks.length,user.id==='carlos'?3:1);}
 const assigned=(await api('marco','/api/tasks','POST',{title:'Fixture assignment',column:'today',assignedTo:'wesley',createdBy:'marco'})).task;
 assert(!(await api('marco','/api/tasks')).tasks.some(t=>t.id===assigned.id));
 assert((await api('wesley','/api/tasks')).tasks.some(t=>t.id===assigned.id));
 await api('carlos','/api/tasks/'+assigned.id,'PATCH',{title:'Fixture edited by Carlos'});
 assert.equal((await request('/api/tasks/'+assigned.id,cookies.marco,'PATCH',{title:'Forbidden'})).status,404);
 const parallel=await Promise.all(users.map(u=>api(u.id,'/api/tasks','POST',{title:u.name+' concurrent',column:'today',assignedTo:u.id,createdBy:u.id,expectedActorId:u.id})));
 assert.equal((await api('carlos','/api/tasks')).tasks.length,7);
 assert.equal((await request('/api/tasks',cookies.carlos,'POST',{title:'Spoof',column:'today',createdBy:'marco'})).status,409);
 check('assignment-only personal tasks, combined Carlos tasks, authorized edits, concurrent saves and spoof rejection');
 const taskBurst=await Promise.all(Array.from({length:45},(_,i)=>api(users[i%3].id,'/api/tasks','POST',{title:'Stress task '+i,column:'today',assignedTo:users[i%3].id,createdBy:users[i%3].id})));
 assert.equal(new Set(taskBurst.map(r=>r.task.id)).size,45);assert.equal((await api('carlos','/api/tasks')).tasks.length,52);
 check('45 overlapping task writes retain every assignment');
 for(const user of users){
  const created=await api(user.id,'/api/crm/lead','POST',{firstName:user.name+' fixture',phone:'2025550142'});leads[user.id]=created.lead;
  chats[user.id]=(await api(user.id,'/api/harvey/conversations','POST',{title:user.name+' fixture chat',mode:'work'})).id;
 }
 const marco=await api('marco','/api/dashboard/data?includePhoneless=1'),wesley=await api('wesley','/api/dashboard/data?includePhoneless=1'),combined=await api('carlos','/api/dashboard/data?includePhoneless=1');
 assert.equal(marco.leads.length,2);assert.equal(wesley.leads.length,1);assert.equal(combined.leads.length,4);
 assert(combined.leads.every(l=>l.id.startsWith('acct.')&&l.accountOwnerName));assert(!JSON.stringify(combined).includes('passwordHash'));
 assert.equal(combined.totals.leads,4);assert.equal(combined.commandTasksSummary.totalPending,(await api('carlos','/api/tasks')).tasks.filter(t=>t.status!=='done').length);
 const marcoRef=combined.leads.find(l=>l.name==='Marco fixture').id;
 await api('carlos','/api/crm/lead/'+marcoRef,'PATCH',{name:'Marco fixture edited by Carlos'});
 assert((await api('marco','/api/dashboard/data?includePhoneless=1')).leads.some(l=>l.name==='Marco fixture edited by Carlos'));
 assert((await request('/api/crm/lead/'+marcoRef+'/record',cookies.wesley)).status>=400);
 assert((await request('/api/dashboard/data',cookies.wesley,'GET',undefined,{'x-account-owner':'marco'})).status>=400);
 const mixed=combined.leads.filter(l=>l.accountOwnerId!=='carlos').map(l=>l.id);
 assert((await request('/api/leads/mass-delete',cookies.carlos,'POST',{leadIds:mixed})).status>=400);
 const explicit=await api('carlos','/api/crm/lead','POST',{firstName:'For Wesley fixture',phone:'2025550188'},{'x-account-owner':'wesley'});
 assert((await api('wesley','/api/dashboard/data?includePhoneless=1')).leads.some(l=>l.name==='For Wesley fixture'));
 check('combined CRM totals, scoped record edits, explicit record ownership, cross-account denial and mixed bulk-write rejection');
 assert.equal((await api('carlos','/api/harvey/conversations')).conversations.length,4);
 for(const id of [chats.marco,chats.wesley,preserved.id])assert.equal((await api('carlos','/api/harvey/conversations/'+id)).id,id);
 assert((await request('/api/harvey/conversations/'+chats.marco,cookies.wesley)).status>=400);
 await api('carlos','/api/harvey/conversations/'+chats.wesley+'/title','POST',{title:'Wesley chat edited by Carlos'});
 assert.equal((await api('wesley','/api/harvey/conversations/'+chats.wesley)).title,'Wesley chat edited by Carlos');
 assert.equal((await api('marco','/api/harvey/conversations/'+preserved.id)).messages[0].content,'Preserved private message');
 check('Carlos sees and edits both owners’ chats; Wesley cannot access Marco; retained messages unchanged');
 await api('carlos','/api/harvey/chat','POST',{workspace:true,conversationId:chats.marco,message:'Monte Carlo off',actorId:'wesley'});
 const actorMessages=(await api('marco','/api/harvey/conversations/'+chats.marco)).messages;
 assert.equal(actorMessages.find(m=>m.role==='user').actorId,'carlos');
 check('Harvey records Carlos as the speaker in Marco’s chat and ignores forged actor input');
 const docs=await Promise.all(users.map(u=>api(u.id,'/api/knowledge','POST',{title:u.name+' shared fixture',body:'Shared durable SOP '+u.id,category:'Fixture'})));
 for(const user of users)for(const doc of docs)assert.equal((await api(user.id,'/api/knowledge/'+doc.doc.id)).doc.body,doc.doc.body);
 await api('wesley','/api/knowledge/'+docs[0].doc.id,'PATCH',{body:'Shared correction'});
 assert.equal((await api('marco','/api/knowledge/'+docs[0].doc.id)).doc.body,'Shared correction');
 check('concurrent shared knowledge creation and cross-account edits');
 const bursts=await Promise.all(Array.from({length:60},(_,i)=>api(users[i%3].id,'/api/knowledge','POST',{title:'Stress fixture '+i,body:'Concurrent document '+i,category:'Stress'})));
 const ids=new Set(bursts.map(r=>r.doc.id));assert.equal(ids.size,60);
 for(const user of users){const all=(await api(user.id,'/api/knowledge')).docs;assert.equal(all.filter(d=>ids.has(d.id)).length,60);}
 check('60 overlapping writes across three worker processes retain every shared document');
 await api('wesley','/api/account/preferences','PUT',{theme:'dark',accent:'#123456',fontSize:18});
 assert.equal((await api('wesley','/api/account/preferences')).preferences.accent,'#123456');
 assert.notEqual((await api('marco','/api/account/preferences')).preferences.accent,'#123456');
 assert.equal((await request('/api/account/preferences',cookies.wesley,'PUT',{accent:'red;body{display:none}'})).status,400);
 check('persistent individual preferences, no cross-account theme leakage, invalid CSS rejected');
 const targets=(await api('wesley','/api/account/chats')).chats;assert(targets.every(c=>c.accountOwnerId==='wesley'));
 assert((await request('/api/account/chat-relay',cookies.wesley,'POST',{requestId:'forbidden',sourceChatId:chats.wesley,targets:[chats.marco],message:'Must not deliver'})).status>=400);
 const relayInput={requestId:'fixture-relay',sourceChatId:chats.carlos,targets:[chats.marco,chats.wesley],message:'Fixture message: acknowledge this test only.'};
 const relay=await api('carlos','/api/account/chat-relay','POST',relayInput);assert.equal(relay.deliveries.length,2);
 const duplicate=await api('carlos','/api/account/chat-relay','POST',relayInput);assert.deepEqual(duplicate,relay);
 assert((await request('/api/account/chat-relay',cookies.carlos,'POST',{...relayInput,message:'Changed'})).status>=400);
 check('authorized multi-owner chat relay, unauthorized target rejection and exactly-once request receipt');
 assert.equal((await request('/api/dashboard/data')).status,401);
 assert.equal((await request('/api/auth/team',cookies.carlos)).status,403);
 assert.equal((await request('/api/users',cookies.carlos,'POST',{name:'Other',email:'other@example.com'})).status,403);
 assert.equal((await request('/api/dashboard/data','', 'GET',undefined,{'x-account-bridge':'forged'})).status,401);
 check('anonymous requests, forged internal credentials and non-admin account management denied');
 await stop();start();await ready();
 assert.equal((await api('wesley','/api/account/preferences')).preferences.accent,'#123456');
 assert.equal((await api('carlos','/api/dashboard/data?includePhoneless=1')).leads.length,5);
 assert.equal((await api('marco','/api/harvey/conversations/'+preserved.id)).messages[0].content,'Preserved private message');
 assert.equal((await api('wesley','/api/knowledge/'+docs[0].doc.id)).doc.body,'Shared correction');
 assert.equal(readFileSync(join(root,'local-dashboard-db.json'),'utf8'),legacy);
 assert.equal(readFileSync(join(root,'team.json'),'utf8'),retainedTeam);
 check('restart persistence and original shared data files remain byte-for-byte intact');
 console.log(checks+' team integration groups passed. No external services contacted.');
}catch(error){console.error(logs.slice(-6000));await stop();throw error;}finally{
 if(process.env.KEEP_TEAM_FIXTURE==='1'){
  console.log('TEAM_FIXTURE_READY '+JSON.stringify({port,root}));
  process.stdin.once('data',async()=>{await stop();process.exit(0);});
 }else await stop();
 work.closeStore();
}
