// No messages or comments are sent. Includes one synthetic classifier request.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const dm=require('../dist/src/integrations/zernio/dm.js');
const agent=require('../dist/src/agents/commentAgent/index.js');
const ledger=require('../dist/src/core/commentAgentStore.js');
const body=JSON.stringify({event:'service.healthcheck'}), base='http://127.0.0.1:'+(process.env.PORT||3000);
assert(dm.zernioWebhookSecretConfigured(),'Zernio webhook secret is missing');
assert(dm.isZernioDmConfigured(),'Zernio API credential is missing');
assert(agent.isCommentAgentEnabled(),'Comment agent is disabled');
assert(process.env.ANTHROPIC_API_KEY?.trim(),'Comment classifier credential is missing');
const signature=createHmac('sha256',process.env.ZERNIO_WEBHOOK_SECRET.trim()).update(body).digest('hex');
const post=signature=>fetch(base+'/api/zernio/webhook',{method:'POST',headers:{'content-type':'application/json',...(signature?{'x-zernio-signature':signature}:{})},body,signal:AbortSignal.timeout(10000)});
const rejected=await post('');assert.equal(rejected.status,401);
const accepted=await post(signature);assert.equal(accepted.status,200);assert.equal((await accepted.json()).ignored,true);
const manychat=await fetch(base+'/webhook',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});assert.equal(manychat.status,400);
const accounts=await dm.zernioAccounts();assert(accounts.ok,'Zernio connected-account lookup failed with status '+accounts.status);
assert(accounts.accounts.some(a=>a.platform==='tiktok'&&a.active),'No active TikTok connection');
const draft=await agent.classifyAndDraft({commentText:'Please send me the price and location',authorUsername:'audit_fixture'});
assert(draft,'Live comment classification failed');
console.log(JSON.stringify({sharedAutomationAudit:'passed',signedWebhook:accepted.status,unsignedWebhook:rejected.status,manychatValidation:manychat.status,commentAgentEnabled:true,classifierCredentialConfigured:true,liveClassifierPassed:true,accounts:accounts.accounts.map(a=>({platform:a.platform,username:a.username,active:a.active})),commentHistory:ledger.getCommentAgentStats()}));
ledger.getCommentAgentDb().close();

