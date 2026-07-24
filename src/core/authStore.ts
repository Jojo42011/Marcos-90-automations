import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { Request } from "express";

function resolveAuthDbPath(): string {
  const env = process.env.AUTH_DB_PATH?.trim();
  if (env) return env;
  if (existsSync("/data")) return "/data/auth.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "auth.db");
}

let db: Database.Database | null = null;

function initSchema(database: Database.Database): void {
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

function getDb(): Database.Database {
  if (!db) {
    db = new Database(resolveAuthDbPath());
    initSchema(db);
  }
  return db;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Password hashing — Node's built-in scrypt, no extra dependency. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  try {
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hashHex, "hex");
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/** Short, readable temp password for admin-issued/new accounts (e.g. "sunny-tide-4821"). */
const WORDS = [
  "sunny", "tide", "cedar", "amber", "coral", "meadow", "willow", "harbor",
  "granite", "cobalt", "maple", "sierra", "quartz", "violet", "canyon", "ember",
];
export function genTempPassword(): string {
  const a = WORDS[Math.floor(Math.random() * WORDS.length)];
  const b = WORDS[Math.floor(Math.random() * WORDS.length)];
  const n = 1000 + Math.floor(Math.random() * 9000);
  return `${a}-${b}-${n}`;
}

function reqIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

function reqUa(req: Request): string {
  return String(req.headers["user-agent"] || "").slice(0, 200);
}

export function createSession(userId: string, req: Request): string {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  getDb()
    .prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(token, userId, now.toISOString(), expires.toISOString(), reqIp(req), reqUa(req));
  return token;
}

export interface SessionRow {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export function getSession(token: string): SessionRow | null {
  if (!token) return null;
  const row = getDb()
    .prepare(`SELECT token, user_id as userId, created_at as createdAt, expires_at as expiresAt FROM sessions WHERE token = ?`)
    .get(token) as SessionRow | undefined;
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    getDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return row;
}

export function destroySession(token: string): void {
  if (!token) return;
  getDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

export function destroyAllSessionsForUser(userId: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}

export function pruneExpiredSessions(): void {
  getDb().prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString());
}

export function recordLogin(opts: {
  userId: string | null;
  email: string;
  success: boolean;
  reason?: string;
  req: Request;
}): void {
  getDb()
    .prepare(
      `INSERT INTO login_history (user_id, email, success, reason, ip, user_agent, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.userId,
      opts.email,
      opts.success ? 1 : 0,
      opts.reason || null,
      reqIp(opts.req),
      reqUa(opts.req),
      new Date().toISOString(),
    );
}

export interface LoginHistoryRow {
  id: number;
  userId: string | null;
  email: string;
  success: number;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  at: string;
}

export function getLoginHistory(limit = 100): LoginHistoryRow[] {
  return getDb()
    .prepare(
      `SELECT id, user_id as userId, email, success, reason, ip, user_agent as userAgent, at
       FROM login_history ORDER BY at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(500, limit))) as LoginHistoryRow[];
}

export function recordAudit(opts: {
  userId?: string | null;
  userName?: string | null;
  action: string;
  detail?: string;
  req?: Request;
}): void {
  getDb()
    .prepare(`INSERT INTO audit_log (user_id, user_name, action, detail, ip, at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      opts.userId || null,
      opts.userName || null,
      opts.action,
      opts.detail || null,
      opts.req ? reqIp(opts.req) : null,
      new Date().toISOString(),
    );
}

export interface AuditRow {
  id: number;
  userId: string | null;
  userName: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
  at: string;
}

export function getAuditLog(limit = 200): AuditRow[] {
  return getDb()
    .prepare(
      `SELECT id, user_id as userId, user_name as userName, action, detail, ip, at
       FROM audit_log ORDER BY at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(1000, limit))) as AuditRow[];
}
