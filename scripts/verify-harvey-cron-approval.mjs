/**
 * verify-harvey-cron-approval.mjs — the scheduler and the approval gate.
 *
 * Both of these are money and blast-radius controls, so the interesting checks
 * are the refusals: a schedule too fast to afford, a wall clock that survives a
 * DST changeover, a tool call that must stop and ask, an expired approval that
 * must not execute. The happy path is the easy part.
 *
 * Run:  node scripts/verify-harvey-cron-approval.mjs
 * Expects a built dist/ (npm run build).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(tmpdir(), "harvey-cron-"));
process.env.HARVEY_TASKS_DB_PATH = path.join(tmp, "tasks.db");
process.env.HARVEY_CRON_MIN_INTERVAL_MINUTES = "15";
delete process.env.HARVEY_APPROVAL_REQUIRED;
delete process.env.HARVEY_APPROVAL_STRICT;

const require_ = createRequire(import.meta.url);
const cron = require_("../dist/src/hull/cron.js");
const store = require_("../dist/src/core/harveyTaskStore.js");
const approval = require_("../dist/src/hull/approval.js");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const TZ = "America/Chicago";
/** Wall clock in a zone, for asserting that a fire time is the right local time. */
function wall(ms, tz = TZ) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(ms));
}

// ───────────────────────── CRON PARSING ─────────────────────────
console.log("\nCRON — parsing and what it refuses");

check("a plain 5-field expression parses", !!cron.parseCron("0 7 * * 1-5"));
check("@daily macro parses", cron.parseCron("@daily").hours[0] === 0);
check("step syntax expands", cron.parseCron("*/15 * * * *").minutes.length === 4);
check("month names parse", cron.parseCron("0 0 1 jan *").months[0] === 1);
check("day names parse", cron.parseCron("0 9 * * mon").dows[0] === 1);
check("sunday as 7 folds to 0", cron.parseCron("0 9 * * 7").dows[0] === 0);

let threw = false;
try { cron.parseCron("0 0 * * * *"); } catch (e) { threw = /6-field/.test(e.message); }
check("a 6-field (seconds) expression is REFUSED with a useful message", threw);

threw = false;
try { cron.parseCron("99 * * * *"); } catch { threw = true; }
check("an out-of-range minute is refused", threw);

threw = false;
try { cron.parseCron("nonsense"); } catch { threw = true; }
check("garbage is refused", threw);

// ───────────────────── MINIMUM INTERVAL (COST) ─────────────────────
console.log("\nCOST FLOOR — a schedule is a standing instruction to spend");

check("every-minute is refused", cron.validateSchedule("* * * * *", TZ).ok === false);
check("the refusal explains the floor", /floor is 15/.test(cron.validateSchedule("* * * * *", TZ).error || ""));
check("every 5 minutes is refused under a 15 minute floor", cron.validateSchedule("*/5 * * * *", TZ).ok === false);
check("every 15 minutes is allowed", cron.validateSchedule("*/15 * * * *", TZ).ok === true);
check("a daily schedule is allowed", cron.validateSchedule("0 7 * * 1-5", TZ).ok === true);
check("an invalid timezone falls back to Central rather than throwing",
  cron.validateSchedule("0 7 * * *", "Not/AZone").timezone === "America/Chicago");

// ───────────────────── NEXT RUN, DST INCLUDED ─────────────────────
console.log("\nNEXT RUN — wall clock is the promise, not elapsed milliseconds");

// A Wednesday in winter (CST) and one in summer (CDT). "7am" must be 07:00 both times.
const winter = Date.UTC(2027, 0, 13, 12, 0); // 2027-01-13 06:00 CST
const summer = Date.UTC(2027, 6, 14, 12, 0); // 2027-07-14 07:00 CDT
const w = cron.nextRun("0 7 * * 1-5", TZ, winter);
const s = cron.nextRun("0 7 * * 1-5", TZ, summer);
check("fires at 07:00 local in winter (CST)", /07:00/.test(wall(w)), wall(w));
check("fires at 07:00 local in summer (CDT)", /07:00/.test(wall(s)), wall(s));
check("the two are different UTC offsets, so DST was actually applied",
  new Date(w).getUTCHours() !== new Date(s).getUTCHours());

// Spring forward 2027-03-14: 2:00 -> 3:00 local. A 2:30 schedule cannot happen.
const beforeSpring = Date.UTC(2027, 2, 14, 6, 0); // 00:00 CST that morning
const springRun = cron.nextRun("30 2 * * *", TZ, beforeSpring);
check("a nonexistent wall clock still yields a real future instant", springRun > beforeSpring);
check("and it is strictly after the reference time", springRun !== null && springRun > beforeSpring);

// Fall back 2027-11-07: 1:30 happens twice; we take the first.
const beforeFall = Date.UTC(2027, 10, 7, 4, 0);
const fallRun = cron.nextRun("30 1 * * *", TZ, beforeFall);
check("an ambiguous wall clock resolves to a single instant", typeof fallRun === "number");

