import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const cases=['storage','corruption','scheduled','dm','links','grants','integrations','social','modules'];
if(!process.argv[2]) {
 for(const name of cases){const result=spawnSync(process.execPath,[process.argv[1],name],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});assert.equal(result.status,0,name+'\n'+result.stdout+result.stderr);console.log('PASS',name);}
 process.exit(0);
}
const root=mkdtempSync(join(tmpdir(),'reliability-fix-'));
process.env.TENANT_DATA_ROOT=root;process.env.DB_JSON_PATH=join(root,'db.json');
global.fetch=async()=>{throw new Error('External requests prohibited in regression tests');};
const mod=p=>require('../dist/src/'+p+'.js');
const lead={platform:'tiktok',userId:'fixture-person',name:'Original',phone:null,email:null,username:null};
switch(process.argv[2]) {
 case 'storage': {
  const db=mod('core/db'), fs=require('node:fs');
  const row=db.upsertLeadQuiet(lead);const original=readFileSync(process.env.DB_JSON_PATH,'utf8');
  const rename=fs.renameSync;fs.renameSync=()=>{throw new Error('disk failure');};
  assert.throws(()=>db.upsertLeadQuiet({...lead,id:row.id,name:'Lost'}),/disk failure/);
  fs.renameSync=rename;assert.equal(readFileSync(process.env.DB_JSON_PATH,'utf8'),original);
  assert.equal((await db.getLead('tiktok',lead.userId)).name,'Original');break;
 }
 case 'corruption': {
  writeFileSync(process.env.DB_JSON_PATH,'{"broken"');assert.throws(()=>mod('core/db'),/refusing to overwrite/);
  assert.equal(readFileSync(process.env.DB_JSON_PATH,'utf8'),'{"broken"');break;
 }
 case 'scheduled': {
  const file=join(root,'scheduled-messages.json');
  const entries=Array.from({length:5001},(_,i)=>({id:String(i),leadId:'fixture',channel:'email',to:'fixture@example.invalid',body:'fixture',sendAt:'2000-01-01T00:00:00Z',status:'pending',attempts:0}));
  entries.push({...entries[0],id:'interrupted',status:'sending'});writeFileSync(file,JSON.stringify({messages:entries}));
  const queue=mod('core/scheduledMessages');assert.equal(queue.getScheduled('interrupted').status,'uncertain');
  queue.scheduleMessage({...entries[0],sendAt:'2099-01-01T00:00:00Z',createdBy:'fixture'});
  assert.equal(queue.listScheduled({status:'pending'}).length,5002);
  assert(queue.claimScheduled('0'));assert.equal(queue.claimScheduled('0'),undefined);
  assert.equal(queue.cancelScheduled('0'),false);
  assert.equal(JSON.parse(readFileSync(file)).messages.find(m=>m.id==='0').status,'sending');
  // Overlapping timer passes cannot deliver a claimed message twice.
  for(let i=1;i<5001;i++)queue.getScheduled(String(i)).sendAt='2099-01-01T00:00:00Z';
  let sends=0, release;const hold=new Promise(r=>release=r);
  mod('integrations/email/index').isEmailConfigured=()=>true;
  mod('integrations/email/index').sendEmail=async()=>{sends++;await hold;return {success:true};};
  queue.scheduleMessage({...entries[0],id:undefined,createdBy:'fixture'});
  const sender=mod('core/scheduledSender');const first=sender.processDueMessages();
  await sender.processDueMessages();release();await first;assert.equal(sends,1);break;
 }
 case 'dm': {
  const q=mod('core/durableDmQueue');assert(q.enqueueDm({eventId:'evt'}));assert(!q.enqueueDm({eventId:'evt'}));
  let calls=0;await q.drainDmQueue(async job=>{calls++;q.saveDmReply(job,'prepared');throw new Error('transport down');});
  const file=join(root,'inbound-dm-queue.json');const rows=JSON.parse(readFileSync(file));assert.equal(rows[0].reply,'prepared');
  rows[0].status='processing';rows[0].nextAt=0;writeFileSync(file,JSON.stringify(rows));
  delete require.cache[require.resolve('../dist/src/core/durableDmQueue.js')];const recovered=mod('core/durableDmQueue');
  await Promise.all([recovered.drainDmQueue(async job=>{calls++;assert.equal(job.reply,'prepared');}),recovered.drainDmQueue(async()=>{throw new Error('duplicate');})]);
  assert.equal(calls,2);assert.equal(JSON.parse(readFileSync(file))[0].status,'done');
  recovered.enqueueDm({eventId:'active'});let release;const held=new Promise(r=>release=r);
  const active=recovered.drainDmQueue(async()=>held);
  recovered.enqueueDm({eventId:'new-arrival'});let joined=false;
  await recovered.drainDmQueue(async job=>{assert.equal(job.id,'new-arrival');joined=true;});
  assert(joined,'A new arrival must reach debounce while the previous turn is active');release();await active;break;
 }
 case 'links': {
  process.env.ACCOUNT_ISOLATION='true';process.env.TENANT_OWNER_ID='owner-a';
  const links=mod('core/publicLinks');const link=links.publicLink('/r/stop?k=alert&id=one');
  assert.equal(links.verifyPublicLink(link),'owner-a');
  assert.equal(links.verifyPublicLink(link.replace('id=one','id=two')),undefined);
  assert.equal(links.verifyPublicLink(link.replace('owner-a','owner-b')),undefined);
  assert.equal(links.verifyPublicLink(link.replace('/r/stop','/r/report')),undefined);break;
 }
 case 'grants': {
  const users=mod('core/users');const members=['Marco','Wesley','Carlos'].map((name,i)=>({id:String(i),name,email:name+'@example.invalid',active:true,role:'agent'}));users.saveUsers(members);
  mod('core/workspaceGrants').initializeWorkspaceGrants();const access=mod('core/workspaceAccess');
  assert(access.canViewWorkspace(members[2],'0'));users.updateUser('2',{name:'Renamed'});
  assert(access.canViewWorkspace(users.getUserById('2'),'0'));
  const impostor=users.createUser({name:'Carlos',email:'different@example.invalid',active:true,role:'agent'});
  assert(!access.canViewWorkspace(impostor,'0'));assert.equal(mod('core/workspaceGrants').workspaceMember(impostor.id),impostor.id);assert.equal(mod('core/workspaceGrants').workspaceMember('2'),'carlos');assert(!access.canViewWorkspace(members[1],'0'));break;
 }
 case 'integrations': {
  const settings=mod('core/accountIntegrations');settings.saveIntegrationSettings('a',{GMAIL_REFRESH_TOKEN:'private'});
  assert.equal(settings.accountIntegrationEnvironment('a').GMAIL_REFRESH_TOKEN,'private');
  assert.deepEqual(settings.accountIntegrationEnvironment('b'),{});
  assert.throws(()=>settings.saveIntegrationSettings('a',{TENANT_OWNER_ID:'b'}));
  assert.equal(settings.integrationStatus('a').GMAIL_REFRESH_TOKEN,true);break;
 }
 case 'modules': {
  const db=mod('core/db');db.upsertLeadQuiet({...lead,isPastClient:true});
  const retention=mod('modules/11-past-client-retention/index');
  assert.equal((await retention.runWeeklyUpdates()).created,1);assert.equal((await retention.runWeeklyUpdates()).created,0);
  assert.equal((await retention.runQuarterlyGiftAndReferral()).giftReviews,1);
  assert.equal((await retention.runQuarterlyGiftAndReferral()).giftReviews,0);
  assert.equal((await mod('modules/09-brivity-sync-fix/index').run()).configured,false);
  assert.equal((await mod('modules/12-ab-dm-testing/index').evaluateVariants()).winner,null);
  mod('agents/emailMarketing/noReplyFollowup').checkNoReplyFollowups=async()=>({sent:0,movedToCold:0});
  assert.deepEqual(await mod('modules/10-follow-up-feedback/index').runScheduledFollowUp(),{sent:0,movedToCold:0});break;
 }
 case 'social': {
  const db=mod('core/db');const source={...lead,id:'1',createdAt:'2026-01-01',updatedAt:'2026-01-01'};
  const snapshot={lead:source,conversation:{messages:[{role:'user',text:'hello',at:'2026-01-01'}]}};
  db.mergeSharedSocial([snapshot]);let row=await db.getLead('tiktok',lead.userId);const id=row.id;
  db.upsertLeadQuiet({...row,name:'CRM edit',crmNotes:'Preserve notes'});
  db.mergeSharedSocial([{...snapshot,lead:{...source,name:'Social edit',phone:'fixture-phone'}}]);
  row=await db.getLead('tiktok',lead.userId);assert.equal(row.name,'CRM edit');assert.equal(row.phone,'fixture-phone');assert.equal(row.crmNotes,'Preserve notes');assert.equal(row.id,id);
  assert.equal((await db.getConversation(id)).messages.length,1);db.deleteLead(id);db.mergeSharedSocial([snapshot]);assert.equal(await db.getLead('tiktok',lead.userId),null);break;
 }
}
