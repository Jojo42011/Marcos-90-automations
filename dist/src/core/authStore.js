"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.genTempPassword = genTempPassword;
exports.createSession = createSession;
exports.getSession = getSession;
exports.destroySession = destroySession;
exports.destroyAllSessionsForUser = destroyAllSessionsForUser;
exports.pruneExpiredSessions = pruneExpiredSessions;
exports.recordLogin = recordLogin;
exports.getLoginHistory = getLoginHistory;
exports.recordAudit = recordAudit;
exports.getAuditLog = getAuditLog;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
function resolveAuthDbPath() {
    const env = process.env.AUTH_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/auth.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "auth.db");
}
let db = null;
function initSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS login_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      email TEXT NOT NULL,
      success INTEGER NOT NULL,
      reason TEXT,
      ip TEXT,
      user_agent TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      user_name TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_login_history_at ON login_history(at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
  `);
}
function getDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveAuthDbPath());
        initSchema(db);
    }
    return db;
}
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Password hashing — Node's built-in scrypt, no extra dependency. */
function hashPassword(password) {
    const salt = (0, crypto_1.randomBytes)(16).toString("hex");
    const hash = (0, crypto_1.scryptSync)(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
    if (!stored || !stored.includes(":"))
        return false;
    const [salt, hashHex] = stored.split(":");
    if (!salt || !hashHex)
        return false;
    try {
        const candidate = (0, crypto_1.scryptSync)(password, salt, 64);
        const expected = Buffer.from(hashHex, "hex");
        if (candidate.length !== expected.length)
            return false;
        return (0, crypto_1.timingSafeEqual)(candidate, expected);
    }
    catch {
        return false;
    }
}
/** Short, readable temp password for admin-issued/new accounts (e.g. "sunny-tide-4821"). */
const WORDS = [
    "sunny", "tide", "cedar", "amber", "coral", "meadow", "willow", "harbor",
    "granite", "cobalt", "maple", "sierra", "quartz", "violet", "canyon", "ember",
];
function genTempPassword() {
    const a = WORDS[Math.floor(Math.random() * WORDS.length)];
    const b = WORDS[Math.floor(Math.random() * WORDS.length)];
    const n = 1000 + Math.floor(Math.random() * 9000);
    return `${a}-${b}-${n}`;
}
function reqIp(req) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim())
        return fwd.split(",")[0].trim();
    return req.socket?.remoteAddress || "";
}
function reqUa(req) {
    return String(req.headers["user-agent"] || "").slice(0, 200);
}
function createSession(userId, req) {
    const token = (0, crypto_1.randomBytes)(32).toString("hex");
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS);
    getDb()
        .prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(token, userId, now.toISOString(), expires.toISOString(), reqIp(req), reqUa(req));
    return token;
}
function getSession(token) {
    if (!token)
        return null;
    const row = getDb()
        .prepare(`SELECT token, user_id as userId, created_at as createdAt, expires_at as expiresAt FROM sessions WHERE token = ?`)
        .get(token);
    if (!row)
        return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) {
        getDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
        return null;
    }
    return row;
}
function destroySession(token) {
    if (!token)
        return;
    getDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}
function destroyAllSessionsForUser(userId) {
    getDb().prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}
function pruneExpiredSessions() {
    getDb().prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString());
}
function recordLogin(opts) {
    getDb()
        .prepare(`INSERT INTO login_history (user_id, email, success, reason, ip, user_agent, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(opts.userId, opts.email, opts.success ? 1 : 0, opts.reason || null, reqIp(opts.req), reqUa(opts.req), new Date().toISOString());
}
function getLoginHistory(limit = 100) {
    return getDb()
        .prepare(`SELECT id, user_id as userId, email, success, reason, ip, user_agent as userAgent, at
       FROM login_history ORDER BY at DESC LIMIT ?`)
        .all(Math.max(1, Math.min(500, limit)));
}
function recordAudit(opts) {
    getDb()
        .prepare(`INSERT INTO audit_log (user_id, user_name, action, detail, ip, at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(opts.userId || null, opts.userName || null, opts.action, opts.detail || null, opts.req ? reqIp(opts.req) : null, new Date().toISOString());
}
function getAuditLog(limit = 200) {
    return getDb()
        .prepare(`SELECT id, user_id as userId, user_name as userName, action, detail, ip, at
       FROM audit_log ORDER BY at DESC LIMIT ?`)
        .all(Math.max(1, Math.min(1000, limit)));
}
