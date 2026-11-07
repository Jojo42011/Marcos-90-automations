/**
 * CRM Overview: Views→Close / Call→Close aggregation.
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
        crmStage: "new",
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
    },
    leadKeyToId: {},
    conversationsByLeadId: {},
    commandTasks: [],
  }),
);

const { createTrackerRecord, listTrackerRecords } = await import("../dist/src/core/trackerStore.js");
const { agentKey, buildPipelineOverview, parseAgentFilter } = await import(
  "../dist/src/core/pipelineOverview.js"
);

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

check("agentKey maps Marco / Wesley / Carlos", () => {
  assert.equal(agentKey("Marco Puga"), "marco");
  assert.equal(agentKey("wesley"), "wesley");
  assert.equal(agentKey("Wes"), "wesley");
  assert.equal(agentKey("Carlos"), "carlos");
  assert.equal(agentKey(""), "");
});

check("parseAgentFilter empty = all", () => {
  assert.deepEqual(parseAgentFilter(""), []);
  assert.deepEqual(parseAgentFilter("all"), []);
  assert.deepEqual(parseAgentFilter("Marco Puga,Wesley"), ["Marco Puga", "Wesley"]);
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
check("overview all: buyer funnel has Buyers + Showing", () => {
  assert.equal(all.ok, true);
  const buyers = all.buyers.steps.find((s) => s.key === "buyers");
  const showing = all.buyers.steps.find((s) => s.key === "showing");
  const contacted = all.buyers.steps.find((s) => s.key === "contacted");
  assert.equal(buyers.count, 2);
  assert.ok(contacted.count >= 2);
  assert.ok(showing.count >= 1);
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
check("Marco filter excludes Wesley seller + unassigned", () => {
  assert.equal(marco.buyers.inPipeline, 1);
  assert.equal(marco.sellers.inPipeline, 0);
  const calls = marco.sellers.steps.find((s) => s.key === "calls");
  assert.equal(calls.count, 1);
});

const wes = await buildPipelineOverview({ agent: "Wesley" });
check("Wesley filter keeps his seller + calls", () => {
  assert.equal(wes.sellers.inPipeline, 1);
  assert.equal(wes.buyers.inPipeline, 0);
  const calls = wes.sellers.steps.find((s) => s.key === "calls");
  assert.equal(calls.count, 2);
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
  assert(/Views → Close/.test(tools) || /Views→Close/.test(tools));
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
