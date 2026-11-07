/**
 * CRM Overview: buyer Views→Close (no Call) / seller Call→Close.
 * Run after `npm run build`: node scripts/verify-pipeline-overview.mjs
 */
import assert from "assert";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pipe-ov-"));
process.env.TRACKER_DB_PATH = join(tmp, "tracker.db");
process.env.DB_JSON_PATH = join(tmp, "db.json");
writeFileSync(
  join(tmp, "db.json"),
  JSON.stringify({
    idCounter: 3,
    leadsById: {
      lead_1: {
        id: "lead_1",
        platform: "tiktok",
        userId: "u1",
        username: "u1",
        name: "Buyer One",
        phone: "2105550101",
        state: "new",
        source: "TikTok",
        crmStatus: "new",
        crmStage: "appointment_set",
        crmIntent: "buyer",
        assignedUserName: "Marco Puga",
        activity: [{ type: "call", at: "2026-11-01T12:00:00.000Z" }],
        createdAt: "2026-11-01T12:00:00.000Z",
        updatedAt: "2026-11-01T12:00:00.000Z",
      },
      lead_2: {
        id: "lead_2",
        platform: "tiktok",
        userId: "u2",
        username: "u2",
        name: "Seller Two",
        phone: "2105550102",
        state: "new",
        source: "Mojo",
        crmStatus: "new",
        crmStage: "new",
        crmIntent: "seller",
        assignedUserName: "Wesley",
        activity: [
          { type: "call", at: "2026-11-02T12:00:00.000Z" },
          { type: "call", at: "2026-11-03T12:00:00.000Z" },
        ],
        createdAt: "2026-11-01T12:00:00.000Z",
        updatedAt: "2026-11-01T12:00:00.000Z",
      },
      lead_3: {
        id: "lead_3",
        platform: "instagram",
        userId: "u3",
        username: "u3",
        name: "DM Buyer",
        phone: null,
        state: "new",
        source: "Instagram",
        crmStatus: "new",
        crmStage: "new_lead",
        crmIntent: "buyer",
        assignedUserName: "Marco Puga",
        activity: [],
        createdAt: "2026-11-01T12:00:00.000Z",
        updatedAt: "2026-11-01T12:00:00.000Z",
      },
    },
    leadKeyToId: {},
    conversationsByLeadId: {
      lead_1: {
        messages: [
          { role: "user", text: "hi", at: "2026-11-01T10:00:00.000Z" },
          { role: "assistant", text: "hey", at: "2026-11-01T10:01:00.000Z" },
        ],
      },
      lead_3: {
        messages: [{ role: "user", text: "interested", at: "2026-11-01T11:00:00.000Z" }],
      },
    },
    commandTasks: [],
  }),
);

const { createTrackerRecord, listTrackerRecords } = await import("../dist/src/core/trackerStore.js");
const {
  agentKey,
  buildPipelineOverview,
  parseAgentFilter,
  buyerCrmRank,
  socialAllowedForAgentFilter,
  matchesAgentFilter,
  AGENT_FILTER_NONE,
} = await import("../dist/src/core/pipelineOverview.js");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok " + name);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.error("FAIL " + name + " — " + err.message);
  }
}

check("agentKey maps Marco / Wesley", () => {
  assert.equal(agentKey("Marco Puga"), "marco");
  assert.equal(agentKey("wesley"), "wesley");
  assert.equal(agentKey("Wes"), "wesley");
  assert.equal(agentKey("Carlos"), "carlos");
  assert.equal(agentKey(""), "");
});

check("parseAgentFilter empty = all; __none__; strips Carlos", () => {
  assert.deepEqual(parseAgentFilter(""), []);
  assert.deepEqual(parseAgentFilter("all"), []);
  assert.deepEqual(parseAgentFilter("Marco Puga,Wesley"), ["Marco Puga", "Wesley"]);
  assert.deepEqual(parseAgentFilter(AGENT_FILTER_NONE), [AGENT_FILTER_NONE]);
  assert.deepEqual(parseAgentFilter("Marco Puga,Carlos"), ["Marco Puga"]);
});

check("socialAllowedForAgentFilter: All/Marco yes, Wesley/none no", () => {
  assert.equal(socialAllowedForAgentFilter([]), true);
  assert.equal(socialAllowedForAgentFilter(["Marco Puga"]), true);
  assert.equal(socialAllowedForAgentFilter(["Wesley"]), false);
  assert.equal(socialAllowedForAgentFilter([AGENT_FILTER_NONE]), false);
});

check("matchesAgentFilter __none__ matches nobody", () => {
  assert.equal(matchesAgentFilter("Marco Puga", [AGENT_FILTER_NONE]), false);
  assert.equal(matchesAgentFilter("Wesley", [AGENT_FILTER_NONE]), false);
  assert.equal(matchesAgentFilter("Marco Puga", ["Wesley"]), false);
  assert.equal(matchesAgentFilter("Wesley", ["Wesley"]), true);
});

check("buyerCrmRank ladder", () => {
  assert.equal(buyerCrmRank("appointment_set"), 0);
  assert.equal(buyerCrmRank("met_with_customer"), 1);
  assert.equal(buyerCrmRank("showing_homes"), 2);
  assert.equal(buyerCrmRank("under_contract"), 4);
  assert.equal(buyerCrmRank("sale_closed"), 5);
  assert.equal(buyerCrmRank("closed"), 5); // legacy map
  assert.equal(buyerCrmRank("new_lead"), -1);
});

