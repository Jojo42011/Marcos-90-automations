/**
 * Harvey execution-job pins: Command Center vs browser vs Composio routing,
 * false-denial recovery, and the "new UI surface ⇒ Harvey route" contract.
 * Run after `npm run build`: node scripts/verify-harvey-jobs.mjs
 */
import { readFileSync } from "fs";
import assert from "assert";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err.message}`);
  }
}

const caps = await import("../dist/src/harvey/work/capabilities.js");
const tools = await import("../dist/src/harvey/tools.js");
const fp = await import("../dist/src/hull/founderPrompt.js");

check("EXECUTION_LANES: three lanes, Command Center first", () => {
  assert(/COMMAND CENTER/.test(caps.EXECUTION_LANES));
  assert(/BROWSER/.test(caps.EXECUTION_LANES));
  assert(/COMPOSIO/.test(caps.EXECUTION_LANES));
  assert(/missing plugin is never a missing Command Center capability/i.test(caps.EXECUTION_LANES));
  // Keep it compact — token budget for Work context.
  assert(caps.EXECUTION_LANES.length < 1200, `EXECUTION_LANES too long (${caps.EXECUTION_LANES.length})`);
});

check("OPERATIONAL and Work share EXECUTION_LANES (no duplicate encyclopedia)", () => {
  assert(fp.OPERATIONAL_PROMPT.includes(caps.EXECUTION_LANES));
  assert(/EXECUTION_LANES/.test(read("src/harvey/work/runtime.ts")));
  assert(/EXECUTION_LANES/.test(read("src/hull/founderPrompt.ts")));
});

check("capability map: Command Center social route + lane tags", () => {
  const map = caps.capabilityMap({
    local: false,
    browser: true,
    managed: true,
    apps: [],
    custom: [],
    tools: ["computer", "business_tools", "COMPOSIO_SEARCH_TOOLS", "work_records"],
  });
  assert.equal(map.lanes, "command_center|browser|composio");
  const social = map.routes.find((r) => /TikTok/.test(r.goal));
  assert(social?.available === true);
  assert.equal(social.lane, "command_center");
  const composio = map.routes.find((r) => /Google Sheets/.test(r.goal));
  assert.equal(composio.lane, "composio");
  assert(/Do not use this lane for Command Center/.test(composio.next));
});

check("false-denial detector: TikTok/Composio/Command Center claims", () => {
  assert(caps.unsupportedCapabilityClaim("I can't scroll the virtualized table"));
  assert(caps.unsupportedCapabilityClaim("I cannot access TikTok analytics without a developer app"));
  assert(caps.unsupportedCapabilityClaim("TikTok DMs are not available through plugins"));
  assert(caps.unsupportedCapabilityClaim("We don't have a TikTok integration via Composio"));
  assert(caps.unsupportedCapabilityClaim("Social analytics unavailable — no Composio TikTok connection"));
  assert(!caps.unsupportedCapabilityClaim("TikTok followers are 12,400 per get_social_summary"));
  assert(!caps.unsupportedCapabilityClaim("Waiting on CAPTCHA before continuing"));
});

check("business tools include Command Center social jobs", () => {
  const names = new Set((tools.HARVEY_TOOL_DEFINITIONS || []).map((t) => t.name));
  for (const n of ["get_social_summary", "get_social_videos", "get_social_analytics", "get_smartposter", "crm_api", "crm_api_index", "get_quo_lines", "search_tracker", "get_pipeline_overview"]) {
    assert(names.has(n), `missing tool for business_call: ${n}`);
  }
  assert(/unstagedOnly/.test(read("src/harvey/platformTools.ts")), "search_tracker must expose unstagedOnly");
  assert(/\/api\/quo\//.test(read("src/core/crmApiSurface.ts")), "crm_api must allow Quo read paths");
});

check("CRM Overview funnel ships with Harvey get_pipeline_overview", () => {
  const names = new Set((tools.HARVEY_TOOL_DEFINITIONS || []).map((t) => t.name));
  assert(names.has("get_pipeline_overview"), "missing get_pipeline_overview");
  assert(/\/api\/crm\/pipeline-overview/.test(read("src/server.ts")));
  const crm = read("public/crm-brivity.html");
  assert(/pipeOverview/.test(crm) && /renderPipelineOverview/.test(crm));
});

check("SmartPoster surface ships with Harvey get_smartposter", () => {
  const names = new Set((tools.HARVEY_TOOL_DEFINITIONS || []).map((t) => t.name));
  assert(names.has("get_smartposter"), "missing get_smartposter");
  assert(/registerSmartPosterRoutes/.test(read("src/server.ts")));
  assert(/key:\s*"smartposter"/.test(read("public/shell.html")));
  assert(/SmartPoster/.test(read("public/smartposter.html")));
});

check("FORAI pins route-with-feature convention", () => {
  const forai = read("FORAI.md");
  assert(/new Command Center surface|Harvey route|EXECUTION_LANES|Command Center \/ Zernio/i.test(forai));
});

check("Dialer ships its shared API and Harvey guide",()=>{
  assert(read("src/core/crmApiSurface.ts").includes('"/api/dialer/"'));
  assert(read("src/harvey/platformTools.ts").includes('/api/dialer/guide'));
  assert(read("src/server.ts").includes('registerDialer(app'));
  assert(read("public/shell.html").includes('key:"dialer"'));
});
check("Contact briefs ship evidence access for Harvey",()=>{
 assert(read("src/harvey/platformTools.ts").includes('/api/crm/lead/:id/brief'));
 assert(read("src/server.ts").includes('app.get("/api/crm/lead/:id/brief"'));
 assert(read("src/server.ts").includes('app.post("/api/crm/lead/:id/brief"'));
});
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error("FAIL:", f);
  process.exit(1);
}
