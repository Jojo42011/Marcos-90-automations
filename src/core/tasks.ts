import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { Task, TaskPriority, TaskSource, TaskStatus, TaskType } from "./types.js";
import { CRM_TASK_STATUSES } from "./types.js";

function resolveTasksPath(): string {
  const explicit = process.env.TASKS_JSON_PATH?.trim();
  if (explicit) return explicit;
  const flyDb = "/data/db.json";
  const localDb = join(process.cwd(), "data", "local-dashboard-db.json");
  const dbPath = process.env.DB_JSON_PATH?.trim() || (existsSync(flyDb) ? flyDb : localDb);
  return join(dirname(dbPath), "tasks.json");
}

const TASKS_PATH = resolveTasksPath();

const PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);
const STATUSES = new Set<TaskStatus>(CRM_TASK_STATUSES);
const TYPES = new Set<TaskType>([
  "call", "text", "email", "appointment", "follow_up", "other",
  "to_do", "mail", "social_media", "door_knock",
]);
const APPT_STATUSES = new Set(["scheduled", "completed", "cancelled"]);
const APPT_OUTCOMES = new Set(["none", "held", "no_show", "rescheduled"]);
const CONTINGENT_EVENTS = new Set([
  "birthday", "anniversary", "organization_end_date", "licensed_since", "organization_start_date",
]);

/** A contingency is kept only when all three parts are usable. */
function normalizeContingency(raw: unknown): import("./types.js").TaskContingency | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const days = typeof c.days === "number" && Number.isFinite(c.days) ? Math.round(c.days) : NaN;
  if (!Number.isFinite(days) || days < 0 || days > 3650) return undefined;
  const direction = c.direction === "before" ? "before" : c.direction === "after" ? "after" : null;
  if (!direction) return undefined;
  if (typeof c.event !== "string" || !CONTINGENT_EVENTS.has(c.event)) return undefined;
  return { days, direction, event: c.event as import("./types.js").ContingentEvent };
}
const SOURCES = new Set<TaskSource>(["manual", "auto_plan", "dial_session", "automation"]);

function nowIso(): string {
  return new Date().toISOString();
}

function genTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function dateKey(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const title = typeof t.title === "string" ? t.title.trim() : "";
  const dueDate = typeof t.dueDate === "string" ? t.dueDate.slice(0, 10) : "";
  if (!title || !dueDate) return null;
  const priority = PRIORITIES.has(t.priority as TaskPriority) ? (t.priority as TaskPriority) : "normal";
  const status = STATUSES.has(t.status as TaskStatus) ? (t.status as TaskStatus) : "pending";
  const type = TYPES.has(t.type as TaskType) ? (t.type as TaskType) : "other";
  const source = SOURCES.has(t.source as TaskSource) ? (t.source as TaskSource) : "manual";
  return {
    id: typeof t.id === "string" && t.id ? t.id : genTaskId(),
    title,
    description: typeof t.description === "string" ? t.description : undefined,
    type,
    priority,
    status,
    previousStatus: STATUSES.has(t.previousStatus as TaskStatus)
      ? (t.previousStatus as TaskStatus)
      : undefined,
    dueDate,
    dueTime: typeof t.dueTime === "string" ? t.dueTime : undefined,
    leadId: typeof t.leadId === "string" && t.leadId.trim() ? t.leadId.trim() : undefined,
    leadName: typeof t.leadName === "string" ? t.leadName : undefined,
    assignedUserId: typeof t.assignedUserId === "string" ? t.assignedUserId : undefined,
    assignedUserName: typeof t.assignedUserName === "string" ? t.assignedUserName : undefined,
    completedAt: typeof t.completedAt === "string" ? t.completedAt : undefined,
    completedBy: typeof t.completedBy === "string" ? t.completedBy : undefined,
    createdAt: typeof t.createdAt === "string" ? t.createdAt : nowIso(),
    updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : nowIso(),
    source,
    reminderMinutes: typeof t.reminderMinutes === "number" ? t.reminderMinutes : undefined,
    /* Everything below MUST be listed here. This function rebuilds each task
       from a fixed field list on every read, so a key it does not know about
       is destroyed on the next write — which is exactly how checklists were
       silently lost (FORAI, 2026-08-09). */
    location: typeof t.location === "string" && t.location.trim() ? t.location.trim().slice(0, 400) : undefined,
    instructions: typeof t.instructions === "string" && t.instructions.trim() ? t.instructions.slice(0, 4000) : undefined,
    taskNotes: typeof t.taskNotes === "string" && t.taskNotes.trim() ? t.taskNotes.slice(0, 4000) : undefined,
    recurring: t.recurring === true ? true : undefined,
    recurringInterval:
      typeof t.recurringInterval === "string" && t.recurringInterval.trim() ? t.recurringInterval.trim() : undefined,
    contingent: normalizeContingency(t.contingent),
    appointmentType:
      typeof t.appointmentType === "string" && t.appointmentType.trim() ? t.appointmentType.trim().slice(0, 120) : undefined,
    appointmentStatus: APPT_STATUSES.has(t.appointmentStatus as string)
      ? (t.appointmentStatus as import("./types.js").AppointmentStatus)
      : undefined,
    outcome: APPT_OUTCOMES.has(t.outcome as string)
      ? (t.outcome as import("./types.js").AppointmentOutcome)
      : undefined,
  };
}

/**
 * Resolve a contingent rule into a real due date using a date on the contact.
 *
 * Returns null when the contact has no such date — and that is the whole point
 * of returning null rather than defaulting to today: "3 days before their
 * anniversary" for somebody with no anniversary on file is not a task due
 * today, it is a task that cannot be dated, and the caller has to say so.
 */
