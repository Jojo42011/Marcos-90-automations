// Opt-in real-model candidate acceptance. Isolated synthetic CRM and workbook;
// no customer accounts, retained chats, customer files or external business writes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'harvey-candidate-'));chmodSync(dir,0o755);
assert(process.env.OPENROUTER_API_KEY,'Configured model access required');
const sharedBudget=process.env.SHARED_OPENROUTER_BUDGET_DB_PATH||join(process.env.TENANT_DATA_ROOT||'/data','openrouter-budget.db');
for(const key of Object.keys(process.env))if(/API_KEY|TOKEN|PASSWORD|SECRET|COMPOSIO|TENANT_OWNER_ID|DB_JSON_PATH/.test(key)&&key!=='OPENROUTER_API_KEY')delete process.env[key];
Object.assign(process.env,{ACCOUNT_ISOLATION:'false',TENANT_DATA_ROOT:dir,HARVEY_WORK_DIR:join(dir,'work'),AI_USAGE_DB_PATH:join(dir,'usage.db'),SHARED_OPENROUTER_BUDGET_DB_PATH:sharedBudget,DOTENV_CONFIG_PATH:join(dir,'missing'),HARVEY_BROWSER_ENABLED:'true',HARVEY_WORKER_ENABLED:'false',HARVEY_BROWSER_MAX_SESSIONS:'1',AETHON_MAX_TOKENS:'4500'});
const S=require('../dist/src/harvey/work/store.js'),B=require('../dist/src/harvey/work/browser.js'),F=require('../dist/src/harvey/work/files.js'),R=require('../dist/src/harvey/work/runtime.js'),Excel=require('exceljs');
const originalFetch=global.fetch;
global.fetch=(url,...args)=>{const u=new URL(typeof url==='string'?url:url.url||String(url));assert(['localhost','127.0.0.1','openrouter.ai','books.toscrape.com'].includes(u.hostname),'External fixture destination refused');return originalFetch(url,...args);};
const escape=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
let records=[],writes=0,writtenIds=new Set();
const source=Array.from({length:5},(_,i)=>({id:String(i+1),name:i===1||i===2?'Fixture Same':'Fixture '+(i+1),email:'fixture'+(i+1)+'@example.invalid',notes:'Imported history '+(i+1),due:'2026-11-'+String(10+i).padStart(2,'0'),relationship:'Sibling: Test '+(i+1)}));
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');res.setHeader('Content-Type','text/html; charset=utf-8');
 if(url.pathname==='/session'){res.setHeader('Set-Cookie','fixture_session=valid; HttpOnly; SameSite=Lax; Path=/');res.end('<a href="/">Open fixture contacts</a>');return;}
 if(!req.headers.cookie?.includes('fixture_session=valid')){res.statusCode=401;res.end('<h1>Fixture session unavailable</h1>');return;}
 const id=url.pathname.match(/^\/people\/(\d+)$/)?.[1],row=records.find(r=>r.id===id);
 if(req.method==='POST'&&row){let body='';for await(const chunk of req)body+=chunk;const fields=new URLSearchParams(body);for(const field of ['notes','due','relationship'])row[field]=fields.get(field)||'';writes++;writtenIds.add(row.id);res.statusCode=303;res.setHeader('Location',url.pathname);res.end();return;}
 if(row){res.end(`<h1>${escape(row.name)}</h1><p>Email: ${escape(row.email)}</p><form method="POST"><label>Notes<textarea name="notes">${escape(row.notes)}</textarea></label><label>Task due date<input name="due" type="date" value="${escape(row.due)}"></label><label>Relationship<input name="relationship" value="${escape(row.relationship)}"></label><button>Save changes</button></form><a href="/">All contacts</a>`);return;}
 res.end('<h1>Synthetic CRM</h1><table><tr><th>Name</th><th>Email</th><th>Profile</th></tr>'+records.map(r=>`<tr><td>${escape(r.name)}</td><td>${escape(r.email)}</td><td><a href="/people/${r.id}">Open ${escape(r.email)}</a></td></tr>`).join('')+'</table>');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const parseCSV=text=>{const rows=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(value);value='';}else if(c==='\n'&&!quoted){row.push(value.replace(/\r$/,''));rows.push(row);row=[];value='';}else value+=c;}if(value||row.length){row.push(value);rows.push(row);}return rows;};
