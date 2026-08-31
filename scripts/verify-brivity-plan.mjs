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

/* Nothing may reach the CRM carrying a value no table understood. */
const unmappedRows = rows.filter((r) => (r.unmapped || []).length);
ok("not one of the 2,855 real records hits an unmapped value",
  unmappedRows.length === 0,
  JSON.stringify(unmappedRows.slice(0, 5).map((r) => r.unmapped)));

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); process.exit(1); }
