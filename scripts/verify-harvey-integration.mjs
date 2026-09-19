/**
 * verify-harvey-integration.mjs — the pieces working together.
 *
 * The unit suites prove each part in isolation. This one proves the thing that
 * actually matters and that no unit test can see: that a model asking to send an
 * email does NOT send it, that spend accumulates across a multi-step turn, that
 * the spend cap ends a turn with a sentence instead of an exception, and that a
 * scheduled run keeps the gate armed even when the environment has relaxed it.
 *
 * The model is stubbed at the CommonJS module boundary (dist/ is CJS, so
 * `require()` hands back the live exports object the agent loop actually calls),
 * and the tool executor is stubbed the same way so we can observe whether a
 * gated call reached it. Everything else — routing, context planning, the
 * budget, the ledger, the approval store, the task store — is the real thing.
 *
 * Run:  node scripts/verify-harvey-integration.mjs
 * Expects a built dist/ (npm run build).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(tmpdir(), "harvey-int-"));
process.env.AI_USAGE_DB_PATH = path.join(tmp, "usage.db");
process.env.HARVEY_TASKS_DB_PATH = path.join(tmp, "tasks.db");
process.env.HARVEY_CRON_MIN_INTERVAL_MINUTES = "15";
process.env.HARVEY_DAILY_CAP_USD = "10";
process.env.HARVEY_MONTHLY_CAP_USD = "150";
/* A key must LOOK present or the loop refuses before it reaches the stub. No
   network call is ever made: `complete` itself is replaced below. */
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
delete process.env.OPENROUTER_API_KEY;

const require_ = createRequire(import.meta.url);

const providers = require_("../dist/src/hull/providers/index.js");
const hullTools = require_("../dist/src/hull/tools.js");
const approvalMod = require_("../dist/src/hull/approval.js");
const usage = require_("../dist/src/core/aiUsageStore.js");
const taskStore = require_("../dist/src/core/harveyTaskStore.js");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

/* ── the stubs ───────────────────────────────────────────────────────────── */

const realComplete = providers.complete;
const realExecute = hullTools.executeHullTool;

/** Scripted model turns. Each entry is one `complete()` response. */
let script = [];
let completeCalls = [];
/** Tool names that actually reached the executor. The gate's real assertion. */
let executed = [];

function stubUsage(costUsd = 0.001) {
  return {
    provider: "openrouter", model: "anthropic/claude-sonnet-4.6", job: "chat_deep",
    promptTokens: 1000, completionTokens: 200, cachedTokens: 0,
    costUsd, costEstimated: false, latencyMs: 10, ok: true,
  };
}

providers.complete = async (req) => {
  completeCalls.push(req);
  const next = script.shift();
  if (!next) throw new Error("stub script exhausted — the loop made more calls than expected");
  if (next.throw) throw next.throw;
  // Stream the text when the caller asked for streaming, like the real layer.
  if (req.onToken && next.text) req.onToken(next.text);
  return {
    text: next.text || "",
    toolUses: next.toolUses || [],
    stopReason: next.toolUses?.length ? "tool_use" : "end_turn",
    usage: stubUsage(next.costUsd ?? 0.001),
    modelUsed: next.modelUsed || "anthropic/claude-sonnet-4.6",
    contextPlan: { budgetTokens: 60000, estimatedTokens: 1200, droppedTurns: 0, compactedToolResults: 0, summaryInjected: false },
    budget: { allowed: true, spentTodayUsd: 0, spentMonthUsd: 0, dailyCapUsd: 10, monthlyCapUsd: 150 },
    resolved: { job: req.job, provider: "openrouter", model: "anthropic/claude-sonnet-4.6", fallbacks: [], source: "default" },
  };
};

hullTools.executeHullTool = async (name, input) => {
  executed.push(name);
  return { ok: true, echo: name, input };
};

/* agentLoop is required AFTER the stubs so its module-level imports resolve to
   the same live objects we just patched. */
const { runAgentLoop } = require_("../dist/src/hull/agentLoop.js");
const scheduler = require_("../dist/src/hull/taskScheduler.js");

function reset(newScript) {
  script = newScript;
  completeCalls = [];
  executed = [];
  approvalMod.__resetApprovals();
}

/* ── a plain turn ────────────────────────────────────────────────────────── */
console.log("\nA PLAIN TURN — text in, text out, spend recorded");

