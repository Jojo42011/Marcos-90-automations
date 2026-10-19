import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const cases=['storage','corruption','ids','brivity','smtp'];
if(!process.argv[2]) {
 for(const name of cases){const r=spawnSync(process.execPath,[process.argv[1],name],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});assert.equal(r.status,0,name+'\n'+r.stdout+r.stderr);console.log('PASS',name);}
 process.exit(0);
}
const require=createRequire(import.meta.url), root=mkdtempSync(join(tmpdir(),'storage-guards-'));
process.env.TENANT_DATA_ROOT=root;process.env.DB_JSON_PATH=join(root,'db.json');
global.fetch=async()=>{throw Error('External requests prohibited');};
const mod=p=>require('../dist/src/'+p+'.js');
const lead={platform:'tiktok',userId:'fixture',name:'Original',phone:null,email:null,username:null};
try {
 switch(process.argv[2]) {
 case 'storage': {
  const db=mod('core/db'),fs=require('node:fs');const row=db.upsertLeadQuiet(lead);
  const original=readFileSync(process.env.DB_JSON_PATH,'utf8');
  for(const operation of ['writeFileSync','fsyncSync','renameSync']) {
   const saved=fs[operation];fs[operation]=()=>{throw Error('fixture disk failure');};
   try{assert.throws(()=>db.upsertLeadQuiet({...row,name:'Failed edit'}),/fixture disk failure/);}finally{fs[operation]=saved;}
   assert.equal(readFileSync(process.env.DB_JSON_PATH,'utf8'),original);
   assert.equal((await db.getLead(lead.platform,lead.userId)).name,'Original');
   assert(!readdirSync(root).some(f=>f.endsWith('.pending')));
  }
  db.upsertLeadQuiet({...row,name:'Saved edit'});
  delete require.cache[require.resolve('../dist/src/core/db.js')];
  assert.equal((await mod('core/db').getLead(lead.platform,lead.userId)).name,'Saved edit');break;
 }
 case 'corruption': {
  for(const raw of ['{"broken"','','null','[]','{"leadsById":[]}']) {
   writeFileSync(process.env.DB_JSON_PATH,raw);
   assert.throws(()=>mod('core/db'),/refusing to overwrite/);
   assert.equal(readFileSync(process.env.DB_JSON_PATH,'utf8'),raw);
  }break;
 }
 case 'ids': {
  const db=mod('core/db');db.upsertLeadQuiet({...lead,id:'1'});
  const other=db.upsertLeadQuiet({...lead,userId:'other'});
  assert.notEqual(other.id,'1');assert.equal((await db.getLead(lead.platform,lead.userId)).id,'1');break;
 }
 case 'brivity': {
  const axios=require('axios');let gets=0,posts=0,puts=0,mode='failed';
  axios.create=()=>({get:async()=>{gets++;if(mode==='failed')throw Error('fixture lookup unavailable');return {data:mode==='found'?[{id:'existing'}]:[]};},post:async()=>{posts++;return {data:{id:'new'}};},put:async()=>{puts++;return {data:{id:'existing'}};}});
  let b=mod('integrations/brivity');assert.equal(await b.syncLead({...lead,phone:'fixture'}),null);assert.equal(gets+posts+puts,0);
  process.env.BRIVITY_API_KEY='fixture';delete require.cache[require.resolve('../dist/src/integrations/brivity.js')];b=mod('integrations/brivity');
  assert.equal(await b.syncLead({...lead,phone:'fixture'}),null);assert.equal(posts,0);
  mode='found';assert.equal((await b.syncLead({...lead,phone:'fixture'})).id,'existing');assert.equal(puts,1);assert.equal(posts,0);
  mode='empty';assert.equal((await b.syncLead({...lead,phone:'fixture'})).id,'new');assert.equal(posts,1);break;
 }
 case 'smtp': {
  process.env.GMAIL_SMTP_USER='fixture@example.invalid';process.env.GMAIL_SMTP_APP_PASSWORD='fixture';
  const client=mod('core/smtpClient'),smtp=mod('integrations/smtp/index');
  client.smtpLoginCheck=async()=>{throw new AggregateError([Error('ECONNREFUSED fixture'),Error('ETIMEDOUT fixture')],'');};
  const result=await smtp.verifySmtpConnection();assert.equal(result.ok,false);assert.match(result.error,/ECONNREFUSED/);assert.match(result.error,/ETIMEDOUT/);
  client.smtpSend=async()=>{throw new AggregateError([],'');};
  await assert.rejects(()=>smtp.sendViaSmtp({to:'fixture@example.invalid',subject:'Fixture',body:'Fixture'}),/SMTP connection failed/);break;
 }
 }
} finally {if(process.argv[2]==='smtp')mod('core/emailStore').getEmailDb().close();rmSync(root,{recursive:true,force:true});}
