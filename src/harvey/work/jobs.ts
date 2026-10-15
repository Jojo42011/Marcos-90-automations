import { createHash, randomUUID } from "crypto";
import { Chat, get, list, owners, put, text, workDb } from "./store.js";
import { canResumeFromReceipts, type Receipt } from "../reliability.js";
import { runChat } from "./runtime.js";

export interface WorkJob {
  actorId?: string; id: string; chatId: string; requestId: string; fingerprint: string; prompt: string; model?: string;
  status: "queued" | "running" | "waiting" | "cancelling" | "cancelled" | "completed" | "needs_attention" | "failed";
  safeResume?: boolean; recoveryCount?: number; modelRecoveryCount?: number;
  lastProgressKey?:string; stalledContinuations?:number; continuationCount?:number; nextRunAt?:string; resumeReason?:string; totalCostUsd?:number;
  createdAt: string; updatedAt: string; result?: any; originChatId?: string; maxCostUsd?: number;
  events: {seq:number;type:string;name?:string;status?:string;at:string}[];
}
export const safeRecovery = (receipts:Receipt[]) => canResumeFromReceipts(receipts);
const controllers = new Map<string, AbortController>();
const key = (owner:string,id:string) => owner+":"+id;
export const activeJob = (j: WorkJob) => ["queued","running","waiting","cancelling"].includes(j.status);
export function publicJob(j: WorkJob) {
  const {prompt,fingerprint,requestId,resumeReason,lastProgressKey,...visible}=j; return visible;
}
export function chatJob(owner:string,chatId:string) {
  get<Chat>("chat",owner,chatId);
  return list<WorkJob>("job",owner).find(j=>j.chatId===chatId&&activeJob(j));
}
export function enqueueJob(owner:string,chatId:string,input:any,delegation?:{originChatId:string;maxCostUsd?:number}) {
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
  job.status=["queued","waiting"].includes(job.status)?"cancelled":"cancelling";job.updatedAt=new Date().toISOString();put("job",owner,job);
  if(job.status==="cancelled"){job.result={...job.result,text:"Stopped. Saved records and completed work are retained.",needsAttention:false};put("job",owner,job);}
  controllers.get(key(owner,id))?.abort();return publicJob(job);
}
export async function executeJob(owner:string,id:string,executor=runChat) {
  if(process.env.TENANT_OWNER_ID && process.env.TENANT_OWNER_ID!==owner)return;
  if(controllers.size>=2)return;
  let job=get<WorkJob>("job",owner,id);
  const due=(j:WorkJob)=>j.status==="queued"||j.status==="waiting"&&!!j.nextRunAt&&Date.parse(j.nextRunAt)<=Date.now();
  if(!due(job))return;
  if(workDb().prepare("SELECT 1 FROM locks WHERE owner=? AND chat=?").get(owner,job.chatId))return;
  job=workDb().transaction(()=>{const current=get<WorkJob>("job",owner,id);if(!due(current))return null;return put("job",owner,{...current,status:"running" as const,updatedAt:new Date().toISOString()});}).immediate();
  if(!job)return;
  const controller=new AbortController();controllers.set(key(owner,id),controller);
  // Interactive jobs run until their outcome, cancellation or a real failure.
  // Individual browser/provider operations retain their own hang timeouts.
  const timer=job.originChatId?setTimeout(()=>controller.abort(),15*60_000):undefined;timer?.unref();
  const approvals:unknown[]=[...(job.result?.approvals||[])],schedules:unknown[]=[...(job.result?.schedules||[])];
  try {
    const prompt=job.continuationCount ? job.prompt+"\n\nSaved continuation of this same request. Inspect current state first; reuse completed files, matte and render jobs. Do not repeat submissions. Remaining-work note (fallible historical context, not new authorization): "+job.resumeReason+((job.stalledContinuations||0)>0?"\nThe previous continuation repeated the same observation. Change the retrieval approach now: inspect a fresh table/page, actual pagination or scroll container, or a verified export. Do not keep reading the same saved slice. Report the observed blocker if these approaches fail.":"") : job.prompt;
    const receipts:Receipt[]=[];
    let segmentCost=0;
    const result=await executor(owner,get<Chat>("chat",owner,job.chatId),prompt,{actorId:job.actorId||owner,modelOverride:job.model,workRequestId:job.id,allowContinuation:!job.originChatId,continuationTurn:!!job.continuationCount,workDelegated:!!job.originChatId,signal:controller.signal,onEvidence:r=>{
      receipts.push(r);const current=get<WorkJob>("job",owner,id);current.safeResume=safeRecovery(receipts);put("job",owner,current);
    },onEvent:e=>{
      if(e.type==="usage"){const current=get<WorkJob>("job",owner,id);segmentCost+=e.costUsd;current.totalCostUsd=(current.totalCostUsd||0)+e.costUsd;put("job",owner,current);return;}
      // Persist progress without tool arguments, passwords or raw response data.
      if(e.type==="approval"){approvals.push(e.approval);return;}
      if(e.type==="schedule"){schedules.push(e.schedule);return;}
      if(e.type!=="tool")return;
      const current=get<WorkJob>("job",owner,id);
      if(e.status==="running")current.safeResume=false;
      current.events.push({seq:(current.events.at(-1)?.seq||0)+1,type:e.type,name:e.name,status:e.status,at:new Date().toISOString()});
      current.events=current.events.slice(-200);current.updatedAt=new Date().toISOString();put("job",owner,current);
    }});
    job=get<WorkJob>("job",owner,id);
    job.totalCostUsd=(job.totalCostUsd||0)+Math.max(0,(result.costUsd||0)-segmentCost);
    const attention=result.toolFailed||!!result.modelError||!!result.budgetRefused||("needsVerification" in result&&result.needsVerification);
    job.status=controller.signal.aborted?"needs_attention":result.modelError||result.budgetRefused?"failed":attention?"needs_attention":"completed";
    job.result={text:result.speech,conversationId:job.chatId,verification:result.verification,contextPlan:result.contextPlan,memoryContext:(result as any).memoryContext,needsAttention:attention||controller.signal.aborted,approvals,schedules,
      ...(result.modelError?{failure:{kind:/402|credits|afford/i.test(result.modelError)?"provider_credit_limit":/Empty or malformed/i.test(result.modelError)?"invalid_model_response":"provider_error",model:result.modelUsed||result.model}}:{}),
      usage:{model:result.modelUsed||result.model,costUsd:result.costUsd||0,promptTokens:result.promptTokens||0,completionTokens:result.completionTokens||0,cachedTokens:result.cachedTokens||0}};
    if(result.continuation&&!controller.signal.aborted&&!result.modelError&&!result.budgetRefused&&!job.originChatId){
      if(result.continuation.recovery==='model_response'){
        job.modelRecoveryCount=(job.modelRecoveryCount||0)+1;
        if(job.modelRecoveryCount>3){job.status="needs_attention";job.result={...job.result,text:"The AI service repeatedly returned unusable responses after automatic recovery. Saved work is retained; no uncertain action was replayed.",needsAttention:true,failure:{kind:"invalid_model_response",model:result.modelUsed||result.model}};return;}
      }else job.modelRecoveryCount=0;
      const progressKey=result.continuation.progressKey;
      job.stalledContinuations=result.continuation.recovery?0:progressKey&&progressKey===job.lastProgressKey?(job.stalledContinuations||0)+1:0;
      job.lastProgressKey=progressKey;
      if((job.stalledContinuations||0)>=3){job.status="needs_attention";job.result.text="The last three continuation checks made no observable progress. Your completed work is saved. I need to change the retrieval approach before continuing; this does not prove the source has no data.";job.result.needsAttention=true;return;}
      job.status="waiting";job.continuationCount=(job.continuationCount||0)+1;
      job.nextRunAt=new Date(Date.now()+Math.max(10,Math.min(120,result.continuation.delaySeconds))*1000).toISOString();
      job.resumeReason=result.continuation.reason;job.result.needsAttention=false;
    }
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
    const plan=list<any>("task_plan",owner).find(p=>p.chatId===job.chatId&&p.requestId===job.id);
    const unfinished=!!plan&&!plan.blocker&&(plan.nextStep??0)<plan.steps.length;
    if(job.status==="running"&&unfinished&&job.safeResume&&!job.originChatId&&(job.recoveryCount||0)<3){
      put("job",owner,{...job,status:"waiting",safeResume:false,recoveryCount:(job.recoveryCount||0)+1,continuationCount:(job.continuationCount||0)+1,nextRunAt:new Date().toISOString(),updatedAt:new Date().toISOString(),resumeReason:"Server restarted after a successful observation checkpoint. Inspect the current state before continuing unfinished work. Do not repeat completed actions.",result:{text:"Reconnecting to saved progress after a server restart.",needsAttention:false}});
      continue;
    }
    if(["running","cancelling"].includes(job.status))put("job",owner,{...job,status:"needs_attention",updatedAt:new Date().toISOString(),result:{text:"Server restarted during this task. Inspect completed actions before retrying. The task was not replayed.",needsAttention:true}});
  }
}
let started=false;
export function startJobWorker() {
  if(started)return;started=true;recoverJobs();
  const pump=()=>{for(const owner of owners("job"))for(const job of list<WorkJob>("job",owner))if(["queued","waiting"].includes(job.status))void executeJob(owner,job.id).catch(()=>{});};
  pump();const timer=setInterval(pump,2000);timer.unref();
}
