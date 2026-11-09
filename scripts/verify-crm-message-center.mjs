import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {collectOverviewAlerts}=require('../public/overview-alerts.js');
const now=Date.parse('2026-11-09T18:00:00Z'),recent='2026-11-09T12:00:00Z';
const data={now,leads:[{id:'a',name:'Alex'},{id:'b',name:'Blair'}],conversations:[
 {key:'a',leadId:'a',names:['Alex'],channel:'instagram',at:recent,msgs:[{me:false,t:'Can we tour?',at:recent}]},
 {key:'b',leadId:'b',names:['Blair'],at:recent,msgs:[{me:true,t:'Sent',at:recent}]},
 {key:'old',leadId:'a',names:['Alex'],msgs:[{me:false,at:'2026-10-01T12:00:00Z'}]}
],tasks:[{id:'due',leadId:'a',title:'Call Alex',dueDate:'2026-11-07',status:'pending'},{id:'done',leadId:'a',dueDate:'2026-11-07',status:'completed'},{id:'future',leadId:'a',dueDate:'2026-12-01',status:'pending'}],notifications:[{id:'n',leadId:'b',notificationType:'listing_active',createdAt:recent,message:'Back on the market'},{id:'read',leadId:'a',notificationType:'re_engagement',createdAt:recent,read:true},{id:'noise',leadId:'a',notificationType:'sync_done',createdAt:recent}],scheduled:[{id:'failed',leadId:'a',status:'failed',sendAt:recent},{id:'sent',leadId:'a',status:'sent',sendAt:recent}]};
const rows=collectOverviewAlerts(data);
assert.deepEqual(new Set(rows.map(r=>r.key)),new Set(['reply:a','task:due','update:n','failed:failed']));
assert.equal(collectOverviewAlerts({...data,allowedIds:[]}).length,0);
assert(!collectOverviewAlerts({...data,allowedIds:['a']}).some(r=>r.key==='update:n'));
assert.equal(collectOverviewAlerts({now}).length,0);
assert(rows.every(r=>r.conversationKey||r.leadId||r.scheduledId));
const html=readFileSync(new URL('../public/crm-brivity.html',import.meta.url),'utf8');
for(const [,code] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(code);
assert(!html.includes('How to read these pipelines'));
const identity=html.slice(html.indexOf('function convKey(c)'),html.indexOf('/* Can this thread put a real text'));
const ctx=vm.createContext({});vm.runInContext(identity,ctx);
assert.notEqual(ctx.convKey({quo:true,peerKey:'555',phoneNumberId:'a'}),ctx.convKey({quo:true,peerKey:'555',phoneNumberId:'b'}));
assert.notEqual(ctx.convKey({channel:'instagram',leadId:'a'}),ctx.convKey({channel:'email',leadId:'a'}));
assert.notEqual(ctx.convKey({channel:'instagram',leadId:'owner:a'}),ctx.convKey({channel:'instagram',leadId:'other:a'}));
console.log('CRM checks passed: actionable-only alerts, dates, agent filters, direct targets, script syntax and channel/line identity.');
