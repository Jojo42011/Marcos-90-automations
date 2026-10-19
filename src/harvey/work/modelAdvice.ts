import {recoveryReviewPolicy} from './execution.js';
import {availableModels,pricingStatus,refreshCatalog} from "../../hull/providers/catalog.js";
import {routingTable} from "../../hull/providers/routing.js";
import {getAiUsageDb} from "../../core/aiUsageStore.js";
import {Chat,list} from "./store.js";

export async function modelAdvice(owner:string,selected="auto",requested?:string[]) {
  await refreshCatalog();
  const sessions=list<Chat>("chat",owner).slice(0,200).map(c=>c.sessionId).filter(Boolean);
  let timing:any[]=[];
  try{if(sessions.length)timing=getAiUsageDb().prepare(`SELECT COALESCE(model_used,model) model,COUNT(*) samples,AVG(latency_ms)/1000 seconds FROM ai_requests WHERE ok=1 AND latency_ms>0 AND ts>=? AND session_id IN (${sessions.map(()=>'?').join(',')}) GROUP BY COALESCE(model_used,model)`).all(new Date(Date.now()-7*86400000).toISOString(),...sessions);}catch{/* Missing observations are unknown, not instant responses. */}
  const models=availableModels().filter(m=>m.available&&(!requested?.length||requested.some(q=>[m.id,m.label].some(v=>String(v||'').toLowerCase().includes(q.toLowerCase()))))).map(m=>{
    const observed=timing.find(t=>t.model===m.id);
    return {...m,pricing:pricingStatus(m.id),exampleCostUsd:Number(((m.inputPerM*10000+m.outputPerM*2000)/1e6).toFixed(6)),
      recentSpeed:observed&&observed.samples>=3?{samples:observed.samples,averageResponseSeconds:Math.round(observed.seconds*10)/10,windowDays:7}:null,
      fit:m.tier==="cheap"?"Lower-cost candidate for straightforward extraction, summaries and routine checks; verify it on a sample.":m.tier==="premium"?"Consider for difficult reasoning after a simpler option falls short; usually unnecessary for copying rows or routine counts.":"Candidate for multi-step work and resolving ambiguous instructions; verify outputs.",
      visualUse:m.supportsVision?"Accepts images/screenshots":"Text/semantic data directly; inspect_screen supplies an auxiliary vision observation for screenshots"};
  }).sort((a,b)=>a.exampleCostUsd-b.exampleCostUsd);
  const routing=routingTable();
  return {selectedModel:selected,recoveryReview:recoveryReviewPolicy(),models,routing:requested?.length?undefined:routing,recommendations:{routine:models.find(m=>m.supportsTools)?.id||null,visual:models.find(m=>m.supportsTools&&m.supportsVision)?.id||null,multiStep:routing.agent?.model||null},
    example:{inputTokens:10000,outputTokens:2000,unit:"USD per model response, not per finished task",note:"Illustrative uncached text estimate. Repeated tool steps, growing history, images and retries change total cost; provider billing is authoritative."},
    guidance:["A stalled interactive task may use a read-only recovery consultation with the reported recovery model, inside the task budget and its $0.05 consultation ceiling. Its usage is included; the main model stays selected.","Start with Auto if unsure. It follows the configured routing table and can use a vision model after a screenshot; it is not guaranteed to choose the cheapest model.","A manually selected model stays selected; Harvey must explain a capability mismatch instead of quietly changing it.","Cost tier is not a speed benchmark. Recent speed uses this account's successful chat calls over seven days, with at least three samples. Task size differs, so these are observations, not controlled rankings or promises.","There is no measured quality leaderboard here. Recommend a model for the task and explain the evidence; do not call one universally best.","Routine record counts generally do not justify a premium model. Better pagination or an export often matters more than a more expensive model.","Provider credit errors, the shared $150 monthly OpenRouter allowance and browser/tool errors are different. Interactive tasks have no tool-round, duration or continuation-count cap. Check the actual recorded error before explaining a failure.","An unread profile field is unknown, not zero or absent. Model selection cannot turn incomplete source data into verified facts."],
    source:"https://openrouter.ai/api/v1/models",note:"Configured provider access does not prove a model is currently healthy. Static or stale prices must be described as estimates. Advice does not change models or budgets."};
}
