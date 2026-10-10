/* Select ownership when creating a record, without switching the dashboard. */
(function(){
  'use strict';
  if(!document.cookie.split('; ').some(function(c){return c==='mp_account=carlos';}))return;
  var original=window.fetch.bind(window);
  var creates=new Set(['/api/crm/lead','/api/deals','/api/transactions','/api/tracker/records','/api/finance/commissions','/api/finance/expenses','/api/leads/import-csv','/api/marco-tasks','/api/crm-tasks']);
  function choose(){return new Promise(async function(resolve,reject){
    try{var r=await original('/api/account/workspaces');if(!r.ok)throw new Error('Could not load account owners');var data=await r.json();
      var dialog=document.createElement('dialog');dialog.style.cssText='border:1px solid #94a3b8;border-radius:16px;padding:24px;min-width:280px;font:14px system-ui';
      var form=document.createElement('form');form.method='dialog';var title=document.createElement('h2');title.textContent='Who is this record for?';form.appendChild(title);
      var select=document.createElement('select');select.setAttribute('aria-label','Record owner');select.style.cssText='width:100%;padding:10px;margin-bottom:20px';
      data.workspaces.forEach(function(u){var option=document.createElement('option');option.value=u.id;option.textContent=u.name;select.appendChild(option);});form.appendChild(select);
      var cancel=document.createElement('button');cancel.textContent='Cancel';cancel.value='cancel';form.appendChild(cancel);
      var save=document.createElement('button');save.textContent='Continue';save.value='save';save.style.marginLeft='12px';form.appendChild(save);
      dialog.appendChild(form);document.body.appendChild(dialog);dialog.addEventListener('close',function(){var owner=select.value,result=dialog.returnValue;dialog.remove();result==='save'?resolve(owner):reject(new Error('Creation cancelled. No record was saved.'));},{once:true});dialog.showModal();
    }catch(e){reject(e);}
  });}
  window.fetch=async function(input,init){
    var url=new URL(typeof input==='string'?input:input.url,location.href),method=String(init?.method||input?.method||'GET').toUpperCase();
    if(url.origin!==location.origin||method!=='POST'||!creates.has(url.pathname))return original(input,init);
    var headers=new Headers(init?.headers||input?.headers),body=init?.body;
    if(headers.has('x-account-owner')||typeof body==='string'&&(body.includes('acct.')||body.includes('accountOwnerId')))return original(input,init);
    try{headers.set('x-account-owner',await choose());return original(input,Object.assign({},init,{headers:headers}));}
    catch(e){return new Response(JSON.stringify({error:e.message}),{status:409,headers:{'Content-Type':'application/json'}});}
  };
})();
