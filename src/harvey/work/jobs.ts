import { createHash, randomUUID } from "crypto";
import { Chat, get, list, owners, put, text, workDb } from "./store.js";
import { runChat } from "./runtime.js";

export interface WorkJob {
  actorId?: string; id: string; chatId: string; requestId: string; fingerprint: string; prompt: string; model?: string;
  status: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "needs_attention" | "failed";
  createdAt: string; updatedAt: string; result?: any; originChatId?: string; maxCostUsd?: number;
  events: {seq:number;type:string;name?:string;status?:string;at:string}[];
}
const controllers = new Map<string, AbortController>();
const key = (owner:string,id:string) => owner+":"+id;
export const activeJob = (j: WorkJob) => ["queued","running","cancelling"].includes(j.status);
export function publicJob(j: WorkJob) {
  const {prompt,fingerprint,requestId,...visible}=j; return visible;
}
export function chatJob(owner:string,chatId:string) {
  get<Chat>("chat",owner,chatId);
  return list<WorkJob>("job",owner).find(j=>j.chatId===chatId&&activeJob(j));
}
export function enqueueJob(owner:string,chatId:string,input:any,delegation?:{originChatId:string;maxCostUsd:number}) {
  const chat=get<Chat>("chat",owner,chatId);
  const requestId=text(input.requestId,"Request ID",100),prompt=text(input.message,"Message",50000);
  const model=text(input.model === undefined ? chat.model || "auto" : input.model,"Model",150);
  const fingerprint=createHash("sha256").update(JSON.stringify([chatId,prompt,model,input.actorId||owner,delegation||null])).digest("hex");
  const job=workDb().transaction(()=>{
    const existing=list<WorkJob>("job",owner).find(j=>j.requestId===requestId);
    if(existing){if(existing.fingerprint!==fingerprint)throw new Error("Request ID already belongs to different input");return existing;}
    if(chatJob(owner,chatId)||workDb().prepare("SELECT 1 FROM locks WHERE owner=? AND chat=?").get(owner,chatId))throw new Error("This chat already has a run in progress");
    const now=new Date().toISOString();
    return put<WorkJob>("job",owner,{id:randomUUID(),chatId,requestId,fingerprint,prompt,model,actorId:input.actorId||owner,...delegation,status:"queued",createdAt:now,updatedAt:now,events:[]});
  }).immediate();
  if(process.env.TENANT_OWNER_ID===owner || process.env.ACCOUNT_ISOLATION!=="true")setImmediate(()=>void executeJob(owner,job.id).catch(()=>{}));return publicJob(job);
}
export function cancelJob(owner:string,id:string) {
  const job=get<WorkJob>("job",owner,id);get<Chat>("chat",owner,job.chatId);
  if(!activeJob(job))return publicJob(job);
  job.status=job.status==="queued"?"cancelled":"cancelling";job.updatedAt=new Date().toISOString();put("job",owner,job);
  controllers.get(key(owner,id))?.abort();return publicJob(job);
}
export async function executeJob(owner:string,id:string,executor=runChat) {
  if(process.env.TENANT_OWNER_ID && process.env.TENANT_OWNER_ID!==owner)return;
  if(controllers.size>=2)return;
  let job=get<WorkJob>("job",owner,id);
  if(job.status!=="queued")return;
  if(workDb().prepare("SELECT 1 FROM locks WHERE owner=? AND chat=?").get(owner,job.chatId))return;
  job=workDb().transaction(()=>{const current=get<WorkJob>("job",owner,id);if(current.status!=="queued")return null;return put("job",owner,{...current,status:"running" as const,updatedAt:new Date().toISOString()});}).immediate();
  if(!job)return;
  const controller=new AbortController();controllers.set(key(owner,id),controller);
  const timer=setTimeout(()=>controller.abort(),15*60_000);timer.unref();
  const approvals:unknown[]=[],schedules:unknown[]=[];
  try {
    const result=await executor(owner,get<Chat>("chat",owner,job.chatId),job.prompt,{actorId:job.actorId||owner,modelOverride:job.model,maxCostUsd:job.maxCostUsd,workDelegated:!!job.originChatId,signal:controller.signal,onEvent:e=>{
      // Persist progress without tool arguments, passwords or raw response data.
      if(e.type==="approval"){approvals.push(e.approval);return;}
      if(e.type==="schedule"){schedules.push(e.schedule);return;}
      if(e.type!=="tool")return;
      const current=get<WorkJob>("job",owner,id);
      current.events.push({seq:(current.events.at(-1)?.seq||0)+1,type:e.type,name:e.name,status:e.status,at:new Date().toISOString()});
      current.events=current.events.slice(-200);current.updatedAt=new Date().toISOString();put("job",owner,current);
    }});
    job=get<WorkJob>("job",owner,id);
    const attention=result.toolFailed||!!result.modelError||!!result.budgetRefused||("needsVerification" in result&&result.needsVerification);
    job.status=controller.signal.aborted?"needs_attention":result.modelError||result.budgetRefused?"failed":attention?"needs_attention":"completed";
    job.result={text:result.speech,conversationId:job.chatId,verification:result.verification,contextPlan:result.contextPlan,memoryContext:(result as any).memoryContext,needsAttention:attention||controller.signal.aborted,approvals,schedules,
      usage:{model:result.modelUsed||result.model,costUsd:result.costUsd||0,promptTokens:result.promptTokens||0,completionTokens:result.completionTokens||0,cachedTokens:result.cachedTokens||0}};
  } catch {
    job=get<WorkJob>("job",owner,id);job.status="needs_attention";
    job.result={text:controller.signal.aborted?"Stopped. Inspect any action already in progress before retrying.":"The task was interrupted. Review saved chat and verification checkpoints before retrying; no automatic replay was performed.",needsAttention:true};
  } finally {
    clearTimeout(timer);controllers.delete(key(owner,id));job.updatedAt=new Date().toISOString();put("job",owner,job);
  }
}
export function recoverJobs() {
  for(const owner of owners("job"))for(const job of list<WorkJob>("job",owner)) {
    if(process.env.TENANT_OWNER_ID && process.env.TENANT_OWNER_ID!==owner)continue;
    if(["running","cancelling"].includes(job.status))put("job",owner,{...job,status:"needs_attention",updatedAt:new Date().toISOString(),result:{text:"Server restarted during this task. Inspect completed actions before retrying. The task was not replayed.",needsAttention:true}});
  }
}
let started=false;
export function startJobWorker() {
  if(started)return;started=true;recoverJobs();
  const pump=()=>{for(const owner of owners("job"))for(const job of list<WorkJob>("job",owner))if(job.status==="queued")void executeJob(owner,job.id).catch(()=>{});};
  pump();const timer=setInterval(pump,2000);timer.unref();
}
