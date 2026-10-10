"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.touchPresence = touchPresence;
exports.getPresence = getPresence;
exports.addNotification = addNotification;
exports.getNotifications = getNotifications;
exports.markNotificationsRead = markNotificationsRead;
exports.addChatMessage = addChatMessage;
exports.getChat = getChat;
exports.markChatRead = markChatRead;
exports.chatUnreadCounts = chatUnreadCounts;
exports.initTeamStore = initTeamStore;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const tenantData_js_1 = require("./tenantData.js");
/**
 * Team collaboration store for the Task Command Center — direct chat,
 * notifications (assignments / due-soon / messages), and lightweight presence.
 * File-backed (same pattern as pushStore): /data/team.json on Fly, ./data
 * locally. Identity comes from the authenticated account: member ids
 * (marco/wesley/carlos).
 */
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
const db_js_1 = require("./db.js");
function resolvePath() {
    const explicit = process.env.TEAM_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    if ((0, fs_1.existsSync)((0, tenantData_js_1.dataPath)("")))
        return (0, tenantData_js_1.dataPath)("team.json");
    return (0, tenantData_js_1.dataPath)("team.json");
}
const PATH = resolvePath();
const MAX_CHATS = 5000;
const MAX_NOTIFICATIONS = 2000;
let state = { chats: [], notifications: [], dueNotified: [] };
const presence = new Map(); // member id -> last-seen epoch ms
let loaded = false;
// One transactional store for team collaboration across account workers.
// Import existing files additively; never rewrite or remove the source files.
let shared;
function sharedDb() {
    if (process.env.ACCOUNT_ISOLATION !== "true")
        return undefined;
    if (shared)
        return shared;
    const root = (0, path_1.dirname)(process.env.SHARED_TASK_DB_PATH || (0, tenantData_js_1.dataPath)("shared-tasks.db"));
    (0, fs_1.mkdirSync)(root, { recursive: true });
    const db = new better_sqlite3_1.default((0, path_1.join)(root, "shared-team.db"));
    try {
        db.pragma("busy_timeout = 10000");
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = FULL");
        db.exec("CREATE TABLE IF NOT EXISTS team_state(id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS team_imports(source TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS team_presence(member TEXT PRIMARY KEY, seen INTEGER NOT NULL);");
        db.transaction(() => {
            const row = db.prepare("SELECT body FROM team_state WHERE id=1").get();
            const merged = row ? JSON.parse(row.body) : { chats: [], notifications: [], dueNotified: [] };
            const sources = [process.env.TEAM_JSON_PATH, (0, path_1.join)(root, "team.json")].filter((x) => !!x);
            const accounts = (0, path_1.join)(root, "accounts");
            if ((0, fs_1.existsSync)(accounts))
                for (const entry of (0, fs_1.readdirSync)(accounts, { withFileTypes: true }))
                    if (entry.isDirectory())
                        sources.push((0, path_1.join)(accounts, entry.name, "team.json"));
            for (const source of sources) {
                if (!(0, fs_1.existsSync)(source) || db.prepare("SELECT 1 FROM team_imports WHERE source=?").get(source))
                    continue;
                // Invalid files fail visibly instead of replacing retained records with emptiness.
                const raw = (0, fs_1.readFileSync)(source, "utf8"), old = JSON.parse(raw);
                for (const key of ["chats", "notifications"]) {
                    const ids = new Set(merged[key].map(x => x.id));
                    for (const item of old[key] || [])
                        if (!ids.has(item.id)) {
                            merged[key].push(item);
                            ids.add(item.id);
                        }
                }
                merged.dueNotified = [...new Set([...merged.dueNotified, ...(old.dueNotified || [])])];
                db.prepare("INSERT INTO team_imports(source,body) VALUES(?,?)").run(source, raw);
            }
            merged.chats.sort((a, b) => a.at.localeCompare(b.at));
            merged.notifications.sort((a, b) => a.at.localeCompare(b.at));
            db.prepare("INSERT OR REPLACE INTO team_state(id,body) VALUES(1,?)").run(JSON.stringify(merged));
        }).immediate();
        shared = db;
    }
    catch (error) {
        db.close();
        throw error;
    }
    return shared;
}
function transaction(fn) {
    const db = sharedDb();
    return db.transaction(() => { loaded = false; return fn(); }).immediate();
}
function persist() {
    const db = sharedDb();
    if (db) {
        db.prepare("UPDATE team_state SET body=? WHERE id=1").run(JSON.stringify(state));
        return;
    }
    try {
        (0, fs_1.mkdirSync)((0, path_1.dirname)(PATH), { recursive: true });
        (0, fs_1.writeFileSync)(PATH, JSON.stringify(state), "utf8");
    }
    catch (err) {
        console.error("[team] persist failed:", err);
    }
}
function load() {
    const db = sharedDb();
    if (db) {
        if (loaded && db.inTransaction)
            return;
        state = JSON.parse(db.prepare("SELECT body FROM team_state WHERE id=1").get().body);
        loaded = true;
        return;
    }
    if (loaded)
        return;
    loaded = true;
    try {
        if (!(0, fs_1.existsSync)(PATH))
            return;
        const raw = (0, fs_1.readFileSync)(PATH, "utf8");
        if (!raw.trim())
            return;
        const data = JSON.parse(raw);
        state.chats = Array.isArray(data.chats) ? data.chats : [];
        state.notifications = Array.isArray(data.notifications) ? data.notifications : [];
        state.dueNotified = Array.isArray(data.dueNotified) ? data.dueNotified : [];
    }
    catch (err) {
        console.error("[team] load failed:", err);
    }
}
const nowIso = () => new Date().toISOString();
const norm = (s) => String(s || "").toLowerCase().trim();
/* ── Presence ── */
function touchPresence(user) {
    const u = norm(user);
    if (u) {
        const db = sharedDb();
        if (db)
            db.prepare("INSERT OR REPLACE INTO team_presence(member,seen) VALUES(?,?)").run(u, Date.now());
        else
            presence.set(u, Date.now());
    }
}
function getPresence() {
    const out = {};
    for (const m of ["marco", "wesley", "carlos"]) {
        const db = sharedDb();
        const t = db ? db.prepare("SELECT seen FROM team_presence WHERE member=?").get(m)?.seen : presence.get(m);
        out[m] = { lastSeen: t ? new Date(t).toISOString() : null, online: !!t && Date.now() - t < 70000 };
    }
    return out;
}
/* ── Notifications ── */
function addNotification(n) {
    const db = sharedDb();
    if (db && !db.inTransaction)
        return transaction(() => addNotification(n));
    load();
    const entry = { ...n, user: norm(n.user), id: (0, crypto_1.randomUUID)(), at: nowIso() };
    state.notifications.push(entry);
    if (!sharedDb() && state.notifications.length > MAX_NOTIFICATIONS) {
        state.notifications = state.notifications.slice(-MAX_NOTIFICATIONS);
    }
    persist();
    return entry;
}
function getNotifications(user, limit = 100) {
    load();
    const u = norm(user);
    return state.notifications.filter((n) => n.user === u).slice(-limit).reverse();
}
function markNotificationsRead(user, ids) {
    const db = sharedDb();
    if (db && !db.inTransaction)
        return transaction(() => markNotificationsRead(user, ids));
    load();
    const u = norm(user);
    const idSet = ids && ids.length ? new Set(ids) : null;
    let n = 0;
    state.notifications.forEach((x) => {
        if (x.user !== u || x.readAt)
            return;
        if (idSet && !idSet.has(x.id))
            return;
        x.readAt = nowIso();
        n++;
    });
    if (n)
        persist();
    return n;
}
/* ── Chat ── */
function addChatMessage(from, to, text) {
    const db = sharedDb();
    if (db && !db.inTransaction)
        return transaction(() => addChatMessage(from, to, text));
    load();
    const msg = {
        id: (0, crypto_1.randomUUID)(),
        from: norm(from),
        to: norm(to),
        text: String(text || "").slice(0, 4000),
        at: nowIso(),
    };
    state.chats.push(msg);
    if (!sharedDb() && state.chats.length > MAX_CHATS)
        state.chats = state.chats.slice(-MAX_CHATS);
    persist();
    addNotification({
        user: msg.to,
        type: "message",
        title: "New message",
        body: msg.text.slice(0, 140),
        from: msg.from,
        chatWith: msg.from,
    });
    return msg;
}
function getChat(me, withUser, limit = 200) {
    load();
    const a = norm(me), b = norm(withUser);
    return state.chats
        .filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a))
        .slice(-limit);
}
/** Mark everything the peer sent me as read; returns count. */
function markChatRead(me, withUser) {
    const db = sharedDb();
    if (db && !db.inTransaction)
        return transaction(() => markChatRead(me, withUser));
    load();
    const a = norm(me), b = norm(withUser);
    let n = 0;
    state.chats.forEach((m) => {
        if (m.from === b && m.to === a && !m.readAt) {
            m.readAt = nowIso();
            n++;
        }
    });
    // Message notifications from this peer are implicitly handled too.
    state.notifications.forEach((x) => {
        if (x.user === a && x.type === "message" && x.from === b && !x.readAt)
            x.readAt = nowIso();
    });
    if (n)
        persist();
    return n;
}
/** Unread message counts for `user`, keyed by sender. */
function chatUnreadCounts(user) {
    load();
    const u = norm(user);
    const out = {};
    state.chats.forEach((m) => {
        if (m.to === u && !m.readAt)
            out[m.from] = (out[m.from] || 0) + 1;
    });
    return out;
}
/* ── Due-soon (15 min) scheduler ── */
function taskDueEpoch(t) {
    if (!t.dueDate || !t.dueTime)
        return null;
    const md = /^(\d{4})-(\d{2})-(\d{2})/.exec(t.dueDate);
    const mt = /^(\d{2}):(\d{2})$/.exec(t.dueTime);
    if (!md || !mt)
        return null;
    const d = new Date(+md[1], +md[2] - 1, +md[3], +mt[1], +mt[2], 0, 0);
    return isNaN(d.getTime()) ? null : d.getTime();
}
function dueSoonTick() {
    const db = sharedDb();
    if (db && !db.inTransaction)
        return transaction(() => dueSoonTick());
    load();
    const now = Date.now();
    const FIFTEEN = 15 * 60 * 1000;
    let changed = false;
    for (const t of (0, db_js_1.getAssignedCommandTasks)()) {
        if (!t || t.status === "done" || t.status === "on_hold")
            continue;
        const due = taskDueEpoch(t);
        if (due == null)
            continue;
        const key = `${t.id}|${due}`;
        if (state.dueNotified.includes(key))
            continue;
        const delta = due - now;
        if (delta <= FIFTEEN && delta > -60000) {
            addNotification({
                user: t.assignedTo || "marco",
                type: "due_soon",
                title: "Task due in 15 minutes",
                body: t.title,
                taskId: t.id,
            });
            state.dueNotified.push(key);
            changed = true;
        }
        else if (delta <= -60000) {
            state.dueNotified.push(key); // past due — don't fire late
            changed = true;
        }
    }
    if (changed) {
        if (!sharedDb())
            state.dueNotified = state.dueNotified.slice(-1000);
        persist();
    }
}
let started = false;
function initTeamStore() {
    if (started)
        return;
    started = true;
    load();
    const timer = setInterval(() => {
        try {
            dueSoonTick();
        }
        catch (err) {
            console.error("[team] due-soon tick:", err);
        }
    }, 60 * 1000);
    if (timer.unref)
        timer.unref();
    console.log(`[team] store initialized — ${state.chats.length} msgs, ${state.notifications.length} notifications`);
}
