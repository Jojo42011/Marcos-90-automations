import { getSocialDb } from "../../core/socialStore.js";

export interface ReportingSnapshot {
  id?: number;
  type: "morning" | "evening";
  generatedAt: string;
  summary: string;
  data: Record<string, unknown>;
}

export function saveReportingSnapshot(snapshot: Omit<ReportingSnapshot, "id">): void {
  const db = getSocialDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS reporting_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `);

  db.prepare(
    `INSERT INTO reporting_snapshots (type, generated_at, summary, data)
     VALUES (?, ?, ?, ?)`,
  ).run(snapshot.type, snapshot.generatedAt, snapshot.summary, JSON.stringify(snapshot.data));
}

export function getLatestReportingSnapshot(type?: "morning" | "evening"): ReportingSnapshot | null {
  const db = getSocialDb();
  try {
    const query = type
      ? `SELECT * FROM reporting_snapshots WHERE type = ? ORDER BY generated_at DESC LIMIT 1`
      : `SELECT * FROM reporting_snapshots ORDER BY generated_at DESC LIMIT 1`;
    const row = type
      ? (db.prepare(query).get(type) as Record<string, unknown> | undefined)
      : (db.prepare(query).get() as Record<string, unknown> | undefined);

    if (!row) return null;
    return {
      id: Number(row.id),
      type: row.type as ReportingSnapshot["type"],
      generatedAt: String(row.generated_at),
      summary: String(row.summary),
      data: JSON.parse(String(row.data)) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export function getRecentReportingSnapshots(limit = 14): ReportingSnapshot[] {
  const db = getSocialDb();
  try {
    const rows = db
      .prepare(`SELECT * FROM reporting_snapshots ORDER BY generated_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: Number(row.id),
      type: row.type as ReportingSnapshot["type"],
      generatedAt: String(row.generated_at),
      summary: String(row.summary),
      data: JSON.parse(String(row.data)) as Record<string, unknown>,
    }));
  } catch {
    return [];
  }
}
