/**
 * The ticker that runs Harvey's scheduled tasks.
 *
 * WHY IT HOLDS NO STATE. Fly restarts this machine for its own reasons, and a
 * scheduler that kept "what is due" in memory would lose it silently — the
 * report simply would not arrive, which is the failure nobody notices. So the
 * loop is: ask the table what is due, claim it (which moves its next fire
 * forward BEFORE the run, so a crash cannot produce a re-fire loop on every
 * boot), run it, record what happened.
 *
 * WHY ONE AT A TIME. This is a 2 GB machine that also runs a Python video
 * sidecar. Two agent runs in parallel is how it gets OOM-killed, and a task that
 * is a few seconds late costs nothing.
 *
 * WHY A SCHEDULED RUN IS MORE CONSTRAINED THAN A CHAT. Nobody is watching. So a
 * scheduled run gets its own per-run cost ceiling, is refused outright when the
 * daily budget is gone, and keeps the approval gate ARMED — which means a task
 * can draft the email and must still wait for a human before it sends. A cron
 * that could send on its own is a cron that can text 1,300 people at 3am.
 */
import { finishRun, claimTask, dueTasks, getTask, reconcileNextRuns, startRun, type HarveyTask } from "../core/harveyTaskStore.js";
import { sessionCostUsd, spentToday, getCaps } from "../core/aiUsageStore.js";

/** How often the loop looks for work. Cheap: one indexed query. */
const TICK_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function cronEnabled(): boolean {
  const v = process.env.HARVEY_CRON_ENABLED?.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off" || v === "no");
}

/**
 * Run one task now. Exported so "Run now" in the UI and the ticker share exactly
 * one code path — a manual run that behaved differently from the scheduled one
 * would make testing a schedule meaningless.
 */
export async function runTaskNow(
  taskId: string,
  trigger: "schedule" | "manual" = "manual",
): Promise<{ ok: boolean; runId: string; output?: string; error?: string; costUsd: number }> {
  const task = getTask(taskId);
  if (!task) return { ok: false, runId: "", error: `No task ${taskId}`, costUsd: 0 };

  const run = startRun(task.id, trigger);
  const sessionId = `task:${task.id}:${run.id}`;

  /* Budget is checked before the model is ever reached. An unmade request is the
     only one that is guaranteed free. */
  const caps = getCaps();
  const spent = spentToday();
  if (spent >= caps.dailyCapUsd) {
    const error =
      `Skipped: Harvey's daily spend cap ($${caps.dailyCapUsd.toFixed(2)}) is already used ` +
      `($${spent.toFixed(2)}). The task was not run and will try again on its next schedule.`;
    finishRun(run.id, task.id, { ok: false, error });
    return { ok: false, runId: run.id, error, costUsd: 0 };
  }

  try {
    const { runAgentLoop } = await import("./agentLoop.js");
    const result = await runAgentLoop({
      message: taskPrompt(task),
      sessionId,
      fullMode: true,
      job: "agent",
      /* Scheduled work is unattended, so the gate stays on regardless of how a
         live chat happens to be configured. */
      approvalMode: "on",
      maxCostUsd: task.maxCostUsd,
    });

    /* Cost is read back from the usage ledger by session rather than trusted
       from the return value: a turn that died partway still spent money, and the
       ledger is the row the provider actually billed. */
    const costUsd = sessionCostUsd(sessionId);

    /* A run stopped by the spend cap or a provider outage is a FAILURE, not a
       quiet success with an apology in the output. The agent loop deliberately
       answers with a sentence rather than throwing — right for a live chat,
       wrong here, because a task that records "ok" every morning while
       delivering "I could not reach a model" looks healthy in the list and
       never trips the pause. */
    const failure = result.budgetRefused || result.modelError;
    if (failure) {
      finishRun(run.id, task.id, { ok: false, costUsd, error: failure });
      return { ok: false, runId: run.id, error: failure, costUsd };
    }

    const held = result.approvals?.length
      ? `\n\n(${result.approvals.length} action${result.approvals.length === 1 ? "" : "s"} waiting on your approval.)`
      : "";
    const output = `${result.speech}${held}`;

    const { paused } = finishRun(run.id, task.id, { ok: true, costUsd, output });
    if (paused) console.warn(`[HarveyCron] task ${task.id} paused after repeated failures`);
    return { ok: true, runId: run.id, output, costUsd };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const costUsd = sessionCostUsd(sessionId);
    const { paused } = finishRun(run.id, task.id, { ok: false, costUsd, error });
    if (paused) {
      console.warn(
        `[HarveyCron] task "${task.title}" (${task.id}) paused after 3 consecutive failures. Last error: ${error}`,
      );
    }
    return { ok: false, runId: run.id, error, costUsd };
  }
}

/**
 * What the model is actually asked when a task fires.
 *
 * The stored prompt is wrapped rather than sent bare because a scheduled run has
 * no conversation behind it: it needs to be told that nobody is watching, that
 * the reply is the deliverable, and that it cannot ask a follow-up question and
 * wait for an answer that will never come.
 */
function taskPrompt(task: HarveyTask): string {
  return [
    `SCHEDULED TASK: ${task.title}`,
    `This is an automatic run on the schedule "${task.scheduleLabel}". Nobody is at the keyboard.`,
    `Your reply IS the deliverable, so write it as the finished thing, not as a plan or a question.`,
    `If something is genuinely missing, say exactly what is missing rather than guessing at it.`,
    `Anything that sends to a real person still requires approval and will be held for one.`,
    "",
    task.prompt,
  ].join("\n");
}

async function tick(): Promise<void> {
  if (running || !cronEnabled()) return;
  running = true;
  try {
    const due = dueTasks();
    for (const task of due) {
      // Claim first: the next fire moves forward before any work happens.
      claimTask(task.id);
      try {
        await runTaskNow(task.id, "schedule");
      } catch (err) {
        console.error(`[HarveyCron] task ${task.id} threw outside its own handler:`, err);
      }
    }
  } catch (err) {
    console.error("[HarveyCron] tick failed:", err);
  } finally {
    running = false;
  }
}

/** Start the loop. Safe to call twice; the second call is a no-op. */
export function startTaskScheduler(): void {
  if (timer) return;
  if (!cronEnabled()) {
    console.log("[HarveyCron] disabled (HARVEY_CRON_ENABLED=false)");
    return;
  }

  /* Rebuild every next fire at boot. After downtime a stored next_run_at can be
     hours in the past, and firing all of them at once would be a stampede that
     spends the daily cap in a minute. */
  const reconciled = reconcileNextRuns();
  console.log(`[HarveyCron] started; ${reconciled} task(s) scheduled`);

  timer = setInterval(() => void tick(), TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopTaskScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: run one pass synchronously. */
export async function __tickOnce(): Promise<void> {
  await tick();
}
