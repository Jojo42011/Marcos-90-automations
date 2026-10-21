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
const C=require('../dist/src/harvey/work/canvas.js');
let connected=0;
const page=(mode='labeled')=>`<style>
 .node{position:absolute;width:160px;height:180px;background:#ddd;top:130px}.port{position:absolute;width:12px;height:12px;background:blue;top:70px;z-index:10}#source{left:100px}#dest{left:480px}#house{left:280px;top:320px}.source,.react-flow__handle-right{right:-6px}.target,.react-flow__handle-left{left:-6px}#cover{position:absolute;left:470px;top:190px;width:35px;height:35px;background:red;z-index:20;display:none}#state{position:absolute;left:240px;top:40px;margin:0}
 #promo{position:fixed;left:200px;top:140px;width:400px;height:300px;background:#222;color:#fff;z-index:50;padding:16px;display:none}
 </style><h1>Canvas fixture</h1><button onclick="document.querySelector('#dest').style.left='600px'">Move node</button><button onclick="document.querySelector('#cover').style.display='block'">Cover port</button><button onclick="document.querySelector('#promo').style.display='block'">Show promo</button><p id="state">Not merged</p>
 <div id="promo" role="dialog" aria-modal="true"><h2>SwitchX 2.0 &amp; Reframe</h2><p>What's new in SwitchX</p><button aria-label="Close">Got it</button></div>
 <div id="graph" style="transform:scale(0.5);transform-origin:top left">${mode==='unlabeled'?`
 <div class="node react-flow__node" data-id="matte" id="source">Person cutout<div class="port react-flow__handle react-flow__handle-right"></div></div>
 <div class="node react-flow__node" data-id="house" id="house">House background<div class="port react-flow__handle react-flow__handle-right"></div></div>
 <div class="node react-flow__node" data-id="compositor" id="dest">Compositor<div class="port react-flow__handle react-flow__handle-left" data-handlepos="left"></div><div class="port react-flow__handle react-flow__handle-left" data-handlepos="left" style="top:95px"></div><div class="port react-flow__handle react-flow__handle-left" data-handlepos="left" style="top:120px"></div></div>
 `:`
 <div class="node react-flow__node" data-id="matte" id="source">Person cutout<div class="port react-flow__handle source" data-handleid="alpha" aria-label="Matte alpha output"></div></div>
 <div class="node react-flow__node" data-id="house" id="house">House background<div class="port react-flow__handle source" data-handleid="video" aria-label="House video output"></div></div>
 <div class="node react-flow__node" data-id="compositor" id="dest">Compositor<div class="port react-flow__handle target" data-handleid="foreground" aria-label="Compositor foreground input"></div><div class="port react-flow__handle target" data-handleid="background" aria-label="Compositor background input" style="top:120px"></div></div>
 `}<div id="cover"></div></div>
 <script>
 document.querySelector('#promo button')?.addEventListener('click',()=>{document.querySelector('#promo').style.display='none';});

 const edges=new Set(), unlabeled=${mode==='unlabeled'?'true':'false'};
 let selectedEdgeKey=null;
 function sync(){
  document.querySelectorAll('.react-flow__edge').forEach(e=>e.remove());
  let i=0;
  for(const key of edges){
   const [source,target,sh,th]=key.split('|');
   const sEl=document.querySelector('[data-id="'+source+'"]'),tEl=document.querySelector('[data-id="'+target+'"]');
   const edge=document.createElement('div');edge.className='react-flow__edge';edge.dataset.source=source;edge.dataset.target=target;edge.dataset.sourcehandle=sh;edge.dataset.targethandle=th;edge.tabIndex=0;
   if(sEl&&tEl){const sr=sEl.getBoundingClientRect(),tr=tEl.getBoundingClientRect();edge.style.cssText='position:fixed;left:'+((sr.right+tr.left)/2-24)+'px;top:'+((sr.top+tr.top)/2)+'px;width:48px;height:12px;background:orange;z-index:30;';}
   else edge.style.cssText='position:fixed;left:12px;top:'+(420+i*16)+'px;width:48px;height:12px;background:orange;z-index:30;';
   if(key===selectedEdgeKey)edge.style.outline='2px solid red';
   document.body.append(edge);i++;
  }
  const ok=unlabeled?(edges.has('matte|compositor||')||[...edges].some(k=>k.startsWith('matte|compositor')))&&[...edges].some(k=>k.startsWith('house|compositor')):edges.has('matte|compositor|alpha|foreground')&&edges.has('house|compositor|video|background');
  document.querySelector('#state').textContent=ok?'Merged cutout over house':edges.size?'Partially connected':'Not merged';
 }
 let start=null,moves=0,lastX=0,lastY=0;
 function nearestPort(x,y,kind){
  let best=null,bestDist=80;
  const sel=kind==='source'?'.port.react-flow__handle-right, .port.source':'.port.react-flow__handle-left, .port.target';
  for(const el of document.querySelectorAll(sel)){
   const r=el.getBoundingClientRect(),cx=r.x+r.width/2,cy=r.y+r.height/2,d=Math.hypot(cx-x,cy-y);
   if(d<bestDist){best=el;bestDist=d;}
  }
  return best;
 }
 document.addEventListener('mousedown',e=>{
  const edge=e.target.closest('.react-flow__edge');
  if(edge){selectedEdgeKey=[edge.dataset.source,edge.dataset.target,edge.dataset.sourcehandle||'',edge.dataset.targethandle||''].join('|');sync();return;}
  const src=nearestPort(e.clientX,e.clientY,'source');
  if(!src)return;start=src;moves=0;lastX=e.clientX;lastY=e.clientY;
 });
 document.addEventListener('mousemove',e=>{if(start){moves++;lastX=e.clientX;lastY=e.clientY;}});
 document.addEventListener('mouseup',()=>{
  if(!start||moves<3){start=null;return;}
  const target=nearestPort(lastX,lastY,'target');
  if(!target){start=null;return;}
  const sourceNode=start.closest('[data-id]').dataset.id,targetNode=target.closest('[data-id]').dataset.id;
  edges.add([sourceNode,targetNode,start.dataset.handleid||'',target.dataset.handleid||''].join('|'));sync();fetch('/connected');start=null;
 });
 document.addEventListener('keydown',e=>{
  if((e.key==='Delete'||e.key==='Backspace')&&selectedEdgeKey){edges.delete(selectedEdgeKey);selectedEdgeKey=null;sync();}
 });
 </script>`;
