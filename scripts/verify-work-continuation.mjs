import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'harvey-continuation-'));
for(const k of Object.keys(process.env))if(/API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|DB_JSON_PATH|COMPOSIO|HARVEY_WORK_DIR|TENANT_OWNER_ID/.test(k))delete process.env[k];
Object.assign(process.env,{TENANT_DATA_ROOT:dir,HARVEY_WORK_DIR:join(dir,'work'),DOTENV_CONFIG_PATH:join(dir,'no-env'),ACCOUNT_ISOLATION:'true'});
global.fetch=()=>{throw new Error('External requests forbidden in continuation fixture');};
const S=require('../dist/src/harvey/work/store.js'),J=require('../dist/src/harvey/work/jobs.js'),{TurnVerification}=require('../dist/src/harvey/reliability.js');
const chat=S.createChat('alice',{}),job=J.enqueueJob('alice',chat.id,{requestId:'render-once',message:'Finish the existing composite without starting over'});
let generated=0,checks=0;
const executor=async(owner,c,prompt,opts)=>{
 assert.equal(owner,'alice');assert.equal(c.id,chat.id);assert(opts.allowContinuation);
 if(!opts.continuationTurn){generated++;return {speech:'Rendering at 46%.',costUsd:.15,continuation:{delaySeconds:30,reason:'Inspect existing render; then export.'}};}
 assert.match(prompt,/Do not repeat submissions/);assert.equal(opts.maxCostUsd,undefined);checks++;
 return {speech:'Existing render exported.',costUsd:.1,verification:{status:'completed'}};
};
try{
 await J.executeJob('alice',job.id,executor);let saved=S.get('job','alice',job.id);assert.equal(saved.status,'waiting');assert.equal(generated,1);assert(J.chatJob('alice',chat.id));
 assert.throws(()=>J.enqueueJob('alice',chat.id,{requestId:'duplicate',message:'Again'}),/progress/);
 await J.executeJob('alice',job.id,executor);assert.equal(checks,0,'Not due yet');
 S.closeStore();J.recoverJobs();saved=S.get('job','alice',job.id);assert.equal(saved.status,'waiting','Safe waiting checkpoints survive restart');
 S.put('job','alice',{...saved,nextRunAt:new Date(0).toISOString()});await J.executeJob('alice',job.id,executor);
 saved=S.get('job','alice',job.id);assert.equal(saved.status,'completed');assert.equal(saved.totalCostUsd,.25);assert.equal(generated,1);assert.equal(checks,1);
 console.log('ok saved wait resumes after restart without repeating generation; cost tracking preserved');
 const cancelled=J.enqueueJob('alice',chat.id,{requestId:'cancel-wait',message:'Finish'});await J.executeJob('alice',cancelled.id,executor);assert.equal(J.cancelJob('alice',cancelled.id).status,'cancelled');
 await J.executeJob('alice',cancelled.id,executor);assert.equal(generated,2);
 const limited=J.enqueueJob('alice',chat.id,{requestId:'limit',message:'Finish'});S.put('job','alice',{...S.get('job','alice',limited.id),totalCostUsd:25,maxCostUsd:.5});await J.executeJob('alice',limited.id,async(_o,_c,_p,opts)=>{assert.equal(opts.maxCostUsd,undefined);return {speech:'Finished beyond old task cap',costUsd:1};});assert.equal(S.get('job','alice',limited.id).status,'completed');assert.equal(S.get('job','alice',limited.id).totalCostUsd,26);
 const interrupted=J.enqueueJob('alice',chat.id,{requestId:'interrupted',message:'Finish'});S.put('job','alice',{...S.get('job','alice',interrupted.id),status:'running'});J.recoverJobs();assert.equal(S.get('job','alice',interrupted.id).status,'needs_attention');
 console.log('ok stop cancels waiting; old task budget does not stop work; interrupted writes are never replayed');
 const stalled=J.enqueueJob('alice',chat.id,{requestId:'stalled',message:'Extract all records'});let changedApproach=false;
 for(let i=0;i<4;i++){
  let j=S.get('job','alice',stalled.id);if(i)S.put('job','alice',{...j,nextRunAt:new Date(0).toISOString()});
  await J.executeJob('alice',stalled.id,async(_o,_c,prompt,opts)=>{assert.equal(opts.workRequestId,stalled.id);if(i>=2){assert.match(prompt,/Change the retrieval approach/);changedApproach=true;}return {speech:'Partial',continuation:{delaySeconds:10,reason:'Read remaining rows',progressKey:'unchanged'},costUsd:0};});
 }
 assert(changedApproach);assert.equal(S.get('job','alice',stalled.id).status,'needs_attention');assert.match(S.get('job','alice',stalled.id).result.text,/no observable progress/);

 assert.match(S.get('job','alice',cancelled.id).result.text,/Stopped/);
 console.log('ok unchanged observations prompt a different retrieval approach then stop with an accurate reason');
 const proof=new TurnVerification();proof.record('computer',{action:'call',tool:'browser_snapshot'},{text:'Rendering at 46%'});
 proof.continuationEvidence('e1','Rendering at 46%');assert.throws(()=>proof.continuationEvidence('e1','Render completed'),/exact/);
 proof.record('computer',{action:'call',tool:'browser_click'},{ok:true});assert.throws(()=>proof.continuationEvidence('e1','Rendering at 46%'),/after the last action/);
 const fail=new TurnVerification();fail.record('computer',{action:'call',tool:'browser_snapshot'},{error:'timeout'});assert.throws(()=>fail.continuationEvidence('e1','timeout'),/successful/);
 console.log('ok waiting requires real observed progress and rejects invented, failed or pre-write evidence');
}finally{S.closeStore();}

