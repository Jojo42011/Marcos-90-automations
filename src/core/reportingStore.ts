import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

function resolveReportingDbPath(): string {
  const env = process.env.REPORTING_DB_PATH?.trim();
  if (env) return env;
  if (existsSync("/data")) return "/data/reporting.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "reporting.db");
}

let db: Database.Database | null = null;

function initReportingSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS reporting_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      data TEXT NOT NULL,
      anomalies TEXT,
      generated_at TEXT NOT NULL,
      delivered_sms INTEGER NOT NULL DEFAULT 0,
      delivered_harvey INTEGER NOT NULL DEFAULT 0
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_date ON reporting_snapshots(snapshot_date)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_type ON reporting_snapshots(snapshot_type)`);
}

export function getReportingDb(): Database.Database {
  if (!db) {
    db = new Database(resolveReportingDbPath());
    initReportingSchema(db);
  }
  return db;
}

export interface SocialSection {
  followers: number;
  followersChangeWeek: number;
  avgViewsLast7Days: number;
  topPost: { description: string; views: number; score: number } | null;
  newDmLeads: number;
  leadIntentFlags: number;
}

export interface EmailSection {
  sent: number;
  openRate: number | null;
  replies: number;
  sequences: number;
  gap: string;
}

export interface TextsSection {
  sentToday: number;
  receivedToday: number;
  replyRate: number;
  appointmentsBooked: number;
  activeThreads: number;
}

export interface TransactionsSection {
  dealsInEscrow: number;
  closingsThisWeek: number;
  deadlinesIn48Hours: Array<{ address: string; label: string; dueDate: string }>;
  missedDeadlines: number;
}

export interface PipelineSection {
  newLeadsToday: number;
  totalLeads: number;
  hotLeads: number;
  warmLeads: number;
  coldLeads: number;
  promotedToHotToday: number;
  goneColdToday: number;
}

export interface BusinessHealthSection {
  pipelineGCI: number;
  mtdClosedVolume: number;
  mtdClosedGCI: number;
  ytdClosedGCI: number;
  anomalyFlag: boolean;
}

export interface DailyDigestData {
  social: SocialSection;
  email: EmailSection;
  texts: TextsSection;
  transactions: TransactionsSection;
  pipeline: PipelineSection;
  businessHealth: BusinessHealthSection;
}

export interface WeeklyKPIData {
  weekOf: string;
  metrics: {
    newLeads: { value: number; weekOverWeek: number | null };
    hotLeads: { value: number; weekOverWeek: number | null };
    appointmentsBooked: { value: number; weekOverWeek: number | null };
    closingsThisWeek: { value: number; weekOverWeek: number | null };
    textReplyRate: { value: number; weekOverWeek: number | null };
    socialFollowers: { value: number; weekOverWeek: number | null };
    pipelineGCI: { value: number; weekOverWeek: number | null };
  };
}

export interface Anomaly {
  field: string;
  currentValue: number;
  averageValue: number;
  deviation: number;
  direction: "up" | "down";
  severity: "warning" | "critical";
  message: string;
}

export interface ReportingSnapshot {
  id?: number;
  snapshotDate: string;
  snapshotType: "daily_digest" | "weekly_kpi";
  data: DailyDigestData | WeeklyKPIData;
  anomalies?: Anomaly[];
  generatedAt: string;
  deliveredSms: boolean;
  deliveredHarvey: boolean;
}

export function saveSnapshot(snap: Omit<ReportingSnapshot, "id">): number {
  const database = getReportingDb();
  const result = database
    .prepare(
      `INSERT INTO reporting_snapshots (snapshot_date, snapshot_type, data, anomalies, generated_at, delivered_sms, delivered_harvey)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      snap.snapshotDate,
      snap.snapshotType,
      JSON.stringify(snap.data),
      snap.anomalies ? JSON.stringify(snap.anomalies) : null,
      snap.generatedAt,
      snap.deliveredSms ? 1 : 0,
      snap.deliveredHarvey ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}

export function getLatestSnapshot(type: "daily_digest" | "weekly_kpi"): ReportingSnapshot | null {
  const database = getReportingDb();
  const row = database
    .prepare(`SELECT * FROM reporting_snapshots WHERE snapshot_type = ? ORDER BY generated_at DESC LIMIT 1`)
    .get(type) as Record<string, unknown> | undefined;
  return row ? rowToSnapshot(row) : null;
}

export function getSnapshotsByType(type: "daily_digest" | "weekly_kpi", limit = 5): ReportingSnapshot[] {
  const database = getReportingDb();
  const rows = database
    .prepare(`SELECT * FROM reporting_snapshots WHERE snapshot_type = ? ORDER BY generated_at DESC LIMIT ?`)
    .all(type, limit) as Record<string, unknown>[];
  return rows.map(rowToSnapshot);
}

export function getSnapshotsForAnomaly(type: "daily_digest", lookbackDays = 28): ReportingSnapshot[] {
  const database = getReportingDb();
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = database
    .prepare(
      `SELECT * FROM reporting_snapshots WHERE snapshot_type = ? AND generated_at >= ? ORDER BY generated_at ASC`,
    )
    .all(type, since) as Record<string, unknown>[];
  return rows.map(rowToSnapshot);
}

export function markSnapshotDelivered(id: number, channel: "sms" | "harvey"): void {
  const database = getReportingDb();
  const col = channel === "sms" ? "delivered_sms" : "delivered_harvey";
  database.prepare(`UPDATE reporting_snapshots SET ${col} = 1 WHERE id = ?`).run(id);
}

function rowToSnapshot(row: Record<string, unknown>): ReportingSnapshot {
  return {
    id: Number(row.id),
    snapshotDate: String(row.snapshot_date),
    snapshotType: row.snapshot_type as ReportingSnapshot["snapshotType"],
    data: JSON.parse(String(row.data)) as DailyDigestData | WeeklyKPIData,
    anomalies: row.anomalies ? (JSON.parse(String(row.anomalies)) as Anomaly[]) : [],
    generatedAt: String(row.generated_at),
    deliveredSms: Number(row.delivered_sms) === 1,
    deliveredHarvey: Number(row.delivered_harvey) === 1,
  };
}
