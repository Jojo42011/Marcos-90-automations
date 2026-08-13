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
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

export interface QuoStoredMessage {
  id: string;
  conversationId: string;
  phoneNumberId: string;
  /** The other party, normalised to last-10-digits for joins. */
  peerKey: string;
  /** The other party as Quo gave it (E.164). */
  peer: string;
  direction: "incoming" | "outgoing";
  text: string;
  status: string;
  createdAt: string;
  userId: string | null;
}

export interface QuoThreadSummary {
  peer: string;
  peerKey: string;
  conversationId: string;
  lastText: string;
  lastAt: string;
  lastDirection: "incoming" | "outgoing";
  messageCount: number;
}

function resolveDbPath(): string {
  const env = process.env.QUO_DB_PATH?.trim();
  if (env) {
    mkdirSync(path.dirname(env), { recursive: true });
    return env;
  }
  if (existsSync("/data")) return "/data/quo.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "quo.db");
}

let db: Database.Database | null = null;

export function getQuoDb(): Database.Database {
  if (!db) {
    db = new Database(resolveDbPath());
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

export function quoMetaGet(key: string): string | null {
  const row = getQuoDb().prepare(`SELECT value FROM quo_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function quoMetaSet(key: string, value: string): void {
  getQuoDb()
    .prepare(`INSERT INTO quo_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

/** Insert-or-ignore on Quo's message id. Returns true when it was new. */
export function upsertQuoMessage(m: QuoStoredMessage): boolean {
  const res = getQuoDb()
    .prepare(
      `INSERT INTO quo_messages (id, conversation_id, phone_number_id, peer_key, peer, direction, text, status, created_at, user_id)
       VALUES (@id, @conversationId, @phoneNumberId, @peerKey, @peer, @direction, @text, @status, @createdAt, @userId)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, text = excluded.text`,
    )
    .run(m as unknown as Record<string, unknown>);
  return res.changes > 0;
}

function rowToMessage(r: Record<string, unknown>): QuoStoredMessage {
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
export function listQuoThreads(limit = 200): QuoThreadSummary[] {
  const rows = getQuoDb()
    .prepare(
      `SELECT peer_key, peer, conversation_id, text, created_at, direction, cnt FROM (
         SELECT m.*, ROW_NUMBER() OVER (PARTITION BY peer_key ORDER BY created_at DESC) rn,
                COUNT(*) OVER (PARTITION BY peer_key) cnt
         FROM quo_messages m
       ) WHERE rn = 1 ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
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
export function getQuoThread(peerKey: string, limit = 200): QuoStoredMessage[] {
  const rows = getQuoDb()
    .prepare(`SELECT * FROM quo_messages WHERE peer_key = ? ORDER BY created_at ASC LIMIT ?`)
    .all(peerKey, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function quoMessageCount(): number {
  const r = getQuoDb().prepare(`SELECT COUNT(*) c FROM quo_messages`).get() as { c: number };
  return Number(r?.c || 0);
}

export function quoThreadCount(): number {
  const r = getQuoDb().prepare(`SELECT COUNT(DISTINCT peer_key) c FROM quo_messages`).get() as { c: number };
  return Number(r?.c || 0);
}
