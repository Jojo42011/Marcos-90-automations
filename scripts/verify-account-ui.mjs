import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const html=readFileSync('public/crm-brivity.html','utf8');
const code=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(s=>s.trim()).join('\n');
new vm.Script(code);
assert(html.indexOf('/account-session.js')<html.indexOf('let LEADS='));
const parsed=ts.createSourceFile('crm.js',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const declarations=new Map();
for(const node of parsed.statements)if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations)declarations.set(d.name.getText(parsed),d.initializer?.getText(parsed));
for(const name of ['LEADS','PEOPLE','CONVOS','CAMPAIGNS','DRIPS','NEWSLETTERS'])assert.equal(declarations.get(name),'[]',name+' starts empty');
const apply=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='applyLive').getText(parsed);
const element={textContent:''};
const context=vm.createContext({window:{},document:{getElementById:()=>element,querySelector:()=>element},
 LEADS:[],PEOPLE:[],CONVOS:[],TX:[],LIVE_DATA:false,DEMO_REASON:'',currentReport:'business',
 loadTransactions:async()=>[],mapLeadRow:x=>x,mapPeopleLive:x=>x,deriveConvosLive:()=>[],calEventsFromTx:()=>[],
 ...Object.fromEntries(['paintDataBanner','loadScheduled','renderTakeAction','renderFeed','renderTracking','renderConvos','renderLeads','renderPeople','renderTx','renderCal','renderReport','renderNurture','renderFinance'].map(k=>[k,()=>{}]))});
vm.runInContext(apply,context);
await context.applyLive({leads:[],deals:[]},null,{});
assert.equal(context.LIVE_DATA,true);assert.equal(context.LEADS.length,0);
await context.applyLive({leads:[{id:'own',name:'Own first contact'}],deals:[]},null,{});
assert.equal(context.LEADS.length,1);assert.equal(context.LEADS[0].id,'own');
await context.applyLive({leads:[],deals:[]},null,{});
assert.equal(context.LEADS.length,0);
console.log('CRM starts empty, accepts zero/one live contacts, and removes deleted contacts without demo fallback.');

const storage=new Map([['accountCacheOwner','previous'],['marcoEmailAdd','private-draft']]);
function adapter(map){return {get length(){return map.size;},key:i=>[...map.keys()][i],getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}}
const handlers={}, session=new Map();
function run(owner){vm.runInNewContext(readFileSync('public/account-session.js','utf8'),{document:{cookie:'mp_account_id='+owner+'; mp_account='+owner},localStorage:adapter(storage),sessionStorage:adapter(session),window:{addEventListener:(e,f)=>handlers[e]=f},location:{reload:()=>{handlers.reloaded=true;}}});}
run('carlos');assert.equal(storage.has('marcoEmailAdd'),false);assert.equal(JSON.parse(storage.get('accountArchive:previous')).marcoEmailAdd,'private-draft');assert.equal(storage.get('marcoTaskUser'),'carlos');
storage.set('newDraft','Keep my work');run('wesley');assert.equal(storage.has('newDraft'),false);run('carlos');assert.equal(storage.get('newDraft'),'Keep my work');
handlers.storage({key:'accountCacheOwner',newValue:'wesley:wesley'});assert.equal(handlers.reloaded,true);
console.log('Account switches isolate display data, retain drafts and restore them on return.');
