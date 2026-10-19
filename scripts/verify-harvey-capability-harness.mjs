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
let mode='',round=0,visionCalls=0,mainCalls=0,mainModel='inception/mercury-2.5',visionReply,recoveryReviews=0,reviewBaseline=0,outcomeReviews=0;
const tc=(name,input)=>({role:'assistant',content:'',tool_calls:[{id:'call-'+round,type:'function',function:{name,arguments:JSON.stringify(input)}}]});
const server=http.createServer(async(req,res)=>{
 if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[]}));return;}
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);let message;
 if(body.tools?.length===1&&body.tools[0].function.name==='submit_outcome_review'&&body.messages.some(m=>typeof m.content==='string'&&m.content.includes('OUTCOME AUDIT'))){outcomeReviews++;const data=JSON.parse(body.messages.find(m=>m.role==='user').content),saved=data.evidence.filter(e=>e.tool==='workspace_read'&&e.data.file==='selection.json').at(-1)?.data.content;assert.equal(body.tool_choice.function.name,'submit_outcome_review');message=tc('submit_outcome_review',{passed:mode!=='outcome_audit'||saved==='["one","two"]',issues:mode!=='outcome_audit'||saved==='["one","two"]'?[]:['The saved selection contains an unobserved record. Replace it with the actual first two observed IDs, one and two.']});}
 else if(!body.tools?.length&&body.messages.some(m=>typeof m.content==='string'&&m.content.includes('READ-ONLY RECOVERY REVIEW'))){recoveryReviews++;message={role:'assistant',content:'Inspect the current state using available tools. Use automaticEvidence:true for completion and keep the original scope; do not replay a write.'};}
 else if(!body.tools?.length&&body.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='image_url'))){visionCalls++;message={role:'assistant',content:JSON.stringify({summary:'The fixture Save button is visible.',data:{control:{label:'Save',x:20,y:30},rows:[{id:'fixture-one',name:'Fixture Person'}]}})};}
 else{
  mainCalls++;const n=round++;
  if(mode==='native_revision'){
   const steps=[['workspace_read',{file:'revision.md'}],['workspace_write',{file:'revision.md',content:'Updated from observed version'}],['workspace_read',{file:'revision.md'}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Runtime used actual observed version for safe replacement and read final content'],limitations:[]}]];message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Updated and verified.'};
  }else if(mode==='source_order'){

   const steps=[['computer',{action:'call',tool:'browser_read_table',arguments:{}}],['work_records',{action:'save',collection:'ordered-proof',records:[1,0].map(i=>({evidenceId:'e1',idPath:'/rows/'+i+'/id',fieldPaths:{name:'/rows/'+i+'/name'}}))}],['work_records',{action:'export',collection:'ordered-proof',file:'ordered.csv',includeSourceId:false}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Attempted without source-bound export'],limitations:[]}],['work_records',{action:'export',collection:'ordered-proof',file:'ordered.csv',includeSourceId:false,orderFrom:{evidenceId:'e4',path:'/rows',keyPath:'/id',count:2}}],['workspace_read',{file:'ordered.csv'}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Native export follows observed first two source rows despite reverse saved insertion'],limitations:[]}]];
   if(n===3)assert.match(JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content).error,/orderFrom/);
   if(n===4)assert.equal(JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content).sourceOrder.evidenceId,'e4');
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Exported the exact source order.'};
  }else if(mode==='format_progress'){

   message=[0,2,4].includes(n)?{role:'assistant',content:''}:n<6?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{}}):n===6?tc('report_verification',{status:'completed',automaticEvidence:true,checks:['Recovered separate formatting failures after successful observations'],limitations:[]}):{role:'assistant',content:'Verified after recovered responses.'};
  }else if(mode==='unavailable'){
   const steps=[['unavailable_fixture_tool',{action:'write'}],['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['report_verification',{status:'completed',automaticEvidence:true,checks:['The unavailable operation never ran; the supported source was read'],limitations:[]}]];
   if(n===1){const r=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.equal(r._harveyEvidence.actionOutcome,'not_executed');}
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Recovered with the actual available capability.'};
  }else if(mode==='revisit'){
   message=n<6?tc('computer',{action:'call',tool:n%2?'browser_snapshot':'browser_navigate',arguments:n%2?{}:{url:'https://fixture.invalid/list'}}):n===6?tc('report_verification',{status:'completed',automaticEvidence:true,checks:['Revisited and observed the same source page three times without replaying any form submission'],limitations:[]}):{role:'assistant',content:'Verified revisited page.'};
  }else if(mode==='deliverable'){
   const steps=[['workspace_write',{file:'delivered.md',content:'Real saved report'}],['workspace_read',{file:'delivered.md'}],['task_plan',{action:'checkpoint',completedSteps:[0,1],nextStep:2}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Saved and read the requested report'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Saved the report.'};
  }else if(mode==='outcome_audit'){
   const reads=body.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return {};}}),hash=reads.findLast(m=>m.file==='selection.json'&&m.sha256)?.sha256;
   const steps=[['computer',{action:'call',tool:'browser_read_table',arguments:{}}],['workspace_write',{file:'selection.json',content:'["wrong"]'}],['workspace_read',{file:'selection.json'}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Attempted incorrect final selection'],limitations:[]}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Same unsupported selection again'],limitations:[]}],['workspace_write',{file:'selection.json',content:'["one","two"]',expectedSha256:hash}],['workspace_read',{file:'selection.json'}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Saved selection matches the first two observed IDs'],limitations:[]}]];
   if(n===4||n===5){const failure=reads.at(-1);assert.match(failure.error,/outcome review/);}
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Corrected the source selection and verified the saved JSON.'};
  }else if(mode==='repeat_checkpoints'){
   const steps=[['workspace_write',{file:'repeat.md',content:'Verified literal text'}],['workspace_write',{file:'repeat.md',content:'Verified literal text'}],['task_plan',{action:'checkpoint',completedSteps:[0,1],nextStep:2}],['task_plan',{action:'checkpoint',completedSteps:[0,1],nextStep:2}],['workspace_read',{file:'repeat.md'}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Idempotent file and checkpoint operations retained exact state; actual saved file was read'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Verified repeat-safe local work.'};
  }else if(mode==='repeat_observations'){
   message=n<5?tc('workspace_read',{file:'same.csv'}):n===5?tc('report_verification',{status:'completed',automaticEvidence:true,checks:['Read the same saved file five times without a fabricated tool limitation'],limitations:[]}):{role:'assistant',content:'Verified file.'};
  }else if(mode==='history_contract'){
   const steps=[['workspace_sheet',{file:'history.xlsx'}],['computer',{action:'call',tool:'browser_navigate',arguments:{url:'https://fixture.invalid/person'}}],['computer',{action:'call',tool:'browser_read_form',arguments:{}}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Old populated notes are not sufficient'],limitations:[]}],['computer',{action:'call',tool:'browser_read_form',arguments:{},sourceValues:[{argumentPath:'/expected/0',evidenceId:'e1',path:'/rows/1/values/B'}]}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Actual reopened target contains distinct source history'],limitations:[]}]];
   if(n===4){const r=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.match(r.error,/Source history transfer is incomplete/);assert.equal(r.missing[0].cell,'B2');assert.equal(outcomeReviews,reviewBaseline,'A model reviewer cannot override a native missing-source gate');}
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Verified the saved history.'};
  }else if(mode==='invalid_source_date'){
   const steps=[['workspace_sheet',{file:'source.xlsx'}],['computer',{action:'call',tool:'browser_fill_form',arguments:{fields:[{name:'Task due date',type:'textbox',target:'input[type="date"]',value:''}]},sourceValues:[{argumentPath:'/fields/0/value',evidenceId:'e1',path:'/rows/0/values/A',format:'date_only'}]}],['report_verification',{status:'blocked',automaticEvidence:true,checks:['The source calendar date was checked before any field write'],limitations:['Source task date is invalid; no correction was authorized and no task was changed']}]];
   if(n===2){const reply=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.match(reply.error,/calendar date is invalid/);assert.equal(reply.recovery.actionOutcome,'not_executed');}
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'The source task date is invalid; no task was changed.'};
  }else if(mode==='source_bindings'){
   const steps=[['workspace_sheet',{file:'source.xlsx'}],['computer',{action:'call',tool:'browser_fill_form',arguments:{fields:[{name:'Notes',target:'textarea',value:'Wrong paraphrase'}]}}],['computer',{action:'call',tool:'browser_fill_form',arguments:{fields:[{name:'Notes',target:'textarea',value:''}]},sourceValues:[{argumentPath:'/fields/0/value',evidenceId:'e1',path:'/rows/0/values/C'}]}],['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['report_verification',{status:'completed',automaticEvidence:true,checks:['Exact source text copied; paraphrased attempt was rejected without changing fields; destination read back'],limitations:[]}]];
   if(n===2){const r=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.equal(r.recovery.actionOutcome,'not_executed');assert.match(r.error,/preserve exact source/);}
   if(n===3){const r=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.equal(r.sourceValueBindings[0].characters,'Exact source Ω 😀\nKeep every word.'.length);assert.match(r.sourceValueBindings[0].sha256,/^[a-f0-9]{64}$/);assert.match(r.sourceValueNote,/not saved-state proof/);}
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Copied exact history and checked the destination.'};
  }else if(mode==='visual'){
   assert.equal(body.model,mainModel,'The main model must stay pinned');
   const steps=[['inspect_screen',{question:'Locate the visible fixture Save button'}],['computer',{action:'call',tool:'browser_mouse_click_xy',arguments:{x:20,y:30}}],['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['report_verification',{status:'completed',evidenceIds:['e4'],checks:['Read back saved fixture state after click'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Saved and checked.'};
  }else if(mode==='rejected_review'){
   message=n===0?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{}}):n<5?tc('report_verification',{status:'completed',evidenceIds:['missing-'+n],checks:['Attempted unsupported completion'],limitations:[]}):{role:'assistant',content:'The task is complete.'};
  }else if(mode==='navigation_recovery'){
   const steps=[['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],['computer',{action:'call',tool:'browser_navigate',arguments:{url:'file:///private-sheet.csv'}}],['workspace_read',{file:'fixture.csv'}],['report_verification',{status:'completed',evidenceIds:['e1','e3'],checks:['Kept the authenticated page and read the attachment through its workspace tool; no browser navigation ran'],limitations:[]}]];
   if(n===2){const result=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.equal(result.recovery.actionOutcome,'not_executed');assert.match(result.error,/URL type/);}
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Read the attached sheet while retaining the existing signed-in browser.'};
  }else if(mode==='sheets'){
   const steps=[['workspace_sheet',{file:'source.xlsx'}],['workspace_sheet',{file:'source.xlsx',sheet:'Inputs',range:'A2:D3'}],['work_records',{action:'save',collection:'native-sheet',records:[0,1].map(i=>({evidenceId:'e2',idPath:'/rows/'+i+'/id',fieldPaths:{name:'/rows/'+i+'/values/A',notes:'/rows/'+i+'/values/B',due:'/rows/'+i+'/values/C',relationship:'/rows/'+i+'/values/D'}}))}],['work_records',{action:'list',collection:'native-sheet'}],['report_verification',{status:'completed',evidenceIds:['e2','e4'],checks:['Read both native source rows, retained observed notes/due dates/relationships, and verified two saved records'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Read and saved both source records without browser or connector workarounds.'};
  }else if(mode==='compact'){
   if(n===1){const result=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.equal(result._harveyEvidence.id,'e2');assert.equal(result._harveyEvidence.truncated,false);assert.equal(result.rows[0].title,'Full source title');}
   const steps=[['computer',{action:'call',tool:'browser_navigate',arguments:{url:'https://fixture.invalid/catalog'}}],['work_records',{action:'save',collection:'compact',records:[{evidenceId:'e2',idPath:'/rows/0/id',fieldPaths:{name:'/rows/0/title'}}]}],['work_records',{action:'list',collection:'compact'}],['report_verification',{status:'completed',evidenceIds:['e2','e4'],checks:['Saved full structured title instead of the shortened snapshot label'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Saved the full source title.'};
  }else if(mode==='compact_readback'){
   const steps=[['computer',{action:'call',tool:'browser_navigate',arguments:{url:'https://fixture.invalid/report'}}],['workspace_read',{file:'fixture.md'}],['report_verification',{status:'completed',evidenceIds:['e2'],checks:['Saved-file read alone does not verify browser state'],limitations:[]}],['report_verification',{status:'completed',evidenceIds:['e2','e5'],checks:['Reviewed compact current browser observation and saved-file content'],limitations:[]}]];
   if(n===3){const reply=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.equal(reply.currentObservation._harveyEvidence.id,'e5');assert.equal(reply.currentObservation._harveyEvidence.truncated,false);}
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Reviewed the compact current page and file.'};
  }else if(mode==='missing_readback'){
   const steps=[['computer',{action:'call',tool:'browser_navigate',arguments:{url:'https://fixture.invalid/report'}}],['workspace_read',{file:'fixture.md'}],['report_verification',{status:'completed',evidenceIds:['e2'],checks:['Attempted unrelated read-back'],limitations:[]}],['report_verification',{status:'completed',evidenceIds:['e2','e4'],checks:['Reviewed fresh selected-page observation and saved content'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Reviewed the page and saved content.'};
  }else if(mode==='forced_review'){
   if(n===2)assert.equal(body.tool_choice?.function?.name,'report_verification','Provider must receive an explicit verification tool choice');
   message=n===0?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{}}):n===2?tc('report_verification',{status:'completed',evidenceIds:['e1'],checks:['Observed fixture outcome'],limitations:[]}):{role:'assistant',content:'The observed fixture is complete.'};
  }else if(mode==='artifact'){
   const steps=[['workspace_write',{file:'fixture.json',content:'{"total":375}'}],['workspace_read',{file:'fixture.json'}],['report_verification',{status:'completed',evidenceIds:['e2'],checks:['Read back saved total 375'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Saved and read back the requested JSON.'};
  }else if(mode==='unverified'){
   message=n===0?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{}}):{role:'assistant',content:'Both actions completed successfully.'};
  }else if(mode==='invalid_projection'){
   message=n===0?tc('work_records',{action:'save',collection:'bad',records:[{evidenceId:'e999',idPath:'/id',fieldPaths:{name:'/name'}}]}):n===1?tc('report_verification',{status:'blocked',evidenceIds:[],checks:['Missing source reference is retained'],limitations:['No valid source receipt in this fixture']}):{role:'assistant',content:'The save had no valid source evidence.'};
  }else if(mode==='stagnant'){
   if(n===8)assert(body.messages.some(m=>String(m.content).includes('UNCHANGED OBSERVATIONS')),'Repeated identical observations must trigger a strategy change');
   message=n<9?tc('computer',{action:'call',tool:n===8?'browser_read_table':'browser_read_snapshot',arguments:n===8?{}:{offset:n*100}}):n===9?tc('report_verification',{status:'completed',evidenceIds:['e9'],checks:['Changed route and read actual fixture records'],limitations:[]}):{role:'assistant',content:'Retrieved records through another observation route.'};
  }else if(mode==='vision_stress'){
   if(n===0||n===2)message=tc('inspect_screen',{question:'Read the fixture rows',structured:true});
   else if(n===1)message=tc('computer',{action:'call',tool:'browser_mouse_click_xy',arguments:{x:20,y:30}});
   else message={role:'assistant',content:'Visual observation remains unavailable; no action was verified.'};
  }else if(mode==='final_review_recovery'){
   const previous=body.messages.filter(m=>m.role==='tool').at(-1);const accepted=previous&&/"accepted"\s*:\s*true/.test(String(previous.content));
   message=n===0?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{}}):n<4?tc('report_verification',{status:'completed',evidenceIds:['missing'+n],checks:['Attempted incorrect citation'],limitations:[]}):recoveryReviews===reviewBaseline?{role:'assistant',content:'The internal review remains unaccepted.'}:accepted?{role:'assistant',content:'Reviewed the actual current evidence.'}:tc('report_verification',{status:'completed',automaticEvidence:true,checks:['Reviewed actual current state after repairing citation bookkeeping'],limitations:[]});
  }else if(mode==='recovery_review'){
   message=n<9?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{target:'#phase'+n}}):n===9?tc('report_verification',{status:'completed',automaticEvidence:true,checks:['Read the current fixture after diagnosis without replaying writes'],limitations:[]}):{role:'assistant',content:'Recovered and checked the fixture.'};
  }else if(mode==='automatic_review'){
   message=n===0?tc('computer',{action:'call',tool:'browser_snapshot',arguments:{}}):n===1?tc('report_verification',{status:'completed',automaticEvidence:true,checks:['Reviewed the current fixture state'],limitations:[]}):{role:'assistant',content:'Reviewed actual state without guessing receipt IDs.'};
  }else if(mode==='recovery_episodes'){
   const steps=[['computer',{action:'call',tool:'browser_snapshot',arguments:{}}],...['#a','#b'].map(target=>['computer',{action:'call',tool:'browser_click',arguments:{target}}]),['computer',{action:'call',tool:'browser_snapshot',arguments:{target:'main'}}],...['#c','#d'].map(target=>['computer',{action:'call',tool:'browser_click',arguments:{target}}]),['computer',{action:'call',tool:'browser_snapshot',arguments:{target:'body'}}],...['#e','#f'].map(target=>['computer',{action:'call',tool:'browser_click',arguments:{target}}]),['computer',{action:'call',tool:'browser_snapshot',arguments:{target:'section'}}],['report_verification',{status:'completed',evidenceIds:['e12'],checks:['Read current state after two distinct recovery episodes; unchanged observations did not rearm recovery or replay writes'],limitations:[]}]];
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'Inspected the final fixture state.'};
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
  }else if(mode==='missing_fields'){
   const steps=[['workspace_sheet',{file:'source.xlsx',sheet:'Inputs',range:'A2:C2'}],['work_records',{action:'save',collection:'missing-fields',records:[{evidenceId:'e1',idPath:'/rows/0/id',fieldPaths:{title:'/rows/0/values/B',price:'/rows/0/values/C'}}]}],['task_plan',{action:'save',objective:'Export one product with title, UPC and price',steps:['Read and verify all requested fields'],successCriteria:['All three fields'],requiredSources:['fixture'],contract:{count:1,collection:'missing-fields',fields:['title','upc','price']}}],['task_plan',{action:'checkpoint',completedSteps:[0],nextStep:1}],['report_verification',{status:'completed',evidenceIds:['e1'],checks:['Attempted missing-field completion'],limitations:[]}],['report_verification',{status:'needs_verification',evidenceIds:['e1'],checks:['UPC is missing from the saved source projection'],limitations:['The required UPC has not been saved']}]];
   if(n===5){const reply=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert(reply.error.includes('"field":"upc","recordsMissing":1'));assert(reply.error.includes('"title","price"'));assert(!reply.error.includes('Private fixture value'));}
   message=n<steps.length?tc(...steps[n]):{role:'assistant',content:'The UPC is still missing; completion is not verified.'};
  }else if(mode==='contract'){
   const steps=[['task_plan',{action:'save',objective:'Export two fixture records',steps:['Read records','Deliver file'],successCriteria:['Two unique records'],requiredSources:['fixture'],contract:{count:2,collection:'profiles',fields:['name'],exclusions:['Mojo FL'],destination:'CSV'}}],['task_plan',{action:'checkpoint',completedSteps:[0,1],nextStep:2}],['report_verification',{status:'completed',evidenceIds:['e1'],checks:['Attempted completion'],limitations:[]}],['report_verification',{status:'needs_verification',evidenceIds:[],checks:['Saved count was checked'],limitations:['Two requested profiles have not been saved']}]];
   if(n===1)message=tc('task_plan',{action:'save',contract:{destination:'Google Sheets'}});
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
 assert.equal(profileClicks,2);assert.equal(profiles.verification.status,'completed');assert.equal(profiles.verification.receipts.find(r=>r.diagnostic?.code==='repeat_refused').actionOutcome,'not_executed');
 const locationProof=new (require(join(root,'harvey/reliability.js')).TurnVerification)();
 locationProof.record('computer',{action:'call',tool:'browser_snapshot'},{url:'https://fixture.invalid/people/1?tab=details'});const before=locationProof.browserLocation();
 locationProof.record('computer',{action:'call',tool:'browser_snapshot'},{url:'https://fixture.invalid/people/1?tab=notes#changed'});assert.equal(locationProof.browserLocation(),before,'Query/hash changes must not permit a duplicate write');
 locationProof.record('computer',{action:'call',tool:'browser_click'},{error:'REPEATED CALL REFUSED',recovery:{kind:'repeat_refused',actionOutcome:'not_executed',safeToRetry:false}});assert.equal(locationProof.browserLocation(),before,'A known unexecuted call cannot erase observed page identity');
 locationProof.record('computer',{action:'call',tool:'browser_click'},{error:'Connection lost after submission'});assert.equal(locationProof.browserLocation(),undefined,'An uncertain write still invalidates prior page identity');

 console.log('ok identical profile controls work across observed URLs while same-page replay stays refused');
 mode='automatic_review';round=0;
 const automatic=await runAgentLoop({message:'Read the fixture',modelOverride:mainModel,allowContinuation:true,workRuntime:{tools,context:'Fixture',execute:async()=>({url:'https://fixture.invalid/',observed:true})}});assert.equal(automatic.verification.status,'completed');assert.deepEqual(automatic.verification.evidenceIds,['e1']);
 const automaticGuard=new (require(join(root,'harvey/reliability.js')).TurnVerification)();automaticGuard.record('task_plan',{action:'get'},{steps:['Only a plan']});assert.throws(()=>automaticGuard.review({status:'completed',automaticEvidence:true,checks:['Attempted plan-only completion'],limitations:[]}),/Completion requires/);
 automaticGuard.record('computer',{action:'call',tool:'browser_click'},{error:'Unknown submission outcome'});automaticGuard.record('workspace_read',{file:'unrelated.txt'},{file:'unrelated.txt',content:'Unrelated file read'});assert.throws(()=>automaticGuard.review({status:'completed',automaticEvidence:true,checks:['Uncertain write remains unresolved'],limitations:[]}),/Completion requires|affected service/);
 mode='final_review_recovery';round=0;reviewBaseline=recoveryReviews;
 const reviewedStop=await runAgentLoop({message:'Read and verify the fixture',modelOverride:mainModel,allowContinuation:true,workRuntime:{tools,context:'Fixture',execute:async()=>({url:'https://fixture.invalid/',observed:true})}});assert.equal(reviewedStop.verification.status,'completed');assert(!reviewedStop.toolFailure);assert.equal(recoveryReviews-reviewBaseline,1);
 mode='recovery_review';round=0;const reviewBefore=recoveryReviews,reviewEvents=[];let actualMutations=0;
 const consulted=await runAgentLoop({message:'Read and finish the fixture',modelOverride:mainModel,allowContinuation:true,workRuntime:{tools,context:'Fixture',execute:async(name,input)=>{if(input.action==='tools')return {tools:[]};if(input.tool!=='browser_snapshot')actualMutations++;return recoveryReviews===reviewBefore?{error:'Fixture browser temporarily unavailable'}:{url:'https://fixture.invalid/',observed:true};}},onEvent:e=>reviewEvents.push(e)});
 assert.equal(consulted.verification.status,'completed');assert.equal(recoveryReviews-reviewBefore,1);assert.equal(actualMutations,0);assert.equal(consulted.modelUsed,mainModel);assert(reviewEvents.some(e=>e.type==='usage'&&e.model!==mainModel));
 console.log('ok automatic evidence uses actual current observations, excludes plan-only proof, and a separately accounted read-only recovery consultation preserves the selected main model');
 mode='recovery_episodes';round=0;let episode=0,diagnosticSnapshots=0,clickSchemas=0,attempts=0;
 const episodes=await runAgentLoop({message:'Inspect and finish the fixture',modelOverride:mainModel,allowContinuation:true,workRuntime:{tools,context:'Fixture',execute:async(name,input)=>{
   assert.equal(name,'computer');
   if(input.action==='tools'){if(input.tool==='browser_click')clickSchemas++;return {tools:[{name:input.tool}]};}
   if(input.tool==='browser_click'){attempts++;return {error:'Target no longer exists',recovery:{actionOutcome:'not_executed',safeToRetry:true}};}
   if(attempts>0 && !input.arguments?.target){diagnosticSnapshots++;return {url:'https://fixture.invalid/people/'+episode,content:'Read-only diagnostic state'};}
   if(input.arguments.target==='main')episode=2;else if(!episode)episode=1;
   return {url:'https://fixture.invalid/people/'+episode,content:'Observed profile '+episode};
 }}});
 assert.equal(episodes.verification.status,'completed');assert.equal(attempts,6);assert.equal(diagnosticSnapshots,2);assert.equal(clickSchemas,2);
 console.log('ok later browser failures recover after fresh progress, discover the failed action schema, and never replay writes');
 mode='recovery';round=0;let discovered=false;
 const recovered=await runAgentLoop({message:'Extract fixture records',modelOverride:'inception/mercury-2.5',allowContinuation:true,workRuntime:{tools,context:'Fixture',execute:async(name)=>{if(name==='capabilities'){discovered=true;return {routes:['semantic snapshot']};}assert(discovered);return {records:[{id:'one'}]};}}});
 assert.equal(recovered.verification.status,'completed');console.log('ok unsupported capability claim triggers route discovery and successful recovery');
 mode='stagnant';round=0;let reads=0;
 const unstuck=await runAgentLoop({message:'Extract fixture records',modelOverride:mainModel,allowContinuation:true,workRuntime:{tools,context:'Fixture',execute:async(_name,input)=>input.tool==='browser_read_table'?{rows:[{id:'actual-row'}]}:{headers:['Name'],rows:[],observationId:'volatile-'+(++reads),capturedAt:new Date().toISOString()}}});
 assert.equal(reads,8);assert.equal(unstuck.verification.status,'completed');assert(!unstuck.continuation);
 console.log('ok repeated unchanged observations trigger a different route without a task cutoff or another user continue');
 mode='resume';round=0;const chat=store.createChat('fixture',{});
 mode='artifact';round=0;const fileTools=runtime.WORK_TOOLS.filter(t=>['workspace_write','workspace_read'].includes(t.name)),fileApi=require(join(root,'harvey/work/files.js'));
 const authored=await runAgentLoop({message:'Create the fixture JSON file',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools:fileTools,context:'Fixture',execute:async(name,input)=>name==='workspace_write'?fileApi.writeWorkspaceFile('fixture',chat.id,input):fileApi.readWorkspaceFile('fixture',chat.id,input)}});
 assert.equal(authored.verification.status,'completed');assert.equal(fileApi.readWorkspaceFile('fixture',chat.id,{file:'fixture.json'}).content,'{"total":375}');
 mode='invalid_projection';round=0;
 const invalid=await runAgentLoop({message:'Save fixture records',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools:runtime.WORK_TOOLS.filter(t=>t.name==='work_records'),context:'Fixture',execute:async()=>{throw Error('Invalid projection must not reach storage');}}});
 assert(invalid.verification.receipts.some(r=>r.tool==='work_records'&&r.outcome==='failed'&&r.diagnostic));
 mode='unverified';round=0;
 const unverified=await runAgentLoop({message:'Open the fixture and verify both actions',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools,context:'Fixture',execute:async()=>({observed:true})}});
 assert.equal(unverified.verification.status,'needs_verification');assert(!unverified.speech.includes('completed successfully'));
 mode='forced_review';round=0;
 const forced=await runAgentLoop({message:'Open and check the fixture',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools,context:'Fixture',execute:async()=>({observed:true})}});
 assert.equal(forced.verification.status,'completed');
 mode='missing_readback';round=0;let navigations=0,readbacks=0;
 const recoveredReadback=await runAgentLoop({message:'Read the fixture page and report',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools:[...tools,...fileTools],context:'Fixture',execute:async(name,input)=>{if(name==='workspace_read')return {file:'fixture.md',content:'Observed fixture report'};if(input.tool==='browser_navigate')navigations++;if(input.tool==='browser_snapshot')readbacks++;return {url:'https://fixture.invalid/report',observed:'Fixture report'};}}});
 assert.equal(recoveredReadback.verification.status,'completed');assert.equal(navigations,1);assert.equal(readbacks,1);
 mode='compact_readback';round=0;let compactReadbacks=0;
 const compactReadback=await runAgentLoop({message:'Read fixture report and verify it',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools:[...tools,...fileTools],context:'Fixture',execute:async(name,input)=>name==='workspace_read'?{file:'fixture.md',content:'Verified fixture report'}:input.tool==='browser_snapshot'?{url:'https://fixture.invalid/report',truncated:true,content:'Partial page'}:input.tool==='browser_read_table'?(compactReadbacks++,{url:'https://fixture.invalid/report',rows:[{name:'Report',value:'Verified fixture report'}]}):{url:'https://fixture.invalid/report',navigated:true}}});
 assert.equal(compactReadback.verification.status,'completed');assert.equal(compactReadbacks,1);
 console.log('ok completion repair replaces a truncated browser snapshot with a complete compact DOM read without replaying navigation');
 mode='format_progress';round=0;
 const formats=await runAgentLoop({message:'Read and verify the fixture',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools,context:'Fixture',execute:async()=>({url:'https://fixture.invalid/',observed:true})}});assert.equal(formats.verification.status,'completed');assert(!formats.modelError);console.log('ok independent malformed responses recover after intervening successful progress');
 mode='rejected_review';round=0;
 const rejectedReview=await runAgentLoop({message:'Finish and verify the fixture',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools,context:'Fixture',execute:async()=>({observed:true})}});
 assert.equal(rejectedReview.verification.status,'needs_verification');assert.match(rejectedReview.speech,/Evidence must reference successful tool receipts/);assert(!rejectedReview.speech.includes('The task is complete.'));
 console.log('ok unaccepted completion names its actual recorded rejection instead of a generic banner or unsupported success claim');
 mode='navigation_recovery';round=0;let rejectedNavigations=0;
 const navigation=await runAgentLoop({message:'Read the attached sheet using the already signed-in browser',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools:[...tools,...fileTools],context:'Fixture',execute:async(name,input)=>name==='workspace_read'?{file:'fixture.csv',content:'name,notes\nFixture Person,Observed history'}:input.tool==='browser_navigate'?(rejectedNavigations++,require(join(root,'harvey/work/browserState.js')).navigationProblem(input.arguments.url)):{url:'https://fixture.invalid/dashboard',authenticated:true}}});
 assert.equal(navigation.verification.status,'completed');assert.equal(rejectedNavigations,1);assert(navigation.verification.receipts.some(r=>r.actionOutcome==='not_executed'));assert(!navigation.continuation);
 console.log('ok invalid attachment navigation recovers through workspace reading without losing the signed-in page or poisoning completion');
 mode='compact';round=0;let compactReads=0;
 const compact=await runAgentLoop({message:'Export this catalog CSV',allowContinuation:true,modelOverride:mainModel,workRuntime:{tools:[...tools,...runtime.WORK_TOOLS.filter(t=>t.name==='work_records')],context:'Fixture',execute:async(name,input)=>name==='work_records'?records.workRecords('fixture',chat.id,input):input.tool==='browser_read_table'?(compactReads++,{url:'https://fixture.invalid/catalog',rows:[{id:'one',title:'Full source title'}]}):{truncated:true,snapshotId:'long',nextOffset:6500,content:[{type:'text',text:'Shortened title ...'}]}}});
 assert.equal(compact.verification.status,'completed');assert.equal(compactReads,1);assert.equal(records.workRecords('fixture',chat.id,{action:'list',collection:'compact'}).items[0].fields.name,'Full source title');
 console.log('ok real text artifacts read back, invalid projections retain diagnostics, and unverified success prose cannot escape the final gate');
 const Excel=require('exceljs'),sheetApi=require(join(root,'harvey/work/spreadsheet.js'));
 for(const selectedModel of ['inception/mercury-2.5','~openai/gpt-luna-latest']){
  const sheetChat=store.createChat('fixture',{}),source=new Excel.Workbook(),tab=source.addWorksheet('Inputs');tab.addRows([['Name','Notes','Due','Relationship'],['Fixture Alpha','Observed text history','2026-10-20','Sibling: Fixture Beta'],['Fixture Beta','Observed call history','2026-10-21','Sibling: Fixture Alpha']]);await source.xlsx.writeFile(join(fileApi.filesDir('fixture',sheetChat.id),'source.xlsx'));
  mode='sheets';round=0;
  const result=await runAgentLoop({message:'Read and retain both uploaded workbook rows with notes, dates and relationships',allowContinuation:true,modelOverride:selectedModel,workRuntime:{tools:runtime.WORK_TOOLS.filter(t=>['workspace_sheet','work_records'].includes(t.name)),context:'Synthetic fixture',execute:async(name,input)=>name==='workspace_sheet'?sheetApi.readWorkspaceSheet('fixture',sheetChat.id,input):records.workRecords('fixture',sheetChat.id,input)}});
  assert.equal(result.verification.status,'completed');const saved=records.workRecords('fixture',sheetChat.id,{action:'list',collection:'native-sheet'});assert.equal(saved.total,2);assert(saved.items.some(r=>r.fields.due==='2026-10-20'&&r.fields.relationship==='Sibling: Fixture Beta'&&r.fields.notes==='Observed text history'));
 }
 console.log('ok native XLSX records retain observed notes, task dates and relationships through both model adapter paths without browser or connector calls (local provider fixtures)');

 mode='resume';round=0;
 const originalScopeSeq=store.append('fixture',chat.id,{role:'user',content:'Export 20 leads excluding Mojo FL to Google Sheets',at:new Date().toISOString()});assert(Number.isSafeInteger(originalScopeSeq));
 store.put('task_plan','fixture',{id:'retained',chatId:chat.id,requestId:'old',sourceUserSeq:originalScopeSeq,steps:['Read','Deliver'],nextStep:0,blocker:'CAPTCHA requires user approval',contract:{count:20,exclusions:['Mojo FL'],destination:'Google Sheets'}});
 await runtime.runChat('fixture',chat,'yes, do it',{allowContinuation:true,workRequestId:'new',modelOverride:'inception/mercury-2.5'});
 const p=store.get('task_plan','fixture','retained');assert.equal(p.requestId,'new');assert.equal(p.blocker,'');assert.match(p.lastBlocker,/CAPTCHA/);assert.equal(p.contract.count,20);assert.equal(p.sourceUserSeq,originalScopeSeq);
 for(const text of ['yes, do it','Google Sheets is connected now','I authorized Google Sheets','Authorize Google Sheets, then do whatever you can','well just time it correctly and try again'])assert(execution.taskFollowup(text));
 assert(!execution.taskFollowup('Are Google Sheets connected?'));assert(!execution.taskFollowup('stop'));assert(!execution.taskFollowup('just explain the plan'));
 console.log('ok follow-up retains exact contract and rechecks historical blockers without bypassing security');
 mode='visual_fields';round=0;
 const savedVisual=await runAgentLoop({message:'Read visual profile fields',modelOverride:'inception/mercury-2.5',workRuntime:{tools:[...tools,...runtime.WORK_TOOLS.filter(t=>t.name==='work_records')],context:'Fixture',execute:async(name,input)=>name==='work_records'?records.workRecords('fixture',chat.id,input):input.tool==='browser_take_screenshot'?{_image:{media_type:'image/png',data:'fixture-profile-pixels'}}:{url:'https://fixture.invalid/people/42?token=secret'}}});
 assert.equal(savedVisual.verification.status,'completed');const visualRecord=records.workRecords('fixture',chat.id,{action:'list',collection:'visual-profiles'}).items[0];assert.equal(visualRecord.key,'https://fixture.invalid/people/42');assert.equal(visualRecord.fields.Name,'Fixture Person');assert(!JSON.stringify(visualRecord).includes('secret'));
 console.log('ok structured visual fields persist under the observed profile path without inventing IDs or retaining URL tokens');
 mode='missing_fields';round=0;
 const missingChat=store.createChat('fixture',{});
 const missingBook=new Excel.Workbook(),missingSheet=missingBook.addWorksheet('Inputs');missingSheet.addRows([['ID','Title','Price'],['one','Private fixture value','9.00']]);await missingBook.xlsx.writeFile(join(fileApi.filesDir('fixture',missingChat.id),'source.xlsx'));
 const missingFields=await runtime.runChat('fixture',missingChat,'Export one product with title, UPC and price',{modelOverride:mainModel});
 assert.notEqual(missingFields.verification.status,'completed');
 console.log('ok missing contract fields identify exact labels and counts without exposing saved contact values');
 mode='contract';round=0;const other=store.createChat('fixture',{});
 const incomplete=await runtime.runChat('fixture',other,'Export two fixture records',{modelOverride:'inception/mercury-2.5'});
 const savedContractPlan=store.list('task_plan','fixture').find(p=>p.chatId===other.id);assert.equal(learning.sourceMessage('fixture',other.id,savedContractPlan.sourceUserSeq).content,'Export two fixture records','Model-created plans retain the actual original request reference too');const retainedContract=savedContractPlan.contract;
 assert.equal(retainedContract.count,2,'Partial contract updates must retain the requested count');assert.equal(retainedContract.collection,'profiles');assert.deepEqual(retainedContract.exclusions,['Mojo FL']);assert.equal(retainedContract.destination,'Google Sheets');
 assert.notEqual(incomplete.verification.status,'completed');assert.equal(store.list('work_record','fixture').filter(r=>r.chatId===other.id).length,0);
 console.log('ok model cannot mark missing contracted records complete');
 const projection=new (require(join(root,'harvey/reliability.js')).TurnVerification)();
 for(const observed of [{id:'same-person',name:'Fixture Name',phone:'fixture-phone'},{id:'same-person',notes:'Observed note'},{id:'same-person',phone:null}]){
  const receipt=projection.record('computer',{action:'call',tool:'browser_read_table'},{rows:[observed]});
  records.workRecords('fixture',other.id,{action:'save',collection:'incremental',_verifiedRecords:projection.projectRecords([{evidenceId:receipt.id,idPath:'/rows/0/id',fieldPaths:Object.fromEntries(Object.keys(observed).filter(k=>k!=='id').map(k=>[k,'/rows/0/'+k]))}])});
 }
 const merged=records.workRecords('fixture',other.id,{action:'list',collection:'incremental'});
 assert.equal(merged.total,1);assert.deepEqual(merged.items[0].fields,{name:'Fixture Name',phone:null,notes:'Observed note'});
 assert.equal(merged.items[0].fieldSources.name.path,'/rows/0/name');assert.equal(merged.items[0].fieldSources.notes.path,'/rows/0/notes');
 store.closeStore();assert.deepEqual(records.workRecords('fixture',other.id,{action:'list',collection:'incremental'}).items[0].fields,merged.items[0].fields);
 const partials=['name','notes'].map(field=>({key:'batched-person',fields:{[field]:'Observed '+field},source:{tool:'computer',observedAt:'fixture-time',paths:{[field]:'/rows/0/'+field}}}));
 records.workRecords('fixture',other.id,{action:'save',collection:'same-batch',_verifiedRecords:partials});
 assert.deepEqual(records.workRecords('fixture',other.id,{action:'list',collection:'same-batch'}).items[0].fields,{name:'Observed name',notes:'Observed notes'});
 console.log('ok incremental sections retain previously observed fields, explicit null corrections and per-field provenance');
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
 mode='unavailable';round=0;let unavailableExecuted=false;
 const available=await runAgentLoop({message:'Inspect the supported source',modelOverride:mainModel,workRuntime:{tools,context:'Fixture',execute:async(name)=>{if(name==='unavailable_fixture_tool')unavailableExecuted=true;return {url:'https://fixture.invalid/list',text:'Actual observed source'};}}});assert.equal(available.verification.status,'completed');assert.equal(unavailableExecuted,false);
 console.log('ok an unavailable tool is confirmed unexecuted and cannot poison completion as an unknown external write');
 mode='revisit';round=0;let revisits=0;
 const revisited=await runAgentLoop({message:'Recheck the source page',modelOverride:mainModel,workRuntime:{tools,context:'Fixture',execute:async(name,input)=>{if(input.tool==='browser_navigate')revisits++;return {url:'https://fixture.invalid/list',text:'Same current source'};}}});assert.equal(revisits,3);assert.equal(revisited.verification.status,'completed');
 console.log('ok observed source pages can be revisited while form submissions retain independent replay protection');
 mode='deliverable';round=0;const deliveryChat=store.createChat('fixture',{});
 const delivered=await runtime.runChat('fixture',deliveryChat,'Write a short report in delivered.md and give me its download link',{modelOverride:mainModel,allowContinuation:true});assert.equal(delivered.verification.status,'completed');assert(delivered.speech.includes('/api/harvey/work/files/'+deliveryChat.id+'/delivered.md'));
 console.log('ok verified native deliverable is linked from the actual owner/chat file even when the model omits the download link');
 mode='native_revision';round=0;const revisionChat=store.createChat('fixture',{});fileApi.writeWorkspaceFile('fixture',revisionChat.id,{file:'revision.md',content:'Prior value'});let boundRevision=false;
 const revisionResult=await runAgentLoop({message:'Update revision.md and verify it',modelOverride:mainModel,workRuntime:{tools:fileTools,context:'Fixture',execute:async(name,input)=>{if(name==='workspace_write'){boundRevision=typeof input.expectedSha256==='string'&&input.expectedSha256.length===64;return fileApi.writeWorkspaceFile('fixture',revisionChat.id,input);}return fileApi.readWorkspaceFile('fixture',revisionChat.id,input);}}});assert(boundRevision);assert.equal(revisionResult.verification.status,'completed');assert.equal(fileApi.readWorkspaceFile('fixture',revisionChat.id,{file:'revision.md'}).content,'Updated from observed version');console.log('ok safe replacement binds actual observed hash without model transcription');
 mode='source_order';round=0;const orderedChat=store.createChat('fixture',{});
 const orderedResult=await runAgentLoop({message:'continue',modelOverride:mainModel,allowContinuation:true,workRuntime:{requestGoal:()=> 'Export the first 2 observed rows at https://fixture.invalid/list in source order as ordered.csv',tools:[...tools,...fileTools,...runtime.WORK_TOOLS.filter(t=>t.name==='work_records')],context:'Fixture',execute:async(name,input)=>name==='computer'?{url:'https://fixture.invalid/list',rows:[{id:'z',name:'First source'},{id:'a',name:'Second source'}]}:name==='work_records'?records.workRecords('fixture',orderedChat.id,input):fileApi.readWorkspaceFile('fixture',orderedChat.id,input)}});assert.equal(orderedResult.verification.status,'completed');assert.equal(fileApi.readWorkspaceFile('fixture',orderedChat.id,{file:'ordered.csv'}).content,'"name"\r\n"First source"\r\n"Second source"\r\n');console.log('ok first-N ordered CSV requires an observed source-list binding and ignores wrong insertion order');
 mode='outcome_audit';round=0;const beforeAudits=outcomeReviews;let auditCostEvents=0;
 const audited=await runAgentLoop({message:'Save the first two observed IDs in selection.json',allowContinuation:true,modelOverride:mainModel,workRuntime:{reviewOutcome:true,tools:[...tools,...fileTools],context:'Fixture',execute:async(name,input)=>name==='workspace_write'?fileApi.writeWorkspaceFile('fixture',chat.id,input):name==='workspace_read'?fileApi.readWorkspaceFile('fixture',chat.id,input):{url:'https://fixture.invalid/list',rows:[{id:'one'},{id:'two'},{id:'three'}]}},onEvent:e=>{if(e.type==='usage'&&e.model.includes('sonnet'))auditCostEvents++;}});
 assert.equal(audited.verification.status,'completed');assert.equal(fileApi.readWorkspaceFile('fixture',chat.id,{file:'selection.json'}).content,'["one","two"]');assert.equal(outcomeReviews-beforeAudits,2);assert.equal(auditCostEvents,2);assert.equal(audited.modelUsed,mainModel);
 console.log('ok bounded read-only outcome review rejects a wrong source selection, keeps the main model, accounts usage and requires corrected saved data before completion');
 mode='repeat_checkpoints';round=0;let checkpointWrites=0,fileWrites=0;
 const checkpointResult=await runAgentLoop({message:'Check local checkpoint idempotence',modelOverride:mainModel,workRuntime:{tools:runtime.WORK_TOOLS.filter(t=>['workspace_write','workspace_read','task_plan'].includes(t.name)),context:'Fixture',execute:async(name,input)=>{if(name==='task_plan'){checkpointWrites++;return {nextStep:2};}if(name==='workspace_write'){fileWrites++;return fileApi.writeWorkspaceFile('fixture',chat.id,input);}return fileApi.readWorkspaceFile('fixture',chat.id,input);}}});
 assert.equal(checkpointResult.verification.status,'completed');assert.equal(fileWrites,2);assert.equal(checkpointWrites,2);
 console.log('ok idempotent local file/checkpoint operations are repeat-safe and saved bytes still require read-back');
 mode='repeat_observations';round=0;let repeatedReads=0;
 const reread=await runAgentLoop({message:'Verify this saved file',modelOverride:mainModel,workRuntime:{tools:runtime.WORK_TOOLS.filter(t=>t.name==='workspace_read'),context:'Fixture',execute:async()=>{repeatedReads++;return {file:'same.csv',content:'Exact saved contents'};}}});
 assert.equal(repeatedReads,5);assert.equal(reread.verification.status,'completed');assert(!reread.verification.receipts.some(r=>r.outcome==='failed'));
 console.log('ok repeated pure file observations remain usable; write replay protections are unchanged');
 mode='source_bindings';round=0;let copied='',copyCalls=0;
 const literalHistory='Exact source Ω 😀\nKeep every word.';
 const boundResult=await runAgentLoop({message:'Reconcile imported workbook notes into the existing contact',modelOverride:mainModel,workRuntime:{tools:[...tools,...runtime.WORK_TOOLS.filter(t=>t.name==='workspace_sheet')],context:'Fixture',execute:async(name,input)=>{
  if(name==='workspace_sheet')return {file:'source.xlsx',rows:[{id:'person',values:{C:literalHistory}}]};
  if(input.tool==='browser_fill_form'){copyCalls++;copied=input.arguments.fields[0].value;return {saved:true};}
  return {url:'https://fixture.invalid/person',content:[{type:'text',text:'Notes: '+copied}]};
 }}});
 assert.equal(boundResult.verification.status,'completed');assert.equal(copyCalls,1);assert.equal(copied,literalHistory);
 console.log('ok source-bound browser input copies literal Unicode/newlines and rejects paraphrased input before execution');
 mode='history_contract';round=0;reviewBaseline=outcomeReviews;let expectedBound=false;
 const historyContract=await runAgentLoop({message:'continue',modelOverride:mainModel,workRuntime:{requestGoal:()=> 'Reconcile imported notes into existing contacts',reviewOutcome:true,tools:[...tools,...runtime.WORK_TOOLS.filter(t=>t.name==='workspace_sheet')],context:'Fixture',execute:async(name,input)=>{
  if(name==='workspace_sheet')return {file:'history.xlsx',sha256:'history-source',sheet:'Leads',rows:[{row:1,values:{A:'Email(s)',B:'Notes'}},{row:2,values:{A:'person@example.invalid',B:'Missing imported history'}}]};
  if(input.tool==='browser_read_form'){expectedBound=input.arguments.expected?.[0]==='Missing imported history';return {url:'https://fixture.invalid/person',identityEmails:['person@example.invalid'],fields:[{label:'Notes',value:expectedBound?'Prior history\nMissing imported history':'Prior history'}]};}
  return {url:'https://fixture.invalid/person'};
 }}});assert(expectedBound);assert.equal(historyContract.verification.status,'completed');assert.equal(outcomeReviews,reviewBaseline+1);console.log('ok native source-history gate survives continuation, rejects populated old notes before model review, and binds exact read-only expected text');
 mode='invalid_source_date';round=0;let invalidDateWrites=0;
 const invalidDateResult=await runAgentLoop({message:'Copy the source task due date into the existing contact',modelOverride:mainModel,workRuntime:{tools:[...tools,...runtime.WORK_TOOLS.filter(t=>t.name==='workspace_sheet')],context:'Fixture',execute:async(name,input)=>{if(name==='workspace_sheet')return {file:'source.xlsx',rows:[{id:'one',values:{A:'2026-11-31'}}]};if(input.tool==='browser_fill_form')invalidDateWrites++;return {saved:true};}}});assert.equal(invalidDateWrites,0);assert.notEqual(invalidDateResult.verification.status,'completed');console.log('ok impossible source task dates fail before browser execution without guessing a replacement date');
 console.log(`PASS ${mainCalls} local model calls, ${visionCalls} local vision calls, ${recoveryReviews} read-only recovery reviews; $0 provider spend; no customer data accessed`);
}finally{global.fetch=originalFetch;store.closeStore();server.closeAllConnections();await new Promise(r=>server.close(r));}
