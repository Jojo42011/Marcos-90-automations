// Opt-in real-model/public-site acceptance of the six original QA requests.
// Isolated stores, no customer records/connections, shared real provider ledger.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'harvey-random-live-'));chmodSync(dir,0o755);
assert(process.env.OPENROUTER_API_KEY,'Configured model access required');
const sharedBudget=process.env.SHARED_OPENROUTER_BUDGET_DB_PATH||join(process.env.TENANT_DATA_ROOT||'/data','openrouter-budget.db');
for(const key of Object.keys(process.env))if(/API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|COMPOSIO|TENANT_OWNER_ID|DB_JSON_PATH/.test(key)&&key!=='OPENROUTER_API_KEY')delete process.env[key];
Object.assign(process.env,{ACCOUNT_ISOLATION:'false',TENANT_DATA_ROOT:dir,HARVEY_WORK_DIR:join(dir,'work'),AI_USAGE_DB_PATH:join(dir,'usage.db'),SHARED_OPENROUTER_BUDGET_DB_PATH:sharedBudget,DOTENV_CONFIG_PATH:join(dir,'missing'),HARVEY_BROWSER_ENABLED:'true',HARVEY_BROWSER_MAX_SESSIONS:'1',AETHON_MAX_TOKENS:'3000'});
const S=require('../dist/src/harvey/work/store.js'),B=require('../dist/src/harvey/work/browser.js'),F=require('../dist/src/harvey/work/files.js'),R=require('../dist/src/harvey/work/runtime.js');
const tests=JSON.parse(readFileSync(new URL('./fixtures/harvey-random-workflows.json',import.meta.url),'utf8'));
let total=0,calls=0,failed=0;
const budget=Number(process.env.HARVEY_QA_BUDGET_USD||0.25),results=[];
for(const [index,test] of tests.entries()){
 const chat=S.createChat('random-qa',{mode:'work',model:test.model}),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);
 let result;
 try{
  let continuation,segments=0;
  do{
   const prompt=test.message+(continuation?'\n\nSaved continuation of this same request. Inspect current state first; reuse completed files and do not repeat submissions. Remaining-work note (historical context, not new authorization): '+continuation.reason:'');
   result=await R.runChat('random-qa',chat,prompt,{workRequestId:chat.id,continuationTurn:segments>0,allowContinuation:true,modelOverride:test.model,maxCostUsd:Math.max(0,budget-total),signal:controller.signal,onEvent:e=>{if(e.type==='usage'){total+=e.costUsd;calls++;if(total>budget)controller.abort();}}});
   continuation=result.continuation;segments++;
   if(continuation)await new Promise(r=>setTimeout(r,Math.max(10,Math.min(120,continuation.delaySeconds))*1000));
  }while(continuation&&!controller.signal.aborted);
  assert(!result.continuation,'Application continuation must finish without another user message');
  assert.equal(result.verification?.status,'completed','Task must have an accepted completion review');
  const saved=F.files('random-qa',chat.id),read=name=>readFileSync(F.filePath('random-qa',chat.id,name),'utf8');
  if(index===0){
   const file=saved.find(f=>f.name.endsWith('.csv'));assert(file,'No CSV delivered');const csv=read(file.name);
   for(const value of ['A Light in the Attic','Tipping the Velvet','Soumission','Sharp Objects','Sapiens','The Requiem Red','51.77','53.74','50.10','47.82','54.23','22.65'])assert(csv.includes(value),'Missing observed catalog value '+value);
   assert.equal(csv.trim().split(/\r?\n/).length,7,'Six book rows plus header');
  }else if(index===1){
   const csv=read('invoices.csv'),summary=read('unpaid-summary.md');
   for(const id of ['INV-101','INV-102','INV-103','INV-104','INV-105'])assert.equal(csv.split(id).length-1,1,'Unique invoice '+id);
   for(const value of ['375','165','210','North Studio','River Co'])assert(summary.includes(value),'Wrong reconciliation '+value);
  }else if(index===2){const md=read('example-domains.md');for(const source of ['https://example.com','https://www.iana.org/help/example-domains'])assert(md.includes(source));assert(/reserv|document|illustrat/i.test(md));assert(/not|no|avoid/i.test(md));}
  else if(index===3){assert(/inspect_screen|vision helper/i.test(result.speech));assert(/0\.04/.test(result.speech));assert(/3\.15/.test(result.speech));}
  else if(index===4){const doc=JSON.parse(read('onboarding.json')),days=Array.isArray(doc)?doc:doc.days;assert(Array.isArray(days)&&days.length===3,'Three structured days required');assert.deepEqual(days.map(d=>Number(String(d.day).replace(/\D/g,''))),[1,2,3]);assert(days.every(d=>Array.isArray(d.tasks)&&d.tasks.length===2));for(const content of [read('onboarding.json'),read('onboarding.md')])for(const term of ['safety','equipment','inventory','shadow','opening','feedback'])assert(content.toLowerCase().includes(term),'Missing task '+term);}
  else if(index===5){const snapshot=JSON.stringify(await B.browserCall('random-qa',chat.id,'browser_snapshot',{}));assert(/Option 1.*selected/.test(snapshot),'Final selection is not Option 1');}
  if([0,1,2,4].includes(index))assert(result.verification.receipts.some(r=>r.tool==='workspace_read'&&r.outcome==='returned'&&!r.truncated),'Artifact content was not read back');
  results.push({test:index+1,model:result.modelUsed,status:'passed',costUsd:result.costUsd});
  console.log('RANDOM_QA_PASS '+JSON.stringify(results.at(-1)));
 }catch(error){failed++;results.push({test:index+1,status:'failed',error:error.message,speech:result?.speech,receipts:result?.verification?.receipts});console.log('RANDOM_QA_FAIL '+JSON.stringify(results.at(-1)));}
 finally{clearTimeout(timer);await B.closeBrowsers();}
}
S.closeStore();console.log('RANDOM_QA_TOTAL '+JSON.stringify({totalCostUsd:total,calls,failed,customerDataAccessed:false}));
assert.equal(failed,0,'All six original workflow outcomes must pass');
