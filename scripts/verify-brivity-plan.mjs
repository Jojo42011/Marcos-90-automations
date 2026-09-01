#!/usr/bin/env node
/**
 * The Brivity import PLANNER, run over the real 2,855-contact export.
 *
 * WHY THIS EXISTS SEPARATELY FROM verify-brivity-mapping. That suite proves the
 * vocabulary tables are right. It cannot prove the importer USES them — and it
 * didn't: `recordKind` was computed on every row and then ignored by the
 * planner, so 125 collaborators (lenders, co-op agents, title reps) and 3 team
 * seats would have been created as leads and landed on the call list. A mapping
 * test passes happily while the write path throws the mapping away.
 *
 * So this drives `planBrivityImport()` itself, with the real archive fed in
 * through the real `personToRow()`, and asserts on what the plan would WRITE.
 *
 * Usage: BRIVITY_ARCHIVE=/path/to/archive.json node scripts/verify-brivity-plan.mjs
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const url = (p) => pathToFileURL(join(process.cwd(), p)).href;
const People = await import(url("dist/src/core/brivityPeople.js"));

const archivePath = process.env.BRIVITY_ARCHIVE;
if (!archivePath) { console.error("BRIVITY_ARCHIVE is required"); process.exit(2); }
const raw = JSON.parse(readFileSync(archivePath, "utf8"));
const people = Array.isArray(raw) ? raw : (raw.people || raw.data || []);
const rows = people.map((p) => People.personToRow(p)).filter(Boolean);

/* planBrivityImport() reaches for the live Brivity API and the live lead store.
   Both are replaced here: the archive stands in for the API, and an EMPTY lead
   store is the honest worst case — with nothing to match against, every
   contact takes the CREATE path, which is exactly the path that decides what
   gets written. */
const { planBrivityImport } = await import(url("dist/src/core/brivityImport.js"));
const DEPS = { fetchPeople: async () => rows, loadLeads: () => [] };
const plan_ = (o) => planBrivityImport(o, DEPS);

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const plan = await plan_({});
console.log(`\n  fetched ${plan.fetched}; create ${plan.counts.create}; ` +
  `skipped dead ${plan.skipped.dead}, non-lead ${plan.skipped.nonLead}, ` +
  `no-contact ${plan.skipped.noContactInfo}, dupe ${plan.skipped.duplicateWithinBrivity}\n`);

ok("the whole archive is seen", plan.fetched === rows.length, `${plan.fetched} vs ${rows.length}`);

/* The defect this suite was written for. */
const kinds = new Map();
for (const r of rows) kinds.set(r.recordKind, (kinds.get(r.recordKind) || 0) + 1);
const nonLeadRows = rows.filter((r) => r.recordKind !== "lead").length;
console.log("  record kinds in the export: " + JSON.stringify(Object.fromEntries(kinds)) + "\n");
ok("the export really does contain non-leads to hold back", nonLeadRows > 0, String(nonLeadRows));
ok("not one collaborator or team record is planned as a new lead",
  plan.creates.every((c) => {
    const src = rows.find((r) => String(r.brivityId) === String(c.brivityId));
    return !src || src.recordKind === "lead";
  }),
  JSON.stringify(plan.creates.filter((c) => {
    const src = rows.find((r) => String(r.brivityId) === String(c.brivityId));
    return src && src.recordKind !== "lead";
  }).slice(0, 5).map((c) => c.name)));
ok("and they are reported as held back, not silently dropped",
  plan.skipped.nonLead > 0, String(plan.skipped.nonLead));

/* Holding back must be a CHOICE, not a hard rule — otherwise there is no way to
   ever bring a lender in deliberately. */
const withNonLeads = await plan_({ includeNonLeads: true });
ok("includeNonLeads:true brings them back",
  withNonLeads.counts.create > plan.counts.create && withNonLeads.skipped.nonLead === 0,
  `${withNonLeads.counts.create} vs ${plan.counts.create}`);

/* Dead contacts: same shape, and the two gates must not double-count. */
ok("dead contacts are held back from create by default", plan.skipped.dead > 0, String(plan.skipped.dead));
const everything = await plan_({ includeDead: true, includeNonLeads: true });
ok("with both gates open nothing is skipped for either reason",
  everything.skipped.dead === 0 && everything.skipped.nonLead === 0,
  `dead ${everything.skipped.dead}, nonLead ${everything.skipped.nonLead}`);
ok("every skip is accounted for, none vanish",
  plan.counts.create + plan.counts.merge + plan.unchanged + plan.ambiguous.length +
  plan.skipped.dead + plan.skipped.nonLead + plan.skipped.noContactInfo +
  plan.skipped.duplicateWithinBrivity === plan.fetched,
  `sum ${plan.counts.create + plan.counts.merge + plan.unchanged + plan.ambiguous.length + plan.skipped.dead + plan.skipped.nonLead + plan.skipped.noContactInfo + plan.skipped.duplicateWithinBrivity} vs fetched ${plan.fetched}`);

