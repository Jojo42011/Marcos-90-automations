import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

export interface SmsThreadEntry {
  id?: number;
  leadId: string;
  messageBody: string;
  direction: "inbound" | "outbound";
  sentAt: string;
  repliedAt?: string;
  messageHandle?: string;
  threadType?: string;
}

function resolveSmsDbPath(): string {
  const env = process.env.SMS_DB_PATH?.trim();
  if (env) return env;
  if (existsSync("/data")) return "/data/sms.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "sms.db");
}

let db: Database.Database | null = null;

export function getSmsDb(): Database.Database {
  if (!db) {
    db = new Database(resolveSmsDbPath());
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

function rowToEntry(row: Record<string, unknown>): SmsThreadEntry {
  return {
    id: Number(row.id),
    leadId: String(row.lead_id),
    messageBody: String(row.message_body),
    direction: row.direction as SmsThreadEntry["direction"],
    sentAt: String(row.sent_at),
    repliedAt: row.replied_at ? String(row.replied_at) : undefined,
    messageHandle: row.message_handle ? String(row.message_handle) : undefined,
    threadType: row.thread_type ? String(row.thread_type) : "general",
  };
}

export function logSmsMessage(entry: Omit<SmsThreadEntry, "id">): number {
  const database = getSmsDb();
  const result = database
    .prepare(
      `INSERT INTO sms_threads (lead_id, message_body, direction, sent_at, replied_at, message_handle, thread_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.leadId,
      entry.messageBody,
      entry.direction,
      entry.sentAt,
      entry.repliedAt ?? null,
      entry.messageHandle ?? null,
      entry.threadType ?? "general",
    );
  return Number(result.lastInsertRowid);
}

/** Skip duplicate inbound handles (persisted across restarts). */
export function isMessageHandleSeen(messageHandle: string): boolean {
  if (!messageHandle?.trim()) return false;
  const database = getSmsDb();
  const row = database
    .prepare(`SELECT id FROM sms_threads WHERE message_handle = ? LIMIT 1`)
    .get(messageHandle.trim()) as { id: number } | undefined;
  return Boolean(row);
}

export function logSmsIfNew(entry: Omit<SmsThreadEntry, "id">): number | null {
  if (entry.messageHandle && isMessageHandleSeen(entry.messageHandle)) return null;
  return logSmsMessage(entry);
}

export function markRepliedAt(messageId: number, repliedAt: string): void {
  const database = getSmsDb();
  database.prepare(`UPDATE sms_threads SET replied_at = ? WHERE id = ?`).run(repliedAt, messageId);
}

export function getInboundMessageCount(leadId: string): number {
  const database = getSmsDb();
  const row = database
    .prepare(`SELECT COUNT(*) AS c FROM sms_threads WHERE lead_id = ? AND direction = 'inbound'`)
    .get(leadId) as { c: number };
  return Number(row.c) || 0;
}

export function getThreadForLead(leadId: string, limit = 50): SmsThreadEntry[] {
  const database = getSmsDb();
  const rows = database
    .prepare(`SELECT * FROM sms_threads WHERE lead_id = ? ORDER BY sent_at ASC LIMIT ?`)
    .all(leadId, limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function getLastInboundMessage(leadId: string): SmsThreadEntry | null {
  const database = getSmsDb();
  const row = database
    .prepare(
      `SELECT * FROM sms_threads WHERE lead_id = ? AND direction = 'inbound'
       ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(leadId) as Record<string, unknown> | undefined;
  return row ? rowToEntry(row) : null;
}
