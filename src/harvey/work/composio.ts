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
// Existing project connections remain usable; new sign-ins belong to the owner.
function scopes(owner:string) {
  const projects=new Set(list<any>("project",owner).map(p=>p.id));
  return [null,...new Set(list<any>("composio_session",owner).map(s=>s.projectId).filter(p=>p&&projects.has(p)))];
}
export async function managedConnections(owner:string) {
  if(!composioReady())return [];
  const all:any[]=[];
  for(const project of scopes(owner)) {
    const session=await composioSession(owner,project);let cursor:string|undefined;
    do {const page=await session.toolkits({isConnected:true,limit:50,...(cursor?{cursor}:{})});
      all.push(...page.items.filter((t:any)=>t.connection?.isActive).map((t:any)=>({...t,scope:composioUser(owner,project)})));
      cursor=page.nextCursor||page.cursor; // SDK returns nextCursor; tolerate older cursor response.
      if(!page.items.length)break;
    }while(cursor);
  }
  return all;
}
export async function managedCatalog(owner:string,project:string|null,search="",cursor?:string) {
  if(project)get("project",owner,project);
  if(!composioReady())return {enabled:false,items:[],connected:[]};
  return guarded(async()=>{const session=await composioSession(owner,null);
    const [catalog,connected]=await Promise.all([session.toolkits(search?{search:search.slice(0,100),limit:30,cursor}:{toolkits:FEATURED,limit:30}),managedConnections(owner)]);
    return {enabled:true,items:catalog.items,cursor:catalog.cursor,connected};
  });
}
export async function connectManaged(owner:string,project:string|null,slug:string) {
  if(!/^[a-z0-9_-]{1,80}$/.test(slug))throw new Error("Invalid service");
  return guarded(async()=>{if(project)get("project",owner,project);const s=await composioSession(owner,null);const connection=await s.authorize(slug,{callbackUrl:new URL("/harvey?plugins=1&project="+encodeURIComponent(project||""),process.env.HARVEY_PUBLIC_URL||"http://localhost:3000").href});return {url:connection.redirectUrl};});
}
export async function disconnectManaged(owner:string,project:string|null,slug:string,scope?:string) {
  if(project)get("project",owner,project);
  return guarded(async()=>{const matches=(await managedConnections(owner)).filter(t=>t.slug===slug&&(!scope||t.scope===scope));
    if(!matches.length)throw new Error("No connected account found");
    for(const found of matches)await (await client()).connectedAccounts.delete(found.connection.connectedAccount.id);
    sessions.clear();return {ok:true};});
}
export async function managedTools(owner:string,project:string|null) {
  if(project)get("project",owner,project);
  if(!composioReady())return [];
  return guarded(async()=>{const session=await composioSession(owner,null);return (await session.tools()).filter((t:any)=>META.has(t.function?.name)).map((t:any)=>({name:t.function.name,description:t.function.description,input_schema:{...t.function.parameters,properties:{...t.function.parameters.properties,harvey_connection_scope:{type:"string",description:"Use the scope from the connected apps list for this service. Omit for new sign-ins.",enum:scopes(owner).map(p=>composioUser(owner,p))}}}}));});
}
export async function executeManaged(owner:string,project:string|null,name:string,input:any) {
  if(project)get("project",owner,project);
  if(!META.has(name))throw new Error("Unsupported managed tool");
  const args={...input};const scope=args.harvey_connection_scope;delete args.harvey_connection_scope;delete args.session_id;delete args.user_id;
  const allowed=scopes(owner);let selected:string|null=null;
  if(scope){const index=allowed.findIndex(p=>composioUser(owner,p)===scope);if(index<0)throw new Error("Unknown connection scope");selected=allowed[index];}
  else if(name!=="COMPOSIO_MANAGE_CONNECTIONS"){const connected=await managedConnections(owner);if(connected.length)selected=allowed.find(p=>composioUser(owner,p)===connected[0].scope)||null;}
  return guarded(async()=>{const session=await composioSession(owner,selected);const result=await session.execute(name,args);if(result.error)throw new Error(typeof result.error==="string"?result.error:JSON.stringify(result.error));return result.data;});
}
