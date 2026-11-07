// No server, build, dependencies, or live integrations required.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const read = name => readFileSync(new URL('../public/' + name + '.html', import.meta.url), 'utf8');
for (const name of ['analytics', 'smartposter', 'crm-brivity']) {
  for (const [, code] of read(name).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(code);
}
const scripts = name => [...read(name).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('var DATA'));
const analytics = vm.createContext({ URL, Date, console });
vm.runInContext(scripts('analytics').split('document.getElementById("view").addEventListener')[0], analytics);
assert.equal(analytics.num(null), null);
assert.equal(analytics.num(0), '0');
assert.match(analytics.card('Views', null), /No data/);
assert.doesNotMatch(analytics.card('Views', 0), /No data/);
assert.equal(analytics.safePostURL('javascript:alert(1)'), '');
assert.equal(analytics.safePostURL('https://example.com/post'), 'https://example.com/post');
assert.match(analytics.statusBanner({status:'live',stale:true}), /stale/);
const recent = {label:'Sample',recentPosts:[
  {caption:'First home',views:0,comments:9,url:'javascript:alert(1)'},
  {caption:'Listing guide',views:20,comments:1,url:'https://example.com'}
]};
analytics.POST_QUERY='home';
assert.match(analytics.postRows(recent), /First home/);
assert.doesNotMatch(analytics.postRows(recent), /Listing guide|javascript:/);
analytics.POST_QUERY='';analytics.POST_SORT='comments';
assert.ok(analytics.postRows(recent).indexOf('First home') < analytics.postRows(recent).indexOf('Listing guide'));
analytics.DATA={platforms:[]};
assert.match(analytics.combinedBody({included:[],excluded:[]}), /connected data/);

const smart = vm.createContext({ Date, Intl, Set, console });
vm.runInContext(scripts('smartposter').split('document.getElementById("tabs").onclick')[0], smart);
smart.DATA={today:'2026-11-08',settings:{timezone:'America/Chicago'},accounts:[{id:'a',platform:'instagram'},{id:'b',platform:'instagram'}]};
assert.equal(smart.weekDates()[0],'2026-11-02'); // Sunday still belongs to Monday's week.
smart.WEEK_OFFSET=1;assert.equal(smart.weekDates()[0],'2026-11-09');
smart.FILTER.add('a');
assert.equal(smart.postMatchesFilter({accountIds:['a'],platforms:['instagram'],status:'ready'}),true);
assert.equal(smart.postMatchesFilter({accountIds:['b'],platforms:['instagram'],status:'ready'}),false);
smart.STATUS_FILTER='failed';
assert.equal(smart.postMatchesFilter({accountIds:['a'],status:'ready'}),false);
assert.equal(smart.postMatchesFilter({accountIds:['a'],status:'failed'}),true);
assert.equal(new Date(smart.localInputTime('2026-11-07T16:00:00Z')).toISOString(),'2026-11-07T16:00:00.000Z');
let error='';smart.drawerError=message=>{error=message;};
smart.document={getElementById:()=>({classList:{contains:()=>true}})};
const button={disabled:false};
await smart.runAction(button,async()=>{throw Error('Try again');});
assert.equal(error,'Try again');assert.equal(button.disabled,false);

// Scheduling from the drawer must save the current form before sending the post.
const elements=new Map();
smart.document={querySelectorAll:()=>[{value:"a"}],getElementById:id=>{
  if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',checkValidity:()=>true,classList:{contains:()=>true}});
  return elements.get(id);
}};
smart.showDrawer=()=>{};smart.load=async()=>{};
smart.DATA.posts=[{id:'draft-1',status:'draft',title:'Old title',caption:'Old caption',platforms:['instagram']}];
const requests=[];smart.api=async(method,path,body)=>{requests.push({method,path,body});return {};};
smart.openPostDrawer('draft-1');
elements.get('savePost');
smart.document.getElementById('editCaption').value='Edited before scheduling';
smart.document.getElementById('editTitle').value='New title';
smart.document.getElementById('editDate').value='2026-11-09';
smart.document.getElementById('editTime').value='10:00';
await elements.get('schedPost').onclick();
assert.equal(requests.length,1);
assert.equal(requests[0].method,'POST');
assert.equal(requests[0].body.caption,'Edited before scheduling');
assert.equal(requests[0].body.localDate,'2026-11-09');
assert.equal(requests[0].body.localTime,'10:00');
assert.equal(requests[0].body.accountIds.join(','),'a');
assert.match(requests[0].path,/draft-1\/schedule$/);

// A drop opens the date/time review; it never publishes automatically.
const dragHandlers={},dayHandlers={};
const dragCard={dataset:{id:'draft-1'},classList:{add(){},remove(){}},addEventListener:(k,v)=>dragHandlers[k]=v};
const day={dataset:{day:'2026-11-12'},classList:{add(){},remove(){}},contains:()=>false,addEventListener:(k,v)=>dayHandlers[k]=v};
const fakeView={innerHTML:'',querySelectorAll:selector=>selector==='[draggable="true"]'?[dragCard]:selector==='[data-day]'?[day]:[]};
smart.document={getElementById:id=>id==='view'?fakeView:id==='sub'?{}:null,querySelectorAll:()=>[]};
smart.renderBanner=smart.renderSummary=smart.renderProfiles=()=>{};smart.renderCalendar=()=>'';
smart.VIEW='calendar';let dropped=null;smart.openPostDrawer=(id,date)=>dropped={id,date};
smart.render();
let payload;const transfer={setData:(_,value)=>payload=value,getData:()=>payload};
dragHandlers.dragstart({dataTransfer:transfer});dayHandlers.drop({preventDefault(){},dataTransfer:transfer});
assert.deepEqual(dropped,{id:'draft-1',date:'2026-11-12'});
assert.equal(requests.length,1,'Dropping must not send a publish request');
const sample=[{status:'live',label:'Account A',recentPosts:[1,2,3,9].map((n,i)=>({id:i,caption:'Caption',views:1000,comments:n}))}];
assert.equal(analytics.growthCandidates(sample,'comments')[0].score,9);
assert.equal(analytics.growthCandidates(sample,'comments')[0].baseline,2);
assert.equal(analytics.growthCandidates([{...sample[0],recentPosts:sample[0].recentPosts.slice(0,3)}],'comments').length,0);

// A slower response for a previous agent filter must never overwrite the latest filter.
const crmSource=read('crm-brivity');
const section=crmSource.slice(crmSource.indexOf('function fmtPoNum('),crmSource.indexOf('function renderTakeAction('));
const pending=[];const panel={innerHTML:'',addEventListener(){}};
const crm=vm.createContext({URLSearchParams,console,esc:s=>String(s??''),USER_FILTER:null,crmApi:s=>s,
  document:{getElementById:()=>panel},fetch:()=>new Promise(resolve=>pending.push(resolve))});
vm.runInContext(section,crm);
crm.renderPipelineOverview();crm.USER_FILTER=['Wesley'];crm.renderPipelineOverview();
pending[1]({ok:true,json:async()=>({ok:true,agent:'Wesley',notes:[]})});
await new Promise(resolve=>setImmediate(resolve));
assert.match(panel.innerHTML,/Wesley/);
pending[0]({ok:true,json:async()=>({ok:true,agent:'Marco',notes:[]})});
await new Promise(resolve=>setImmediate(resolve));
assert.match(panel.innerHTML,/Wesley/);assert.doesNotMatch(panel.innerHTML,/Marco/);
assert.doesNotMatch(crm.poFunnelHTML({steps:[{kind:'people',key:'closed',label:'Closed',count:0}]}),/NaN|Infinity/);
console.log('Growth UI checks passed: syntax, honest metrics, search/sort, URL safety, account filters, dates, action recovery, and stale-response protection.');
