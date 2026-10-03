// Live provider + real browser, isolated temporary data, synthetic credentials only.
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
const dir=mkdtempSync(join(tmpdir(),'harvey-recovery-'));chmodSync(dir,0o755);
Object.assign(process.env,{TENANT_DATA_ROOT:dir,DB_JSON_PATH:join(dir,'db.json'),HARVEY_WORK_DIR:join(dir,'work'),AI_USAGE_DB_PATH:join(dir,'usage.db'),HARVEY_WORKER_ENABLED:'false',HARVEY_BROWSER_ENABLED:'true',HARVEY_DAILY_CAP_USD:'1',HARVEY_MONTHLY_CAP_USD:'1',HARVEY_MAX_COST_PER_CALL_USD:'0.3',AETHON_MAX_TOKENS:'4096'});
// No client connectors are needed or exposed to this test owner.
delete process.env.COMPOSIO_API_KEY;
const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{res.setHeader('content-type','text/html');if(req.url==='/login'&&req.method==='POST'){const f=new URLSearchParams(body);if(f.get('username')==='fixture-user'&&f.get('password')==='fixture-only-42'){res.setHeader('set-cookie','fixture_auth=yes; Path=/; HttpOnly');res.end('<h1>Signed in as fixture-user</h1>');}else{res.statusCode=401;res.end('<h1>Login failed</h1>');}}else if((req.headers.cookie||'').includes('fixture_auth=yes'))res.end('<h1>Signed in as fixture-user</h1>');else res.end('<h1>Fixture sign in</h1><form method="POST" action="/login"><label>Username<input name="username"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>');});});
await new Promise(r=>server.listen(0,'0.0.0.0',r));
const S=await import('../dist/src/harvey/work/store.js'),R=await import('../dist/src/harvey/work/runtime.js'),B=await import('../dist/src/harvey/work/browser.js');
const owner='recovery-smoke',chat=S.createChat(owner,{mode:'work',title:'Isolated release test'});
const timer=setTimeout(()=>{console.error('RECOVERY_SMOKE_TIMEOUT');process.exit(1);},240000);
try{
 const catalog=await import('../dist/src/hull/providers/catalog.js');await catalog.refreshCatalog({force:true});
 const model=process.env.HARVEY_MODEL||process.env.HARVEY_SCHEDULE_MODEL||'inception/mercury-2.5';
 let cost=0;
 const run=async(message)=>{const r=await R.runChat(owner,chat,message,{modelOverride:model,maxCostUsd:0.3,onEvent:e=>{if(e.type==='tool')console.log(JSON.stringify({tool:e.name,status:e.status}));}});cost+=r.costUsd||0;console.log(JSON.stringify({model:r.modelUsed,toolRounds:r.toolRounds,review:r.verification?.status,costUsd:r.costUsd,modelError:!!r.modelError,toolFailed:r.toolFailed}));assert(!r.modelError&&!r.budgetRefused);assert(!/NEEDS VERIFICATION/.test(r.speech));assert(!/monte\s+carlo/i.test(r.speech));return r;};
 const plain=await run('Could having two dashboard tabs open cause a problem? Explain briefly; do not use tools.');assert(!plain.needsVerification);
 const unlock=await R.runChat(owner,chat,'monte carlo');assert(!/monte\s+carlo/i.test(unlock.speech));
 const login=await run(`Log in to my test site http://127.0.0.1:${server.address().port}/ using username fixture-user and password fixture-only-42. Use your browser and check the signed-in page. Do not use business tools.`);
 const snap=await B.browserCall(owner,chat.id,'browser_snapshot',{});assert(JSON.stringify(snap).includes('Signed in as fixture-user'),'Browser did not reach signed-in state');assert.equal(login.verification?.status,'completed','Agent did not verify its completed login');
 await B.closeBrowsers();const resumed=await B.browserCall(owner,chat.id,'browser_navigate',{url:`http://127.0.0.1:${server.address().port}/`});assert(JSON.stringify(resumed).includes('Signed in as fixture-user'),'Saved login state did not survive browser restart');
 console.log(JSON.stringify({recoverySmoke:'passed',conversation:true,realModelBrowserLogin:true,persistentSession:true,verification:true,costUsd:cost,externalCustomerAccountsTested:false}));
}finally{clearTimeout(timer);await B.closeBrowsers();await new Promise(r=>server.close(r));S.closeStore();}
