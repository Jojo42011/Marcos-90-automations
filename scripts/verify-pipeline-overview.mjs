/**
 * CRM Overview: buyer Views→Close (no Call) / seller Dialer talk time→Sold.
 * Run after `npm run build`: node scripts/verify-pipeline-overview.mjs
 */
import assert from "assert";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pipe-ov-"));
process.env.TRACKER_DB_PATH = join(tmp, "tracker.db");
process.env.DB_JSON_PATH = join(tmp, "db.json");
process.env.SHARED_DIALER_DB_PATH = join(tmp, "shared-dialer.db");
writeFileSync(
  join(tmp, "users.json"),
  JSON.stringify([
    { id: "u_marco", name: "Marco Puga", email: "marco@example.test", role: "admin" },
    { id: "u_wes", name: "Wesley", email: "wes@example.test", role: "agent" },
  ]),
);
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

const { createTrackerRecord, listTrackerRecords, getTrackerDb } = await import("../dist/src/core/trackerStore.js");
const { dialerStore } = await import("../dist/src/dialer/store.js");
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const dial = dialerStore();
for (const [id, actorId, outcome, elapsedSeconds, endedAt] of [
  ["c1", "u_marco", "talked", 120, daysAgo(1)],
  ["c2", "u_wes", "appointment_set", 300, daysAgo(2)],
  ["c3", "u_wes", "no_answer", 30, daysAgo(3)],
  ["c4", "u_wes", "interrupted", 5, daysAgo(3)],
  ["c5", "u_wes", "talked", 60, daysAgo(60)],
  ["c6", "u_marco", null, 0, undefined],
]) dial.put("call", { id, actorId, outcome, elapsedSeconds, endedAt, startedAt: endedAt });
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
  name: "Old Wesley Sale",
  sides: ["seller"],
  assignedTo: "Wesley",
  sellerStage: "closed",
  stageMeta: { "seller:closed": { enteredAt: daysAgo(120) }, "seller:listing_appointment_set": { enteredAt: daysAgo(200) } },
});
createTrackerRecord({
  name: "Backfilled Seller",
  sides: ["seller"],
  assignedTo: "Wesley",
  sellerStage: "under_contract",
  legacyStage: "under_contract",
});
const legacyBuyer = createTrackerRecord({ name: "Legacy Buyer", sides: ["buyer"], assignedTo: "Marco Puga" });
getTrackerDb().prepare("UPDATE tracker_records SET buyer_stage='buyer_rep_signed' WHERE id=?").run(legacyBuyer.id);
createTrackerRecord({
  name: "Unassigned Buyer",
  sides: ["buyer"],
  buyerStage: "contacted",
});

check("seeded tracker rows exist", () => {
  assert.equal(listTrackerRecords({}).length, 6);
});

