import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { MarcoTask, MarcoTaskPriority, MarcoTasksSummary, MarcoTaskStatus } from "./types.js";

function resolveMarcoTasksPath(): string {
  const base = existsSync("/data") ? "/data" : join(process.cwd(), "data");
  return join(base, "marco-tasks.json");
}

const PRIORITY_ORDER: Record<MarcoTaskPriority, number> = { high: 0, medium: 1, low: 2 };

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTask(raw: unknown): MarcoTask | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const title = typeof t.title === "string" ? t.title.trim() : "";
  if (!title) return null;
  const priority =
    t.priority === "high" || t.priority === "medium" || t.priority === "low"
      ? t.priority
      : "medium";
  const status =
    t.status === "pending" || t.status === "in_progress" || t.status === "done"
      ? t.status
      : "pending";
  return {
    id: typeof t.id === "string" && t.id ? t.id : randomUUID(),
    title,
    description: typeof t.description === "string" ? t.description : undefined,
    dueDate: typeof t.dueDate === "string" ? t.dueDate.slice(0, 10) : undefined,
    priority,
    status,
    createdBy: typeof t.createdBy === "string" ? t.createdBy : undefined,
    createdAt: typeof t.createdAt === "string" ? t.createdAt : nowIso(),
    updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : nowIso(),
    completedAt: typeof t.completedAt === "string" ? t.completedAt : undefined,
  };
}

export function getMarcoTasks(): MarcoTask[] {
  try {
    const p = resolveMarcoTasksPath();
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTask).filter((t): t is MarcoTask => t !== null);
  } catch {
    return [];
  }
}

export function saveMarcoTasks(tasks: MarcoTask[]): void {
  const p = resolveMarcoTasksPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(tasks, null, 2), "utf8");
}

export function sortMarcoTasks(tasks: MarcoTask[]): MarcoTask[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 1;
    const pb = PRIORITY_ORDER[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    const da = a.dueDate || "9999-12-31";
    const db = b.dueDate || "9999-12-31";
    return da.localeCompare(db);
  });
}

export function buildMarcoTasksSummary(tasks: MarcoTask[]): MarcoTasksSummary {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return {
    pending: tasks.filter((t) => t.status === "pending").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
    done: tasks.filter((t) => t.status === "done").length,
    highPriority: tasks.filter((t) => t.priority === "high" && t.status !== "done").length,
    overdue: tasks.filter((t) => {
      if (!t.dueDate || t.status === "done") return false;
      const due = new Date(t.dueDate.slice(0, 10) + "T00:00:00");
      return due < now;
    }).length,
  };
}

export function seedMarcoTasksIfEmpty(): MarcoTask[] {
  let tasks = getMarcoTasks();
  if (tasks.length > 0) return tasks;

  const inTenDays = new Date();
  inTenDays.setDate(inTenDays.getDate() + 10);
  const dueStr = inTenDays.toISOString().slice(0, 10);

  tasks = [
    createMarcoTask({
      title: "Buy camera equipment",
      description: "Order new Sony camera for home tours",
      dueDate: dueStr,
      priority: "high",
      status: "pending",
      createdBy: "carlos",
    }),
    createMarcoTask({
      title: "Review Q2 marketing budget",
      description: "Go through ad spend and TikTok content costs with Carlos",
      priority: "medium",
      status: "pending",
      createdBy: "carlos",
    }),
    createMarcoTask({
      title: "Schedule team call with Carlos",
      description: "Weekly ops sync — pipeline, content, and dialer targets",
      priority: "low",
      status: "in_progress",
      createdBy: "carlos",
    }),
  ];
  return tasks;
}

export function createMarcoTask(
  data: Omit<MarcoTask, "id" | "createdAt" | "updatedAt">,
): MarcoTask {
  const task: MarcoTask = {
    ...data,
    id: randomUUID(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const tasks = getMarcoTasks();
  tasks.push(task);
  saveMarcoTasks(tasks);
  return task;
}

export function updateMarcoTask(id: string, updates: Partial<MarcoTask>): MarcoTask | null {
  const tasks = getMarcoTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  tasks[idx] = { ...tasks[idx], ...updates, updatedAt: nowIso() };
  if (updates.status === "done" && !tasks[idx].completedAt) {
    tasks[idx].completedAt = nowIso();
  }
  saveMarcoTasks(tasks);
  return tasks[idx];
}

export function deleteMarcoTask(id: string): boolean {
  const tasks = getMarcoTasks();
  const filtered = tasks.filter((t) => t.id !== id);
  if (filtered.length === tasks.length) return false;
  saveMarcoTasks(filtered);
  return true;
}

export function getMarcoTaskById(id: string): MarcoTask | null {
  return getMarcoTasks().find((t) => t.id === id) ?? null;
}