createTrackerRecord({
  name: "Marco Buyer",
  sides: ["buyer"],
  assignedTo: "Marco Puga",
  buyerStage: "actively_showing",
  leadId: "lead_1",
});
createTrackerRecord({
  name: "Wesley Seller",
  sides: ["seller"],
  assignedTo: "Wesley",
  sellerStage: "listing_appointment_set",
  leadId: "lead_2",
});
createTrackerRecord({
  name: "Unassigned Buyer",
  sides: ["buyer"],
  buyerStage: "contacted",
});

check("seeded tracker rows exist", () => {
  assert.equal(listTrackerRecords({}).length, 3);
});

const all = await buildPipelineOverview({});
check("buyer funnel shape: no Call, has DMs/Number/Appt set", () => {
  assert.equal(all.ok, true);
  const keys = all.buyers.steps.map((s) => s.key);
  assert.ok(!keys.includes("calls"), "buyer must not include Call");
  assert.ok(!keys.includes("contacted"), "old Contacted bucket removed");
  assert.ok(keys.includes("dms"));
  assert.ok(keys.includes("number"));
  assert.ok(keys.includes("appt_set"));
  assert.ok(keys.includes("appt_show"));
  assert.ok(keys.includes("showing"));
  assert.ok(keys.includes("contract"));
  assert.ok(keys.includes("closed"));
  assert.equal(all.buyers.subtitle, "Views → Close");
});

check("buyer DMs + number counts", () => {
  const dms = all.buyers.steps.find((s) => s.key === "dms");
  const number = all.buyers.steps.find((s) => s.key === "number");
  // lead_1 + lead_3 have inbound DMs; lead_2 is seller-only
  assert.equal(dms.count, 2);
  // lead_1 has phone; lead_3 does not; seller excluded
  assert.equal(number.count, 1);
});

check("buyer appt set counts appointment_set / showing tracker", () => {
  const appt = all.buyers.steps.find((s) => s.key === "appt_set");
  const showing = all.buyers.steps.find((s) => s.key === "showing");
  assert.ok(appt.count >= 1);
  assert.ok(showing.count >= 1); // lead_1 tracker actively_showing
});

check("overview all: seller funnel counts Wesley appointment", () => {
  const sellers = all.sellers.steps.find((s) => s.key === "sellers");
  const appt = all.sellers.steps.find((s) => s.key === "appointment");
  assert.equal(sellers.count, 1);
  assert.ok(appt.count >= 1);
});

check("overview all: calls include both agents' call activities", () => {
  const calls = all.sellers.steps.find((s) => s.key === "calls");
  assert.equal(calls.count, 3);
});

const marco = await buildPipelineOverview({ agent: "Marco Puga" });
check("Marco filter excludes Wesley seller + unassigned tracker", () => {
  assert.equal(marco.sellers.inPipeline, 0);
  const calls = marco.sellers.steps.find((s) => s.key === "calls");
  assert.equal(calls.count, 1);
  const dms = marco.buyers.steps.find((s) => s.key === "dms");
  assert.equal(dms.count, 2);
});

const wes = await buildPipelineOverview({ agent: "Wesley" });
check("Wesley filter keeps his seller + calls; no Marco social Views", () => {
  assert.equal(wes.sellers.inPipeline, 1);
  const calls = wes.sellers.steps.find((s) => s.key === "calls");
  assert.equal(calls.count, 2);
  const dms = wes.buyers.steps.find((s) => s.key === "dms");
  assert.equal(dms.count, 0);
  assert.equal(wes.buyers.steps.find((s) => s.key === "views"), undefined);
  assert.equal(wes.buyers.steps.find((s) => s.key === "comments"), undefined);
});

const none = await buildPipelineOverview({ agent: AGENT_FILTER_NONE });
check("empty agent pick zeros the funnel (unselect Marco must not show All)", () => {
  assert.equal(none.buyers.steps.find((s) => s.key === "dms").count, 0);
  assert.equal(none.buyers.steps.find((s) => s.key === "number").count, 0);
  assert.equal(none.sellers.steps.find((s) => s.key === "calls").count, 0);
  assert.equal(none.sellers.inPipeline, 0);
  assert.equal(none.buyers.steps.find((s) => s.key === "views"), undefined);
});

check("Overview UI: agents are Marco+Wesley only; filter uses __none__", () => {
  const crm = readFileSync(new URL("../public/crm-brivity.html", import.meta.url), "utf8");
  assert(/const TEAM=\["Marco Puga","Wesley"\]/.test(crm));
  assert(/USER_FILTER==null/.test(crm));
  assert(/__none__/.test(crm));
  assert(!/const TEAM=\["Marco Puga","Wesley","Carlos"\]/.test(crm));
});

check("Harvey tool + CRM route + Overview UI exist", () => {
  const tools = readFileSync(new URL("../src/harvey/platformTools.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const crm = readFileSync(new URL("../public/crm-brivity.html", import.meta.url), "utf8");
  assert(/get_pipeline_overview/.test(tools));
  assert(/\/api\/crm\/pipeline-overview/.test(server));
  assert(/pipeOverview/.test(crm));
  assert(/renderPipelineOverview/.test(crm));
  assert(/>Overview</.test(crm));
  assert(/Views → Close/.test(tools) || /Views→Close/.test(tools) || /Views→Comments/.test(tools));
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
