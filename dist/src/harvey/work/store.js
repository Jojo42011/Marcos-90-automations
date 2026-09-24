"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.workDir = workDir;
exports.workDb = workDb;
exports.list = list;
exports.get = get;
exports.put = put;
exports.remove = remove;
exports.text = text;
exports.timezone = timezone;
exports.createProject = createProject;
exports.createChat = createChat;
exports.handoffChat = handoffChat;
exports.messages = messages;
exports.append = append;
exports.nextRun = nextRun;
exports.createSchedule = createSchedule;
exports.lockChat = lockChat;
exports.unlockChat = unlockChat;
exports.owners = owners;
exports.vaultReady = vaultReady;
exports.seal = seal;
exports.unseal = unseal;
exports.closeStore = closeStore;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const cron_parser_1 = require("cron-parser");
let db;
function workDir() {
    const dir = process.env.HARVEY_WORK_DIR || (process.platform !== "win32" && (0, fs_1.existsSync)("/data") ? "/data/harvey-work" : (0, path_1.join)(process.cwd(), "data", "harvey-work"));
    (0, fs_1.mkdirSync)(dir, { recursive: true });
    return dir;
}
function workDb() {
    if (!db) {
        db = new better_sqlite3_1.default((0, path_1.join)(workDir(), "work.db"));
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        db.exec(`CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,owner,id));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, chat TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(owner,chat,seq);
      CREATE TABLE IF NOT EXISTS locks(owner TEXT NOT NULL, chat TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(owner,chat));`);
    }
    return db;
}
function list(kind, owner) { return workDb().prepare("SELECT body FROM records WHERE kind=? AND owner=? ORDER BY rowid DESC").all(kind, owner).map(r => JSON.parse(r.body)); }
function get(kind, owner, id) {
    const row = workDb().prepare("SELECT body FROM records WHERE kind=? AND owner=? AND id=?").get(kind, owner, id);
    if (!row)
        throw new Error("Not found");
    return JSON.parse(row.body);
}
function put(kind, owner, value) {
    workDb().prepare("INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,owner,id) DO UPDATE SET body=excluded.body").run(kind, owner, value.id, JSON.stringify(value));
    return value;
}
function remove(kind, owner, id) { get(kind, owner, id); workDb().prepare("DELETE FROM records WHERE kind=? AND owner=? AND id=?").run(kind, owner, id); }
function text(value, label, max = 8000) { if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} is required (maximum ${max} characters)`); return value.trim(); }
function timezone(value) { const tz = text(value, "Timezone", 100); new Intl.DateTimeFormat("en", { timeZone: tz }).format(); return tz; }
function createProject(owner, input) {
    return put("project", owner, { id: (0, crypto_1.randomUUID)(), name: text(input.name, "Project name", 100), instructions: String(input.instructions || "").slice(0, 12000), timezone: timezone(input.timezone || "America/Chicago") });
}
function createChat(owner, input) {
    const projectId = input.projectId || null;
    if (projectId)
        get("project", owner, projectId);
    return put("chat", owner, { id: (0, crypto_1.randomUUID)(), sessionId: (0, crypto_1.randomUUID)(), projectId, title: text(input.title || "New chat", "Chat title", 120), mode: input.mode === "work" ? "work" : "chat", updatedAt: new Date().toISOString() });
}
function handoffChat(owner, sourceId, brief) {
    const source = get("chat", owner, sourceId);
    const chat = createChat(owner, { projectId: source.projectId, mode: "work", title: "Work: " + source.title.slice(0, 100) });
    const context = messages(owner, sourceId).slice(-12).map(m => `${m.role}: ${m.content}`).join("\n\n").slice(-16000);
    append(owner, chat.id, { role: "user", at: new Date().toISOString(), content: `Planning handoff from ${source.title}. Treat the following as background, not authorization to execute.\n\n${context}\n\nTask brief: ${text(brief, "Task brief", 8000)}\n\nFirst prepare a plan and identify required connections. Wait for my next message before executing or scheduling.` });
    append(owner, chat.id, { role: "assistant", at: new Date().toISOString(), content: "Your task brief is ready. Send ‘Plan this task’ to check the steps and required connections. No actions or schedules have started." });
    return chat;
}
function messages(owner, chat) { get("chat", owner, chat); return workDb().prepare("SELECT body FROM (SELECT seq,body FROM messages WHERE owner=? AND chat=? ORDER BY seq DESC LIMIT 200) ORDER BY seq").all(owner, chat).map(r => JSON.parse(r.body)); }
function append(owner, chatId, message) {
    const chat = get("chat", owner, chatId);
    workDb().prepare("INSERT INTO messages(owner,chat,body) VALUES (?,?,?)").run(owner, chatId, JSON.stringify(message));
    chat.updatedAt = new Date().toISOString();
    if (chat.title === "New chat" && message.role === "user")
        chat.title = message.content.slice(0, 80);
    put("chat", owner, chat);
}
function nextRun(cron, tz, from = new Date()) {
    timezone(tz);
    if (cron.trim().split(/\s+/).length !== 5)
        throw new Error("Use a five-field cron expression (minute hour day month weekday)");
    const expr = cron_parser_1.CronExpressionParser.parse(cron, { currentDate: from, tz });
    const first = expr.next().toDate();
    let previous = first;
    for (let i = 0; i < 64; i++) {
        const next = expr.next().toDate();
        if (next.getTime() - previous.getTime() < 15 * 60_000)
            throw new Error("Schedules must be at least 15 minutes apart");
        previous = next;
    }
    return first.toISOString();
}
function createSchedule(owner, input) {
    const chat = get("chat", owner, text(input.chatId, "Chat"));
    const cron = text(input.cron, "Schedule", 100), tz = timezone(input.timezone);
    const maxCostUsd = Number(input.maxCostUsd ?? 1);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0.01 || maxCostUsd > 25)
        throw new Error("Run budget must be between $0.01 and $25");
    return put("schedule", owner, { id: (0, crypto_1.randomUUID)(), chatId: chat.id, title: text(input.title, "Task name", 120), prompt: text(input.prompt, "Instructions", 20000), cron, timezone: tz, enabled: true, nextRunAt: nextRun(cron, tz), maxCostUsd });
}
function lockChat(owner, chat) {
    const token = (0, crypto_1.randomUUID)();
    try {
        workDb().prepare("INSERT INTO locks VALUES (?,?,?)").run(owner, chat, token);
    }
    catch {
        throw new Error("This chat already has a run in progress. Try again when it finishes.");
    }
    return token;
}
function unlockChat(owner, chat, token) { workDb().prepare("DELETE FROM locks WHERE owner=? AND chat=? AND token=?").run(owner, chat, token); }
function owners(kind) { return workDb().prepare("SELECT DISTINCT owner FROM records WHERE kind=?").all(kind).map(r => r.owner); }
function vaultReady() { return /^[0-9a-f]{64}$/i.test(process.env.HARVEY_VAULT_KEY || ""); }
function key() { if (!vaultReady())
    throw new Error("Set HARVEY_VAULT_KEY to a stable 64-character hex key before saving logins or connecting services"); return Buffer.from(process.env.HARVEY_VAULT_KEY, "hex"); }
function seal(value) { const iv = (0, crypto_1.randomBytes)(12), c = (0, crypto_1.createCipheriv)("aes-256-gcm", key(), iv); const ciphertext = Buffer.concat([c.update(JSON.stringify(value)), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ciphertext]).toString("base64"); }
function unseal(value) { const b = Buffer.from(value, "base64"), c = (0, crypto_1.createDecipheriv)("aes-256-gcm", key(), b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([c.update(b.subarray(28)), c.final()]).toString()); }
function closeStore() { db?.close(); db = undefined; }