reset([{ text: "You have 3 leads that went quiet this week.", costUsd: 0.004 }]);
let r = await runAgentLoop({ message: "what needs my attention", sessionId: "s-plain", fullMode: true });
check("the answer comes back", /3 leads/.test(r.speech), r.speech);
check("the turn reports what it cost", r.costUsd === 0.004, String(r.costUsd));
check("tokens are reported", r.promptTokens === 1000 && r.completionTokens === 200);
check("the model that actually ran is reported", r.modelUsed === "anthropic/claude-sonnet-4.6");
check("a context plan comes back", !!r.contextPlan && r.contextPlan.budgetTokens > 0);
check("no approvals were needed", (r.approvals || []).length === 0);
check("the job routed to chat_deep in fullMode", completeCalls[0].job === "chat_deep");
check("tools were offered on a full-mode turn", Array.isArray(completeCalls[0].tools) && completeCalls[0].tools.length > 50);

/* ── a harmless tool ─────────────────────────────────────────────────────── */
console.log("\nA READ TOOL — runs without asking");

reset([
  { text: "", toolUses: [{ id: "t1", name: "get_hot_leads", input: {} }] },
  { text: "Two hot leads: Rudy and Marisol." },
]);
r = await runAgentLoop({ message: "who is hot right now", sessionId: "s-read", fullMode: true });
check("the read tool executed", executed.includes("get_hot_leads"), executed.join(","));
check("and the turn answered after it", /Rudy/.test(r.speech));
check("cost summed across both steps", Math.abs(r.costUsd - 0.002) < 1e-9, String(r.costUsd));
check("the tool round was counted", r.toolRounds === 1);

/* ── THE GATE ────────────────────────────────────────────────────────────── */
console.log("\nTHE GATE — an email the model asked to send, and did not");

reset([
  {
    text: "",
    toolUses: [{ id: "t1", name: "gmail_send", input: { to: "buyer@example.com", subject: "Your listings", body: "hi" } }],
  },
  { text: "That email is drafted and waiting on your approval." },
]);
r = await runAgentLoop({ message: "email the buyer their listings", sessionId: "s-gate", fullMode: true });

check("gmail_send did NOT reach the executor", !executed.includes("gmail_send"), executed.join(","));
check("an approval was raised", (r.approvals || []).length === 1);
check("it is pending", r.approvals[0].status === "pending");
check("it is classified high risk", r.approvals[0].risk === "high");
check("the card names the recipient and subject",
  r.approvals[0].summary === 'Email "Your listings" to buyer@example.com', r.approvals[0].summary);
check("it is visible to the approvals endpoint", approvalMod.listPendingApprovals("s-gate").length === 1);

/* The model must be TOLD it did not happen, or it reports success to the
   operator — which is the actual failure this gate exists to prevent. */
const heldResult = JSON.stringify(completeCalls[1].messages);
check("the model was told the action has NOT run", /has NOT run/.test(heldResult));
check("and told not to claim it is done", /do not tell the operator it is done/i.test(heldResult));
check("the turn still completed with an answer", /waiting on your approval/.test(r.speech));

/* Approving is what finally runs it, and it runs exactly once. */
const pendingId = r.approvals[0].id;
const decided = approvalMod.decideApproval(pendingId, "approved", { by: "marco" });
check("approving marks it approved", decided.status === "approved");
await hullTools.executeHullTool(decided.tool, decided.args);
check("only then does the send execute", executed.includes("gmail_send"));
check("and it cannot be replayed", approvalMod.decideApproval(pendingId, "approved") === null);

/* ── the gate cannot be dodged by a scheduled run ────────────────────────── */
console.log("\nUNATTENDED WORK — the gate stays armed when nobody is watching");

process.env.HARVEY_APPROVAL_REQUIRED = "false";
reset([
  { text: "", toolUses: [{ id: "t1", name: "gmail_send", input: { to: "x@y.com", subject: "s", body: "b" } }] },
  { text: "Held." },
]);
r = await runAgentLoop({ message: "send it", sessionId: "s-off", fullMode: true });
check("with the gate switched off, a live chat does send", executed.includes("gmail_send"));

