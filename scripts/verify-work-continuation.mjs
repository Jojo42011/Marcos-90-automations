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
 assert.match(prompt,/Do not repeat submissions/);assert.equal(opts.maxCostUsd,1.85);checks++;
 return {speech:'Existing render exported.',costUsd:.1,verification:{status:'completed'}};
};
try{
 await J.executeJob('alice',job.id,executor);let saved=S.get('job','alice',job.id);assert.equal(saved.status,'waiting');assert.equal(generated,1);assert(J.chatJob('alice',chat.id));
 assert.throws(()=>J.enqueueJob('alice',chat.id,{requestId:'duplicate',message:'Again'}),/progress/);
 await J.executeJob('alice',job.id,executor);assert.equal(checks,0,'Not due yet');
 S.closeStore();J.recoverJobs();saved=S.get('job','alice',job.id);assert.equal(saved.status,'waiting','Safe waiting checkpoints survive restart');
 S.put('job','alice',{...saved,nextRunAt:new Date(0).toISOString()});await J.executeJob('alice',job.id,executor);
 saved=S.get('job','alice',job.id);assert.equal(saved.status,'completed');assert.equal(saved.totalCostUsd,.25);assert.equal(generated,1);assert.equal(checks,1);
 console.log('ok saved wait resumes after restart without repeating generation; aggregate budget enforced');
 const cancelled=J.enqueueJob('alice',chat.id,{requestId:'cancel-wait',message:'Finish'});await J.executeJob('alice',cancelled.id,executor);assert.equal(J.cancelJob('alice',cancelled.id).status,'cancelled');
 await J.executeJob('alice',cancelled.id,executor);assert.equal(generated,2);
 const limited=J.enqueueJob('alice',chat.id,{requestId:'limit',message:'Finish'});S.put('job','alice',{...S.get('job','alice',limited.id),totalCostUsd:2});await J.executeJob('alice',limited.id,executor);assert.equal(S.get('job','alice',limited.id).status,'needs_attention');assert.equal(generated,2);
 const interrupted=J.enqueueJob('alice',chat.id,{requestId:'interrupted',message:'Finish'});S.put('job','alice',{...S.get('job','alice',interrupted.id),status:'running'});J.recoverJobs();assert.equal(S.get('job','alice',interrupted.id).status,'needs_attention');
 console.log('ok stop cancels waiting; exhausted budget stops; interrupted writes are never replayed');
 const proof=new TurnVerification();proof.record('computer',{action:'call',tool:'browser_snapshot'},{text:'Rendering at 46%'});
 proof.continuationEvidence('e1','Rendering at 46%');assert.throws(()=>proof.continuationEvidence('e1','Render completed'),/exact/);
 proof.record('computer',{action:'call',tool:'browser_click'},{ok:true});assert.throws(()=>proof.continuationEvidence('e1','Rendering at 46%'),/after the last action/);
 const fail=new TurnVerification();fail.record('computer',{action:'call',tool:'browser_snapshot'},{error:'timeout'});assert.throws(()=>fail.continuationEvidence('e1','timeout'),/successful/);
 console.log('ok waiting requires real observed progress and rejects invented, failed or pre-write evidence');
}finally{S.closeStore();}
