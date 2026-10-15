// Offline endpoint-to-endpoint acceptance: real HTTP routes, runtime, provider
// adapter and SQLite; deterministic local model. Never connects to client apps.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'harvey-reliability-'));
for(const k of Object.keys(process.env))if(/API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|DATABASE_URL|DB_JSON_PATH|COMPOSIO|HARVEY_WORK_DIR|TENANT_OWNER_ID/.test(k))delete process.env[k];
Object.assign(process.env,{TENANT_DATA_ROOT:dir,HARVEY_WORK_DIR:join(dir,'work'),AI_USAGE_DB_PATH:join(dir,'usage.db'),HARVEY_VAULT_KEY:'12'.repeat(32),HARVEY_WORKER_ENABLED:'false',HARVEY_BROWSER_ENABLED:'false',DOTENV_CONFIG_PATH:join(dir,'no-env')});
const originalFetch=global.fetch;
global.fetch=(url,...args)=>{const u=new URL(typeof url==='string'?url:url.url||String(url));assert(['127.0.0.1','localhost'].includes(u.hostname),'External request blocked: '+u.hostname);return originalFetch(url,...args);};
const root=resolve('dist/src'),store=require(join(root,'harvey/work/store.js')),rel=require(join(root,'harvey/reliability.js'));
const progress=require(join(root,'harvey/work/progress.js'));
let checks=0;const ok=(name,fn)=>{fn();checks++;console.log('ok',name);};
ok('automatic resume retains media across browser reads without secrets or cross-owner leakage',()=>{
 progress.recordProgress('progress-alice','chat','edit_video',{file:'original.mov'},{file:'export.mp4',source:'original.mov',verified:true,frames:414,durationSeconds:13.8});
 for(let i=0;i<20;i++)progress.recordProgress('progress-alice','chat','computer',{action:'call',tool:'browser_type',arguments:{text:'private-password'}},{content:[{type:'text',text:'verification code 123456'}]});
 const p=progress.readProgress('progress-alice','chat');assert.equal(p.events.length,9);assert.equal(p.events[0].file,'export.mp4');assert.equal(p.events[0].verified,true);assert(!JSON.stringify(p).includes('private-password'));assert(!JSON.stringify(p).includes('123456'));assert.equal(progress.readProgress('progress-bob','chat').events.length,0);
});
ok('nested argument hashing preserves IDs and ignores key order',()=>{assert.equal(rel.stableCallKey('x',{a:{b:1,c:2}}),rel.stableCallKey('x',{a:{c:2,b:1}}));assert.notEqual(rel.stableCallKey('x',{arguments:{id:'one'}}),rel.stableCallKey('x',{arguments:{id:'two'}}));});
const proof=new rel.TurnVerification();
proof.record('business_call',{tool:'get_listing'},{listing:{id:'fixture-1',address:'100 Fixture Street',status:'active'}});
ok('exact source values pass; invented addresses and missing paths fail',()=>{
 assert.equal(proof.verifyValues({evidenceId:'e1',claims:[{path:'/listing/address',expected:'100 Fixture Street'}]}).verified,true);
 assert.throws(()=>proof.verifyValues({evidenceId:'e1',claims:[{path:'/listing/address',expected:'999 Invented Drive'}]}),/does not match/);
 assert.throws(()=>proof.verifyValues({evidenceId:'e1',claims:[{path:'/listing/price',expected:100}]}),/missing/);
});
const review={status:'completed',evidenceIds:['e1'],checks:['Checked source'],limitations:[]};
ok('fabricated evidence references fail',()=>assert.throws(()=>proof.review({...review,evidenceIds:['e999']})));
const actions=new rel.TurnVerification();actions.record('schedule_agent',{action:'create'},{id:'schedule'});actions.record('workspace_files',{},[]);
ok('unrelated successful read cannot verify a schedule write',()=>assert.throws(()=>actions.review({...review,evidenceIds:['e2']}),/affected service/));
actions.record('schedule_agent',{action:'list'},[{id:'schedule'}]);actions.review({...review,evidenceIds:['e3']});
ok('matching read-back permits review; later actions invalidate it',()=>{assert.equal(actions.result().status,'completed');actions.record('schedule_agent',{action:'update'},{id:'schedule'});assert.equal(actions.result().status,'needs_verification');});
const failed=new rel.TurnVerification();failed.record('plugin_call',{}, {data:{results:[{success:false,error:'fixture failure'}]}});
ok('nested connector failures cannot serve as evidence',()=>assert.equal(failed.result().receipts[0].outcome,'failed'));
const large=new rel.TurnVerification();large.record('workspace_files',{}, {text:'x'.repeat(13000)});
ok('truncated results cannot support complete claims',()=>assert.throws(()=>large.review(review),/smaller/));
const unseen=new rel.TurnVerification();unseen.record('computer',{action:'call',tool:'browser_take_screenshot'},{imageUnavailableToModel:true,content:[{type:'text',text:'Screenshot captured'}]});
ok('unseen screenshot cannot verify visual completion',()=>assert.throws(()=>unseen.review(review),/Unavailable image/));

ok('CRM GET receipts are observations and writes still require read-back',()=>{
 const v=new rel.TurnVerification();v.record('business_call',{tool:'crm_api',arguments:{method:'GET'}},{ok:true,response:{totals:{leads:2417}}});v.review({...review,checks:['Read complete live totals']});assert.equal(v.result().status,'completed');
 const w=new rel.TurnVerification();w.record('business_call',{tool:'crm_api',arguments:{method:'PATCH'}},{ok:true});assert.throws(()=>w.review(review),/Read back/);
});

