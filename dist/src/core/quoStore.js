"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getQuoDb = getQuoDb;
exports.quoMetaGet = quoMetaGet;
exports.quoMetaSet = quoMetaSet;
exports.upsertQuoMessage = upsertQuoMessage;
exports.listQuoThreads = listQuoThreads;
exports.getQuoThread = getQuoThread;
exports.quoMessageCount = quoMessageCount;
exports.quoThreadCount = quoThreadCount;
/**
 * Local mirror of Quo's SMS, so the CRM can render threads without hitting
 * the API on every page view.
 *
 * KEYED BY PHONE NUMBER, NOT BY LEAD — deliberately. Quo's book and the CRM's
 * lead store are different populations: the workspace holds 286 conversations
 * that are mostly CALLS, including carriers, spam and one-off numbers that
 * have no business becoming CRM leads. Writing them into the lead store would
 * also be dangerous rather than merely untidy: `createLead()` fires real
 * outbound automations (a Twilio text to Marco and Carlos, a marketing
 * auto-reply, a drip enrolment), which is exactly the trap the Brivity import
 * documented. So this table stands alone and the CRM joins it to leads at READ
 * time on a normalised phone key. Nothing here ever writes a lead.
 *
 * Idempotent by Quo's own message id, so a re-sync — or a webhook and a poll
 * delivering the same message — cannot double-post a thread.
 */
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function resolveDbPath() {
    const env = process.env.QUO_DB_PATH?.trim();
    if (env) {
        (0, fs_1.mkdirSync)(path_1.default.dirname(env), { recursive: true });
        return env;
    }
    if ((0, fs_1.existsSync)("/data"))
        return "/data/quo.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "quo.db");
}
let db = null;
function getQuoDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveDbPath());
        db.exec(`
      CREATE TABLE IF NOT EXISTS quo_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        phone_number_id TEXT NOT NULL,
        peer_key TEXT NOT NULL,
        peer TEXT NOT NULL,
        direction TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        user_id TEXT
      )
    `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_quo_peer ON quo_messages(peer_key)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_quo_created ON quo_messages(created_at)`);
        db.exec(`
      CREATE TABLE IF NOT EXISTS quo_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    }
    return db;
}
function quoMetaGet(key) {
    const row = getQuoDb().prepare(`SELECT value FROM quo_meta WHERE key = ?`).get(key);
    return row ? row.value : null;
}
function quoMetaSet(key, value) {
    getQuoDb()
        .prepare(`INSERT INTO quo_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, value);
}
/** Insert-or-ignore on Quo's message id. Returns true when it was new. */
function upsertQuoMessage(m) {
    const res = getQuoDb()
        .prepare(`INSERT INTO quo_messages (id, conversation_id, phone_number_id, peer_key, peer, direction, text, status, created_at, user_id)
       VALUES (@id, @conversationId, @phoneNumberId, @peerKey, @peer, @direction, @text, @status, @createdAt, @userId)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, text = excluded.text`)
        .run(m);
    return res.changes > 0;
}
function rowToMessage(r) {
    return {
        id: String(r.id),
        conversationId: String(r.conversation_id),
        phoneNumberId: String(r.phone_number_id),
        peerKey: String(r.peer_key),
        peer: String(r.peer),
        direction: r.direction === "outgoing" ? "outgoing" : "incoming",
        text: String(r.text ?? ""),
        status: String(r.status ?? ""),
        createdAt: String(r.created_at),
        userId: r.user_id ? String(r.user_id) : null,
    };
}
/** Newest-first thread list, one row per counterparty. */
function listQuoThreads(limit = 200) {
    const rows = getQuoDb()
        .prepare(`SELECT peer_key, peer, conversation_id, text, created_at, direction, cnt FROM (
         SELECT m.*, ROW_NUMBER() OVER (PARTITION BY peer_key ORDER BY created_at DESC) rn,
                COUNT(*) OVER (PARTITION BY peer_key) cnt
         FROM quo_messages m
       ) WHERE rn = 1 ORDER BY created_at DESC LIMIT ?`)
        .all(limit);
    return rows.map((r) => ({
        peer: String(r.peer),
        peerKey: String(r.peer_key),
        conversationId: String(r.conversation_id),
        lastText: String(r.text ?? ""),
        lastAt: String(r.created_at),
        lastDirection: r.direction === "outgoing" ? "outgoing" : "incoming",
        messageCount: Number(r.cnt || 0),
    }));
}
/** Full thread with one counterparty, oldest first (chat order). */
function getQuoThread(peerKey, limit = 200) {
    const rows = getQuoDb()
        .prepare(`SELECT * FROM quo_messages WHERE peer_key = ? ORDER BY created_at ASC LIMIT ?`)
        .all(peerKey, limit);
    return rows.map(rowToMessage);
}
function quoMessageCount() {
    const r = getQuoDb().prepare(`SELECT COUNT(*) c FROM quo_messages`).get();
    return Number(r?.c || 0);
}
function quoThreadCount() {
    const r = getQuoDb().prepare(`SELECT COUNT(DISTINCT peer_key) c FROM quo_messages`).get();
    return Number(r?.c || 0);
}
