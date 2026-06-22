"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCrmAutomationDb = getCrmAutomationDb;
exports.createNotification = createNotification;
exports.getUnreadNotifications = getUnreadNotifications;
exports.getAllNotifications = getAllNotifications;
exports.markNotificationRead = markNotificationRead;
exports.countUnreadNotifications = countUnreadNotifications;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
function resolveCrmAutomationDbPath() {
    const base = fs_1.default.existsSync("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
    fs_1.default.mkdirSync(base, { recursive: true });
    return path_1.default.join(base, "crm-automation.db");
}
let db = null;
function getCrmAutomationDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveCrmAutomationDbPath());
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
function rowToNotification(row) {
    return {
        id: String(row.id),
        leadId: String(row.lead_id),
        notificationType: row.notification_type,
        message: String(row.message),
        read: row.read === 1,
        createdAt: String(row.created_at),
    };
}
function createNotification(n) {
    const database = getCrmAutomationDb();
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    database
        .prepare(`INSERT INTO crm_notifications (id, lead_id, notification_type, message, read, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`)
        .run(id, n.leadId, n.notificationType, n.message, now);
    return { ...n, id, read: false, createdAt: now };
}
function getUnreadNotifications(limit = 50) {
    const rows = getCrmAutomationDb()
        .prepare(`SELECT * FROM crm_notifications WHERE read = 0 ORDER BY created_at DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToNotification);
}
function getAllNotifications(limit = 50) {
    const rows = getCrmAutomationDb()
        .prepare(`SELECT * FROM crm_notifications ORDER BY created_at DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToNotification);
}
function markNotificationRead(id) {
    getCrmAutomationDb().prepare(`UPDATE crm_notifications SET read = 1 WHERE id = ?`).run(id);
}
function countUnreadNotifications() {
    const row = getCrmAutomationDb()
        .prepare(`SELECT COUNT(*) AS c FROM crm_notifications WHERE read = 0`)
        .get();
    return Number(row.c) || 0;
}