const repairAttempts=new Map();
const calls=[];let releaseSlow,slowStarted,transientCalls=0;
const slowReady=new Promise(r=>slowStarted=r),slowHold=new Promise(r=>releaseSlow=r);
const model=http.createServer((req,res)=>{if(req.url==='/key'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{usage_monthly:0}}));return;}let raw='';req.on('data',b=>raw+=b);req.on('end',async()=>{
 const b=JSON.parse(raw);calls.push(b);
 const user=b.messages.filter(m=>m.role==='user').at(-1)?.content||'';
 const toolMessages=b.messages.filter(m=>m.role==='tool');const n=toolMessages.length;
 let response={role:'assistant',content:'A conversational fixture answer.'};
 const tc=(name,args)=>({role:'assistant',content:'',tool_calls:[{id:'call-'+n,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 if(JSON.stringify(b.messages).includes('AUTO_BROWSER_VISION_FIXTURE')){
   if(n===1){assert.notEqual(b.model,'inception/mercury-2.5');assert(JSON.stringify(b.messages).includes('image_url'));}
   response=n<2?tc('computer',{action:'call',tool:n?'browser_mouse_click_xy':'browser_take_screenshot',arguments:n?{x:20,y:20}:{}}):{role:'assistant',content:'The visual step is done.'};
 }
 else if(user.includes('AUTO_FORMAT_RECOVERY_FIXTURE')){
   response=b.model==='inception/mercury-2.5'?{role:'assistant',content:''}:{role:'assistant',content:'Recovered without replaying the task.'};
 }
 else if(JSON.stringify(b.messages).includes('PLAIN_STATUS_FIXTURE')||JSON.stringify(b.messages).includes('PLAIN_STATUS_CALL_FIXTURE')){
   const rewrite=JSON.stringify(b.messages).includes('Rewrite the draft below into 2–4 short, plain sentences for Marco.');
   response=!rewrite&&n===0?tc('workspace_files',{}):rewrite?(JSON.stringify(b.messages).includes('PLAIN_STATUS_CALL_FIXTURE')?tc('workspace_files',{}):{role:'assistant',content:'Both videos are ready. They still need to be combined, and I have not started that step.'}):{role:'assistant',content:'## Technical status\n'+('The source files are prepared; combining them is still pending. '.repeat(14))};
 }
 else if(user.includes('SCROLL_PAGING_FIXTURE')){
   response=n===0?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{}}):n<9?tc('computer',{action:'call',tool:n%2?'browser_scroll':'browser_read_table',arguments:n%2?{target:'#leads',deltaY:600}:{}}):n===9?tc('report_verification',{status:'completed',evidenceIds:['e9'],checks:['Read final page'],limitations:[]}):{role:'assistant',content:'All fixture pages read.'};
 }
 else if(user.includes('SCROLL_RECOVERY_FIXTURE')){
   const repaired=JSON.stringify(b.messages).includes('BROWSER RETRIEVAL RECOVERY');
   response=n===0?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{}}):n===1&&!repaired?{role:'assistant',content:'The site requires physically scrolling, which my automation cannot do. Try manual scroll and screenshot.'}:n===1?tc('computer',{action:'call',tool:'browser_scroll',arguments:{deltaY:600}}):n===2?tc('computer',{action:'call',tool:'browser_read_table',arguments:{}}):n===3?tc('report_verification',{status:'completed',evidenceIds:['e3'],checks:['Read rows after scrolling'],limitations:[]}):{role:'assistant',content:'Retrieved rows after scrolling.'};
 }
 else if(user.includes('AUTO_YIELD_RUNTIME_FIXTURE')){
   response=n===0?tc('workspace_files',{}):{role:'assistant',content:'I reached the execution limit. Just say continue and I will finish.'};
 }
 else if(user.includes('CONTINUATION_RUNTIME_FIXTURE')){
   const steps=[['task_plan',{action:'save',objective:'Existing project composite',steps:['Inspect saved render','Export'],successCriteria:['Verified output'],requiredSources:[]}],['task_plan',{action:'get'}],['continue_work',{delaySeconds:30,reason:'Inspect existing render, then export.',evidenceId:'e2',quote:'Existing project composite'}]];
   response=n<steps.length?tc(...steps[n]):{role:'assistant',content:'The saved render is still pending.'};
 }
 else if(user.includes('CONTINUATION_CHECKPOINT_FIXTURE')){
   const checkpoint=b.tools?.some(t=>t.function.name==='continue_work')&&!b.tools?.some(t=>t.function.name==='computer');
   response=checkpoint?{role:'assistant',content:'',tool_calls:[
     {id:'forbidden',type:'function',function:{name:'computer',arguments:JSON.stringify({action:'call',tool:'browser_click',arguments:{target:'#generate'}})}},
     {id:'checkpoint',type:'function',function:{name:'continue_work',arguments:JSON.stringify({delaySeconds:30,reason:'Inspect existing render then export.',evidenceId:'e29',quote:'Rendering at 46%'})}}
   ]}:b.tools?.length?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{depth:n+1}}):{role:'assistant',content:'Stopped.'};
 }
 else if(user.includes('SUMMARY_RECOVERY_FIXTURE')){
   response=b.tools?.length?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{depth:n+1}}):b.model==='inception/mercury-2.5'?{role:'assistant',content:''}:{role:'assistant',content:'The files are ready. The last step is still pending.'};
 }
 else if(user.includes('LOGIN_EMAIL_RECOVERY_FIXTURE')){
   response=n?{role:'assistant',content:'I checked the available mail connection.'}:JSON.stringify(b.messages).includes('Before asking the user to supply this sign-in code')?tc('COMPOSIO_SEARCH_TOOLS',{queries:[{use_case:'Find the current sign-in email'}]}):{role:'assistant',content:'Please share the verification code from your inbox.'};
 }
 else if(user.includes('VIDEO_RECOVERY_BUDGET')){
   response=n<5?tc('edit_video',{file:'original.mov',durationSeconds:15-n}):{role:'assistant',content:'The diagnostic is retained; no more export attempts were made.'};
 }
 else if(user.includes('MALFORMED_REPLY_FIXTURE')){
   const attempt=(repairAttempts.get(user)||0)+1;repairAttempts.set(user,attempt);
   response=attempt<=2?{role:'assistant',content:attempt===1?'':'<|tool_call_start|><function=computer>bad call</function><|tool_call_end|>'}:{role:'assistant',content:'Recovered into a usable answer.'};
 }
 else if(user.includes('BROKEN_BATCH_FIXTURE'))response=n===0?tc('computer',{action:'call',tool:user.includes('UNKNOWN_WRITE')?'browser_click':'browser_snapshot'}):{role:'assistant',content:''};
 else if(user.includes('ALWAYS_EMPTY_FIXTURE'))response={role:'assistant',content:''};
 else if(user.includes('ORDERED_TOOLS_FIXTURE')){
   response=n===0?{role:'assistant',content:'',tool_calls:[
    {id:'write',type:'function',function:{name:'schedule_agent',arguments:JSON.stringify({action:'create'})}},
    {id:'read',type:'function',function:{name:'schedule_agent',arguments:JSON.stringify({action:'list'})}},
    {id:'verify',type:'function',function:{name:'report_verification',arguments:JSON.stringify({status:'completed',evidenceIds:['e2'],checks:['Read after write'],limitations:[]})}}
   ]}:{role:'assistant',content:'Saved and verified.'};
 }
 else if(user.includes('SLOW_FIXTURE')){slowStarted();await slowHold;response={role:'assistant',content:'Slow fixture completed.'};}
 else if(user.includes('TRANSIENT_FIXTURE')){if(++transientCalls===1){res.statusCode=504;res.end(JSON.stringify({error:{message:'Upstream idle timeout exceeded'}}));return;}response={role:'assistant',content:'Transient provider recovered.'};}
 else if(user.includes('BROWSER_VISION_FIXTURE')){
  if(n===1)assert(!JSON.stringify(b.messages).includes('image_url'),'Text-only model must not receive image input');
  response=n<2?tc('computer',{action:'call',tool:n?'browser_mouse_click_xy':'browser_take_screenshot',arguments:n?{x:20,y:20}:{}}):n===2?tc('report_verification',{status:'needs_verification',evidenceIds:[],checks:['Model capability checked'],limitations:['Visual input unsupported']}):{role:'assistant',content:'Use semantic controls.'};
 }
 else if(user.includes('BROWSER_GUARD_FIXTURE')){
  response=n<3?tc('computer',{action:'call',tool:'browser_click',arguments:{target:'#save'}}):n===3?tc('report_verification',{status:'needs_verification',evidenceIds:[],checks:['Inspect before another action'],limitations:['Fixture action needs read-back']}):{role:'assistant',content:'Stopped for inspection.'};
 }
 else if(user.includes('RECOVERY_FIXTURE')){
  const steps=[['schedule_agent',{action:'create',title:'Recovered task',prompt:'Fixture',cron:'* * * * *',timezone:'UTC'}],['schedule_agent',{action:'create',title:'Recovered task',prompt:'Fixture',cron:'0 9 * * *',timezone:'UTC'}],['schedule_agent',{action:'list'}],['report_verification',{status:'completed',evidenceIds:['e3'],checks:['Read back the corrected schedule'],limitations:[]}]];
  response=n<steps.length?tc(...steps[n]):{role:'assistant',content:'The corrected schedule is saved.'};
 }
 else if(user.includes('DETACHED_FIXTURE')){await new Promise(r=>setTimeout(r,1000));response={role:'assistant',content:'Detached fixture completed.'};}
 else if(user.includes('TEACH_FIXTURE')){
  const output=i=>JSON.parse(toolMessages[i].content);
  const seq=n?output(0).messages[0].seq:0;
  const lesson={key:'listing rule',value:'Use active listings only',sourceSeq:seq,sourceQuote:'Use active listings only.'};
  const steps=[
   ['history_search',{query:'TEACH_FIXTURE'}],
   ['agent_memory',{action:'save',...lesson}],
   ['agent_memory',{action:'search',query:'listing rule'}],
   ['workflow',{action:'save',name:'Taught listing review',steps:['Read active listings from the CRM'],checks:['Every reported field matches its source'],prerequisites:['Verify signed-in account'],sources:[{seq,quote:'Use active listings only.'}]}],
   ['workflow',{action:'get',id:n>3?output(3).id:''}],
   ['schedule_agent',{action:'create',title:'Taught daily workflow',prompt:'Run the taught listing review and verify outcomes',workflowId:n>3?output(3).id:'',cron:'0 9 * * *',timezone:'America/Chicago'}],
   ['schedule_agent',{action:'list'}],
   ['report_verification',{status:'completed',evidenceIds:['e3','e5','e7'],checks:['Read back saved memory, procedure and schedule'],limitations:[]}]
  ];response=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Saved the taught procedure and daily schedule. Execution has not been tested.'};
 }
 else if(user.includes('UNSUPPORTED_FIXTURE'))response={role:'assistant',content:'I have verified every listing and completed the task.'};
 else if(user.includes('AUTOMATE_FIXTURE')){
  const sequence=[
   ['task_plan',{action:'save',objective:'Fixture agent and schedule',successCriteria:['Agent exists','Schedule exists'],steps:['Create agent','Create schedule','Read back both'],requiredSources:['Local records']}],
   ['task_plan',{action:'get'}],
   ['projects',{action:'new_chat',title:'Fixture research agent'}],
   ['projects',{action:'list_chats'}],
   ['schedule_agent',{action:'create',title:'Fixture weekly review',prompt:'Review fixture information',cron:'0 9 * * 1',timezone:'America/Chicago'}],
   ['schedule_agent',{action:'list'}],
   ['task_plan',{action:'checkpoint',completedSteps:[0,1,2],nextStep:3}],
   ['task_plan',{action:'get'}],
   ['report_verification',{status:'completed',evidenceIds:['e8','e4','e6'],checks:['Read back created agent and weekly schedule'],limitations:[]}]
  ];response=n<sequence.length?tc(...sequence[n]):{role:'assistant',content:'Fixture agent created and schedule saved. Worker is disabled in this test.'};
 }
 else if(user.includes('REPEAT_FIXTURE')){
  const create={action:'create',title:'One only',prompt:'Fixture',cron:'0 10 * * 1',timezone:'America/Chicago'};
  response=n<2?tc('schedule_agent',create):tc('report_verification',{status:'needs_verification',evidenceIds:[],checks:['Duplicate attempt blocked'],limitations:['Read-back pending']});
  if(n>=3)response={role:'assistant',content:'Only one creation attempt ran.'};
 }
 res.setHeader('content-type','application/json');res.end(JSON.stringify({model:b.model,choices:[{message:response}],usage:{prompt_tokens:10,completion_tokens:10,cost:0}}));
});});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
process.env.OPENROUTER_API_KEY='local-fixture';process.env.OPENROUTER_BASE_URL='http://127.0.0.1:'+model.address().port;process.env.HARVEY_MODEL='openai/fixture';
const express=require('express'),routes=require(join(root,'harvey/work/routes.js')),jobs=require(join(root,'harvey/work/jobs.js')),runtime=require(join(root,'harvey/work/runtime.js'));
const app=express();app.use(express.json());app.use(express.static(resolve('public')));
const owner=req=>String(req.headers['x-test-owner']||'alice'),authorized=req=>req.headers.authorization==='Bearer fixture';
app.get('/api/harvey/models',(_req,res)=>res.json({models:[{id:'openai/fixture',name:'Fixture One'},{id:'openai/fixture-two',name:'Fixture Two'}]}));
app.get('/api/harvey/work/model-advice',(_req,res)=>res.json({models:[{id:'openai/fixture',name:'Fixture One',label:'Fixture One',inputPerM:1,outputPerM:2,exampleCostUsd:.014,pricing:{fresh:true},recentSpeed:{averageResponseSeconds:2,samples:3},fit:'Routine fixture work',visualUse:'Text only'},{id:'openai/fixture-two',name:'Fixture Two',label:'Fixture Two',inputPerM:2,outputPerM:4,exampleCostUsd:.028,pricing:{fresh:false},recentSpeed:null}],recommendations:{routine:'openai/fixture',multiStep:'openai/fixture-two'}}));
app.use('/api/harvey',routes.createWorkRouter(authorized,owner));
app.post('/api/harvey/chat',(req,res)=>{if(!authorized(req))return res.sendStatus(401);return routes.handleWorkChat(req,res,owner(req));});
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/harvey';
async function api(path,method='GET',body,who='alice'){
 const response=await fetch(base+path,{method,headers:{authorization:'Bearer fixture','x-test-owner':who,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 return {status:response.status,data:await response.json()};
}
async function chat(mode='work'){return (await api('/conversations','POST',{mode})).data;}
async function terminal(id){for(let i=0;i<300;i++){const r=await api('/work/jobs/'+id);if(!['queued','running','cancelling'].includes(r.data.status))return r.data;await new Promise(r=>setTimeout(r,30));}throw new Error('Job timed out');}
try{
 const {runAgentLoop}=require(join(root,'hull/agentLoop.js'));
 for(const invalidCall of [false,true]){
   let reads=0;
   const simple=await runAgentLoop({message:"What's left? "+(invalidCall?'PLAIN_STATUS_CALL_FIXTURE':'PLAIN_STATUS_FIXTURE'),modelOverride:'inception/mercury-2.5',workRuntime:{context:'Fixture',tools:[{name:'workspace_files',description:'Fixture',input_schema:{type:'object',properties:{}}}],execute:async()=>{reads++;return {files:[{name:'ready.mp4'}]};}}});
   ok('plain status rewrite cannot execute additional tools '+invalidCall,()=>{assert.equal(reads,1);if(!invalidCall){assert(simple.speech.length<200);assert(!simple.speech.includes('##'));assert.match(simple.speech,/still need/);}else assert(simple.modelError);});
 }
 for(const execution of [true,false]){
   const continuationChat=store.createChat('continuation-fixture',{});
   const result=await require(join(root,'harvey/work/runtime.js')).runChat('continuation-fixture',continuationChat,(execution?'Finish':'Did you finish')+' CONTINUATION_RUNTIME_FIXTURE',{allowContinuation:true,modelOverride:'openai/fixture'});
   ok('real runtime continuation requires an execution request and unfinished plan '+execution,()=>assert.equal(!!result.continuation,execution));
 }
 let pagingScrolls=0;
 const paged=await runAgentLoop({message:'Read all SCROLL_PAGING_FIXTURE',modelOverride:'inception/mercury-2.5',workRuntime:{context:'Fixture',tools:[{name:'computer',description:'Fixture',input_schema:{type:'object',properties:{}}}],execute:async(_n,i)=>{if(i.tool==='browser_scroll')pagingScrolls++;return {rows:[{page:pagingScrolls}]};}}});
 ok('identical scroll gestures can advance after distinct fresh page observations',()=>{assert.equal(pagingScrolls,4);assert.equal(paged.verification.status,'completed');});
 let scrollCalls=0;
 const scrollRecovery=await runAgentLoop({message:'Export leads SCROLL_RECOVERY_FIXTURE',modelOverride:'inception/mercury-2.5',allowContinuation:true,workRuntime:{context:'Fixture',tools:[{name:'computer',description:'Fixture',input_schema:{type:'object',properties:{}}}],execute:async(_n,i)=>{if(i.tool==='browser_scroll')scrollCalls++;return {rows:i.tool==='browser_read_table'?[{name:'Fixture'}]:[]};}}});
 ok('unsupported manual-scroll handoff retries supported retrieval with text-only model',()=>{assert.equal(scrollCalls,1);assert.match(scrollRecovery.speech,/Retrieved rows/);assert.equal(scrollRecovery.verification.status,'completed');});
 const autoChat=store.createChat('auto-yield-fixture',{});
 const automatic=await require(join(root,'harvey/work/runtime.js')).runChat('auto-yield-fixture',autoChat,'How many records are in each group? AUTO_YIELD_RUNTIME_FIXTURE',{allowContinuation:true,workRequestId:'auto-job',modelOverride:'openai/fixture'});
 ok('counting task seeds its plan and continues even when the model asks the user to continue',()=>{assert(automatic.continuation);assert(automatic.continuation.progressKey);assert(!/say continue/i.test(automatic.speech));assert(!store.messages('auto-yield-fixture',autoChat.id).some(m=>m.role==='assistant'&&/continue/i.test(m.content)));});
 const oldAgent=process.env.HARVEY_MODEL_AGENT;
 process.env.HARVEY_MODEL_AGENT='inception/mercury-2.5';
 let autoVisualExecutions=0;
 const autoVisual=await runAgentLoop({message:'AUTO_BROWSER_VISION_FIXTURE',job:'agent',workRuntime:{context:'Fixture',tools:[{name:'computer',description:'Fixture',input_schema:{type:'object',properties:{}}}],execute:async(_n,i)=>{autoVisualExecutions++;return i.tool==='browser_take_screenshot'?{_image:{media_type:'image/jpeg',data:'fixture-pixels'},content:[{type:'text',text:'Screenshot captured'}]}:{ok:true};}}});
 ok('Auto hands actual screenshot pixels to a vision model before coordinate action',()=>{assert.equal(autoVisualExecutions,2);assert.notEqual(autoVisual.modelUsed,'inception/mercury-2.5');});
 const autoFormat=await runAgentLoop({message:'AUTO_FORMAT_RECOVERY_FIXTURE',job:'agent',workRuntime:{context:'Fixture',tools:[],execute:async()=>{throw Error('No action expected');}}});
 ok('Auto changes model once after malformed replies without replaying any action',()=>{assert.match(autoFormat.speech,/Recovered/);assert(!autoFormat.modelError);});
 let longActions=0;
 const summary=await runAgentLoop({message:'SUMMARY_RECOVERY_FIXTURE',job:'agent',workRuntime:{context:'Fixture',tools:[{name:'computer',description:'Fixture',input_schema:{type:'object',properties:{}}}],execute:async()=>{longActions++;return {content:[{type:'text',text:'Existing work observed'}]};}}});
 ok('long tool run reserves enough room to recover its final answer without restarting work',()=>{assert.equal(longActions,29);assert.match(summary.speech,/last step is still pending/);assert(!summary.modelError);});
 let continuationReads=0;
 const continuationTools=['computer','continue_work'].map(name=>({name,description:'Fixture',input_schema:{type:'object',properties:{}}}));
 const checkpointed=await runAgentLoop({message:'Finish CONTINUATION_CHECKPOINT_FIXTURE',job:'agent',allowContinuation:true,workRuntime:{context:'Fixture',tools:continuationTools,pendingWork:()=>true,execute:async(_n,i)=>{assert.equal(i.tool,'browser_snapshot','Checkpoint round must reject a fabricated external action');continuationReads++;return {text:'Rendering at 46%'};}}});
 ok('reserved checkpoint yields unfinished work with observed state and cannot run external actions',()=>{assert.equal(continuationReads,29);assert.equal(checkpointed.continuation.delaySeconds,30);assert.match(checkpointed.continuation.reason,/existing render/);});
 const elapsed=await runAgentLoop({message:'Finish CONTINUATION_CHECKPOINT_FIXTURE',job:'agent',allowContinuation:true,checkpointAt:Date.now()-1,workRuntime:{context:'Fixture',tools:continuationTools,pendingWork:()=>true,execute:async()=>{throw new Error('The elapsed segment must not execute more external actions');}}});
 ok('elapsed segment enters checkpoint rounds before the hard task timer',()=>assert.equal(elapsed.verification?.receipts.length,0));
 if(oldAgent===undefined)delete process.env.HARVEY_MODEL_AGENT;else process.env.HARVEY_MODEL_AGENT=oldAgent;
 for(const available of [true,false]){
   let mailDiscovery=0;
   await runAgentLoop({message:'LOGIN_EMAIL_RECOVERY_FIXTURE',modelOverride:'inception/mercury-2.5',workRuntime:{context:'Fixture',loginEmailAvailable:available,tools:[{name:'COMPOSIO_SEARCH_TOOLS',description:'Fixture',input_schema:{type:'object',properties:{}}}],execute:async()=>{mailDiscovery++;return {tools:[]};}}});
   ok('email recovery respects authorized mailbox availability '+available,()=>assert.equal(mailDiscovery,available?1:0));
 }
 let editCalls=0;
 const videoResult=await runAgentLoop({message:'VIDEO_RECOVERY_BUDGET',fullMode:true,modelOverride:'inception/mercury-2.5',workRuntime:{tools:[{name:'edit_video',description:'Fixture',input_schema:{type:'object',properties:{}}}],context:'Fixture',execute:async()=>{editCalls++;return {error:'Fixture failure',diagnostic:{code:'unsupported_track',message:'Unsupported alternate audio',detail:'apple_apac'}};}}});
 ok('varying edit arguments cannot bypass per-source recovery budget and diagnostics survive',()=>{assert.equal(editCalls,2);assert(videoResult.verification.receipts.some(r=>r.diagnostic?.detail==='apple_apac'));});
 const repairRuntime={tools:[],context:'Fixture',execute:async()=>{throw new Error('No tool should run');}};
 const formatRepaired=await runAgentLoop({message:'MALFORMED_REPLY_FIXTURE',fullMode:true,workRuntime:repairRuntime,modelOverride:'inception/mercury-2.5'});
 ok('empty and pseudo-tool output repairs into a usable answer without executing text',()=>{assert.match(formatRepaired.speech,/Recovered/);assert(!formatRepaired.modelError);});
 const empty=await runAgentLoop({message:'ALWAYS_EMPTY_FIXTURE',fullMode:true,workRuntime:repairRuntime,modelOverride:'inception/mercury-2.5'});
 ok('persistent empty replies return an honest nonempty failure after bounded repair',()=>{assert(empty.modelError);assert(empty.speech.length>20);});
 for(const unknownWrite of [false,true]){
   let actions=0;
   const recovered=await runAgentLoop({message:'Finish BROKEN_BATCH_FIXTURE '+(unknownWrite?'UNKNOWN_WRITE':''),fullMode:true,allowContinuation:true,modelOverride:'inception/mercury-2.5',workRuntime:{context:'Fixture',pendingWork:()=>true,tools:[{name:'computer',description:'Fixture',input_schema:{type:'object',properties:{}}}],execute:async()=>{actions++;return {text:'Source account and destination account inspected; completed batch retained.'};}}});
   ok('malformed batch resumes only after safe observation '+unknownWrite,()=>{assert.equal(actions,1);assert.equal(recovered.continuation?.recovery,unknownWrite?undefined:'model_response');assert.equal(!!recovered.modelError,unknownWrite);});
 }
 let written=false,writeCount=0;
 const ordered=await runAgentLoop({message:'ORDERED_TOOLS_FIXTURE',fullMode:true,modelOverride:'inception/mercury-2.5',workRuntime:{tools:[{name:'schedule_agent',description:'Fixture',input_schema:{type:'object',properties:{action:{type:'string'}}}}],context:'Fixture',execute:async(_n,i)=>{if(i.action==='create'){await new Promise(r=>setTimeout(r,30));written=true;writeCount++;return {id:'one'};}assert(written);return [{id:'one'}];}}});
 ok('dependent tool batch executes write then read then verification without racing or replay',()=>{assert.equal(writeCount,1);assert.equal(ordered.verification.status,'completed');});
 let visualExecutions=0;
 const visualResult=await runAgentLoop({message:'BROWSER_VISION_FIXTURE',modelOverride:'inception/mercury-2.5',workRuntime:{context:'Local browser visual capability fixture.',tools:[{name:'computer',description:'Fixture browser',input_schema:{type:'object',properties:{}}}],execute:async()=>{visualExecutions++;return {_image:{media_type:'image/jpeg',data:'fixture-pixels'},content:[{type:'text',text:'Screenshot captured'}]};}}});
 ok('text-only model keeps working after screenshots and cannot issue unseen coordinate clicks',()=>assert.equal(visualExecutions,1));
 ok('visual-only response honestly states missing image capability',()=>assert.match(visualResult.speech,/cannot inspect image pixels/));
 for(const safe of [true,false]){
  let executions=0;
  await runAgentLoop({message:'BROWSER_GUARD_FIXTURE',modelOverride:'openai/fixture',workRuntime:{context:'Local browser recovery fixture.',tools:[{name:'computer',description:'Fixture browser',input_schema:{type:'object',properties:{}}}],execute:async()=>{
   executions++;return executions===1?{error:'Fixture target failure',recovery:{actionOutcome:safe?'not_executed':'unknown',safeToRetry:safe}}:{content:[{type:'text',text:'Clicked'}]};
  }}});
  ok(safe?'confirmed unexecuted browser action gets one retry, then successful replay is refused':'uncertain browser action is never automatically replayed',()=>assert.equal(executions,safe?2:1));
 }
 assert.equal((await api("/chat","POST",{background:true,message:"Unbound",requestId:randomUUID()})).status,400);checks++;
 const taught=await chat();
 const taughtResult=await api('/chat','POST',{conversationId:taught.id,message:'TEACH_FIXTURE: Use active listings only. Save this workflow and schedule it daily at 9 am.',model:'openai/fixture'});
 ok('HTTP teaching turn saves sourced memory, a versioned procedure and a pinned daily schedule',()=>{assert.equal(taughtResult.data.verification.status,'completed',JSON.stringify(taughtResult));const t=store.list('schedule','alice').find(x=>x.chatId===taught.id);assert(t.workflowId);assert.equal(t.cron,'0 9 * * *');assert.equal(t.pauseAfterFailures,3);assert(taughtResult.data.contextPlan);assert(taughtResult.data.memoryContext);});
 assert.equal((await api('/work/chats/'+taught.id+'/memory','GET',undefined,'bob')).status,404);checks++;
 const taughtSchedule=store.list('schedule','alice').find(x=>x.chatId===taught.id);store.remove('schedule','alice',taughtSchedule.id);
 const c=await chat(),requestId=randomUUID();
 const input={conversationId:c.id,background:true,message:'AUTOMATE_FIXTURE',model:'openai/fixture',requestId};
 const posted=await api('/chat','POST',input);assert.equal(posted.status,202);const jobId=posted.data.job.id;
 const duplicate=await api('/chat','POST',input);assert.equal(duplicate.data.job.id,jobId);
 const complete=await terminal(jobId);
 ok('HTTP background agent creates its own agent and schedule with verified read-back',()=>{assert.equal(complete.status,'completed',JSON.stringify(complete));assert(store.list('chat','alice').some(c=>c.title==='Fixture research agent'));assert.equal(store.list('schedule','alice').filter(s=>s.title==='Fixture weekly review').length,1);});
 ok('duplicate HTTP request returns same job; prompt is not exposed in status',()=>{assert.equal(duplicate.data.job.id,jobId);assert(!('prompt' in complete));assert(!('fingerprint' in complete));});
 assert.equal((await api('/chat','POST',{...input,message:'different input'})).status,400);checks++;
 assert.equal((await api('/work/jobs/'+jobId,'GET',undefined,'bob')).status,404);assert.equal((await api('/work/jobs/'+jobId+'/cancel','POST',{},'bob')).status,404);checks++;
 const checkpoints=(await api('/work/chats/'+c.id+'/verification')).data.checkpoints;
 ok('owner-scoped task plan and evidence checkpoints persist',()=>{assert.equal(checkpoints[0].status,'completed');assert(checkpoints[0].receipts.length>=6);assert.equal(store.list('task_plan','alice')[0].objective,'Fixture agent and schedule');assert.equal(store.list('task_plan','bob').length,0);assert.deepEqual(store.list('task_plan','alice')[0].completedSteps,[0,1,2]);assert.equal(store.list('task_plan','alice')[0].nextStep,3);});
 const originalHistory=JSON.stringify(store.messages('alice',c.id));store.closeStore();
 ok('store reopen retains jobs, conversations, agents, schedules and verification',()=>{assert.equal(store.get('job','alice',jobId).status,'completed');assert.equal(JSON.stringify(store.messages('alice',c.id)),originalHistory);assert.equal(store.list('schedule','alice').length,1);assert(store.list('verification','alice').length);});
 const delegated=await chat('chat');await runtime.runChat('alice',delegated,'Monte Carlo',{workDelegated:true,modelOverride:'openai/fixture'});
 ok('delegated runs cannot enable login consent, schedule, or spawn additional agents',()=>{assert(!store.get('chat','alice',delegated.id).allowChatCredentials);const names=calls.at(-1).tools.map(t=>t.function.name);assert(!names.includes('agent_team'));assert(!names.includes('schedule_agent'));assert.equal(store.messages('alice',delegated.id)[0].origin,'delegated');});
 const consent=await chat('chat');let before=calls.length;
 const on=await api('/chat','POST',{conversationId:consent.id,message:'Monte Carlo',model:'openai/fixture'});
 ok('chat-password consent still enables without a model round trip',()=>{assert(on.data.text.includes('Credential access is unlocked'));assert.equal(calls.length,before);assert.equal(store.get('chat','alice',consent.id).allowChatCredentials,true);});
 await api('/chat','POST',{conversationId:consent.id,message:'Discuss login',model:'anthropic/fixture'});
 ok('model switch preserves chat credential consent',()=>assert(JSON.stringify(calls.at(-1).messages[0]).includes('credential mode is ENABLED')));
 const explanation=await api('/chat','POST',{conversationId:c.id,message:'Why did you ask for verification? Are two tabs a problem?',model:'openai/fixture'});
 ok('ordinary Work conversation is not replaced by a verification warning',()=>{assert.equal(explanation.data.text,'A conversational fixture answer.');assert(!explanation.data.needsAttention);});
 assert(!JSON.stringify(calls.at(-1)).match(/monte\s+carlo/i));
 const note=await chat();const beforeNote=calls.length;
 const ack=await runtime.runChat('alice',note,'Reply with a short acknowledgement. Do not call tools, create tasks, or send messages.',{actorId:'alice',workDelegated:true,modelOverride:'openai/fixture'});
 ok('delegated acknowledgement does not force tools from negated instructions',()=>{assert.equal(calls.length-beforeNote,1);assert.equal(ack.toolRounds,0);assert.equal(ack.needsVerification,false);assert.equal(ack.speech,'A conversational fixture answer.');assert(JSON.stringify(calls.at(-1)).includes('authorized chat relay'));});

 const lie=await api('/chat','POST',{conversationId:c.id,message:'UNSUPPORTED_FIXTURE',model:'openai/fixture'});
 ok('unsupported completion claim is replaced with needs-verification',()=>{assert.equal(lie.data.needsAttention,true);assert(!lie.data.text.includes('verified every listing'));});
 const repeat=await chat();await api('/chat','POST',{conversationId:repeat.id,message:'REPEAT_FIXTURE',model:'openai/fixture'});
 ok('repeated create executes once',()=>assert.equal(store.list('schedule','alice').filter(s=>s.title==='One only').length,1));
 const slow=await chat('chat');await api('/conversations/'+slow.id,'PATCH',{model:'openai/fixture'});const queued=await api('/chat','POST',{conversationId:slow.id,background:true,requestId:randomUUID(),message:'SLOW_FIXTURE',model:'openai/fixture'});
 await slowReady;
 ok('HTTP response ends while job continues independently',()=>assert.equal(store.get('job','alice',queued.data.job.id).status,'running'));
 if(process.env.PW_CHROMIUM){
  const {chromium}=await import('playwright');const browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM});
  try{
   const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base.replace('/api/harvey','')+'/harvey.html?token=fixture&chat='+slow.id);
   await page.locator('#sendBtn[aria-label="Stop generating"]').waitFor({timeout:10000});
   await page.reload();await page.locator('#sendBtn[aria-label="Stop generating"]').waitFor({timeout:10000});
   assert.equal(store.get('job','alice',queued.data.job.id).status,'running');
   await page.locator('#newChatIcon').click();
   await page.locator('#modelPill').click();await page.locator('[data-model="openai/fixture-two"]').click();
   await page.locator('#input').fill('A separate conversation');await page.locator('#sendBtn').click();
   await page.getByText('A conversational fixture answer.',{exact:true}).waitFor();
   const second=store.list('chat','alice').find(x=>x.model==='openai/fixture-two');assert(second);
   assert.equal(store.get('chat','alice',slow.id).model,'openai/fixture');
   assert.equal(store.get('job','alice',queued.data.job.id).model,'openai/fixture');
   assert.equal(store.get('job','alice',queued.data.job.id).status,'running');
   await page.locator('[data-conv="'+slow.id+'"] .title').click();
   await page.locator('#sendBtn[aria-label="Stop generating"]').waitFor();assert.equal(await page.locator('#modelPillLabel').textContent(),'Fixture One');
   checks++;console.log('ok switching chats permits concurrent work and preserves independent saved models');
   await page.locator('#sendBtn').click();await page.getByText('Stop requested.',{exact:false}).waitFor({timeout:10000});
   assert.equal(store.get('job','alice',queued.data.job.id).status,'cancelling');assert.deepEqual(errors,[]);
   checks++;console.log('ok real chat UI reattaches after refresh and explicitly cancels the stored job');
   await page.locator('#newChatIcon').click();await page.locator('#input').fill('DETACHED_FIXTURE');
   const accepted=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/api/harvey/chat')&&r.request().method()==='POST');await page.locator('#sendBtn').click();
   const detached=(await (await accepted).json()).job;
   await page.locator('[data-conv="'+second.id+'"] .title').click();
   const done=await terminal(detached.id);assert.equal(done.status,'completed');
   assert.equal(await page.getByText('Detached fixture completed.',{exact:true}).count(),0);
   await page.reload();await page.getByText('A conversational fixture answer.',{exact:true}).waitFor();assert.equal(await page.locator('#modelPillLabel').textContent(),'Fixture Two');
   await page.locator('[data-conv="'+detached.chatId+'"] .title').click();await page.getByText('Detached fixture completed.',{exact:true}).waitFor();
   checks++;console.log('ok detached job finishes in cloud, never renders in another chat, and its result survives refresh');
   const paused=store.createSchedule('alice',{chatId:slow.id,title:'Failure pause fixture',prompt:'Fixture only',cron:'0 9 * * *',timezone:'America/Chicago'});store.put('schedule','alice',{...paused,enabled:false,pauseReason:'Repeated runs need attention; inspect before resuming.'});
   await page.getByRole('button',{name:'Explore models',exact:true}).click();
   await page.getByText('Choose a model for the job',{exact:true}).waitFor();
   assert.match(await page.locator('#modelsBody').innerText(),/0.0140/);assert.match(await page.locator('#modelsBody').innerText(),/2.0 seconds/);assert.match(await page.locator('#modelsBody').innerText(),/Estimated price/);
   await page.locator('[data-advice-model="openai/fixture"]').first().click();assert.equal(await page.locator('#modelPillLabel').textContent(),'Fixture One');
   checks++;console.log('ok onboarding guide renders real costs, measured timing and model selection');
   await page.getByRole('button',{name:'Scheduled',exact:true}).click();await page.getByText('Repeated runs need attention; inspect before resuming.',{exact:true}).waitFor({timeout:10000});checks++;console.log('ok paused schedule explains why it stopped in the real UI');
   store.remove('schedule','alice',paused.id);
   const removed=store.createChat('alice',{title:'Remote deletion fixture'});
   const other=await browser.newPage();
   await other.goto(base.replace('/api/harvey','')+'/harvey.html?token=fixture&chat='+removed.id);
   await other.waitForFunction(id=>new URL(location.href).searchParams.get('chat')===id,removed.id);
   await other.locator('#input').fill('Keep my unsent draft');
   const deleted=await api('/conversations/'+removed.id,'DELETE');assert.equal(deleted.status,200);
   await other.evaluate(()=>window.dispatchEvent(new Event('focus')));
   await other.waitForFunction(()=>!new URL(location.href).searchParams.get('chat'));
   assert.equal(await other.locator('#input').inputValue(),'Keep my unsent draft');
   assert.equal(await other.locator('[data-conv="'+removed.id+'"]').count(),0);
   await other.close();checks++;console.log('ok remote chat deletion clears another live session and preserves its unsent draft');

  }finally{await browser.close();}
 }
 assert.equal((await api('/conversations/'+slow.id,'DELETE')).status,400);checks++;
 assert.equal((await api('/conversations/'+slow.id,'PATCH',{projectId:null})).status,400);checks++;
 const cancelled=await api('/work/jobs/'+queued.data.job.id+'/cancel','POST',{});assert.equal(cancelled.data.status,'cancelling');releaseSlow();
 const stopped=await terminal(queued.data.job.id);
 ok('explicit cancellation is separate from connection loss and reports uncertain outcomes',()=>assert.equal(stopped.status,'needs_attention'));
 const transient=await chat();const recoveredProvider=await api('/chat','POST',{conversationId:transient.id,message:'TRANSIENT_FIXTURE',model:'openai/fixture'});
 ok('transient model failure retries the same model request without replaying tools',()=>{assert.equal(transientCalls,2);assert.equal(recoveredProvider.data.text,'Transient provider recovered.');});
 const repair=await chat();const repaired=await api('/chat','POST',{conversationId:repair.id,message:'RECOVERY_FIXTURE',model:'openai/fixture'});
 ok('a recovered tool failure with verified read-back is successful without robotic status banners',()=>{assert.equal(repaired.data.needsAttention,false,JSON.stringify(repaired.data));assert.equal(repaired.data.text,'The corrected schedule is saved.');});
 const frozenChat=store.createChat('alice',{model:'openai/fixture'});
 const frozen=jobs.enqueueJob('alice',frozenChat.id,{message:'Snapshot model',requestId:randomUUID()});store.put('chat','alice',{...frozenChat,model:'openai/fixture-two'});
 let frozenModel;await jobs.executeJob('alice',frozen.id,async(_o,_c,_m,opts)=>{frozenModel=opts.modelOverride;return {speech:'ok'};});
 ok('queued job pins its model even if that chat preference subsequently changes',()=>assert.equal(frozenModel,'openai/fixture'));
 const auto=jobs.enqueueJob('alice',frozenChat.id,{message:'Explicit auto',model:'auto',requestId:randomUUID()});
 await jobs.executeJob('alice',auto.id,async(_o,_c,_m,opts)=>{assert.equal(opts.modelOverride,'auto');return {speech:'ok'};});
 const foreign=store.createChat('bob',{});store.put('job','bob',{...frozen,id:'other-owner-job',chatId:foreign.id,status:'running'});
 process.env.TENANT_OWNER_ID='alice';jobs.recoverJobs();delete process.env.TENANT_OWNER_ID;
 ok('one account worker restarting does not interrupt another account’s jobs',()=>assert.equal(store.get('job','bob','other-owner-job').status,'running'));
 const preserved=JSON.stringify(store.messages('alice',c.id));
 store.put('job','alice',{...store.get('job','alice',jobId),id:'restart-fixture',status:'running'});jobs.recoverJobs();
 ok('restart never blindly replays uncertain work or deletes prior history',()=>{assert.equal(store.get('job','alice','restart-fixture').status,'needs_attention');assert.equal(JSON.stringify(store.messages('alice',c.id)),preserved);});
 const scheduled=store.list('schedule','alice')[0];
 const unverified=await runtime.runScheduled('alice',scheduled.id,true,new Date(),async()=>({speech:'Everything is done',toolFailed:false}));
 ok('scheduled success requires structured verification, not optimistic prose',()=>assert.equal(unverified.status,'needs_attention'));
 console.log(checks+' reliability and endpoint checks passed; only local model/server fixtures were contacted.');
}finally{releaseSlow();await new Promise(r=>server.close(r));await new Promise(r=>model.close(r));store.closeStore();}
