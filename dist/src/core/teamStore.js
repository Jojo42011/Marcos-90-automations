"use strict";
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
/**
 * Team collaboration store for the Task Command Center — direct chat,
 * notifications (assignments / due-soon / messages), and lightweight presence.
 * File-backed (same pattern as pushStore): /data/team.json on Fly, ./data
 * locally. Identity model matches the task board: device-picked member ids
 * (marco/wesley/kendrick/carlos).
 */
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
const db_js_1 = require("./db.js");
function resolvePath() {
    const explicit = process.env.TEAM_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/team.json";
    return (0, path_1.join)(process.cwd(), "data", "team.json");
}
const PATH = resolvePath();
const MAX_CHATS = 5000;
const MAX_NOTIFICATIONS = 2000;
let state = { chats: [], notifications: [], dueNotified: [] };
const presence = new Map(); // member id -> last-seen epoch ms
let loaded = false;
function persist() {
    try {
        (0, fs_1.mkdirSync)((0, path_1.dirname)(PATH), { recursive: true });
        (0, fs_1.writeFileSync)(PATH, JSON.stringify(state), "utf8");
    }
    catch (err) {
        console.error("[team] persist failed:", err);
    }
}
function load() {
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
    if (u)
        presence.set(u, Date.now());
}
function getPresence() {
    const out = {};
    for (const m of ["marco", "wesley", "kendrick", "carlos"]) {
        const t = presence.get(m);
        out[m] = { lastSeen: t ? new Date(t).toISOString() : null, online: !!t && Date.now() - t < 70000 };
    }
    return out;
}
/* ── Notifications ── */
function addNotification(n) {
    load();
    const entry = { ...n, user: norm(n.user), id: (0, crypto_1.randomUUID)(), at: nowIso() };
    state.notifications.push(entry);
    if (state.notifications.length > MAX_NOTIFICATIONS) {
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
    load();
    const msg = {
        id: (0, crypto_1.randomUUID)(),
        from: norm(from),
        to: norm(to),
        text: String(text || "").slice(0, 4000),
        at: nowIso(),
    };
    state.chats.push(msg);
    if (state.chats.length > MAX_CHATS)
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
    load();
    const now = Date.now();
    const FIFTEEN = 15 * 60 * 1000;
    let changed = false;
    for (const t of (0, db_js_1.getCommandTasks)()) {
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