check("next run is strictly in the future", cron.nextRun("*/15 * * * *", TZ, Date.now()) > Date.now());
check("an impossible date returns null rather than hanging", cron.nextRun("0 0 30 2 *", TZ, Date.now()) === null);

// ───────────────────── ENGLISH → CRON ─────────────────────
console.log("\nPLAIN ENGLISH — what an operator actually types");

check('"every weekday at 7am" → 0 7 * * 1-5', cron.parseNaturalSchedule("every weekday at 7am") === "0 7 * * 1-5");
check('"every day at 7:30am" → 30 7 * * *', cron.parseNaturalSchedule("every day at 7:30am") === "30 7 * * *");
check('"daily at 6pm" → 0 18 * * *', cron.parseNaturalSchedule("daily at 6pm") === "0 18 * * *");
check('"every monday at 9am" → 0 9 * * 1', cron.parseNaturalSchedule("every monday at 9am") === "0 9 * * 1");
check('"hourly" → 0 * * * *', cron.parseNaturalSchedule("hourly") === "0 * * * *");
check('"every 30 minutes" → */30 * * * *', cron.parseNaturalSchedule("every 30 minutes") === "*/30 * * * *");
check('"noon" is 12:00 not 00:00', cron.parseNaturalSchedule("every day at noon") === "0 12 * * *");
check('"midnight" is 00:00', cron.parseNaturalSchedule("every day at midnight") === "0 0 * * *");
check("a raw cron expression passes through", cron.parseNaturalSchedule("0 7 * * 1-5") === "0 7 * * 1-5");
check("something vague returns null instead of guessing a schedule",
  cron.parseNaturalSchedule("sometime when you get a chance") === null);

console.log("\nDESCRIBE — the label the operator reads back");
check("weekday schedule reads as Weekdays", /Weekdays/.test(cron.describeCron("0 7 * * 1-5", TZ)));
check("and names the time", /7:00 AM/.test(cron.describeCron("0 7 * * 1-5", TZ)));
check("interval schedule reads as an interval", cron.describeCron("*/30 * * * *", TZ) === "Every 30 minutes");
check("named day reads as the day", /Monday/.test(cron.describeCron("0 9 * * 1", TZ)));

// ───────────────────────── TASK STORE ─────────────────────────
console.log("\nTASK STORE — durable, because a timer dies with the machine");

const task = store.createTask({
  title: "Morning pipeline report",
  prompt: "Summarise new leads and what needs a call today.",
  cron: "0 7 * * 1-5",
  timezone: TZ,
  deliver: "chat",
  createdBy: "marco",
});
check("a task is created", !!task.id);
check("it computes a next run", !!task.nextRunAt);
check("it carries a human schedule label", /Weekdays/.test(task.scheduleLabel));
check("it starts enabled", task.enabled === true);
check("it has a per-run cost ceiling", task.maxCostUsd > 0);

check("it appears in the list", store.listTasks().some((t) => t.id === task.id));
check("it can be read back", store.getTask(task.id)?.title === "Morning pipeline report");

const paused = store.updateTask(task.id, { enabled: false });
check("pausing clears the next run so it cannot fire while paused", paused.nextRunAt === null);
const resumed = store.updateTask(task.id, { enabled: true });
check("resuming recomputes a future next run", new Date(resumed.nextRunAt).getTime() > Date.now());

// Due detection + claim
const dueTask = store.createTask({
  title: "Due now", prompt: "do the thing", cron: "0 7 * * *", timezone: TZ,
});
store.getHarveyTaskDb()
  .prepare("UPDATE harvey_tasks SET next_run_at = ? WHERE id = ?")
  .run(new Date(Date.now() - 60000).toISOString(), dueTask.id);
check("a past next_run_at makes the task due", store.dueTasks().some((t) => t.id === dueTask.id));

const claimed = store.claimTask(dueTask.id);
check("claiming advances next_run_at into the future (no reboot re-fire loop)",
  new Date(claimed.nextRunAt).getTime() > Date.now());
check("and it is no longer due", !store.dueTasks().some((t) => t.id === dueTask.id));

// Runs + failure pausing
const run1 = store.startRun(dueTask.id, "manual");
check("a run is recorded as started", !!run1.id && run1.ok === null);
store.finishRun(run1.id, dueTask.id, { ok: true, costUsd: 0.0031, output: "done" });
check("a finished run stores its cost", store.listRuns(dueTask.id)[0].costUsd === 0.0031);
check("success resets the failure counter", store.getTask(dueTask.id).consecutiveFailures === 0);
check("success sets last status ok", store.getTask(dueTask.id).lastStatus === "ok");

