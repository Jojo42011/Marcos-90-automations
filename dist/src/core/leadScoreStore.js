"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLeadScoreDb = getLeadScoreDb;
exports.recordLeadScore = recordLeadScore;
exports.getLatestScore = getLatestScore;
exports.getScoreHistory = getScoreHistory;
exports.getScoreEntriesSince = getScoreEntriesSince;
exports.getLatestScoresForAllLeads = getLatestScoresForAllLeads;
exports.getLeadsByTier = getLeadsByTier;
exports.getLastRescoreRunAt = getLastRescoreRunAt;
exports.recordRescoreRun = recordRescoreRun;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function resolveLeadScoreDbPath() {
    const env = process.env.LEAD_SCORE_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/leadscores.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "leadscores.db");
}
let db = null;
function initLeadScoreSchema(database) {
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
function getLeadScoreDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveLeadScoreDbPath());
        initLeadScoreSchema(db);
    }
    return db;
}
function recordLeadScore(entry) {
    const database = getLeadScoreDb();
    database
        .prepare(`INSERT INTO lead_scores (lead_id, score, previous_score, score_date, scoring_factors, tier)
       VALUES (?, ?, ?, ?, ?, ?)`)
        .run(entry.leadId, entry.score, entry.previousScore ?? null, entry.scoreDate, JSON.stringify(entry.scoringFactors), entry.tier);
}
function getLatestScore(leadId) {
    const database = getLeadScoreDb();
    const row = database
        .prepare(`SELECT * FROM lead_scores WHERE lead_id = ? ORDER BY score_date DESC LIMIT 1`)
        .get(leadId);
    return row ? rowToScore(row) : null;
}
function getScoreHistory(leadId, limit = 20) {
    const database = getLeadScoreDb();
    const rows = database
        .prepare(`SELECT * FROM lead_scores WHERE lead_id = ? ORDER BY score_date DESC LIMIT ?`)
        .all(leadId, limit);
    return rows.map(rowToScore);
}
function getScoreEntriesSince(sinceIso) {
    const database = getLeadScoreDb();
    const rows = database
        .prepare(`SELECT * FROM lead_scores WHERE score_date >= ? ORDER BY score_date ASC`)
        .all(sinceIso);
    return rows.map(rowToScore);
}
function getLatestScoresForAllLeads() {
    const database = getLeadScoreDb();
    const rows = database
        .prepare(`SELECT ls.* FROM lead_scores ls
       INNER JOIN (
         SELECT lead_id, MAX(score_date) as max_date FROM lead_scores GROUP BY lead_id
       ) latest ON ls.lead_id = latest.lead_id AND ls.score_date = latest.max_date`)
        .all();
    const map = new Map();
    for (const row of rows) {
        map.set(String(row.lead_id), rowToScore(row));
    }
    return map;
}
function getLeadsByTier(tier) {
    const allLatest = getLatestScoresForAllLeads();
    return Array.from(allLatest.values()).filter((s) => s.tier === tier);
}
function getLastRescoreRunAt() {
    const database = getLeadScoreDb();
    const row = database
        .prepare(`SELECT last_run_at FROM rescore_runs ORDER BY id DESC LIMIT 1`)
        .get();
    return row?.last_run_at ?? null;
}
function recordRescoreRun(at) {
    getLeadScoreDb().prepare(`INSERT INTO rescore_runs (last_run_at) VALUES (?)`).run(at);
}
function rowToScore(row) {
    return {
        id: Number(row.id),
        leadId: String(row.lead_id),
        score: Number(row.score),
        previousScore: row.previous_score != null ? Number(row.previous_score) : undefined,
        scoreDate: String(row.score_date),
        scoringFactors: JSON.parse(String(row.scoring_factors)),
        tier: row.tier,
    };
}