const server=http.createServer((req,res)=>{
 if(req.url==='/connected'){connected++;res.end('ok');return;}
 res.setHeader('Content-Type','text/html');
 res.end(page(req.url?.includes('unlabeled')?'unlabeled':'labeled'));
});server.listen(0,'127.0.0.1');await once(server,'listening');
const url='http://127.0.0.1:'+server.address().port;
const unlabeledUrl=url+'/unlabeled';
const call=(name,args={})=>B.browserCall('alice','canvas',name,args);
const inspect=async()=>{const r=await call('browser_inspect_targets');assert(!r.error,JSON.stringify(r));assert(r._image?.data);return r;};
const alphaDrag=r=>({observationId:r.observationId,start:r.targets.find(t=>t.port==='alpha'&&t.direction==='output').id,end:r.targets.find(t=>t.port==='foreground'&&t.direction==='input').id});

// Pure matcher coverage (no browser), including unlabeled Beeble-like slots.
{
 const targets=[
  {id:'t0',label:'Matte alpha output',nodeId:'matte',nodeLabel:'Person cutout',port:'alpha',kind:'port',direction:'output',rect:{x:1,y:1,width:6,height:6},unobstructed:true,selector:'a',slot:0,slotCount:1,slotName:'only'},
  {id:'t1',label:'',nodeId:'compositor',nodeLabel:'Compositor',port:null,kind:'port',direction:'input',rect:{x:2,y:10,width:6,height:6},unobstructed:true,selector:'b',slot:0,slotCount:3,slotName:'top'},
  {id:'t2',label:'',nodeId:'compositor',nodeLabel:'Compositor',port:null,kind:'port',direction:'input',rect:{x:2,y:20,width:6,height:6},unobstructed:true,selector:'c',slot:1,slotCount:3,slotName:'middle'},
  {id:'t3',label:'',nodeId:'compositor',nodeLabel:'Compositor',port:null,kind:'port',direction:'input',rect:{x:2,y:30,width:6,height:6},unobstructed:true,selector:'d',slot:2,slotCount:3,slotName:'bottom'},
  {id:'t4',label:'',nodeId:'house',nodeLabel:'House background',port:null,kind:'port',direction:'output',rect:{x:3,y:3,width:6,height:6},unobstructed:true,selector:'e',slot:0,slotCount:1,slotName:'only'},
 ];
 assert.equal(C.matchCanvasPort(targets,{label:'Matte alpha',direction:'output'}).target.port,'alpha');
 assert.equal(C.matchCanvasPort(targets,{label:'Compositor',role:'foreground',direction:'input'}).target.slotName,'top');
 assert.equal(C.matchCanvasPort(targets,{label:'Compositor',role:'background',direction:'input'}).target.slotName,'bottom');
 assert.equal(C.matchCanvasPort(targets,{nodeId:'compositor',slot:'bottom',direction:'input'}).target.id,'t3');
 const invented=C.matchCanvasPort(targets,{nodeId:'compositor',port:'invented-id',direction:'input'});
 assert.match(invented.error||'',/Ambiguous unlabeled|role|slot/);
 assert.ok((invented.available||[]).length>=3,JSON.stringify(invented.available));
 assert.equal(C.rematchCanvasTarget(targets,{nodeId:'matte',port:'alpha',kind:'port',direction:'output'}).id,'t0');
 assert.equal(C.edgeConnects([{source:'matte',target:'compositor',sourcePort:'alpha',targetPort:'foreground'}],targets[0],targets[1]),true);
 assert.equal(C.edgeConnects([{source:'matte',target:'compositor',sourcePort:'',targetPort:''}],targets[0],targets[1]),true);
 assert.match(C.uncoverPortsCode(['html > body']),/scrollIntoView/);
 assert.match(C.uncoverPortsCode(['html > body']),/harveyClearAbove|pointerEvents/);
 assert.match(C.restoreUncoverCode(),/harveyRestore|harvey-uncover/);
 assert.match(C.dismissCanvasOverlaysCode(),/SwitchX|Escape|Got it/i);
 assert.match(C.disconnectEdgeCode('house','matte'),/Delete/);
 console.log('ok canvas port match/rematch helpers including unlabeled slots');
}

