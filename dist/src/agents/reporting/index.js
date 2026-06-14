"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveReportingSnapshot = saveReportingSnapshot;
exports.getLatestReportingSnapshot = getLatestReportingSnapshot;
exports.getRecentReportingSnapshots = getRecentReportingSnapshots;
const socialStore_js_1 = require("../../core/socialStore.js");
function saveReportingSnapshot(snapshot) {
    const db = (0, socialStore_js_1.getSocialDb)();
    db.exec(`
    CREATE TABLE IF NOT EXISTS reporting_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `);
    db.prepare(`INSERT INTO reporting_snapshots (type, generated_at, summary, data)
     VALUES (?, ?, ?, ?)`).run(snapshot.type, snapshot.generatedAt, snapshot.summary, JSON.stringify(snapshot.data));
}
function getLatestReportingSnapshot(type) {
    const db = (0, socialStore_js_1.getSocialDb)();
    try {
        const query = type
            ? `SELECT * FROM reporting_snapshots WHERE type = ? ORDER BY generated_at DESC LIMIT 1`
            : `SELECT * FROM reporting_snapshots ORDER BY generated_at DESC LIMIT 1`;
        const row = type
            ? db.prepare(query).get(type)
            : db.prepare(query).get();
        if (!row)
            return null;
        return {
            id: Number(row.id),
            type: row.type,
            generatedAt: String(row.generated_at),
            summary: String(row.summary),
            data: JSON.parse(String(row.data)),
        };
    }
    catch {
        return null;
    }
}
function getRecentReportingSnapshots(limit = 14) {
    const db = (0, socialStore_js_1.getSocialDb)();
    try {
        const rows = db
            .prepare(`SELECT * FROM reporting_snapshots ORDER BY generated_at DESC LIMIT ?`)
            .all(limit);
        return rows.map((row) => ({
            id: Number(row.id),
            type: row.type,
            generatedAt: String(row.generated_at),
            summary: String(row.summary),
            data: JSON.parse(String(row.data)),
        }));
    }
    catch {
        return [];
    }
}
