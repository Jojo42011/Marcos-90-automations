/**
 * Assertions for the Auto Plans parity build (Aug 2026): triggers, pause rules,
 * step chaining, transaction plans. Run AFTER `npm run build`:
 *   node scripts/verify-auto-plans.mjs
 */
import { readFileSync, rmSync } from "fs";
import assert from "assert";

let passed = 0; const failures = [];
function check(name, fn) { try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
async function checkAsync(name, fn) { try { await fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Isolated stores so the run never touches real data.
const SCRATCH = process.env.SCRATCH_DIR || "/tmp/verify-auto-plans";
rmSync(SCRATCH, { recursive: true, force: true });
process.env.AUTO_PLAN_TRIGGERS_JSON_PATH = `${SCRATCH}/triggers.json`;
process.env.AUTO_PLANS_JSON_PATH = `${SCRATCH}/plans.json`;

const { createAutoPlan, getAutoPlans, duplicateAutoPlan, normalizeAutoPlanSteps } =
  await import("../dist/src/core/autoPlans.js");
const { createAutoPlanTrigger, triggerMatchesLead, findTriggeredEnrollment } =
  await import("../dist/src/core/autoPlanTriggers.js");

const plan = createAutoPlan({
  name: "Verify nurture", tag: "", planType: "people", active: true,
  autoPauseOnReply: true, autoPauseOnStatus: "hot", completionStatus: "nurture",
  steps: [
    { type: "text", dayOffset: 0, content: "hi [name]" },
    { type: "task", dayOffset: 2, content: "call them", taskPriority: 1, instructions: "Full context in CRM" },
  ],
});

const lead = (over = {}) => ({
  id: "L1", platform: "tiktok", userId: "u", username: null, name: "Test", phone: null, email: null,
  state: "new", source: "Mojo", adCampaign: null, propertyInquired: null, criteria: null, brivityId: null,
  crmStatus: "new", crmStage: "new", crmPriority: "normal", crmIntent: "buyer", crmCallQueue: "none",
  crmNotes: null, tags: ["expired - hot"], autoPlanEnrollments: [], ...over,
});

/* ── Triggers: the four Brivity fields, AND logic, Any = null ────────────── */
check("trigger: all-null conditions match anyone (Any/Any/Any/Any)", () => {
  const t = createAutoPlanTrigger({ intent: null, status: null, source: null, tag: null, planId: plan.id });
  assert(triggerMatchesLead(t, lead()));
});
check("trigger: AND logic — one failing field kills the match", () => {
  const t = { id: "x", intent: "buyer", status: null, source: "Website", tag: null, planId: plan.id, active: true, createdAt: "", updatedAt: "" };
  assert(!triggerMatchesLead(t, lead({ source: "Mojo" })), "source mismatch must fail despite intent match");
  assert(triggerMatchesLead(t, lead({ source: "website" })), "matching is case-insensitive");
});
check("trigger: tag condition matches any tag on the contact", () => {
  const t = { id: "x", intent: null, status: null, source: null, tag: "Expired - Hot", planId: plan.id, active: true, createdAt: "", updatedAt: "" };
  assert(triggerMatchesLead(t, lead()));
  assert(!triggerMatchesLead(t, lead({ tags: [] })));
});
check("guardrail: a contact already on an ACTIVE plan is never auto-enrolled again", () => {
  const enrolled = lead({ autoPlanEnrollments: [{ planId: "other", planName: "x", enrolledAt: "", currentStepIndex: 0, completedSteps: [], status: "active" }] });
  assert.equal(findTriggeredEnrollment(enrolled, getAutoPlans()), null,
    "stacking plans is a human decision, not a trigger's");
  const pausedOnly = lead({ autoPlanEnrollments: [{ planId: "other", planName: "x", enrolledAt: "", currentStepIndex: 0, completedSteps: [], status: "completed" }] });
  assert(findTriggeredEnrollment(pausedOnly, getAutoPlans()), "a finished plan must not block future triggers");
});
check("guardrail: bulk-import paths never evaluate triggers", () => {
  const s = read("src/core/db.ts");
  const quiet = s.split("export function upsertLeadQuiet")[1]?.split("\nexport ")[0] ?? "";
  assert(!/applyAutoPlanAutomations/.test(quiet), "upsertLeadQuiet must stay quiet — Brivity skips mass imports too");
  const create = s.split("export async function createLead")[1]?.split("\nexport ")[0] ?? "";
  assert(/applyAutoPlanAutomations\(null,/.test(create), "an organically created lead must be evaluated");
});
check("guardrail: managing enrollments by hand never instantly re-triggers", () => {
  const s = read("src/core/db.ts");
  assert(/input\.autoPlanEnrollments !== undefined;?\s*\n?\s*const finalNext = managed \? next : applyAutoPlanAutomations/.test(s.replace(/\/\*[\s\S]*?\*\//g, "")),
    "unenrolling must not re-enroll via trigger in the same write");
});

/* ── Pause rules ─────────────────────────────────────────────────────────── */
await checkAsync("pause-on-reply: active enrollment in a pausing plan pauses; others untouched", async () => {
  const { pauseAutoPlansOnInboundText } = await import("../dist/src/core/db.js");
  const l = lead({ autoPlanEnrollments: [
    { planId: plan.id, planName: plan.name, enrolledAt: "", currentStepIndex: 0, completedSteps: [], status: "active" },
  ]});
  const out = pauseAutoPlansOnInboundText(l);
  assert(out, "must report a change");
  assert.equal(out.autoPlanEnrollments[0].status, "paused");
  const not = pauseAutoPlansOnInboundText(lead({ autoPlanEnrollments: [] }));
  assert.equal(not, null, "no active enrollments → no write");
});
check("pause-on-reply: wired into the pipeline where EVERY inbound lands (SMS + DM)", () => {
  const s = read("src/app/pipeline.ts");
  assert(/pauseAutoPlansOnInboundText\(lead\)/.test(s));
  const idx = s.indexOf("pauseAutoPlansOnInboundText");
  const appendIdx = s.indexOf('appendMessage(lead.id, "user"');
  assert(appendIdx !== -1 && idx > appendIdx, "the pause must follow the inbound append, not precede lead resolution");
});

/* ── Steps: chaining, priority, negative offsets ─────────────────────────── */
check("steps: prev_step chaining survives normalization; a chain with no link degrades to plan start", () => {
  const steps = normalizeAutoPlanSteps([
    { type: "text", dayOffset: 0, content: "a" },
    { type: "email", dayOffset: 2, content: "b", anchor: "prev_step", afterStepId: "s1" },
    { type: "task", dayOffset: 1, content: "c", anchor: "prev_step" },
  ]);
  assert.equal(steps[1].anchor, "prev_step");
  assert.equal(steps[1].afterStepId, "s1");
  assert.equal(steps[2].anchor ?? "enrollment", "enrollment", "prev_step without afterStepId is meaningless");
});
check("steps: negative offsets survive ONLY on date anchors ('3 days before close')", () => {
  const steps = normalizeAutoPlanSteps([
    { type: "task", dayOffset: -3, content: "walkthrough", anchor: "closing_date" },
    { type: "task", dayOffset: -3, content: "bad", anchor: "enrollment" },
  ]);
  assert.equal(steps[0].dayOffset, -3, "before-close steps are the whole point of transaction plans");
  assert.equal(steps[1].dayOffset, 0, "you cannot text someone 3 days before they enrolled");
});
check("steps: authoring order is preserved (a dayOffset sort would scramble chains)", () => {
  const steps = normalizeAutoPlanSteps([
    { type: "task", dayOffset: 9, content: "later" },
    { type: "task", dayOffset: 1, content: "sooner" },
  ]);
  assert.equal(steps[0].content, "later");
});
check("steps: task priority clamps to Brivity's 1–9, instructions survive", () => {
  const steps = normalizeAutoPlanSteps([
    { type: "task", dayOffset: 0, content: "x", taskPriority: 1, instructions: "do it right" },
    { type: "task", dayOffset: 0, content: "y", taskPriority: 42 },
  ]);
  assert.equal(steps[0].taskPriority, 1);
  assert.equal(steps[0].instructions, "do it right");
  assert.equal(steps[1].taskPriority, undefined, "out-of-range priority is dropped, not clamped to a lie");
});

/* ── Duplicate — Brivity's main plan-building path ───────────────────────── */
check("duplicate: clones steps/settings under new ids and remaps chain refs internally", () => {
  const src = createAutoPlan({
    name: "Chain", tag: "", active: true, planType: "people",
    steps: [
      { id: "sA", type: "text", dayOffset: 0, content: "a" },
      { id: "sB", type: "email", dayOffset: 2, content: "b", anchor: "prev_step", afterStepId: "sA" },
    ],
  });
  const copy = duplicateAutoPlan(src.id);
  assert(copy && copy.id !== src.id);
  assert(/copy/i.test(copy.name));
  assert.notEqual(copy.steps[0].id, src.steps[0].id, "step ids must be regenerated");
  assert.equal(copy.steps[1].afterStepId, copy.steps[0].id,
    "the copy's chain must point at the COPY's step, not the original's");
});

/* ── Engine honesty + wiring ─────────────────────────────────────────────── */
check("engine: a text step with no phone creates a VISIBLE task, never a silent skip or fake send", () => {
  const s = read("src/server.ts");
  const engine = s.split("export async function executeDueAutoPlanSteps")[1]?.split("\nexport ")[0] ?? "";
  assert(/no phone/i.test(engine) && /createTask/.test(engine.split("!lead.phone")[1]?.slice(0, 1200) ?? ""),
    "Brivity flags this as an error; ours must surface it as a task");
});
check("engine: chained steps wait for their referenced step (no completedAt → not due)", () => {
  const s = read("src/server.ts");
  const engine = s.split("export async function executeDueAutoPlanSteps")[1]?.split("\nexport ")[0] ?? "";
  assert(/prev_step/.test(engine) && /if \(!prevDone\) continue/.test(engine));
});
check("engine: transaction engine anchors on real deal dates and waits for missing ones", () => {
  const s = read("src/server.ts");
  const engine = s.split("export async function executeDueTransactionPlanSteps")[1]?.split("\napp\.")[0] ?? "";
  assert(/closing_date/.test(engine) && /contract_date/.test(engine) && /expiration/.test(engine));
  assert(/if \(!baseIso\) continue/.test(engine), "a deal with no close date must wait, not error");
  assert(/email automation not connected/.test(engine),
    "email steps must say plainly they need a human — the Gmail path is dead");
});
check("engine: hourly sweep, both flavors scheduled", () => {
  const s = read("src/server.ts");
  assert(/AUTO_PLAN_INTERVAL_MS = 60 \* 60 \* 1000/.test(s), "24h cadence made day-0 steps a day late");
  assert(/executeDueTransactionPlanSteps\(\)/.test(s.split("setInterval")[1] ? s : ""),
    "transaction plans must run on the same schedule");
});
check("routes: settings payload, triggers CRUD, duplicate, tx enroll registered", () => {
  const s = read("src/server.ts");
  for (const r of [
    'app.get("/api/auto-plans/settings"', 'app.get("/api/auto-plan-triggers"',
    'app.post("/api/auto-plan-triggers"', 'app.patch("/api/auto-plan-triggers/:id"',
    'app.delete("/api/auto-plan-triggers/:id"', 'app.post("/api/auto-plans/:id/duplicate"',
    'app.post("/api/transactions/:id/auto-plans/:planId"', 'app.delete("/api/transactions/:id/auto-plans/:planId"',
  ]) assert(s.includes(r), `missing route ${r}`);
});
check("normalizer: completedAt + enrolledVia survive lead persistence round-trips", () => {
  const s = read("src/core/db.ts");
  const norm = s.split("export function normalizeAutoPlanEnrollments")[1]?.split("\nexport ")[0] ?? "";
  assert(/completedAt/.test(norm) && /enrolledVia/.test(norm),
    "dropping them silently breaks chaining and trigger counts");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  ✗ " + f); process.exit(1); }
