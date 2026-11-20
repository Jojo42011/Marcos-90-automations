// Run after npm run build. Uses an SDK fixture; never contacts connected apps.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url), records=[], accounts=new Map(), calls=[];
const project={id:'old-project',owner:'alice',kind:'project'};
records.push(project);
const store={
  list:(kind,owner)=>records.filter(r=>r.kind===kind&&r.owner===owner),
  get:(kind,owner,id)=>{const value=records.find(r=>r.kind===kind&&r.owner===owner&&r.id===id);if(!value)throw new Error('Not found');return value;},
  put:(kind,owner,value)=>records.push({...value,kind,owner})
};
function toolkit(slug,active=false,accountId){
  const id=accountId||slug+'-account';
  return {slug,name:slug,logo:null,connection:{isActive:active,connectedAccount:{id}}};
}
function accountRow(slug,id,extra={}){
  return {
    id,
    status:'ACTIVE',
    isDisabled:false,
    toolkit:{slug},
    alias:extra.alias||null,
    data:extra.data||{},
    authConfig:{id:'auth-'+slug,isComposioManaged:true,isDisabled:false},
    statusReason:null,
    createdAt:'2026-01-01T00:00:00Z',
    updatedAt:'2026-01-01T00:00:00Z',
  };
}
const sdk={Composio:class {
  sessions={create:async id=>session(id),use:id=>session(id)};
  authConfigs={
    list:async({toolkit})=>{calls.push({authList:toolkit});return {items:[{id:'auth-'+toolkit}]};},
    create:async(slug)=>({id:'auth-created-'+slug}),
  };
  connectedAccounts={
    list:async(query)=>{
      calls.push({list:query});
      const userIds=query?.userIds||[];
      let items=[];
      for(const [scope,rows] of accounts){
        if(userIds.length&&!userIds.includes(scope))continue;
        items=items.concat(rows.filter(a=>!query?.statuses||query.statuses.includes(a.status)));
      }
      if(query?.cursor==='accounts-2')return {items:items.slice(1),nextCursor:null,totalPages:1};
      return {items:items.slice(0,1),nextCursor:items.length>1?'accounts-2':null,totalPages:items.length>1?2:1};
    },
    link:async(userId,authConfigId,options)=>{
      calls.push({link:{userId,authConfigId,options}});
      return {redirectUrl:'https://connect.example/'+authConfigId,id:'pending'};
    },
    delete:async id=>{
      for(const [scope,items] of accounts)accounts.set(scope,items.filter(a=>a.id!==id));
    },
  };
  toolkits={get:async slug=>({slug,name:slug,authConfigDetails:[{}]})};
}};
function session(id){return {
  sessionId:id,
  toolkits:async options=>{
    calls.push({id,options});
    if(options.isConnected){
      const rows=accounts.get(id)||[];
      return {items:rows.map(a=>toolkit(a.toolkit.slug,true,a.id)),cursor:undefined};
    }
    if(options.search==='broken')throw new Error('Provider failed fixture-secret');
    return options.cursor?{items:[toolkit('videodb')],cursor:undefined}:{items:[toolkit(options.search||'canva')],cursor:'catalog-2'};
  },
  authorize:async slug=>({redirectUrl:'https://connect.example/'+slug}),
  tools:async()=>[{function:{name:'COMPOSIO_SEARCH_TOOLS',description:'Search',parameters:{type:'object',properties:{}}}}],
  execute:async(name,input)=>{calls.push({id,name,input});return {data:{id,name,input}};}
};}
function load(){
  const exports={};
  vm.runInNewContext(readFileSync('dist/src/harvey/work/composio.js','utf8'),{
    exports,require:name=>name==='./store.js'?store:require(name),URL,
    process:{env:{COMPOSIO_API_KEY:'fixture-secret'}},
    Function:function(){return async()=>sdk;}
  });return exports;
}
let m=load(), owner=m.composioUser('alice',null), legacy=m.composioUser('alice',project.id);
let catalog=await m.managedCatalog('alice',null);
assert.equal(catalog.items[0].slug,'canva');assert.equal(catalog.cursor,'catalog-2');
assert(!('toolkits' in calls[0].options),'catalog must not be restricted to a featured allowlist');
await m.managedCatalog('alice',null,'video','catalog-2');
assert(calls.some(c=>c.options?.search==='video'&&c.options?.cursor==='catalog-2'));
assert.equal((await m.managedCatalog('alice',null,'video','catalog-2')).cursor,null);
await assert.rejects(()=>m.managedCatalog('bob',project.id),/Not found/);
await assert.rejects(()=>m.managedCatalog('alice',null,'broken'),e=>!e.message.includes('fixture-secret')&&e.message.includes('[redacted]'));
console.log('ok full catalog, search pagination, terminal cursor, owner isolation and redacted errors');
assert.equal((await m.connectManaged('alice',project.id,'canva')).url,'https://connect.example/auth-canva');
assert(calls.some(c=>c.link?.options?.allowMultiple===true),'connect must allow multiple accounts');
assert.equal((await m.managedConnections('alice')).length,0,'authorization link alone is not a connection');
accounts.set(owner,[
  accountRow('canva','canva-account'),
  accountRow('googledrive','drive-account'),
  accountRow('gmail','gmail-a',{alias:'marco@example.com'}),
  accountRow('gmail','gmail-b',{data:{email:'wesley@example.com'}}),
]);
assert.equal((await m.managedConnections('alice')).length,4,'all connection pages, active only, multi-account');
const gmails=(await m.managedConnections('alice')).filter(c=>c.slug==='gmail');
assert.equal(gmails.length,2);
assert.equal(gmails[0].label,'marco@example.com');
assert.equal(gmails[1].label,'wesley@example.com');
m=load();
assert.equal((await m.managedConnections('alice')).length,4,'persisted session reused after restart');
assert.equal((await m.managedConnections('bob')).length,0);
let result=await m.executeManaged('alice',project.id,'COMPOSIO_SEARCH_TOOLS',{user_id:'bob',session_id:'forged'});
assert.equal(result.id,owner);assert(!('user_id' in result.input));assert(!('session_id' in result.input));
console.log('ok successful sign-in visible owner-wide after restart; other users and input scope overrides isolated');
await m.composioSession('alice',project.id);accounts.set(legacy,[accountRow('gmail','legacy-gmail')]);
await assert.rejects(()=>m.executeManaged('alice',null,'COMPOSIO_SEARCH_TOOLS',{}),/Multiple connection scopes/);
result=await m.executeManaged('alice',null,'COMPOSIO_SEARCH_TOOLS',{harvey_connection_scope:legacy});assert.equal(result.id,legacy);
result=await m.executeManaged('alice',project.id,'COMPOSIO_WAIT_FOR_CONNECTIONS',{});assert.equal(result.id,owner);
await assert.rejects(()=>m.executeManaged('bob',null,'COMPOSIO_SEARCH_TOOLS',{harvey_connection_scope:legacy}),/Unknown connection scope/);
await m.disconnectManaged('alice',null,'canva',owner,'canva-account');
assert(!(await m.managedConnections('alice')).some(t=>t.slug==='canva'));
await m.disconnectManaged('alice',null,'gmail',owner,'gmail-a');
const remainingGmail=(await m.managedConnections('alice')).filter(t=>t.slug==='gmail'&&t.scope===owner);
assert.equal(remainingGmail.length,1,'disconnect removes only the selected account');
assert.equal(remainingGmail[0].accountId,'gmail-b');
const schemas=await m.managedTools('alice',project.id);
assert(schemas[0].input_schema.properties.harvey_connection_scope.enum.includes(legacy));
console.log('ok explicit legacy account routing, owner-wide sign-in wait, per-account disconnect and current tool scope schemas');
