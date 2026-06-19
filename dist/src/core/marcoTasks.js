"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMarcoTasks = getMarcoTasks;
exports.saveMarcoTasks = saveMarcoTasks;
exports.sortMarcoTasks = sortMarcoTasks;
exports.buildMarcoTasksSummary = buildMarcoTasksSummary;
exports.seedMarcoTasksIfEmpty = seedMarcoTasksIfEmpty;
exports.createMarcoTask = createMarcoTask;
exports.updateMarcoTask = updateMarcoTask;
exports.deleteMarcoTask = deleteMarcoTask;
exports.getMarcoTaskById = getMarcoTaskById;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const types_js_1 = require("./types.js");
function resolveMarcoTasksPath() {
    const base = (0, fs_1.existsSync)("/data") ? "/data" : (0, path_1.join)(process.cwd(), "data");
    return (0, path_1.join)(base, "marco-tasks.json");
}
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
function nowIso() {
    return new Date().toISOString();
}
function normalizeTask(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const t = raw;
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!title)
        return null;
    const priority = t.priority === "high" || t.priority === "medium" || t.priority === "low"
        ? t.priority
        : "medium";
    const status = types_js_1.MARCO_TASK_STATUSES.includes(t.status)
        ? t.status
        : "pending";
    return {
        id: typeof t.id === "string" && t.id ? t.id : (0, crypto_1.randomUUID)(),
        title,
        description: typeof t.description === "string" ? t.description : undefined,
        dueDate: typeof t.dueDate === "string" ? t.dueDate.slice(0, 10) : undefined,
        priority,
        status,
        previousStatus: types_js_1.MARCO_TASK_STATUSES.includes(t.previousStatus)
            ? t.previousStatus
            : undefined,
        createdBy: typeof t.createdBy === "string" ? t.createdBy : undefined,
        createdAt: typeof t.createdAt === "string" ? t.createdAt : nowIso(),
        updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : nowIso(),
        completedAt: typeof t.completedAt === "string" ? t.completedAt : undefined,
    };
}
function getMarcoTasks() {
    try {
        const p = resolveMarcoTasksPath();
        if (!(0, fs_1.existsSync)(p))
            return [];
        const parsed = JSON.parse((0, fs_1.readFileSync)(p, "utf8"));
        if (!Array.isArray(parsed))
            return [];
        return parsed.map(normalizeTask).filter((t) => t !== null);
    }
    catch {
        return [];
    }
}
function saveMarcoTasks(tasks) {
    const p = resolveMarcoTasksPath();
    (0, fs_1.mkdirSync)((0, path_1.dirname)(p), { recursive: true });
    (0, fs_1.writeFileSync)(p, JSON.stringify(tasks, null, 2), "utf8");
}
function sortMarcoTasks(tasks) {
    return [...tasks].sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority] ?? 1;
        const pb = PRIORITY_ORDER[b.priority] ?? 1;
        if (pa !== pb)
            return pa - pb;
        const da = a.dueDate || "9999-12-31";
        const db = b.dueDate || "9999-12-31";
        return da.localeCompare(db);
    });
}
function buildMarcoTasksSummary(tasks) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return {
        pending: tasks.filter((t) => t.status === "pending" || t.status === "due_soon").length,
        inProgress: tasks.filter((t) => t.status === "in_progress").length,
        done: tasks.filter((t) => t.status === "done").length,
        highPriority: tasks.filter((t) => t.priority === "high" && t.status !== "done" && t.status !== "on_hold").length,
        overdue: tasks.filter((t) => {
            if (t.status === "done" || t.status === "on_hold")
                return false;
            if (t.status === "overdue")
                return true;
            if (!t.dueDate)
                return false;
            const due = new Date(t.dueDate.slice(0, 10) + "T00:00:00");
            return due < now;
        }).length,
    };
}
function seedMarcoTasksIfEmpty() {
    let tasks = getMarcoTasks();
    if (tasks.length > 0)
        return tasks;
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
function createMarcoTask(data) {
    const task = {
        ...data,
        id: (0, crypto_1.randomUUID)(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
    const tasks = getMarcoTasks();
    tasks.push(task);
    saveMarcoTasks(tasks);
    return task;
}
function updateMarcoTask(id, updates) {
    const tasks = getMarcoTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1)
        return null;
    tasks[idx] = { ...tasks[idx], ...updates, updatedAt: nowIso() };
    if (updates.status === "done" && !tasks[idx].completedAt) {
        tasks[idx].completedAt = nowIso();
    }
    saveMarcoTasks(tasks);
    return tasks[idx];
}
function deleteMarcoTask(id) {
    const tasks = getMarcoTasks();
    const filtered = tasks.filter((t) => t.id !== id);
    if (filtered.length === tasks.length)
        return false;
    saveMarcoTasks(filtered);
    return true;
}
function getMarcoTaskById(id) {
    return getMarcoTasks().find((t) => t.id === id) ?? null;
}