/* What actually gets written must carry the mapping, not the old defaults. */
const stages = new Map(); const statuses = new Map(); let nullIntent = 0;
for (const c of plan.creates) {
  stages.set(c.stage, (stages.get(c.stage) || 0) + 1);
  statuses.set(c.status, (statuses.get(c.status) || 0) + 1);
  if (c.intent === null) nullIntent++;
}
console.log("\n  planned stages:   " + JSON.stringify(Object.fromEntries(stages)));
console.log("  planned statuses: " + JSON.stringify(Object.fromEntries(statuses)) + "\n");
ok("creates carry real stages, not all 'new_lead'", stages.size > 1, JSON.stringify(Object.fromEntries(stages)));
ok("attempted_contact survives into the plan", (stages.get("attempted_contact") || 0) > 100, String(stages.get("attempted_contact")));
ok("archived and trashed stay distinct from dead in the plan",
  statuses.has("archived") && statuses.has("trashed"), JSON.stringify(Object.fromEntries(statuses)));
ok("no create is planned with status 'dead' while includeDead is false",
  !statuses.has("dead"), String(statuses.get("dead")));
ok("'Brivity did not say' is carried as null intent, not invented as buyer",
  nullIntent > 0, String(nullIntent));

/* Every planned write must be traceable back to the record it came from. */
ok("every create keeps a Brivity id", plan.creates.every((c) => c.brivityId), "some create has no brivityId");
ok("every create has something to contact them on",
  plan.creates.every((c) => c.phone || c.email), "a create has neither phone nor email");
ok("no create is planned twice for the same Brivity id",
  new Set(plan.creates.map((c) => c.brivityId)).size === plan.creates.length);

/* 339 leads have no name in Brivity. What they get called matters: a name
   column full of raw digit strings reads as a data error. */
const digitNames = plan.creates.filter((c) => /^\d{7,}$/.test(c.name));
ok("no contact is named as a raw string of digits", digitNames.length === 0,
  JSON.stringify(digitNames.slice(0, 5).map((c) => c.name)));
const phoneNamed = plan.creates.filter((c) => /^\(\d{3}\) \d{3}-\d{4}$/.test(c.name));
ok("a nameless contact is instead labelled with their formatted number",
  phoneNamed.length > 0, String(phoneNamed.length));
ok("every planned contact has some label", plan.creates.every((c) => c.name && c.name.trim()));

/* Brivity's company/job_title have no field here. They must survive anyway —
   among them are the title companies and brokerages that say who someone is. */
const withCompany = rows.filter((r) => /\[from Brivity\] Company:/.test(r.crmNotes || ""));
ok("company survives the transfer instead of being dropped",
  withCompany.length >= 140, String(withCompany.length));
ok("and it is labelled as Brivity's, not passed off as a note typed here",
  withCompany.every((r) => r.crmNotes.includes("[from Brivity]")));
const both = rows.filter((r) => /Company:.*·.*Title:/.test(r.crmNotes || ""));
ok("a job title rides along with the company when both exist", both.length > 0, String(both.length));
/* The notes Brivity already held must not be clobbered by the addition. */
const merged = rows.find((r) => /\[from Brivity\]/.test(r.crmNotes || "") &&
  r.crmNotes.split("\n\n").length > 1);
ok("an existing Brivity note is kept above the appended fields",
  !!merged && merged.crmNotes.indexOf("[from Brivity]") > 0,
  merged ? merged.crmNotes.slice(0, 80) : "none");

/* Nothing may reach the CRM carrying a value no table understood. */
const unmappedRows = rows.filter((r) => (r.unmapped || []).length);
ok("not one of the 2,855 real records hits an unmapped value",
  unmappedRows.length === 0,
  JSON.stringify(unmappedRows.slice(0, 5).map((r) => r.unmapped)));

/* ──────────────────────────────────────────────────────────────────────────
 * MERGE SAFETY.
 *
 * Against Marco's real CRM most of these contacts match a lead he already has,
 * so the merge path — not the create path — is where a migration destroys
 * data. Everything below asks the same question: can importing a stale Brivity
 * row make the CRM worse than it was? A merge may only ADD what is missing.
 * ────────────────────────────────────────────────────────────────────────── */
console.log("\n  --- merge safety ---");

const pick = (fn) => rows.find(fn);
const trashRow = pick((r) => r.crmStatus === "trashed" && r.phone);
const deadRow = pick((r) => r.crmStatus === "dead" && r.phone);
const archRow = pick((r) => r.crmStatus === "archived" && r.phone);
const emailRow = pick((r) => r.email && r.phone);

const lead = (over) => ({
  id: "L" + Math.random().toString(36).slice(2, 8), name: "Existing Name",
  phone: null, email: null, source: null, crmStatus: "new", crmIntent: null,
  brivityId: null, tags: [], ...over,
});
const changed = (m, field) => (m?.changes || []).find((c) => c.field === field);

