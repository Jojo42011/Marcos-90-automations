/* A read-only view of the selected chat's existing hosted browser. */
(function(){
  'use strict';
  var h, key='', generation=0, controller, timer, open=false, dismissed=false, lastPoll=0;
  function $(id){return document.getElementById(id);}
  function clear(){
    generation++;if(controller)controller.abort();controller=null;
    $('computerImage').removeAttribute('src');$('computerImage').hidden=true;
    $('computerPage').textContent='No page open';$('computerCaptured').textContent='';
    $('computerActivity').textContent='';$('computerEmpty').hidden=false;
    $('computerEmpty').textContent='Ask Harvey to open a website in this chat.';
  }
  function toggle(value,user){
    open=value;if(user)dismissed=!value;
    $('computerPanel').hidden=!value;document.body.classList.toggle('computer-panel-open',value);
    $('computerPanelOpen').setAttribute('aria-expanded',String(value));
    if(value){$('taskPanelClose').click();lastPoll=0;poll();}
    else {generation++;if(controller)controller.abort();controller=null;}
  }
  function sync(){
    if(!h)return;
    var next=(h.state.conversationId||'new')+':'+h.state.mode;
    if(next!==key){key=next;clear();lastPoll=0;dismissed=false;}
    $('computerPanelOpen').hidden=h.state.view!=='chat';
    if(h.state.view!=='chat'){if(open)toggle(false);return;}
    if(!dismissed && h.state.mode==='work' && !open && $('taskPanel').hidden)toggle(true);
    if(open)poll();
  }
  async function poll(){
    if(!h||!open||document.hidden||controller||Date.now()-lastPoll<4000)return;
    var id=h.state.conversationId;
    if(!id){$('computerStatus').textContent='Ready when you are';return;}
    var version=generation, abort=new AbortController();controller=abort;lastPoll=Date.now();
    $('computerStatus').textContent=$('computerImage').hidden?'Connecting…':$('computerStatus').textContent;
    try{
      var response=await fetch(h.apiUrl('/api/harvey/work/browser/'+encodeURIComponent(id)+'/preview'),{signal:abort.signal,cache:'no-store'});
      if(!response.ok)throw new Error('Computer preview unavailable. Try again shortly.');
      var data=await response.json();
      if(version!==generation||id!==h.state.conversationId||data.chatId!==id||!open)return;
      var labels={disabled:'Browser not enabled',closed:'No browser open',unavailable:'Preview unavailable',working:'Using browser',ready:'Browser ready',needs_attention:'Browser needs attention'};
      $('computerStatus').textContent=labels[data.state]||'Preview unavailable';
      var actions={browser_navigate:'Opening a page',browser_navigate_back:'Going back',browser_snapshot:'Inspecting the page',browser_click:'Clicking a control',browser_type:'Typing',browser_fill_form:'Filling a form',browser_press_key:'Using the keyboard',browser_select_option:'Selecting an option',browser_hover:'Inspecting a control',browser_drag:'Dragging',browser_tabs:'Switching tabs',browser_wait_for:'Waiting for the page',browser_handle_dialog:'Handling a dialog',browser_file_upload:'Uploading a file',browser_take_screenshot:'Capturing the page'};
      var action=actions[data.action];
      $('computerActivity').textContent=(data.phase==='running'?'Harvey is working':data.phase==='queued'?'Task queued':data.phase==='cancelling'?'Stopping task':'No task running')+(action?' · '+(data.state==='working'?'':'Last browser action: ')+action:'');
      if(data.frame && /^data:image\/jpeg;base64,/.test(data.frame.image)){
        $('computerImage').src=data.frame.image;$('computerImage').hidden=false;$('computerEmpty').hidden=true;
        $('computerPage').textContent=data.frame.url||data.frame.title||'Browser';
        $('computerPage').title=data.frame.title||'';
        $('computerCaptured').textContent='Captured '+new Date(data.frame.capturedAt).toLocaleTimeString();
      }else{
        $('computerImage').removeAttribute('src');$('computerImage').hidden=true;$('computerEmpty').hidden=false;
        $('computerPage').textContent='No page open';$('computerCaptured').textContent='';
        $('computerEmpty').textContent=data.state==='disabled'?'The hosted browser is not enabled on this server.':data.state==='unavailable'?'The browser could not provide a preview. Retrying automatically.':data.state==='working'?'Harvey is using the browser. The preview will update when this action finishes.':'Ask Harvey to open a website in this chat. Viewing this panel does not launch a browser.';
      }
    }catch(e){if(e.name!=='AbortError'&&version===generation){$('computerStatus').textContent='Disconnected · retrying';$('computerCaptured').textContent=$('computerImage').hidden?'':'Last captured image · connection lost';}}
    finally{if(controller===abort)controller=null;}
  }
  window.HarveyComputer={
    init:function(hooks){h=hooks;
      $('computerPanelOpen').onclick=function(){toggle(!open,true);};
      $('computerPanelClose').onclick=function(){toggle(false,true);$('computerPanelOpen').focus();};
      $('computerRefresh').onclick=function(){lastPoll=0;poll();};
      $('computerExpand').onclick=function(){var expanded=document.body.classList.toggle('computer-expanded');this.setAttribute('aria-pressed',String(expanded));this.textContent=expanded?'Compact':'Expand';};
      document.addEventListener('keydown',function(e){if(e.key==='Escape'&&open){toggle(false,true);$('computerPanelOpen').focus();}});
      document.addEventListener('visibilitychange',function(){if(document.hidden){if(controller)controller.abort();}else{lastPoll=0;sync();}});
      timer=setInterval(sync,500);window.addEventListener('pagehide',function(){clearInterval(timer);clear();});window.addEventListener('pageshow',function(e){if(e.persisted){clearInterval(timer);timer=setInterval(sync,500);lastPoll=0;sync();}});sync();
    },
    sync:sync,
    hide:function(){if(open)toggle(false,true);}
  };
})();