const decode=s=>s.replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&');
const home=await(await fetch('https://books.toscrape.com/')).text(),expectedBooks=[];
for(const [,href,title]of [...home.matchAll(/<h3>\s*<a href="([^"]+)" title="([^"]+)"/g)].slice(0,10)){
 const page=await(await fetch(new URL(href,'https://books.toscrape.com/'))).text(),upc=page.match(/<th>UPC<\/th><td>([^<]+)<\/td>/)?.[1],price=page.match(/<th>Price \(incl\. tax\)<\/th><td>[^\d]*(\d+\.\d+)<\/td>/)?.[1];assert(upc&&price,'Independent public source parser failed');expectedBooks.push([decode(title),upc,price]);
}
assert.equal(expectedBooks.length,10);
let browserTrace=[];const originalBrowserCall=B.browserCall;
B.browserCall=async(owner,chat,tool,args,...rest)=>{const out=await originalBrowserCall(owner,chat,tool,args,...rest);browserTrace.push({tool,arguments:JSON.stringify(args).slice(0,600),error:out?.error||null});if(browserTrace.length>30)browserTrace.shift();return out;};
let cost=0,calls=0,failed=0;const budget=Number(process.env.HARVEY_QA_BUDGET_USD||.25),outcomes=[];
const run=async(chat,message)=>{
 console.log('CANDIDATE_START '+JSON.stringify({model:chat.model,chatId:chat.id,rerun:message.startsWith('Recheck')}));
 const receiptTrace=[];browserTrace=[];
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),420000);let result,continuation,segments=0;
 try{do{result=await R.runChat('candidate-qa',chat,message+(continuation?'\nSaved continuation: '+continuation.reason:''),{workRequestId:chat.id,continuationTurn:segments>0,allowContinuation:true,modelOverride:chat.model,maxCostUsd:Math.max(0,budget-cost),signal:controller.signal,onEvidence:r=>{receiptTrace.push({tool:r.tool,operation:r.operation,outcome:r.outcome,diagnostic:r.diagnostic});if(receiptTrace.length>30)receiptTrace.shift();},onEvent:e=>{if(e.type==='usage'){cost+=e.costUsd;calls++;if(calls%20===0)console.log('CANDIDATE_PROGRESS '+JSON.stringify({model:chat.model,calls,costUsd:cost}));if(cost>budget)controller.abort();}}});continuation=result.continuation;segments++;if(continuation)await new Promise(r=>setTimeout(r,Math.max(10,Math.min(60,continuation.delaySeconds))*1000));}while(continuation&&!controller.signal.aborted);
 assert(!result.modelError&&!result.budgetRefused&&!result.toolFailure,JSON.stringify({modelError:result.modelError,budgetRefused:result.budgetRefused,toolFailure:result.toolFailure}));if(result.verification?.status!=='completed')console.log('CANDIDATE_DIAGNOSTICS '+JSON.stringify(result.verification?.receipts.filter(r=>r.outcome==='failed').slice(-5).map(r=>({tool:r.tool,diagnostic:r.diagnostic}))));assert.equal(result.verification?.status,'completed',result.speech);return result;
 }catch(error){console.log('CANDIDATE_TRACE '+JSON.stringify({model:chat.model,receipts:receiptTrace,browser:browserTrace}));throw error;}finally{clearTimeout(timer);}
};
try{
 for(const model of ['inception/mercury-2.5','~openai/gpt-luna-latest']){
  records=source.map((r,i)=>({...r,notes:i===0?r.notes:i===1?'Keep prior history':'',due:i===0?r.due:'',relationship:i===0?r.relationship:''}));writes=0;writtenIds=new Set();
  const chat=S.createChat('candidate-qa',{mode:'work',model});
  const book=new Excel.Workbook(),sheet=book.addWorksheet('Leads');sheet.addRows([['Name','Email','Notes','Task due date','Relationship'],...source.map(r=>[r.name,r.email,r.notes,r.due,r.relationship]),['Fixture Same',null,'Ambiguous history: do not assign',null,null]]);await book.xlsx.writeFile(join(F.filesDir('candidate-qa',chat.id),'source.xlsx'));
  await B.browserCall('candidate-qa',chat.id,'browser_navigate',{url:base+'/session'});
  try{
   const result=await run(chat,`Synthetic reconciliation QA. The current browser already has an authenticated fixture session at ${base}. Read uploaded source.xlsx using the native workbook tools and reconcile its rows into existing contacts on this fixture website. Match by exact email; the row without email has two same-name matches, so leave it unresolved and explain why. Add only missing notes, task due dates and relationships. Preserve existing history, original dates and existing correct fields. Do not create contacts or duplicate content. Read each saved profile back. Save reconciliation.md listing the five verified matches and the unresolved row, read the file, and return its download link. No other website, connection or customer account is authorized. Complete without asking me to continue.`);
   for(const wanted of source){const actual=records.find(r=>r.id===wanted.id);assert(actual.notes.includes(wanted.notes),'Missing imported note '+wanted.id);assert.equal(actual.notes.split(wanted.notes).length-1,1,'Duplicate imported note');assert.equal(actual.due,wanted.due);assert.equal(actual.relationship,wanted.relationship);assert(!actual.notes.includes('Ambiguous history'));}assert(records[1].notes.includes('Keep prior history'));assert.equal(writtenIds.size,4,'Only four incomplete profiles should be changed');assert(!writtenIds.has('1'),'Already-correct profile must not be rewritten');assert.equal(records.length,5);
   const report=readFileSync(F.filePath('candidate-qa',chat.id,'reconciliation.md'),'utf8');assert(/ambig|unresolved|missing email/i.test(report));assert(result.speech.includes('/api/harvey/work/files/'));
   const before=JSON.stringify(records),beforeWrites=writes;
   await run(chat,'Recheck the same source workbook and the same five existing contacts. Complete the same reconciliation again, adding only information still missing. Preserve everything already saved and the unresolved ambiguous row. Verify the current destination state and report the result; do not rewrite unchanged profiles.');assert.equal(JSON.stringify(records),before);assert.equal(writes,beforeWrites,'Rerun must not resubmit unchanged contacts');
   const out={model,test:'xlsx-to-authenticated-synthetic-crm',status:'passed',verifiedContacts:5,ambiguousRowsUntouched:1,initialWrites:writes,rerunWrites:0};outcomes.push(out);console.log('CANDIDATE_PASS '+JSON.stringify(out));
  }catch(e){failed++;console.log('CANDIDATE_FAIL '+JSON.stringify({model,test:'xlsx-to-authenticated-synthetic-crm',error:e.message,writes,independentDestination:{matchingNotes:records.filter(r=>r.notes.includes(source.find(s=>s.id===r.id).notes)).length,matchingDates:records.filter(r=>r.due===source.find(s=>s.id===r.id).due).length,matchingRelationships:records.filter(r=>r.relationship===source.find(s=>s.id===r.id).relationship).length,preservedPrior:records[1].notes.includes('Keep prior history'),alreadyCorrectProfileRewritten:writtenIds.has('1')}}));}
  finally{await B.closeBrowsers();}
  const browserChat=S.createChat('candidate-qa',{mode:'work',model});
  try{
   const result=await run(browserChat,'Public browser QA: Open https://books.toscrape.com/ and take the first 10 books in homepage order. Open each product detail page and collect its full title, UPC and price including tax. Save books.csv with columns title,upc,price. Preserve UPCs as text and price as a decimal number. Read the saved file back and check 10 unique products before returning its download link. Complete end to end without asking me to continue. No purchases, logins, email or other connected apps.');
   const csv=readFileSync(F.filePath('candidate-qa',browserChat.id,'books.csv'),'utf8'),rows=parseCSV(csv.replace(/^\uFEFF/,'').trim());assert.deepEqual(rows[0],['title','upc','price']);assert.deepEqual(rows.slice(1),expectedBooks);assert(result.speech.includes('/api/harvey/work/files/'));
   console.log('CANDIDATE_PASS '+JSON.stringify({model,test:'ten-public-product-details',verifiedCells:30,status:'passed'}));
  }catch(e){failed++;console.log('CANDIDATE_FAIL '+JSON.stringify({model,test:'ten-public-product-details',error:e.message}));}
  finally{await B.closeBrowsers();}
 }
 console.log('CANDIDATE_TOTAL '+JSON.stringify({costUsd:cost,modelCalls:calls,failed,customerDataAccessed:false,productionCodeReplaced:false}));assert.equal(failed,0,'Candidate reconciliation must complete and pass independent destination checks');
}finally{global.fetch=originalFetch;await B.closeBrowsers();S.closeStore();server.closeAllConnections();await new Promise(r=>server.close(r));}