export function resolveContingentDue(
  rule: import("./types.js").TaskContingency,
  dates: { birthday?: string | null; homeAnniversary?: string | null; licensedSince?: string | null;
           organizationStartDate?: string | null; organizationEndDate?: string | null },
): string | null {
  const pick: Record<string, string | null | undefined> = {
    birthday: dates.birthday,
    anniversary: dates.homeAnniversary,
    licensed_since: dates.licensedSince,
    organization_start_date: dates.organizationStartDate,
    organization_end_date: dates.organizationEndDate,
  };
  const base = pick[rule.event];
  if (typeof base !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(base)) return null;
  const ms = Date.UTC(Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 1, Number(base.slice(8, 10)));
  /* Birthdays and anniversaries recur, so the rule means the NEXT one — a task
     three days before a birthday that already passed this year is due next
     year, not eleven months ago. Fixed one-off dates are used as they are. */
  const recurs = rule.event === "birthday" || rule.event === "anniversary";
  let target = ms;
  if (recurs) {
    const now = new Date();
    const thisYear = Date.UTC(now.getUTCFullYear(), Number(base.slice(5, 7)) - 1, Number(base.slice(8, 10)));
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    target = thisYear >= todayMs ? thisYear : Date.UTC(now.getUTCFullYear() + 1, Number(base.slice(5, 7)) - 1, Number(base.slice(8, 10)));
  }
  const shifted = target + (rule.direction === "before" ? -1 : 1) * rule.days * 86400000;
  return new Date(shifted).toISOString().slice(0, 10);
}

function writeTasksFile(tasks: Task[]): void {
  mkdirSync(dirname(TASKS_PATH), { recursive: true });
  writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2), "utf8");
}

export function getTasks(): Task[] {
  try {
    if (!existsSync(TASKS_PATH)) return [];
    const raw = readFileSync(TASKS_PATH, "utf8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTask).filter((t): t is Task => t !== null);
  } catch (err) {
    console.error("[tasks] getTasks failed:", err);
    return [];
  }
}

export function saveTasks(tasks: Task[]): void {
  try {
    writeTasksFile(tasks);
  } catch (err) {
    console.error("[tasks] saveTasks failed:", err);
  }
}

export function getTaskById(id: string): Task | null {
  return getTasks().find((t) => t.id === id) ?? null;
}

export function getTasksByLead(leadId: string): Task[] {
  return getTasks().filter((t) => t.leadId === leadId);
}

function isCrmActiveStatus(status: TaskStatus): boolean {
  return (
    status === "pending" ||
    status === "in_progress" ||
    status === "due_soon" ||
    status === "overdue"
  );
}

function isCrmTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "cancelled";
}

export function getTasksDueToday(): Task[] {
  const today = todayKey();
  return getTasks().filter(
    (t) =>
      !isCrmTerminal(t.status) &&
      t.status !== "on_hold" &&
      (t.status === "due_soon" || dateKey(t.dueDate) === today),
  );
}

export function getOverdueTasks(): Task[] {
  const today = todayKey();
  return getTasks().filter(
    (t) =>
      !isCrmTerminal(t.status) &&
      t.status !== "on_hold" &&
      (t.status === "overdue" || dateKey(t.dueDate) < today),
  );
}

export function buildTasksSummary(): import("./types.js").TasksSummary {
  const tasks = getTasks();
  const today = todayKey();
  let dueToday = 0;
  let overdue = 0;
  let pending = 0;
  let completedToday = 0;
  for (const t of tasks) {
    const dk = dateKey(t.dueDate);
    if (isCrmActiveStatus(t.status)) {
      pending += 1;
      if (t.status === "due_soon" && dk === today) dueToday += 1;
      else if (dk === today && t.status !== "overdue") dueToday += 1;
      if (t.status === "overdue" || dk < today) overdue += 1;
    }
    if (t.status === "completed" && t.completedAt && dateKey(t.completedAt) === today) {
      completedToday += 1;
    }
  }
  return { dueToday, overdue, pending, completedToday };
}

export function createTask(data: Omit<Task, "id" | "createdAt" | "updatedAt">): Task {
  const now = nowIso();
  const task: Task = {
    ...data,
    id: genTaskId(),
    createdAt: now,
    updatedAt: now,
  };
  const tasks = getTasks();
  tasks.unshift(task);
  saveTasks(tasks);
  return task;
}

export function updateTask(id: string, updates: Partial<Task>): Task | null {
  const tasks = getTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const prev = tasks[idx];
  const next: Task = {
    ...prev,
    ...updates,
    id: prev.id,
    updatedAt: nowIso(),
  };
  tasks[idx] = next;
  saveTasks(tasks);
  return next;
}

export function deleteTask(id: string): boolean {
  const tasks = getTasks();
  const filtered = tasks.filter((t) => t.id !== id);
  if (filtered.length === tasks.length) return false;
  saveTasks(filtered);
  return true;
}

export function filterTasks(opts: {
  status?: string;
  assignedUserId?: string;
  leadId?: string;
  dueDate?: string;
}): Task[] {
  let list = getTasks();
  if (opts.status) list = list.filter((t) => t.status === opts.status);
  if (opts.assignedUserId) list = list.filter((t) => t.assignedUserId === opts.assignedUserId);
  if (opts.leadId) list = list.filter((t) => t.leadId === opts.leadId);
  if (opts.dueDate) list = list.filter((t) => dateKey(t.dueDate) === opts.dueDate.slice(0, 10));
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
