"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOutreachDb = getOutreachDb;
exports.newId = newId;
exports.listAlerts = listAlerts;
exports.getAlert = getAlert;
exports.insertAlert = insertAlert;
exports.updateAlert = updateAlert;
exports.deleteAlert = deleteAlert;
exports.dueAlerts = dueAlerts;
exports.sentListingsFor = sentListingsFor;
exports.recordSentListings = recordSentListings;
exports.listReports = listReports;
exports.getReport = getReport;
exports.insertReport = insertReport;
exports.updateReport = updateReport;
exports.deleteReport = deleteReport;
exports.dueReports = dueReports;
exports.recordSend = recordSend;
exports.listSends = listSends;
exports.markSendOpened = markSendOpened;
exports.recordEngagement = recordEngagement;
exports.engagementForLead = engagementForLead;
exports.hotEngagement = hotEngagement;
exports.outreachCounts = outreachCounts;
exports.outreachSummaryByLead = outreachSummaryByLead;
/**
 * Listing Alerts and Market Reports — the two client-facing MLS subscriptions.
 *
 * ONE FILE FOR BOTH, on purpose. They are the same subsystem seen from the two
 * sides of the business: a saved MLS search that emails a contact on a
 * schedule, and logs whether the contact engaged. A buyer gets listings, a
 * homeowner gets what their neighbourhood is doing. They share the criteria
 * vocabulary, the send loop, the tracking pixel and the engagement feed, so
 * splitting them across two databases would mean writing all of that twice.
 *
 * WHAT `sent_listings` IS FOR, and why it is not just a timestamp. Brivity's
 * alert fires "the moment a matching listing hits, changes price, or goes
 * pending". A last-sent timestamp cannot express that — a listing whose price
 * dropped yesterday has not changed since the last run by any date comparison,
 * yet it is exactly what the buyer wants to hear about. So each alert keeps the
 * price and status it last told this contact about, per listing, and a row is
 * re-sendable when either has moved. That also makes the common case correct:
 * a listing already sent, unchanged, is never sent twice.
 */
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function resolveDbPath() {
    const env = process.env.OUTREACH_DB_PATH?.trim();
    if (env) {
        (0, fs_1.mkdirSync)(path_1.default.dirname(env), { recursive: true });
        return env;
    }
    if ((0, fs_1.existsSync)("/data"))
        return "/data/outreach.db";
    const dir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(dir, { recursive: true });
    return path_1.default.join(dir, "outreach.db");
}
let db = null;
function getOutreachDb() {
    if (db)
        return db;
    db = new better_sqlite3_1.default(resolveDbPath());
    db.pragma("journal_mode = WAL");
    db.exec(`
    CREATE TABLE IF NOT EXISTS listing_alerts (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cc TEXT,
      send_email INTEGER NOT NULL DEFAULT 1,
      frequency TEXT NOT NULL DEFAULT 'daily',
      criteria TEXT NOT NULL DEFAULT '{}',
      paused INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sent_at TEXT,
      next_send_at TEXT,
      last_match_count INTEGER,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_lead ON listing_alerts(lead_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_next ON listing_alerts(next_send_at);

    CREATE TABLE IF NOT EXISTS market_reports (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      cc TEXT,
      frequency TEXT NOT NULL DEFAULT 'quarterly',
      drip INTEGER NOT NULL DEFAULT 1,
      criteria TEXT NOT NULL DEFAULT '{}',
      subject TEXT NOT NULL DEFAULT '{}',
      adjusted_value REAL,
      include_home_value INTEGER NOT NULL DEFAULT 1,
      email_message TEXT,
      paused INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sent_at TEXT,
      next_send_at TEXT,
      last_viewed_at TEXT,
      view_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reports_lead ON market_reports(lead_id);
    CREATE INDEX IF NOT EXISTS idx_reports_next ON market_reports(next_send_at);

    /* One row per listing per alert: what this contact has already been told,
       and at what price/status, so a change can re-notify but a repeat cannot. */
    CREATE TABLE IF NOT EXISTS sent_listings (
      alert_id TEXT NOT NULL,
      listing_key TEXT NOT NULL,
      last_price REAL,
      last_status TEXT,
      first_sent_at TEXT NOT NULL,
      last_sent_at TEXT NOT NULL,
      PRIMARY KEY (alert_id, listing_key)
    );

    CREATE TABLE IF NOT EXISTS outreach_sends (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      listing_count INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      opened_at TEXT,
      open_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sends_sub ON outreach_sends(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_sends_at ON outreach_sends(sent_at);

    /* Every click-through and report open. This is the buyer/seller
       temperature signal the whole feature exists to produce — a contact who
       keeps opening is the one to call. */
    CREATE TABLE IF NOT EXISTS outreach_engagement (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      event TEXT NOT NULL,
      listing_key TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eng_lead ON outreach_engagement(lead_id);
    CREATE INDEX IF NOT EXISTS idx_eng_sub ON outreach_engagement(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_eng_at ON outreach_engagement(at);
  `);
    return db;
}
const json = (raw, fallback) => {
    try {
        return raw ? JSON.parse(String(raw)) : fallback;
    }
    catch {
        return fallback;
    }
};
function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
/* ---------------------------------------------------------------- alerts -- */
function rowToAlert(r) {
    return {
        id: String(r.id),
        leadId: String(r.lead_id),
        name: String(r.name),
        cc: r.cc ? String(r.cc) : null,
        sendEmail: Number(r.send_email) === 1,
        frequency: (["daily", "weekly", "monthly"].includes(String(r.frequency)) ? String(r.frequency) : "daily"),
        criteria: json(r.criteria, {}),
        paused: Number(r.paused) === 1,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
        lastSentAt: r.last_sent_at ? String(r.last_sent_at) : null,
        nextSendAt: r.next_send_at ? String(r.next_send_at) : null,
        lastMatchCount: r.last_match_count == null ? null : Number(r.last_match_count),
        createdBy: r.created_by ? String(r.created_by) : null,
    };
}
function listAlerts(leadId) {
    const db = getOutreachDb();
    const rows = leadId
        ? db.prepare(`SELECT * FROM listing_alerts WHERE lead_id = ? ORDER BY created_at DESC`).all(leadId)
        : db.prepare(`SELECT * FROM listing_alerts ORDER BY created_at DESC`).all();
    return rows.map(rowToAlert);
}
function getAlert(id) {
    const r = getOutreachDb().prepare(`SELECT * FROM listing_alerts WHERE id = ?`).get(id);
    return r ? rowToAlert(r) : null;
}
function insertAlert(a) {
    getOutreachDb()
        .prepare(`INSERT INTO listing_alerts (id, lead_id, name, cc, send_email, frequency, criteria, paused,
         created_at, updated_at, last_sent_at, next_send_at, last_match_count, created_by)
       VALUES (@id,@leadId,@name,@cc,@sendEmail,@frequency,@criteria,@paused,
         @createdAt,@updatedAt,@lastSentAt,@nextSendAt,@lastMatchCount,@createdBy)`)
        .run({
        ...a,
        sendEmail: a.sendEmail ? 1 : 0,
        paused: a.paused ? 1 : 0,
        criteria: JSON.stringify(a.criteria ?? {}),
    });
    return a;
}
const ALERT_COLS = {
    name: "name", cc: "cc", sendEmail: "send_email", frequency: "frequency",
    criteria: "criteria", paused: "paused", lastSentAt: "last_sent_at",
    nextSendAt: "next_send_at", lastMatchCount: "last_match_count",
};
function updateAlert(id, patch) {
    const sets = [];
    const params = { id, updatedAt: new Date().toISOString() };
    for (const [key, col] of Object.entries(ALERT_COLS)) {
        if (!(key in patch))
            continue;
        const v = patch[key];
        sets.push(`${col} = @${key}`);
        params[key] = key === "criteria" ? JSON.stringify(v ?? {})
            : typeof v === "boolean" ? (v ? 1 : 0)
                : v ?? null;
    }
    if (!sets.length)
        return getAlert(id);
    getOutreachDb().prepare(`UPDATE listing_alerts SET ${sets.join(", ")}, updated_at = @updatedAt WHERE id = @id`).run(params);
    return getAlert(id);
}
function deleteAlert(id) {
    const db = getOutreachDb();
    const res = db.prepare(`DELETE FROM listing_alerts WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM sent_listings WHERE alert_id = ?`).run(id);
    return res.changes > 0;
}
/** Alerts whose next send is due (or overdue), skipping paused ones. */
function dueAlerts(now = new Date().toISOString()) {
    const rows = getOutreachDb()
        .prepare(`SELECT * FROM listing_alerts WHERE paused = 0 AND send_email = 1
              AND (next_send_at IS NULL OR next_send_at <= ?) ORDER BY next_send_at`)
        .all(now);
    return rows.map(rowToAlert);
}
function sentListingsFor(alertId) {
    const rows = getOutreachDb()
        .prepare(`SELECT listing_key, last_price, last_status FROM sent_listings WHERE alert_id = ?`)
        .all(alertId);
    const out = new Map();
    for (const r of rows) {
        out.set(String(r.listing_key), {
            listingKey: String(r.listing_key),
            lastPrice: r.last_price == null ? null : Number(r.last_price),
            lastStatus: r.last_status == null ? null : String(r.last_status),
        });
    }
    return out;
}
function recordSentListings(alertId, rows, at = new Date().toISOString()) {
    const db = getOutreachDb();
    const stmt = db.prepare(`INSERT INTO sent_listings (alert_id, listing_key, last_price, last_status, first_sent_at, last_sent_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(alert_id, listing_key) DO UPDATE SET
       last_price = excluded.last_price, last_status = excluded.last_status, last_sent_at = excluded.last_sent_at`);
    const tx = db.transaction((list) => {
        for (const r of list)
            stmt.run(alertId, r.listingKey, r.price, r.status, at, at);
    });
    tx(rows);
}
/* --------------------------------------------------------------- reports -- */
function rowToReport(r) {
    const freq = String(r.frequency);
    return {
        id: String(r.id),
        leadId: String(r.lead_id),
        name: String(r.name),
        address: String(r.address),
        cc: r.cc ? String(r.cc) : null,
        frequency: (["monthly", "quarterly", "semiannual", "annual"].includes(freq) ? freq : "quarterly"),
        drip: Number(r.drip) === 1,
        criteria: json(r.criteria, {}),
        subject: json(r.subject, {}),
        adjustedValue: r.adjusted_value == null ? null : Number(r.adjusted_value),
        includeHomeValue: Number(r.include_home_value) === 1,
        emailMessage: r.email_message ? String(r.email_message) : null,
        paused: Number(r.paused) === 1,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
        lastSentAt: r.last_sent_at ? String(r.last_sent_at) : null,
        nextSendAt: r.next_send_at ? String(r.next_send_at) : null,
        lastViewedAt: r.last_viewed_at ? String(r.last_viewed_at) : null,
        viewCount: Number(r.view_count || 0),
        createdBy: r.created_by ? String(r.created_by) : null,
    };
}
function listReports(leadId) {
    const db = getOutreachDb();
    const rows = leadId
        ? db.prepare(`SELECT * FROM market_reports WHERE lead_id = ? ORDER BY created_at DESC`).all(leadId)
        : db.prepare(`SELECT * FROM market_reports ORDER BY created_at DESC`).all();
    return rows.map(rowToReport);
}
function getReport(id) {
    const r = getOutreachDb().prepare(`SELECT * FROM market_reports WHERE id = ?`).get(id);
    return r ? rowToReport(r) : null;
}
function insertReport(m) {
    getOutreachDb()
        .prepare(`INSERT INTO market_reports (id, lead_id, name, address, cc, frequency, drip, criteria, subject, adjusted_value,
         include_home_value, email_message, paused, created_at, updated_at, last_sent_at, next_send_at,
         last_viewed_at, view_count, created_by)
       VALUES (@id,@leadId,@name,@address,@cc,@frequency,@drip,@criteria,@subject,@adjustedValue,
         @includeHomeValue,@emailMessage,@paused,@createdAt,@updatedAt,@lastSentAt,@nextSendAt,
         @lastViewedAt,@viewCount,@createdBy)`)
        .run({
        ...m,
        drip: m.drip ? 1 : 0,
        paused: m.paused ? 1 : 0,
        includeHomeValue: m.includeHomeValue ? 1 : 0,
        criteria: JSON.stringify(m.criteria ?? {}),
        subject: JSON.stringify(m.subject ?? {}),
    });
    return m;
}
const REPORT_COLS = {
    name: "name", address: "address", cc: "cc", frequency: "frequency", drip: "drip",
    criteria: "criteria", subject: "subject", adjustedValue: "adjusted_value", includeHomeValue: "include_home_value",
    emailMessage: "email_message", paused: "paused", lastSentAt: "last_sent_at",
    nextSendAt: "next_send_at", lastViewedAt: "last_viewed_at", viewCount: "view_count",
};
function updateReport(id, patch) {
    const sets = [];
    const params = { id, updatedAt: new Date().toISOString() };
    for (const [key, col] of Object.entries(REPORT_COLS)) {
        if (!(key in patch))
            continue;
        const v = patch[key];
        sets.push(`${col} = @${key}`);
        params[key] = key === "criteria" || key === "subject" ? JSON.stringify(v ?? {})
            : typeof v === "boolean" ? (v ? 1 : 0)
                : v ?? null;
    }
    if (!sets.length)
        return getReport(id);
    getOutreachDb().prepare(`UPDATE market_reports SET ${sets.join(", ")}, updated_at = @updatedAt WHERE id = @id`).run(params);
    return getReport(id);
}
function deleteReport(id) {
    return getOutreachDb().prepare(`DELETE FROM market_reports WHERE id = ?`).run(id).changes > 0;
}
function dueReports(now = new Date().toISOString()) {
    const rows = getOutreachDb()
        .prepare(`SELECT * FROM market_reports WHERE paused = 0 AND drip = 1
              AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at`)
        .all(now);
    return rows.map(rowToReport);
}
/* ----------------------------------------------------- sends + tracking --- */
function recordSend(s) {
    const row = { ...s, openedAt: null, openCount: 0 };
    getOutreachDb()
        .prepare(`INSERT INTO outreach_sends (id, kind, subscription_id, lead_id, sent_at, listing_count, ok, error, opened_at, open_count)
       VALUES (@id,@kind,@subscriptionId,@leadId,@sentAt,@listingCount,@ok,@error,NULL,0)`)
        .run({ ...row, ok: row.ok ? 1 : 0 });
    return row;
}
function listSends(subscriptionId, limit = 25) {
    const rows = getOutreachDb()
        .prepare(`SELECT * FROM outreach_sends WHERE subscription_id = ? ORDER BY sent_at DESC LIMIT ?`)
        .all(subscriptionId, limit);
    return rows.map((r) => ({
        id: String(r.id),
        kind: r.kind === "report" ? "report" : "alert",
        subscriptionId: String(r.subscription_id),
        leadId: String(r.lead_id),
        sentAt: String(r.sent_at),
        listingCount: Number(r.listing_count || 0),
        ok: Number(r.ok) === 1,
        error: r.error ? String(r.error) : null,
        openedAt: r.opened_at ? String(r.opened_at) : null,
        openCount: Number(r.open_count || 0),
    }));
}
function markSendOpened(sendId, at = new Date().toISOString()) {
    getOutreachDb()
        .prepare(`UPDATE outreach_sends SET opened_at = COALESCE(opened_at, ?), open_count = open_count + 1 WHERE id = ?`)
        .run(at, sendId);
}
function recordEngagement(e) {
    getOutreachDb()
        .prepare(`INSERT INTO outreach_engagement (id, kind, subscription_id, lead_id, event, listing_key, at)
              VALUES (?,?,?,?,?,?,?)`)
        .run(newId("eng"), e.kind, e.subscriptionId, e.leadId, e.event, e.listingKey ?? null, e.at ?? new Date().toISOString());
}
function engagementForLead(leadId, limit = 50) {
    const rows = getOutreachDb()
        .prepare(`SELECT * FROM outreach_engagement WHERE lead_id = ? ORDER BY at DESC LIMIT ?`)
        .all(leadId, limit);
    return rows.map((r) => ({
        id: String(r.id),
        kind: r.kind === "report" ? "report" : "alert",
        subscriptionId: String(r.subscription_id),
        leadId: String(r.lead_id),
        event: String(r.event),
        listingKey: r.listing_key ? String(r.listing_key) : null,
        at: String(r.at),
    }));
}
/** Engagement counts per lead since a date — the "who is getting serious" list. */
function hotEngagement(sinceIso, limit = 50) {
    const rows = getOutreachDb()
        .prepare(`SELECT lead_id, COUNT(*) n, MAX(at) last_at FROM outreach_engagement
              WHERE at >= ? GROUP BY lead_id ORDER BY n DESC, last_at DESC LIMIT ?`)
        .all(sinceIso, limit);
    return rows.map((r) => ({ leadId: String(r.lead_id), events: Number(r.n), lastAt: String(r.last_at) }));
}
function outreachCounts() {
    const db = getOutreachDb();
    const one = (sql) => Number(db.prepare(sql).get()?.n || 0);
    return {
        alerts: one(`SELECT COUNT(*) n FROM listing_alerts`),
        reports: one(`SELECT COUNT(*) n FROM market_reports`),
        sends: one(`SELECT COUNT(*) n FROM outreach_sends`),
        engagements: one(`SELECT COUNT(*) n FROM outreach_engagement`),
    };
}
function outreachSummaryByLead() {
    const d = getOutreachDb();
    const out = new Map();
    const bump = (leadId) => {
        let row = out.get(leadId);
        if (!row) {
            row = { listingAlerts: 0, marketReports: 0, lastSentAt: null, lastOpenedAlertAt: null, lastOpenedReportAt: null };
            out.set(leadId, row);
        }
        return row;
    };
    const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
    for (const r of d.prepare(`SELECT lead_id, COUNT(*) n FROM listing_alerts GROUP BY lead_id`).all()) {
        bump(String(r.lead_id)).listingAlerts = Number(r.n) || 0;
    }
    for (const r of d.prepare(`SELECT lead_id, COUNT(*) n FROM market_reports GROUP BY lead_id`).all()) {
        bump(String(r.lead_id)).marketReports = Number(r.n) || 0;
    }
    const sends = d
        .prepare(`SELECT lead_id, kind, MAX(sent_at) AS last_sent, MAX(opened_at) AS last_opened
       FROM outreach_sends WHERE ok = 1 GROUP BY lead_id, kind`)
        .all();
    for (const r of sends) {
        const row = bump(String(r.lead_id));
        row.lastSentAt = later(row.lastSentAt, r.last_sent);
        if (String(r.kind) === "alert")
            row.lastOpenedAlertAt = later(row.lastOpenedAlertAt, r.last_opened);
        else
            row.lastOpenedReportAt = later(row.lastOpenedReportAt, r.last_opened);
    }
    return out;
}
