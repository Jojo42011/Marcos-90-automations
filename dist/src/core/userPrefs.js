"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserTablePrefs = getUserTablePrefs;
exports.setUserTablePrefs = setUserTablePrefs;
const fs_1 = require("fs");
const path_1 = require("path");
const MAX_USERS = 50;
const MAX_TABLES_PER_USER = 12;
const MAX_COLS = 40;
function resolvePrefsPath() {
    const explicit = process.env.USER_PREFS_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDb = "/data/db.json";
    const localDb = (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
    const dbPath = process.env.DB_JSON_PATH?.trim() || ((0, fs_1.existsSync)(flyDb) ? flyDb : localDb);
    return (0, path_1.join)((0, path_1.dirname)(dbPath), "user-prefs.json");
}
const PREFS_PATH = resolvePrefsPath();
function readFile() {
    try {
        if (!(0, fs_1.existsSync)(PREFS_PATH))
            return {};
        const raw = (0, fs_1.readFileSync)(PREFS_PATH, "utf8");
        if (!raw.trim())
            return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch (err) {
        console.error("[userPrefs] read failed:", err);
        return {};
    }
}
function writeFileSafe(data) {
    try {
        (0, fs_1.mkdirSync)((0, path_1.dirname)(PREFS_PATH), { recursive: true });
        (0, fs_1.writeFileSync)(PREFS_PATH, JSON.stringify(data, null, 2), "utf8");
    }
    catch (err) {
        console.error("[userPrefs] write failed:", err);
    }
}
function cleanKey(raw, max = 64) {
    return typeof raw === "string" ? raw.trim().slice(0, max) : "";
}
function sanitizeTablePrefs(raw) {
    const p = raw && typeof raw === "object" ? raw : {};
    const strList = (v) => {
        if (!Array.isArray(v))
            return undefined;
        const out = v.filter((x) => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 64));
        return out.slice(0, MAX_COLS);
    };
    const out = {};
    const hidden = strList(p.hidden);
    if (hidden)
        out.hidden = hidden;
    const order = strList(p.order);
    if (order)
        out.order = order;
    if (p.sortField === null)
        out.sortField = null;
    else if (typeof p.sortField === "string" && p.sortField.trim())
        out.sortField = p.sortField.trim().slice(0, 64);
    if (p.sortDir === 1 || p.sortDir === -1)
        out.sortDir = p.sortDir;
    return out;
}
/** All table prefs for one user (empty object when none saved). */
function getUserTablePrefs(userId) {
    const uid = cleanKey(userId);
    if (!uid)
        return {};
    const data = readFile();
    return data.tables?.[uid] ?? {};
}
/** Merge-write one table's prefs for one user; returns the saved prefs. */
function setUserTablePrefs(userId, tableKey, prefs) {
    const uid = cleanKey(userId);
    const table = cleanKey(tableKey, 32);
    if (!uid || !table)
        throw new Error("user and table are required");
    const clean = sanitizeTablePrefs(prefs);
    const data = readFile();
    const tables = data.tables ?? {};
    if (!tables[uid] && Object.keys(tables).length >= MAX_USERS) {
        throw new Error("too many users with saved preferences");
    }
    const mine = tables[uid] ?? {};
    if (!mine[table] && Object.keys(mine).length >= MAX_TABLES_PER_USER) {
        throw new Error("too many tables with saved preferences");
    }
    mine[table] = clean;
    tables[uid] = mine;
    writeFileSafe({ ...data, tables, updatedAt: new Date().toISOString() });
    return clean;
}
