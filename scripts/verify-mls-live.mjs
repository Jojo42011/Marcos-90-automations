import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'mls-live-'));
process.env.TENANT_DATA_ROOT=dir;process.env.HARVEY_WORK_DIR=join(dir,'work');process.env.AI_USAGE_DB_PATH=join(dir,'usage.db');
const {searchMlsLive}=require('../dist/src/integrations/simplyrets/index.js');
const {tenantEnvironment}=require('../dist/src/core/tenantGateway.js');
const store=require('../dist/src/harvey/work/store.js'),loop=require('../dist/src/hull/agentLoop.js'),runtime=require('../dist/src/harvey/work/runtime.js'),local=require('../dist/src/harvey/work/localBrowser.js');
let inspect=async()=>{};loop.runAgentLoop=async opts=>{await inspect(opts.workRuntime);return {speech:'Fixture verified',toolRounds:0,model:'fixture'};};
const realFetch=global.fetch;let calls=0;
try {
 delete process.env.SIMPLYRETS_USERNAME;delete process.env.SIMPLYRETS_PASSWORD;
 assert.equal((await searchMlsLive({})).ok,false);
 process.env.SIMPLYRETS_USERNAME='fixture-user';process.env.SIMPLYRETS_PASSWORD='fixture-password';process.env.SIMPLYRETS_VENDOR='sabor';
 global.fetch=async(url,init)=>{calls++;const u=new URL(url);assert.equal(u.origin,'https://api.simplyrets.com');assert.equal(u.searchParams.get('cities'),'San Antonio');assert.equal(u.searchParams.get('limit'),'2');assert.equal(u.searchParams.get('vendor'),'sabor');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Basic '+Buffer.from('fixture-user:fixture-password').toString('base64'));return new Response(JSON.stringify([{mlsId:'fixture1'},{mlsId:'fixture2'}]),{headers:{link:'<https://api.simplyrets.com/properties?offset=2>; rel="next"'}});};
 const result=await searchMlsLive({city:'San Antonio',limit:2,minPrice:0,maxPrice:500000});assert.equal(result.nextOffset,2);assert.equal(result.count,2);assert(!JSON.stringify(result).includes('fixture-password'));
 for(const bad of [{url:'https://evil.test'},{limit:51},{limit:1.5},{offset:-1},{minBeds:'2'},{status:'Bogus'},{minPrice:5,maxPrice:1}])assert.equal((await searchMlsLive(bad)).ok,false);
 assert.equal(calls,1);
 global.fetch=async()=>new Response('must not echo upstream credentials',{status:401});const denied=await searchMlsLive({});assert(denied.authenticationFailed);assert(!JSON.stringify(denied).includes('must not echo'));
 global.fetch=async()=>new Response('{}');assert.equal((await searchMlsLive({})).ok,false);
 global.fetch=async()=>{throw Error('credential-containing upstream error');};assert(!JSON.stringify(await searchMlsLive({})).includes('credential-containing'));
 for(const who of ['marco','wesley','carlos']){
  const env=tenantEnvironment(who,{...process.env,BRIVITY_API_KEY:'private',GMAIL_REFRESH_TOKEN:'private'});assert.equal(env.SIMPLYRETS_PASSWORD,'fixture-password');assert.equal(env.BRIVITY_API_KEY,undefined);assert.equal(env.GMAIL_REFRESH_TOKEN,undefined);
  process.env.TENANT_MEMBER=who;const chat=store.createChat(who,{mode:'work'});
  inspect=async r=>{const discovery=await r.execute('business_tools',{});for(const name of ['search_mls_live','search_listings','get_listing','get_mls_status'])assert(discovery.tools.some(t=>t.name===name),who+' missing '+name);};
  await runtime.runChat(who,chat,'Check MLS capabilities');
  local.connectLocalBrowser(who,chat.id);
  inspect=async r=>{assert((await r.execute('computer',{action:'tools'})).tools.some(t=>t.name==='browser_snapshot'));assert((await r.execute('use_saved_login',{loginId:'anything'})).error);assert((await r.execute('computer',{action:'call',tool:'browser_snapshot'})).error);};
  await runtime.runChat(who,chat,'Inspect my connected browser');
  inspect=async r=>{assert((await r.execute('computer',{action:'tools'})).error);};
  await runtime.runChat(who,chat,'Scheduled inspection',{},'fixture-scheduled');
  await runtime.runChat(who,chat,'Delegated inspection',{actorId:'different-user',workDelegated:true});
  local.stopLocalBrowser(who,chat.id);
 }
 console.log('ok live MLS filters/pagination/errors, server-only shared credentials, all three runtime tool sets, local saved-login/scheduled/delegated guards');
} finally {global.fetch=realFetch;store.closeStore();rmSync(dir,{recursive:true,force:true});}
