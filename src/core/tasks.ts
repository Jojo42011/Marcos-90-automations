import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { Task, TaskPriority, TaskSource, TaskStatus, TaskType } from "./types.js";

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
const STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed", "cancelled"]);
const TYPES = new Set<TaskType>(["call", "text", "email", "appointment", "follow_up", "other"]);
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
  };
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

export function getTasksDueToday(): Task[] {
  const today = todayKey();
  return getTasks().filter(
    (t) => t.status !== "completed" && t.status !== "cancelled" && dateKey(t.dueDate) === today,
  );
}

export function getOverdueTasks(): Task[] {
  const today = todayKey();
  return getTasks().filter(
    (t) => t.status !== "completed" && t.status !== "cancelled" && dateKey(t.dueDate) < today,
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
    if (t.status === "pending" || t.status === "in_progress") {
      pending += 1;
      if (dk === today) dueToday += 1;
      else if (dk < today) overdue += 1;
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