/* A live conversation must not be filed away by a stale Brivity row. */
for (const [label, row] of [["trashed", trashRow], ["dead", deadRow], ["archived", archRow]]) {
  if (!row) { ok(`a Brivity '${label}' row exists to test with`, false, "none in export"); continue; }
  const p2 = await planBrivityImport({}, {
    fetchPeople: async () => [row],
    loadLeads: () => [lead({ phone: row.phone, name: "Live DM Lead" })],
  });
  const m = p2.merges[0];
  ok(`a Brivity '${label}' row never buries a lead we are talking to`,
    !changed(m, "crmStatus"), JSON.stringify(m?.changes));
}

/* The status gap-fill must still WORK for statuses that don't bury. */
const warmRow = pick((r) => r.crmStatus === "hot" && r.phone) || pick((r) => r.crmStatus === "nurture" && r.phone);
if (warmRow) {
  const p2 = await planBrivityImport({}, {
    fetchPeople: async () => [warmRow],
    loadLeads: () => [lead({ phone: warmRow.phone })],
  });
  ok("a warm Brivity status still fills an empty status",
    changed(p2.merges[0], "crmStatus")?.to === warmRow.crmStatus,
    JSON.stringify(p2.merges[0]?.changes));
}

/* And it must only ever FILL, never overwrite a status the CRM already set. */
if (warmRow) {
  const p2 = await planBrivityImport({}, {
    fetchPeople: async () => [warmRow],
    loadLeads: () => [lead({ phone: warmRow.phone, crmStatus: "watch" })],
  });
  ok("a status the CRM already decided is not overwritten",
    !changed(p2.merges[0], "crmStatus"), JSON.stringify(p2.merges[0]?.changes));
}

/* Email: fill a gap, never replace. A lead holds ONE email. */
if (emailRow) {
  const fill = await planBrivityImport({}, {
    fetchPeople: async () => [emailRow],
    loadLeads: () => [lead({ phone: emailRow.phone })],
  });
  ok("a missing email is filled in from Brivity",
    changed(fill.merges[0], "email")?.to === emailRow.email, JSON.stringify(fill.merges[0]?.changes));

  const keep = await planBrivityImport({}, {
    fetchPeople: async () => [emailRow],
    loadLeads: () => [lead({ phone: emailRow.phone, email: "real@fromconversation.com" })],
  });
  ok("an email we already hold is NOT overwritten by Brivity's",
    !changed(keep.merges[0], "email"), JSON.stringify(keep.merges[0]?.changes));
}

/* Intent: Brivity is authoritative when it speaks, silent when it does not. */
const naRow = pick((r) => r.crmIntent === null && r.phone);
if (naRow) {
  const p2 = await planBrivityImport({}, {
    fetchPeople: async () => [naRow],
    loadLeads: () => [lead({ phone: naRow.phone, crmIntent: "seller" })],
  });
  ok("a Brivity 'n/a' never erases an intent the CRM learned",
    !changed(p2.merges[0], "crmIntent"), JSON.stringify(p2.merges[0]?.changes));
}

/* Phone is the match key, but a lead matched on EMAIL may have no phone. */
if (emailRow) {
  const p2 = await planBrivityImport({}, {
    fetchPeople: async () => [emailRow],
    loadLeads: () => [lead({ email: emailRow.email })],
  });
  ok("a lead matched on email gets its missing phone filled",
    changed(p2.merges[0], "phone")?.to === emailRow.phone, JSON.stringify(p2.merges[0]?.changes));
  const p3 = await planBrivityImport({}, {
    fetchPeople: async () => [emailRow],
    loadLeads: () => [lead({ email: emailRow.email, phone: "(210) 555-0000" })],
  });
  ok("a phone we already hold is not overwritten",
    !changed(p3.merges[0], "phone"), JSON.stringify(p3.merges[0]?.changes));
}

/* Two leads sharing a phone is a human decision, not a coin flip. */
if (emailRow) {
  const p2 = await planBrivityImport({}, {
    fetchPeople: async () => [emailRow],
    loadLeads: () => [lead({ phone: emailRow.phone }), lead({ phone: emailRow.phone })],
  });
  ok("an ambiguous phone match is escalated, not guessed",
    p2.ambiguous.length === 1 && p2.merges.length === 0, JSON.stringify(p2.ambiguous));
}

/* Re-running the import must be a no-op, or a migration cannot be retried. */
const first = await plan_({});
const asLeads = first.creates.map((c) => lead({
  id: "L" + c.brivityId, name: c.name, phone: c.phone, email: c.email,
  source: c.source, crmStatus: c.status, crmIntent: c.intent, brivityId: c.brivityId,
}));
const second = await planBrivityImport({}, { fetchPeople: async () => rows, loadLeads: () => asLeads });
ok("re-running after an import creates nothing new (idempotent)",
  second.counts.create === 0, `${second.counts.create} duplicate creates`);
ok("and it does not churn the records it just wrote",
  second.counts.merge === 0, `${second.counts.merge} merges: ` +
  JSON.stringify(second.merges.slice(0, 3)));

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); process.exit(1); }
