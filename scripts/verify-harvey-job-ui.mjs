import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
const source=readFileSync('public/harvey-chat.js','utf8');
const watch=source.slice(source.indexOf('  async function watchJob('),source.indexOf('  function handleSseBlock('));
const context={state:{},encodeURIComponent,Math,JSON,Error,Promise,setTimeout:fn=>setImmediate(fn),current:()=>true,handleSseBlock:()=>{},applyNonStream:(data,ui)=>ui.setText(data.text),api:async()=>({ok:false,status:503})};
vm.createContext(context);vm.runInContext(watch,context);const ui={text:'',notes:[],setText(t){this.text=t},note(t){this.notes.push(t)}};const run={abort:new AbortController()};
let calls=0;context.api=async()=>++calls<=3?{ok:false,status:503}:{ok:true,data:{id:'saved',status:'completed',result:{text:'Verified saved result'}}};
await context.watchJob({id:'saved',status:'running'},ui,run);assert.equal(calls,4);assert.equal(ui.text,'Verified saved result');assert(ui.notes.length===3);assert.equal(context.state.activeJobId,null);
context.api=async()=>({ok:false,status:401});await assert.rejects(context.watchJob({id:'saved',status:'running'},ui,run),/do not resubmit/);
context.api=async()=>({ok:false,status:503});await assert.rejects(context.watchJob({id:'saved',status:'running'},ui,run),/task is saved/);
console.log('ok transient job polling recovers the same job; authorization/permanent errors preserve explicit reconnect instructions without resubmission');
// Exercise the real assistant message renderer: finish must preserve its specific error.
const renderer=source.slice(source.indexOf('  function addAssistantMessage('),source.indexOf('  /* ── approvals'));
const body={innerHTML:""};const elements={".body":body,".tools":{},".approvals":{},".msg-meta":{},".copy-msg":{addEventListener(){}}};
context.document={createElement:()=>({querySelector:key=>elements[key]})};context.thread={appendChild(){}};context.scrollToBottom=()=>{};context.esc=t=>t;context.renderMarkdown=t=>t;context.requestAnimationFrame=()=>1;context.cancelAnimationFrame=()=>{};
vm.runInContext(renderer,context);const message=context.addAssistantMessage();message.error('Encoder failed: actual diagnostic');message.finish();assert(body.innerHTML.includes('actual diagnostic'));assert(!body.innerHTML.includes('usable reply'));
console.log('ok finish preserves the actual error instead of replacing it with an empty-response message');

const chat=source.slice(source.indexOf('  async function harveyChat('),source.indexOf('  async function watchJob('));
Object.assign(context,{ensureWorkChat:async()=>{},apiUrl:p=>p,authHeaders:h=>h,Date,TextDecoder,crypto:{randomUUID:()=>"same-request"},fetch:async()=>({ok:true,status:200,headers:{get:()=>"text/event-stream"},body:{getReader:()=>({read:async()=>({done:true})})}})});
vm.runInContext(chat,context);context.api=async p=>({ok:true,data:p.endsWith('/job')?{job:null}:{messages:[{role:'assistant',at:'2099-01-01T00:00:00Z',content:'Recovered saved final reply'}]}});
await context.harveyChat('Fixture',ui,{chatId:'saved',abort:new AbortController()});assert.equal(ui.text,'Recovered saved final reply');
console.log('ok ended response stream retrieves the saved final answer without resubmitting the task');

const inline=source.slice(source.indexOf('  function mdInline('),source.indexOf('  function isTableSep('));vm.runInContext(inline,context);
assert(context.mdInline('[clip](/api/harvey/work/files/chat/edited.mp4)').includes('href="/api/harvey/work/files/chat/edited.mp4"'));
assert(!context.mdInline('[bad](javascript:alert(1))').includes('<a '));assert(!context.mdInline('[bad](//evil.example/file)').includes('<a '));
const linkSource=readFileSync('dist/src/harvey/work/files.js','utf8');const linkContext={Map,files:()=>[{path:'/data/harvey-work/browsers/own/files/clip.mp4',download:'/api/harvey/work/files/chat/clip.mp4'}]};vm.createContext(linkContext);vm.runInContext(linkSource.slice(linkSource.indexOf('function publicFileLinks(')),linkContext);
assert.equal(linkContext.publicFileLinks('owner','chat','[clip](/workspace/harvey-work/browsers/own/files/clip.mp4)'),'[clip](/api/harvey/work/files/chat/clip.mp4)');
assert.equal(linkContext.publicFileLinks('owner','chat','[clip](/workspace/harvey-work/browsers/other/files/clip.mp4)'),'[clip](/workspace/harvey-work/browsers/other/files/clip.mp4)');
console.log('ok existing-file download links are normalized and rendered, while foreign paths and unsafe schemes are not promoted');
