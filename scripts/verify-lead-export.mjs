import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'harvey-export-'));chmodSync(dir,0o755);
for(const k of Object.keys(process.env))if(/API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|HARVEY_WORK_DIR|AI_USAGE_DB_PATH|TENANT_OWNER_ID|DB_JSON_PATH|SHARED_OPENROUTER/.test(k))delete process.env[k];
Object.assign(process.env,{TENANT_DATA_ROOT:dir,HARVEY_WORK_DIR:join(dir,'work'),DOTENV_CONFIG_PATH:join(dir,'no-env'),HARVEY_BROWSER_ENABLED:'true'});
const S=require('../dist/src/harvey/work/store.js'),B=require('../dist/src/harvey/work/browser.js'),R=require('../dist/src/harvey/work/records.js'),F=require('../dist/src/harvey/work/files.js'),{TurnVerification}=require('../dist/src/harvey/reliability.js');
const app=require('express')();
app.get('/',(_req,res)=>res.type('html').send(`<style>body{margin:0}#viewport{height:300px;overflow:auto;width:700px}#space{height:3500px;position:relative}table{position:absolute;width:100%}td{height:25px}</style><h1>40 eligible-to-review leads</h1><div id="viewport" aria-label="Leads"><div id="space"><table aria-rowcount="40"><thead><tr><th>Name</th><th>Source</th></tr></thead><tbody></tbody></table></div></div><script>const pane=document.querySelector('#viewport'),table=document.querySelector('table');pane.addEventListener('scroll',()=>{const page=Math.min(4,Math.floor(pane.scrollTop/600));table.style.top=pane.scrollTop+'px';table.querySelector('tbody').innerHTML=Array.from({length:8},(_,j)=>{const i=page*8+j;return '<tr><td><a href="/people/'+i+'">'+(i===0?'=Formula-like name':'Lead '+i)+'</a></td><td>'+(j===7?'Mojo FL':'Listing Lead')+'</td></tr>'}).join('')});</script>`));
app.use('/api/harvey',require('../dist/src/harvey/work/routes.js').createWorkRouter(req=>req.headers.authorization==='Bearer fixture',req=>req.headers['x-owner']||'alice'));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
const original=global.fetch;global.fetch=(url,...args)=>{assert.equal(new URL(String(url)).hostname,'127.0.0.1');return original(url,...args);};
const chat=S.createChat('alice',{}),v=new TurnVerification();
const call=(tool,args={})=>B.browserCall('alice',chat.id,tool,args);
try{
 await call('browser_navigate',{url:base});
 const tools=await B.browserTools('alice',chat.id);assert(tools.some(t=>t.name==='browser_scroll'));assert(tools.some(t=>t.name==='browser_inspect_scroll_regions'));
 assert.equal((await call('browser_read_table')).rows.length,0,'Reproduce empty rows before scrolling');
 const regions=await call('browser_inspect_scroll_regions');assert(regions.regions.some(r=>r.target==='#viewport'));
 assert((await call('browser_scroll',{target:'#missing'})).error);
 for(let page=0;page<5;page++){
  const moved=await call('browser_scroll',{target:'#viewport',deltaY:page?600:1});assert(moved.moved,JSON.stringify(moved));
  const table=await call('browser_read_table');assert.equal(table.rows.length,8);assert.equal(table.nextOffset,null);assert.equal(table.totalFromAria,'40');
  const receipt=v.record('computer',{action:'call',tool:'browser_read_table'},table);
  const records=table.rows.flatMap((r,i)=>r.cells[1]==='Mojo FL'?[]:[{evidenceId:receipt.id,idPath:`/rows/${i}/id`,fieldPaths:{name:`/rows/${i}/cells/0`,source:`/rows/${i}/cells/1`}}]);
  const input={action:'save',collection:'filtered',_verifiedRecords:v.projectRecords(records)};
  R.workRecords('alice',chat.id,input);R.workRecords('alice',chat.id,input);
  if(page===2)S.closeStore();
 }
 assert.equal(R.workRecords('alice',chat.id,{action:'list',collection:'filtered'}).total,35);
 const exported=R.workRecords('alice',chat.id,{action:'export',collection:'filtered',columns:['name','source']});assert.equal(exported.rows,35);assert.equal(exported.missingByColumn.name,0);
 assert.equal(R.workRecords('alice',chat.id,{action:'export',collection:'filtered',columns:['name','source']}).file,exported.file,'Retry reuses identical export');
 const response=await fetch(base+exported.download,{headers:{authorization:'Bearer fixture'}});assert.equal(response.status,200);const csv=await response.text();assert.equal(csv.trim().split('\r\n').length,36);assert(!csv.includes('Mojo FL'));assert(csv.includes("'=Formula-like name"));
 assert.equal((await fetch(base+exported.download,{headers:{authorization:'Bearer fixture','x-owner':'bob'}})).status,404);
 assert.equal((await fetch(base+exported.download)).status,401);
 assert.throws(()=>R.workRecords('alice',chat.id,{action:'export',collection:'filtered',columns:['unreadNotes']}),/never been observed/);
 const readback=v.record('workspace_files',{},F.workspaceFiles('alice',chat.id));assert(readback.observation);assert(F.workspaceFiles('alice',chat.id).files.some(f=>f.name===exported.file));
 console.log('PASS: empty lazy table -> discover nested scrolling -> retrieve five virtualized batches -> exclude five records -> deduplicate/restart -> verified 35-row CSV -> authenticated download; no screenshots, external services or manual scrolling');
}finally{await B.closeBrowsers();S.closeStore();server.closeAllConnections();await new Promise(r=>server.close(r));global.fetch=original;}
