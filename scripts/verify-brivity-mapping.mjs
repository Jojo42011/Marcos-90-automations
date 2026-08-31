#!/usr/bin/env node
/**
 * The Brivity → CRM field mapping, checked against the vocabulary Marco's
 * account actually contains.
 *
 * WHY THIS IS WORTH A SUITE. A migration mistake does not look like a crash. It
 * looks like 1,394 contacts sitting in the wrong stage, or 42 clients filed as
 * cold leads, and nobody notices until someone goes looking for a past client
 * who is not where they should be. By then the CRM has been in use for weeks
 * and the wrong labels are indistinguishable from the truth.
 *
 * So the fixtures below are not invented. Every status, stage, lead_type and
 * record type here is a real value from the live export of 2026-08-31, with the
 * real contact count beside it, and the assertions are about where each one
 * ends up. The counts are what makes a regression legible: "past-client is
 * wrong" is abstract, "29 contacts land in the wrong bucket" is not.
 *
 * Usage: node scripts/verify-brivity-mapping.mjs
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const M = await import(pathToFileURL(join(process.cwd(), "dist/src/core/brivityMapping.js")).href);
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

/* ---- the real distributions, measured 2026-08-31 over 2,855 contacts ---- */
const STATUSES = [
  ["unqualified", 1144], ["archived", 547], ["trash", 505], ["watch", 348],
  ["nurture", 205], ["hot", 33], ["past-client", 29], ["inactive", 26],
  ["active-client", 12], ["new", 3], ["brivity-user", 2], ["prospective-client", 1],
];
const STAGES = [
  ["New lead", 1327], ["Attempted contact", 1224], ["Spoke with customer", 168],
  ["Appointment set", 6], ["Met with customer", 2],
];
const LEAD_TYPES = [["n/a", 1353], ["seller", 662], ["buyer", 623], ["seller/buyer", 202], ["tenant", 13]];
const TYPES = [["lead", 2727], ["collaborator", 125], ["team", 3]];

const total = STATUSES.reduce((a, [, n]) => a + n, 0);
console.log(`  (fixtures cover ${total} of the 2,855 real contacts)\n`);

// ---- every real value is known to the tables -------------------------------
const unknownStatus = STATUSES.filter(([s]) => !M.BRIVITY_STATUS_MAP[M.norm(s)]);
ok("every status in the live account has an explicit mapping",
  unknownStatus.length === 0, JSON.stringify(unknownStatus.map((x) => x[0])));
const unknownStage = STAGES.filter(([s]) => !M.BRIVITY_STAGE_MAP[M.norm(s)]);
ok("every stage in the live account has an explicit mapping",
  unknownStage.length === 0, JSON.stringify(unknownStage.map((x) => x[0])));
const unknownType = LEAD_TYPES.filter(([s]) => !Object.prototype.hasOwnProperty.call(M.BRIVITY_INTENT_MAP, M.norm(s)));
ok("every lead_type in the live account has an explicit mapping",
  unknownType.length === 0, JSON.stringify(unknownType.map((x) => x[0])));

// ---- the specific errors this replaced --------------------------------------
const st = (s) => M.mapVocabulary({ status: s, stage: "New lead", lead_type: "buyer" });
ok("archived stays archived, not 'dead' (547 contacts)", st("archived").status === "archived", st("archived").status);
ok("trash stays trashed, not 'dead' (505 contacts)", st("trash").status === "trashed", st("trash").status);
ok("unqualified is dead, which is correct (1,144)", st("unqualified").status === "dead");
/* The one that actually costs money: a realtor's past clients are the referral
   and repeat list. Filing them as a cold "watch" lead loses the segment. */
ok("a past client is not filed as a cold lead (29)",
  st("past-client").status !== "watch" && st("past-client").addTags.includes("Past Client"),
  JSON.stringify(st("past-client")));
ok("an active client is not filed as a cold lead (12)",
  st("active-client").status === "hot" && st("active-client").addTags.includes("Active Client"),
  JSON.stringify(st("active-client")));
ok("a Brivity staff seat is marked as one, not left as a lead (2)",
  st("brivity-user").addTags.includes("Brivity Staff Account"));

const stg = (s) => M.mapVocabulary({ status: "nurture", stage: s, lead_type: "buyer" }).stage;
ok("'Attempted contact' keeps its stage (1,224 contacts)", stg("Attempted contact") === "attempted_contact", stg("Attempted contact"));
ok("'Spoke with customer' keeps its stage (168)", stg("Spoke with customer") === "spoke_with_customer", stg("Spoke with customer"));
ok("'Met with customer' keeps its stage (2)", stg("Met with customer") === "met_with_customer", stg("Met with customer"));
ok("'New lead' maps to new_lead, not the legacy 'new'", stg("New lead") === "new_lead", stg("New lead"));
ok("'Appointment set' keeps its stage (6)", stg("Appointment set") === "appointment_set");
ok("stage lookup is case- and space-insensitive",
  stg("ATTEMPTED   CONTACT") === "attempted_contact" && stg("attempted contact") === "attempted_contact");

const it = (t) => M.mapVocabulary({ status: "nurture", stage: "New lead", lead_type: t });
ok("'seller/buyer' becomes buyer_seller, not seller (202)", it("seller/buyer").intent === "buyer_seller", String(it("seller/buyer").intent));
ok("'n/a' stays UNSTATED rather than becoming a buyer (1,353)", it("n/a").intent === null, String(it("n/a").intent));
ok("'tenant' is not called a buyer, and is tagged instead (13)",
  it("tenant").intent === null && it("tenant").addTags.includes("Tenant"), JSON.stringify(it("tenant")));
ok("a real buyer is still a buyer", it("buyer").intent === "buyer");
ok("a real seller is still a seller", it("seller").intent === "seller");

// ---- record kinds ----------------------------------------------------------
for (const [t, n] of TYPES) ok(`record type '${t}' is identified (${n})`, M.recordKind(t) === t, M.recordKind(t));
ok("an unknown record type is flagged rather than assumed to be a lead",
  M.recordKind("something_new") === "unknown");

// ---- unknown values are surfaced, not swallowed -----------------------------
const nov = M.mapVocabulary({ status: "some-new-status", stage: "Some New Stage", lead_type: "landlord?" });
ok("an unknown status is reported", nov.unmapped.some((u) => u.field === "status"), JSON.stringify(nov.unmapped));
ok("an unknown stage is reported", nov.unmapped.some((u) => u.field === "stage"));
ok("an unknown lead_type is reported", nov.unmapped.some((u) => u.field === "lead_type"));
ok("and it still falls back to something safe rather than throwing",
  nov.status === "nurture" && nov.stage === "new_lead");
/* 128 contacts have no stage at all. That is Brivity saying nothing, which is
   different from Brivity saying something we do not recognise. */
const blank = M.mapVocabulary({ status: "nurture", stage: "", lead_type: "" });
ok("an EMPTY stage is not reported as unmapped (128 contacts)",
  blank.unmapped.length === 0 && blank.stage === "new_lead", JSON.stringify(blank.unmapped));

// ---- no real value silently uses a fallback ---------------------------------
let fellBack = 0;
for (const [s] of STATUSES) if (M.mapVocabulary({ status: s }).unmapped.length) fellBack++;
for (const [s] of STAGES) if (M.mapVocabulary({ stage: s }).unmapped.length) fellBack++;
for (const [t] of LEAD_TYPES) if (M.mapVocabulary({ lead_type: t }).unmapped.length) fellBack++;
ok("not one real value in the live account hits a fallback", fellBack === 0, String(fellBack));

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); process.exit(1); }