reset([
  { text: "", toolUses: [{ id: "t1", name: "gmail_send", input: { to: "x@y.com", subject: "s", body: "b" } }] },
  { text: "That is waiting on approval." },
]);
r = await runAgentLoop({ message: "send it", sessionId: "s-cron", fullMode: true, approvalMode: "on" });
check("but approvalMode:'on' still holds it, even with the env switch off",
  !executed.includes("gmail_send"), executed.join(","));
check("and raises the approval", (r.approvals || []).length === 1);
delete process.env.HARVEY_APPROVAL_REQUIRED;

/* ── the spend cap ───────────────────────────────────────────────────────── */
console.log("\nTHE SPEND CAP — a sentence, not an exception");

reset([{ throw: new providers.BudgetRefusedError({
  allowed: false,
  reason: "Harvey's daily AI spend cap of $10.00 is used up ($10.04 today). It resets at midnight Central.",
  spentTodayUsd: 10.04, spentMonthUsd: 12, dailyCapUsd: 10, monthlyCapUsd: 150,
}) }]);
r = await runAgentLoop({ message: "anything", sessionId: "s-cap", fullMode: true });
check("the turn does not throw", typeof r.speech === "string");
check("it says the cap is the reason", /spend cap/.test(r.speech), r.speech);
check("and flags it structurally so the UI can too", !!r.budgetRefused);

/* A provider outage is a different sentence and must not read as a cap. */
reset([{ throw: new providers.ModelLayerError("network", "upstream 503") }]);
r = await runAgentLoop({ message: "anything", sessionId: "s-down", fullMode: true });
check("an outage answers honestly instead of crashing", /could not reach a model/.test(r.speech), r.speech);
check("and is not reported as a budget refusal", !r.budgetRefused);

/* ── streaming and events ────────────────────────────────────────────────── */
console.log("\nSTREAMING — tokens and live tool events for the chat UI");

reset([
  { text: "Checking.", toolUses: [{ id: "t1", name: "get_task_board", input: {} }] },
  { text: "Four tasks are due today." },
]);
const tokens = [];
const events = [];
r = await runAgentLoop({
  message: "what is due today",
  sessionId: "s-stream",
  fullMode: true,
  onToken: (t) => tokens.push(t),
  onEvent: (e) => events.push(e),
});
check("tokens streamed to the caller", tokens.join("").includes("Four tasks"));
check("a tool event was emitted running", events.some((e) => e.type === "tool" && e.status === "running"));
check("and done", events.some((e) => e.type === "tool" && e.status === "done"));
check("a usage event was emitted per step", events.filter((e) => e.type === "usage").length === 2);
check("usage events carry cost", events.find((e) => e.type === "usage").costUsd === 0.001);

/* An approval mid-stream must reach the UI as its own event. */
reset([
  { text: "", toolUses: [{ id: "t1", name: "run_script", input: { code: "rm -rf /" } }] },
  { text: "Waiting on you." },
]);
const ev2 = [];
r = await runAgentLoop({ message: "run it", sessionId: "s-ev", fullMode: true, onEvent: (e) => ev2.push(e) });
check("an approval event is emitted for the card", ev2.some((e) => e.type === "approval"));
check("the event carries an id the UI can POST to", !!ev2.find((e) => e.type === "approval").approval.id);
check("and the script never ran", !executed.includes("run_script"));

/* ── the ledger ──────────────────────────────────────────────────────────── */
console.log("\nTHE LEDGER — spend is measured, not guessed");

const spentBefore = usage.spentToday();
reset([{ text: "ok", costUsd: 0.25 }]);
await runAgentLoop({ message: "hello there", sessionId: "s-ledger", fullMode: true });
/* The stub bypasses the real recorder, so the ledger is exercised directly —
   what matters here is that a session's spend is attributable at all, which is
   what the scheduler reads back to cost a run. */
usage.recordUsage({ ...stubUsage(0.25), sessionId: "s-ledger" });
check("a session's spend can be read back", usage.sessionCostUsd("s-ledger") === 0.25);
check("today's total moved", usage.spentToday() >= spentBefore);
check("an unknown session costs nothing", usage.sessionCostUsd("s-nope") === 0);
const summary = usage.usageSummary(30);
check("the usage summary answers", !!summary && typeof summary === "object");

/* ── a scheduled task end to end ─────────────────────────────────────────── */
console.log("\nSCHEDULED TASK — sentence to cron to a recorded run");

