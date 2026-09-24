// Opt-in read-only check of the connected mailbox. Never logs message content.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
const live=new Database(join(process.env.HARVEY_WORK_DIR||'/data/harvey-work','work.db'),{readonly:true,fileMustExist:true});
const records=live.prepare("SELECT kind,owner,body FROM records WHERE kind IN ('project','composio_session')").all();live.close();
const workerEnabled=process.env.HARVEY_WORKER_ENABLED==='true';
const scratch=mkdtempSync(join(tmpdir(),'harvey-email-check-'));
Object.assign(process.env,{HARVEY_WORK_DIR:join(scratch,'work'),AI_USAGE_DB_PATH:join(scratch,'usage.db'),HARVEY_DAILY_CAP_USD:'0.02',HARVEY_MONTHLY_CAP_USD:'0.02',HARVEY_MAX_COST_PER_CALL_USD:'0.02',AETHON_MAX_TOKENS:'4096',HARVEY_WORKER_ENABLED:'false'});
const timeout=setTimeout(()=>{console.error('EMAIL_SMOKE_FAIL timeout');process.exit(1)},150000);
try{
const S=await import('../dist/src/harvey/work/store.js');
for(const row of records)S.put(row.kind,row.owner,JSON.parse(row.body));
const M=await import('../dist/src/harvey/work/composio.js');
const R=await import('../dist/src/harvey/work/runtime.js');
const catalog=await import('../dist/src/hull/providers/catalog.js');assert(await catalog.refreshCatalog({force:true}));
const model=catalog.availableModels().find(m=>m.id==='inception/mercury-2.5'&&m.inputPerM>0&&m.inputPerM<=0.5&&m.outputPerM<=1.5);assert(model,'Verified cheap model unavailable');
let found=false;
for(const owner of S.owners('composio_session')){
 const connections=await M.managedConnections(owner);const mail=connections.find(c=>['gmail','outlook'].includes(c.slug));if(!mail)continue;
 found=true;const chat=S.createChat(owner,{mode:'chat',title:'Isolated email integration check'});const calls=[];
 const result=await R.runChat(owner,chat,'Read my single most recent inbox email through '+mail.name+'. Use the connected managed tools to actually fetch it. Return only EMAIL_READ_OK if you retrieved a real message. Do not include any sender, subject, body or other personal data in your final answer. Do not send, modify, mark as read, delete, schedule, or access other services.',{modelOverride:model.id,maxCostUsd:0.02,onEvent:e=>{if(e.type==='tool')calls.push({name:e.name,status:e.status});}});
 assert(!result.modelError&&!result.toolFailed&&!result.budgetRefused,'Provider/tool failure');assert(calls.some(c=>c.name==='COMPOSIO_MULTI_EXECUTE_TOOL'&&c.status==='done'),'No email execution tool call');assert(result.speech.includes('EMAIL_READ_OK'),'Email not retrieved');
 console.log('EMAIL_SMOKE_PASS '+JSON.stringify({workerEnabled,service:mail.slug,mode:'chat',toolCalls:calls,costUsd:result.costUsd,promptTokens:result.promptTokens,completionTokens:result.completionTokens}));break;
}
assert(found,'No connected Gmail or Outlook account found for an app user');
}catch(e){console.error('EMAIL_SMOKE_FAIL '+e.message);process.exitCode=1;}finally{clearTimeout(timeout);}
