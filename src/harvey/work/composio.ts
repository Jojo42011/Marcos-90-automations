import { createHash } from "crypto";
import { get, list, put } from "./store.js";

const SDK = new Function("return import('@composio/core')");
let clientPromise: Promise<any>;
const sessions = new Map<string, Promise<any>>();
const META = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_WAIT_FOR_CONNECTIONS"]);
const FEATURED = ["gmail","googledrive","googlecalendar","googlesheets","outlook","onedrive","slack","notion","github","linear","dropbox","box","hubspot","salesforce","airtable","trello","asana","discord","youtube","microsoft_teams"];
export function composioReady() { return !!process.env.COMPOSIO_API_KEY?.trim(); }
export function composioUser(owner: string, project: string | null) { return "harvey_" + createHash("sha256").update(JSON.stringify([owner,project])).digest("hex"); }
async function client() {
  if (!composioReady()) throw new Error("Managed connections are not configured yet");
  return clientPromise ||= SDK().then(({Composio}:any) => new Composio({apiKey:process.env.COMPOSIO_API_KEY}));
}
async function guarded<T>(work:()=>Promise<T>):Promise<T> { try { return await work(); } catch(e:any) { const message=String(e.message||"Connection request failed").split(process.env.COMPOSIO_API_KEY||"\0").join("[redacted]");throw new Error(message.slice(0,500)); } }
export async function composioSession(owner: string, project: string | null) {
  if(project)get("project",owner,project);
  const key=composioUser(owner,project);
  if(!sessions.has(key))sessions.set(key,guarded(async()=>{
    const c=await client(), saved=list<any>("composio_session",owner).find(s=>s.id===key);
    if(saved)return c.sessions.use(saved.sessionId);
    const s=await c.sessions.create(key,{manageConnections:{callbackUrl:new URL("/harvey?plugins=1&project="+encodeURIComponent(project||""),process.env.HARVEY_PUBLIC_URL||"http://localhost:3000").href}});
    put("composio_session",owner,{id:key,sessionId:s.sessionId,projectId:project});return s;
  }).catch(e=>{sessions.delete(key);throw e;}));
  return sessions.get(key)!;
}
export async function managedCatalog(owner:string,project:string|null,search="",cursor?:string) {
  if(!composioReady())return {enabled:false,items:[],connected:[]};
  return guarded(async()=>{const s=await composioSession(owner,project);
    const [catalog,connected]=await Promise.all([s.toolkits(search?{search:search.slice(0,100),limit:30,cursor}:{toolkits:FEATURED,limit:30}),s.toolkits({isConnected:true,limit:50})]);
    return {enabled:true,items:catalog.items,cursor:catalog.cursor,connected:connected.items};
  });
}
export async function connectManaged(owner:string,project:string|null,slug:string) {
  if(!/^[a-z0-9_-]{1,80}$/.test(slug))throw new Error("Invalid service");
  return guarded(async()=>{const s=await composioSession(owner,project);const connection=await s.authorize(slug,{callbackUrl:new URL("/harvey?plugins=1&project="+encodeURIComponent(project||""),process.env.HARVEY_PUBLIC_URL||"http://localhost:3000").href});return {url:connection.redirectUrl};});
}
export async function disconnectManaged(owner:string,project:string|null,slug:string) {
  return guarded(async()=>{const s=await composioSession(owner,project);const found=(await s.toolkits({toolkits:[slug],limit:1})).items[0];const id=found?.connection?.connectedAccount?.id;if(!id)throw new Error("No connected account found");await (await client()).connectedAccounts.delete(id);return {ok:true};});
}
export async function managedTools(owner:string,project:string|null) {
  if(!composioReady())return [];
  return guarded(async()=>{const s=await composioSession(owner,project);return (await s.tools()).filter((t:any)=>META.has(t.function?.name)).map((t:any)=>({name:t.function.name,description:t.function.description,input_schema:t.function.parameters}));});
}
export async function executeManaged(owner:string,project:string|null,name:string,input:any) {
  if(!META.has(name))throw new Error("Unsupported managed tool");
  // The session is selected by server identity, never by model-supplied identity.
  const args={...input};delete args.session_id;delete args.user_id;
  return guarded(async()=>{const s=await composioSession(owner,project);const r=await s.execute(name,args);if(r.error)throw new Error(typeof r.error==="string"?r.error:JSON.stringify(r.error));return r.data;});
}

