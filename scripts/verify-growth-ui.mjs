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

// Smart Poster now uses real Astryx components; verify its shared scheduling model.
await import('./verify-smartposter-ui.mjs');
analytics.TREND_DAYS=7;analytics.TREND_METRIC='views';
const daily=[{accountId:'a',dailyPerformance:{days:[{date:'2026-11-06',metrics:{views:30}}]}}];
let series=analytics.trendSeries(daily,'2026-11-07T20:00:00Z');
assert.equal(series.length,14);assert.equal(series[13].date,'2026-11-06');assert.equal(series[13].value,30);
assert.equal(series[12].value,null,'Missing dates must not become zero');
assert.equal(series[13].complete,true);
series=analytics.trendSeries([...daily,{accountId:'b',dailyPerformance:{days:[]}}],'2026-11-07T20:00:00Z');
assert.equal(series[13].value,30);assert.equal(series[13].complete,false);
assert.match(analytics.growthActions([]),/not available/);
assert.doesNotMatch(read('analytics'),/Your next move|Find what moves your audience/);
assert.doesNotMatch(read('crm-brivity'),/Turn attention into appointments/);

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