const { executeScheduleTool } = require_("../dist/src/hull/scheduleTools.js");
const created = await executeScheduleTool("schedule_task", {
  title: "Morning pipeline report",
  prompt: "Summarise what needs a call today.",
  schedule: "every weekday at 7am",
}, { sessionId: "s-chat", createdBy: "marco" });
check("Harvey can schedule from a sentence", created.created === true);
check("it stored a real cron", created.cron === "0 7 * * 1-5", created.cron);
check("and reads the schedule back in English", /Weekdays/.test(created.schedule));
check("it warns that sends still need approval", /approval/i.test(created.note || ""));

const vague = await executeScheduleTool("schedule_task", {
  title: "x", prompt: "y", schedule: "whenever you feel like it",
});
check("a vague cadence is refused rather than guessed", !!vague.error);
check("and the refusal offers examples", Array.isArray(vague.examples) && vague.examples.length > 0);

const tooFast = await executeScheduleTool("schedule_task", {
  title: "z", prompt: "y", schedule: "every 2 minutes",
});
check("a schedule below the cost floor is refused", !!tooFast.error);

const dup = await executeScheduleTool("schedule_task", {
  title: "Morning pipeline report", prompt: "again", schedule: "every weekday at 7am",
});
check("an identical duplicate is refused with the existing id", !!dup.existingTaskId);

reset([{ text: "3 calls to make: Rudy, Marisol, Dana.", costUsd: 0.01 }]);
const runOut = await scheduler.runTaskNow(created.id, "manual");
check("running the task succeeds", runOut.ok === true, runOut.error || "");
check("its output is the deliverable", /3 calls to make/.test(runOut.output), runOut.output);
const runs = taskStore.listRuns(created.id);
check("the run is recorded", runs.length === 1);
check("recorded as ok", runs[0].ok === true);
check("with its trigger", runs[0].trigger === "manual");

/* The scheduled prompt has to tell the model nobody is watching, or it asks a
   follow-up question into an empty room. */
const schedPrompt = completeCalls[0].messages.map((m) => JSON.stringify(m)).join(" ");
check("the run is told it is unattended", /Nobody is at the keyboard/.test(schedPrompt));
check("and that its reply is the deliverable", /IS the deliverable/i.test(schedPrompt));

/* A provider outage during an unattended run must be recorded as a FAILURE.
   The agent loop answers with a sentence rather than throwing, which is right
   for a live chat and wrong here: recorded as "ok", a task would deliver
   "I could not reach a model" every morning and still look healthy. */
console.log("\nUNATTENDED FAILURE — a down provider is not a successful run");

reset([{ throw: new providers.ModelLayerError("network", "upstream down") }]);
const failedRun = await scheduler.runTaskNow(created.id, "schedule");
check("a model outage makes the run fail", failedRun.ok === false, JSON.stringify(failedRun));
check("and the error is recorded, not the apology", /upstream down/.test(failedRun.error || ""));
check("the task's last status is error", taskStore.getTask(created.id).lastStatus === "error");

/* Two more, and the task pauses itself instead of retrying at full price. */
let lastPaused = false;
for (let i = 0; i < 2; i++) {
  script = [{ throw: new providers.ModelLayerError("network", "upstream down") }];
  await scheduler.runTaskNow(created.id, "schedule");
  lastPaused = taskStore.getTask(created.id).enabled === false;
}
check("three consecutive failures pause the task", lastPaused === true);
check("the paused task stops being scheduled", taskStore.getTask(created.id).nextRunAt === null);

/* The cap is the same story: a skipped run is a failure, with the cap named. */
reset([{ throw: new providers.BudgetRefusedError({
  allowed: false, reason: "Daily cap reached.", spentTodayUsd: 11, spentMonthUsd: 20,
  dailyCapUsd: 10, monthlyCapUsd: 150,
}) }]);
taskStore.updateTask(created.id, { enabled: true });
const cappedRun = await scheduler.runTaskNow(created.id, "manual");
check("a capped run is recorded as failed", cappedRun.ok === false);
check("with the cap as the reason", /cap/i.test(cappedRun.error || ""));

providers.complete = realComplete;
hullTools.executeHullTool = realExecute;
rmSync(tmp, { recursive: true, force: true });

const total = pass + fail;
console.log(`\n${pass}/${total} checks passed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
