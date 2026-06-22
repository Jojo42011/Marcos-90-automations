import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

function resolveCrmAutomationDbPath(): string {
  const base = fs.existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "crm-automation.db");
}

let db: Database.Database | null = null;

export function getCrmAutomationDb(): Database.Database {
  if (!db) {
    db = new Database(resolveCrmAutomationDbPath());

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_notifications (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        notification_type TEXT NOT NULL,
        message TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_crmnotif_lead ON crm_notifications(lead_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_crmnotif_read ON crm_notifications(read)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS listing_status_events (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        address TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        previous_status TEXT,
        off_market_outreach_sent_at TEXT,
        active_notification_sent_at TEXT,
        detected_at TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_listingstatus_lead ON listing_status_events(lead_id)`);
  }
  return db;
}

export type CrmNotificationType = "re_engagement" | "listing_off_market" | "listing_active";

export interface CrmNotification {
  id?: string;
  leadId: string;
  notificationType: CrmNotificationType;
  message: string;
  read: boolean;
  createdAt?: string;
}

function rowToNotification(row: Record<string, unknown>): CrmNotification {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    notificationType: row.notification_type as CrmNotificationType,
    message: String(row.message),
    read: row.read === 1,
    createdAt: String(row.created_at),
  };
}

export function createNotification(
  n: Omit<CrmNotification, "id" | "createdAt" | "read">,
): CrmNotification {
  const database = getCrmAutomationDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO crm_notifications (id, lead_id, notification_type, message, read, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(id, n.leadId, n.notificationType, n.message, now);
  return { ...n, id, read: false, createdAt: now };
}

export function getUnreadNotifications(limit = 50): CrmNotification[] {
  const rows = getCrmAutomationDb()
    .prepare(`SELECT * FROM crm_notifications WHERE read = 0 ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToNotification);
}

export function getAllNotifications(limit = 50): CrmNotification[] {
  const rows = getCrmAutomationDb()
    .prepare(`SELECT * FROM crm_notifications ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToNotification);
}

export function markNotificationRead(id: string): void {
  getCrmAutomationDb().prepare(`UPDATE crm_notifications SET read = 1 WHERE id = ?`).run(id);
}

export function countUnreadNotifications(): number {
  const row = getCrmAutomationDb()
    .prepare(`SELECT COUNT(*) AS c FROM crm_notifications WHERE read = 0`)
    .get() as { c: number };
  return Number(row.c) || 0;
}
