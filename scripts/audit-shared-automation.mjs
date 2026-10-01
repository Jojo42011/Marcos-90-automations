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
const marco=accounts.accounts.find(a=>a.platform==='tiktok'&&a.username==='puga.realtor');
assert(marco?.active,'Marco TikTok account needs reconnection');
assert.equal(dm.zernioTikTokAccountId(),marco.id,'Configured TikTok account must be Marco');
const provider=async(path,init={})=>fetch('https://zernio.com/api/v1'+path,{...init,headers:{authorization:'Bearer '+process.env.ZERNIO_DM_API_KEY.trim(),'content-type':'application/json'},signal:AbortSignal.timeout(20000)});
const subscriptions=await provider('/webhooks/settings');assert(subscriptions.ok,'Webhook subscription lookup failed: '+subscriptions.status);
const hooks=(await subscriptions.json()).webhooks.filter(h=>{try{return new URL(h.url).pathname==='/api/zernio/webhook';}catch{return false;}});
console.log(JSON.stringify({webhookSubscriptions:hooks.map(h=>({active:h.isActive,events:h.events,failureCount:h.failureCount,lastFiredAt:h.lastFiredAt}))}));
assert(hooks.some(h=>h.isActive&&h.events.includes('comment.received')),'No active comment webhook subscription');
assert(hooks.some(h=>h.isActive&&h.events.includes('message.received')),'No active DM webhook subscription');
for(const hook of hooks.filter(h=>h.isActive)){
  const tested=await provider('/webhooks/test',{method:'POST',body:JSON.stringify({webhookId:hook._id})});
  assert(tested.ok,'Provider-to-app test delivery failed: '+tested.status);
}
const draft=await agent.classifyAndDraft({commentText:'Please send me the price and location',authorUsername:'audit_fixture'});
assert(draft,'Live comment classification failed');
const llm=require('../dist/src/integrations/llm/index.js');
const modelCheck=await llm.anthropicLiveCheck();assert(modelCheck.ok,'DM model unavailable: '+modelCheck.kind);
const deliveries=await provider('/webhooks/logs?event=message.received&limit=20');
assert(deliveries.ok,'DM delivery log lookup failed: '+deliveries.status);
const rows=(await deliveries.json()).logs.filter(r=>hooks.some(h=>h._id===r.webhookId));
const db=require('../dist/src/core/db.js'), leads=await db.listAllLeads(), inspected=new Set(), threads=[];
for(const row of rows){
  const evt=dm.parseZernioInboundMessage(row.requestPayload);
  if(!evt||evt.accountId!==marco.id||inspected.has(evt.conversationId)||inspected.size>=5)continue;
  inspected.add(evt.conversationId);
  const response=await provider('/inbox/conversations/'+encodeURIComponent(evt.conversationId)+'/messages?'+new URLSearchParams({accountId:marco.id,sortOrder:'desc',limit:'20'}));
  assert(response.ok,'Marco inbox read failed: '+response.status);
  const data=await response.json(), messages=data.messages||data.data||[];
  const lead=leads.find(l=>l.platform===evt.platform&&l.userId===evt.senderId);
  const stored=lead?(await db.getConversation(lead.id)).messages:[];
  const confirmed=messages.filter(m=>m.direction==='outgoing'&&stored.some(s=>s.role==='assistant'&&s.text===(m.text||m.message)));
  const interested=evt.text.trim()?await llm.classifyNewLeadBuyingIntent(evt.text,{platform:evt.platform,channel:'dm'}):false;
  threads.push({inboundAt:row.createdAt,messageKeys:Object.keys(row.requestPayload?.message||{}),parsedTextChars:evt.text.length,alternateTextChars:typeof row.requestPayload?.message?.message==='string'?row.requestPayload.message.message.length:0,buyingIntent:interested,providerMessages:messages.length,storedMessages:stored.length,confirmedAgentReplies:confirmed.length,latestConfirmedReplyAt:confirmed[0]?.sentAt||confirmed[0]?.createdAt||null});
}
console.log(JSON.stringify({marcoDmAudit:'passed',account:'puga.realtor',model:modelCheck.model,modelAvailable:true,recentInboundDeliveries:rows.map(r=>({at:r.createdAt,status:r.status,httpStatus:r.statusCode})),threads,note:'Read-only delivery inspection; no customer messages sent'}));
console.log(JSON.stringify({sharedAutomationAudit:'passed',signedWebhook:accepted.status,unsignedWebhook:rejected.status,manychatValidation:manychat.status,commentAgentEnabled:true,classifierCredentialConfigured:true,liveClassifierPassed:true,accounts:accounts.accounts.map(a=>({platform:a.platform,username:a.username,active:a.active})),commentHistory:ledger.getCommentAgentStats()}));
ledger.getCommentAgentDb().close();