let pausedFlag = false;
for (let i = 0; i < 3; i++) {
  const r = store.startRun(dueTask.id, "schedule");
  pausedFlag = store.finishRun(r.id, dueTask.id, { ok: false, error: "boom" }).paused;
}
check("three consecutive failures pause the task instead of retrying forever", pausedFlag === true);
check("the paused task is disabled", store.getTask(dueTask.id).enabled === false);
check("and has no next run", store.getTask(dueTask.id).nextRunAt === null);

check("reconcile rebuilds next runs after downtime", store.reconcileNextRuns() >= 1);
check("deleting a task removes it", store.deleteTask(dueTask.id) && !store.getTask(dueTask.id));

// ───────────────────────── APPROVAL GATE ─────────────────────────
console.log("\nAPPROVAL — enforced in code, because a prompt is not a control");

approval.__resetApprovals();

check("sending an email needs approval", approval.needsApproval("gmail_send", { to: "a@b.com" }));
check("sending WhatsApp needs approval", approval.needsApproval("whatsapp_send", { to: "jahan" }));
check("queueing a text to a contact needs approval", approval.needsApproval("schedule_message", { leadId: "L1" }));
check("running a script needs approval", approval.needsApproval("run_script", {}));
check("deleting a file needs approval", approval.needsApproval("delete_file", { path: "x" }));
check("changing agent logic needs approval", approval.needsApproval("change_agent_logic", {}));

check("reading a lead does NOT need approval", !approval.needsApproval("get_lead", { id: "L1" }));
check("searching does NOT need approval", !approval.needsApproval("search_leads", { query: "x" }));
check("an internal CRM write does NOT need approval", !approval.needsApproval("update_lead", { id: "L1" }));

/* The argument-aware case: one tool, two very different blast radii. */
check("crm_api GET is a read", approval.classifyToolCall("crm_api", { method: "GET", path: "/api/leads" }).level === "low");
check("crm_api DELETE is high risk", approval.classifyToolCall("crm_api", { method: "DELETE", path: "/api/leads/1" }).level === "high");
check("crm_api POST needs approval", approval.needsApproval("crm_api", { method: "POST", path: "/api/leads" }));
check("and the reason names the method and path",
  /DELETE/.test(approval.classifyToolCall("crm_api", { method: "DELETE", path: "/api/x" }).reason));

check("a browser click is medium risk", approval.classifyToolCall("browser_click", {}).level === "medium");
check("medium is allowed by default", !approval.needsApproval("browser_click", {}));
process.env.HARVEY_APPROVAL_STRICT = "true";
check("strict mode holds medium risk too", approval.needsApproval("browser_click", {}));
delete process.env.HARVEY_APPROVAL_STRICT;

process.env.HARVEY_APPROVAL_REQUIRED = "false";
check("the kill switch disables the gate", !approval.needsApproval("gmail_send", { to: "a@b.com" }));
delete process.env.HARVEY_APPROVAL_REQUIRED;
check("and removing it re-arms the gate", approval.needsApproval("gmail_send", { to: "a@b.com" }));

const req = approval.requestApproval({
  tool: "gmail_send",
  args: { to: "buyer@example.com", subject: "Your listing alerts" },
  sessionId: "s1",
});
check("an approval is created pending", req.status === "pending");
check("the summary is written for a human, not a JSON dump",
  req.summary === 'Email "Your listing alerts" to buyer@example.com', req.summary);
check("it appears in the pending list", approval.listPendingApprovals().some((a) => a.id === req.id));
check("it is scoped to its session", approval.listPendingApprovals("s1").length === 1);
check("and not to another session", approval.listPendingApprovals("other").length === 0);

const held = approval.heldToolResultText(req);
check("the model is told the action did NOT run", /has NOT run/.test(held));
check("the model is told not to work around it", /work around it/.test(held));
check("the model is told not to claim it is done", /do not tell the operator it is done/i.test(held));

check("approving marks it approved", approval.decideApproval(req.id, "approved", { by: "marco" }).status === "approved");
check("it leaves the pending list once decided", !approval.listPendingApprovals().some((a) => a.id === req.id));
check("the same approval cannot be decided twice (no replay)", approval.decideApproval(req.id, "approved") === null);

const denied = approval.requestApproval({ tool: "run_script", args: {}, sessionId: "s1" });
check("denying records the reason", approval.decideApproval(denied.id, "denied", { reason: "not now" }).denyReason === "not now");

/* Fails closed: an approval that expired is not executable. */
const stale = approval.requestApproval({ tool: "gmail_send", args: { to: "x@y.com" }, sessionId: "s2" });
stale.expiresAt = new Date(Date.now() - 1000).toISOString();
check("an expired approval cannot be approved (fails closed)", approval.decideApproval(stale.id, "approved") === null);
check("and it is not listed as pending", !approval.listPendingApprovals().some((a) => a.id === stale.id));

rmSync(tmp, { recursive: true, force: true });

const total = pass + fail;
console.log(`\n${pass}/${total} checks passed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
