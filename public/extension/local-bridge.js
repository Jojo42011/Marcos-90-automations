/* Trusted Harvey origin only. The page retains its own authenticated session; no API keys are copied. */
(()=>{
 const origin=location.origin,channel='harvey-my-browser-v1';let port;
 function connect(){if(port)return;port=chrome.runtime.connect({name:'harvey-local-v1'});port.onMessage.addListener(data=>window.postMessage({channel,direction:'extension',...data},origin));port.onDisconnect.addListener(()=>{port=null;window.postMessage({channel,direction:'extension',event:'stopped',reason:'Extension disconnected'},origin);});}
 window.addEventListener('message',e=>{if(e.source!==window||e.origin!==origin||e.data?.channel!==channel||e.data.direction!=='page')return;try{connect();port.postMessage(e.data);}catch{window.postMessage({channel,direction:'extension',id:e.data.id,ok:false,error:'Extension unavailable'},origin);}});
 window.addEventListener('pagehide',()=>{port?.disconnect();port=null;});
})();
