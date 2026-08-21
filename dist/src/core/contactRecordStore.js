"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLIENT_INTENTS = exports.PROPERTY_TYPES = exports.AGREEMENT_KINDS = exports.TEAM_ROLES = exports.CONTACT_DOC_TYPES = exports.SOCIAL_PLATFORMS = void 0;
exports.resolveContactDocsDir = resolveContactDocsDir;
exports.getContactRecordDb = getContactRecordDb;
exports.normEmailKind = normEmailKind;
exports.normPhoneKind = normPhoneKind;
exports.normAddressKind = normAddressKind;
exports.formatUsPhone = formatUsPhone;
exports.normDay = normDay;
exports.listEmails = listEmails;
exports.addEmail = addEmail;
exports.getEmail = getEmail;
exports.updateEmail = updateEmail;
exports.deleteEmail = deleteEmail;
exports.listPhones = listPhones;
exports.getPhone = getPhone;
exports.addPhone = addPhone;
exports.updatePhone = updatePhone;
exports.deletePhone = deletePhone;
exports.listAddresses = listAddresses;
exports.getAddress = getAddress;
exports.addAddress = addAddress;
exports.updateAddress = updateAddress;
exports.deleteAddress = deleteAddress;
exports.addressOneLine = addressOneLine;
exports.listSocial = listSocial;
exports.setSocial = setSocial;
exports.normalizeSocialUrl = normalizeSocialUrl;
exports.listNotes = listNotes;
exports.addNote = addNote;
exports.updateNote = updateNote;
exports.deleteNote = deleteNote;
exports.normDocType = normDocType;
exports.listDocuments = listDocuments;
exports.getDocument = getDocument;
exports.addDocument = addDocument;
exports.deleteDocument = deleteDocument;
exports.getContactRecord = getContactRecord;
exports.seedFromLead = seedFromLead;
exports.listAssignments = listAssignments;
exports.setAssignments = setAssignments;
exports.listAgreements = listAgreements;
exports.getAgreement = getAgreement;
exports.addAgreement = addAgreement;
exports.deleteAgreement = deleteAgreement;
/**
 * The contact record's own data: emails, phones, addresses, social links,
 * notes and documents for one CRM contact.
 *
 * WHY A SEPARATE STORE. A Lead already carries ONE `email`, ONE `phone` and
 * ONE `address` string, and those stay exactly where they are — they are what
 * the DM pipeline writes, what the lead table sorts on, and what every existing
 * automation reads. What the contact record needs is different: a person has a
 * personal address and a work address, a mobile that can be texted and a home
 * line that is on the Do Not Call list. That is a one-to-many relationship, and
 * squeezing it into the single-value columns would have quietly broken the
 * table, the filters and the senders all at once.
 *
 * So the rule this file follows: the Lead's own `email`/`phone`/`address` are
 * the PRIMARY, and the rows here are the full set. Marking a row primary writes
 * back to the Lead (see server.ts) so there is exactly one answer to "what
 * number do we call", and nothing downstream has to learn a new shape.
 *
 * DNC IS NOT DECORATION. `dnc` on a phone row is a legal flag, so it is stored
 * on the row, shown on the row, and never inferred. A number nobody has checked
 * is `dnc = 0` meaning "not marked", not "cleared to call" — the UI says as
 * much rather than implying a check happened.
 *
 * DOCUMENTS ARE FILES ON DISK, not blobs in SQLite. The row holds the metadata
 * and a path under /data/contact-docs; the bytes stay on the volume, which is
 * what the rest of this system does with uploads and what keeps the database
 * small enough to stay fast.
 */
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
/** Platforms the Social Media block edits, in the order the block renders. */
exports.SOCIAL_PLATFORMS = [
    "facebook",
    "x",
    "linkedin",
    "instagram",
    "youtube",
    "tiktok",
    "pinterest",
];
/* ────────────────────────── database ────────────────────────── */
function resolveBase() {
    const base = (0, fs_1.existsSync)("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(base, { recursive: true });
    return base;
}
function resolveDbPath() {
    return process.env.CONTACT_RECORD_DB_PATH?.trim() || path_1.default.join(resolveBase(), "contact-records.db");
}
function resolveContactDocsDir() {
    const dir = process.env.CONTACT_DOCS_DIR?.trim() || path_1.default.join(resolveBase(), "contact-docs");
    (0, fs_1.mkdirSync)(dir, { recursive: true });
    return dir;
}
let db = null;
function getContactRecordDb() {
    if (db)
        return db;
    db = new better_sqlite3_1.default(resolveDbPath());
    db.pragma("journal_mode = WAL");
    db.exec(`
    CREATE TABLE IF NOT EXISTS contact_emails (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      address TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'personal',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_emails_lead ON contact_emails(lead_id);

    CREATE TABLE IF NOT EXISTS contact_phones (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      number TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'mobile',
      dnc INTEGER NOT NULL DEFAULT 0,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_phones_lead ON contact_phones(lead_id);

    CREATE TABLE IF NOT EXISTS contact_addresses (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'home',
      street TEXT NOT NULL DEFAULT '',
      apt TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT 'US',
      postal_code TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_addresses_lead ON contact_addresses(lead_id);

    CREATE TABLE IF NOT EXISTS contact_social_links (
      lead_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      url TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (lead_id, platform)
    );

    CREATE TABLE IF NOT EXISTS contact_notes (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      body TEXT NOT NULL,
      hidden_from_viewers INTEGER NOT NULL DEFAULT 1,
      important INTEGER NOT NULL DEFAULT 0,
      author TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_notes_lead ON contact_notes(lead_id, created_at);

    CREATE TABLE IF NOT EXISTS note_mentions (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_note_mentions_note ON note_mentions(note_id);
    CREATE INDEX IF NOT EXISTS idx_note_mentions_member ON note_mentions(member_id);

    /* Secondary team access on one contact. The PRIMARY agent is not in here:
       it stays on the Lead's assignedUserId/assignedUserName, which is what
       the lead table, the round-robin and every notification already read.
       This table is the people who additionally get to see and edit, and the
       functional role they hold on this contact. */
    CREATE TABLE IF NOT EXISTS contact_assignments (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      role_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (lead_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_assignments ON contact_assignments(lead_id);

    /* An agreement is the paperwork; the transaction it opens lives in the
       pipeline store and the file lives in contact_documents. This row is the
       metadata that belongs to neither: the fee, its unit, and who referred. */
    CREATE TABLE IF NOT EXISTS referral_agreements (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'referral',
      document_id TEXT,
      transaction_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      fee_value REAL,
      fee_type TEXT NOT NULL DEFAULT 'percentage',
      referring_agent TEXT NOT NULL DEFAULT '',
      partner_lead_id TEXT,
      partner_name TEXT NOT NULL DEFAULT '',
      client_intent TEXT NOT NULL DEFAULT 'Buyer',
      property_type TEXT NOT NULL DEFAULT 'Residential',
      signed_date TEXT,
      expiration_date TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_referral_agreements ON referral_agreements(lead_id, created_at);

    CREATE TABLE IF NOT EXISTS contact_documents (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'other',
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      bytes INTEGER NOT NULL DEFAULT 0,
      stored_path TEXT NOT NULL,
      signed_date TEXT,
      expiration_date TEXT,
      transaction_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_documents_lead ON contact_documents(lead_id, created_at);
  `);
    return db;
}
const nowIso = () => new Date().toISOString();
const bool = (v) => (v ? 1 : 0);
/* ────────────────────────── normalisers ────────────────────────── */
const EMAIL_KINDS = new Set(["personal", "work", "other"]);
const PHONE_KINDS = new Set(["mobile", "home", "work", "other"]);
const ADDRESS_KINDS = new Set(["home", "work", "mailing", "other"]);
const SOCIAL_SET = new Set(exports.SOCIAL_PLATFORMS);
function normEmailKind(v) {
    return typeof v === "string" && EMAIL_KINDS.has(v) ? v : "personal";
}
function normPhoneKind(v) {
    return typeof v === "string" && PHONE_KINDS.has(v) ? v : "mobile";
}
function normAddressKind(v) {
    return typeof v === "string" && ADDRESS_KINDS.has(v) ? v : "home";
}
/**
 * "(817) 995-4677" for a 10-digit US number, "+1 (817) 995-4677" for an
 * 11-digit one starting with 1. Anything else is kept exactly as typed —
 * an international number mangled into a US shape is worse than an unformatted
 * one, because it looks correct and does not dial.
 */
function formatUsPhone(raw) {
    const trimmed = (raw || "").trim();
    const digits = trimmed.replace(/\D/g, "");
    if (/^\+/.test(trimmed) && !/^\+1/.test(trimmed))
        return trimmed;
    if (digits.length === 10)
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits.startsWith("1"))
        return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    return trimmed;
}
/** ISO YYYY-MM-DD, or null. Junk is null rather than a silently wrong date. */
function normDay(v) {
    if (typeof v !== "string")
        return null;
    const s = v.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
const toEmail = (r) => ({
    id: r.id, leadId: r.lead_id, address: r.address, kind: normEmailKind(r.kind),
    isPrimary: !!r.is_primary, createdAt: r.created_at,
});
function listEmails(leadId) {
    return getContactRecordDb()
        .prepare(`SELECT * FROM contact_emails WHERE lead_id = ? ORDER BY is_primary DESC, created_at ASC`)
        .all(leadId).map(toEmail);
}
function addEmail(leadId, address, kind, makePrimary) {
    const d = getContactRecordDb();
    const id = (0, crypto_1.randomUUID)();
    const existing = listEmails(leadId);
    // First one on the record is the primary whether or not anybody asked.
    const primary = makePrimary || existing.length === 0;
    if (primary)
        d.prepare(`UPDATE contact_emails SET is_primary = 0 WHERE lead_id = ?`).run(leadId);
    d.prepare(`INSERT INTO contact_emails (id, lead_id, address, kind, is_primary, created_at) VALUES (?,?,?,?,?,?)`).run(id, leadId, address.trim(), normEmailKind(kind), bool(primary), nowIso());
    return getEmail(id);
}
function getEmail(id) {
    const r = getContactRecordDb().prepare(`SELECT * FROM contact_emails WHERE id = ?`).get(id);
    return r ? toEmail(r) : null;
}
function updateEmail(id, patch) {
    const cur = getEmail(id);
    if (!cur)
        return null;
    const d = getContactRecordDb();
    if (patch.isPrimary)
        d.prepare(`UPDATE contact_emails SET is_primary = 0 WHERE lead_id = ?`).run(cur.leadId);
    d.prepare(`UPDATE contact_emails SET address = ?, kind = ?, is_primary = ? WHERE id = ?`).run(patch.address !== undefined ? patch.address.trim() : cur.address, patch.kind !== undefined ? normEmailKind(patch.kind) : cur.kind, bool(patch.isPrimary !== undefined ? patch.isPrimary : cur.isPrimary), id);
    return getEmail(id);
}
function deleteEmail(id) {
    const cur = getEmail(id);
    if (!cur)
        return null;
    const d = getContactRecordDb();
    d.prepare(`DELETE FROM contact_emails WHERE id = ?`).run(id);
    // Never leave a record with rows but no primary — promote the oldest.
    if (cur.isPrimary) {
        const next = listEmails(cur.leadId)[0];
        if (next)
            d.prepare(`UPDATE contact_emails SET is_primary = 1 WHERE id = ?`).run(next.id);
    }
    return cur;
}
const toPhone = (r) => ({
    id: r.id, leadId: r.lead_id, number: r.number, kind: normPhoneKind(r.kind),
    dnc: !!r.dnc, isPrimary: !!r.is_primary, createdAt: r.created_at,
});
function listPhones(leadId) {
    return getContactRecordDb()
        .prepare(`SELECT * FROM contact_phones WHERE lead_id = ? ORDER BY is_primary DESC, created_at ASC`)
        .all(leadId).map(toPhone);
}
function getPhone(id) {
    const r = getContactRecordDb().prepare(`SELECT * FROM contact_phones WHERE id = ?`).get(id);
    return r ? toPhone(r) : null;
}
function addPhone(leadId, number, kind, dnc, makePrimary) {
    const d = getContactRecordDb();
    const id = (0, crypto_1.randomUUID)();
    const primary = makePrimary || listPhones(leadId).length === 0;
    if (primary)
        d.prepare(`UPDATE contact_phones SET is_primary = 0 WHERE lead_id = ?`).run(leadId);
    d.prepare(`INSERT INTO contact_phones (id, lead_id, number, kind, dnc, is_primary, created_at) VALUES (?,?,?,?,?,?,?)`).run(id, leadId, formatUsPhone(number), normPhoneKind(kind), bool(dnc), bool(primary), nowIso());
    return getPhone(id);
}
function updatePhone(id, patch) {
    const cur = getPhone(id);
    if (!cur)
        return null;
    const d = getContactRecordDb();
    if (patch.isPrimary)
        d.prepare(`UPDATE contact_phones SET is_primary = 0 WHERE lead_id = ?`).run(cur.leadId);
    d.prepare(`UPDATE contact_phones SET number = ?, kind = ?, dnc = ?, is_primary = ? WHERE id = ?`).run(patch.number !== undefined ? formatUsPhone(patch.number) : cur.number, patch.kind !== undefined ? normPhoneKind(patch.kind) : cur.kind, bool(patch.dnc !== undefined ? patch.dnc : cur.dnc), bool(patch.isPrimary !== undefined ? patch.isPrimary : cur.isPrimary), id);
    return getPhone(id);
}
function deletePhone(id) {
    const cur = getPhone(id);
    if (!cur)
        return null;
    const d = getContactRecordDb();
    d.prepare(`DELETE FROM contact_phones WHERE id = ?`).run(id);
    if (cur.isPrimary) {
        const next = listPhones(cur.leadId)[0];
        if (next)
            d.prepare(`UPDATE contact_phones SET is_primary = 1 WHERE id = ?`).run(next.id);
    }
    return cur;
}
const toAddress = (r) => ({
    id: r.id, leadId: r.lead_id, kind: normAddressKind(r.kind), street: r.street, apt: r.apt,
    city: r.city, region: r.region, country: r.country, postalCode: r.postal_code, createdAt: r.created_at,
});
function listAddresses(leadId) {
    return getContactRecordDb()
        .prepare(`SELECT * FROM contact_addresses WHERE lead_id = ? ORDER BY created_at ASC`)
        .all(leadId).map(toAddress);
}
function getAddress(id) {
    const r = getContactRecordDb().prepare(`SELECT * FROM contact_addresses WHERE id = ?`).get(id);
    return r ? toAddress(r) : null;
}
function addAddress(leadId, input) {
    const id = (0, crypto_1.randomUUID)();
    const country = (input.country || "US").trim().toUpperCase().slice(0, 2) || "US";
    getContactRecordDb()
        .prepare(`INSERT INTO contact_addresses (id, lead_id, kind, street, apt, city, region, country, postal_code, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, leadId, normAddressKind(input.kind), (input.street || "").trim(), (input.apt || "").trim(), (input.city || "").trim(), (input.region || "").trim().toUpperCase(), country, (input.postalCode || "").trim(), nowIso());
    return getAddress(id);
}
function updateAddress(id, input) {
    const cur = getAddress(id);
    if (!cur)
        return null;
    const pick = (v, fallback) => (v === undefined ? fallback : v);
    getContactRecordDb()
        .prepare(`UPDATE contact_addresses SET kind=?, street=?, apt=?, city=?, region=?, country=?, postal_code=? WHERE id=?`)
        .run(input.kind !== undefined ? normAddressKind(input.kind) : cur.kind, pick(input.street, cur.street).trim(), pick(input.apt, cur.apt).trim(), pick(input.city, cur.city).trim(), pick(input.region, cur.region).trim().toUpperCase(), pick(input.country, cur.country).trim().toUpperCase().slice(0, 2) || "US", pick(input.postalCode, cur.postalCode).trim(), id);
    return getAddress(id);
}
function deleteAddress(id) {
    return getContactRecordDb().prepare(`DELETE FROM contact_addresses WHERE id = ?`).run(id).changes > 0;
}
/** One line, the way an envelope reads. Used to seed the Lead's `address`. */
function addressOneLine(a) {
    const street = [a.street, a.apt].filter(Boolean).join(" #");
    const tail = [a.city, [a.region, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return [street, tail, a.country && a.country !== "US" ? a.country : ""].filter(Boolean).join(", ");
}
function listSocial(leadId) {
    const rows = getContactRecordDb()
        .prepare(`SELECT * FROM contact_social_links WHERE lead_id = ?`)
        .all(leadId);
    const byPlatform = new Map(rows.map((r) => [r.platform, r]));
    // Ordered by SOCIAL_PLATFORMS so the block's icon row never reshuffles.
    return exports.SOCIAL_PLATFORMS.filter((p) => byPlatform.has(p)).map((p) => {
        const r = byPlatform.get(p);
        return { leadId, platform: p, url: r.url, updatedAt: r.updated_at };
    });
}
/**
 * Replace the whole set from the Edit Modal. A blank URL removes the link
 * rather than storing an empty string, so "has a Facebook" stays a real yes/no.
 */
function setSocial(leadId, links) {
    const d = getContactRecordDb();
    const at = nowIso();
    const del = d.prepare(`DELETE FROM contact_social_links WHERE lead_id = ? AND platform = ?`);
    const put = d.prepare(`INSERT INTO contact_social_links (lead_id, platform, url, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(lead_id, platform) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`);
    d.transaction(() => {
        for (const platform of exports.SOCIAL_PLATFORMS) {
            if (!(platform in links))
                continue;
            const raw = links[platform];
            const url = typeof raw === "string" ? normalizeSocialUrl(platform, raw) : "";
            if (!url)
                del.run(leadId, platform);
            else
                put.run(leadId, platform, url, at);
        }
    })();
    return listSocial(leadId);
}
const SOCIAL_HOSTS = {
    facebook: "https://facebook.com/",
    x: "https://x.com/",
    linkedin: "https://linkedin.com/in/",
    instagram: "https://instagram.com/",
    youtube: "https://youtube.com/@",
    tiktok: "https://tiktok.com/@",
    pinterest: "https://pinterest.com/",
};
/**
 * The "auto-formatting" the spec's tip describes: a bare handle becomes the
 * platform's profile URL, a full URL is kept as typed. Only http(s) survives —
 * a `javascript:` "profile" would otherwise become a live link in the block.
 */
function normalizeSocialUrl(platform, raw) {
    const v = (raw || "").trim();
    if (!v)
        return "";
    if (/^https?:\/\//i.test(v))
        return v.slice(0, 400);
    if (/^[a-z][a-z0-9+.-]*:/i.test(v))
        return ""; // any other scheme: refuse
    const handle = v.replace(/^@+/, "").replace(/^\/+/, "");
    if (!handle)
        return "";
    return (SOCIAL_HOSTS[platform] + handle).slice(0, 400);
}
function listNotes(leadId) {
    const d = getContactRecordDb();
    const rows = d
        .prepare(`SELECT * FROM contact_notes WHERE lead_id = ? ORDER BY created_at DESC`)
        .all(leadId);
    if (!rows.length)
        return [];
    const mentions = d
        .prepare(`SELECT note_id, member_id, member_name FROM note_mentions WHERE lead_id = ?`)
        .all(leadId);
    const byNote = new Map();
    for (const m of mentions) {
        const list = byNote.get(m.note_id) || [];
        list.push({ memberId: m.member_id, memberName: m.member_name });
        byNote.set(m.note_id, list);
    }
    return rows.map((r) => ({
        id: r.id,
        leadId: r.lead_id,
        body: r.body,
        hiddenFromViewers: !!r.hidden_from_viewers,
        important: !!r.important,
        author: r.author,
        mentions: byNote.get(r.id) || [],
        createdAt: r.created_at,
    }));
}
function addNote(leadId, input) {
    const d = getContactRecordDb();
    const id = (0, crypto_1.randomUUID)();
    const at = nowIso();
    d.transaction(() => {
        d.prepare(`INSERT INTO contact_notes (id, lead_id, body, hidden_from_viewers, important, author, created_at)
       VALUES (?,?,?,?,?,?,?)`).run(id, leadId, input.body.trim().slice(0, 8000), 
        // Default hidden: the modal's toggle starts on, and a note written for
        // the team must never leak to a client view because nobody touched it.
        bool(input.hiddenFromViewers === undefined ? true : input.hiddenFromViewers), bool(input.important), (input.author || "").slice(0, 120), at);
        const put = d.prepare(`INSERT INTO note_mentions (id, note_id, lead_id, member_id, member_name, created_at) VALUES (?,?,?,?,?,?)`);
        for (const m of (input.mentions || []).slice(0, 20)) {
            if (!m || !m.memberId)
                continue;
            put.run((0, crypto_1.randomUUID)(), id, leadId, String(m.memberId).slice(0, 80), String(m.memberName || "").slice(0, 120), at);
        }
    })();
    return listNotes(leadId).find((n) => n.id === id);
}
function updateNote(id, patch) {
    const d = getContactRecordDb();
    const cur = d.prepare(`SELECT * FROM contact_notes WHERE id = ?`).get(id);
    if (!cur)
        return null;
    d.prepare(`UPDATE contact_notes SET body = ?, hidden_from_viewers = ?, important = ? WHERE id = ?`).run(patch.body !== undefined ? patch.body.trim().slice(0, 8000) : cur.body, bool(patch.hiddenFromViewers !== undefined ? patch.hiddenFromViewers : !!cur.hidden_from_viewers), bool(patch.important !== undefined ? patch.important : !!cur.important), id);
    return listNotes(cur.lead_id).find((n) => n.id === id) || null;
}
function deleteNote(id) {
    const d = getContactRecordDb();
    return d.transaction(() => {
        d.prepare(`DELETE FROM note_mentions WHERE note_id = ?`).run(id);
        return d.prepare(`DELETE FROM contact_notes WHERE id = ?`).run(id).changes > 0;
    })();
}
/* ────────────────────────── documents ────────────────────────── */
/** Document types the Select Document Type modal offers. */
exports.CONTACT_DOC_TYPES = [
    { id: "buyer_representation", label: "Buyer Representation Agreement" },
    { id: "listing_agreement", label: "Listing Agreement" },
    { id: "referral_agreement", label: "Referral Agreement" },
    { id: "disclosure", label: "Disclosure" },
    { id: "pre_approval", label: "Pre-Approval Letter" },
    { id: "identification", label: "Identification" },
    { id: "other", label: "Other" },
];
const DOC_TYPE_IDS = new Set(exports.CONTACT_DOC_TYPES.map((t) => t.id));
function normDocType(v) {
    return typeof v === "string" && DOC_TYPE_IDS.has(v) ? v : "other";
}
const toDoc = (r) => ({
    id: r.id, leadId: r.lead_id, docType: r.doc_type, fileName: r.file_name, mime: r.mime,
    bytes: r.bytes, storedPath: r.stored_path, signedDate: r.signed_date,
    expirationDate: r.expiration_date, transactionId: r.transaction_id, createdAt: r.created_at,
});
function listDocuments(leadId) {
    return getContactRecordDb()
        .prepare(`SELECT * FROM contact_documents WHERE lead_id = ? ORDER BY created_at DESC`)
        .all(leadId).map(toDoc);
}
function getDocument(id) {
    const r = getContactRecordDb().prepare(`SELECT * FROM contact_documents WHERE id = ?`).get(id);
    return r ? toDoc(r) : null;
}
function addDocument(leadId, input) {
    const id = (0, crypto_1.randomUUID)();
    getContactRecordDb()
        .prepare(`INSERT INTO contact_documents
       (id, lead_id, doc_type, file_name, mime, bytes, stored_path, signed_date, expiration_date, transaction_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, leadId, normDocType(input.docType), input.fileName.slice(0, 260), input.mime.slice(0, 120), Math.max(0, Math.round(input.bytes)), input.storedPath, normDay(input.signedDate), normDay(input.expirationDate), input.transactionId || null, nowIso());
    return getDocument(id);
}
function deleteDocument(id) {
    const cur = getDocument(id);
    if (!cur)
        return null;
    getContactRecordDb().prepare(`DELETE FROM contact_documents WHERE id = ?`).run(id);
    // The row is the only thing pointing at the file, so the file goes with it.
    try {
        if (cur.storedPath && (0, fs_1.existsSync)(cur.storedPath))
            (0, fs_1.rmSync)(cur.storedPath);
    }
    catch (err) {
        console.error("[contactRecord] could not remove document file:", err);
    }
    return cur;
}
/* ────────────────────────── whole record ────────────────────────── */
function getContactRecord(leadId) {
    return {
        emails: listEmails(leadId),
        phones: listPhones(leadId),
        addresses: listAddresses(leadId),
        social: listSocial(leadId),
        notes: listNotes(leadId),
        documents: listDocuments(leadId),
    };
}
/**
 * Seed the multi-value tables from the Lead's single-value fields, once.
 *
 * Every contact in this CRM predates this store, so without this the record
 * would open blank for 1,300 people who plainly do have an email and a phone.
 * It runs only when the lead has NO rows of that kind yet, so it can never
 * duplicate a row a human added or resurrect one they deleted.
 */
function seedFromLead(lead) {
    if (!lead || !lead.id)
        return;
    const d = getContactRecordDb();
    const countOf = (table) => d.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE lead_id = ?`).get(lead.id).n;
    if (lead.email && lead.email.trim() && countOf("contact_emails") === 0) {
        addEmail(lead.id, lead.email, "personal", true);
    }
    if (lead.phone && lead.phone.trim() && countOf("contact_phones") === 0) {
        addPhone(lead.id, lead.phone, "mobile", false, true);
    }
    if (lead.address && lead.address.trim() && countOf("contact_addresses") === 0) {
        // A free-text address cannot be split reliably, so it goes in as the street
        // line and the operator can correct it — better than three empty fields.
        addAddress(lead.id, { kind: "home", street: lead.address.trim(), country: "US" });
    }
}
/* ────────────────────────── team assignments ────────────────────────── */
/** Functional roles the Manage Team modal offers, in Brivity's order. */
exports.TEAM_ROLES = [
    "Broker",
    "Buyer's Agent",
    "Listing Agent",
    "Listing Coordinator",
    "Listing Representative",
    "Marketing Manager",
    "Referring Agent",
    "Team Owner",
    "Transaction Coordinator",
];
function listAssignments(leadId) {
    return getContactRecordDb()
        .prepare(`SELECT * FROM contact_assignments WHERE lead_id = ? ORDER BY created_at ASC`)
        .all(leadId)
        .map((r) => ({
        id: r.id, leadId: r.lead_id, userId: r.user_id, userName: r.user_name,
        roleName: r.role_name, createdAt: r.created_at,
    }));
}
/**
 * Replace the whole team for one contact, as the modal's SAVE TEAM does.
 *
 * Whole-set replacement rather than add/remove deltas because the modal edits
 * a list and saves it once: computing a diff on the client would let a row the
 * operator deleted survive a race with one they added.
 */
function setAssignments(leadId, members) {
    const d = getContactRecordDb();
    const at = nowIso();
    d.transaction(() => {
        d.prepare(`DELETE FROM contact_assignments WHERE lead_id = ?`).run(leadId);
        const put = d.prepare(`INSERT INTO contact_assignments (id, lead_id, user_id, user_name, role_name, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(lead_id, user_id) DO UPDATE SET role_name = excluded.role_name, updated_at = excluded.updated_at`);
        const seen = new Set();
        for (const m of members.slice(0, 25)) {
            const uid = String(m?.userId || "").trim().slice(0, 80);
            // One row per person: the same member twice with two roles is a mistake,
            // and the UNIQUE constraint should never be the thing that reports it.
            if (!uid || seen.has(uid))
                continue;
            seen.add(uid);
            const role = String(m.roleName || "").trim().slice(0, 100);
            put.run((0, crypto_1.randomUUID)(), leadId, uid, String(m.userName || uid).slice(0, 120), role, at, at);
        }
    })();
    return listAssignments(leadId);
}
/* ────────────────────────── agreements ────────────────────────── */
exports.AGREEMENT_KINDS = ["buyer", "seller", "referral"];
/** Property classifications the agreement modal offers; Residential is default. */
exports.PROPERTY_TYPES = [
    "Residential",
    "Commercial",
    "Manufactured Home",
    "Rental",
    "Business Opportunity",
    "Multi-Family",
    "Vacant Land",
    "Condominium",
];
exports.CLIENT_INTENTS = ["Buyer", "Seller", "Tenant", "Landlord"];
const toAgreement = (r) => ({
    id: r.id, leadId: r.lead_id, kind: exports.AGREEMENT_KINDS.includes(r.kind) ? r.kind : "referral",
    documentId: r.document_id, transactionId: r.transaction_id, title: r.title, feeValue: r.fee_value,
    feeType: r.fee_type, referringAgent: r.referring_agent, partnerLeadId: r.partner_lead_id,
    partnerName: r.partner_name, clientIntent: r.client_intent, propertyType: r.property_type,
    signedDate: r.signed_date, expirationDate: r.expiration_date, isActive: !!r.is_active, createdAt: r.created_at,
});
function listAgreements(leadId) {
    return getContactRecordDb()
        .prepare(`SELECT * FROM referral_agreements WHERE lead_id = ? ORDER BY created_at DESC`)
        .all(leadId).map(toAgreement);
}
function getAgreement(id) {
    const r = getContactRecordDb().prepare(`SELECT * FROM referral_agreements WHERE id = ?`).get(id);
    return r ? toAgreement(r) : null;
}
const oneOf = (list, v, fallback) => typeof v === "string" && list.includes(v) ? v : fallback;
function addAgreement(leadId, input) {
    const id = (0, crypto_1.randomUUID)();
    getContactRecordDb()
        .prepare(`INSERT INTO referral_agreements
       (id, lead_id, kind, document_id, transaction_id, title, fee_value, fee_type, referring_agent,
        partner_lead_id, partner_name, client_intent, property_type, signed_date, expiration_date, is_active, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, leadId, oneOf(exports.AGREEMENT_KINDS, input.kind, "referral"), input.documentId || null, input.transactionId || null, (input.title || "").trim().slice(0, 255), typeof input.feeValue === "number" && Number.isFinite(input.feeValue) ? input.feeValue : null, input.feeType === "flat" ? "flat" : "percentage", (input.referringAgent || "").trim().slice(0, 120), input.partnerLeadId || null, (input.partnerName || "").trim().slice(0, 160), oneOf(exports.CLIENT_INTENTS, input.clientIntent, "Buyer"), oneOf(exports.PROPERTY_TYPES, input.propertyType, "Residential"), normDay(input.signedDate), normDay(input.expirationDate), 1, nowIso());
    return getAgreement(id);
}
function deleteAgreement(id) {
    const cur = getAgreement(id);
    if (!cur)
        return null;
    getContactRecordDb().prepare(`DELETE FROM referral_agreements WHERE id = ?`).run(id);
    return cur;
}
