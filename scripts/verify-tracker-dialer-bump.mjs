/**
 * Dialer outcome → Tracker stage bump.
 * Run after `npm run build`: node scripts/verify-tracker-dialer-bump.mjs
 */
import assert from "assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "dialer-bump-"));
process.env.TRACKER_DB_PATH = join(tmp, "tracker.db");

const {
  createTrackerRecord,
  getTrackerRecord,
  getTrackerRecordByLead,
} = await import("../dist/src/core/trackerStore.js");
const {
  bumpTrackerFromDialerActivity,
  canAdvanceStage,
  classifyDialerOutcome,
  isDialerActivitySource,
  planDialerBump,
  resolveBumpSides,
} = await import("../dist/src/core/trackerDialerBump.js");

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

check("Dialer source detection", () => {
  assert.equal(isDialerActivitySource("Dialer"), true);
  assert.equal(isDialerActivitySource("Logged from the contact record"), false);
  assert.equal(isDialerActivitySource(""), false);
});

check("outcome classification", () => {
  assert.equal(classifyDialerOutcome("Talked"), "contacted");
  assert.equal(classifyDialerOutcome("Left Message"), null);
  assert.equal(classifyDialerOutcome("No Answer"), null);
  assert.equal(classifyDialerOutcome("Appointment Set"), "appointment");
  assert.equal(classifyDialerOutcome("showing_set"), "appointment");
});

check("forward-only stage compare", () => {
  assert.equal(canAdvanceStage("buyer", null, "contacted"), true);
  assert.equal(canAdvanceStage("buyer", "contacted", "contacted"), false);
  assert.equal(canAdvanceStage("buyer", "actively_showing", "contacted"), false);
  assert.equal(canAdvanceStage("seller", "new", "contacted"), true);
  assert.equal(canAdvanceStage("seller", "contacted", "listing_appointment_set"), true);
  assert.equal(canAdvanceStage("seller", "active_on_mls", "listing_appointment_set"), false);
});

check("side resolution uses intent when both present", () => {
  assert.deepEqual(resolveBumpSides({ sides: ["buyer", "seller"] }, "seller"), ["seller"]);
  assert.deepEqual(resolveBumpSides({ sides: ["buyer", "seller"] }, "buyer"), ["buyer"]);
  assert.deepEqual(resolveBumpSides({ sides: ["buyer"] }, "seller"), ["buyer"]);
});

const unstagedBuyer = createTrackerRecord({
  leadId: "lead_talked",
  name: "Unstaged Buyer",
  sides: ["buyer"],
  status: "new",
});
assert.equal(unstagedBuyer.buyerStage, undefined);

check("unstaged → contacted on Dialer Talked", () => {
  const r = bumpTrackerFromDialerActivity({
    leadId: "lead_talked",
    outcome: "Talked",
    source: "Dialer",
    leadIntent: "buyer",
  });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(r.kind, "contacted");
  const rec = getTrackerRecord(unstagedBuyer.id);
  assert.equal(rec.buyerStage, "contacted");
});

const aheadSeller = createTrackerRecord({
  leadId: "lead_ahead",
  name: "Already Showing Seller",
  sides: ["seller"],
  status: "hot",
  sellerStage: "listing_appointment_set",
});

check("no downgrade when already further along", () => {
  const r = bumpTrackerFromDialerActivity({
    leadId: "lead_ahead",
    outcome: "Talked",
    source: "Dialer",
    leadIntent: "seller",
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "already_ahead");
  assert.equal(getTrackerRecord(aheadSeller.id).sellerStage, "listing_appointment_set");

  const appt = bumpTrackerFromDialerActivity({
    leadId: "lead_ahead",
    outcome: "Appointment Set",
    source: "Dialer",
    leadIntent: "seller",
  });
  assert.equal(appt.applied, false);
  assert.equal(getTrackerRecord(aheadSeller.id).sellerStage, "listing_appointment_set");
});

check("missing tracker = no-op (does not create)", () => {
  const before = getTrackerRecordByLead("lead_missing");
  assert.equal(before, null);
  const r = bumpTrackerFromDialerActivity({
    leadId: "lead_missing",
    outcome: "Talked",
    source: "Dialer",
    leadIntent: "buyer",
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "no_tracker");
  assert.equal(getTrackerRecordByLead("lead_missing"), null);
});

const sellerNew = createTrackerRecord({
  leadId: "lead_seller_new",
  name: "Seller New",
  sides: ["seller"],
  sellerStage: "new",
});

check("seller new + Talked advances to contacted", () => {
  const r = bumpTrackerFromDialerActivity({
    leadId: "lead_seller_new",
    outcome: "Talked",
    source: "Dialer",
    leadIntent: "seller",
  });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(getTrackerRecord(sellerNew.id).sellerStage, "contacted");
});

const sellerContacted = createTrackerRecord({
  leadId: "lead_seller_appt",
  name: "Seller Contacted",
  sides: ["seller"],
  sellerStage: "contacted",
});

check("Appointment Set bumps seller to listing_appointment_set", () => {
  const r = bumpTrackerFromDialerActivity({
    leadId: "lead_seller_appt",
    outcome: "Appointment Set",
    source: "Dialer",
    leadIntent: "seller",
  });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(getTrackerRecord(sellerContacted.id).sellerStage, "listing_appointment_set");
});

const buyerContacted = createTrackerRecord({
  leadId: "lead_buyer_appt",
  name: "Buyer Contacted",
  sides: ["buyer"],
  buyerStage: "contacted",
});

check("Appointment Set bumps buyer to actively_showing", () => {
  const r = bumpTrackerFromDialerActivity({
    leadId: "lead_buyer_appt",
    outcome: "Appointment Set",
    source: "Dialer",
    leadIntent: "buyer",
  });
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(getTrackerRecord(buyerContacted.id).buyerStage, "actively_showing");
});

check("non-Dialer call source is ignored", () => {
  const rec = createTrackerRecord({
    leadId: "lead_logged",
    name: "Logged Call",
    sides: ["buyer"],
  });
  const r = bumpTrackerFromDialerActivity({
    leadId: "lead_logged",
    outcome: "Talked",
    source: "Logged from the contact record",
    leadIntent: "buyer",
  });
  assert.equal(r.reason, "not_dialer");
  assert.equal(getTrackerRecord(rec.id).buyerStage, undefined);
});

check("planDialerBump never invents Closed", () => {
  const rec = {
    id: "x",
    sides: ["buyer"],
    name: "x",
    status: "new",
    addedAt: "",
    updatedAt: "",
  };
  const changes = planDialerBump(rec, "contacted", "buyer");
  assert.ok(changes.every((c) => c.to !== "closed"));
  const appt = planDialerBump({ ...rec, buyerStage: "contacted" }, "appointment", "buyer");
  assert.ok(appt.every((c) => c.to === "actively_showing"));
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.error(failures.join("\n"));
  process.exit(1);
}
