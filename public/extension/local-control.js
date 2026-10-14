/* Account/chat-scoped connection from the signed-in Harvey page. The legacy bus is separate. */
let localSession=null,localStarting=null;
self.harveyLocalSessionActive=()=>!!localSession||!!localStarting;
const localAppOrigins=new Set(['https://marco-90-automation.fly.dev']);
function safeLocalUrl(value){const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||localAppOrigins.has(u.origin))throw Error('Choose a website, not Harvey or a browser settings page.');return u.href;}
async function stopLocal(reason='Control stopped'){
 const s=localSession;localSession=null;if(!s)return;
 s.stopped=true;clearInterval(s.watchdog);
 if(s.attached)try{await chrome.debugger.detach({tabId:s.tabId});}catch{}
 try{s.port.postMessage({event:'stopped',reason,connectionId:s.connectionId});}catch{}
 if(!localSession)await chrome.action.setBadgeText({text:''});
}
function checkLocal(s){if(localSession!==s||s.stopped||Date.now()-s.lastSeen>30000)throw Error('Browser control is disconnected');}
async function localCdp(s,method,params={}){checkLocal(s);return chrome.debugger.sendCommand({tabId:s.tabId},method,params);}
async function localProbe(s,args,frameId=0,documentId){checkLocal(s);const target={tabId:s.tabId,...(documentId?{documentIds:[documentId]}:{frameIds:[frameId]})};const r=await chrome.scripting.executeScript({target,func:localPageProbe,args:[args],world:'ISOLATED'});checkLocal(s);if(r[0]?.result==null)throw Error(r[0]?.error?.message||'Page operation refused or target unavailable. Inspect the page; sign-in and sensitive fields require the user.');return r[0].result;}
async function localSnapshot(s,args={}){
 checkLocal(s);const nonce=crypto.randomUUID();s.refs=new Map();
 const results=await chrome.scripting.executeScript({target:{tabId:s.tabId,allFrames:true},func:localPageProbe,args:[{action:'observe',nonce,offset:args.offset}],world:'ISOLATED'});
 checkLocal(s);const frames=[];
 for(const r of results){if(!r.result)continue;const controls=r.result.controls.map(c=>{const ref=r.frameId+':'+c.ref;s.refs.set(ref,{target:c.ref,nonce,frameId:r.frameId,documentId:r.documentId,at:Date.now(),rect:c.rect});return {...c,ref};});frames.push({...r.result,frame:String(r.frameId),controls});}
 const main=frames.find(f=>f.frame==='0');
 return {title:main?.title,url:main?.url,frames,note:'Frames are labeled separately. Read requested pagination/scroll regions to establish full coverage.'};
}
function localRef(s,ref){const r=s.refs?.get(ref);if(!r||Date.now()-r.at>30000)throw Error('Inspect a fresh snapshot and use a returned reference');return r;}
async function localRefAction(s,ref,action,args={}){const r=localRef(s,ref);return localProbe(s,{...args,action,target:r.target,nonce:r.nonce},r.frameId,r.documentId);}
async function localShot(s){const shot=await localCdp(s,'Page.captureScreenshot',{format:'jpeg',quality:65,fromSurface:true,captureBeyondViewport:false});const metrics=await localProbe(s,{action:'observe',nonce:crypto.randomUUID()});s.refs=new Map();s.vision={at:Date.now(),...await localProbe(s,{action:'viewport'})};return {title:metrics.title,url:metrics.url,_image:{media_type:'image/jpeg',data:shot.data},viewport:metrics.viewport};}
async function localMouse(s,type,x,y,extra={}){return localCdp(s,'Input.dispatchMouseEvent',{type,x,y,...extra});}
async function localClick(s,x,y){await localMouse(s,'mouseMoved',x,y);try{await localMouse(s,'mousePressed',x,y,{button:'left',clickCount:1});}finally{if(localSession===s)await localMouse(s,'mouseReleased',x,y,{button:'left',clickCount:1});}}
async function localDrag(s,start,end){await localMouse(s,'mouseMoved',start.x,start.y);try{await localMouse(s,'mousePressed',start.x,start.y,{button:'left',buttons:1,clickCount:1});for(let i=1;i<=24;i++){await new Promise(r=>setTimeout(r,12));await localMouse(s,'mouseMoved',start.x+(end.x-start.x)*i/24,start.y+(end.y-start.y)*i/24,{button:'left',buttons:1});}}finally{if(localSession===s)await localMouse(s,'mouseReleased',end.x,end.y,{button:'left',clickCount:1});}}
async function localKey(s,key){const allowed={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34};if(!allowed[key])throw Error('Unsupported key');await localProbe(s,{action:'keyboardGuard'});await localCdp(s,'Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:allowed[key]});await localCdp(s,'Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:allowed[key]});}
async function executeLocal(s,cmd){
 checkLocal(s);if(!s.ready||cmd.connectionId!==s.connectionId||!cmd.id||s.executed.has(cmd.id)||Date.now()>cmd.expiresAt)throw Error('Command expired or already executed');
 if(s.busy)throw Error('A browser action is already running');s.executed.add(cmd.id);s.busy=true;
 if(s.executed.size>500)await stopLocal('Session action limit reached. Reconnect.');
 let acted=false;
 try{
  checkLocal(s);const tab=await chrome.tabs.get(s.tabId);safeLocalUrl(tab.url);const a=cmd.args||{},name=cmd.tool;
  if(name==='browser_tabs'){if(a.action==='select')await chrome.tabs.update(s.tabId,{active:true});return {tabs:[{title:tab.title,url:tab.url,connected:true}]};}
  if(name==='browser_snapshot')return await localSnapshot(s,a);
  if(name==='browser_take_screenshot')return await localShot(s);
  if(name==='browser_inspect_targets'){const shot=await localShot(s),snapshot=await localSnapshot(s);return {...snapshot,...shot,note:'Use the fresh refs for drag targets. Verify resulting graph edges/inputs; a gesture alone is not completion.'};}
  if(name==='browser_read_table')return await localRefAction(s,a.target,'table',{offset:a.offset});
  if(name==='browser_navigate'){safeLocalUrl(a.url);s.refs=new Map();s.vision=null;acted=true;await chrome.tabs.update(s.tabId,{url:a.url});await waitForLoad(s.tabId,12000);}
  else if(name==='browser_navigate_back'){acted=true;await chrome.tabs.goBack(s.tabId);await waitForLoad(s.tabId,10000);}
  else if(name==='browser_click'||name==='browser_hover'){
   const r=localRef(s,a.target);const p=await localRefAction(s,a.target,'geometry');acted=true;
   if(r.frameId!==0){if(name==='browser_hover')throw Error('Hover in this frame is unavailable; use its visible controls');await localRefAction(s,a.target,'frameClick');}
   else if(name==='browser_click')await localClick(s,p.x,p.y);else await localMouse(s,'mouseMoved',p.x,p.y);
  }
  else if(name==='browser_type'){acted=true;await localRefAction(s,a.target,'fill',{value:String(a.text??'')});if(a.submit)await localKey(s,'Enter');}
  else if(name==='browser_fill_form'){if(!Array.isArray(a.fields)||a.fields.length>20)throw Error('Use at most 20 fields');for(const f of a.fields){acted=true;await localRefAction(s,f.target,'fill',{value:String(f.value??'')});}}
  else if(name==='browser_select_option'){if(!Array.isArray(a.values)||a.values.length>20)throw Error('Invalid option values');acted=true;await localRefAction(s,a.target,'select',{values:a.values});}
  else if(name==='browser_press_key'){acted=true;await localKey(s,a.key);}
  else if(name==='browser_scroll'){const deltaY=Math.max(-2000,Math.min(2000,Number(a.deltaY)||600)),deltaX=Math.max(-2000,Math.min(2000,Number(a.deltaX)||0));acted=true;if(a.target)await localRefAction(s,a.target,'scroll',{deltaY,deltaX});else await localProbe(s,{action:'scroll',deltaY,deltaX});}
  else if(name==='browser_drag_targets'){
   const r1=localRef(s,a.start),r2=localRef(s,a.end);if(r1.frameId||r2.frameId)throw Error('Use screenshot coordinates for cross-frame gestures');
   const p1=await localRefAction(s,a.start,'geometry'),p2=await localRefAction(s,a.end,'geometry'),check=await localRefAction(s,a.start,'geometry',{scroll:false}),check2=await localRefAction(s,a.end,'geometry',{scroll:false});if(Math.abs(check.x-p1.x)>2||Math.abs(check.y-p1.y)>2||Math.abs(check2.x-p2.x)>2||Math.abs(check2.y-p2.y)>2)throw Error('Targets moved; inspect again');acted=true;await localDrag(s,p1,p2);
  }
  else if(name==='browser_mouse_click_xy'||name==='browser_mouse_drag_xy'){
   if(!s.vision||Date.now()-s.vision.at>30000)throw Error('Take a fresh screenshot first');
   const viewport=await localProbe(s,{action:'viewport'});for(const key of ['width','height','x','y','url'])if(viewport[key]!==s.vision[key])throw Error('Viewport changed; take a fresh screenshot');
   const points=name==='browser_mouse_click_xy'?[{x:a.x,y:a.y}]:[{x:a.startX,y:a.startY},{x:a.endX,y:a.endY}];
   for(const p of points)if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>=s.vision.width||p.y>=s.vision.height)throw Error('Coordinates outside captured viewport');
   acted=true;s.vision=null;if(points.length===1)await localClick(s,points[0].x,points[0].y);else await localDrag(s,...points);
  }
  else if(name==='browser_wait_for'){const seconds=Number(a.time??1);if(!Number.isFinite(seconds)||seconds<0||seconds>10)throw Error('Wait must be 0–10 seconds');await new Promise(r=>setTimeout(r,seconds*1000));}
  else throw Error('Unsupported local browser action');
  checkLocal(s);s.vision=null;await new Promise(r=>setTimeout(r,200));
  try{return {...await localSnapshot(s),actionCompleted:acted,note:'Inspect the returned page and destination to verify the requested result.'};}
  catch{return {actionCompleted:acted,needsObservation:true,note:'The action returned, but page observation failed. Inspect before retrying; do not repeat the action blindly.'};}
 }catch(e){return {error:e.message,recovery:{actionOutcome:acted?'unknown':'not_executed',safeToRetry:!acted}};}
 finally{s.busy=false;}
}
chrome.runtime.onConnect.addListener(port=>{
 if(port.name!=='harvey-local-v1')return;
 let origin;try{origin=new URL(port.sender.url).origin;}catch{port.disconnect();return;}
 if(!localAppOrigins.has(origin)||!port.sender.tab){port.disconnect();return;}
 port.onDisconnect.addListener(()=>{if(localStarting===port)localStarting=null;if(localSession?.port===port)void stopLocal('Harvey tab disconnected');});
 port.onMessage.addListener(async msg=>{
  const reply=value=>{try{port.postMessage({id:msg.id,...value});}catch{}};
  try{
   if(msg.action==='ping'){reply({ok:true,version:chrome.runtime.getManifest().version});return;}
   if(msg.action==='start'){
    if(localSession||localStarting)throw Error('Another Harvey chat already controls a tab. Stop that connection first.');
    localStarting=port;
    try {
    const cfg=await config();if(self.harveyLegacyBusy)throw Error('Wait for the legacy browser action to finish.');if(cfg.enabled)throw Error('Turn off legacy extension control before using the chat connection.');
    const url=safeLocalUrl(msg.url),tab=await chrome.tabs.create({url,active:true});
    const s={port,tabId:tab.id,connectionId:msg.connectionId,ready:false,lastSeen:Date.now(),executed:new Set(),refs:new Map()};if(localStarting!==port){await chrome.tabs.remove(tab.id);throw Error('Harvey disconnected while opening the tab');}localSession=s;
    s.watchdog=setInterval(()=>{if(Date.now()-s.lastSeen>30000)void stopLocal('Connection lost; control stopped');},5000);
    reply({ok:true,tabId:tab.id});return;
    }finally{if(localStarting===port)localStarting=null;}
   }
   const s=localSession;if(!s||s.port!==port||msg.connectionId!==s.connectionId)throw Error('This chat has no connected browser');s.lastSeen=Date.now();
   if(msg.action==='heartbeat'){reply({ok:true,ready:s.ready});return;}
   if(msg.action==='stop'){await stopLocal();reply({ok:true});return;}
   if(msg.action==='focus'){await chrome.tabs.update(s.tabId,{active:true});reply({ok:true});return;}
   if(msg.action==='ready'){
    if(s.ready){reply({ok:true});return;}
    safeLocalUrl((await chrome.tabs.get(s.tabId)).url);await chrome.debugger.attach({tabId:s.tabId},'1.3');s.attached=true;if(localSession!==s){try{await chrome.debugger.detach({tabId:s.tabId});}catch{}throw Error('Connection stopped while attaching');}
    await localCdp(s,'Page.enable');s.ready=true;await chrome.action.setBadgeText({text:'LIVE'});await chrome.action.setBadgeBackgroundColor({color:'#177a67'});reply({ok:true});return;
   }
   if(msg.action==='command'){const result=await executeLocal(s,msg.command);reply({ok:true,result});return;}
   throw Error('Unknown connection action');
  }catch(e){reply({ok:false,error:e.message});}
 });
});
chrome.tabs.onRemoved.addListener(id=>{if(localSession?.tabId===id)void stopLocal('Connected tab closed');});
chrome.debugger.onDetach.addListener(source=>{if(localSession?.tabId===source.tabId)void stopLocal('Chrome detached browser control');});
chrome.debugger.onEvent.addListener((source,method)=>{const s=localSession;if(s?.tabId===source.tabId&&method==='Page.frameNavigated'){s.refs=new Map();s.vision=null;}});
chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{if(msg?.type==='harvey:local-status'){reply({active:!!localSession});return;}if(msg?.type==='harvey:local-stop'){stopLocal().then(()=>reply({ok:true}));return true;}});
