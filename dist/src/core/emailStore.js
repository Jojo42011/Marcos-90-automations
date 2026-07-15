"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEmailDb = getEmailDb;
exports.kvSet = kvSet;
exports.kvGet = kvGet;
exports.kvDelete = kvDelete;
exports.logEmail = logEmail;
exports.markEmailSent = markEmailSent;
exports.attachGmailMessageId = attachGmailMessageId;
exports.markEmailFailed = markEmailFailed;
exports.markEmailOpened = markEmailOpened;
exports.markEmailReplied = markEmailReplied;
exports.getEmailsForLead = getEmailsForLead;
exports.getRecentEmails = getRecentEmails;
exports.getEmailStats = getEmailStats;
exports.countActiveDripSequences = countActiveDripSequences;
exports.getActiveDripSequences = getActiveDripSequences;
exports.startDripSequence = startDripSequence;
exports.updateDripSequence = updateDripSequence;
exports.getActiveSequencesDueNow = getActiveSequencesDueNow;
exports.getSequenceForLead = getSequenceForLead;
exports.stopSequence = stopSequence;
exports.pauseSequence = pauseSequence;
exports.getEmailById = getEmailById;
exports.getRepliedEmails = getRepliedEmails;
exports.getEmailsForDripType = getEmailsForDripType;
exports.cacheGmailMessage = cacheGmailMessage;
exports.getCachedGmailMessages = getCachedGmailMessages;
exports.getCachedGmailMessage = getCachedGmailMessage;
exports.getInboundCachedReplies = getInboundCachedReplies;
exports.saveEmailTemplate = saveEmailTemplate;
exports.updateEmailTemplate = updateEmailTemplate;
exports.deleteEmailTemplate = deleteEmailTemplate;
exports.getEmailTemplates = getEmailTemplates;
exports.getEmailTemplate = getEmailTemplate;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
function resolveEmailDbPath() {
    const base = fs_1.default.existsSync("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
    fs_1.default.mkdirSync(base, { recursive: true });
    return path_1.default.join(base, "email.db");
}
let db = null;
function getEmailDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveEmailDbPath());
        db.exec(`
      CREATE TABLE IF NOT EXISTS emails_sent (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        email_type TEXT NOT NULL,
        sequence_step INTEGER,
        send_status TEXT NOT NULL DEFAULT 'pending',
        sent_at TEXT,
        opened_at TEXT,
        replied_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      )
    `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_lead ON emails_sent(lead_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails_sent(sent_at)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_type ON emails_sent(email_type)`);
        db.exec(`
      CREATE TABLE IF NOT EXISTS drip_sequences (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        sequence_type TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        next_send_date TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_quarter_sent TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_drip_lead ON drip_sequences(lead_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_drip_status ON drip_sequences(status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_drip_next_send ON drip_sequences(next_send_date)`);
        try {
            db.exec(`ALTER TABLE emails_sent ADD COLUMN gmail_message_id TEXT`);
        }
        catch {
            /* column exists */
        }
        db.exec(`
      CREATE TABLE IF NOT EXISTS gmail_inbox_cache (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        direction TEXT,
        from_addr TEXT,
        to_addr TEXT,
        subject TEXT,
        snippet TEXT,
        body TEXT,
        received_at TEXT NOT NULL,
        lead_id TEXT,
        synced_at TEXT NOT NULL
      )
    `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_gmail_cache_received ON gmail_inbox_cache(received_at)`);
        db.exec(`
      CREATE TABLE IF NOT EXISTS email_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        template_type TEXT NOT NULL DEFAULT 'mass_email',
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_email_templates_type ON email_templates(template_type)`);
        // Small key-value table for Gmail auth + sync bookkeeping. Lives on the
        // /data volume, so a refresh token re-linked through the in-app OAuth flow
        // survives deploys without touching Fly secrets.
        db.exec(`
      CREATE TABLE IF NOT EXISTS email_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    }
    return db;
}
function kvSet(key, value) {
    getEmailDb()
        .prepare(`INSERT INTO email_kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(key, value, new Date().toISOString());
}
function kvGet(key) {
    const row = getEmailDb().prepare(`SELECT value FROM email_kv WHERE key = ?`).get(key);
    return row?.value ?? null;
}
function kvDelete(key) {
    getEmailDb().prepare(`DELETE FROM email_kv WHERE key = ?`).run(key);
}
function rowToEmail(row) {
    return {
        id: String(row.id),
        leadId: String(row.lead_id),
        subject: String(row.subject),
        body: String(row.body),
        emailType: row.email_type,
        sequenceStep: row.sequence_step != null ? Number(row.sequence_step) : undefined,
        sendStatus: row.send_status,
        sentAt: row.sent_at ? String(row.sent_at) : undefined,
        openedAt: row.opened_at ? String(row.opened_at) : undefined,
        repliedAt: row.replied_at ? String(row.replied_at) : undefined,
        error: row.error ? String(row.error) : undefined,
        createdAt: row.created_at ? String(row.created_at) : undefined,
        gmailMessageId: row.gmail_message_id ? String(row.gmail_message_id) : undefined,
    };
}
function rowToCachedGmail(row) {
    return {
        id: String(row.id),
        threadId: row.thread_id ? String(row.thread_id) : "",
        direction: String(row.direction || "unknown"),
        fromAddr: String(row.from_addr || ""),
        toAddr: String(row.to_addr || ""),
        subject: String(row.subject || ""),
        snippet: String(row.snippet || ""),
        body: String(row.body || ""),
        receivedAt: String(row.received_at),
        leadId: row.lead_id ? String(row.lead_id) : undefined,
        syncedAt: String(row.synced_at),
    };
}
function rowToSequence(row) {
    return {
        id: String(row.id),
        leadId: String(row.lead_id),
        sequenceType: row.sequence_type,
        currentStep: Number(row.current_step),
        nextSendDate: row.next_send_date ? String(row.next_send_date) : undefined,
        status: row.status,
        lastQuarterSent: row.last_quarter_sent ? String(row.last_quarter_sent) : undefined,
        startedAt: row.started_at ? String(row.started_at) : undefined,
        updatedAt: row.updated_at ? String(row.updated_at) : undefined,
    };
}
function logEmail(email) {
    const database = getEmailDb();
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    database
        .prepare(`INSERT INTO emails_sent (id, lead_id, subject, body, email_type, sequence_step, send_status, sent_at, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, email.leadId, email.subject, email.body, email.emailType, email.sequenceStep ?? null, email.sendStatus, email.sentAt || null, email.error || null, now);
    return { ...email, id, createdAt: now };
}
function markEmailSent(id, gmailMessageId) {
    const sentAt = new Date().toISOString();
    if (gmailMessageId) {
        getEmailDb()
            .prepare(`UPDATE emails_sent SET send_status = 'sent', sent_at = ?, gmail_message_id = ? WHERE id = ?`)
            .run(sentAt, gmailMessageId, id);
    }
    else {
        getEmailDb()
            .prepare(`UPDATE emails_sent SET send_status = 'sent', sent_at = ? WHERE id = ?`)
            .run(sentAt, id);
    }
}
function attachGmailMessageId(id, gmailMessageId) {
    getEmailDb()
        .prepare(`UPDATE emails_sent SET gmail_message_id = ? WHERE id = ?`)
        .run(gmailMessageId, id);
}
function markEmailFailed(id, error) {
    getEmailDb()
        .prepare(`UPDATE emails_sent SET send_status = 'failed', error = ? WHERE id = ?`)
        .run(error, id);
}
function markEmailOpened(id) {
    getEmailDb()
        .prepare(`UPDATE emails_sent SET opened_at = ? WHERE id = ? AND opened_at IS NULL`)
        .run(new Date().toISOString(), id);
}
function markEmailReplied(leadId) {
    getEmailDb()
        .prepare(`UPDATE emails_sent SET replied_at = ?
       WHERE id = (
         SELECT id FROM emails_sent
         WHERE lead_id = ? AND send_status = 'sent' AND replied_at IS NULL
         ORDER BY sent_at DESC LIMIT 1
       )`)
        .run(new Date().toISOString(), leadId);
}
function getEmailsForLead(leadId, limit = 50) {
    const rows = getEmailDb()
        .prepare(`SELECT * FROM emails_sent WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(leadId, limit);
    return rows.map(rowToEmail);
}
function getRecentEmails(limit = 50) {
    const rows = getEmailDb()
        .prepare(`SELECT * FROM emails_sent ORDER BY created_at DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToEmail);
}
function getEmailStats(sinceIso) {
    const row = getEmailDb()
        .prepare(`SELECT
        SUM(CASE WHEN send_status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) as replied,
        SUM(CASE WHEN send_status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM emails_sent WHERE created_at >= ?`)
        .get(sinceIso);
    return {
        sent: Number(row.sent) || 0,
        opened: Number(row.opened) || 0,
        replied: Number(row.replied) || 0,
        failed: Number(row.failed) || 0,
    };
}
function countActiveDripSequences() {
    const row = getEmailDb()
        .prepare(`SELECT COUNT(*) as c FROM drip_sequences WHERE status = 'active'`)
        .get();
    return Number(row.c) || 0;
}
function getActiveDripSequences(limit = 100) {
    const rows = getEmailDb()
        .prepare(`SELECT * FROM drip_sequences WHERE status = 'active' ORDER BY next_send_date ASC LIMIT ?`)
        .all(limit);
    return rows.map(rowToSequence);
}
function startDripSequence(leadId, sequenceType, firstSendDate) {
    const database = getEmailDb();
    const existing = database
        .prepare(`SELECT * FROM drip_sequences WHERE lead_id = ? AND sequence_type = ? AND status = 'active'`)
        .get(leadId, sequenceType);
    if (existing) {
        console.log("[EmailStore] Drip already active for", leadId, sequenceType);
        return rowToSequence(existing);
    }
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    const nextSend = firstSendDate || now;
    database
        .prepare(`INSERT INTO drip_sequences (id, lead_id, sequence_type, current_step, next_send_date, status, started_at, updated_at)
       VALUES (?, ?, ?, 0, ?, 'active', ?, ?)`)
        .run(id, leadId, sequenceType, nextSend, now, now);
    return {
        id,
        leadId,
        sequenceType,
        currentStep: 0,
        nextSendDate: nextSend,
        status: "active",
        startedAt: now,
        updatedAt: now,
    };
}
function updateDripSequence(id, updates) {
    const database = getEmailDb();
    const existing = database.prepare(`SELECT * FROM drip_sequences WHERE id = ?`).get(id);
    if (!existing)
        return;
    const merged = { ...rowToSequence(existing), ...updates, updatedAt: new Date().toISOString() };
    database
        .prepare(`UPDATE drip_sequences SET current_step = ?, next_send_date = ?, status = ?, last_quarter_sent = ?, updated_at = ? WHERE id = ?`)
        .run(merged.currentStep, merged.nextSendDate || null, merged.status, merged.lastQuarterSent || null, merged.updatedAt, id);
}
function getActiveSequencesDueNow(sequenceType) {
    const database = getEmailDb();
    const nowIso = new Date().toISOString();
    const rows = sequenceType
        ? database
            .prepare(`SELECT * FROM drip_sequences WHERE status = 'active' AND sequence_type = ? AND next_send_date <= ?`)
            .all(sequenceType, nowIso)
        : database
            .prepare(`SELECT * FROM drip_sequences WHERE status = 'active' AND next_send_date <= ?`)
            .all(nowIso);
    return rows.map(rowToSequence);
}
function getSequenceForLead(leadId, sequenceType) {
    const row = getEmailDb()
        .prepare(`SELECT * FROM drip_sequences WHERE lead_id = ? AND sequence_type = ? ORDER BY started_at DESC LIMIT 1`)
        .get(leadId, sequenceType);
    return row ? rowToSequence(row) : null;
}
function stopSequence(id) {
    updateDripSequence(id, { status: "stopped" });
}
function pauseSequence(id) {
    updateDripSequence(id, { status: "paused" });
}
function getEmailById(id) {
    const row = getEmailDb().prepare(`SELECT * FROM emails_sent WHERE id = ?`).get(id);
    return row ? rowToEmail(row) : null;
}
function getRepliedEmails(limit = 50) {
    const rows = getEmailDb()
        .prepare(`SELECT * FROM emails_sent WHERE replied_at IS NOT NULL ORDER BY replied_at DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToEmail);
}
function getEmailsForDripType(leadId, emailType) {
    const rows = getEmailDb()
        .prepare(`SELECT * FROM emails_sent WHERE lead_id = ? AND email_type = ? AND send_status = 'sent' ORDER BY sequence_step ASC, sent_at ASC`)
        .all(leadId, emailType);
    return rows.map(rowToEmail);
}
function cacheGmailMessage(msg) {
    getEmailDb()
        .prepare(`INSERT INTO gmail_inbox_cache (id, thread_id, direction, from_addr, to_addr, subject, snippet, body, received_at, lead_id, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         thread_id = excluded.thread_id,
         direction = excluded.direction,
         from_addr = excluded.from_addr,
         to_addr = excluded.to_addr,
         subject = excluded.subject,
         snippet = excluded.snippet,
         body = excluded.body,
         received_at = excluded.received_at,
         lead_id = COALESCE(excluded.lead_id, gmail_inbox_cache.lead_id),
         synced_at = excluded.synced_at`)
        .run(msg.id, msg.threadId, msg.direction, msg.fromAddr, msg.toAddr, msg.subject, msg.snippet, msg.body, msg.receivedAt, msg.leadId || null, msg.syncedAt);
}
function getCachedGmailMessages(limit = 30) {
    const rows = getEmailDb()
        .prepare(`SELECT * FROM gmail_inbox_cache ORDER BY received_at DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToCachedGmail);
}
function getCachedGmailMessage(id) {
    const row = getEmailDb().prepare(`SELECT * FROM gmail_inbox_cache WHERE id = ?`).get(id);
    return row ? rowToCachedGmail(row) : null;
}
function getInboundCachedReplies(limit = 50) {
    const rows = getEmailDb()
        .prepare(`SELECT * FROM gmail_inbox_cache WHERE direction = 'inbound' ORDER BY received_at DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToCachedGmail);
}
function rowToEmailTemplate(row) {
    return {
        id: String(row.id),
        name: String(row.name),
        templateType: row.template_type,
        subject: String(row.subject),
        body: String(row.body),
        isActive: Number(row.is_active) === 1,
        createdAt: row.created_at ? String(row.created_at) : undefined,
        updatedAt: row.updated_at ? String(row.updated_at) : undefined,
    };
}
function saveEmailTemplate(template) {
    const database = getEmailDb();
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    database
        .prepare(`INSERT INTO email_templates (id, name, template_type, subject, body, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, template.name, template.templateType, template.subject, template.body, template.isActive ? 1 : 0, now, now);
    return { ...template, id, createdAt: now, updatedAt: now };
}
function updateEmailTemplate(id, updates) {
    const database = getEmailDb();
    const now = new Date().toISOString();
    if (updates.name !== undefined) {
        database.prepare(`UPDATE email_templates SET name = ?, updated_at = ? WHERE id = ?`).run(updates.name, now, id);
    }
    if (updates.subject !== undefined) {
        database.prepare(`UPDATE email_templates SET subject = ?, updated_at = ? WHERE id = ?`).run(updates.subject, now, id);
    }
    if (updates.body !== undefined) {
        database.prepare(`UPDATE email_templates SET body = ?, updated_at = ? WHERE id = ?`).run(updates.body, now, id);
    }
    if (updates.isActive !== undefined) {
        database
            .prepare(`UPDATE email_templates SET is_active = ?, updated_at = ? WHERE id = ?`)
            .run(updates.isActive ? 1 : 0, now, id);
    }
}
function deleteEmailTemplate(id) {
    getEmailDb().prepare(`DELETE FROM email_templates WHERE id = ?`).run(id);
}
function getEmailTemplates(type) {
    const database = getEmailDb();
    const rows = type
        ? database
            .prepare(`SELECT * FROM email_templates WHERE template_type = ? ORDER BY created_at DESC`)
            .all(type)
        : database
            .prepare(`SELECT * FROM email_templates ORDER BY created_at DESC`)
            .all();
    return rows.map(rowToEmailTemplate);
}
function getEmailTemplate(id) {
    const row = getEmailDb().prepare(`SELECT * FROM email_templates WHERE id = ?`).get(id);
    return row ? rowToEmailTemplate(row) : null;
}