// New durable recovery checks use isolated chats and only local executors.
const recoveryChat=S.createChat('alice',{});
const recovery=J.enqueueJob('alice',recoveryChat.id,{requestId:'safe-recovery',message:'Transfer all verified records'});
const receipt=(observation,scope='business:lead',outcome='returned')=>({id:'e',tool:'business_call',at:new Date().toISOString(),observation,scope,outcome,discovery:false,truncated:false});
assert(!J.safeRecovery([receipt(false)]));
assert(!J.safeRecovery([receipt(false),receipt(true,'business:other')]));
assert(!J.safeRecovery([receipt(false,'business:lead','failed'),receipt(true)]));
assert(J.safeRecovery([receipt(false),receipt(true)]));
S.put('task_plan','alice',{id:'recovery-plan',chatId:recoveryChat.id,requestId:recovery.id,steps:['Transfer remaining records'],nextStep:0});
S.put('job','alice',{...S.get('job','alice',recovery.id),status:'running',safeResume:true,totalCostUsd:.25});
J.recoverJobs();assert.equal(S.get('job','alice',recovery.id).status,'waiting');
let recovered=0;
await J.executeJob('alice',recovery.id,async(_o,_c,prompt,opts)=>{recovered++;assert(opts.continuationTurn);assert.equal(opts.maxCostUsd,undefined);assert.match(prompt,/Inspect current state/);opts.onEvent({type:'usage',costUsd:.1});return {speech:'Verified existing batch; finished remaining records.',costUsd:.1,verification:{status:'completed'}};});
assert.equal(recovered,1);assert.equal(S.get('job','alice',recovery.id).totalCostUsd,.35,'Persisted step cost must not be double counted');
const longChat=S.createChat('alice',{}),long=J.enqueueJob('alice',longChat.id,{requestId:'long',message:'Transfer all authorized records'});
S.put('job','alice',{...S.get('job','alice',long.id),continuationCount:20,createdAt:new Date(Date.now()-2*60*60_000).toISOString()});
await J.executeJob('alice',long.id,async()=>({speech:'Long task completed',verification:{status:'completed'}}));assert.equal(S.get('job','alice',long.id).status,'completed');
const cancellingChat=S.createChat('alice',{}),cancelling=J.enqueueJob('alice',cancellingChat.id,{requestId:'stop-restart',message:'Finish'});
S.put('job','alice',{...S.get('job','alice',cancelling.id),status:'cancelling',safeResume:true});J.recoverJobs();assert.equal(S.get('job','alice',cancelling.id).status,'needs_attention');
console.log('ok matching read-back recovery, no cross-resource/failed-write replay, persisted spend, >12 segments/>1 hour, cancellation remains stopped');
S.closeStore();

