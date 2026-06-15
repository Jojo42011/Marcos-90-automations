import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

function resolveLeadScoreDbPath(): string {
  const env = process.env.LEAD_SCORE_DB_PATH?.trim();
  if (env) return env;
  if (existsSync("/data")) return "/data/leadscores.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "leadscores.db");
}

let db: Database.Database | null = null;

function initLeadScoreSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS lead_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      previous_score INTEGER,
      score_date TEXT NOT NULL,
      scoring_factors TEXT NOT NULL,
      tier TEXT NOT NULL
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_leadscores_lead ON lead_scores(lead_id)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_leadscores_date ON lead_scores(score_date)`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS rescore_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      last_run_at TEXT NOT NULL
    )
  `);
}

export function getLeadScoreDb(): Database.Database {
  if (!db) {
    db = new Database(resolveLeadScoreDbPath());
    initLeadScoreSchema(db);
  }
  return db;
}

export interface ScoringFactors {
  timeline: number;
  preApproval: number;
  responseCount: number;
  propertyViews: number;
  showingRequests: number;
}

export interface LeadScoreEntry {
  id?: number;
  leadId: string;
  score: number;
  previousScore?: number;
  scoreDate: string;
  scoringFactors: ScoringFactors;
  tier: "hot" | "warm" | "cold";
}

export function recordLeadScore(entry: Omit<LeadScoreEntry, "id">): void {
  const database = getLeadScoreDb();
  database
    .prepare(
      `INSERT INTO lead_scores (lead_id, score, previous_score, score_date, scoring_factors, tier)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.leadId,
      entry.score,
      entry.previousScore ?? null,
      entry.scoreDate,
      JSON.stringify(entry.scoringFactors),
      entry.tier,
    );
}

export function getLatestScore(leadId: string): LeadScoreEntry | null {
  const database = getLeadScoreDb();
  const row = database
    .prepare(`SELECT * FROM lead_scores WHERE lead_id = ? ORDER BY score_date DESC LIMIT 1`)
    .get(leadId) as Record<string, unknown> | undefined;
  return row ? rowToScore(row) : null;
}

export function getScoreHistory(leadId: string, limit = 20): LeadScoreEntry[] {
  const database = getLeadScoreDb();
  const rows = database
    .prepare(`SELECT * FROM lead_scores WHERE lead_id = ? ORDER BY score_date DESC LIMIT ?`)
    .all(leadId, limit) as Record<string, unknown>[];
  return rows.map(rowToScore);
}

export function getLatestScoresForAllLeads(): Map<string, LeadScoreEntry> {
  const database = getLeadScoreDb();
  const rows = database
    .prepare(
      `SELECT ls.* FROM lead_scores ls
       INNER JOIN (
         SELECT lead_id, MAX(score_date) as max_date FROM lead_scores GROUP BY lead_id
       ) latest ON ls.lead_id = latest.lead_id AND ls.score_date = latest.max_date`,
    )
    .all() as Record<string, unknown>[];

  const map = new Map<string, LeadScoreEntry>();
  for (const row of rows) {
    map.set(String(row.lead_id), rowToScore(row));
  }
  return map;
}

export function getLeadsByTier(tier: "hot" | "warm" | "cold"): LeadScoreEntry[] {
  const allLatest = getLatestScoresForAllLeads();
  return Array.from(allLatest.values()).filter((s) => s.tier === tier);
}

export function getLastRescoreRunAt(): string | null {
  const database = getLeadScoreDb();
  const row = database
    .prepare(`SELECT last_run_at FROM rescore_runs ORDER BY id DESC LIMIT 1`)
    .get() as { last_run_at: string } | undefined;
  return row?.last_run_at ?? null;
}

export function recordRescoreRun(at: string): void {
  getLeadScoreDb().prepare(`INSERT INTO rescore_runs (last_run_at) VALUES (?)`).run(at);
}

function rowToScore(row: Record<string, unknown>): LeadScoreEntry {
  return {
    id: Number(row.id),
    leadId: String(row.lead_id),
    score: Number(row.score),
    previousScore: row.previous_score != null ? Number(row.previous_score) : undefined,
    scoreDate: String(row.score_date),
    scoringFactors: JSON.parse(String(row.scoring_factors)) as ScoringFactors,
    tier: row.tier as LeadScoreEntry["tier"],
  };
}
