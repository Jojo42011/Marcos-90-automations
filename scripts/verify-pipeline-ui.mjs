import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../public/tracker.html',import.meta.url),'utf8');
const js=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(x=>x.includes('var RECORDS'));
new vm.Script(js);
const elements=new Map();
const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',style:{},scrollLeft:120,open:false});return elements.get(id);};
let pending=[],renders=0,queries=0;
const ctx=vm.createContext({console,Date,JSON,Promise,Array,Error,document:{hidden:false,getElementById:el,querySelectorAll:()=>[]},
 FIRST_LOAD:false,LOADING:false,LOAD_VERSION:0,DATA_VERSION:0,CUR:null,DIRTY:false,SELECTING:false,dragId:null,
 RECORDS:[{id:'old'}],SCHEMA:{statuses:[],buyerStages:[],sellerStages:[]},
 api:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),toast:()=>{},
 paintSelectFilters:()=>{},applyOverviewQuery:()=>queries++,paintStatusChips:()=>{},paintStageChips:()=>{},paintContactChip:()=>{},paintBulkStageOptions:()=>{},renderBoard:()=>renders++});
vm.runInContext(js.slice(js.indexOf('function load(announce,background)'),js.indexOf('setInterval(function(){load(false,true);')),ctx);
let job=ctx.load(false,true);pending.shift().resolve({records:[{id:'updated'}]});await job;
assert.equal(ctx.RECORDS[0].id,'updated');assert.equal(renders,1);assert.equal(el('board').scrollLeft,120);assert.equal(queries,0);
job=ctx.load(false,true);pending.shift().resolve({records:[{id:'updated'}]});await job;assert.equal(renders,1,'Unchanged polling must not rebuild the board');
job=ctx.load(false,true);ctx.CUR={id:'updated'};pending.shift().resolve({records:[{id:'stale'}]});await job;assert.equal(ctx.RECORDS[0].id,'updated');
await ctx.load(false,true);assert.equal(pending.length,0,'Open record pauses polling');ctx.CUR=null;
job=ctx.load(false,true);ctx.DATA_VERSION++;pending.shift().resolve({records:[{id:'pre-save'}]});await job;assert.equal(ctx.RECORDS[0].id,'updated');
job=ctx.load(false,true);pending.shift().reject(Error('Offline'));await job;assert.equal(ctx.RECORDS[0].id,'updated');assert.match(el('syncState').textContent,/failed/);
job=ctx.load(false,true);pending.shift().resolve({records:[]});await job;assert.equal(ctx.RECORDS.length,0,'Empty server data clears removed records');
ctx.DIRTY=true;await ctx.load(false,true);assert.equal(pending.length,0);ctx.DIRTY=false;
ctx.document.hidden=true;await ctx.load(false,true);assert.equal(pending.length,0);
ctx.document.hidden=false;ctx.FIRST_LOAD=true;
job=ctx.load(false,true);pending.shift().resolve({statuses:[],buyerStages:[],sellerStages:[]});pending.shift().resolve({records:[]});await job;
assert.equal(ctx.FIRST_LOAD,false);assert.equal(queries,1,'Initial URL filters must apply once');assert.ok(renders>=3,'Initial empty recovery must render the board');
assert.match(html,/aria-controls="filters"/);assert.match(html,/<dialog id="addPersonDialog"/);assert.match(html,/tabindex="0" aria-label/);
assert.doesNotMatch(js.slice(js.indexOf('function openAddPerson'),js.indexOf('function applyOverviewQuery')),/prompt\(/);
// Exercise the real form submit handler without sending network requests.
let createdBody=null,opened=null;
const formElements=new Map();const formEl=id=>{if(!formElements.has(id))formElements.set(id,{disabled:false,style:{},close(){},click(){}});return formElements.get(id);};
const formContext=vm.createContext({console,Date,FormData:class{get(k){return {name:'  Preview Person  ',side:'seller',phone:'123',email:'sample@example.com',source:'Instagram'}[k];}},document:{getElementById:formEl,querySelectorAll:()=>[]},
 ADD_STAGE:'contacted',SIDE:'buyer',jsonReq:(method,body)=>({method,body}),api:async(path,req)=>{createdBody=req.body;return {record:{id:'new'}};},replaceRecord:()=>{},paintSelectFilters:()=>{},openDrawer:id=>opened=id,toast:()=>{}});
vm.runInContext(js.slice(js.indexOf('function openAddPerson('),js.indexOf('/* ================= Overview deep-link')),formContext);
await formEl('addPersonForm').onsubmit({preventDefault(){}});
assert.equal(createdBody.name,'Preview Person');assert.equal(createdBody.sellerStage,'contacted');assert.equal(createdBody.sides.join(','),'seller');assert.ok(createdBody.stageMeta['seller:contacted'].enteredAt);assert.equal(opened,'new');assert.equal(formEl('createPerson').disabled,false);
formContext.api=async()=>{throw Error('Save failed');};
await formEl('addPersonForm').onsubmit({preventDefault(){}});
assert.equal(formEl('addPersonError').textContent,'Save failed');assert.equal(formEl('createPerson').disabled,false);
console.log('Pipeline UI checks passed: syntax, refresh, unchanged-data preservation, editor protection, mutation races, offline data retention, empty results, and accessible controls.');
