/**
 * Due-today / overdue Dialer queues from existing CRM task due dates.
 * Dates are calendar days in America/Chicago (team operating zone).
 * Open call / follow_up tasks only — appointments stay on the calendar path.
 */
import type { Task } from "../core/types.js";

const OPEN = new Set(["pending", "in_progress", "due_soon", "overdue"]);
const FOLLOW_TYPES = new Set(["call", "follow_up"]);

/** YYYY-MM-DD in America/Chicago. */
export function centralDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isOpenFollowUpTask(t: Pick<Task, "type" | "status" | "dueDate" | "leadId">): boolean {
  return (
    !!t.leadId &&
    FOLLOW_TYPES.has(String(t.type || "")) &&
    OPEN.has(String(t.status || "")) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(t.dueDate || "").slice(0, 10))
  );
}

/** Earliest open call/follow_up due date for a lead, or "". */
export function earliestFollowUpDueDate(
  tasks: Array<Pick<Task, "type" | "status" | "dueDate" | "leadId">>,
  leadId: string,
): string {
  let best = "";
  for (const t of tasks) {
    if (!isOpenFollowUpTask(t) || t.leadId !== leadId) continue;
    const d = String(t.dueDate).slice(0, 10);
    if (!best || d < best) best = d;
  }
  return best;
}

export type FollowUpBucket = "overdue" | "due" | "";

/**
 * overdue: dated open follow-up before today (Central).
 * due: dated open follow-up today, or crmCallQueue urgent when not overdue.
 */
export function followUpBucket(
  contact: { followUpDueDate?: string | null; crmCallQueue?: string | null },
  today = centralDateKey(),
): FollowUpBucket {
  const due = String(contact.followUpDueDate || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(due) && due < today) return "overdue";
  if (/^\d{4}-\d{2}-\d{2}$/.test(due) && due === today) return "due";
  if (contact.crmCallQueue === "urgent") return "due";
  return "";
}
