/* Keep each account's browser drafts without displaying them in another workspace. */
(function () {
  function cookie(name) { var item=document.cookie.split('; ').find(function(s){return s.indexOf(name+'=')===0;});return item?decodeURIComponent(item.slice(name.length+1)):''; }
  var actor=cookie('mp_account_id'), owner=cookie('mp_workspace_id')||actor;
  if(!actor)return;
  var key=actor+':'+owner, prefix='accountArchive:';
  try {
    var previous=localStorage.getItem('accountCacheOwner');
    if(previous!==key) {
      var saved={};
      for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k!=='accountCacheOwner'&&k.indexOf(prefix)!==0)saved[k]=localStorage.getItem(k);}
      // Save first: if quota is exhausted, leave drafts untouched rather than deleting them.
      localStorage.setItem(prefix+(previous||'legacy'),JSON.stringify(saved));
      Object.keys(saved).forEach(function(k){localStorage.removeItem(k);});
      var restored=JSON.parse(localStorage.getItem(prefix+key)||'{}');
      Object.keys(restored).forEach(function(k){localStorage.setItem(k,restored[k]);});
      localStorage.setItem('accountCacheOwner',key);
    }
    var sessionOwner=sessionStorage.getItem('accountCacheOwner');
    if(sessionOwner!==key){
      var draft={};for(var j=0;j<sessionStorage.length;j++){var sk=sessionStorage.key(j);if(sk!=='accountCacheOwner')draft[sk]=sessionStorage.getItem(sk);}
      localStorage.setItem(prefix+'session:'+(sessionOwner||previous||'legacy'),JSON.stringify(draft));
      Object.keys(draft).forEach(function(k){sessionStorage.removeItem(k);});
      var sessionDraft=JSON.parse(localStorage.getItem(prefix+'session:'+key)||'{}');
      Object.keys(sessionDraft).forEach(function(k){sessionStorage.setItem(k,sessionDraft[k]);});
      sessionStorage.setItem('accountCacheOwner',key);
    }
    localStorage.setItem('marcoTaskUser',cookie('mp_account'));
  } catch (_) {}
  window.addEventListener('storage',function(e){if(e.key==='accountCacheOwner'&&e.newValue!==key)location.reload();});
  window.addEventListener('pageshow',function(e){if(e.persisted||cookie('mp_account_id')!==actor||(cookie('mp_workspace_id')||actor)!==owner)location.reload();});
  window.addEventListener('DOMContentLoaded',function(){
    fetch('/api/account/workspaces').then(function(r){return r.ok?r.json():null;}).then(function(data){
      if(!data||data.workspaces.length<2)return;
      var label=document.createElement('label');label.style.cssText='position:fixed;bottom:12px;right:12px;z-index:99999;background:#172033;color:white;padding:10px;border-radius:10px;font:13px system-ui;box-shadow:0 2px 10px #0005';
      label.textContent='Workspace: ';var select=document.createElement('select');select.setAttribute('aria-label','View workspace');
      data.workspaces.forEach(function(w){var option=document.createElement('option');option.value=w.id;option.textContent=w.name+(w.readOnly?' (view only)':' (yours)');option.selected=w.id===owner;select.appendChild(option);});
      select.onchange=async function(){select.disabled=true;try{var r=await fetch('/api/account/workspace?id='+encodeURIComponent(select.value),{method:'POST'});if(!r.ok)throw new Error('Workspace unavailable');location.reload();}catch(e){select.disabled=false;alert(e.message);}};
      label.appendChild(select);document.body.appendChild(label);
    }).catch(function(){});
  });
})();