check("legacy buyer stage keys read as the new ladder; new rows get entry stamps", () => {
  const legacy = listTrackerRecords({}).find((r) => r.name === "Legacy Buyer");
  assert.equal(legacy.buyerStage, "appointment_set");
  const wes = listTrackerRecords({}).find((r) => r.name === "Wesley Seller");
  assert.ok(wes.stageMeta["seller:listing_appointment_set"]?.enteredAt);
  const backfill = listTrackerRecords({}).find((r) => r.name === "Backfilled Seller");
  assert.equal(backfill.stageMeta["seller:under_contract"], undefined);
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

const step = (o, key) => o.sellers.steps.find((s) => s.key === key);
check("seller funnel shape: Dialer metrics then stage steps, default 30-day window", () => {
  assert.deepEqual(
    all.sellers.steps.map((s) => s.key),
    ["attempt_elapsed", "connected_talk", "called", "conversations", "appt_set", "appt_show", "listed", "contract", "closed"],
  );
  assert.equal(all.sellers.window.key, "30d");
  assert.equal(step(all, "attempt_elapsed").format, "duration");
  assert.equal(step(all, "attempt_elapsed").label, "Attempt elapsed");
  assert.equal(step(all, "attempt_elapsed").rateFromPrev, null);
  assert.equal(step(all, "connected_talk").format, "unavailable");
  assert.equal(step(all, "connected_talk").count, null);
  assert.equal(step(all, "connected_talk").label, "Connected talk");
  assert.equal(step(all, "called").rateFromPrev, null);
  assert.equal(all.sellers.subtitle, "Attempt elapsed → Sold");
  assert.match(all.notes.join("\n"), /attempt elapsed/i);
  assert.match(all.notes.join("\n"), /Connected talk is unavailable/i);
});

check("overview all: Dialer numbers skip interrupted, unfinished and out-of-window calls", () => {
  assert.equal(step(all, "called").count, 3);
  assert.equal(step(all, "attempt_elapsed").count, 450);
  assert.equal(step(all, "conversations").count, 2);
  assert.equal(step(all, "conversations").rateFromPrev, 66.7);
});

check("windowed seller stages use entry dates; undated backfills only count all time", () => {
  assert.equal(step(all, "appt_set").count, 1);
  assert.equal(step(all, "closed").count, 0);
  assert.equal(step(all, "contract").count, 0);
});

const allTime = await buildPipelineOverview({ sellerWindow: "all" });
check("all-time seller window counts every call and every staged row", () => {
  assert.equal(allTime.sellers.window.since, null);
  assert.equal(step(allTime, "called").count, 4);
  assert.equal(step(allTime, "appt_set").count, 3);
  assert.equal(step(allTime, "contract").count, 2);
  assert.equal(step(allTime, "closed").count, 1);
  assert.equal(step(allTime, "closed").label, "Sold");
});

const { resolveSellerWindow } = await import("../dist/src/core/pipelineOverview.js");
check("seller windows: unknown falls back to 30d; month starts at Chicago midnight", () => {
  assert.equal(resolveSellerWindow("bogus").key, "30d");
  const w = resolveSellerWindow("month", new Date("2026-11-14T18:00:00Z"));
  assert.equal(w.since, "2026-11-01T05:00:00.000Z");
  const summer = resolveSellerWindow("month", new Date("2026-07-03T03:00:00Z"));
  assert.equal(summer.since, "2026-07-01T05:00:00.000Z");
  const edge = resolveSellerWindow("month", new Date("2026-12-01T03:00:00Z"));
  assert.equal(edge.since, "2026-11-01T05:00:00.000Z");
});

const marco = await buildPipelineOverview({ agent: "Marco Puga" });
check("Marco filter excludes Wesley seller + unassigned tracker", () => {
  assert.equal(marco.sellers.inPipeline, 0);
  assert.equal(step(marco, "called").count, 1);
  assert.equal(step(marco, "attempt_elapsed").count, 120);
  assert.equal(step(marco, "connected_talk").count, null);
  const dms = marco.buyers.steps.find((s) => s.key === "dms");
  assert.equal(dms.count, 2);
});

const wes = await buildPipelineOverview({ agent: "Wesley" });
check("Wesley filter keeps his seller + calls; no Marco social Views", () => {
  assert.equal(wes.sellers.inPipeline, 3);
  assert.equal(step(wes, "called").count, 2);
  assert.equal(step(wes, "conversations").count, 1);
  const dms = wes.buyers.steps.find((s) => s.key === "dms");
  assert.equal(dms.count, 0);
  assert.equal(wes.buyers.steps.find((s) => s.key === "views"), undefined);
  assert.equal(wes.buyers.steps.find((s) => s.key === "comments"), undefined);
});

const none = await buildPipelineOverview({ agent: AGENT_FILTER_NONE });
check("empty agent pick zeros the funnel (unselect Marco must not show All)", () => {
  assert.equal(none.buyers.steps.find((s) => s.key === "dms").count, 0);
  assert.equal(none.buyers.steps.find((s) => s.key === "number").count, 0);
  assert.equal(step(none, "called").count, 0);
  assert.equal(step(none, "attempt_elapsed").count, 0);
  assert.equal(step(none, "connected_talk").count, null);
  assert.equal(none.sellers.inPipeline, 0);
  assert.equal(none.buyers.steps.find((s) => s.key === "views"), undefined);
});

check("Overview UI: agents are Marco+Wesley only; filter uses __none__", () => {
  const crm = readFileSync(new URL("../public/crm-brivity.html", import.meta.url), "utf8");
  assert(/const TEAM=\["Marco Puga","Wesley"\]/.test(crm));
  assert(/USER_FILTER==null/.test(crm));
  assert(/__none__/.test(crm));
  assert(!/const TEAM=\["Marco Puga","Wesley","Carlos"\]/.test(crm));
  assert(/format==="unavailable"\|\|s\.count==null/.test(crm));
  assert(/Attempt elapsed/.test(crm));
});

check("Harvey tool + CRM route + Overview UI exist", () => {
  const tools = readFileSync(new URL("../src/harvey/platformTools.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const crm = readFileSync(new URL("../public/crm-brivity.html", import.meta.url), "utf8");
  assert(/get_pipeline_overview/.test(tools));
  assert(/Attempt elapsed/.test(tools));
  assert(/call\.completed alone is not connected evidence/.test(tools));
  assert(/\/api\/crm\/pipeline-overview/.test(server));
  assert(/pipeOverview/.test(crm));
  assert(/renderPipelineOverview/.test(crm));
  assert(/>Overview</.test(crm));
  assert(/Views → Close/.test(tools) || /Views→Close/.test(tools) || /Views→Comments/.test(tools));
});

getTrackerDb().close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
