// Offline regression: real runtime and provider serializers; fixture model/browser/store.
// No production credentials, model calls, database writes or browser sessions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

const root = resolve("dist/src");
const env = { OPENROUTER_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture" };
let requests = [], loopCalls = 0, browserCalls = [], failProvider = false, direct = false;
function load(file, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(resolve(root, file), "utf8"), {
    module, exports: module.exports, process: { env }, console,
    Buffer, URL, AbortController, TextDecoder, setTimeout, clearTimeout,
    require: name => {
      if (name in dependencies) return dependencies[name];
      throw new Error("Unexpected dependency: " + name);
    }, ...globals
  }, { filename: file });
  return module.exports;
}
const translate = load("hull/providers/translate.js");
const cache = load("hull/providers/promptCache.js");
class ModelLayerError extends Error { constructor(_code, message) { super(message); } }
const catalog = { getModelInfo: () => null, toAnthropicId: s => s.replace("anthropic/", "") };
const action = { action: "call", tool: "browser_fill_form", arguments: { fields: [{name:"Password",type:"textbox",ref:"e2",value:"fixture-password"}] } };
const providerDeps = {"./catalog.js":catalog,"./internal.js":{ModelLayerError},"./promptCache.js":cache,"./translate.js":translate};
const router = load("hull/providers/openrouter.js", providerDeps, {
  fetch: async (_url, init) => {
    if (failProvider) throw new Error("fixture provider unavailable");
    const body = JSON.parse(init.body); requests.push(body);
    return {ok:true,json:async()=>({model:body.model,choices:[{message:{content:"",tool_calls:[{id:"login",type:"function",function:{name:"computer",arguments:JSON.stringify(action)}}]}}],usage:{cost:0}})};
  }
});
class Anthropic {
  messages = { create: async params => {
    requests.push(params);
    return {content:[{type:"tool_use",id:"login",name:"computer",input:action}],usage:{}};
  }};
}
const anthropic = load("hull/providers/anthropicDirect.js", {...providerDeps,"@anthropic-ai/sdk":Anthropic});
const chats = new Map(), history = new Map(), locks = new Set();
function newChat(owner, mode="chat") {
  const chat={id:randomUUID(),sessionId:randomUUID(),projectId:null,mode};
  chats.set(owner+":"+chat.id,chat); return {...chat};
}
const store = {
  get: (_kind,owner,id) => {const c=chats.get(owner+":"+id);if(!c)throw new Error("Not found");return {...c};},
  put: (_kind,owner,c) => {chats.set(owner+":"+c.id,{...c});return {...c};},
  messages: (owner,id) => [...(history.get(owner+":"+id)||[])],
  append: (owner,id,m) => {const k=owner+":"+id;history.set(k,[...(history.get(k)||[]),m]);},
  lockChat: (owner,id) => {const k=owner+":"+id;if(locks.has(k))throw new Error("locked");locks.add(k);return k;},
  unlockChat: (_owner,_id,k) => locks.delete(k)
};
const runtime = load("harvey/work/runtime.js", {
  "./composio.js":{managedConnections:async()=>[],managedTools:async()=>[],composioReady:()=>false},
  "./files.js":{}, crypto:{randomUUID}, "./store.js":store,
  "./browser.js":{browserEnabled:()=>true,browserCall:async(...args)=>{browserCalls.push(args);return {filled:true};}},
  "./connectors.js":{connections:()=>[],publicConnection:c=>c},
  "../tools.js":{HARVEY_TOOL_DEFINITIONS:[]}, "../../hull/approval.js":{},
  "../../hull/agentLoop.js":{runAgentLoop:async opts=>{
    loopCalls++;
    const req={model:opts.modelOverride||"openai/fixture",system:opts.workRuntime.context,messages:[{role:"user",content:opts.message}],tools:opts.workRuntime.tools,maxTokens:100};
    const out=await (direct?anthropic.callAnthropic(req):router.callOpenRouter(req));
    if (opts.workRuntime.context.includes("credential mode is ENABLED"))
      for(const call of out.toolUses) await opts.workRuntime.execute(call.name,call.input);
    return {speech:"Fixture completed",model:out.modelUsed,toolRounds:out.toolUses.length};
  }}
});
let passed=0;
function ok(name,fn){fn();passed++;console.log("ok",name);}
const chat = newChat("alice"), fresh = newChat("alice"), work = newChat("alice","work");
failProvider=true;
let streamed="";
const enabled=await runtime.runChat("alice",chat,"Monte Carlo",{modelOverride:"openai/fixture",onToken:t=>streamed+=t});
ok("consent succeeds without a provider and streams its acknowledgement",()=>{
  assert.equal(loopCalls,0);assert.equal(enabled.model,"harvey-settings");assert.equal(streamed,enabled.speech);
  assert.equal(store.get("chat","alice",chat.id).allowChatCredentials,true);
});
failProvider=false;
for (const model of ["openai/fixture","anthropic/fixture","google/fixture","inception/fixture"]) {
  requests=[];browserCalls=[];
  await runtime.runChat("alice",chat,"Sign in to my requested site",{modelOverride:model});
  ok("OpenRouter consent and browser tool survive switch to "+model,()=>{
    assert.equal(requests[0].model,model);
    assert(JSON.stringify(requests[0].messages[0]).includes("credential mode is ENABLED"));
    assert(requests[0].tools.find(t=>t.function.name==="computer").function.description.includes("credential mode is ENABLED"));
    assert.equal(browserCalls.length,1);assert.equal(browserCalls[0][2],"browser_fill_form");
  });
}
direct=true;requests=[];browserCalls=[];
await runtime.runChat("alice",chat,"Continue login",{modelOverride:"anthropic/fixture"});
ok("direct Anthropic receives the same consent and executes the browser fixture",()=>{
  assert(JSON.stringify(requests[0].system).includes("credential mode is ENABLED"));
  assert(requests[0].tools.find(t=>t.name==="computer").description.includes("credential mode is ENABLED"));
  assert.equal(browserCalls.length,1);
});
direct=false;
await runtime.runChat("alice",work,"Monte Carlo on.");
ok("Work mode supports the same consent command",()=>assert(store.get("chat","alice",work.id).allowChatCredentials));
requests=[];await runtime.runChat("alice",fresh,"Monte Carlo simulation");
ok("ordinary discussion cannot enable consent",()=>assert(!store.get("chat","alice",fresh.id).allowChatCredentials));
const before=loopCalls;
await runtime.runChat("alice",chat,"Monte Carlo off",{modelOverride:"google/fixture"});
ok("off is deterministic on every model",()=>{
  assert.equal(loopCalls,before);assert.equal(store.get("chat","alice",chat.id).allowChatCredentials,false);
});
requests=[];await runtime.runChat("alice",chat,"Continue login",{modelOverride:"openai/fixture"});
ok("new model receives OFF despite prior enabled history",()=>assert(JSON.stringify(requests[0].messages[0]).includes("credential mode is OFF")));
await runtime.runChat("alice",chat,"Monte Carlo",{},"scheduled-fixture");
ok("scheduled prompts cannot change consent",()=>assert.equal(store.get("chat","alice",chat.id).allowChatCredentials,false));
await assert.rejects(()=>runtime.runChat("bob",chat,"Monte Carlo"),/Not found/);
ok("owner isolation and lock cleanup",()=>{assert.equal(locks.size,0);assert(!store.get("chat","alice",fresh.id).allowChatCredentials);});
const stopped=new AbortController();stopped.abort();
await assert.rejects(()=>runtime.runChat("alice",chat,"Monte Carlo",{signal:stopped.signal}));
ok("cancelled commands do not alter consent",()=>assert.equal(store.get("chat","alice",chat.id).allowChatCredentials,false));
console.log(passed+" offline credential-consent checks passed; live model behavior is not asserted.");
