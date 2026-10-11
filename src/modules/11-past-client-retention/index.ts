import {runPastClientQuarterlyTouch} from "../../agents/emailMarketing/pastClientQuarterly.js";
import {getCommandTasks,createCommandTask,listAllLeads} from "../../core/db.js";
import {tenantOwner} from "../../core/tenantData.js";
/** Review tasks are deduplicated by period. No unconfigured gift purchase or duplicate email campaign. */
function reviewTask(key:string,title:string,description:string):boolean {
  key=`${tenantOwner()||"root"}:${key}`;
  if(getCommandTasks().some(task=>task.tags?.includes(key)))return false;
  createCommandTask({title,description,column:"this_week",color:"blue",status:"pending",createdBy:tenantOwner()||"automation",assignedTo:process.env.TENANT_MEMBER||"marco",tags:[key]});
  return true;
}
export async function runWeeklyUpdates():Promise<{created:number}> {
  const now=new Date();now.setUTCHours(0,0,0,0);now.setUTCDate(now.getUTCDate()-((now.getUTCDay()+6)%7));
  const period=now.toISOString().slice(0,10);let created=0;
  for(const lead of await listAllLeads())if(lead.isPastClient && !["trashed","archived","dead"].includes(lead.crmStatus)) {
    if(reviewTask(`retention-week:${lead.id}:${period}`,`Review weekly update for ${lead.name||"past client"}`,`Review contact ${lead.id} and current market information before sending a personal update.`))created++;
  }
  return {created};
}
export async function runQuarterlyGiftAndReferral():Promise<{sent:number; giftReviews:number}> {
  const result=await runPastClientQuarterlyTouch();const now=new Date();const period=`${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth()/3)+1}`;let giftReviews=0;
  for(const lead of await listAllLeads())if(lead.isPastClient && !["trashed","archived","dead"].includes(lead.crmStatus)) {
    if(reviewTask(`retention-gift:${lead.id}:${period}`,`Review gift and referral follow-up for ${lead.name||"past client"}`,`Confirm contact ${lead.id}, delivery address, gift choice and budget before placing an order. No purchase has been made.`))giftReviews++;
  }
  return {...result,giftReviews};
}
