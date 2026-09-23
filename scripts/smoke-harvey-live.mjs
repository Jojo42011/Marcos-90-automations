// Explicit opt-in deployment smoke test. Never logs keys or reads business data.
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dir = mkdtempSync(join(tmpdir(), 'harvey-smoke-'));
Object.assign(process.env, {
  HARVEY_WORK_DIR: join(dir, 'work'), AI_USAGE_DB_PATH: join(dir, 'usage.db'),
  HARVEY_DAILY_CAP_USD: '0.05', HARVEY_MONTHLY_CAP_USD: '0.05',
  HARVEY_MAX_COST_PER_CALL_USD: '0.01', AETHON_MAX_TOKENS: '512',
  HARVEY_CONTEXT_CEILING_TOKENS: '8000', HARVEY_WORKER_ENABLED: 'false',
});
const timeout = setTimeout(() => { console.error('Smoke test timed out'); process.exit(1); }, 150000);
try {
  assert(process.env.OPENROUTER_API_KEY, 'OpenRouter key missing on machine');
  const catalog = await import('../dist/src/hull/providers/catalog.js');
  assert(await catalog.refreshCatalog({force:true}), 'Live pricing unavailable; refusing paid test');
  const response = await fetch('https://openrouter.ai/api/v1/models');
  assert(response.ok, 'Live model list unavailable');
  const live = new Map((await response.json()).data.map(m=>[m.id,m]));
  const models = catalog.availableModels().filter(m=>m.supportsTools && live.has(m.id) && m.inputPerM>0 && m.inputPerM<=0.5 && m.outputPerM<=1.5).sort((a,b)=>(a.inputPerM+a.outputPerM)-(b.inputPerM+b.outputPerM));
  const model=models[0]; assert(model, 'No verified cheap tool model available');
  console.log('SMOKE_MODEL '+JSON.stringify({id:model.id,inputPerM:model.inputPerM,outputPerM:model.outputPerM,context:model.contextTokens,outputLimit:512,testBudgetUsd:0.05}));
  chmodSync(dir,0o755);
  const B=await import('../dist/src/harvey/work/browser.js');
  try { const page=await B.browserCall('deployment-smoke','browser-check','browser_navigate',{url:'https://example.com'});assert(JSON.stringify(page).includes('Example Domain'),'Browser page not read');console.log('SMOKE_BROWSER_PASS'); } finally {await B.closeBrowsers();}
  const managed=await import('../dist/src/harvey/work/composio.js');
  if(managed.composioReady()) {const items=await managed.managedCatalog('deployment-smoke',null);assert(items.items.some(x=>x.slug==='gmail'));const link=await managed.connectManaged('deployment-smoke',null,'gmail');assert.equal(new URL(link.url).hostname,'connect.composio.dev');const result=await managed.executeManaged('deployment-smoke',null,'COMPOSIO_SEARCH_TOOLS',{queries:[{use_case:'read gmail inbox'}]});assert(result);console.log('SMOKE_COMPOSIO_PASS '+JSON.stringify({catalog:items.items.length,logos:items.items.filter(x=>x.logo).length,connectLink:true,toolDiscovery:true}));}
  const S=await import('../dist/src/harvey/work/store.js');
  const R=await import('../dist/src/harvey/work/runtime.js');
  const owner='deployment-smoke';const project=S.createProject(owner,{name:'Smoke test',instructions:'Use only tools explicitly requested. Do not access business data.',timezone:'America/Chicago'});
  const chat=S.createChat(owner,{projectId:project.id,mode:'chat'});
  let total=0;
  const run=async(c,p)=>{const result=await R.runChat(owner,c,p,{modelOverride:model.id,maxCostUsd:0.01,onEvent:e=>{if(e.type==='tool')console.log('SMOKE_TOOL '+JSON.stringify(e));}});total+=result.costUsd||0;console.log('SMOKE_RESULT '+JSON.stringify({mode:c.mode,text:result.speech,model:result.modelUsed,promptTokens:result.promptTokens,completionTokens:result.completionTokens,costUsd:result.costUsd,contextPlan:result.contextPlan,toolRounds:result.toolRounds}));assert(!result.modelError&&!result.budgetRefused&&!result.toolFailed,'Model or tool failure');assert.equal(result.modelUsed,model.id,'Unexpected model substitution');assert(result.promptTokens>0&&result.completionTokens>0,'Missing token accounting');assert(total<0.05,'Test budget reached');return result;};
  assert.match((await run(chat,'Reply with exactly: HARVEY_TEST_OK')).speech,/HARVEY_TEST_OK/);
  await run(chat,'Remember this test code: cedar-42. Reply briefly.');
  assert.match((await run(chat,'What test code did I just give you?')).speech,/cedar-42/i);
  process.env.AETHON_MAX_TOKENS='4096';
  const work=S.createChat(owner,{projectId:project.id,mode:'work'});
  await run(work,'Use schedule_agent to create a daily schedule at 9 am America/Chicago named Smoke test. Its task is: Reply with HARVEY_SCHEDULE_OK. Do not use any other tools.');
  const schedules=S.list('schedule',owner);assert.equal(schedules.length,1,'Schedule not created');
  const scheduled=await R.runScheduled(owner,schedules[0].id,true,new Date(),async(o,c,p,opts,id)=>{const r=await R.runChat(o,c,p,{...opts,modelOverride:model.id,maxCostUsd:0.01},id);total+=r.costUsd||0;assert(!r.modelError&&!r.budgetRefused&&!r.toolFailed,'Scheduled model or tool failure');console.log('SMOKE_SCHEDULE_USAGE '+JSON.stringify({model:r.modelUsed,promptTokens:r.promptTokens,completionTokens:r.completionTokens,costUsd:r.costUsd}));return r;});
  assert.equal(scheduled.status,'completed');assert.match(scheduled.result,/HARVEY_SCHEDULE_OK/);
  try { assert.match((await run(work,'Use computer with action call, tool browser_navigate and arguments url https://example.com. Read the page and tell me its heading. Do not use business tools.')).speech,/Example Domain/i); } finally {await B.closeBrowsers();}
  console.log('SMOKE_SETUP '+JSON.stringify({vault:S.vaultReady(),workerInApp:process.env.HARVEY_WORKER_ENABLED==='true',oauth:(await import('../dist/src/harvey/work/connectors.js')).catalog().map(c=>({id:c.id,ready:c.ready}))}));
  console.log('SMOKE_PASS '+JSON.stringify({chat:true,memory:true,workTools:true,scheduleExecution:true,totalCostUsd:total,browserEnabledInApp:process.env.HARVEY_BROWSER_ENABLED==='true',externalAccounts:'not tested'}));
} catch(e) { console.error('SMOKE_FAIL '+e.message);process.exitCode=1; } finally {clearTimeout(timeout);}
