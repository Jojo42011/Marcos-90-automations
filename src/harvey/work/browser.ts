import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash, randomUUID } from "crypto";
import { mkdirSync, chownSync, existsSync, renameSync, chmodSync, writeFileSync, readFileSync, realpathSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { get, list, put, seal, unseal, workDir, text } from "./store.js";
import {browserRead, parseTabs, readTabs, recoveryFor, restorableUrl, resultText, TabState, writeTabs} from "./browserState.js";

const ALLOWED = new Set(["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type", "browser_fill_form", "browser_press_key", "browser_select_option", "browser_hover", "browser_drag", "browser_tabs", "browser_wait_for", "browser_handle_dialog", "browser_file_upload", "browser_take_screenshot", "browser_close", "browser_mouse_click_xy", "browser_mouse_drag_xy", "browser_mouse_wheel"]);
const TARGETED = new Set(["browser_click","browser_type","browser_fill_form","browser_select_option","browser_hover","browser_drag"]);
const EXTRA_TOOLS = [
  {name:"browser_read_snapshot",description:"Read another bounded page of the most recent full snapshot without recapturing it. Use snapshotId and nextOffset returned by the previous result. For a new state or a specific region use browser_snapshot with target/depth instead.",inputSchema:{type:"object",properties:{snapshotId:{type:"string"},offset:{type:"integer",minimum:0}},required:["snapshotId","offset"]}},
  {name:"browser_recover",description:"Restart this chat's unresponsive hosted browser and restore saved tabs/cookies. Only after observing a connection or browser crash. Never replays a click, form submission or other action; unsaved page state can be lost. Inspect the restored page before continuing.",inputSchema:{type:"object",properties:{}}}
];
type Frame = { image: string; capturedAt: string; url: string; title: string };
type Session = {owner:string;chat:string;client:Client;tools:any[];lastUsed:number;statePath:string;tabsPath:string;tabs?:TabState;busy:number;chain:Promise<any>;action?:string;failed?:boolean;frame?:Frame;preview?:Promise<void>;previewAbort?:AbortController;closing?:boolean;snapshot?:{id:string;raw:string;at:number};visionAt?:number;dirty:boolean;savedAt:number;saveTimer?:NodeJS.Timeout;saveWarning?:string;restoreWarning?:string;metrics:{calls:number;preflights:number;checkpoints:number;previewCalls:number}};
const sessions = new Map<string, Promise<Session>>();
let shuttingDown=false;
let shutdownRegistered=false;
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
  const result:any=await s.client.callTool({name,arguments:args},undefined,{timeout,signal});
  // This MCP version puts implicit action snapshots in local files. Return their
  // actual observations to the model without paying for another browser call.
  const dir=browserDirectory(s.owner,s.chat),files=realpathSync(join(dir,"files"));
  for(const content of result.content||[])if(content.type==="text")content.text=content.text.replace(/(### Snapshot\r?\n)- \[Snapshot\]\((files\/page-[\w.-]+\.yml)\)/g,(_match:string,header:string,file:string)=>{
    try{const path=realpathSync(resolve(dir,file));if(!path.startsWith(files+sep)||statSync(path).size>2*1024*1024)throw new Error("Snapshot outside bounded workspace");return header+"```yaml\n"+readFileSync(path,"utf8")+"\n```";}
    catch{return header+"Snapshot content unavailable. Request a focused browser_snapshot before acting or claiming page contents.";}
  });
  return result;
}
function checked(r:any){if(r.isError)throw new Error(resultText(r).slice(0,2000));return r;}
function remember(s:Session,r:any,full=false){
  const raw=resultText(r);
  if(full || /### Snapshot/.test(raw))s.snapshot={id:randomUUID(),raw,at:Date.now()};
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
  s.saveTimer=setTimeout(()=>{s.saveTimer=undefined;void observedAction(s,"session checkpoint",()=>checkpoint(s));},1500);s.saveTimer.unref();
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
  try{await checkpoint(s,true);if(explicit)writeTabs(s.tabsPath,{urls:s.tabs?.urls||[],active:s.tabs?.active||0,open:false,updatedAt:new Date().toISOString()});}finally{await s.client.close();}
}
export async function closeBrowser(owner:string,chat:string){const key=owner+":"+chat,pending=sessions.get(key);if(pending){const s=await pending.catch(()=>null);if(s)await closeSession(s,true);sessions.delete(key);}else{const path=tabsPath(owner,chat),saved=readTabs(path);if(saved)writeTabs(path,{...saved,open:false});}}
export async function closeBrowsers(){await Promise.all([...sessions].map(async([key,pending])=>{try{const s=await pending.catch(()=>null);if(s)await closeSession(s);}finally{sessions.delete(key);}}));}
// Closing a laptop only disconnects the UI. There is deliberately no idle tab eviction.
// Periodically capture cookie changes and client-side tab navigation while the model is idle.
const maintenance=setInterval(()=>{for(const pending of sessions.values())void pending.then(s=>{if(!s.busy&&!s.closing){s.dirty=true;void observedAction(s,"session checkpoint",()=>checkpoint(s));}}).catch(()=>{});},30000);maintenance.unref();
export async function browserTools(owner:string,chat:string,name?:string){const tools=(await session(owner,chat)).tools;if(name){const t=tools.find(t=>t.name===name);if(!t)throw new Error("Unsupported browser tool");return [t];}return tools.map(t=>({name:t.name,description:t.description?.slice(0,180),schema:"Request computer action=tools with this tool name for its complete input schema."}));}
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
  if(name==="browser_recover"){
    const key=owner+":"+chat,pending=sessions.get(key);if(pending){const s=await pending.catch(()=>null);if(s){s.closing=true;if(s.saveTimer)clearTimeout(s.saveTimer);s.previewAbort?.abort();await s.chain.catch(()=>{});await s.client.close().catch(()=>{});}sessions.delete(key);}
    const s=await session(owner,chat);return observedAction(s,name,async()=>{const r=checked(await call(s,"browser_snapshot",{},15000,signal));remember(s,r,true);return {...normalized(s,r),recovered:true,note:"Restored saved tabs and cookies; inspect authentication and effects of the interrupted action before continuing."};});
  }
  if(name==="browser_read_snapshot"){const s=await session(owner,chat);if(s.snapshot?.id!==args.snapshotId)throw new Error("Snapshot changed; request a fresh focused snapshot");return pageSlice(s,args.offset);}
  if(!ALLOWED.has(name))throw new Error("Unsupported browser action");
  if(name==="browser_navigate" || name==="browser_tabs"&&args.url){const url=new URL(text(args.url,"URL",4000));if(!["https:","http:"].includes(url.protocol)||url.username||url.password)throw new Error("Use an HTTP(S) URL without embedded credentials");}
  const filesDir=join(browserDirectory(owner,chat),"files");
  if(name==="browser_file_upload")for(const file of args.paths||[])if(!resolve(file).startsWith(resolve(filesDir)+sep))throw new Error("Upload files must belong to this chat's browser workspace");
  if(name==="browser_take_screenshot"||name==="browser_snapshot")delete args.filename;
  if(name==="browser_take_screenshot"){args.type="jpeg";args.fullPage=false;}
  if(name==="browser_close"){await closeBrowser(owner,chat);return {content:[{type:"text",text:"Browser closed; saved login retained. Tabs will not reopen until requested."}]};}
  const s=await session(owner,chat);
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
      preflight=false;
      const result=checked(await call(s,name,args,name==="browser_navigate"||name==="browser_wait_for"||name==="browser_tabs"&&args.action==="new"?35000:15000,signal));
      if(!browserRead(name,args)){s.visionAt=undefined;s.snapshot=undefined;s.dirty=true;}
      if(name==="browser_take_screenshot")s.visionAt=Date.now();
      try{remember(s,result,name==="browser_snapshot");}catch{s.saveWarning="The action returned successfully but tab state could not be saved. Inspect the page before repeating any action.";}
      s.lastUsed=Date.now();
      if(s.dirty){if(!s.savedAt || args.submit || name==="browser_press_key"&&/enter/i.test(args.key||""))await checkpoint(s);else deferCheckpoint(s);}
      return normalized(s,result);
    }catch(e){
      s.failed=true;const message=(e as Error).message;let recovery=recoveryFor(message,preflight);s.visionAt=undefined;
      // A batch may have changed earlier fields before a later target failed.
      if(!preflight&&name==="browser_fill_form"&&recovery.safeToRetry)recovery={kind:"partial_form",actionOutcome:"unknown",safeToRetry:false,guidance:"Some fields may already be filled. Inspect the fresh form and fill only the remaining fields; do not blindly replay the batch or submit."};
      let observation:any;
      if(!signal?.aborted)try{const fresh=checked(await call(s,"browser_snapshot",{depth:6},8000));remember(s,fresh,true);observation=pageSlice(s);}catch{}
      if(!preflight){s.dirty=true;deferCheckpoint(s);}
      return {error:message,recovery,observation};
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
