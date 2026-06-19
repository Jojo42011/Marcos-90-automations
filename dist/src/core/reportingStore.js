"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReportingDb = getReportingDb;
exports.saveSnapshot = saveSnapshot;
exports.getLatestSnapshot = getLatestSnapshot;
exports.getSnapshotsByType = getSnapshotsByType;
exports.getSnapshotsForAnomaly = getSnapshotsForAnomaly;
exports.markSnapshotDelivered = markSnapshotDelivered;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function resolveReportingDbPath() {
    const env = process.env.REPORTING_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/reporting.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "reporting.db");
}
let db = null;
function initReportingSchema(database) {
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
function getReportingDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveReportingDbPath());
        initReportingSchema(db);
    }
    return db;
}
function saveSnapshot(snap) {
    const database = getReportingDb();
    const result = database
        .prepare(`INSERT INTO reporting_snapshots (snapshot_date, snapshot_type, data, anomalies, generated_at, delivered_sms, delivered_harvey)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(snap.snapshotDate, snap.snapshotType, JSON.stringify(snap.data), snap.anomalies ? JSON.stringify(snap.anomalies) : null, snap.generatedAt, snap.deliveredSms ? 1 : 0, snap.deliveredHarvey ? 1 : 0);
    return Number(result.lastInsertRowid);
}
function getLatestSnapshot(type) {
    const database = getReportingDb();
    const row = database
        .prepare(`SELECT * FROM reporting_snapshots WHERE snapshot_type = ? ORDER BY generated_at DESC LIMIT 1`)
        .get(type);
    return row ? rowToSnapshot(row) : null;
}
function getSnapshotsByType(type, limit = 5) {
    const database = getReportingDb();
    const rows = database
        .prepare(`SELECT * FROM reporting_snapshots WHERE snapshot_type = ? ORDER BY generated_at DESC LIMIT ?`)
        .all(type, limit);
    return rows.map(rowToSnapshot);
}
function getSnapshotsForAnomaly(type, lookbackDays = 28) {
    const database = getReportingDb();
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = database
        .prepare(`SELECT * FROM reporting_snapshots WHERE snapshot_type = ? AND generated_at >= ? ORDER BY generated_at ASC`)
        .all(type, since);
    return rows.map(rowToSnapshot);
}
function markSnapshotDelivered(id, channel) {
    const database = getReportingDb();
    const col = channel === "sms" ? "delivered_sms" : "delivered_harvey";
    database.prepare(`UPDATE reporting_snapshots SET ${col} = 1 WHERE id = ?`).run(id);
}
function rowToSnapshot(row) {
    return {
        id: Number(row.id),
        snapshotDate: String(row.snapshot_date),
        snapshotType: row.snapshot_type,
        data: JSON.parse(String(row.data)),
        anomalies: row.anomalies ? JSON.parse(String(row.anomalies)) : [],
        generatedAt: String(row.generated_at),
        deliveredSms: Number(row.delivered_sms) === 1,
        deliveredHarvey: Number(row.delivered_harvey) === 1,
    };
}
