/** Offline regression checks against compiled production modules. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const require=createRequire(import.meta.url);
const dir=mkdtempSync(path.join(tmpdir(),"marco-dm-reliability-"));
process.env.DB_JSON_PATH=path.join(dir,"leads.json");
process.env.LISTINGS_DB_PATH=path.join(dir,"listings.db");
process.env.COMMENT_AGENT_DB_PATH=path.join(dir,"comments.db");
process.env.COMMENT_AGENT_ENABLED="true";
process.env.COMMENT_AGENT_MIN_SPACING_SEC="0";
process.env.COMMENT_AGENT_MAX_PER_HOUR="100";
process.env.COMMENT_AGENT_MAX_PER_DAY="100";
delete process.env.ANTHROPIC_API_KEY;
globalThis.fetch=async()=>{throw Error("Network is forbidden in this test");};
let checks=0;
const check=(name,fn)=>{fn();checks++;console.log(`ok ${name}`);};
const historyModule=require("../dist/src/integrations/zernio/history.js");
const before="2026-10-01T12:00:00Z",old="2026-09-01T12:00:00Z";
let calls=0;
const history=await historyModule.readConversationHistory({conversationId:"c",accountId:"a",beforeMessageId:"live"},async url=>{
 calls++;
 if(calls===1)return {ok:true,json:{messages:[{id:"live",direction:"incoming",message:"Price?",createdAt:before}],pagination:{hasMore:true,nextCursor:"older"}}};
 assert.match(url,/cursor=older/);
 return {ok:true,json:{messages:[{id:"phone",direction:"incoming",message:"210 555 0198",createdAt:old},{id:"out",direction:"outgoing",text:"What number?",createdAt:"2026-08-30T12:00:00Z"}],pagination:{hasMore:false}}};
});
check("REST pagination and both body fields",()=>assert.deepEqual(history.messages.map(m=>[m.id,m.role]),[["out","assistant"],["phone","user"]]));
check("history completeness",()=>assert.equal(history.complete,true));
check("explicit invitation",()=>assert.equal(historyModule.respondsToDmInvitation("heyyy u said to DM"),true));
const noBoundary=await historyModule.readConversationHistory({conversationId:"c",accountId:"a"},async()=>({ok:true,json:{messages:[{id:"old",direction:"incoming",message:"hey",createdAt:old}]}}));
check("no future-turn import without boundary",()=>assert.deepEqual(noBoundary,{messages:[],complete:false}));

const db=require("../dist/src/core/db.js");
const pipeline=require("../dist/src/app/pipeline.js");
const payload={platform:"tiktok",userId:"reliability-person",username:"tester",commentOrDm:"dm",message:"heyyy u said to DM",conversationHistory:[...history.messages,...Array.from({length:10},(_,i)=>({id:`more${i}`,role:"user",text:`old message ${i}`,at:new Date(Date.parse(old)+(i+1)*1000).toISOString()}))]};
const first=await pipeline.run(payload);
check("phone older than six messages recovered",()=>assert.match(first.lead.phone,/2105550198/));
check("invitation reply is acknowledged",()=>assert.match(first.reply,/thanks for messaging/i));
check("no repeat phone request",()=>assert.doesNotMatch(first.reply??"",/what.*number|send.*number|share.*phone/i));
const second=await pipeline.run({...payload,message:"Price location?"});
check("unverified property facts are withheld",()=>{assert.match(second.reply,/have someone reach out/);assert.doesNotMatch(second.reply,/Austin|San Antonio|\$[0-9]/);});
check("known phone is not requested again",()=>assert.doesNotMatch(second.reply,/number|phone|screenshot|video|listing|verified/i));
const conversation=await db.getConversation(first.lead.id);
check("history dedupes across turns",()=>assert.equal(conversation.messages.filter(m=>m.providerMessageId).length,12));
check("history recovery preserves existing phone",()=>assert.equal(db.recoverHistoricalPhone(first.lead,"+15125550127").phone,first.lead.phone));

const knowledge=require("../dist/src/app/propertyKnowledge.js");
const llm=require("../dist/src/integrations/llm/index.js");
for(const platform of ["instagram","tiktok"]){
 const unknown=await pipeline.run({platform,userId:`unknown-${platform}`,commentOrDm:"dm",message:"How much is that house?"});
 check(`${platform} missing details offers natural follow-up and captures phone`,()=>{assert.match(unknown.reply,/have someone reach out/);assert.match(unknown.reply,/best number/);assert.equal(unknown.lead.state,"phone_requested");assert.doesNotMatch(unknown.reply,/verified|screenshot|send.*video/i);});
 const captured=await pipeline.run({platform,userId:`unknown-${platform}`,commentOrDm:"dm",message:"210 555 0187"});
 check(`${platform} handoff still accepts the supplied phone`,()=>{assert.match(captured.lead.phone,/2105550187/);assert(!knowledge.requestsPhoneNumber(captured.reply||""));});
}
const realOpening=llm.generateMarcoOpeningReply;
llm.generateMarcoOpeningReply=async()=>"Could you send me a picture of the house so I can take a look?";
const guarded=await pipeline.run({platform:"tiktok",userId:"stale-media-model",commentOrDm:"dm",message:"I'm interested in the home from your post"});
llm.generateMarcoOpeningReply=realOpening;
check("model media request replaced before persistence",()=>{assert.match(guarded.reply,/have someone reach out/);assert.doesNotMatch(guarded.reply,/picture|look/);});
const guardedHistory=await db.getConversation(guarded.lead.id);
check("saved outbound matches safe response",()=>assert.equal(guardedHistory.messages.at(-1).text,guarded.reply));
for(const unsafe of ["Send me a screenshot", "Could you send photos?", "Send screenshots please", "Could you share the video?", "Please upload a photo", "I can see the image you sent", "I watched that video"]){
 check(`blocks unsupported media: ${unsafe}`,()=>assert(knowledge.requestsUnsupportedPropertyMedia(unsafe)));
}
check("ordinary Marco replies retain their wording",()=>{assert(!knowledge.requestsUnsupportedPropertyMedia("Yeah, of course, is there a good number I can get that over to?"));assert(!knowledge.requestsUnsupportedPropertyMedia("I can send you a quick intro video."));});
check("consecutive missing-details fallback varies naturally",()=>assert.notEqual(knowledge.unverifiedListingReply(true,knowledge.unverifiedListingReply(true)),knowledge.unverifiedListingReply(true)));

// Hold a direct pipeline turn open; a distinct second turn must queue, not disappear.
const realRun=pipeline.run;let release,entered=[];
pipeline.run=async p=>{entered.push(p.message);if(entered.length===1)await new Promise(r=>{release=r;});return {reply:p.message};};
const webhook=require("../dist/src/app/webhook.js");
const one=webhook.handleIncomingPayload({...payload,message:"one"});
await sleep(10);
const two=webhook.handleIncomingPayload({...payload,message:"two"});
await sleep(10);check("second direct turn waits",()=>assert.deepEqual(entered,["one"]));
release();await Promise.all([one,two]);check("both direct turns finish",()=>assert.deepEqual(entered,["one","two"]));
pipeline.run=realRun;

// Exercise the exact debounce race: second timer expires while first is running.
const {scheduleDebouncedInbound}=require("../dist/src/app/messageDebounce.js");
let releaseBatch;const batches=[];
const processBatch=async p=>{batches.push(p.message);if(batches.length===1)await new Promise(r=>{releaseBatch=r;});return {status:200,reply:p.message};};
const log={requestId:"test",correlationId:"test"};
const b1=scheduleDebouncedInbound({...payload,userId:"debounce",message:"first"},log,processBatch);
await sleep(4100);
const b2=scheduleDebouncedInbound({...payload,userId:"debounce",message:"second"},log,processBatch);
await sleep(4100);check("busy batch remains queued",()=>assert.deepEqual(batches,["first"]));
releaseBatch();await Promise.all([b1,b2]);check("second batch survives busy processing",()=>assert.deepEqual(batches,["first","second"]));

const comments=require("../dist/src/integrations/zernio/comments.js");
const agent=require("../dist/src/agents/commentAgent/index.js");
const store=require("../dist/src/core/commentAgentStore.js");
const posted=[];
comments.readBackComment=async()=>({found:true,isOwner:false,canReply:true,username:"buyer",text:"info",isHidden:false,replyCount:0});
comments.postCommentReply=async input=>{posted.push(input.message);return {success:true,status:200,postedCommentId:`sent${posted.length}`};};
const evt=id=>({eventId:id,commentId:id,platformPostId:"video",postId:null,platform:"tiktok",text:"info",authorId:id,authorUsername:id,createdAt:new Date().toISOString(),isReply:false,parentCommentId:null});
await agent.handleInboundComment(evt("fact"),"acct",{classify:async()=>({bucket:"high_intent",reply:"Austin, 4 beds, $450000",reason:"test"})});
check("unsafe model public copy never posted",()=>assert.doesNotMatch(posted[0],/Austin|beds|450/));
await agent.handleInboundComment(evt("known"),"acct",{knownContact:true});
check("known commenters continue existing conversation",()=>assert.match(posted[1],/continue in our messages/));
process.env.COMMENT_AGENT_MAX_PER_HOUR=String(posted.length+1);
agent.enqueueComment(evt("a"),"acct");agent.enqueueComment(evt("b"),"acct");await agent.drainCommentQueue();
check("rate-limited comment is deferred",()=>assert.equal(store.getRecentCommentActions().find(r=>r.commentId==="b").decision,"skipped_rate_limit"));
store.resetCommentAgentDbForTests();
store.getCommentAgentDb().prepare("UPDATE comment_actions SET acted_at=? WHERE decision='replied'").run(new Date(Date.now()-7200000).toISOString());
store.getCommentAgentDb().prepare("UPDATE comment_queue SET next_attempt=0 WHERE status='pending'").run();
await agent.drainCommentQueue();check("pending work survives reopening SQLite",()=>assert.equal(posted.length,4));
agent.enqueueComment(evt("b"),"acct");await agent.drainCommentQueue();check("queue does not duplicate a successful reply",()=>assert.equal(posted.length,4));
store.resetCommentAgentDbForTests();
console.log(`${checks} reliability checks passed`);
// SQLite modules may retain Windows file handles until exit; only remove files if unlocked.
try{rmSync(dir,{recursive:true,force:true});}catch{}
