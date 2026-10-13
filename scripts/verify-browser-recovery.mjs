import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
process.env.HARVEY_BROWSER_ENABLED='true';
process.env.HARVEY_WORK_DIR=mkdtempSync(join(tmpdir(),'harvey-recovery-'));
const B=require('../dist/src/harvey/work/browser.js');
const {TurnVerification}=require('../dist/src/harvey/reliability.js');
let writes=0;
const server=http.createServer((req,res)=>{
 res.setHeader('Content-Type','text/html');
 if(req.url==='/write'){if(req.method==='POST')writes++;res.end('<h1>Saved exactly once</h1>');return;}
 if(req.url==='/login')res.setHeader('Set-Cookie','fixture_session=valid; HttpOnly; SameSite=Lax; Path=/');
 if(req.url==='/second'){res.end('<h1>Second tab '+(req.headers.cookie?.includes('fixture_session=valid')?'authenticated':'signed out')+'</h1>');return;}
 if(req.url==='/frame'){res.end('<button onclick="this.textContent=\'Frame done\'">Frame action</button>');return;}
 res.end(`<h1>Recovery fixture</h1><button id="one" onclick="this.textContent='Clicked once'">Unique action</button><button>Duplicate</button><button>Duplicate</button>
 <form action="/write" method="POST"><input id="first" aria-label="First"><input id="second" aria-label="Second"><button>Save record</button></form>
 <iframe src="/frame" title="Fixture frame"></iframe><canvas width="150" height="60" style="display:block" onclick="document.querySelector('#visual-status').textContent='Visual action done'"></canvas><p id="visual-status">Visual control ready</p>
 <section id="results">${Array.from({length:500},(_,i)=>'<p id="row'+i+'">Record '+i+' descriptive fixture text</p>').join('')}</section>`);
});server.listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port;
const call=(tool,args={})=>B.browserCall('alice','recovery',tool,args);
const txt=r=>JSON.stringify(r);
try{
 const started=Date.now();let r=await call('browser_navigate',{url:base+'/login'});assert(!r.error,txt(r));
 const baseline=await B.browserMetrics('alice','recovery');
 r=await call('browser_snapshot',{target:'#one'});assert(!r.error,txt(r));
 const before=await B.browserMetrics('alice','recovery');
 assert.equal(before.checkpoints,baseline.checkpoints,'Read-only snapshot must not save browser storage');
 r=await call('browser_click',{selector:'#one'});assert(!r.error,txt(r));
 const after=await B.browserMetrics('alice','recovery');
 assert.equal(after.preflights,before.preflights,'Fresh observation avoids duplicate preflight');
 assert.equal(after.calls-before.calls,1,'One MCP call for an observed click');
 console.log('ok fresh click uses one MCP call; reads skip storage export');
 r=await call('browser_snapshot',{target:'#absent-snapshot-target'});assert(!r.error,txt(r));assert(r.recovered);assert.match(txt(r),/Recovery fixture/);assert.equal(writes,0);
 console.log('ok failed targeted snapshot recovers with whole-page evidence without writes');
 r=await call('browser_click',{target:'missing999'});assert.equal(r.recovery.actionOutcome,'not_executed');assert(r.observation);
 r=await call('browser_click',{target:'button:has-text("Duplicate")'});assert.equal(r.recovery.actionOutcome,'not_executed');assert.equal(writes,0);
 console.log('ok stale and ambiguous targets return fresh recovery evidence without submitting');
 r=await call('browser_fill_form',{fields:[{name:'First',type:'textbox',target:'#first',value:'alpha'},{name:'Second',type:'textbox',target:'#second',value:'beta'}]});assert(!r.error,txt(r));
 r=await call('browser_snapshot',{target:'form'});assert.match(txt(r),/alpha/);assert.match(txt(r),/beta/);
 r=await call('browser_fill_form',{fields:[{name:'First',type:'textbox',target:'#first',value:'partly changed'},{name:'Missing',type:'textbox',target:'#absent',value:'never'}]});
 assert.equal(r.recovery.actionOutcome,'unknown');assert.equal(r.recovery.safeToRetry,false);
 r=await call('browser_snapshot',{target:'form'});assert.match(txt(r),/partly changed/);assert.match(txt(r),/beta/);
 r=await call('browser_snapshot',{});assert(r.truncated);let all=txt(r);let pages=1;
 while(r.nextOffset!==null){r=await call('browser_read_snapshot',{snapshotId:r.snapshotId,offset:r.nextOffset});all+=txt(r);pages++;assert(pages<20);}
 assert.match(all,/Record 499/);r=await call('browser_snapshot',{target:'#row499'});assert(!r.truncated);assert.match(txt(r),/Record 499/);
 console.log('ok multi-field fill and bounded full-page retrieval preserve the last record');
 r=await call('browser_snapshot',{depth:4});let raw=r.content.map(x=>x.text).join('\n');let frameRef=raw.match(/button "Frame action" \[ref=([^\]]+)\]/)?.[1];
 if(!frameRef){r=await call('browser_snapshot',{target:'iframe'});raw=r.content.map(x=>x.text).join('\n');frameRef=raw.match(/button "Frame action" \[ref=([^\]]+)\]/)?.[1];}
 assert(frameRef,'Iframe must expose its control');r=await call('browser_click',{target:frameRef});assert(!r.error,txt(r));
 r=await call('browser_take_screenshot');assert(r._image?.data.length>1000,'Model gets real pixels: '+JSON.stringify(r).slice(0,2500));
 const ledger=new TurnVerification();const receipt=ledger.record('computer',{action:'call',tool:'browser_take_screenshot'},r);assert(!receipt.truncated,'Image bytes are not text truncation');
 assert((await B.browserTools('alice','recovery')).some(t=>t.name==='browser_mouse_click_xy'));
 assert(!(await B.browserTools('alice','recovery')).some(t=>t.name==='browser_run_code_unsafe'));
 assert(JSON.stringify(await B.browserTools('alice','recovery')).length<10000,'Tool catalog must fit model result budget');
 assert((await B.browserTools('alice','recovery','browser_click'))[0].inputSchema);
 console.log('ok iframe targets, model-visible pixels and restricted visual tools');
 await call('browser_tabs',{action:'new',url:base+'/second'});
 assert.equal(JSON.parse(readFileSync(join(B.browserDirectory('alice','recovery'),'tabs.json'),'utf8')).urls.length,2,'Repeated MCP tab sections must not duplicate retained tabs');
 await call('browser_tabs',{action:'select',index:0});
 await B.closeBrowsers();
 r=await call('browser_snapshot',{target:'h1'});assert.match(txt(r),/Recovery fixture/);
 r=await call('browser_tabs',{action:'list'});assert.match(txt(r),/second/);assert.match(txt(r),/0: \(current\)/);
 await call('browser_tabs',{action:'select',index:1});r=await call('browser_snapshot',{target:'h1'});assert.match(txt(r),/authenticated/);
 const other=await B.browserCall('bob','recovery','browser_navigate',{url:base+'/second'});assert.match(txt(other),/signed out/);
 console.log('ok two tabs, selected tab and session-only cookie restored; another owner stays signed out');
 await call('browser_tabs',{action:'select',index:0});
 r=await call('browser_click',{target:'button:has-text("Save record")'});assert(!r.error,txt(r));assert.equal(writes,1);
 await B.closeBrowsers();r=await call('browser_recover');assert(!r.error,txt(r));assert.equal(writes,1,'Recovery must not replay form submission');
 assert.match(txt(r),/Saved exactly once/);
 const retainedPath=join(B.browserDirectory('alice','recovery'),'tabs.json'),retained=readFileSync(retainedPath,'utf8');
 r=await call('browser_navigate',{url:'http://127.0.0.1:1/unreachable'});assert(r.error);
 await B.closeBrowsers();assert.equal(readFileSync(retainedPath,'utf8'),retained,'Failed-page diagnostics must not overwrite the last retained tabs');
 r=await call('browser_recover');assert(!r.error,txt(r));assert.match(txt(r),/Saved exactly once/);assert.equal(writes,1);
 console.log('ok recovery reloads saved tabs without repeating a completed submission');
 await B.closeBrowser('alice','recovery');assert.equal((await B.browserPreview('alice','recovery')).state,'closed');
 // Force a checkpoint publication failure after a successful navigation. It must not become an action failure.
 const dir=B.browserDirectory('alice','save-warning');mkdirSync(join(dir,'auth-state.json.pending'));
 r=await B.browserCall('alice','save-warning','browser_navigate',{url:base+'/second'});assert(!r.error,txt(r));assert(r.persistenceWarning);
 rmdirSync(join(dir,'auth-state.json.pending'));
 console.log('ok checkpoint failure is separate from action outcome; explicit Close remains closed');
 assert.equal(writes,1);console.log(JSON.stringify({elapsedMs:Date.now()-started,clickMcpCalls:after.calls-before.calls,snapshotPages:pages,fixtureWrites:writes}));
}finally{await B.closeBrowsers();server.closeAllConnections();await new Promise(r=>server.close(r));}
