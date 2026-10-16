// Read-only operator audit. Print only allowlisted failure metadata, never messages/arguments.
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
const root=process.env.TENANT_DATA_ROOT||'/data',paths=new Set([join(process.env.HARVEY_WORK_DIR||join(root,'harvey-work'),'work.db')]);
if(existsSync(join(root,'accounts')))for(const entry of readdirSync(join(root,'accounts'),{withFileTypes:true}))if(entry.isDirectory())paths.add(join(root,'accounts',entry.name,'harvey-work','work.db'));
const identifier=value=>/^(?:browser_[a-z_]+|computer|task_plan|work_records|scroll|snapshot|click|read_table)$/.test(value||'')?value:'unclassified';
const category=value=>/argument|schema/i.test(value||'')?'arguments':/disconnect|connection/i.test(value||'')?'connection':/target|selector|reference/i.test(value||'')?'targeting':/repeat/i.test(value||'')?'repeat_refused':/timeout/i.test(value||'')?'timeout':/unsupported|unknown/i.test(value||'')?'unsupported_tool':'unclassified';
let matched=0;
for(const path of paths){
 if(!existsSync(path))continue;
 const db=new Database(path,{readonly:true,timeout:5000});
 try{
  const chats=db.prepare("SELECT owner,id FROM records WHERE kind='chat' AND lower(json_extract(body,'$.title')) LIKE '%brivity%' LIMIT 20").all();
  for(const chat of chats){
   const jobs=db.prepare("SELECT body FROM records WHERE kind='job' AND owner=? AND json_extract(body,'$.chatId')=? ORDER BY rowid DESC LIMIT 5").all(chat.owner,chat.id).map(r=>JSON.parse(r.body));
   const progress=db.prepare("SELECT body FROM records WHERE kind='execution_progress' AND owner=? AND id=?").get(chat.owner,chat.id);
   const failures=jobs.filter(j=>j.result?.verification?.receipts?.some(r=>r.outcome==='failed')||j.result?.failure);
   if(!failures.length)continue;matched++;
   console.log('BROWSER_FAILURE_AUDIT '+JSON.stringify({chat:createHash('sha256').update(chat.owner+':'+chat.id).digest('hex').slice(0,12),jobs:failures.map(j=>({status:['failed','needs_attention','completed','cancelled'].includes(j.status)?j.status:'other',failureKind:['tool_error','invalid_model_response','provider_error','provider_credit_limit'].includes(j.result?.failure?.kind)?j.result.failure.kind:'unclassified',failed:(j.result?.verification?.receipts||[]).filter(r=>r.outcome==='failed').map(r=>({tool:identifier(r.tool),category:category(r.diagnostic?.code+' '+(r.diagnostic?.message||'')),retainedDiagnostic:!!r.diagnostic}))})),recentBrowserActions:progress?JSON.parse(progress.body).events.filter(e=>e.tool==='computer').map(e=>({action:identifier(e.action),outcome:e.outcome==='failed'?'failed':'returned'})):[]}));
  }
 }finally{db.close();}
}
console.log('BROWSER_FAILURE_AUDIT_SUMMARY '+JSON.stringify({matchedChats:matched,readonly:true,rawChatOrLeadDataPrinted:false}));
