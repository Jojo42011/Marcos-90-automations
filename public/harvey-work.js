/* Project, plugin and recurring-agent controls for the existing Harvey chat. */
(function () {
  "use strict";
  var h, projects = [], services = [], connections = [], status = {}, activeView = "plugins";
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  async function api(path, method, body) { var r = await h.api("/api/harvey" + path, { method: method || "GET", body: body }); if (!r.ok) throw new Error(r.error || r.data && r.data.error || "Request failed"); return r.data; }
  function notice(error) { h.toast(error.message || String(error)); }
  function button(label, action, id) { return '<button type="button" class="work-button" data-work-action="' + action + '" data-id="' + esc(id || "") + '">' + esc(label) + '</button>'; }
  function field(label, name, value, type) { return '<label class="work-field">' + esc(label) + '<input name="' + name + '" type="' + (type || "text") + '" value="' + esc(value || "") + '"' + (type === "password" ? ' autocomplete="new-password"' : '') + ' required></label>'; }
  function area(label, name, value) { return '<label class="work-field">' + esc(label) + '<textarea name="' + name + '" rows="4" required>' + esc(value || "") + '</textarea></label>'; }
  function scope() { return '<p class="work-hint">Available in ' + esc(h.state.projectId ? (projects.find(function(p){return p.id === h.state.projectId;}) || {}).name : "all your projects") + '.</p>'; }
  function actionsCheckbox() { return '<label class="work-check"><input name="allowWrites" type="checkbox"> Enable actions, including sends and updates, for tasks I request</label>'; }
  function modal(title, html, onSave) {
    var dialog = $("workDialog"); dialog.innerHTML = '<form method="dialog" id="workForm"><header><h2>' + esc(title) + '</h2><button type="button" id="workDialogClose" aria-label="Close dialog">×</button></header>' + html + '<p class="work-error" id="workFormError" role="alert"></p><footer><button type="button" id="workCancel" class="work-button">Cancel</button><button type="submit" class="work-button primary">Save</button></footer></form>';
    $("workDialogClose").onclick = $("workCancel").onclick = function () { dialog.close(); }; dialog.showModal();
    $("workForm").onsubmit = async function (e) { e.preventDefault(); var submit = e.submitter; submit.disabled = true; try { var data = Object.fromEntries(new FormData(e.target)); data.allowWrites = data.allowWrites === "on"; await onSave(data); dialog.close(); } catch (err) { $("workFormError").textContent = err.message; } finally { submit.disabled = false; } };
  }
  async function loadProjects() {
    projects = (await api("/projects")).projects;
    $("projectSelect").innerHTML = '<option value="">All chats</option>' + projects.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join("");
    $("projectSelect").value = h.state.projectId || ""; syncControls();
    $("projectEdit").hidden = !h.state.projectId;
  }
  function syncControls() {
    $("workStarters").hidden=h.state.mode!=="work";
    document.querySelectorAll('[data-mode]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.mode===(h.state.mode||'chat')));});
    var heading=document.querySelector('.empty h1');if(heading)heading.textContent=h.state.mode==='work'?'What should we work on?':'What’s on your mind?';
    $('input').placeholder=h.state.mode==='work'?'Give Harvey a task…':'Message Harvey…';
    $('projectList').innerHTML=[{id:'',name:'All chats'}].concat(projects).map(function(p){return '<button type="button" class="project-row'+((h.state.projectId||'')===p.id?' selected':'')+'" data-project="'+esc(p.id)+'" aria-current="'+(((h.state.projectId||'')===p.id)?'true':'false')+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z"/></svg><span>'+esc(p.name)+'</span></button>';}).join('');
  }
  function projectForm(edit) {
    var p = projects.find(function (p) { return p.id === h.state.projectId; }) || {};
    modal(edit ? "Project settings" : "New project", field("Name", "name", edit ? p.name : "") + area("Shared instructions", "instructions", edit ? p.instructions : "Keep work focused on this project.") + field("Timezone", "timezone", p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago"), async function (data) {
      var saved = await api(edit ? "/projects/" + p.id : "/projects", edit ? "PATCH" : "POST", data); h.state.projectId = saved.id; await loadProjects(); h.newChat(); h.refresh();
    });
  }
  async function pluginsView() {
    var data = await api("/work/plugins"); services = data.catalog; connections = data.connections;
    $("workTitle").textContent = "Plugins"; $("workSubtitle").textContent = "Connect your services once. Use them in chats and recurring agents.";
    $("workBody").innerHTML = '<div class="work-toolbar">' + button("Add custom connector", "custom") + '</div>' +
      (!status.vault ? '<div class="panel">Connection storage needs setup. Configure Harvey’s vault key before adding accounts.</div>' : '') +
      '<h2>Connected</h2><div class="work-grid">' + (connections.length ? connections.map(function(c){return '<article class="panel"><h3>' + esc(c.name) + '</h3><p class="work-hint">' + esc(c.projectId ? (projects.find(function(p){return p.id === c.projectId;})||{}).name || "Project" : "All projects") + ' · ' + (c.allowWrites ? "Actions enabled" : "Read only") + '</p><div class="work-toolbar">' + button(c.allowWrites ? "Set read only" : "Enable actions", "permissions", c.id) + button("Disconnect", "disconnect", c.id) + '</div></article>';}).join("") : '<p class="work-hint">No services connected yet. Choose one below or add a custom connector.</p>') + '</div>' +
      '<h2>Add a service</h2><div class="work-grid">' + services.map(function(s){return '<article class="panel"><div class="service-icon">' + esc(s.name[0]) + '</div><h3>' + esc(s.name) + '</h3><p class="work-hint">' + (s.ready ? "Ready to connect" : "App setup required") + '</p>' + button(s.ready ? "Connect" : "View setup", "connect", s.id) + '</article>';}).join("") + '</div>';
  }
  async function schedulesView() {
    var data = await api("/work/schedules"), chats = h.state.conversations;
    var tasks = data.schedules.filter(function(s){var c=chats.find(function(c){return c.id===s.chatId;});return !h.state.projectId || c && c.projectId===h.state.projectId;});
    $("workTitle").textContent = "Scheduled agents"; $("workSubtitle").textContent = "Give a chat a job and a time. Results return to that chat.";
    $("workBody").innerHTML = '<div class="work-toolbar">' + button("Schedule this chat", "schedule") + '</div>' + (!status.worker ? '<div class="panel">The background worker is off. Saved schedules will run automatically once the worker is enabled. Run now works while testing.</div>' : '') +
      (tasks.length ? tasks.map(function(s){var runs=data.runs.filter(function(r){return r.scheduleId===s.id;}).slice(0,5);return '<article class="panel"><div class="work-heading"><h3>' + esc(s.title) + '</h3><span>' + (s.enabled ? "Active" : "Paused") + '</span></div><p>' + esc(s.prompt) + '</p><p class="work-hint">' + esc(scheduleLabel(s.cron)) + ' · ' + esc(s.timezone) + '<br>Next: ' + esc(new Date(s.nextRunAt).toLocaleString(undefined,{timeZone:s.timezone})) + ' · Budget $' + esc(s.maxCostUsd) + '/run</p><div class="work-toolbar">' + button("Open chat","open",s.chatId) + button("Run now","run",s.id) + button(s.enabled?"Pause":"Resume",s.enabled?"pause":"resume",s.id) + button("Edit","edit-schedule",s.id) + button("Remove","remove-schedule",s.id) + '</div>' + runs.map(function(r){return '<details class="work-run"><summary>' + esc(r.status.replace(/_/g," ")) + ' · ' + esc(new Date(r.startedAt).toLocaleString()) + '</summary><pre>' + esc(r.result || "Working…") + '</pre></details>';}).join("") + '</article>';}).join("") : '<div class="panel"><h3>Your first recurring agent</h3><p>Open a chat, switch to Work, and say what to do and when.</p><p class="work-hint">“Review new files in the connected drive every weekday at 9 am and summarize them here.”</p></div>');
  }
  function scheduleParts(cron) {
    var match=String(cron||'0 9 * * *').match(/^(\d+) (\d+) \* \* (\*|1-5|[0-6])$/);
    if(!match)return {cadence:'advanced',time:'09:00',weekday:'1'};
    return {cadence:match[3]==='*'?'daily':match[3]==='1-5'?'weekdays':'weekly',time:match[2].padStart(2,'0')+':'+match[1].padStart(2,'0'),weekday:match[3]};
  }
  function scheduleLabel(cron) {var p=scheduleParts(cron);return p.cadence==='advanced'?'Custom schedule: '+cron:(p.cadence==='daily'?'Every day':p.cadence==='weekdays'?'Every weekday':'Every '+['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][Number(p.weekday)])+' at '+p.time;}
  async function scheduleForm(existing) {
    if (!existing && h.state.mode !== 'work') { h.toast('Switch this chat to Work before scheduling it.'); h.showView('chat'); return; }
    var chatId = existing ? existing.chatId : await h.ensureChat(), p = projects.find(function(p){return p.id===h.state.projectId;}) || {}, timing=scheduleParts(existing&&existing.cron);
    var controls='<label class="work-field">Repeat<select name="cadence"><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="advanced">Custom schedule</option></select></label>'+
      '<label class="work-field" id="scheduleTimeLabel">Time<input type="time" name="time" value="'+timing.time+'" required></label>'+
      '<label class="work-field" id="scheduleDayLabel">Day<select name="weekday">'+['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(function(day,i){return '<option value="'+i+'">'+day+'</option>';}).join('')+'</select></label>'+
      '<label class="work-field" id="scheduleCronLabel">Custom cron expression<input name="cron" value="'+esc(existing?existing.cron:'0 9 * * *')+'"></label>';
    modal(existing ? 'Edit scheduled agent' : 'Schedule this agent', field('Task name','title',existing && existing.title) + area('What should Harvey do?','prompt',existing && existing.prompt) + controls + field('Timezone','timezone',existing ? existing.timezone : p.timezone || 'America/Chicago') + field('Maximum model cost per run ($)','maxCostUsd',existing ? existing.maxCostUsd : '1','number'),async function(d){
      if(d.cadence!=='advanced'){var parts=d.time.split(':');d.cron=Number(parts[1])+' '+Number(parts[0])+' * * '+(d.cadence==='daily'?'*':d.cadence==='weekdays'?'1-5':d.weekday);}
      d.chatId=chatId;d.maxCostUsd=Number(d.maxCostUsd);await api(existing?'/work/schedules/'+existing.id:'/work/schedules',existing?'PATCH':'POST',d);await show('schedules');
    });
    var form=$('workForm'),cost=form.elements.maxCostUsd;cost.min='0.01';cost.max='25';cost.step='0.01';form.elements.cadence.value=timing.cadence;form.elements.weekday.value=timing.cadence==='weekly'?timing.weekday:'1';
    function toggle(){var c=form.elements.cadence.value;$('scheduleTimeLabel').hidden=c==='advanced';form.elements.time.required=c!=='advanced';$('scheduleDayLabel').hidden=c!=='weekly';$('scheduleCronLabel').hidden=c!=='advanced';form.elements.cron.required=c==='advanced';}
    form.elements.cadence.onchange=toggle;toggle();
  }
  async function browserView() {
    var data = await api("/work/logins"); $("workTitle").textContent = "Browser"; $("workSubtitle").textContent = "A separate browser for each agent chat. Sessions survive restarts.";
    $("workBody").innerHTML = '<article class="panel"><h3>' + (status.browser ? "Browser control enabled" : "Browser setup required") + '</h3><p>Switch to Work and tell Harvey which site to open and what to do. Saved browser profiles keep cookies and sign-ins between runs.</p><p class="work-hint">Sites can still expire sessions or require MFA. This version provides browser automation and page snapshots; an interactive remote desktop is not included.</p><div class="work-toolbar">' + button("Inspect this chat’s browser","snapshot") + button("Close browser","close-browser") + button("Save login","save-login") + button("Upload file","upload") + '</div><pre id="browserSnapshot" class="work-snapshot"></pre></article>' +
      '<h2>Saved logins</h2>' + (data.logins.length ? data.logins.map(function(l){return '<article class="panel"><h3>' + esc(l.name) + '</h3><p class="work-hint">' + esc(l.url) + '</p>' + button("Remove saved login","remove-login",l.id) + '</article>';}).join("") : '<p class="work-hint">Add a login here when a site has no API connection. Passwords are stored separately from chat messages.</p>');
    if(h.state.conversationId){var local=await api("/work/files/"+h.state.conversationId);$("workBody").insertAdjacentHTML("beforeend",'<h2>Chat files</h2>'+local.files.map(function(f){return '<p><a href="'+esc(h.apiUrl("/api/harvey/work/files/"+h.state.conversationId+"/"+encodeURIComponent(f.name)))+'">'+esc(f.name)+'</a> · '+Math.ceil(f.size/1024)+' KB</p>';}).join(""));}
  }
  async function show(view) { activeView=view;h.showView("work");$("workBody").textContent="Loading…";try{status=await api("/work/status");await loadProjects();if(view==="plugins")await pluginsView();else if(view==="schedules")await schedulesView();else await browserView();}catch(e){$("workBody").textContent=e.message;} }
  async function uploadFile() {
    var chat = await h.ensureChat();
    modal("Upload a file", '<label class="work-field">File (up to 250 MB)<input type="file" name="file" required></label><p class="work-hint">Harvey can use this file in the current Work chat. Video trimming and browser uploads are supported.</p>', async function(d){var form=new FormData();form.append("file",d.file);var saved=await api("/work/files/"+chat,"POST",form);h.toast("Uploaded "+saved.file);});
  }
  async function act(action,id) {
    if(action==="upload")return uploadFile();
    if(action==="custom")return modal("Add custom MCP connector",field("Name","name")+field("HTTPS MCP URL","endpoint","","url")+'<label class="work-field">Bearer token (optional)<input name="token" type="password" autocomplete="new-password"></label>'+scope()+actionsCheckbox(),async function(d){d.projectId=h.state.projectId;await api("/work/plugins/mcp","POST",d);await pluginsView();});
    if(action==="connect") {var s=services.find(function(s){return s.id===id;});if(!s.ready)return modal(s.name+" setup",'<p>Configure '+esc(s.setup)+' on the server, along with HARVEY_PUBLIC_URL and HARVEY_VAULT_KEY. Register the OAuth callback ending in <code>/api/harvey/work/oauth/callback</code>.</p><p>Once configured, this service gets a Connect button.</p>',async function(){});return modal("Connect "+s.name,scope()+actionsCheckbox()+'<p>You’ll continue to the service to choose your account and approve access.</p>',async function(d){var result=await api("/work/plugins/oauth","POST",{service:id,projectId:h.state.projectId,allowWrites:d.allowWrites});window.location.assign(result.url);});}
    if(action==="disconnect"){if(!confirm("Disconnect this service from Harvey?"))return;await api("/work/plugins/"+id,"DELETE");return pluginsView();}
    if(action==="permissions"){var c=connections.find(function(c){return c.id===id;});if(!c.allowWrites&&!confirm("Allow tasks you request to send messages and make changes through "+c.name+"?"))return;await api("/work/plugins/"+id,"PATCH",{allowWrites:!c.allowWrites});return pluginsView();}
    if(action==="schedule")return scheduleForm();
    if(action==="open"){await h.openChat(id);h.showView("chat");return;}
    if(action==="edit-schedule"){var all=await api("/work/schedules");return scheduleForm(all.schedules.find(function(s){return s.id===id;}));}
    if(action==="pause"||action==="resume"){await api("/work/schedules/"+id,"PATCH",{enabled:action==="resume"});return schedulesView();}
    if(action==="run"){h.toast("Agent started. The result will be saved in its chat.");await api("/work/schedules/"+id+"/run","POST",{});await h.refresh();return schedulesView();}
    if(action==="remove-schedule"){if(!confirm("Remove this schedule? Past run results stay in the chat."))return;await api("/work/schedules/"+id,"DELETE");return schedulesView();}
    if(action==="save-login")return modal("Save browser login",field("Name","name")+field("Login page URL","url","","url")+field("Username or email","username")+field("Password","password","","password")+scope(),async function(d){d.projectId=h.state.projectId;await api("/work/logins","POST",d);await browserView();});
    if(action==="remove-login"){if(!confirm("Remove this saved password? Existing browser sessions stay signed in."))return;await api("/work/logins/"+id,"DELETE");return browserView();}
    if(action==="snapshot"||action==="close-browser"){var chat=await h.ensureChat();var result=await api("/work/browser/"+chat+(action==="snapshot"?"/snapshot":"/close"),"POST",{});$("browserSnapshot").textContent=action==="snapshot"?(result.content||[]).filter(function(c){return c.type==="text";}).map(function(c){return c.text;}).join("\n"):"Browser closed. Saved sessions are retained.";}
  }
  window.HarveyWork = {
    upload: function(){return uploadFile().catch(notice);},
    init: function(hooks){h=hooks;$("newProject").onclick=function(){projectForm(false);};$("projectEdit").onclick=function(){projectForm(true);};$("projectSelect").onchange=function(){h.state.projectId=this.value||null;h.newChat();$("projectEdit").hidden=!h.state.projectId;h.refresh();syncControls();};
      $("modeSelect").onchange=async function(){if(document.querySelector("#thread .msg")){this.value=h.state.mode;return;}var old=h.state.mode;h.state.mode=this.value;syncControls();try{if(h.state.conversationId)await api("/conversations/"+h.state.conversationId,"PATCH",{mode:h.state.mode});}catch(e){h.state.mode=old;this.value=old;syncControls();notice(e);}};
      document.querySelectorAll("[data-work-view]").forEach(function(b){b.onclick=function(){show(b.dataset.workView);};});
      $("workBody").onclick=async function(e){var b=e.target.closest("[data-work-action]");if(!b)return;b.disabled=true;try{await act(b.dataset.workAction,b.dataset.id);}catch(err){notice(err);}finally{b.disabled=false;}};
      document.querySelectorAll('[data-mode]').forEach(function(b){b.onclick=function(){$('modeSelect').value=b.dataset.mode;$('modeSelect').dispatchEvent(new Event('change'));};});
      $('projectList').onclick=function(e){var b=e.target.closest('[data-project]');if(b){$('projectSelect').value=b.dataset.project;$('projectSelect').dispatchEvent(new Event('change'));}};
      document.querySelectorAll('[data-starter]').forEach(function(b){b.onclick=function(){$('input').value=b.dataset.starter;$('input').dispatchEvent(new Event('input'));$('input').focus();};});
      $('handoffWork').onclick=async function(){if(h.state.busy)return;try{var target=await api('/conversations/'+h.state.conversationId+'/handoff','POST',{});await h.refresh();await h.openChat(target.id);}catch(e){notice(e);}};
      loadProjects().catch(notice);
    },
    sync: function(){if(!h)return;syncControls();$("projectSelect").value=h.state.projectId||"";$("modeSelect").value=h.state.mode||"chat";$("projectEdit").hidden=!h.state.projectId;},
    refresh: function(){return loadProjects().catch(notice);}
  };
})();
