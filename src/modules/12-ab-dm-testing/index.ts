import {listAllLeads,getConversation} from "../../core/db.js";
import {atomicJson} from "../../core/atomicJson.js";
import {dataPath} from "../../core/tenantData.js";
/** Evaluate explicitly attributed variants only. Never invent attribution or change live DM wording. */
export async function evaluateVariants() {
  const groups:Record<string,{leads:number; captured:number; messagesToPhone:number}>=Object.create(null);
  for(const lead of await listAllLeads()) {
    const variant=(lead as any).dmVariant;
    if(typeof variant!=="string" || !variant.trim())continue;
    const row=groups[variant] ||= {leads:0,captured:0,messagesToPhone:0};row.leads++;
    if(!lead.phone || !lead.phoneCapturedAt)continue;
    const conversation=await getConversation(lead.id);
    row.captured++;row.messagesToPhone+=conversation.messages.filter(m=>m.role==="user" && m.at<=lead.phoneCapturedAt!).length;
  }
  const variants=Object.entries(groups).map(([variant,g])=>({variant,...g,captureRate:g.captured/g.leads,averageMessagesToPhone:g.captured?g.messagesToPhone/g.captured:null}));
  const result={at:new Date().toISOString(),variants,winner:null,note:"Descriptive results only. A randomized assignment policy and minimum sample size must be agreed before declaring a winner."};
  atomicJson(dataPath("dm-variant-results.json"),result);return result;
}
