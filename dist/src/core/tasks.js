"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTasks = getTasks;
exports.saveTasks = saveTasks;
exports.getTaskById = getTaskById;
exports.getTasksByLead = getTasksByLead;
exports.getTasksDueToday = getTasksDueToday;
exports.getOverdueTasks = getOverdueTasks;
exports.buildTasksSummary = buildTasksSummary;
exports.createTask = createTask;
exports.updateTask = updateTask;
exports.deleteTask = deleteTask;
exports.filterTasks = filterTasks;
const fs_1 = require("fs");
const path_1 = require("path");
function resolveTasksPath() {
    const explicit = process.env.TASKS_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDb = "/data/db.json";
    const localDb = (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
    const dbPath = process.env.DB_JSON_PATH?.trim() || ((0, fs_1.existsSync)(flyDb) ? flyDb : localDb);
    return (0, path_1.join)((0, path_1.dirname)(dbPath), "tasks.json");
}
const TASKS_PATH = resolveTasksPath();
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);
const TYPES = new Set(["call", "text", "email", "appointment", "follow_up", "other"]);
const SOURCES = new Set(["manual", "auto_plan", "dial_session", "automation"]);
function nowIso() {
    return new Date().toISOString();
}
function genTaskId() {
    return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function dateKey(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime()))
        return "";
    return d.toISOString().slice(0, 10);
}
function todayKey() {
    return new Date().toISOString().slice(0, 10);
}
function normalizeTask(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const t = raw;
    const title = typeof t.title === "string" ? t.title.trim() : "";
    const dueDate = typeof t.dueDate === "string" ? t.dueDate.slice(0, 10) : "";
    if (!title || !dueDate)
        return null;
    const priority = PRIORITIES.has(t.priority) ? t.priority : "normal";
    const status = STATUSES.has(t.status) ? t.status : "pending";
    const type = TYPES.has(t.type) ? t.type : "other";
    const source = SOURCES.has(t.source) ? t.source : "manual";
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
function writeTasksFile(tasks) {
    (0, fs_1.mkdirSync)((0, path_1.dirname)(TASKS_PATH), { recursive: true });
    (0, fs_1.writeFileSync)(TASKS_PATH, JSON.stringify(tasks, null, 2), "utf8");
}
function getTasks() {
    try {
        if (!(0, fs_1.existsSync)(TASKS_PATH))
            return [];
        const raw = (0, fs_1.readFileSync)(TASKS_PATH, "utf8");
        if (!raw.trim())
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.map(normalizeTask).filter((t) => t !== null);
    }
    catch (err) {
        console.error("[tasks] getTasks failed:", err);
        return [];
    }
}
function saveTasks(tasks) {
    try {
        writeTasksFile(tasks);
    }
    catch (err) {
        console.error("[tasks] saveTasks failed:", err);
    }
}
function getTaskById(id) {
    return getTasks().find((t) => t.id === id) ?? null;
}
function getTasksByLead(leadId) {
    return getTasks().filter((t) => t.leadId === leadId);
}
function getTasksDueToday() {
    const today = todayKey();
    return getTasks().filter((t) => t.status !== "completed" && t.status !== "cancelled" && dateKey(t.dueDate) === today);
}
function getOverdueTasks() {
    const today = todayKey();
    return getTasks().filter((t) => t.status !== "completed" && t.status !== "cancelled" && dateKey(t.dueDate) < today);
}
function buildTasksSummary() {
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
            if (dk === today)
                dueToday += 1;
            else if (dk < today)
                overdue += 1;
        }
        if (t.status === "completed" && t.completedAt && dateKey(t.completedAt) === today) {
            completedToday += 1;
        }
    }
    return { dueToday, overdue, pending, completedToday };
}
function createTask(data) {
    const now = nowIso();
    const task = {
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
function updateTask(id, updates) {
    const tasks = getTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0)
        return null;
    const prev = tasks[idx];
    const next = {
        ...prev,
        ...updates,
        id: prev.id,
        updatedAt: nowIso(),
    };
    tasks[idx] = next;
    saveTasks(tasks);
    return next;
}
function deleteTask(id) {
    const tasks = getTasks();
    const filtered = tasks.filter((t) => t.id !== id);
    if (filtered.length === tasks.length)
        return false;
    saveTasks(filtered);
    return true;
}
function filterTasks(opts) {
    let list = getTasks();
    if (opts.status)
        list = list.filter((t) => t.status === opts.status);
    if (opts.assignedUserId)
        list = list.filter((t) => t.assignedUserId === opts.assignedUserId);
    if (opts.leadId)
        list = list.filter((t) => t.leadId === opts.leadId);
    if (opts.dueDate)
        list = list.filter((t) => dateKey(t.dueDate) === opts.dueDate.slice(0, 10));
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
