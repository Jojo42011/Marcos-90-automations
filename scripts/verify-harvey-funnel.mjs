import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'harvey-funnel-'));
for(const k of Object.keys(process.env))if(/API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|DATABASE_URL|DB_JSON_PATH|COMPOSIO|TENANT_OWNER_ID/.test(k))delete process.env[k];
Object.assign(process.env,{TENANT_DATA_ROOT:root,DB_JSON_PATH:join(root,'db.json'),HARVEY_WORK_DIR:join(root,'work'),DOTENV_CONFIG_PATH:join(root,'no-env'),HARVEY_WORKER_ENABLED:'false',HARVEY_BROWSER_ENABLED:'false'});
global.fetch=async()=>{throw Error('Network forbidden in funnel fixture');};
const leads=[
  {id:'requested',state:'phone_requested',phone:''},
  {id:'captured',state:'new',phone:'2105550101'},
  {id:'imported',state:'criteria_collected',phone:'2105550102'},
  {id:'no-phone',state:'property_sent',phone:'   '},
].map(l=>({...l,platform:'tiktok',userId:l.id,createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'}));
writeFileSync(process.env.DB_JSON_PATH,JSON.stringify({idCounter:4,leadsById:Object.fromEntries(leads.map(l=>[l.id,l])),leadKeyToId:{},conversationsByLeadId:Object.fromEntries(['requested','captured','no-phone'].map(id=>[id,{messages:[{role:'user',text:'Hello',at:'2026-11-01T00:00:00Z'}]}])),commandTasks:[]}));
const {executeHarveyTool}=await import('../dist/src/harvey/tools.js');
const funnel=await executeHarveyTool('get_funnel_stats',{});
assert.equal(funnel.phoneCaptureNumerator,1);
assert.equal(funnel.phoneCaptureDenominator,3);
assert.equal(funnel.phoneCaptureRatePct,33);
assert.equal(funnel.countByStage.phone_requested,1);
assert.equal(funnel.totalLeads,4);
const summary=await executeHarveyTool('get_lead_summary',{});
assert.equal(summary.phonesCaptured,2);
assert.match(summary.definitions.phonesCaptured,/includes imports/);
const db=await import('../dist/src/core/db.js');
db.resetMemoryStore();
const empty=await executeHarveyTool('get_funnel_stats',{});
assert.equal(empty.phoneCaptureRatePct,null);
assert.equal(empty.phoneCaptureDenominator,0);
console.log('Harvey funnel: stage labels, DM denominator, imported phones and empty data verified.');
