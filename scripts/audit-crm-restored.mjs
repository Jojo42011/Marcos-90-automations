// Operator recovery audit: compare retained backup, tenant store and actual CRM
// HTTP response. Only counts are logged. The temporary audit session is revoked.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {getUsers}=require('../dist/src/core/users.js');
const {createSession,destroySession,recordAudit}=require('../dist/src/core/authStore.js');
const candidates=getUsers().filter(u=>/^marco(?:\s|$)/i.test(u.name));assert.equal(candidates.length,1);
const user=candidates[0],root=process.env.TENANT_DATA_ROOT||'/data';
const folder=join(root,'accounts',createHash('sha256').update(user.id).digest('hex'));
const receipt=JSON.parse(readFileSync(join(folder,'crm-recovery-receipt.json')));
const backup=JSON.parse(readFileSync(join(root,'crm-recovery-backups',receipt.sourceDigest+'.json')));
const restored=JSON.parse(readFileSync(join(folder,'db.json')));
for(const [id,lead] of Object.entries(backup.leadsById)){assert(restored.leadsById[id],'A retained lead is missing');assert.equal(restored.leadsById[id].phone,lead.phone,'A retained phone differs');assert.equal(restored.leadsById[id].phoneNumber,lead.phoneNumber,'A retained phone differs');}
for(const id of Object.keys(backup.conversationsByLeadId||{}))assert(restored.conversationsByLeadId[id],'A retained conversation is missing');
const token=createSession(user.id,{headers:{'user-agent':'CRM recovery audit'},socket:{remoteAddress:'127.0.0.1'}});
recordAudit({userId:user.id,action:'crm_recovery_audit',detail:'Temporary local session for read-only restored CRM endpoint verification'});
try{
 const response=await fetch(`http://127.0.0.1:${process.env.PORT||3000}/api/dashboard/data?includePhoneless=1`,{headers:{cookie:`mp_sid=${token}`},redirect:'manual'});
 assert.equal(response.status,200,'Marco CRM endpoint unavailable');const body=await response.json();
 const ids=new Set(body.leads.map(l=>String(l.id)));for(const id of Object.keys(backup.leadsById))assert(ids.has(id),'Restored lead missing from Marco CRM response');
 console.log(JSON.stringify({crmRecovery:'passed',retainedLeads:Object.keys(backup.leadsById).length,retainedWithPhone:Object.values(backup.leadsById).filter(l=>l.phone||l.phoneNumber).length,retainedConversations:Object.keys(backup.conversationsByLeadId||{}).length,visibleCrmLeads:body.leads.length,backupVerified:true,httpStatus:response.status}));
}finally{destroySession(token);}
