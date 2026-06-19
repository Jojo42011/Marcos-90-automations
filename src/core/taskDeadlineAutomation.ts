import { getCommandTasks, saveCommandTasks } from "./db.js";
import { getMarcoTasks, saveMarcoTasks } from "./marcoTasks.js";
import { getTasks, saveTasks } from "./tasks.js";
import type { CommandTask, MarcoTask, Task } from "./types.js";

const DUE_SOON_MS = 48 * 60 * 60 * 1000;
const AUTO_STATUSES = new Set(["due_soon", "overdue"]);

type AutoReason = "deadline_approaching" | "deadline_passed" | "deadline_extended_reverted";

function nowIso(): string {
  return new Date().toISOString();
}

function isAutoStatus(status: string): boolean {
  return AUTO_STATUSES.has(status);
}

function endOfDayMs(dateStr: string): number {
  return new Date(dateStr.slice(0, 10) + "T23:59:59.999").getTime();
}

function parseDueTimeMs(dueDate: string, dueTime?: string): number {
  const date = dueDate.slice(0, 10);
  if (dueTime && /^\d{1,2}:\d{2}/.test(dueTime)) {
    const parts = dueTime.trim().split(":");
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1] || "0", 10);
    const s = parseInt(parts[2] || "0", 10);
    const d = new Date(`${date}T00:00:00`);
    d.setHours(h, m, s, 999);
    return d.getTime();
  }
  return endOfDayMs(date);
}

interface StatusUpdate {
  status: string;
  previousStatus?: string;
}

function reasonFor(oldStatus: string, newStatus: string): AutoReason {
  if (newStatus === "overdue") return "deadline_passed";
  if (newStatus === "due_soon") return "deadline_approaching";
  return "deadline_extended_reverted";
}

function logMove(
  store: string,
  id: string,
  oldStatus: string,
  newStatus: string,
  reason: AutoReason,
): void {
  console.log(
    `[TaskDeadline] store=${store} task=${id} ${oldStatus} -> ${newStatus} reason=${reason}`,
  );
}

function evaluateDeadline(
  status: string,
  previousStatus: string | undefined,
  deadlineMs: number,
  isTerminal: (s: string) => boolean,
  nowMs: number,
): StatusUpdate | null {
  if (isTerminal(status)) return null;
  if (status === "on_hold") return null;

  const msUntil = deadlineMs - nowMs;
  const isPast = msUntil < 0;

  if (isPast) {
    if (status !== "overdue") {
      const prev = isAutoStatus(status) ? previousStatus : status;
      return { status: "overdue", previousStatus: prev };
    }
    return null;
  }

  if (msUntil <= DUE_SOON_MS) {
    if (status !== "due_soon") {
      const prev = isAutoStatus(status) ? previousStatus : status;
      return { status: "due_soon", previousStatus: prev };
    }
    return null;
  }

  if (isAutoStatus(status) && previousStatus) {
    return { status: previousStatus, previousStatus: undefined };
  }

  return null;
}

function applyCommandUpdates(tasks: CommandTask[], nowMs: number): { tasks: CommandTask[]; moves: number } {
  let moves = 0;
  const next = tasks.map((t) => {
    if (!t.dueDate) return t;
    const upd = evaluateDeadline(
      t.status,
      t.previousStatus,
      endOfDayMs(t.dueDate),
      (s) => s === "done",
      nowMs,
    );
    if (!upd) return t;
    logMove("command", t.id, t.status, upd.status, reasonFor(t.status, upd.status));
    moves += 1;
    return {
      ...t,
      status: upd.status as CommandTask["status"],
      previousStatus: upd.previousStatus as CommandTask["previousStatus"],
      updatedAt: nowIso(),
    };
  });
  return { tasks: next, moves };
}

function applyCrmUpdates(tasks: Task[], nowMs: number): { tasks: Task[]; moves: number } {
  let moves = 0;
  const next = tasks.map((t) => {
    const upd = evaluateDeadline(
      t.status,
      t.previousStatus,
      parseDueTimeMs(t.dueDate, t.dueTime),
      (s) => s === "completed" || s === "cancelled",
      nowMs,
    );
    if (!upd) return t;
    logMove("crm", t.id, t.status, upd.status, reasonFor(t.status, upd.status));
    moves += 1;
    return {
      ...t,
      status: upd.status as Task["status"],
      previousStatus: upd.previousStatus as Task["previousStatus"],
      updatedAt: nowIso(),
    };
  });
  return { tasks: next, moves };
}

function applyMarcoUpdates(tasks: MarcoTask[], nowMs: number): { tasks: MarcoTask[]; moves: number } {
  let moves = 0;
  const next = tasks.map((t) => {
    if (!t.dueDate) return t;
    const upd = evaluateDeadline(
      t.status,
      t.previousStatus,
      endOfDayMs(t.dueDate),
      (s) => s === "done",
      nowMs,
    );
    if (!upd) return t;
    logMove("marco", t.id, t.status, upd.status, reasonFor(t.status, upd.status));
    moves += 1;
    return {
      ...t,
      status: upd.status as MarcoTask["status"],
      previousStatus: upd.previousStatus as MarcoTask["previousStatus"],
      updatedAt: nowIso(),
    };
  });
  return { tasks: next, moves };
}

export function runTaskDeadlineAutomation(): { moves: number } {
  const nowMs = Date.now();
  let totalMoves = 0;

  const cmd = applyCommandUpdates(getCommandTasks(), nowMs);
  if (cmd.moves > 0) saveCommandTasks(cmd.tasks);
  totalMoves += cmd.moves;

  const crm = applyCrmUpdates(getTasks(), nowMs);
  if (crm.moves > 0) saveTasks(crm.tasks);
  totalMoves += crm.moves;

  const marco = applyMarcoUpdates(getMarcoTasks(), nowMs);
  if (marco.moves > 0) saveMarcoTasks(marco.tasks);
  totalMoves += marco.moves;

  return { moves: totalMoves };
}

export function scheduleTaskDeadlineAutomation(): void {
  setInterval(() => {
    try {
      runTaskDeadlineAutomation();
    } catch (err) {
      console.error("[TaskDeadline] Check error:", err);
    }
  }, 15 * 60 * 1000);

  console.log("[TaskDeadline] Scheduled — checking every 15 minutes");

  try {
    runTaskDeadlineAutomation();
  } catch (err) {
    console.error("[TaskDeadline] Initial run error:", err);
  }
}