const batchesChat=S.createChat('alice',{}),batches=J.enqueueJob('alice',batchesChat.id,{requestId:'many-batches',message:'Transfer all authorized source records into the separate destination'});
const sourceRecords=Array.from({length:30},(_,id)=>({id,sourceAccount:'source'})),destination=new Map();
for(let i=0;i<30;i++){
 const before=S.get('job','alice',batches.id);if(i)S.put('job','alice',{...before,nextRunAt:new Date(0).toISOString()});
 await J.executeJob('alice',batches.id,async(owner,c,prompt,opts)=>{
   assert.equal(owner,'alice');assert.equal(c.id,batchesChat.id);assert.equal(opts.workRequestId,batches.id);
   const source=sourceRecords.find(r=>!destination.has(r.id));assert(source);destination.set(source.id,{...source,destinationAccount:'destination'});
   return {speech:i===29?'All batches verified':'Batch verified',costUsd:.01,...(i<29?{continuation:{delaySeconds:10,reason:'Inspect destination before creating remaining source records',progressKey:String(destination.size)}}:{verification:{status:'completed'}})};
 });
}
assert.equal(destination.size,30);assert.equal(sourceRecords.length,30);assert.equal(S.get('job','alice',batches.id).status,'completed');assert.equal(S.list('job','bob').length,0);
const brokenChat=S.createChat('alice',{}),broken=J.enqueueJob('alice',brokenChat.id,{requestId:'bounded-model-repair',message:'Finish remaining batch'});
for(let i=0;i<4;i++){
 if(i)S.put('job','alice',{...S.get('job','alice',broken.id),nextRunAt:new Date(0).toISOString()});
 await J.executeJob('alice',broken.id,async()=>({speech:'Recovering',continuation:{delaySeconds:10,reason:'Inspect saved progress',recovery:'model_response'},costUsd:.01}));
}
assert.equal(S.get('job','alice',broken.id).status,'needs_attention');assert.equal(S.get('job','alice',broken.id).result.failure.kind,'invalid_model_response');
console.log('ok 30 batches retain distinct source/destination and job identity without duplicate records; persistent malformed service responses stop after bounded automatic recovery');
const oldChat=S.createChat('alice',{}),old=J.enqueueJob('alice',oldChat.id,{requestId:'uncapped-age',message:'Finish all remaining profiles'});
S.put('job','alice',{...S.get('job','alice',old.id),createdAt:new Date(Date.now()-72*60*60_000).toISOString(),continuationCount:1000});
await J.executeJob('alice',old.id,async(_o,_c,_p,opts)=>{assert.equal(opts.checkpointAt,undefined);assert(!opts.signal.aborted);return {speech:'Remaining profiles completed',verification:{status:'completed'}};});
assert.equal(S.get('job','alice',old.id).status,'completed');
console.log('ok interactive jobs continue beyond 24 hours and 256 yields without an elapsed-task checkpoint');
const failureChat=S.createChat('alice',{}),failureJob=J.enqueueJob('alice',failureChat.id,{requestId:'tool-diagnostic',message:'Finish source retrieval'});
await J.executeJob('alice',failureJob.id,async()=>({speech:'Browser disconnected',toolFailure:{code:'browser_disconnected',message:'Selected browser disconnected',detail:'computer/browser_snapshot'}}));
const toolFailed=S.get('job','alice',failureJob.id);assert.equal(toolFailed.status,'needs_attention');assert.equal(toolFailed.result.failure.kind,'tool_error');assert.equal(toolFailed.result.failure.code,'browser_disconnected');
console.log('ok saved job retains browser tool failure separately from provider or credit failures');
S.closeStore();
