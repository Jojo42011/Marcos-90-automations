/* Settings belong to the authenticated account and follow it across devices. */
(function(){
  'use strict';
  var sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href='/account-settings.css';document.head.appendChild(sheet);
  var preferences={},dialog,style=document.createElement('style');document.head.appendChild(style);
  function apply(p){
    preferences=p;
    var dark=p.theme==='dark'||p.theme==='system'&&matchMedia('(prefers-color-scheme:dark)').matches;
    document.documentElement.dataset.theme=dark?'dark':'light';
    document.documentElement.dataset.accountDensity=p.density;
    document.documentElement.style.colorScheme=dark?'dark':'light';
    try{localStorage.setItem('theme',dark?'dark':'light');localStorage.setItem('accountPreferences',JSON.stringify(p));}catch(_){}
    style.textContent=':root{--accent:'+p.accent+'!important;--teal:'+p.accent+'!important;--teal-strong:'+(dark?'color-mix(in srgb,'+p.accent+' 45%,white)':p.accent)+'!important;--account-font-size:'+p.fontSize+'px}body{font-size:var(--account-font-size)}'+
      (dark?':root{--bg:#10151d;--surface:#18212c;--panel:#18212c;--card:#18212c;--text:#edf2f7;--ink:#edf2f7;--muted:#a5b2c3;--line:#344255;--soft:#233c46}':'')+
      (p.density==='compact'?'td,th{padding-top:6px!important;padding-bottom:6px!important}':'')+
      (p.reducedMotion?'*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}':'');
  }
  function open(){
    if(window.parent!==window && window.parent.AccountSettings){window.parent.AccountSettings.open();return;}
    if(dialog){if(!dialog.open)dialog.showModal();return;}
    dialog=document.createElement('dialog');dialog.setAttribute('aria-label','Account settings');
    dialog.className='account-settings';
    dialog.innerHTML=`<form method="dialog" class="settings-header"><h2>Account settings</h2><button class="settings-close" aria-label="Close settings">×</button></form><p class="settings-profile" id="account-settings-name"></p>
      <form id="account-settings-form"><section class="settings-section"><h3>Appearance</h3>
      <label class="settings-row"><span class="settings-label">Theme<span class="settings-hint">Make this space your own</span></span><select name="theme"><option value="system">Use device setting</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label class="settings-row"><span class="settings-label">Accent color<span class="settings-hint">A personal touch across your workspace</span></span><input name="accent" type="color"></label></section>
      <section class="settings-section"><h3>Comfort & accessibility</h3>
      <label class="settings-row"><span class="settings-label">Display density</span><select name="density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
      <label class="settings-row"><span class="settings-label">Text size</span><span class="settings-range"><input name="fontSize" type="range" min="12" max="20" step="1"><output id="settings-size">14</output></span></label>
      <label class="settings-row"><span class="settings-label">Reduce motion<span class="settings-hint">Keep transitions subtle and still</span></span><input name="reducedMotion" type="checkbox" role="switch"></label></section>
      <div class="settings-actions"><p role="status" id="account-settings-status"></p><button class="settings-save" type="submit">Save changes</button></div></form>
      <footer class="settings-footer"><button type="button" id="account-settings-logout">Log out</button></footer>`;
    document.body.appendChild(dialog);
    var form=dialog.querySelector('#account-settings-form');
    Object.keys(preferences).forEach(function(k){var field=form.elements.namedItem(k);if(field){if(field.type==='checkbox')field.checked=preferences[k];else field.value=preferences[k];}});
    form.elements.fontSize.oninput=function(){dialog.querySelector('#settings-size').value=this.value;};form.elements.fontSize.oninput();
    fetch('/api/auth/me').then(function(r){return r.json();}).then(function(d){dialog.querySelector('#account-settings-name').textContent=d.user?d.user.name+' · '+d.user.email:'';}).catch(function(){});
    form.onsubmit=async function(e){e.preventDefault();var button=form.querySelector('[type=submit]');button.disabled=true;
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
    var button=document.createElement('button');button.textContent='⚙';button.title='Account settings';button.setAttribute('aria-label','Account settings');button.className='account-settings-trigger';button.onclick=open;document.body.appendChild(button);
  }
})();
