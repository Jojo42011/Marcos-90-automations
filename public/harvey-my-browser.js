(function(){
 'use strict';
 const channel='harvey-my-browser-v1',pending=new Map();let h,session=null,selected=false,currentChat=null,epoch=0,statusAt=0,checking=false,remoteConnected=false;
 const $=id=>document.getElementById(id);
 function say(text){$('localBrowserStatus').textContent=text;}
 function bridge(action,data={},timeout=5000){return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('Harvey extension is not responding. Install or enable it, then reload Harvey.'));},timeout);pending.set(id,{resolve,reject,timer});window.postMessage({channel,direction:'page',id,action,...data},location.origin);});}
 window.addEventListener('message',e=>{if(e.source!==window||e.origin!==location.origin||e.data?.channel!==channel||e.data.direction!=='extension')return;const data=e.data;if(data.event==='stopped'){void stop(data.reason||'Control stopped');return;}const p=pending.get(data.id);if(!p)return;pending.delete(data.id);clearTimeout(p.timer);data.ok?p.resolve(data):p.reject(Error(data.error||'Browser action failed'));});
 async function request(chat,action,body={}){
  const r=await fetch(h.apiUrl('/api/harvey/work/browser/'+encodeURIComponent(chat)+'/local/'+action),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-harvey-browser':'1'},body:JSON.stringify(body),cache:'no-store'});
  const data=await r.json();if(!r.ok)throw Error(data.error||'Browser connection unavailable');return data;
 }
 function paint(){
  $('myBrowserOpen').hidden=h.state.view!=='chat';$('myBrowserOpen').classList.toggle('connected',!!session?.ready);$('myBrowserOpen').setAttribute('aria-pressed',String(selected));
  $('localBrowserCard').hidden=!selected;
  document.querySelector('#computerPanel .computer-eyebrow').textContent=selected?'Your browser · this chat only':'This chat’s hosted browser';
  for(const el of document.querySelectorAll('#computerPanel > .computer-card,#computerPanel > .computer-tools,#computerActivity,#computerCaptured,#computerPanel > .computer-footnote'))el.hidden=selected;
  $('localBrowserReady').hidden=!session||session.ready;$('localBrowserFocus').hidden=!session;$('localBrowserStop').hidden=!session&&!remoteConnected;
  $('localBrowserReconnect').hidden=!!session;
 }
 async function stop(reason='Control stopped. Your tab stays open.'){
  const s=session;session=null;remoteConnected=false;epoch++;if(s){clearInterval(s.heartbeat);void bridge('stop',{connectionId:s.connectionId}).catch(()=>{});void request(s.chat,'stop',{token:s.token}).catch(()=>{});}say(reason);paint();
 }
 async function relay(s){
  while(session===s){
   try{
    await bridge('heartbeat',{connectionId:s.connectionId});
    const r=await request(s.chat,'poll',{token:s.token,ready:s.ready});
    if(session!==s)return;
    if(r.command){
     const result=await bridge('command',{connectionId:s.connectionId,command:r.command},30000);
     if(session!==s)return;
     await request(s.chat,'result',{token:s.token,id:r.command.id,result:result.result});
     if(result.result._image?.media_type==='image/jpeg'){const image=$('localBrowserImage');image.src='data:image/jpeg;base64,'+result.result._image.data;image.hidden=false;}
     $('localBrowserSite').textContent=result.result.title||result.result.url||'Connected tab';
     say(result.result.error?'Needs attention: '+result.result.error:'Connected · Harvey can work in this tab');
    }
   }catch(e){if(session===s)await stop(e.message);return;}
  }
 }
 async function openDialog(){
  $('myBrowserDialog').showModal();$('myBrowserMessage').textContent='Checking your Harvey extension…';$('myBrowserConnect').disabled=true;
  try{await bridge('ping');$('myBrowserMessage').textContent='Open a site, sign in yourself, then allow Harvey to use that tab.';$('myBrowserInstall').hidden=true;$('myBrowserConnect').disabled=false;$('myBrowserUrl').focus();}
  catch{$('myBrowserMessage').textContent='Install Harvey Browser Control once, then reload this page. Already installed? Enable it in Chrome’s extensions menu.';$('myBrowserInstall').hidden=false;}
 }
 async function start(){
  const url=new URL($('myBrowserUrl').value.includes('://')?$('myBrowserUrl').value:'https://'+$('myBrowserUrl').value);if(!['http:','https:'].includes(url.protocol)||url.origin===location.origin)throw Error('Enter the website you want Harvey to use.');
  $('myBrowserConnect').disabled=true;let created;
  try{
   const chat=await h.ensureChat();currentChat=chat;const version=++epoch;
   created=await request(chat,'connect');if(version!==epoch||h.state.conversationId!==chat){void request(chat,'stop',{token:created.token});return;}
   const connecting={...created,chat,ready:false};session=connecting;selected=true;
   await bridge('start',{url:url.href,connectionId:created.connectionId});
   if(session!==connecting||version!==epoch){void bridge('stop',{connectionId:created.connectionId}).catch(()=>{});return;}
   $('myBrowserDialog').close();window.HarveyComputer.show();say('Sign in in the new tab. Then return here and select “Ready — allow control”.');$('localBrowserSite').textContent=url.hostname;paint();const started=session;started.heartbeat=setInterval(()=>{if(session===started)void request(started.chat,'heartbeat',{token:started.token}).then(()=>session===started&&bridge('heartbeat',{connectionId:started.connectionId})).catch(e=>{if(session===started)void stop(e.message);});},10000);void relay(started);
  }catch(e){await stop(e.message);throw e;}finally{$('myBrowserConnect').disabled=false;}
 }
 async function sync(){
  if(!h)return;const chat=h.state.conversationId;
  if(chat!==currentChat){if(session)await stop('Chat changed; browser control stopped.');currentChat=chat;selected=false;$('localBrowserImage').hidden=true;$('localBrowserImage').removeAttribute('src');statusAt=0;epoch++;paint();}
  if(!chat||session||checking||Date.now()-statusAt<4000)return;
  checking=true;statusAt=Date.now();const version=epoch;
  try{const data=await request(chat,'status');if(version!==epoch||h.state.conversationId!==chat)return;selected=data.selected;remoteConnected=data.connected;if(selected)say(data.connected?'This chat is connected in another Harvey tab. Stop that connection before reconnecting here.':'Disconnected · reconnect to use your browser, or select Hosted computer.');paint();}catch{}finally{checking=false;}
 }
 window.HarveyMyBrowser={isSelected:()=>selected,init(hooks){h=hooks;
  $('myBrowserOpen').onclick=()=>{if(selected){window.HarveyComputer.show();return;}void openDialog();};
  $('localBrowserReconnect').onclick=()=>void openDialog();
  $('myBrowserCancel').onclick=()=>$('myBrowserDialog').close();
  $('myBrowserForm').onsubmit=e=>{e.preventDefault();void start().catch(e=>$('myBrowserMessage').textContent=e.message);};
  $('localBrowserReady').onclick=async()=>{const s=session;if(!s)return;try{await bridge('ready',{connectionId:s.connectionId});if(session!==s)return;await request(s.chat,'ready',{token:s.token});if(session!==s)return;s.ready=true;say('Connected · tell Harvey what to do in the chat.');paint();}catch(e){say(e.message);}};
  $('localBrowserFocus').onclick=()=>session&&bridge('focus',{connectionId:session.connectionId}).catch(e=>say(e.message));
  $('localBrowserStop').onclick=async()=>{try{if(!session&&currentChat)await request(currentChat,'stop');await stop();}catch(e){say(e.message);}};
  $('localBrowserHosted').onclick=async()=>{try{await request(h.state.conversationId,'hosted');await stop();selected=false;paint();window.HarveyComputer.sync();}catch(e){say(e.message);}};
  window.addEventListener('pagehide',()=>{void stop('Harvey tab closed');});
  setInterval(()=>void sync(),500);void sync();
 }};
})();
