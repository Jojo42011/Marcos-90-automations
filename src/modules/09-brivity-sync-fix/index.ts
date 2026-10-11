import {listAllLeads,upsertLeadQuiet} from "../../core/db.js";
import {syncLead} from "../../integrations/brivity.js";
/** Repair cold-call contacts using the existing phone lookup, without replaying lead automations. */
export async function run(): Promise<{synced:number; failed:number; skipped:number; configured:boolean}> {
  const result={synced:0,failed:0,skipped:0,configured:Boolean(process.env.BRIVITY_API_KEY)};
  if(!result.configured)return result;
  for(const lead of await listAllLeads()) {
    if(lead.brivityId || !/mojo|cold.?call/i.test(`${lead.platform} ${lead.source}`))continue;
    if(!lead.phone){result.skipped++;continue;}
    const response=await syncLead(lead) as any;
    const id=response?.id || response?.contact?.id || response?.data?.id;
    if(!id){result.failed++;continue;}
    upsertLeadQuiet({...lead,brivityId:String(id)});result.synced++;
  }
  return result;
}
