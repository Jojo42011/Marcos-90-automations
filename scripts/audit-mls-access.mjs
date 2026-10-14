// Explicit operator audit. Read-only MLS requests; temporary auth sessions are revoked.
// Never log credentials, listing contents, user IDs or authentication cookies.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {getUsers}=require('../dist/src/core/users.js');
const {createSession,destroySession,recordAudit}=require('../dist/src/core/authStore.js');
const {searchMlsLive}=require('../dist/src/integrations/simplyrets/index.js');
const base='http://127.0.0.1:'+(process.env.PORT||3000),accounts=[];
for(const name of ['marco','wesley','carlos']) {
 const users=getUsers().filter(u=>u.active!==false&&u.name.trim().split(/\s+/)[0].toLowerCase()===name);assert.equal(users.length,1,'Expected one active team account');
 const token=createSession(users[0].id,{headers:{'user-agent':'MLS access audit'},socket:{remoteAddress:'127.0.0.1'}});
 recordAudit({userId:users[0].id,action:'mls_access_audit',detail:'Read-only MLS authentication check; temporary session revoked afterwards'});
 try {
  const response=await fetch(base+'/api/mls/ping',{headers:{cookie:'mp_sid='+token},redirect:'manual'});assert.equal(response.status,200,'MLS route unavailable');
  const result=await response.json();assert.equal(result.ok,true,'MLS authentication failed');accounts.push({account:name,authenticated:true,listingReturned:!!result.sample});
 } finally {destroySession(token);}
}
const live=await searchMlsLive({limit:1});assert.equal(live.ok,true,'Direct live MLS query failed');
console.log(JSON.stringify({mlsAccessAudit:'passed',accounts,directRead:true,listingCount:live.count,note:'No listing contents or credentials logged; no customer or MLS records changed.'}));
