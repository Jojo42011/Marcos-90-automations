import { managedCatalog, connectManaged, disconnectManaged } from "./composio.js";
import multer from "multer";
import { randomUUID } from "crypto";
import { filesDir, files, filePath } from "./files.js";
import express, { Request, Response } from "express";
import { append, handoffChat, Chat, Connection, createChat, createProject, createSchedule, get, list, messages, Project, put, remove, Run, Schedule, text, timezone, vaultReady, workDb } from "./store.js";
import { addMcp, catalog, connections, finishOAuth, publicConnection, startOAuth } from "./connectors.js";
import { browserCall, browserEnabled, closeBrowser, logins, saveLogin } from "./browser.js";
import { runChat, runScheduled, updateSchedule } from "./runtime.js";

type Owner = (req: Request) => string;
const error = (res: Response, e: any) => res.status(e.message === "Not found" ? 404 : 400).json({ error: e.message || "Request failed" });
export function createWorkRouter(authorize: (req: Request) => boolean, owner: Owner) {
  const r = express.Router(); r.use(express.json({ limit: "256kb" }));
  r.get("/work/oauth/callback", async (req, res) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    try { const state = String(req.query.state || ""), cookie = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("harvey_oauth_state="))?.split("=")[1] || "";
      if (req.query.error) throw new Error("Service sign-in was cancelled. Return to Plugins to try again.");
      await finishOAuth(state, text(req.query.code, "Authorization code", 8000), cookie); res.clearCookie("harvey_oauth_state", { path: "/api/harvey/work/oauth" }); res.redirect("/harvey?connected=1");
    } catch (e) { res.status(400).type("text/plain").send((e as Error).message); }
  });
  r.use((req,res,next) => { if (!authorize(req)) { res.status(401).json({ error: "Unauthorized" }); return; } next(); });
  const route = (method: "get" | "post" | "patch" | "delete", path: string, fn: (req: Request, res: Response, o: string) => any) => r[method](path, async (req,res) => { try { await fn(req,res,owner(req)); } catch(e) { error(res,e); } });
  r.post("/work/files/:chat", (req,res,next) => { try {get("chat",owner(req),String(req.params.chat));next();}catch(e){error(res,e);} }, multer({storage:multer.diskStorage({destination:(req,_file,cb)=>cb(null,filesDir(owner(req),String(req.params.chat))),filename:(_req,file,cb)=>cb(null,randomUUID()+"-"+file.originalname.replace(/[^a-zA-Z0-9._-]/g,"-").slice(-120))}),limits:{fileSize:250*1024*1024,files:1}}).single("file"), (req,res)=>res.status(201).json({file:req.file?.filename}));
  route("get", "/work/files/:chat", (q,res,o) => {get("chat",o,String(q.params.chat));res.json({files:files(o,String(q.params.chat))});});
  route("get", "/work/files/:chat/:name", (q,res,o) => {get("chat",o,String(q.params.chat));res.download(filePath(o,String(q.params.chat),String(q.params.name)));});
  route("get", "/work/status", (_q,res) => res.json({ browser: browserEnabled(), worker: process.env.HARVEY_WORKER_ENABLED === "true", vault: vaultReady() }));
  route("get", "/projects", (_q,res,o) => res.json({ projects: list<Project>("project",o) }));
  route("post", "/projects", (q,res,o) => res.status(201).json(createProject(o,q.body)));
  route("patch", "/projects/:id", (q,res,o) => { const p = get<Project>("project",o,String(q.params.id)); res.json(put("project",o,{ ...p, name: q.body.name === undefined ? p.name : text(q.body.name,"Name",100), instructions: q.body.instructions === undefined ? p.instructions : String(q.body.instructions).slice(0,12000), timezone: q.body.timezone === undefined ? p.timezone : timezone(q.body.timezone) })); });
  route("get", "/conversations", (_q,res,o) => res.json({ conversations: list<Chat>("chat",o).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) }));
  route("post", "/conversations", (q,res,o) => res.status(201).json(createChat(o,q.body)));
  route("get", "/conversations/:id", (q,res,o) => res.json({ ...get<Chat>("chat",o,String(q.params.id)), messages: messages(o,String(q.params.id)) }));
  route("post", "/conversations/:id/title", (q,res,o) => { const c = get<Chat>("chat",o,String(q.params.id)); res.json(put("chat",o,{...c,title:text(q.body.title,"Title",120)})); });
  route("post", "/conversations/:id/handoff", (q,res,o) => res.status(201).json(handoffChat(o,String(q.params.id),q.body.brief || "Prepare a plan from this conversation.")));
  route("patch", "/conversations/:id", (q,res,o) => { const c = get<Chat>("chat",o,String(q.params.id)); if(q.body.mode !== undefined && q.body.mode !== c.mode && (messages(o,c.id).length || workDb().prepare("SELECT 1 FROM locks WHERE owner=? AND chat=?").get(o,c.id))) throw new Error("Mode is fixed after the first message. Create a new chat or hand off to Work."); if (q.body.projectId) get("project",o,q.body.projectId); res.json(put("chat",o,{...c,projectId:q.body.projectId === undefined ? c.projectId : q.body.projectId || null,mode:q.body.mode === undefined ? c.mode : q.body.mode === "work" ? "work" : "chat"})); });
  route("delete", "/conversations/:id", async (q,res,o) => {
    const id = String(q.params.id); get("chat",o,id);
    if (workDb().prepare("SELECT 1 FROM locks WHERE owner=? AND chat=?").get(o,id)) throw new Error("Wait for this chat's running task to finish");
    for (const s of list<Schedule>("schedule",o).filter(s=>s.chatId===id)) remove("schedule",o,s.id);
    for (const run of list<Run>("run",o).filter(s=>s.chatId===id)) remove("run",o,run.id);
    workDb().prepare("DELETE FROM messages WHERE owner=? AND chat=?").run(o,id); remove("chat",o,id); await closeBrowser(o,id); res.json({ok:true});
  });
  route("get", "/work/managed", async(q,res,o)=>res.json(await managedCatalog(o,q.query.projectId?String(q.query.projectId):null,String(q.query.search||""),q.query.cursor?String(q.query.cursor):undefined)));
  route("post", "/work/managed/connect", async(q,res,o)=>res.json(await connectManaged(o,q.body.projectId||null,String(q.body.service))));
  route("post", "/work/managed/disconnect", async(q,res,o)=>res.json(await disconnectManaged(o,q.body.projectId||null,String(q.body.service),q.body.scope?String(q.body.scope):undefined)));
  route("get", "/work/plugins", (_q,res,o) => res.json({ catalog:catalog(), connections:connections(o).map(publicConnection) }));
  route("post", "/work/plugins/oauth", (q,res,o) => { const result = startOAuth(o,q.body.service,q.body.projectId || null,q.body.allowWrites === true); res.cookie("harvey_oauth_state",result.state,{ httpOnly:true,sameSite:"lax",secure:q.secure,maxAge:600000,path:"/api/harvey/work/oauth" }); res.json({url:result.url}); });
  route("post", "/work/plugins/mcp", async (q,res,o) => res.status(201).json(await addMcp(o,q.body)));
  route("patch", "/work/plugins/:id", (q,res,o) => { const c = get<Connection>("connection",o,String(q.params.id)); if (q.body.projectId) get("project",o,q.body.projectId); res.json(publicConnection(put("connection",o,{...c,allowWrites:q.body.allowWrites === true,projectId:q.body.projectId === undefined ? c.projectId : q.body.projectId || null}))); });
  route("delete", "/work/plugins/:id", (q,res,o) => { remove("connection",o,String(q.params.id)); res.json({ok:true}); });
  route("get", "/work/logins", (_q,res,o) => res.json({logins:logins(o)}));
  route("post", "/work/logins", (q,res,o) => { const {secret,...login}=saveLogin(o,q.body); res.status(201).json(login); });
  route("delete", "/work/logins/:id", (q,res,o) => {remove("login",o,String(q.params.id)); res.json({ok:true});});
  route("post", "/work/browser/:chat/snapshot", async (q,res,o) => { const c=get<Chat>("chat",o,String(q.params.chat)); res.json(await browserCall(o,c.id,"browser_snapshot",{})); });
  route("post", "/work/browser/:chat/close", async (q,res,o) => {get("chat",o,String(q.params.chat)); await closeBrowser(o,String(q.params.chat));res.json({ok:true});});
  route("get", "/work/schedules", (_q,res,o) => res.json({schedules:list<Schedule>("schedule",o),runs:list<Run>("run",o).slice(0,100)}));
  route("post", "/work/schedules", (q,res,o) => res.status(201).json(createSchedule(o,q.body)));
  route("patch", "/work/schedules/:id", (q,res,o) => res.json(updateSchedule(o,String(q.params.id),q.body)));
  route("post", "/work/schedules/:id/run", async (q,res,o) => { const run=await runScheduled(o,String(q.params.id),true); if(!run) throw new Error("This agent is already running"); res.json(run); });
  route("delete", "/work/schedules/:id", (q,res,o) => {remove("schedule",o,String(q.params.id));res.json({ok:true});});
  r.use((e: any, _req: Request, res: Response, _next: express.NextFunction) => { res.status(e.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({error:e.code === "LIMIT_FILE_SIZE" ? "File exceeds the 250 MB limit" : "Upload failed"}); });
  return r;
}
export async function handleWorkChat(req: Request,res: Response,owner: string) {
  let streaming = false;
  const controller = new AbortController();
  res.on("close",()=>{if(!res.writableEnded)controller.abort();});
  try {
    const message = text(req.body.message,"Message",50000);
    const chat = req.body.conversationId ? get<Chat>("chat",owner,String(req.body.conversationId)) : createChat(owner,req.body);
    const stream = req.body.stream === true;
    if(stream) {res.setHeader("Content-Type","text/event-stream");res.setHeader("Cache-Control","no-cache");res.flushHeaders();streaming=true;}
    const send=(event:string,data:unknown)=>{if(!res.writableEnded&&!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
    if(stream) send("conversation",{conversationId:chat.id,sessionId:chat.sessionId});
    const heartbeat=stream?setInterval(()=>{if(!res.writableEnded&&!res.destroyed)res.write(": heartbeat\n\n");},15000):null;
    try {
      const approvals: unknown[] = []; const schedules: unknown[] = [];
      const result=await runChat(owner,chat,message,{signal:controller.signal,modelOverride:req.body.model&&req.body.model!=="auto"?String(req.body.model):undefined,onToken:stream?t=>send("token",{text:t}):undefined,onEvent:e=>{if(e.type === "approval")approvals.push(e.approval);if(e.type === "schedule")schedules.push(e.schedule);if(stream)send(e.type,e.type === "approval" ? e.approval : e);}});
      const data={text:result.speech,conversationId:chat.id,sessionId:chat.sessionId,usage:{model:result.modelUsed||result.model,costUsd:result.costUsd||0,promptTokens:result.promptTokens||0,completionTokens:result.completionTokens||0,cachedTokens:result.cachedTokens||0},approvals,schedules,needsAttention:result.toolFailed||!!result.modelError||!!result.budgetRefused};
      if(stream){send("done",data);res.end();}else res.json(data);
    } finally { if(heartbeat)clearInterval(heartbeat); }
  } catch(e) { if(res.destroyed)return;if(streaming){res.write(`event: error\ndata: ${JSON.stringify({message:(e as Error).message})}\n\n`);res.end();}else error(res,e); }
}
