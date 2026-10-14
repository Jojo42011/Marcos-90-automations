import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=existsSync('dist/src/videoKnowledge')?'dist/src':'dist';
const load=name=>import(pathToFileURL(path.resolve(root,name+'.js')));
const {VideoStore}=await load('videoKnowledge/store');
const {videoReply}=await load('videoKnowledge/index');
const {reconcileEvidence}=await load('videoKnowledge/extraction');
const {messageWithVideoReference,expandVideoLinks,SHARED_VIDEO}=await load('videoKnowledge/references');
const {parseZernioInboundMessage}=await load('integrations/zernio/dm');
const {readConversationHistory}=await load('integrations/zernio/history');
process.env.VIDEO_KNOWLEDGE_ENABLED='true';process.env.VIDEO_KNOWLEDGE_REPLIES_ENABLED='true';
const s=new VideoStore(':memory:');let count=0;
const test=async(name,fn)=>{await fn();count++;console.log('ok '+name);};
const caption='San Antonio. 4 bedrooms. Comment OAK.';
const facts=source=>[{field:'city',value:'San Antonio',quote:'San Antonio',source},{field:'bedrooms',value:'4 bedrooms',quote:'4 bedrooms',source}];
s.ingest({account:'a',post:'123',url:'https://www.tiktok.com/@owner/video/123',caption,published:'2026-10-01T00:00:00Z'});
s.complete(s.claim('a'),caption,reconcileEvidence(facts('caption'),facts('transcript'),{caption,transcript:caption}));
const reply=(person,text,account='a')=>videoReply(person,text,s,account,true);
try {
await test('description attempt progresses to URL, then answers the original question',()=>{
 assert.match(reply('p','How many bedrooms in the house with the red kitchen?'),/quick description/);
 assert.match(reply('p','JOHNSON'),/TikTok video URL/);
 assert.match(reply('p','https://www.tiktok.com/@owner/video/123'),/4 bedrooms/);
 assert.equal(s.lookup('a','p'),undefined);
});
await test('unknown keyword starts clarification; follow-up does not repeat the same question',()=>{
 assert.match(reply('keyword','JOHNSON'),/quick description/);
 assert.match(reply('keyword','the one with the red kitchen'),/Copy link/);
});
await test('native shared post preserves the provider video identifier for lookup',()=>{
 const text=messageWithVideoReference({text:'You see it?',attachments:[{type:'share',payload:{videoId:'123'},url:'https://www.tiktok.com/embed/v2/123'}]});
 assert.match(reply('share',text),/San Antonio/);
 assert.match(reply('share','You see it?'),/San Antonio/);
});
await test('both webhook shapes retain the shared video instead of empty text',()=>{
 const parsed=parseZernioInboundMessage({event:'message.received',account:{id:'a',platform:'tiktok'},conversation:{id:'c',participantId:'p'},message:{id:'m',platform:'tiktok',direction:'incoming',attachments:[{type:'share',payload:{videoId:'123'}}]}});
 const event=parsed?.event||parsed;assert.match(event.text,/embed\/v2\/123/);
});
await test('history recovers shared video references in incoming turns',async()=>{
 const result=await readConversationHistory({accountId:'a',conversationId:'c',beforeAt:'2026-10-13T10:00:00Z'},async()=>({ok:true,json:{messages:[{id:'m',direction:'incoming',createdAt:'2026-10-12T10:00:00Z',attachments:[{type:'share',payload:{videoId:'123'}}]}]}}));
 assert.match(result.messages[0].text,/embed\/v2\/123/);
});
await test('a preview with no reference clears the prior property and asks for a usable link',()=>{
 reply('preview','https://www.tiktok.com/@owner/video/123');const text=messageWithVideoReference({attachments:[{type:'video',url:'https://cdn.example/thumbnail.mp4'}]});assert.equal(text,SHARED_VIDEO);
 const result=reply('preview',text);assert.match(result,/Copy link/);assert.doesNotMatch(result,/San Antonio|address|neighborhood|look it up another/);
 assert.match(reply('preview','You see it?'),/Copy link/);
});
await test('unknown and other-account links do not reuse a previous home or invent processing',()=>{
 reply('other','OAK');assert.match(reply('other','https://www.tiktok.com/@owner/video/999'),/couldn.t match/);
 assert.match(reply('other','https://www.tiktok.com/@owner/video/123','other'),/couldn.t match/);
});
await test('short links resolve to stored knowledge with no credentials',async()=>{
 const text=await expandVideoLinks('https://vm.tiktok.com/abc/',async(url,options)=>{assert.equal(options.redirect,'manual');assert.equal(options.headers,undefined);return new Response(null,{status:302,headers:{location:'https://www.tiktok.com/@owner/video/123'}});});
 assert.match(reply('short',text),/San Antonio/);
});
await test('short-link resolver never follows arbitrary hosts and handles failure',async()=>{
 let calls=0;await expandVideoLinks('https://vm.tiktok.com/abc/',async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});});assert.equal(calls,1);
 await expandVideoLinks('https://evil.example/a',async()=>{throw Error('Should not fetch');});
 assert.equal(await expandVideoLinks('https://vm.tiktok.com/abc/',async()=>{throw Error('timeout');}),'https://vm.tiktok.com/abc/');
});
await test('ending the conversation clears pending clarification',()=>{
 reply('closed','JOHNSON');assert.equal(reply('closed','no thanks'),null);assert.equal(s.lookup('a','closed'),undefined);
});
await test('feature disabled preserves existing attachment behavior',()=>{
 process.env.VIDEO_KNOWLEDGE_REPLIES_ENABLED='false';assert.equal(messageWithVideoReference({text:null,attachments:[{type:'share',payload:{videoId:'123'}}]}),'');
});
console.log(`Video URL fallback: ${count} checks passed. No live services or DMs.`);
}finally{s.close();}