try{
 await call('browser_navigate',{url});
 const grounded=await inspect();
 assert.ok(grounded.graph?.nodes?.some(n=>/Compositor/i.test(n.nodeLabel||'')),JSON.stringify(grounded.graph));
 assert.ok(Array.isArray(grounded.graph?.wires));
 assert.ok(grounded.url&&/127\.0\.0\.1/.test(grounded.url),JSON.stringify({url:grounded.url}));
 // Atomic Beeble-style merges: each connect_ports call inspects+drags+verifies in one round-trip.
 let merge=await call('browser_connect_ports',{start:{label:'Matte alpha',direction:'output'},end:{label:'Compositor foreground',direction:'input'}});
 assert(!merge.error,JSON.stringify({error:merge.error,gesture:merge.gesture,edges:merge.edges}));assert.equal(merge.gesture.connectionVerified,true);assert.equal(connected,1);
 assert.ok(merge.url&&/127\.0\.0\.1/.test(merge.url),'connect_ports must return page url so page identity survives');
 const already=await call('browser_connect_ports',{start:{nodeId:'matte',port:'alpha'},end:{nodeId:'compositor',port:'foreground'}});
 assert.equal(already.alreadyConnected,true);assert.equal(already.gesture.connectionVerified,true);assert.equal(connected,1);
 await call('browser_navigate',{url});connected=0;
 merge=await call('browser_connect_ports',{start:{nodeId:'house',port:'video'},end:{nodeId:'compositor',port:'background',label:'background'}});
 assert(!merge.error,JSON.stringify({error:merge.error,gesture:merge.gesture,edges:merge.edges}));assert.equal(merge.gesture.connectionVerified,true);assert.equal(connected,1);
 assert.equal(merge.edges[0].source,'house');assert.equal(merge.edges[0].targetPort,'background');
 console.log('ok browser_connect_ports merges cutout and house ports with edge verification in one call');

 // Unlabeled Beeble-like compositor: no aria-labels / handle ids; role/slot must resolve ports.
 await call('browser_navigate',{url:unlabeledUrl});connected=0;
 const inspectU=await call('browser_inspect_targets',{nodeIds:['compositor','matte','house']});
 assert(!inspectU.error,JSON.stringify(inspectU));
 const compInputs=inspectU.targets.filter(t=>t.nodeId==='compositor'&&t.direction==='input');
 assert.equal(compInputs.length,3,JSON.stringify(compInputs));
 assert.ok(compInputs.every(t=>!t.label&&(t.port==null||t.port==='')));
 assert.equal(compInputs.find(t=>t.slot===0).slotName,'top');
 merge=await call('browser_connect_ports',{start:{label:'Person cutout',direction:'output'},end:{label:'Compositor',role:'foreground',direction:'input'}});
 assert(!merge.error,JSON.stringify({error:merge.error,availablePorts:merge.availablePorts,gesture:merge.gesture}));assert.equal(merge.gesture.connectionVerified,true);assert.equal(connected,1);
 assert.equal(merge.connectedPorts.end.slotName,'top');
 await call('browser_navigate',{url:unlabeledUrl});connected=0;
 merge=await call('browser_connect_ports',{start:{label:'House',direction:'output'},end:{label:'Compositor',role:'background',direction:'input'}});
 assert(!merge.error,JSON.stringify({error:merge.error,availablePorts:merge.availablePorts,gesture:merge.gesture}));assert.equal(merge.gesture.connectionVerified,true);assert.equal(connected,1);
 assert.equal(merge.connectedPorts.end.slotName,'bottom');
 // Invented Beeble port ids recover when cutout/house semantics identify the compositor slot.
 await call('browser_navigate',{url:unlabeledUrl});connected=0;
 const recovered=await call('browser_connect_ports',{start:{label:'Person cutout',direction:'output'},end:{nodeId:'compositor',port:'totally-invented',direction:'input'}});
 assert(!recovered.error,JSON.stringify({error:recovered.error,availablePorts:recovered.availablePorts,gesture:recovered.gesture}));
 assert.equal(recovered.gesture.connectionVerified,true);assert.equal(recovered.connectedPorts.end.slotName,'top');
 // No semantic role hint → availablePorts lists unlabeled compositor inputs.
 const bad=await call('browser_connect_ports',{start:{port:'nope-out',direction:'output'},end:{port:'nope-in',direction:'input'}});
 assert(bad.error);assert(bad.availablePorts?.length>=3||/Ambiguous unlabeled|role|slot|No visible canvas port/.test(bad.error||''),JSON.stringify({error:bad.error,availablePorts:bad.availablePorts}));
 console.log('ok unlabeled Beeble-like compositor ports match via role/slot and return availablePorts');

 await call('browser_navigate',{url});connected=0;
 let r=await inspect();assert.equal(r.edges.length,0);assert.equal(r.targets.find(t=>t.port==='alpha').rect.width,6);assert(!r.targets.some(t=>t.selector));const drag=alphaDrag(r);
 r=await call('browser_drag_targets',drag);assert(!r.error,JSON.stringify(r));assert.equal(connected,1);assert.equal(r.gesture.connectionVerified,true);assert.equal(r.edges[0].targetPort,'foreground');
 assert((await call('browser_drag_targets',drag)).error,'Old observation cannot replay a write');assert.equal(connected,1);
 console.log('ok real pointer events connect six-pixel ports at 50% canvas zoom; edge sets connectionVerified');

 // Time-expired observation rematches once by port identity (model latency without an intervening write).
 await call('browser_navigate',{url});connected=0;
 r=await inspect();const aged=alphaDrag(r);
 B.__setCanvasObservationTtlMs(1);await new Promise(res=>setTimeout(res,5));
 const refreshed=await call('browser_drag_targets',aged);
 B.__setCanvasObservationTtlMs(30000);
 assert(!refreshed.error,JSON.stringify({error:refreshed.error,gesture:refreshed.gesture,refreshed:refreshed.observationRefreshed}));assert.equal(refreshed.observationRefreshed,true);assert.equal(refreshed.gesture.connectionVerified,true);assert.equal(connected,1);
 console.log('ok time-expired drag rematches port identity on a fresh inspect');

 // An intervening write clears the observation; stale IDs cannot rematch after that.
 await call('browser_navigate',{url});connected=0;
 r=await inspect();const afterWrite=alphaDrag(r);
 await call('browser_click',{target:'button:has-text("Move node")'});
 assert((await call('browser_drag_targets',afterWrite)).error,'Write clears canvas observation');assert.equal(connected,0);

 // Overlay covering a port: force-uncover clears pointer-events so the wire still completes.
 await call('browser_navigate',{url});connected=0;
 await call('browser_click',{target:'button:has-text("Cover port")'});
 const throughCover=await call('browser_connect_ports',{start:{label:'Matte alpha',direction:'output'},end:{label:'Compositor foreground',direction:'input'}});
 assert(!throughCover.error,JSON.stringify({error:throughCover.error,gesture:throughCover.gesture}));
 assert.equal(throughCover.gesture.connectionVerified,true);assert.equal(connected,1);
 console.log('ok covered ports are force-uncovered and still connect with verification');

 // Beeble-style promo modal: dismiss then connect.
 await call('browser_navigate',{url});connected=0;
 await call('browser_click',{target:'button:has-text("Show promo")'});
 const throughPromo=await call('browser_connect_ports',{start:{label:'Matte alpha',direction:'output'},end:{label:'Compositor foreground',direction:'input'}});
 assert(!throughPromo.error,JSON.stringify({error:throughPromo.error,gesture:throughPromo.gesture,overlays:throughPromo.overlaysDismissed}));
 assert.equal(throughPromo.gesture.connectionVerified,true);assert.equal(connected,1);
 console.log('ok SwitchX-style promo modal is dismissed and connect still verifies');

 // Disconnect a wrong matte feed, then wire house→background.
 await call('browser_navigate',{url});connected=0;
 await call('browser_connect_ports',{start:{nodeId:'house',port:'video'},end:{nodeId:'compositor',port:'background',label:'background'}});
 const cut=await call('browser_disconnect_edge',{sourceNodeId:'house',targetNodeId:'compositor'});
 assert.equal(cut.disconnected,true,JSON.stringify(cut));
 assert.ok(!(cut.edges||[]).some(e=>e.source==='house'&&e.target==='compositor'),JSON.stringify(cut.edges));
 console.log('ok browser_disconnect_edge removes an observed wire');

 const wrongOwner=await B.browserCall('bob','canvas','browser_drag_targets',alphaDrag(await inspect()));assert(wrongOwner.error);
 const tools=await B.browserTools('alice','canvas');assert(tools.some(t=>t.name==='browser_connect_ports'));assert(tools.some(t=>t.name==='browser_disconnect_edge'));assert(!tools.some(t=>/evaluate|unsafe/.test(t.name)));
 await assert.rejects(()=>call('browser_run_code_unsafe',{code:'() => 1'}),/Unsupported browser action/);
 console.log('ok owner isolation and arbitrary-code boundary');
}
finally{B.__setCanvasObservationTtlMs(30000);await B.closeBrowsers();server.closeAllConnections();await new Promise(r=>server.close(r));}
