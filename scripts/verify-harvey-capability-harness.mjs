// Small end-to-end harness flows against a local provider. No paid calls/customer apps.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import http from 'node:http';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'harvey-harness-'));
for(const key of Object.keys(process.env))if(/API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|COMPOSIO|TENANT_OWNER_ID|DB_JSON_PATH/.test(key))delete process.env[key];
Object.assign(process.env,{ACCOUNT_ISOLATION:'false',TENANT_DATA_ROOT:dir,HARVEY_WORK_DIR:join(dir,'work'),AI_USAGE_DB_PATH:join(dir,'usage.db'),SHARED_OPENROUTER_BUDGET_DB_PATH:join(dir,'budget.db'),HARVEY_BROWSER_ENABLED:'false',HARVEY_WORKER_ENABLED:'false',DOTENV_CONFIG_PATH:join(dir,'missing')});
const originalFetch=global.fetch;
global.fetch=(url,...args)=>{const u=new URL(typeof url==='string'?url:url.url||String(url));assert(['localhost','127.0.0.1'].includes(u.hostname),'External call refused');return originalFetch(url,...args);};
let mode='',round=0,visionCalls=0,mainCalls=0,mainModel='inception/mercury-2.5',visionReply;
const tc=(name,input)=>({role:'assistant',content:'',tool_calls:[{id:'call-'+round,type:'function',function:{name,arguments:JSON.stringify(input)}}]});
const server=http.createServer(async(req,res)=>{
 if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[]}));return;}
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);let message;
 if(!body.tools?.length&&body.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='image_url'))){visionCalls++;message={role:'assistant',content:JSON.stringify({summary:'The fixture Save button is visible.',data:{control:{label:'Save',x:20,y:30},rows:[{id:'fixture-one',name:'Fixture Person'}]}})};}
 else{
  mainCalls++;const n=round++;
  if(mode==='visual'){
   assert.equal(body.model,mainModel,'The main model must stay pinned');
   const steps=[['inspect_screen',{question:'Locate the visible fixture Save button'}],['computer',{action:'call',tool:'browser_mouse_click_xy',arguments:{x:20,y:30}}],['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['report_verification',{status:'completed',evidenceIds:['e4'],checks:['Read back saved fixture state after click'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Saved and checked.'};
  }else if(mode==='stagnant'){
   if(n===8)assert(body.messages.some(m=>String(m.content).includes('UNCHANGED OBSERVATIONS')),'Repeated identical observations must trigger a strategy change');
   message=n<9?tc('computer',{action:'call',tool:n===8?'browser_read_table':'browser_read_snapshot',arguments:n===8?{}:{offset:n*100}}):n===9?tc('report_verification',{status:'completed',evidenceIds:['e9'],checks:['Changed route and read actual fixture records'],limitations:[]}):{role:'assistant',content:'Retrieved records through another observation route.'};
  }else if(mode==='vision_stress'){
   if(n===0||n===2)message=tc('inspect_screen',{question:'Read the fixture rows',structured:true});
   else if(n===1)message=tc('computer',{action:'call',tool:'browser_mouse_click_xy',arguments:{x:20,y:30}});
   else message={role:'assistant',content:'Visual observation remains unavailable; no action was verified.'};
  }else if(mode==='recovery'){
   if(n===0)message={role:'assistant',content:"I cannot extract virtualized table data."};
   else{assert(body.messages.some(m=>String(m.content).includes('CAPABILITY RECOVERY')));const steps=[['capabilities',{}],['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['report_verification',{status:'completed',evidenceIds:['e2'],checks:['Read fixture records'],limitations:[]}]];message=n<=steps.length?tc(...steps[n-1]):{role:'assistant',content:'Read the records using the available route.'};}
  }else if(mode==='visual_fields'){
   const steps=[['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['inspect_screen',{question:'Read the visible profile name into data.rows',structured:true}],['work_records',{action:'save',collection:'visual-profiles',records:[{evidenceId:'e3',idPath:'/sourcePage',fieldPaths:{Name:'/data/rows/0/name'}}]}],['work_records',{action:'list',collection:'visual-profiles'}],['report_verification',{status:'completed',evidenceIds:['e3','e5'],checks:['Read back visual field saved under observed profile URL'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Saved the observed visual profile.'};
  }else if(mode==='profiles'){
   const steps=[['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['computer',{action:'call',tool:'browser_click',arguments:{target:'#notes'}}],['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['computer',{action:'call',tool:'browser_click',arguments:{target:'#notes'}}],['computer',{action:'call',tool:'browser_navigate',arguments:{url:'https://fixture.invalid/people/2'}}],['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['computer',{action:'call',tool:'browser_click',arguments:{target:'#notes'}}],['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['report_verification',{status:'completed',evidenceIds:['e8'],checks:['Different profile read back; same-page repeat refused'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Inspected both profiles.'};
  }else if(mode==='learn'){
   const steps=[['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['report_verification',{status:'completed',evidenceIds:['e1'],checks:['Observed fixture record'],limitations:[]}],['workflow',{action:'learn',name:'Inspect fixture record',steps:['Inspect the selected page and read its record'],checks:['Read the current record identifier'],prerequisites:['Authorized selected browser']}],['workflow',{action:'list'}],['report_verification',{status:'completed',evidenceIds:['e1','e3'],checks:['Read saved procedure'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Retained the verified method.'};
  }else if(mode==='resume'){
   message=n===0?tc('task_plan',{action:'get'}):n===1?tc('report_verification',{status:'blocked',evidenceIds:[],checks:['Previous approval still needs inspection'],limitations:['No connected browser in this fixture']}):{role:'assistant',content:'The browser is disabled in this fixture; no site action ran.'};
  }else if(mode==='contract'){
   const steps=[['task_plan',{action:'save',objective:'Export two fixture records',steps:['Read records','Deliver file'],successCriteria:['Two unique records'],requiredSources:['fixture'],contract:{count:2,collection:'profiles',fields:['name'],exclusions:['Mojo FL'],destination:'CSV'}}],['task_plan',{action:'checkpoint',completedSteps:[0,1],nextStep:2}],['report_verification',{status:'completed',evidenceIds:['e1'],checks:['Attempted completion'],limitations:[]}],['report_verification',{status:'needs_verification',evidenceIds:[],checks:['Saved count was checked'],limitations:['Two requested profiles have not been saved']}]];
   if(n===1)message=tc('task_plan',{action:'save',objective:'Export two fixture records',steps:['Read records','Deliver file'],successCriteria:['Two unique records'],requiredSources:['fixture'],contract:{destination:'Google Sheets'}});
   else message=(n>1?n-1:n)<steps.length?tc(...steps[n>1?n-1:n]):{role:'assistant',content:'The two profiles are still missing.'};
  }else throw Error('Unknown fixture');
 }
 if(visionReply!==undefined&&!body.tools?.length){message={role:'assistant',content:visionReply};}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',model:body.model,choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,cost:0}}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
Object.assign(process.env,{OPENROUTER_API_KEY:'local-fixture',OPENROUTER_BASE_URL:'http://127.0.0.1:'+server.address().port});
const root=resolve('dist/src'),{runAgentLoop}=require(join(root,'hull/agentLoop.js'));
const store=require(join(root,'harvey/work/store.js')),runtime=require(join(root,'harvey/work/runtime.js'));
const learning=require(join(root,'harvey/work/learning.js')),execution=require(join(root,'harvey/work/execution.js'));
const records=require(join(root,'harvey/work/records.js'));
const caps=require(join(root,'harvey/work/capabilities.js')),failure=require(join(root,'harvey/toolFailures.js'));
const tools=runtime.WORK_TOOLS.filter(t=>['computer','inspect_screen','capabilities'].includes(t.name));
try{
 mode='visual';round=0;let clicks=0;const events=[];
 const visual=await runAgentLoop({message:'Inspect fixture and save',modelOverride:'inception/mercury-2.5',allowContinuation:true,workRuntime:{tools,context:'Isolated fixture',execute:async(name,input)=>{
  assert.equal(name,'computer');if(input.tool==='browser_take_screenshot')return {_image:{media_type:'image/png',data:'fixture-image-bytes'}};
  if(input.tool==='browser_mouse_click_xy'){clicks++;return {clicked:true};}return {saved:true};
 }},onEvent:e=>events.push(e)});
 assert.equal(clicks,1);assert.equal(visionCalls,1);assert.equal(visual.verification.status,'completed');assert.equal(visual.costUsd,0);assert(events.some(e=>e.type==='usage'&&e.model!=='inception/mercury-2.5'));
 console.log('ok text-only main model uses separate vision, acts once and reads back; auxiliary usage counted');
 mode='visual';round=0;mainModel='anthropic/claude-sonnet-4.6';
 const native=await runAgentLoop({message:'Inspect native fixture',modelOverride:mainModel,allowContinuation:true,workRuntime:{tools,context:'Fixture',execute:async(_name,input)=>input.tool==='browser_take_screenshot'?{_image:{media_type:'image/png',data:'fixture-native-image'}}:{saved:true}}});
 assert.equal(native.verification.status,'completed');assert.equal(visionCalls,1,'Native model must not pay for an auxiliary vision call');
 console.log('ok native vision uses the same inspection tool without an extra model call');
 mainModel='inception/mercury-2.5';
 for(const reply of ['not JSON','{"summary":"partial","data":', '[]','{"summary":"missing data"}','{"summary":"wrong shape","data":[]}']){
  mode='vision_stress';round=0;visionReply=reply;let unsafeClicks=0;const seen=[];const start=visionCalls;
  await runAgentLoop({message:'Inspect the fixture rows; do not claim success',modelOverride:mainModel,workRuntime:{tools,context:'Fixture',execute:async(_name,input)=>{if(input.tool==='browser_take_screenshot')return {_image:{media_type:'image/png',data:'same-stress-pixels'}};unsafeClicks++;return {clicked:true};}},onEvidence:r=>seen.push(r)});
  assert.equal(unsafeClicks,0,'Invalid helper output must not enable coordinate actions');
  assert.equal(visionCalls-start,2,'Failed visual output must not enter the successful cache');
  assert.equal(seen.filter(r=>r.tool==='inspect_screen'&&r.outcome==='failed').length,2,'Record actual visual failures');
 }
 visionReply=undefined;
 console.log('ok malformed/truncated/wrong-shaped visual results fail explicitly, stay uncached and cannot unlock coordinate actions');
 mode='profiles';round=0;let profile='1',profileClicks=0;
 const profiles=await runAgentLoop({message:'Read profile notes',modelOverride:'inception/mercury-2.5',workRuntime:{tools,context:'Fixture',execute:async(_name,input)=>{if(input.tool==='browser_navigate')profile='2';if(input.tool==='browser_click')profileClicks++;return {url:'https://fixture.invalid/people/'+profile,notes:'Observed fixture notes'};}}});
 assert.equal(profileClicks,2);assert.equal(profiles.verification.status,'completed');
 const locationProof=new (require(join(root,'harvey/reliability.js')).TurnVerification)();
 locationProof.record('computer',{action:'call',tool:'browser_snapshot'},{url:'https://fixture.invalid/people/1?tab=details'});const before=locationProof.browserLocation();
 locationProof.record('computer',{action:'call',tool:'browser_snapshot'},{url:'https://fixture.invalid/people/1?tab=notes#changed'});assert.equal(locationProof.browserLocation(),before,'Query/hash changes must not permit a duplicate write');
 console.log('ok identical profile controls work across observed URLs while same-page replay stays refused');
 mode='recovery';round=0;let discovered=false;
 const recovered=await runAgentLoop({message:'Extract fixture records',modelOverride:'inception/mercury-2.5',allowContinuation:true,workRuntime:{tools,context:'Fixture',execute:async(name)=>{if(name==='capabilities'){discovered=true;return {routes:['semantic snapshot']};}assert(discovered);return {records:[{id:'one'}]};}}});
 assert.equal(recovered.verification.status,'completed');console.log('ok unsupported capability claim triggers route discovery and successful recovery');
 mode='stagnant';round=0;let reads=0;
 const unstuck=await runAgentLoop({message:'Extract fixture records',modelOverride:mainModel,allowContinuation:true,workRuntime:{tools,context:'Fixture',execute:async(_name,input)=>input.tool==='browser_read_table'?{rows:[{id:'actual-row'}]}:{headers:['Name'],rows:[],observationId:'volatile-'+(++reads),capturedAt:new Date().toISOString()}}});
 assert.equal(reads,8);assert.equal(unstuck.verification.status,'completed');assert(!unstuck.continuation);
 console.log('ok repeated unchanged observations trigger a different route without a task cutoff or another user continue');
 mode='resume';round=0;const chat=store.createChat('fixture',{});
 store.put('task_plan','fixture',{id:'retained',chatId:chat.id,requestId:'old',steps:['Read','Deliver'],nextStep:0,blocker:'CAPTCHA requires user approval',contract:{count:20,exclusions:['Mojo FL'],destination:'Google Sheets'}});
 await runtime.runChat('fixture',chat,'yes, do it',{allowContinuation:true,workRequestId:'new',modelOverride:'inception/mercury-2.5'});
 const p=store.get('task_plan','fixture','retained');assert.equal(p.requestId,'new');assert.equal(p.blocker,'');assert.match(p.lastBlocker,/CAPTCHA/);assert.equal(p.contract.count,20);
 for(const text of ['yes, do it','Google Sheets is connected now','I authorized Google Sheets','Authorize Google Sheets, then do whatever you can','well just time it correctly and try again'])assert(execution.taskFollowup(text));
 assert(!execution.taskFollowup('Are Google Sheets connected?'));assert(!execution.taskFollowup('stop'));assert(!execution.taskFollowup('just explain the plan'));
 console.log('ok follow-up retains exact contract and rechecks historical blockers without bypassing security');
 mode='visual_fields';round=0;
 const savedVisual=await runAgentLoop({message:'Read visual profile fields',modelOverride:'inception/mercury-2.5',workRuntime:{tools:[...tools,...runtime.WORK_TOOLS.filter(t=>t.name==='work_records')],context:'Fixture',execute:async(name,input)=>name==='work_records'?records.workRecords('fixture',chat.id,input):input.tool==='browser_take_screenshot'?{_image:{media_type:'image/png',data:'fixture-profile-pixels'}}:{url:'https://fixture.invalid/people/42?token=secret'}}});
 assert.equal(savedVisual.verification.status,'completed');const visualRecord=records.workRecords('fixture',chat.id,{action:'list',collection:'visual-profiles'}).items[0];assert.equal(visualRecord.key,'https://fixture.invalid/people/42');assert.equal(visualRecord.fields.Name,'Fixture Person');assert(!JSON.stringify(visualRecord).includes('secret'));
 console.log('ok structured visual fields persist under the observed profile path without inventing IDs or retaining URL tokens');
 mode='contract';round=0;const other=store.createChat('fixture',{});
 const incomplete=await runtime.runChat('fixture',other,'Export two fixture records',{modelOverride:'inception/mercury-2.5'});
 const retainedContract=store.list('task_plan','fixture').find(p=>p.chatId===other.id).contract;
 assert.equal(retainedContract.count,2,'Partial contract updates must retain the requested count');assert.equal(retainedContract.collection,'profiles');assert.deepEqual(retainedContract.exclusions,['Mojo FL']);assert.equal(retainedContract.destination,'Google Sheets');
 assert.notEqual(incomplete.verification.status,'completed');assert.equal(store.list('work_record','fixture').filter(r=>r.chatId===other.id).length,0);
 console.log('ok model cannot mark missing contracted records complete');
 const history=learning.boundedHistory([{role:'user',content:'Exclude Mojo FL; Google Sheets; 20 profiles'},{role:'assistant',content:'x'.repeat(40000)},{role:'user',content:'yes do it'}]);
 assert(history.messages.some(m=>m.content.includes('Exclude Mojo FL')));
 const map=caps.capabilityMap({local:false,browser:true,managed:true,connectionError:'discovery failed',apps:[],custom:[],tools:['computer','inspect_screen','COMPOSIO_SEARCH_TOOLS','work_records']});
 assert.equal(map.routes[2].state,'unknown');assert(map.routes[0].available);
 assert.equal(failure.toolFailure('computer',{tool:'browser_snapshot'},{error:{message:'Timed out waiting for selector'}}).code,'timeout');
 assert.throws(()=>learning.learnWorkflow('fixture',chat.id,{name:'fake'}),/evidence/);
 console.log('ok context preserves instructions, unknown connection state is explicit, nested errors are diagnosed, unproven procedures rejected');
 mode='learn';round=0;
 const learned=await runAgentLoop({message:'Retain a verified method',modelOverride:'inception/mercury-2.5',workRuntime:{context:'Fixture',tools:[...tools,...runtime.WORK_TOOLS.filter(t=>t.name==='workflow')],execute:async(name,input)=>name==='workflow'?input.action==='learn'?learning.learnWorkflow('fixture',chat.id,input):{workflows:learning.workflows('fixture',chat.id)}:{id:'observed-fixture-record'}}});
 assert.equal(learned.verification.status,'completed');assert.equal(learning.workflows('fixture',chat.id)[0].basis,'verified_execution_require_current_prerequisites');assert.equal(learning.workflows('other-owner',store.createChat('other-owner',{}).id).length,0);
 console.log('ok a completed observed procedure is retained and read back without crossing owners');
 console.log(`PASS ${mainCalls} local model calls, ${visionCalls} local vision calls; $0 provider spend; no customer data accessed`);
}finally{global.fetch=originalFetch;store.closeStore();server.closeAllConnections();await new Promise(r=>server.close(r));}
