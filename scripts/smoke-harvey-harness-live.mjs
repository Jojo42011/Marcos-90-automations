// Opt-in real-model acceptance. Three synthetic canvas rows, no customer browser/data.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'harvey-harness-live-'));chmodSync(dir,0o755);
assert(process.env.OPENROUTER_API_KEY,'Configured model access is required');
const sharedBudget=process.env.SHARED_OPENROUTER_BUDGET_DB_PATH||join(process.env.TENANT_DATA_ROOT||'/data','openrouter-budget.db');
for(const key of Object.keys(process.env))if(/API_KEY|TOKEN|PASSWORD|SECRET|COMPOSIO|TENANT_OWNER_ID|DB_JSON_PATH/.test(key)&&key!=='OPENROUTER_API_KEY')delete process.env[key];
Object.assign(process.env,{ACCOUNT_ISOLATION:'false',TENANT_DATA_ROOT:dir,HARVEY_WORK_DIR:join(dir,'work'),AI_USAGE_DB_PATH:join(dir,'usage.db'),SHARED_OPENROUTER_BUDGET_DB_PATH:sharedBudget,DOTENV_CONFIG_PATH:join(dir,'missing'),HARVEY_BROWSER_ENABLED:'true',AETHON_MAX_TOKENS:'2048'});
const S=require('../dist/src/harvey/work/store.js'),B=require('../dist/src/harvey/work/browser.js'),R=require('../dist/src/harvey/work/records.js'),F=require('../dist/src/harvey/work/files.js');
const {WORK_TOOLS}=require('../dist/src/harvey/work/runtime.js'),{capabilityMap}=require('../dist/src/harvey/work/capabilities.js'),{runAgentLoop}=require('../dist/src/hull/agentLoop.js');
const app=require('express')();
app.get('/',(_req,res)=>res.type('html').send(`<title>Isolated visual records fixture</title><h1>Records are drawn below</h1><canvas width="1000" height="280" aria-label="Visual records"></canvas><script>const c=document.querySelector('canvas').getContext('2d');c.fillStyle='white';c.fillRect(0,0,1000,280);c.fillStyle='black';c.font='24px Arial';['ID | Name | Source','F001 | Iris Fixture | Listing Lead','F002 | Riley Fixture | Mojo FL','F003 | Noah Fixture | Sphere'].forEach((s,i)=>c.fillText(s,20,45+i*55));</script>`));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port,owner='harness-smoke',chat=S.createChat(owner,{}),original=global.fetch;
global.fetch=(url,...args)=>{const u=new URL(typeof url==='string'?url:url.url||String(url));assert(['localhost','127.0.0.1','openrouter.ai'].includes(u.hostname),'External fixture destination refused');return original(url,...args);};
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000),model=process.env.HARVEY_HARNESS_SMOKE_MODEL||'inception/mercury-2.5';
let cost=0,calls=0,exported;
const tools=WORK_TOOLS.filter(t=>['capabilities','computer','inspect_screen','work_records','workspace_files'].includes(t.name));
try{
 await B.browserCall(owner,chat.id,'browser_navigate',{url:base});
 const result=await runAgentLoop({message:'Export the two eligible synthetic records from the already-open visual records fixture to CSV, excluding source Mojo FL. Use capabilities to find the route. The data is drawn, so inspect_screen structured=true should read literal id/name/source fields into data.rows. Save their exact values via work_records collection leads and JSON-pointer source evidence, export CSV, inspect the resulting file and verify completion. Do not navigate, create tabs, reset the browser, access any other website/service or ask the user to transcribe. This fixture contains three rows, two eligible.',
   modelOverride:model,maxCostUsd:0.03,allowContinuation:true,signal:controller.signal,
   workRuntime:{tools,context:'Isolated visual-record export. Use current observations and literal source IDs. Preserve exclusion. No customer data or external business actions are authorized.',pendingWork:()=>false,execute:async(name,input)=>{
     if(name==='capabilities')return capabilityMap({local:false,browser:true,managed:false,apps:[],custom:[],tools:tools.map(t=>t.name)});
     if(name==='computer'){
       if(input.action==='tools')return {tools:await B.browserTools(owner,chat.id,input.tool)};
       if(!['browser_snapshot','browser_take_screenshot','browser_read_snapshot','browser_read_table','browser_inspect_scroll_regions'].includes(input.tool))throw Error('Only observation of the existing fixture is authorized');
       return B.browserCall(owner,chat.id,input.tool,input.arguments||{},controller.signal);
     }
     if(name==='work_records'){const r=R.workRecords(owner,chat.id,input);if(input.action==='export')exported=r;return r;}
     if(name==='workspace_files')return F.workspaceFiles(owner,chat.id,input);
     throw Error('Unknown fixture tool');
   }},onEvent:e=>{if(e.type==='usage'){cost+=e.costUsd;calls++;if(cost>0.03)controller.abort();}}});
 assert(!result.modelError&&!result.toolFailure&&!result.budgetRefused,JSON.stringify({modelError:result.modelError,toolFailure:result.toolFailure,budgetRefused:result.budgetRefused}));
 assert.equal(result.verification?.status,'completed','The visual export was not verified');assert.equal(exported?.rows,2);
 const csv=readFileSync(F.filePath(owner,chat.id,exported.file),'utf8');
 for(const value of ['F001','Iris Fixture','Listing Lead','F003','Noah Fixture','Sphere'])assert(csv.split(/[,\r\n]+/).map(v=>v.replace(/^\uFEFF/, '').replace(/^\"|\"$/g,'')).includes(value),'Missing or changed literal fixture field');
 assert(!csv.includes('F002')&&!csv.includes('Mojo FL'));assert.equal(csv.trim().split('\r\n').length,3);
 console.log('HARNESS_LIVE_PASS '+JSON.stringify({model:result.modelUsed,rows:2,modelCalls:calls,costUsd:cost,verifiedCsv:true,customerDataAccessed:false}));
}finally{clearTimeout(timer);await B.closeBrowsers();S.closeStore();global.fetch=original;server.closeAllConnections();await new Promise(r=>server.close(r));}
