/* Existing account-scoped APIs supply actions, never invented activity. */
function collectOverviewAlerts(input) {
  var now=input.now||Date.now(), cutoff=now-7*86400000;
  var today=new Date(now);today.setHours(0,0,0,0);
  var leads=new Map((input.leads||[]).map(function(l){return [l.id,l];}));
  var allowed=input.allowedIds?new Set(input.allowedIds):null;
  function visible(id){return !allowed||allowed.has(id);}
  function name(id,fallback){var l=leads.get(id);return l&&(l.name||l.username)||fallback||'Contact';}
  var rows=[];
  (input.conversations||[]).forEach(function(c){
    var last=(c.msgs||[]).at(-1),at=Date.parse(last&&last.at||c.at);
    if(!last||last.me!==false||!Number.isFinite(at)||at<cutoff||at>now||!visible(c.leadId))return;
    rows.push({key:'reply:'+c.key,kind:'reply',at:at,title:(c.names||[])[0]+' sent a reply',detail:(c.channel||'Message')+' · '+(last.t||'Open the conversation'),action:'Read reply',conversationKey:c.key});
  });
  (input.tasks||[]).forEach(function(t){
    var due=Date.parse(t.dueDate+'T00:00:00');
    if(!t.leadId||!visible(t.leadId)||t.status==='completed'||t.status==='cancelled'||!Number.isFinite(due)||due>=today.getTime())return;
    rows.push({key:'task:'+t.id,kind:'task',at:due,title:'Follow up with '+name(t.leadId,t.leadName),detail:(t.title||'Follow-up')+' · Due '+t.dueDate,action:'Open tasks',leadId:t.leadId,tab:'tasks'});
  });
  var labels={re_engagement:'is active again',listing_off_market:'has a listing off the market',listing_active:'has a listing back on the market'};
  (input.notifications||[]).forEach(function(n){
    var at=Date.parse(n.createdAt);
    if(n.read||!labels[n.notificationType]||!n.leadId||!visible(n.leadId)||!Number.isFinite(at)||at<cutoff||at>now)return;
    rows.push({key:'update:'+n.id,kind:'update',at:at,title:name(n.leadId)+' '+labels[n.notificationType],detail:n.message,action:'Open contact',leadId:n.leadId,notificationId:n.id,tab:'note'});
  });
  (input.scheduled||[]).forEach(function(m){
    var at=Date.parse(m.sendAt);
    if(m.status!=='failed'||!visible(m.leadId)||!Number.isFinite(at)||at<cutoff||at>now)return;
    rows.push({key:'failed:'+m.id,kind:'update',at:at,title:'Message to '+name(m.leadId,m.leadName||m.to)+' was not sent',detail:'Review the failed message before trying again.',action:'Review message',scheduledId:m.id});
  });
  return rows.sort(function(a,b){return b.at-a.at;});
}
if(typeof module!=='undefined')module.exports={collectOverviewAlerts};
if(typeof document!=='undefined')(function(){
  var state={tasks:[],notifications:[],scheduled:[]},rows=[],filter='all',request=0,errors=[];
  function paint(){
    var list=document.getElementById('oaList');if(!list)return;
    rows=collectOverviewAlerts({leads:LIVE_DATA?LEADS:[],conversations:LIVE_DATA?CONVOS.map(function(c){return Object.assign({},c,{key:convKey(c)});}):[],allowedIds:USER_FILTER===null?null:dashLeads().map(function(l){return l.id;}),tasks:state.tasks,notifications:state.notifications,scheduled:state.scheduled});
    var selected=rows.filter(function(r){return filter==='all'||r.kind===filter;});
    document.getElementById('oaCount').textContent=String(rows.length);
    document.getElementById('oaStatus').textContent=errors.length?'Could not refresh '+errors.join(', ')+'. Other available items are shown.':'';
    if(list.contains(document.activeElement))return;
    list.innerHTML=selected.length?selected.slice(0,20).map(function(r){return '<button type="button" class="oa-row" data-key="'+esc(r.key)+'" data-kind="'+r.kind+'"><span class="oa-icon" aria-hidden="true">'+(r.kind==='reply'?'↗':r.kind==='task'?'◷':'!')+'</span><span class="oa-copy"><strong>'+esc(r.title)+'</strong><small>'+esc(r.detail||'')+'</small></span><span class="oa-action">'+r.action+'</span><span aria-hidden="true">↗</span></button>';}).join(''):'<div class="oa-empty">'+(errors.length?'No items available from the sources that loaded.':'No '+(filter==='all'?'actionable notifications':filter==='reply'?'recent replies to review':filter==='task'?'overdue follow-ups':'recent updates')+' right now.')+'</div>';
  }
  window.refreshOverviewAlerts=async function(){
    var seq=++request;
    var sources=[['tasks','/api/crm-tasks','follow-ups'],['notifications','/api/crm/notifications?unreadOnly=true','listing updates'],['scheduled','/api/scheduled','scheduled messages']];
    var results=await Promise.allSettled(sources.map(async function(s){var response=await fetch(crmApi(s[1]));if(!response.ok)throw Error();var data=await response.json();var value=data[s[0]==='scheduled'?'messages':s[0]];if(!Array.isArray(value))throw Error();return value;}));
    if(seq!==request)return;
    errors=[];results.forEach(function(r,i){var s=sources[i];if(r.status==='fulfilled')state[s[0]]=r.value;else{state[s[0]]=[];errors.push(s[2]);}});paint();
  };
  document.getElementById('oaRefresh').onclick=window.refreshOverviewAlerts;
  document.getElementById('oaTabs').onclick=function(e){var b=e.target.closest('[data-alert]');if(!b)return;filter=b.dataset.alert;this.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);x.setAttribute('aria-pressed',String(x===b));});paint();};
  document.getElementById('oaList').onclick=function(e){var b=e.target.closest('[data-key]');if(!b)return;var row=rows.find(function(r){return r.key===b.dataset.key;});if(!row)return;
    if(row.conversationKey){var index=CONVOS.findIndex(function(c){return convKey(c)===row.conversationKey;});if(index<0){crmToast('This conversation is no longer in the loaded inbox.');return;}document.querySelector('.rail [data-view="messages"]').click();document.querySelector('#msgTabs [data-mt="all"]').click();openThread(index);}
    else if(row.scheduledId){document.querySelector('.rail [data-view="messages"]').click();document.querySelector('#msgTabs [data-mt="scheduled"]').click();}
    else if(LEADS.some(function(l){return l.id===row.leadId;})){openLead(row.leadId,'note');if(row.kind==='task'){var tasks=document.getElementById('ldTasksBlk');if(tasks)tasks.scrollIntoView({block:'center'});}if(row.notificationId)fetch(crmApi('/api/crm/notifications/'+encodeURIComponent(row.notificationId)+'/read'),{method:'POST'}).then(function(r){if(r.ok)window.refreshOverviewAlerts();}).catch(function(){});}
    else crmToast('This contact is not in the loaded CRM. Refresh the CRM and try again.');
  };
  window.refreshOverviewAlerts();
  setInterval(function(){if(!document.hidden&&document.getElementById('view-dashboard').classList.contains('on'))window.refreshOverviewAlerts();},60000);
})();
