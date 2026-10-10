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
    var script=document.createElement('script');script.src='/account-settings.js';document.head.appendChild(script);
    var ownership=document.createElement('script');ownership.src='/account-ownership.js';document.head.appendChild(ownership);
  });
})();
