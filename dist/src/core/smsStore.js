"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSmsDb = getSmsDb;
exports.logSmsMessage = logSmsMessage;
exports.isMessageHandleSeen = isMessageHandleSeen;
exports.logSmsIfNew = logSmsIfNew;
exports.markRepliedAt = markRepliedAt;
exports.getInboundMessageCount = getInboundMessageCount;
exports.getThreadForLead = getThreadForLead;
exports.getLastInboundMessage = getLastInboundMessage;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function resolveSmsDbPath() {
    const env = process.env.SMS_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/sms.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "sms.db");
}
let db = null;
function getSmsDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveSmsDbPath());
        db.exec(`
      CREATE TABLE IF NOT EXISTS sms_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL,
        message_body TEXT NOT NULL,
        direction TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        replied_at TEXT,
        message_handle TEXT,
        thread_type TEXT DEFAULT 'general'
      )
    `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sms_lead_id ON sms_threads(lead_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sms_sent_at ON sms_threads(sent_at)`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_message_handle ON sms_threads(message_handle) WHERE message_handle IS NOT NULL`);
    }
    return db;
}
function rowToEntry(row) {
    return {
        id: Number(row.id),
        leadId: String(row.lead_id),
        messageBody: String(row.message_body),
        direction: row.direction,
        sentAt: String(row.sent_at),
        repliedAt: row.replied_at ? String(row.replied_at) : undefined,
        messageHandle: row.message_handle ? String(row.message_handle) : undefined,
        threadType: row.thread_type ? String(row.thread_type) : "general",
    };
}
function logSmsMessage(entry) {
    const database = getSmsDb();
    const result = database
        .prepare(`INSERT INTO sms_threads (lead_id, message_body, direction, sent_at, replied_at, message_handle, thread_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(entry.leadId, entry.messageBody, entry.direction, entry.sentAt, entry.repliedAt ?? null, entry.messageHandle ?? null, entry.threadType ?? "general");
    return Number(result.lastInsertRowid);
}
/** Skip duplicate inbound handles (persisted across restarts). */
function isMessageHandleSeen(messageHandle) {
    if (!messageHandle?.trim())
        return false;
    const database = getSmsDb();
    const row = database
        .prepare(`SELECT id FROM sms_threads WHERE message_handle = ? LIMIT 1`)
        .get(messageHandle.trim());
    return Boolean(row);
}
function logSmsIfNew(entry) {
    if (entry.messageHandle && isMessageHandleSeen(entry.messageHandle))
        return null;
    return logSmsMessage(entry);
}
function markRepliedAt(messageId, repliedAt) {
    const database = getSmsDb();
    database.prepare(`UPDATE sms_threads SET replied_at = ? WHERE id = ?`).run(repliedAt, messageId);
}
function getInboundMessageCount(leadId) {
    const database = getSmsDb();
    const row = database
        .prepare(`SELECT COUNT(*) AS c FROM sms_threads WHERE lead_id = ? AND direction = 'inbound'`)
        .get(leadId);
    return Number(row.c) || 0;
}
function getThreadForLead(leadId, limit = 50) {
    const database = getSmsDb();
    const rows = database
        .prepare(`SELECT * FROM sms_threads WHERE lead_id = ? ORDER BY sent_at ASC LIMIT ?`)
        .all(leadId, limit);
    return rows.map(rowToEntry);
}
function getLastInboundMessage(leadId) {
    const database = getSmsDb();
    const row = database
        .prepare(`SELECT * FROM sms_threads WHERE lead_id = ? AND direction = 'inbound'
       ORDER BY sent_at DESC LIMIT 1`)
        .get(leadId);
    return row ? rowToEntry(row) : null;
}
