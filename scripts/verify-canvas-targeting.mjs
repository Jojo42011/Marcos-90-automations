import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
const require=createRequire(import.meta.url);
process.env.HARVEY_WORK_DIR=mkdtempSync(join(tmpdir(),'harvey-canvas-'));
chmodSync(process.env.HARVEY_WORK_DIR,0o755);
process.env.HARVEY_BROWSER_ENABLED='true';
const B=require('../dist/src/harvey/work/browser.js');
let connected=0;
const server=http.createServer((req,res)=>{
 if(req.url==='/connected'){connected++;res.end('ok');return;}
 res.setHeader('Content-Type','text/html');res.end(`<style>
 .node{position:absolute;width:160px;height:180px;background:#ddd;top:130px}.port{position:absolute;width:12px;height:12px;background:blue;top:70px}#source{left:100px}#dest{left:480px}.source{right:-6px}.target{left:-6px}#cover{position:absolute;left:470px;top:190px;width:35px;height:35px;background:red;z-index:5;display:none}
 </style><h1>Canvas fixture</h1><button onclick="document.querySelector('#dest').style.left='600px'">Move node</button><button onclick="document.querySelector('#cover').style.display='block'">Cover port</button>
 <div id="graph" style="transform:scale(0.5);transform-origin:top left"><div class="node react-flow__node" data-id="matte" id="source">Person cutout<div class="port react-flow__handle source" data-handleid="alpha" aria-label="Matte alpha output"></div></div>
 <div class="node react-flow__node" data-id="switch" id="dest">SwitchX<div class="port react-flow__handle target" data-handleid="alpha" aria-label="SwitchX alpha input"></div><p id="state">Alpha not connected</p></div><div id="cover"></div></div>
 <script>let start=false,moves=0;document.querySelector('.source').addEventListener('mousedown',()=>{start=true;moves=0});document.addEventListener('mousemove',()=>{if(start)moves++});document.addEventListener('mouseup',e=>{if(start&&e.target.matches('.target')&&moves>=10){document.querySelector('#state').textContent='Alpha connected from matte';let edge=document.createElement('div');edge.className='react-flow__edge';edge.dataset.source='matte';edge.dataset.target='switch';edge.dataset.sourcehandle='alpha';edge.dataset.targethandle='alpha';document.body.append(edge);fetch('/connected');}start=false;});</script>`);
});server.listen(0,'127.0.0.1');await once(server,'listening');
const url='http://127.0.0.1:'+server.address().port;
const call=(name,args={})=>B.browserCall('alice','canvas',name,args);
const inspect=async()=>{const r=await call('browser_inspect_targets');assert(!r.error,JSON.stringify(r));assert(r._image?.data);return r;};
const inputs=r=>({observationId:r.observationId,start:r.targets.find(t=>t.port==='alpha'&&t.direction==='output').id,end:r.targets.find(t=>t.port==='alpha'&&t.direction==='input').id});
try{
 await call('browser_navigate',{url});
 let r=await inspect();assert.equal(r.edges.length,0);assert.equal(r.targets.find(t=>t.port==='alpha').rect.width,6);assert(!r.targets.some(t=>t.selector));const drag=inputs(r);
 r=await call('browser_drag_targets',drag);assert(!r.error,JSON.stringify(r));assert.equal(connected,1);assert.equal(r.gesture.connectionVerified,false);assert.equal(r.edges[0].targetPort,'alpha');
 assert.match(JSON.stringify(r.targets),/Alpha connected from matte/);
 assert((await call('browser_drag_targets',drag)).error,'Old observation cannot replay a write');assert.equal(connected,1);
 console.log('ok real pointer events connect six-pixel ports at 50% canvas zoom; read-back distinguishes gesture from connection');
 r=await inspect();const stale=inputs(r);await call('browser_click',{target:'button:has-text("Move node")'});
 assert((await call('browser_drag_targets',stale)).error);assert.equal(connected,1);
 await call('browser_navigate',{url});await call('browser_click',{target:'button:has-text("Cover port")'});r=await inspect();
 const covered=await call('browser_drag_targets',inputs(r));assert.equal(covered.recovery.actionOutcome,'not_executed');assert.match(covered.error,/obscured/);assert.equal(connected,1);
 console.log('ok moved/covered targets fail before mouse-down; no duplicate connection');
 const wrongOwner=await B.browserCall('bob','canvas','browser_drag_targets',inputs(r));assert(wrongOwner.error);assert.equal(connected,1);
 const tools=await B.browserTools('alice','canvas');assert(!tools.some(t=>/evaluate|unsafe/.test(t.name)));
 await assert.rejects(()=>call('browser_run_code_unsafe',{code:'() => 1'}),/Unsupported browser action/);
 console.log('ok owner isolation and arbitrary-code boundary');
}
finally{await B.closeBrowsers();server.closeAllConnections();await new Promise(r=>server.close(r));}
