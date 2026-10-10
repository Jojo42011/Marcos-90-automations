/* Settings belong to the authenticated account and follow it across devices. */
(function(){
  'use strict';
  var preferences={},dialog,style=document.createElement('style');document.head.appendChild(style);
  function apply(p){
    preferences=p;
    var dark=p.theme==='dark'||p.theme==='system'&&matchMedia('(prefers-color-scheme:dark)').matches;
    document.documentElement.dataset.theme=dark?'dark':'light';
    document.documentElement.dataset.accountDensity=p.density;
    document.documentElement.style.colorScheme=dark?'dark':'light';
    try{localStorage.setItem('theme',dark?'dark':'light');localStorage.setItem('accountPreferences',JSON.stringify(p));}catch(_){}
    style.textContent=':root{--accent:'+p.accent+'!important;--teal:'+p.accent+'!important;--teal-strong:'+p.accent+'!important;--account-font-size:'+p.fontSize+'px}body{font-size:var(--account-font-size)}'+
      (dark?':root{--bg:#10151d;--surface:#18212c;--panel:#18212c;--card:#18212c;--text:#edf2f7;--ink:#edf2f7;--muted:#a5b2c3;--line:#344255;--soft:#233c46}#brand{background:#fff;border-radius:8px;padding:6px}.nav-item:hover{background:#233c46}':'')+
      (p.density==='compact'?'td,th{padding-top:6px!important;padding-bottom:6px!important}':'')+
      (p.reducedMotion?'*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}':'');
  }
  function open(){
    if(window.parent!==window && window.parent.AccountSettings){window.parent.AccountSettings.open();return;}
    if(dialog){dialog.showModal();return;}
    dialog=document.createElement('dialog');dialog.setAttribute('aria-label','Account settings');
    dialog.style.cssText='border:1px solid #8793a4;border-radius:18px;padding:24px;width:min(420px,85vw);font:14px system-ui;box-shadow:0 20px 80px #0005';
    dialog.innerHTML='<form method="dialog"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Account settings</h2><button aria-label="Close settings">✕</button></div></form><p id="account-settings-name"></p><form id="account-settings-form" style="display:grid;gap:16px"><label>Appearance <select name="theme"><option value="system">Use device setting</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Accent color <input name="accent" type="color"></label><label>Density <select name="density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label>Text size <input name="fontSize" type="range" min="12" max="20" step="1"></label><label><input name="reducedMotion" type="checkbox"> Reduce motion</label><p role="status" id="account-settings-status" style="margin:0"></p><button type="submit">Save settings</button></form><hr style="margin:20px 0"><button type="button" id="account-settings-logout">Log out</button>';
    document.body.appendChild(dialog);
    var form=dialog.querySelector('#account-settings-form');
    Object.keys(preferences).forEach(function(k){var field=form.elements.namedItem(k);if(field){if(field.type==='checkbox')field.checked=preferences[k];else field.value=preferences[k];}});
    fetch('/api/auth/me').then(function(r){return r.json();}).then(function(d){dialog.querySelector('#account-settings-name').textContent=d.user?d.user.name+' · '+d.user.email:'';}).catch(function(){});
    form.onsubmit=async function(e){e.preventDefault();var button=form.querySelector('button');button.disabled=true;
      try{var input={theme:form.elements.theme.value,accent:form.elements.accent.value,density:form.elements.density.value,fontSize:Number(form.elements.fontSize.value),reducedMotion:form.elements.reducedMotion.checked};
        var r=await fetch('/api/account/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});var data=await r.json();if(!r.ok)throw new Error(data.error||'Could not save');apply(data.preferences);
        document.querySelectorAll('iframe').forEach(function(frame){frame.contentWindow.postMessage({type:'account-preferences',preferences:data.preferences},location.origin);});
        dialog.querySelector('[role=status]').textContent='Saved for your account.';
      }catch(error){dialog.querySelector('[role=status]').textContent=error.message;}finally{button.disabled=false;}
    };
    dialog.querySelector('#account-settings-logout').onclick=async function(){this.disabled=true;try{var r=await fetch('/api/auth/logout',{method:'POST'});if(!r.ok)throw new Error('Log out failed. Please try again.');window.top.location.href='/login';}catch(e){this.disabled=false;dialog.querySelector('[role=status]').textContent=e.message;}};
    dialog.addEventListener('click',function(e){if(e.target===dialog){var b=dialog.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)dialog.close();}});
    dialog.showModal();
  }
  window.AccountSettings={open:open};
  window.addEventListener('message',function(e){if(e.origin===location.origin&&e.source===parent&&e.data?.type==='account-preferences')apply(e.data.preferences);});
  fetch('/api/account/preferences').then(function(r){if(!r.ok)throw new Error('Settings unavailable');return r.json();}).then(function(d){apply(d.preferences);}).catch(function(){});
  if(window.parent===window&&!document.getElementById('whoBtn')){
    var button=document.createElement('button');button.textContent='⚙';button.title='Account settings';button.setAttribute('aria-label','Account settings');button.style.cssText='position:fixed;bottom:16px;right:16px;z-index:9999;width:40px;height:40px;border-radius:50%;border:1px solid #94a3b8;background:#fff;color:#18212c;font-size:22px;cursor:pointer';button.onclick=open;document.body.appendChild(button);
  }
})();
