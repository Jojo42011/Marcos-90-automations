import {mergeMissingValue} from './valueFormats.js';
import { scrollCode } from "./scroll.js";
import { tableCode, formCode, copyFieldInPage } from "./tables.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash, randomUUID } from "crypto";
import { mkdirSync, chownSync, existsSync, renameSync, chmodSync, writeFileSync, readFileSync, realpathSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { get, list, put, seal, unseal, workDir, text } from "./store.js";
import {navigationProblem, browserRead, parseTabs, readTabs, recoveryFor, restorableUrl, resultText, TabState, writeTabs} from "./browserState.js";

import { browserArguments } from "./browserArguments.js";
import { uploadArguments } from "./uploadFiles.js";
import { inspectCode, parseBrowserJson, dragCode, CanvasTarget } from "./canvas.js";

const canvasObservations = new Map<string,{id:string;at:number;targets:CanvasTarget[]}>();

const ALLOWED = new Set(["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type", "browser_fill_form", "browser_press_key", "browser_select_option", "browser_hover", "browser_drag", "browser_tabs", "browser_wait_for", "browser_handle_dialog", "browser_file_upload", "browser_take_screenshot", "browser_close", "browser_mouse_click_xy", "browser_mouse_drag_xy", "browser_mouse_wheel"]);
const TARGETED = new Set(["browser_click","browser_type","browser_fill_form","browser_select_option","browser_hover","browser_drag"]);
const EXTRA_TOOLS = [
  {name:"browser_inspect_scroll_regions",description:"Find rendered page/pane scroll containers and their selectors and positions. Use when rows are missing, virtualized or lazy-loaded; no screenshot or vision model needed.",inputSchema:{type:"object",properties:{}}},
  {name:"browser_scroll",description:"Scroll an observed container or the document using DOM scrolling, without screenshot coordinates. Supports text-only models. Use a selector from browser_inspect_scroll_regions or the observed table. Then read fresh rows/snapshot; do not ask the user to scroll for you.",inputSchema:{type:"object",properties:{target:{type:"string"},deltaY:{type:"number",minimum:-2000,maximum:2000},deltaX:{type:"number",minimum:-2000,maximum:2000}}}},
  {name:"browser_read_form",description:"Read visible form values, identity emails and full-value hashes. Password/hidden fields are excluded. expected:[source text] checks literal history on the visible page without returning long text. computer sourceValues can bind /expected/0 directly from a source cell. Save and reopen before verifying persistence.",inputSchema:{type:"object",properties:{target:{type:"string"},expected:{type:"array",maxItems:30,items:{type:"string",maxLength:262144}}}}},
  {name:"browser_read_table",description:"Read compact structured rendered table/grid rows or article/list cards, including stable links and full link titles/alt text. Use this for catalog cards as well as tables before relying on screenshots. Optional target is an observed table/container selector or repeating article/list-card selector; multiple matching cards are allowed. Prefer row.title/full link titles over shortened display text. offset/nextOffset page DOM rows only: use actual UI pagination or scrolling for unseen/virtualized records. Verify filters and total separately; save sourced rows with work_records before continuing.",inputSchema:{type:"object",properties:{target:{type:"string"},offset:{type:"integer",minimum:0}}}},
  {name:"browser_inspect_targets",description:"Inspect visible canvas nodes, ports, controls and exposed graph edges with precise viewport rectangles and a screenshot. Optionally focus on observed nodeIds when the graph is large. Use before connecting overlapping nodes; missing DOM edges require destination read-back, not guesswork.",inputSchema:{type:"object",properties:{nodeIds:{type:"array",items:{type:"string"},maxItems:4}}}},
  {name:"browser_drag_targets",description:"Connect two freshly observed port targets with a controlled mouse gesture. Requires observationId and target IDs from browser_inspect_targets. Rejects moved/obscured targets before pressing. Returns fresh graph and pixels; verify the intended input, not just gesture completion.",inputSchema:{type:"object",properties:{observationId:{type:"string"},start:{type:"string"},end:{type:"string"}},required:["observationId","start","end"]}},
  {name:"browser_read_snapshot",description:"Read another bounded page of the most recent full snapshot without recapturing it. Use snapshotId and nextOffset returned by the previous result. For a new state or a specific region use browser_snapshot with target/depth instead.",inputSchema:{type:"object",properties:{snapshotId:{type:"string"},offset:{type:"integer",minimum:0}},required:["snapshotId","offset"]}},
  {name:"browser_recover",description:"Restart this chat's unresponsive hosted browser and restore saved tabs/cookies. Only after observing a connection or browser crash. Never replays a click, form submission or other action; unsaved page state can be lost. Inspect the restored page before continuing.",inputSchema:{type:"object",properties:{}}}
];
type Frame = { image: string; capturedAt: string; url: string; title: string };
type Session = {owner:string;chat:string;client:Client;tools:any[];lastUsed:number;statePath:string;tabsPath:string;tabs?:TabState;busy:number;chain:Promise<any>;action?:string;failed?:boolean;frame?:Frame;preview?:Promise<void>;previewAbort?:AbortController;closing?:boolean;snapshot?:{id:string;raw:string;at:number};visionAt?:number;preservedFormChanged?:boolean;unchangedPreservedForm?:boolean;dirty:boolean;savedAt:number;saveTimer?:NodeJS.Timeout;saveWarning?:string;restoreWarning?:string;metrics:{calls:number;preflights:number;checkpoints:number;previewCalls:number}};
const sessions = new Map<string, Promise<Session>>();
let shuttingDown=false;
let shutdownRegistered=false;
let catalogPromise:Promise<any[]>|undefined;
// MCP listTools is schema discovery, not a browser session. Keep its catalog
// independent of owner profiles and the finite set of live Chromium workers.
async function installedBrowserTools():Promise<any[]> {
  if(!catalogPromise)catalogPromise=(async()=>{
    const client=new Client({name:'harvey-browser-catalog',version:'1.0.0'});
    const env:Record<string,string>={};for(const name of ['PATH','SystemRoot','TEMP','TMP','PLAYWRIGHT_BROWSERS_PATH'])if(process.env[name])env[name]=process.env[name]!;
    const transport=new StdioClientTransport({command:process.execPath,args:[join(__dirname,'browserWorker.js'),'--headless','--caps','storage,vision'],env,stderr:'pipe'});
    try{await client.connect(transport,{timeout:15000});return (await client.listTools({},{timeout:15000})).tools.filter(t=>ALLOWED.has(t.name));}
    finally{await client.close().catch(()=>{});}
  })().catch(e=>{catalogPromise=undefined;throw e;});
  return catalogPromise;
}
function registerShutdown(){
  if(shutdownRegistered)return;shutdownRegistered=true;
  for(const sig of ["SIGTERM","SIGINT"] as const)process.once(sig,()=>{
    shuttingDown=true;const end=setTimeout(()=>process.exit(0),8000);end.unref();
    void closeBrowsers().finally(()=>process.exit(0));
  });
}
export function browserEnabled() { return process.env.HARVEY_BROWSER_ENABLED === "true"; }
export function browserDirectory(owner: string, chat: string) { const key = createHash("sha256").update(owner + ":" + chat).digest("hex"); const dir = join(workDir(), "browsers", key); mkdirSync(dir, { recursive: true }); return dir; }
function tabsPath(owner:string,chat:string){return join(browserDirectory(owner,chat),"tabs.json");}
async function call(s:Session,name:string,args:any={},timeout=15000,signal?:AbortSignal):Promise<any>{
  s.metrics.calls++;
  // The SDK retains abort listeners on the supplied signal. Give each request
  // its own signal and detach it from the long-lived task when this call ends.
  signal?.throwIfAborted();
  const request=new AbortController(),abort=()=>request.abort(signal?.reason);
  signal?.addEventListener('abort',abort,{once:true});
  let result:any;
  try{result=await s.client.callTool({name,arguments:args},undefined,{timeout,signal:request.signal});}
  finally{signal?.removeEventListener('abort',abort);}
  // This MCP version puts implicit action snapshots in local files. Return their
  // actual observations to the model without paying for another browser call.
  const dir=browserDirectory(s.owner,s.chat),files=realpathSync(join(dir,"files"));
  for(const content of result.content||[])if(content.type==="text")content.text=content.text.replace(/(### Snapshot\r?\n)- \[Snapshot\]\((files[\\/]+page-[\w.-]+\.yml)\)/g,(_match:string,header:string,file:string)=>{
    try{const path=realpathSync(resolve(dir,file.replace(/[\\/]+/g,sep)));if(!path.startsWith(files+sep)||statSync(path).size>2*1024*1024)throw new Error("Snapshot outside bounded workspace");return header+"```yaml\n"+readFileSync(path,"utf8")+"\n```";}
    catch{return header+"Snapshot content unavailable. Request a focused browser_snapshot before acting or claiming page contents.";}
  });
  return result;
}
function checked(r:any){if(r.isError)throw new Error(resultText(r).slice(0,2000));return r;}
function remember(s:Session,r:any,full=false,persistTabs=true){
  const raw=resultText(r);
  if(full || /### Snapshot/.test(raw))s.snapshot={id:randomUUID(),raw,at:Date.now()};
  if(!persistTabs)return;
  const tabs=parseTabs(raw);
  if(tabs)s.tabs=tabs;
  else {const url=raw.match(/^- Page URL: (.+)$/m)?.[1];if(url && restorableUrl(url)){s.tabs ||= {urls:[],active:0,open:true,updatedAt:""};s.tabs.urls[s.tabs.active]=url;}}
  if(s.tabs){s.tabs.open=true;s.tabs.updatedAt=new Date().toISOString();writeTabs(s.tabsPath,s.tabs);}
}
function pageSlice(s:Session,offset=0){
  const snap=s.snapshot;if(!snap)throw new Error("Inspect browser_snapshot first");
  if(!Number.isInteger(offset)||offset<0||offset>snap.raw.length)throw new Error("Invalid snapshot offset");
  const end=Math.min(snap.raw.length,offset+6500);
  return {content:[{type:"text",text:snap.raw.slice(offset,end)}],snapshotId:snap.id,offset,nextOffset:end<snap.raw.length?end:null,totalCharacters:snap.raw.length,truncated:end<snap.raw.length||offset>0,note:end<snap.raw.length?"Partial page. Use browser_read_snapshot for remaining text, or browser_snapshot target/depth for a complete focused region.":undefined};
}
function normalized(s:Session,result:any){
  const image=(result.content||[]).find((c:any)=>c.type==="image");
  const raw=resultText(result);
  const output:any = raw.length>7000 && s.snapshot?.raw===raw ? pageSlice(s) : {content:(result.content||[]).filter((c:any)=>c.type==="text")};
  if(image){if(image.data.length>8*1024*1024)throw new Error("Screenshot too large; request a viewport or focused screenshot");output._image={media_type:image.mimeType,data:image.data};}
  if(s.saveWarning)output.persistenceWarning=s.saveWarning;
  if(s.restoreWarning)output.restoreWarning=s.restoreWarning;
  return output;
}
async function session(owner:string,chat:string):Promise<Session>{
  if(!browserEnabled())throw new Error("Harvey's hosted browser is not enabled");
  if(shuttingDown)throw new Error("Browser worker is shutting down; retry after restart");
  registerShutdown();
  const key=owner+":"+chat;
  if(!sessions.has(key)){
    if(sessions.size>=Number(process.env.HARVEY_BROWSER_MAX_SESSIONS||3))throw new Error("All browser slots are occupied. Existing tabs have been preserved. Close an unused chat browser explicitly before opening another.");
    const promise=(async()=>{
      const dir=browserDirectory(owner,chat),files=join(dir,"files");mkdirSync(files,{recursive:true});
      const unprivileged=process.platform!=="win32" && process.getuid?.()===0;
      if(unprivileged){chownSync(dir,1001,1001);chownSync(files,1001,1001);}
      const config={capabilities:["storage","vision"],browser:{browserName:"chromium",userDataDir:join(dir,"profile"),launchOptions:{headless:true,...(process.env.HARVEY_BROWSER_EXECUTABLE?{executablePath:process.env.HARVEY_BROWSER_EXECUTABLE}:{})}},timeouts:{action:5000,navigation:30000,idle:0},outputDir:files,saveSession:false,imageResponses:"allow"};
      const configPath=join(dir,"config.json");writeFileSync(configPath,JSON.stringify(config));
      const client=new Client({name:"harvey-browser",version:"1.1.0"});
      const env:Record<string,string>={};for(const name of ["PATH","HOME","USERPROFILE","LOCALAPPDATA","SystemRoot","TEMP","TMP","PLAYWRIGHT_BROWSERS_PATH"])if(process.env[name])env[name]=process.env[name]!;env.HOME=dir;
      const transport=new StdioClientTransport({command:process.execPath,args:[join(__dirname,"browserWorker.js"),"--config",configPath],cwd:dir,env,stderr:"pipe"});
      let startupError="";transport.stderr?.on("data",b=>{startupError=(startupError+String(b)).slice(-2000);});
      try{
        await client.connect(transport,{timeout:15000});
        const tools=(await client.listTools({},{timeout:15000})).tools.filter(t=>ALLOWED.has(t.name));
        const s:Session={owner,chat,client,tools:[...tools,...EXTRA_TOOLS],statePath:join(dir,"auth-state.json"),tabsPath:join(dir,"tabs.json"),lastUsed:Date.now(),savedAt:0,busy:0,chain:Promise.resolve(),dirty:false,metrics:{calls:0,preflights:0,checkpoints:0,previewCalls:0}};
        if(existsSync(s.statePath)){
          // The unprivileged MCP process must be able to read the retained mode-0600 checkpoint.
          if(unprivileged)chownSync(s.statePath,1001,1001);
          checked(await call(s,"browser_set_storage_state",{filename:s.statePath},30000));
        }
        const retained=readTabs(s.tabsPath);
        if(retained?.open && retained.urls.length){
          s.tabs=retained;
          // Every restoration is a GET navigation, never a replay of form input or submissions.
          for(let i=0;i<retained.urls.length;i++){
            try{checked(await call(s,i?"browser_tabs":"browser_navigate",i?{action:"new",url:retained.urls[i]}:{url:retained.urls[i]},35000));}
            catch{ s.restoreWarning="One or more saved pages could not reload. Inspect tabs and current authentication; no previous action was replayed."; }
          }
          try{checked(await call(s,"browser_tabs",{action:"select",index:retained.active}));}catch{s.restoreWarning="Saved active tab unavailable; inspect the open tabs.";}
        }
        return s;
      }catch(e){await client.close().catch(()=>{});throw new Error(`Browser startup failed: ${(e as Error).message}${startupError?". "+startupError:""}`);}
    })().catch(e=>{sessions.delete(key);throw e;});
    sessions.set(key,promise);
  }
  const s=await sessions.get(key)!;s.lastUsed=Date.now();return s;
}
async function checkpoint(s:Session,force=false){
  if(!force&&!s.dirty)return;
  const pending=s.statePath+".pending";
  try{
    const tabResult=checked(await call(s,"browser_tabs",{action:"list"}));const tabs=parseTabs(resultText(tabResult));if(tabs){s.tabs=tabs;writeTabs(s.tabsPath,tabs);}
    checked(await call(s,"browser_storage_state",{filename:pending},15000));chmodSync(pending,0o600);renameSync(pending,s.statePath);
    s.savedAt=Date.now();s.dirty=false;s.saveWarning=undefined;s.metrics.checkpoints++;
  }catch{ s.saveWarning="Browser action may have succeeded, but its latest session state could not be saved. Previous saved state is intact. Verify the page; do not repeat the action because of this warning."; }
}
function deferCheckpoint(s:Session){
  if(s.saveTimer||s.closing)return;
  s.saveTimer=setTimeout(()=>{s.saveTimer=undefined;if(!s.failed&&!s.closing)void observedAction(s,"session checkpoint",()=>checkpoint(s)).catch(()=>{});},1500);s.saveTimer.unref();
}
async function observedAction<T>(s:Session,name:string,fn:()=>Promise<T>):Promise<T>{
  if(s.closing)throw new Error("Browser is closing");
  s.busy++;s.previewAbort?.abort();
  const next=s.chain.catch(()=>{}).then(async()=>{await s.preview?.catch(()=>{});s.action=name;s.failed=false;try{return await fn();}catch(e){s.failed=true;throw e;}});
  s.chain=next;try{return await next;}finally{s.busy--;}
}
async function closeSession(s:Session,explicit=false){
  s.closing=true;s.previewAbort?.abort();if(s.saveTimer)clearTimeout(s.saveTimer);
  await s.chain.catch(()=>{});await s.preview?.catch(()=>{});
  try{if(!s.failed)await checkpoint(s,true);if(explicit)writeTabs(s.tabsPath,{urls:s.tabs?.urls||[],active:s.tabs?.active||0,open:false,updatedAt:new Date().toISOString()});}finally{await s.client.close();}
}
export async function closeBrowser(owner:string,chat:string){const key=owner+":"+chat,pending=sessions.get(key);canvasObservations.delete(key);if(pending){const s=await pending.catch(()=>null);if(s)await closeSession(s,true);sessions.delete(key);}else{const path=tabsPath(owner,chat),saved=readTabs(path);if(saved)writeTabs(path,{...saved,open:false});}}
export async function closeBrowsers(){canvasObservations.clear();await Promise.all([...sessions].map(async([key,pending])=>{try{const s=await pending.catch(()=>null);if(s)await closeSession(s);}finally{sessions.delete(key);}}));}
// Closing a laptop only disconnects the UI. There is deliberately no idle tab eviction.
// Periodically capture cookie changes and client-side tab navigation while the model is idle.
const maintenance=setInterval(()=>{for(const pending of sessions.values())void pending.then(s=>{if(!s.busy&&!s.closing&&!s.failed){s.dirty=true;void observedAction(s,"session checkpoint",()=>checkpoint(s)).catch(()=>{});}}).catch(()=>{});},30000);maintenance.unref();
export async function browserTools(owner:string,chat:string,name?:string){if(!browserEnabled())throw Error("Harvey's hosted browser is not enabled");const tools=[...await installedBrowserTools(),...EXTRA_TOOLS].map(t=>t.name!=="browser_file_upload"?t:{...t,description:"Upload local workspace files into the currently opened file chooser. Click Choose files first, then use paths from workspace_files. Native OS interaction is unnecessary. Missing paths do not cancel; cancel:true explicitly cancels.",inputSchema:{type:"object",properties:{paths:{type:"array",items:{type:"string"},minItems:1,maxItems:20},cancel:{type:"boolean"}}}});if(name){const t=tools.find(t=>t.name===name);if(!t)throw new Error("Unsupported browser tool");return [t];}return tools.map(t=>({name:t.name,description:t.description?.slice(0,180),schema:"Request computer action=tools with this tool name for its complete input schema."}));}
export async function browserMetrics(owner:string,chat:string){const s=await sessions.get(owner+":"+chat);return s?{...s.metrics}:undefined;}
export async function browserPreview(owner:string,chat:string){
  if(!browserEnabled())return {state:"disabled"};
  let pending=sessions.get(owner+":"+chat);
  if(!pending){if(shuttingDown)return {state:"closed"};try{if(!readTabs(tabsPath(owner,chat))?.open)return {state:"closed"};pending=session(owner,chat);}catch{return {state:"unavailable"};}}
  let s:Session;try{s=await pending;}catch{return {state:"unavailable"};}if(s.closing)return {state:"closed"};
  if(!s.busy&&!s.preview&&(!s.frame||Date.now()-Date.parse(s.frame.capturedAt)>4000)){
    const abort=new AbortController();s.previewAbort=abort;
    s.preview=(async()=>{try{
      s.metrics.previewCalls++;
      const shot=checked(await call(s,"browser_take_screenshot",{type:"jpeg"},2500,abort.signal));
      const image=(shot.content||[]).find((c:any)=>c.type==="image");if(!image||image.data.length>6*1024*1024)return;
      let url=s.tabs?.urls[s.tabs.active]||"";try{const u=new URL(url);u.username="";u.password="";u.search="";u.hash="";url=u.toString();}catch{url="";}
      s.frame={image:"data:"+image.mimeType+";base64,"+image.data,capturedAt:new Date().toISOString(),url,title:"Browser"};
    }catch{/* Preview is disposable; never block or fail an action because of it. */}finally{s.preview=undefined;s.previewAbort=undefined;}})();
  }
  // Return immediately. A slow preview cannot hold the next action for a full screenshot timeout.
  return {state:s.busy?"working":s.failed?"needs_attention":"ready",action:s.action,frame:s.frame,persistenceWarning:s.saveWarning,restoreWarning:s.restoreWarning};
}
export function validateActionReferences(snapshot:string,args:any){
  const fields=Array.isArray(args?.fields)?args.fields:[];
  const refs=[args?.ref,args?.startRef,args?.endRef,...fields.map((f:any)=>f.ref)].filter(Boolean);
  const targets=[args?.target,args?.startTarget,args?.endTarget,...fields.map((f:any)=>f.target)].filter(Boolean);
  for(const ref of refs)if(typeof ref!=="string"||!snapshot.includes(`[ref=${ref}]`))throw new Error("Browser target changed. Inspect a fresh snapshot and use its current reference or a unique selector.");
  for(const target of targets){if(typeof target!=="string"||target.length>2000)throw new Error("Invalid browser target");if(snapshot.includes(`[ref=${target}]`))continue;if(/^[\w-]+$/.test(target)&&! /^(input|textarea|select|button)$/.test(target))throw new Error("Browser target changed or is no longer visible. Inspect a fresh snapshot before trying a different action.");}
}
export async function browserCall(owner:string,chat:string,name:string,args:any,signal?:AbortSignal):Promise<any>{
  signal?.throwIfAborted();args={...(args||{})};
  if(['browser_read_form','browser_read_table'].includes(name)&&args.url!==undefined)return {error:name+' reads the current selected page; url is not supported. Navigate to the intended URL using browser_navigate, inspect its identity, then read it. Nothing was read or navigated.',recovery:{actionOutcome:'not_executed',safeToRetry:false}};
  if(['browser_read_form','browser_read_table'].includes(name)){const allowed=name==='browser_read_form'?['target','expected']:['target','offset'];const unknown=Object.keys(args).filter(key=>!allowed.includes(key));if(unknown.length)return {error:'Unknown '+name+' argument '+JSON.stringify(unknown)+'. Supported arguments: '+allowed.join(', ')+'. Nothing was read.',recovery:{actionOutcome:'not_executed',safeToRetry:false}};}
  if(name==='browser_read_form'){
    if(args.target!==undefined&&(typeof args.target!=='string'||args.target.length>2000))return {error:'Use an observed form selector'};
    if(args.expected!==undefined&&(!Array.isArray(args.expected)||args.expected.length>30||Array.from(args.expected).some((value:any)=>typeof value!=='string'||value.length>262144)||args.expected.reduce((n:number,value:string)=>n+value.length,0)>524288))return {error:'Use up to 30 bounded source text checks'};
    const s=await session(owner,chat);return observedAction(s,name,async()=>{
      const data:any=parseBrowserJson(checked(await call(s,'browser_evaluate',{function:formCode({target:args.target,expected:args.expected})},15000,signal)));
      if(data.error)return data;
      return {...data,textChecks:Array.isArray(args.expected)?args.expected.map((value:string,i:number)=>({sha256:createHash('sha256').update(value).digest('hex'),matched:data.contains?.[i]===true})):undefined,fields:(data.fields||[]).map((field:any)=>{const {value,...rest}=field;return {...rest,characters:value.length,sha256:createHash('sha256').update(value).digest('hex'),...(value.length<=2000?{value}:{preview:value.slice(0,1000),valueTruncated:true})};}),note:'Full field values were read for hashes. Long previews are not full text. These are visible editor values; save and reopen the actual record before claiming persistence.'};
    });
  }
  if(name==="browser_scroll"||name==="browser_inspect_scroll_regions"){
    if(args.target!==undefined&&(typeof args.target!=="string"||args.target.length>2000)||['deltaY','deltaX'].some(k=>args[k]!==undefined&&(!Number.isFinite(args[k])||Math.abs(args[k])>2000)))return {error:"Use an observed selector and scroll deltas between -2000 and 2000"};
    const s=await session(owner,chat);
    return observedAction(s,name,async()=>{
      if(name==="browser_scroll"){canvasObservations.delete(owner+":"+chat);s.visionAt=undefined;s.snapshot=undefined;}
      try{return parseBrowserJson(checked(await call(s,"browser_evaluate",{function:scrollCode({action:name==="browser_scroll"?"scroll":"inspect",target:args.target,deltaY:args.deltaY,deltaX:args.deltaX})},15000,signal)));}
      catch(e){return {error:"Scroll operation failed: "+(e as Error).message,note:"Inspect a fresh snapshot or scroll region before retrying. This does not establish that the site has no data."};}
    });
  }
  if(name==="browser_read_table"){
    if(args.target!==undefined&&(typeof args.target!=="string"||args.target.length>2000)||args.offset!==undefined&&(!Number.isInteger(args.offset)||args.offset<0))return {error:"Use a bounded selector and nonnegative offset"};
    const s=await session(owner,chat);
    return observedAction(s,name,async()=>{try{
      let result:any;
      for(let attempt=0;attempt<5;attempt++){
        signal?.throwIfAborted();
        result=parseBrowserJson(checked(await call(s,"browser_evaluate",{function:tableCode({target:args.target,offset:args.offset})},15000,signal)));
        if(result.error||result.rows?.length)return result;
        if(attempt<4)await new Promise(resolve=>setTimeout(resolve,250));
      }
      return {...result,waitedForRowsMs:1000,note:"No rendered rows after bounded read-only polling. Inspect the current tab, actual scroll region, filters or pagination. This does not establish a lazy-loading cause or absence of data."};
    }catch(e){return {error:"Table observation failed: "+(e as Error).message,note:"This does not prove the site has no records. Inspect the relevant tab or a focused snapshot."};}});
  }
  if(name==="browser_inspect_targets"||name==="browser_drag_targets"){
    if(args.nodeIds!==undefined&&(!Array.isArray(args.nodeIds)||args.nodeIds.length>4||args.nodeIds.some((id:any)=>typeof id!=="string"||id.length>200)))return {error:"nodeIds must contain up to four observed node IDs"};
    const s=await session(owner,chat),key=owner+":"+chat;
    return observedAction(s,name,async()=>{
      let gesture:any;
      if(name==="browser_drag_targets"){
        const observation=canvasObservations.get(key);
        if(!observation||observation.id!==args.observationId||Date.now()-observation.at>30000)return {error:"Canvas observation expired; inspect targets again",recovery:{kind:"target",actionOutcome:"not_executed",safeToRetry:true}};
        const start=observation.targets.find(t=>t.id===args.start),end=observation.targets.find(t=>t.id===args.end);
        if(!start||!end||start.id===end.id)return {error:"Select two distinct observed targets",recovery:{kind:"target",actionOutcome:"not_executed",safeToRetry:true}};
        canvasObservations.delete(key);s.visionAt=undefined;s.snapshot=undefined;
        try{gesture=parseBrowserJson(checked(await call(s,"browser_run_code_unsafe",{code:dragCode({x:start.rect.x+start.rect.width/2,y:start.rect.y+start.rect.height/2},{x:end.rect.x+end.rect.width/2,y:end.rect.y+end.rect.height/2},[start,end])},15000,signal)));}
        catch{return {error:"Canvas gesture outcome is unknown; inspect the destination before another attempt",recovery:{kind:"targeting",actionOutcome:"unknown",safeToRetry:false}};}
        if(gesture.error)return {...gesture,recovery:{kind:"target",actionOutcome:"not_executed",safeToRetry:true}};
        s.dirty=true;deferCheckpoint(s);
      }
      try{
        const geometry=parseBrowserJson(checked(await call(s,"browser_evaluate",{function:"() => "+inspectCode(args.nodeIds)},15000,signal)));
        const shot=checked(await call(s,"browser_take_screenshot",{type:"jpeg",fullPage:false},15000,signal));
        const id=randomUUID();canvasObservations.set(key,{id,at:Date.now(),targets:geometry.targets});s.visionAt=Date.now();
        return {...normalized(s,shot),...geometry,targets:geometry.targets.map(({selector,...target}:CanvasTarget)=>target),observationId:id,...(gesture?{gesture}:{}),coordinateSpace:"CSS viewport pixels; do not use the scaled Computer preview coordinates"};
      }catch(error){return {error:"Could not inspect canvas geometry/pixels: "+String((error as Error).message).slice(0,1000),...(gesture?{gesture}:{}),recovery:{kind:"targeting",actionOutcome:gesture?"unknown":"not_executed",safeToRetry:!gesture,guidance:"Use a fresh semantic snapshot or screenshot. This is an observation/targeting failure, not proof the app cannot complete the workflow."}};}
    });
  }
  if(name==="browser_recover"){
    const key=owner+":"+chat,pending=sessions.get(key);canvasObservations.delete(key);if(pending){const s=await pending.catch(()=>null);if(s){s.closing=true;if(s.saveTimer)clearTimeout(s.saveTimer);s.previewAbort?.abort();await s.chain.catch(()=>{});await s.client.close().catch(()=>{});}sessions.delete(key);}
    const s=await session(owner,chat);return observedAction(s,name,async()=>{const r=checked(await call(s,"browser_snapshot",{},15000,signal));remember(s,r,true);return {...normalized(s,r),recovered:true,note:"Restored saved tabs and cookies; inspect authentication and effects of the interrupted action before continuing."};});
  }
  if(name==="browser_read_snapshot"){const s=await session(owner,chat);if(s.snapshot?.id!==args.snapshotId)throw new Error("Snapshot changed; request a fresh focused snapshot");return pageSlice(s,args.offset);}
  if(!ALLOWED.has(name))throw new Error("Unsupported browser action");
  if(name==="browser_navigate" || name==="browser_tabs"&&args.url){const problem=navigationProblem(args.url);if(problem)return problem;}
  const filesDir=join(browserDirectory(owner,chat),"files");
  if(name==="browser_file_upload")args=uploadArguments(filesDir,args);
  if(name==="browser_take_screenshot"||name==="browser_snapshot")delete args.filename;
  if(name==="browser_take_screenshot"){args.type="jpeg";args.fullPage=false;}
  if(name==="browser_close"){await closeBrowser(owner,chat);return {content:[{type:"text",text:"Browser closed; saved login retained. Tabs will not reopen until requested."}]};}
  const preserveExisting=args._preserveExisting===true;args={...args};delete args._preserveExisting;
  const s=await session(owner,chat);
  const schema=s.tools.find(t=>t.name===name)?.inputSchema;
  try{args=browserArguments(schema,args);}catch(error){return {error:(error as Error).message,recovery:{kind:"arguments",actionOutcome:"not_executed",safeToRetry:true,guidance:"No page action ran. Correct the arguments using this installed schema; do not retry guessed shapes or ask the user to perform the action."},inputSchema:schema};}
  return observedAction(s,name,async()=>{
    signal?.throwIfAborted();let preflight=true;
    try{
      if(TARGETED.has(name)){
        // MCP itself resolves the live target and enforces uniqueness/actionability.
        // Reuse a fresh observed tree instead of duplicating it on every click.
        if(!s.snapshot || Date.now()-s.snapshot.at>10000){s.metrics.preflights++;remember(s,checked(await call(s,"browser_snapshot",{},15000,signal)),true);}
        try{validateActionReferences(s.snapshot!.raw,args);}catch{
          s.metrics.preflights++;remember(s,checked(await call(s,"browser_snapshot",{},15000,signal)),true);
          validateActionReferences(s.snapshot!.raw,args);
        }
      }
      if(name==="browser_mouse_click_xy"||name==="browser_mouse_drag_xy")if(!s.visionAt||Date.now()-s.visionAt>30000)throw new Error("Capture a fresh viewport screenshot before coordinate targeting");
      let saveControl=false;
      if(name==='browser_click'&&(s.unchangedPreservedForm||s.preservedFormChanged)){
        const evaluated=browserArguments(s.tools.find(t=>t.name==='browser_evaluate')?.inputSchema,{element:'Observed save control',target:args.target||args.ref,function:`element => document.forms.length===1&&(element.form||element.closest('form'))===document.forms[0]&&/^(?:save(?: changes)?|update(?: contact|profile|record)?)$/i.test((element.innerText||element.value||element.getAttribute('aria-label')||'').trim())`});
        saveControl=parseBrowserJson(checked(await call(s,'browser_evaluate',evaluated,15000,signal)))===true;
        if(preserveExisting&&saveControl&&s.unchangedPreservedForm&&!s.preservedFormChanged){const snap=checked(await call(s,'browser_snapshot',{},15000,signal));remember(s,snap,true);return {...normalized(s,snap),unchanged:true,submissionSkipped:true,note:'The missing-only fields were already present. This unchanged Save/Update was not submitted; reopen and verify the existing saved state.'};}
      }
      const preservedFields:any[]=[];
      if(preserveExisting&&['browser_fill_form','browser_type'].includes(name)){
        const fields=name==='browser_fill_form'?args.fields:[{target:args.target||args.ref,value:args.text}];
        const changed=[];let unambiguousForm=true;
        for(const field of fields){
          const evalArgs=browserArguments(s.tools.find(t=>t.name==='browser_evaluate')?.inputSchema,{element:'Current visible copy destination',target:field.target||field.ref,function:copyFieldInPage.toString()});
          const current:any=parseBrowserJson(checked(await call(s,'browser_evaluate',evalArgs,15000,signal)));
          unambiguousForm&&=current.unambiguousForm===true;
          if(current.excluded||current.search){changed.push(field);continue;}
          const value=mergeMissingValue(current.value,String(field.value??''),current.history);
          preservedFields.push({target:field.target||field.ref,characters:value.length,sha256:createHash('sha256').update(value).digest('hex'),changed:value!==current.value});
          if(value!==current.value)changed.push({...field,value});
        }
        if(!changed.length){s.unchangedPreservedForm=unambiguousForm&&!s.preservedFormChanged;const snap=checked(await call(s,'browser_snapshot',{},15000,signal));remember(s,snap,true);return {...normalized(s,snap),unchanged:true,preservedFields,note:'The requested values were already present or existing scalar fields were retained. No field changed. Do not submit an unchanged form.'};}
        s.preservedFormChanged=true;s.unchangedPreservedForm=false;
        if(name==='browser_fill_form')args.fields=changed;else args.text=changed[0].value;
      }
      // A control click may edit a checkbox or switch editor state. Preserve uncertainty
      // until navigation rather than suppressing a later required submission.
      if(!browserRead(name,args)){s.unchangedPreservedForm=false;s.preservedFormChanged=true;}
      preflight=false;
      const result=checked(await call(s,name==="browser_mouse_drag_xy"?"browser_run_code_unsafe":name,name==="browser_mouse_drag_xy"?{code:dragCode({x:args.startX,y:args.startY},{x:args.endX,y:args.endY})}:args,name==="browser_navigate"||name==="browser_wait_for"||name==="browser_tabs"&&args.action==="new"?35000:name==="browser_file_upload"?120000:15000,signal));
      if(saveControl||['browser_navigate','browser_navigate_back','browser_tabs'].includes(name)){s.preservedFormChanged=false;s.unchangedPreservedForm=false;}
      if(name==="browser_mouse_drag_xy"){const gesture=parseBrowserJson(result);if(gesture.error)return {...gesture,recovery:{kind:"target",actionOutcome:"not_executed",safeToRetry:true}};}
      if(!browserRead(name,args))canvasObservations.delete(owner+":"+chat);
      if(!browserRead(name,args)){s.visionAt=undefined;s.snapshot=undefined;s.dirty=true;}
      if(name==="browser_take_screenshot")s.visionAt=Date.now();
      try{remember(s,result,name==="browser_snapshot");}catch{s.saveWarning="The action returned successfully but tab state could not be saved. Inspect the page before repeating any action.";}
      s.lastUsed=Date.now();
      if(s.dirty){if(!s.savedAt || args.submit || name==="browser_press_key"&&/enter/i.test(args.key||""))await checkpoint(s);else deferCheckpoint(s);}
      return {...normalized(s,result),...(preservedFields.length?{preservedFields,note:'Existing scalar values were retained and literal history was appended only when missing. These hashes describe editor values; save and reopen to verify persistence.'}:{})};
    }catch(e){
      s.failed=true;const message=(e as Error).message;let recovery=recoveryFor(message,preflight);s.visionAt=undefined;
      // A batch may have changed earlier fields before a later target failed.
      if(!preflight&&name==="browser_fill_form"&&recovery.safeToRetry)recovery={kind:"partial_form",actionOutcome:"unknown",safeToRetry:false,guidance:"Some fields may already be filled. Inspect the fresh form and fill only the remaining fields; do not blindly replay the batch or submit."};
      if(name==="browser_file_upload")recovery={...recovery,guidance:"Inspect the page for selected files or progress before repeating an upload. If no chooser is visible and no file was selected, click the observed Choose files control, then use browser_file_upload with paths from workspace_files. A native chooser is supported. "+recovery.guidance};
      let observation:any;
      // A crashed browser can respawn as a blank page. Do not replace retained
      // tabs with that diagnostic page before browser_recover can restore them.
      if(!signal?.aborted)try{
        const fresh=checked(await call(s,"browser_snapshot",{},8000));remember(s,fresh,true,false);observation=pageSlice(s);
        // Snapshot reads have no external effect to replay. If a focused read
        // fails but a whole-page read succeeds, return the fresh observation.
        // Keep failed writes uncertain even when their diagnostic read succeeds.
        if(name==="browser_snapshot") {s.failed=false;return {...normalized(s,fresh),recovered:true,note:"The requested snapshot failed; this is a fresh whole-page observation instead. Choose targets from this result; the original target was not verified."};}
      }catch{}
      if(!preflight)s.dirty=true;
      return {error:message,recovery,observation,inputSchema:schema,note:"Use this installed schema to correct the next call. For a failed targeted snapshot, read the whole page with browser_snapshot arguments {} before choosing a fresh target; do not guess more references."};
    }
  });
}
export function saveLogin(owner: string, input: any) {
  if (input.projectId) get("project", owner, input.projectId);
  const url = new URL(text(input.url, "Login URL", 2000)); if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use an HTTPS login URL");
  if (typeof input.password !== "string" || !input.password.length || input.password.length > 2000) throw new Error("Password is required (maximum 2000 characters)");
  return put("login", owner, { id: randomUUID(), name: text(input.name, "Login name", 100), projectId: input.projectId || null, url: url.toString(), secret: seal({ username: text(input.username, "Username", 500), password: input.password }) });
}
export function logins(owner: string, projectId?: string | null) { return list<any>("login", owner).filter(c => projectId === undefined || !c.projectId || c.projectId === projectId).map(({ secret, ...c }) => c); }
export async function fillSavedLogin(owner: string, chat: string, projectId: string | null, input: any, signal?:AbortSignal) {
  const login = get<any>("login", owner, text(input.loginId, "Login")); if (login.projectId && login.projectId !== projectId) throw new Error("Login belongs to another project");
  // Check the current page's URL from the browser itself, never the model's claim.
  const s = await session(owner, chat);
  return observedAction(s,"browser_fill_form",async()=>{
  const snap: any = checked(await call(s,"browser_snapshot",{},15000,signal));
  const snapshot = (snap.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const pageUrl = snapshot.match(/- Page URL: (https?:\/\/[^\s]+)/)?.[1];
  if (!pageUrl || new URL(pageUrl).origin !== new URL(login.url).origin) throw new Error("Navigate to the saved login's exact origin before using it");
  const credentials = unseal(login.secret);
  // One fill call minimizes the gap between verifying the destination and typing.
  const targetKey = s.tools.find(t=>t.name === "browser_fill_form")?.inputSchema?.properties?.fields?.items?.properties?.target ? "target" : "ref";
  const filled = await call(s,"browser_fill_form",{ fields: [
    { name: "Username", type: "textbox", [targetKey]: text(input.usernameRef, "Username field reference", 100), value: credentials.username },
    { name: "Password", type: "textbox", [targetKey]: text(input.passwordRef, "Password field reference", 100), value: credentials.password },
  ] },15000,signal);
  if (filled.isError) throw new Error("The saved login could not be filled. Inspect fresh field references and try again.");
  s.dirty=true;s.snapshot=undefined;s.visionAt=undefined;
  try{remember(s,filled);}catch{s.saveWarning="Login fields were filled, but tab state could not be saved. Inspect the page before repeating.";}
  await checkpoint(s);
  return { filled: true, persistenceWarning:s.saveWarning, note: "Saved login filled. Inspect the page, then submit if requested. MFA or CAPTCHA may need the user's help." };
  });
}
