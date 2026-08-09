"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STANDARD_DEADLINE_RULES = void 0;
exports.recordTransactionImport = recordTransactionImport;
exports.getLastTransactionImport = getLastTransactionImport;
exports.getTransactionByExternalKey = getTransactionByExternalKey;
exports.getTransactionsDb = getTransactionsDb;
exports.resolveTemplatesDir = resolveTemplatesDir;
exports.resolveGeneratedDocsDir = resolveGeneratedDocsDir;
exports.createTransaction = createTransaction;
exports.updateTransaction = updateTransaction;
exports.getTransaction = getTransaction;
exports.getAllTransactions = getAllTransactions;
exports.deleteTransaction = deleteTransaction;
exports.syncDeadlinesFromTransaction = syncDeadlinesFromTransaction;
exports.generateFullDeadlineTimeline = generateFullDeadlineTimeline;
exports.resolveFieldValues = resolveFieldValues;
exports.createDeadline = createDeadline;
exports.getDeadlinesForDeal = getDeadlinesForDeal;
exports.getUpcomingDeadlines = getUpcomingDeadlines;
exports.getOverdueDeadlines = getOverdueDeadlines;
exports.markDeadlineAlertSent = markDeadlineAlertSent;
exports.markDeadlineEscalated = markDeadlineEscalated;
exports.markDeadlineMissedSameDayEscalated = markDeadlineMissedSameDayEscalated;
exports.markDeadlineCompleted = markDeadlineCompleted;
exports.createDocument = createDocument;
exports.updateDocumentStatus = updateDocumentStatus;
exports.getDocumentsForDeal = getDocumentsForDeal;
exports.getUnsignedDocuments = getUnsignedDocuments;
exports.getDocument = getDocument;
exports.flagDocumentForReview = flagDocumentForReview;
exports.getDocumentsNeedingReview = getDocumentsNeedingReview;
exports.createDocumentTemplate = createDocumentTemplate;
exports.getAllTemplates = getAllTemplates;
exports.getTemplate = getTemplate;
exports.mapOldDealStatusToTransaction = mapOldDealStatusToTransaction;
exports.migrateSigningDocuments = migrateSigningDocuments;
exports.migrateFromDealsJson = migrateFromDealsJson;
exports.countTransactions = countTransactions;
const crypto_1 = require("crypto");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function resolveTransactionsDbPath() {
    const env = process.env.TRANSACTIONS_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/transactions.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "transactions.db");
}
let db = null;
function initTransactionsSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      deal_type TEXT NOT NULL,
      parties TEXT NOT NULL,
      price REAL,
      status TEXT NOT NULL DEFAULT 'active',
      contract_date TEXT,
      inspection_date TEXT,
      appraisal_date TEXT,
      loan_commitment_date TEXT,
      title_date TEXT,
      closing_date TEXT,
      possession_date TEXT,
      lead_id TEXT,
      deal_file_url TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_lead ON transactions(lead_id)`);
    database.exec(`
    CREATE TABLE IF NOT EXISTS transaction_deadlines (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      deadline_type TEXT NOT NULL,
      label TEXT,
      due_date TEXT NOT NULL,
      alert_sent INTEGER NOT NULL DEFAULT 0,
      escalated INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (deal_id) REFERENCES transactions(id)
    )
  `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_deadlines_deal ON transaction_deadlines(deal_id)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_deadlines_due ON transaction_deadlines(due_date)`);
    database.exec(`
    CREATE TABLE IF NOT EXISTS transaction_documents (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      document_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      parties TEXT,
      signed_at TEXT,
      sent_at TEXT,
      document_url TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (deal_id) REFERENCES transactions(id)
    )
  `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_documents_deal ON transaction_documents(deal_id)`);
    database.exec(`
    CREATE TABLE IF NOT EXISTS document_templates (
      id TEXT PRIMARY KEY,
      template_type TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      field_mapping TEXT,
      uploaded_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )
  `);
    try {
        database.exec(`ALTER TABLE transaction_documents ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0`);
    }
    catch {
        /* column exists */
    }
    try {
        database.exec(`ALTER TABLE transaction_documents ADD COLUMN missing_fields TEXT`);
    }
    catch {
        /* column exists */
    }
    try {
        database.exec(`ALTER TABLE transactions ADD COLUMN inspection_flow TEXT DEFAULT '{}'`);
    }
    catch {
        /* column exists */
    }
    try {
        database.exec(`ALTER TABLE transactions ADD COLUMN final_week_flow TEXT DEFAULT '{}'`);
    }
    catch {
        /* column exists */
    }
    try {
        database.exec(`ALTER TABLE transactions ADD COLUMN post_close_flow TEXT DEFAULT '{}'`);
    }
    catch {
        /* column exists */
    }
    try {
        database.exec(`ALTER TABLE transaction_deadlines ADD COLUMN missed_same_day_escalated INTEGER NOT NULL DEFAULT 0`);
    }
    catch {
        /* column exists */
    }
    /* Import provenance and the fields a Brivity transaction export carries that
       the deadline/document engine never needed. They live in real columns
       rather than in `parties` because they are not parties — `parties` is
       already enough of a grab-bag. */
    for (const [column, ddl] of [
        ["mls", "TEXT"],
        ["list_price", "REAL"],
        ["gci", "REAL"],
        ["agent", "TEXT"],
        ["source", "TEXT"],
        ["external_key", "TEXT"],
        ["imported_at", "TEXT"],
        /* Listing-agreement expiration (ISO date). The UI showed an Expiration
           column for years while nothing stored one, so every value typed there
           evaporated on reload — and an expiring listing is precisely the thing a
           seller's agent cannot afford to discover late. */
        ["expiration", "TEXT"],
        /* Transaction Auto Plan enrollments (JSON array). Date-anchored plans need
           somewhere to live on the deal itself; leads keep theirs on the lead. */
        ["auto_plans", "TEXT"],
        /* Brivity transaction-page dates (team feature list, Aug 2026). */
        ["date_listed", "TEXT"],
        ["date_canceled", "TEXT"],
        ["status_changed_at", "TEXT"],
        ["deposit_due", "TEXT"],
        ["additional_deposit_due", "TEXT"],
        ["escrow_signing_date", "TEXT"],
    ]) {
        try {
            database.exec(`ALTER TABLE transactions ADD COLUMN ${column} ${ddl}`);
        }
        catch {
            /* column exists */
        }
    }
    database.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_external_key ON transactions(external_key)`);
    /**
     * One row per import run. This is what lets the UI say "as of 14 Jul"
     * instead of "real-time" — a snapshot with no provenance is the same class
     * of lie as a zero that means "no data".
     */
    database.exec(`
    CREATE TABLE IF NOT EXISTS transaction_imports (
      id TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      filename TEXT,
      source TEXT NOT NULL DEFAULT 'csv',
      rows_seen INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      unmapped_headers TEXT,
      errors TEXT
    )
  `);
}
function recordTransactionImport(run) {
    const database = getTransactionsDb();
    const id = (0, crypto_1.randomUUID)();
    const importedAt = run.importedAt || new Date().toISOString();
    database
        .prepare(`INSERT INTO transaction_imports
        (id, imported_at, filename, source, rows_seen, created, updated, skipped, unmapped_headers, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, importedAt, run.filename ?? null, run.source, run.rowsSeen, run.created, run.updated, run.skipped, JSON.stringify(run.unmappedHeaders || []), JSON.stringify(run.errors || []));
    return { ...run, id, importedAt, filename: run.filename ?? null };
}
/** The most recent import, or null if transactions have only ever been typed in by hand. */
function getLastTransactionImport() {
    const database = getTransactionsDb();
    const row = database
        .prepare(`SELECT * FROM transaction_imports ORDER BY imported_at DESC LIMIT 1`)
        .get();
    if (!row)
        return null;
    return {
        id: String(row.id),
        importedAt: String(row.imported_at),
        filename: row.filename ? String(row.filename) : null,
        source: String(row.source || "csv"),
        rowsSeen: Number(row.rows_seen || 0),
        created: Number(row.created || 0),
        updated: Number(row.updated || 0),
        skipped: Number(row.skipped || 0),
        unmappedHeaders: parseJsonColumn(row.unmapped_headers, []),
        errors: parseJsonColumn(row.errors, []),
    };
}
/** Look up a previously-imported transaction by its stable source key (MLS #, or address). */
function getTransactionByExternalKey(key) {
    if (!key.trim())
        return null;
    const database = getTransactionsDb();
    const row = database
        .prepare(`SELECT * FROM transactions WHERE external_key = ?`)
        .get(key.trim());
    return row ? rowToTransaction(row) : null;
}
function getTransactionsDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveTransactionsDbPath());
        initTransactionsSchema(db);
    }
    return db;
}
function resolveTemplatesDir() {
    if ((0, fs_1.existsSync)("/data")) {
        const dir = "/data/templates";
        (0, fs_1.mkdirSync)(dir, { recursive: true });
        return dir;
    }
    const localDir = path_1.default.join(process.cwd(), "data", "templates");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return localDir;
}
function resolveGeneratedDocsDir() {
    if ((0, fs_1.existsSync)("/data")) {
        const dir = "/data/generated-docs";
        (0, fs_1.mkdirSync)(dir, { recursive: true });
        return dir;
    }
    const localDir = path_1.default.join(process.cwd(), "data", "generated-docs");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return localDir;
}
function rowToTransaction(row) {
    return {
        id: String(row.id),
        address: String(row.address),
        dealType: row.deal_type,
        parties: JSON.parse(String(row.parties || "{}")),
        price: typeof row.price === "number" ? row.price : row.price != null ? Number(row.price) : undefined,
        status: row.status,
        contractDate: row.contract_date ? String(row.contract_date) : undefined,
        inspectionDate: row.inspection_date ? String(row.inspection_date) : undefined,
        appraisalDate: row.appraisal_date ? String(row.appraisal_date) : undefined,
        loanCommitmentDate: row.loan_commitment_date ? String(row.loan_commitment_date) : undefined,
        titleDate: row.title_date ? String(row.title_date) : undefined,
        closingDate: row.closing_date ? String(row.closing_date) : undefined,
        possessionDate: row.possession_date ? String(row.possession_date) : undefined,
        leadId: row.lead_id ? String(row.lead_id) : undefined,
        dealFileUrl: row.deal_file_url ? String(row.deal_file_url) : undefined,
        notes: row.notes ? String(row.notes) : undefined,
        inspectionFlow: parseJsonColumn(row.inspection_flow, {}),
        finalWeekFlow: parseJsonColumn(row.final_week_flow, {}),
        postCloseFlow: parseJsonColumn(row.post_close_flow, {}),
        mls: row.mls ? String(row.mls) : undefined,
        listPrice: row.list_price != null ? Number(row.list_price) : undefined,
        gci: row.gci != null ? Number(row.gci) : undefined,
        expiration: row.expiration ? String(row.expiration) : undefined,
        dateListed: row.date_listed ? String(row.date_listed) : undefined,
        dateCanceled: row.date_canceled ? String(row.date_canceled) : undefined,
        statusChangedAt: row.status_changed_at ? String(row.status_changed_at) : undefined,
        depositDue: row.deposit_due ? String(row.deposit_due) : undefined,
        additionalDepositDue: row.additional_deposit_due ? String(row.additional_deposit_due) : undefined,
        escrowSigningDate: row.escrow_signing_date ? String(row.escrow_signing_date) : undefined,
        autoPlans: (() => {
            try {
                const parsed = row.auto_plans ? JSON.parse(String(row.auto_plans)) : null;
                return Array.isArray(parsed) ? parsed : undefined;
            }
            catch {
                return undefined;
            }
        })(),
        agent: row.agent ? String(row.agent) : undefined,
        source: row.source ? String(row.source) : undefined,
        externalKey: row.external_key ? String(row.external_key) : undefined,
        importedAt: row.imported_at ? String(row.imported_at) : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}
function parseJsonColumn(value, fallback) {
    if (!value)
        return fallback;
    try {
        return JSON.parse(String(value));
    }
    catch {
        return fallback;
    }
}
function rowToDeadline(row) {
    return {
        id: String(row.id),
        dealId: String(row.deal_id),
        deadlineType: row.deadline_type,
        label: row.label ? String(row.label) : undefined,
        dueDate: String(row.due_date),
        alertSent: Number(row.alert_sent) === 1,
        escalated: Number(row.escalated) === 1,
        completed: Number(row.completed) === 1,
        completedAt: row.completed_at ? String(row.completed_at) : undefined,
        missedSameDayEscalated: Number(row.missed_same_day_escalated) === 1,
        createdAt: String(row.created_at),
    };
}
function rowToDocument(row) {
    let missingFields;
    if (row.missing_fields) {
        try {
            missingFields = JSON.parse(String(row.missing_fields));
        }
        catch {
            missingFields = undefined;
        }
    }
    return {
        id: String(row.id),
        dealId: String(row.deal_id),
        documentType: row.document_type,
        status: row.status,
        parties: JSON.parse(String(row.parties || "[]")),
        signedAt: row.signed_at ? String(row.signed_at) : undefined,
        sentAt: row.sent_at ? String(row.sent_at) : undefined,
        documentUrl: row.document_url ? String(row.document_url) : undefined,
        notes: row.notes ? String(row.notes) : undefined,
        needsReview: Number(row.needs_review) === 1,
        missingFields,
        createdAt: String(row.created_at),
    };
}
function rowToTemplate(row) {
    return {
        id: String(row.id),
        templateType: row.template_type,
        name: String(row.name),
        filePath: String(row.file_path),
        fieldMapping: JSON.parse(String(row.field_mapping || "{}")),
        uploadedAt: String(row.uploaded_at),
        active: Number(row.active) === 1,
    };
}
function createTransaction(tx, options) {
    const database = getTransactionsDb();
    const id = options?.id?.trim() || (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    database
        .prepare(`INSERT INTO transactions
        (id, address, deal_type, parties, price, status, contract_date, inspection_date,
         appraisal_date, loan_commitment_date, title_date, closing_date, possession_date,
         lead_id, deal_file_url, notes, mls, list_price, gci, expiration, auto_plans, agent, source, external_key,
         imported_at, date_listed, date_canceled, status_changed_at, deposit_due, additional_deposit_due, escrow_signing_date,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tx.address, tx.dealType, JSON.stringify(tx.parties || {}), tx.price ?? null, tx.status, tx.contractDate ?? null, tx.inspectionDate ?? null, tx.appraisalDate ?? null, tx.loanCommitmentDate ?? null, tx.titleDate ?? null, tx.closingDate ?? null, tx.possessionDate ?? null, tx.leadId ?? null, tx.dealFileUrl ?? null, tx.notes ?? null, tx.mls ?? null, tx.listPrice ?? null, tx.gci ?? null, tx.expiration ?? null, tx.autoPlans ? JSON.stringify(tx.autoPlans) : null, tx.agent ?? null, tx.source ?? null, tx.externalKey ?? null, tx.importedAt ?? null, tx.dateListed ?? null, tx.dateCanceled ?? null, tx.statusChangedAt ?? now, tx.depositDue ?? null, tx.additionalDepositDue ?? null, tx.escrowSigningDate ?? null, now, now);
    const created = { ...tx, id, statusChangedAt: tx.statusChangedAt ?? now, createdAt: now, updatedAt: now };
    if (created.status === "under_contract") {
        syncDeadlinesFromTransaction(created);
    }
    return created;
}
function updateTransaction(id, updates) {
    const existing = getTransaction(id);
    if (!existing)
        return null;
    const merged = {
        ...existing,
        ...updates,
        /* Brivity's Status Changed At: stamped automatically whenever status
           actually moves, so the tx table's column and date-range filter are real. */
        statusChangedAt: updates.status !== undefined && updates.status !== existing.status
            ? new Date().toISOString().slice(0, 10)
            : (updates.statusChangedAt ?? existing.statusChangedAt),
        parties: { ...existing.parties, ...(updates.parties ?? {}) },
        inspectionFlow: { ...existing.inspectionFlow, ...(updates.inspectionFlow ?? {}) },
        finalWeekFlow: { ...existing.finalWeekFlow, ...(updates.finalWeekFlow ?? {}) },
        postCloseFlow: { ...existing.postCloseFlow, ...(updates.postCloseFlow ?? {}) },
        updatedAt: new Date().toISOString(),
    };
    const database = getTransactionsDb();
    database
        .prepare(`UPDATE transactions SET
        address = ?, deal_type = ?, parties = ?, price = ?, status = ?,
        contract_date = ?, inspection_date = ?, appraisal_date = ?, loan_commitment_date = ?,
        title_date = ?, closing_date = ?, possession_date = ?, lead_id = ?, deal_file_url = ?,
        notes = ?, inspection_flow = ?, final_week_flow = ?, post_close_flow = ?,
        mls = ?, list_price = ?, gci = ?, expiration = ?, auto_plans = ?, agent = ?, source = ?, external_key = ?,
        imported_at = ?, date_listed = ?, date_canceled = ?, status_changed_at = ?,
        deposit_due = ?, additional_deposit_due = ?, escrow_signing_date = ?, updated_at = ?
      WHERE id = ?`)
        .run(merged.address, merged.dealType, JSON.stringify(merged.parties || {}), merged.price ?? null, merged.status, merged.contractDate ?? null, merged.inspectionDate ?? null, merged.appraisalDate ?? null, merged.loanCommitmentDate ?? null, merged.titleDate ?? null, merged.closingDate ?? null, merged.possessionDate ?? null, merged.leadId ?? null, merged.dealFileUrl ?? null, merged.notes ?? null, JSON.stringify(merged.inspectionFlow || {}), JSON.stringify(merged.finalWeekFlow || {}), JSON.stringify(merged.postCloseFlow || {}), merged.mls ?? null, merged.listPrice ?? null, merged.gci ?? null, merged.expiration ?? null, merged.autoPlans ? JSON.stringify(merged.autoPlans) : null, merged.agent ?? null, merged.source ?? null, merged.externalKey ?? null, merged.importedAt ?? null, merged.dateListed ?? null, merged.dateCanceled ?? null, merged.statusChangedAt ?? null, merged.depositDue ?? null, merged.additionalDepositDue ?? null, merged.escrowSigningDate ?? null, merged.updatedAt, id);
    if (merged.status === "under_contract") {
        syncDeadlinesFromTransaction(merged);
    }
    return merged;
}
function getTransaction(id) {
    const database = getTransactionsDb();
    const row = database.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id);
    return row ? rowToTransaction(row) : null;
}
function getAllTransactions(statusFilter) {
    const database = getTransactionsDb();
    const rows = statusFilter
        ? database
            .prepare(`SELECT * FROM transactions WHERE status = ? ORDER BY closing_date ASC`)
            .all(statusFilter)
        : database
            .prepare(`SELECT * FROM transactions ORDER BY closing_date ASC`)
            .all();
    return rows.map(rowToTransaction);
}
function deleteTransaction(id) {
    const database = getTransactionsDb();
    database.prepare(`DELETE FROM transaction_deadlines WHERE deal_id = ?`).run(id);
    database.prepare(`DELETE FROM transaction_documents WHERE deal_id = ?`).run(id);
    const result = database.prepare(`DELETE FROM transactions WHERE id = ?`).run(id);
    return result.changes > 0;
}
function syncDeadlinesFromTransaction(tx) {
    if (!tx.id)
        return;
    const existing = getDeadlinesForDeal(tx.id);
    const existingTypes = new Set(existing.map((d) => d.deadlineType));
    const dateFieldMap = [
        ["inspection", tx.inspectionDate],
        ["appraisal", tx.appraisalDate],
        ["loan_commitment", tx.loanCommitmentDate],
        ["title", tx.titleDate],
        ["closing", tx.closingDate],
    ];
    for (const [type, date] of dateFieldMap) {
        if (date && !existingTypes.has(type)) {
            createDeadline({ dealId: tx.id, deadlineType: type, dueDate: date });
        }
    }
}
exports.STANDARD_DEADLINE_RULES = [
    { type: "option_period", label: "Option Period Ends", calculateFrom: "contract_date", offsetDays: 10 },
    { type: "earnest_money", label: "Earnest Money Due", calculateFrom: "contract_date", offsetDays: 3 },
    { type: "inspection", label: "Inspection Deadline", calculateFrom: "contract_date", offsetDays: 10 },
    { type: "loan_commitment", label: "Loan Commitment Deadline", calculateFrom: "contract_date", offsetDays: 21 },
    { type: "appraisal", label: "Appraisal Deadline", calculateFrom: "contract_date", offsetDays: 21 },
    { type: "title", label: "Title Commitment Due", calculateFrom: "contract_date", offsetDays: 15 },
];
function explicitDateForDeadlineType(type, tx) {
    switch (type) {
        case "inspection":
            return tx.inspectionDate;
        case "appraisal":
            return tx.appraisalDate;
        case "loan_commitment":
            return tx.loanCommitmentDate;
        case "title":
            return tx.titleDate;
        case "closing":
            return tx.closingDate;
        default:
            return undefined;
    }
}
function generateFullDeadlineTimeline(tx) {
    if (!tx.contractDate) {
        console.warn("[Transactions] Cannot generate timeline without contractDate for", tx.id);
        return [];
    }
    const existing = getDeadlinesForDeal(tx.id);
    const existingTypes = new Set(existing.map((d) => d.deadlineType));
    const created = [];
    const contractDate = new Date(tx.contractDate);
    for (const rule of exports.STANDARD_DEADLINE_RULES) {
        if (existingTypes.has(rule.type))
            continue;
        const explicitDate = explicitDateForDeadlineType(rule.type, tx);
        const dueDate = explicitDate
            ? new Date(explicitDate)
            : new Date(contractDate.getTime() + rule.offsetDays * 24 * 60 * 60 * 1000);
        const deadline = createDeadline({
            dealId: tx.id,
            deadlineType: rule.type,
            label: rule.label,
            dueDate: dueDate.toISOString(),
        });
        created.push(deadline);
    }
    if (tx.closingDate && !existingTypes.has("closing")) {
        const deadline = createDeadline({
            dealId: tx.id,
            deadlineType: "closing",
            label: "Closing Date",
            dueDate: tx.closingDate,
        });
        created.push(deadline);
    }
    console.log("[Transactions] Generated", created.length, "deadlines for deal", tx.id);
    return created;
}
function resolveFieldValues(tx, fieldMapping) {
    const resolved = {};
    for (const [pdfFieldName, dataPath] of Object.entries(fieldMapping)) {
        const value = getValueByPath(tx, dataPath);
        resolved[pdfFieldName] = value !== undefined && value !== null ? String(value) : "";
    }
    return resolved;
}
function getValueByPath(obj, dataPath) {
    return dataPath.split(".").reduce((acc, key) => {
        if (acc && typeof acc === "object" && key in acc) {
            return acc[key];
        }
        return undefined;
    }, obj);
}
function createDeadline(deadline) {
    const database = getTransactionsDb();
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    database
        .prepare(`INSERT INTO transaction_deadlines (id, deal_id, deadline_type, label, due_date, alert_sent, escalated, completed, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)`)
        .run(id, deadline.dealId, deadline.deadlineType, deadline.label ?? null, deadline.dueDate, now);
    return { ...deadline, id, alertSent: false, escalated: false, completed: false, createdAt: now };
}
function getDeadlinesForDeal(dealId) {
    const database = getTransactionsDb();
    const rows = database
        .prepare(`SELECT * FROM transaction_deadlines WHERE deal_id = ? ORDER BY due_date ASC`)
        .all(dealId);
    return rows.map(rowToDeadline);
}
function getUpcomingDeadlines(withinDays = 7) {
    const database = getTransactionsDb();
    const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = database
        .prepare(`SELECT * FROM transaction_deadlines
       WHERE due_date <= ? AND completed = 0
       ORDER BY due_date ASC`)
        .all(cutoff);
    return rows.map(rowToDeadline);
}
function getOverdueDeadlines() {
    const database = getTransactionsDb();
    const now = new Date().toISOString();
    const rows = database
        .prepare(`SELECT * FROM transaction_deadlines
       WHERE due_date < ? AND completed = 0
       ORDER BY due_date ASC`)
        .all(now);
    return rows.map(rowToDeadline);
}
function markDeadlineAlertSent(id) {
    getTransactionsDb().prepare(`UPDATE transaction_deadlines SET alert_sent = 1 WHERE id = ?`).run(id);
}
function markDeadlineEscalated(id) {
    getTransactionsDb().prepare(`UPDATE transaction_deadlines SET escalated = 1 WHERE id = ?`).run(id);
}
function markDeadlineMissedSameDayEscalated(id) {
    getTransactionsDb()
        .prepare(`UPDATE transaction_deadlines SET missed_same_day_escalated = 1 WHERE id = ?`)
        .run(id);
}
function markDeadlineCompleted(id) {
    getTransactionsDb()
        .prepare(`UPDATE transaction_deadlines SET completed = 1, completed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), id);
}
function createDocument(doc) {
    const database = getTransactionsDb();
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    const needsReview = doc.needsReview ? 1 : 0;
    const missingFieldsJson = doc.missingFields ? JSON.stringify(doc.missingFields) : null;
    database
        .prepare(`INSERT INTO transaction_documents (id, deal_id, document_type, status, parties, signed_at, sent_at, document_url, notes, created_at, needs_review, missing_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, doc.dealId, doc.documentType, doc.status, JSON.stringify(doc.parties || []), doc.signedAt ?? null, doc.sentAt ?? null, doc.documentUrl ?? null, doc.notes ?? null, now, needsReview, missingFieldsJson);
    return {
        ...doc,
        id,
        createdAt: now,
        needsReview: doc.needsReview ?? false,
        missingFields: doc.missingFields,
    };
}
function updateDocumentStatus(id, status, signedAt) {
    getTransactionsDb()
        .prepare(`UPDATE transaction_documents SET status = ?, signed_at = ? WHERE id = ?`)
        .run(status, signedAt ?? null, id);
}
function getDocumentsForDeal(dealId) {
    const database = getTransactionsDb();
    const rows = database
        .prepare(`SELECT * FROM transaction_documents WHERE deal_id = ? ORDER BY created_at ASC`)
        .all(dealId);
    return rows.map(rowToDocument);
}
function getUnsignedDocuments() {
    const database = getTransactionsDb();
    const rows = database
        .prepare(`SELECT * FROM transaction_documents WHERE status IN ('sent', 'pending') ORDER BY sent_at ASC`)
        .all();
    return rows.map(rowToDocument);
}
function getDocument(id) {
    const database = getTransactionsDb();
    const row = database.prepare(`SELECT * FROM transaction_documents WHERE id = ?`).get(id);
    return row ? rowToDocument(row) : null;
}
function flagDocumentForReview(id, documentUrl, missingFields) {
    getTransactionsDb()
        .prepare(`UPDATE transaction_documents SET document_url = ?, needs_review = ?, missing_fields = ?, status = 'pending' WHERE id = ?`)
        .run(documentUrl, missingFields.length > 0 ? 1 : 0, JSON.stringify(missingFields), id);
}
function getDocumentsNeedingReview() {
    const database = getTransactionsDb();
    const rows = database
        .prepare(`SELECT * FROM transaction_documents WHERE needs_review = 1 ORDER BY created_at ASC`)
        .all();
    return rows.map(rowToDocument);
}
function createDocumentTemplate(template) {
    const database = getTransactionsDb();
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    database
        .prepare(`INSERT INTO document_templates (id, template_type, name, file_path, field_mapping, uploaded_at, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`)
        .run(id, template.templateType, template.name, template.filePath, JSON.stringify(template.fieldMapping || {}), now);
    return { ...template, id, uploadedAt: now, active: true };
}
function getAllTemplates(typeFilter) {
    const database = getTransactionsDb();
    const rows = typeFilter
        ? database
            .prepare(`SELECT * FROM document_templates WHERE template_type = ? AND active = 1`)
            .all(typeFilter)
        : database
            .prepare(`SELECT * FROM document_templates WHERE active = 1`)
            .all();
    return rows.map(rowToTemplate);
}
function getTemplate(id) {
    const database = getTransactionsDb();
    const row = database.prepare(`SELECT * FROM document_templates WHERE id = ?`).get(id);
    return row ? rowToTemplate(row) : null;
}
function mapOldDealStatusToTransaction(status) {
    const map = {
        prospect: "active",
        active: "active",
        under_contract: "under_contract",
        pending: "pending",
        closed: "closed",
        fallen_through: "fell_through",
        fell_through: "fell_through",
        cancelled: "cancelled",
    };
    return map[status] ?? "active";
}
function migrateSigningDocuments(dealId, documents) {
    for (const doc of documents) {
        const status = doc.status === "signed" || doc.status === "declined" || doc.status === "sent" || doc.status === "pending"
            ? doc.status
            : "pending";
        createDocument({
            dealId,
            documentType: "other",
            status,
            sentAt: doc.sentAt,
            signedAt: doc.signedAt,
            documentUrl: doc.fileData?.startsWith("data:") ? doc.fileData : undefined,
            notes: doc.name,
            parties: doc.signerName ? [doc.signerName] : undefined,
        });
    }
}
function migrateFromDealsJson(deals) {
    let migrated = 0;
    let skipped = 0;
    for (const raw of deals) {
        if (!raw || typeof raw !== "object") {
            skipped++;
            continue;
        }
        const deal = raw;
        const address = typeof deal.propertyAddress === "string" && deal.propertyAddress.trim()
            ? deal.propertyAddress.trim()
            : typeof deal.address === "string" && deal.address.trim()
                ? deal.address.trim()
                : "Unknown address";
        const leadName = typeof deal.leadName === "string" ? deal.leadName.trim() : "";
        if (!leadName) {
            skipped++;
            continue;
        }
        const dealTypeRaw = typeof deal.dealType === "string" ? deal.dealType : "buyer";
        let dealType = "buyer";
        let dealSubtype;
        if (dealTypeRaw === "seller")
            dealType = "seller";
        else if (dealTypeRaw === "referral" || dealTypeRaw === "investor") {
            dealType = "buyer";
            dealSubtype = dealTypeRaw;
        }
        const statusRaw = typeof deal.status === "string" ? deal.status : "prospect";
        const legacyStatus = statusRaw === "prospect" ? "prospect" : undefined;
        try {
            const id = typeof deal.id === "string" && deal.id.trim() ? deal.id.trim() : undefined;
            if (id && getTransaction(id)) {
                skipped++;
                continue;
            }
            const tx = createTransaction({
                address,
                dealType,
                parties: {
                    leadName,
                    phone: typeof deal.phone === "string" ? deal.phone : undefined,
                    email: typeof deal.email === "string" ? deal.email : undefined,
                    assignedTo: typeof deal.assignedTo === "string" ? deal.assignedTo : undefined,
                    commissionPercent: typeof deal.commissionPercent === "number" ? deal.commissionPercent : undefined,
                    estimatedGCI: typeof deal.estimatedGCI === "number" ? deal.estimatedGCI : undefined,
                    openedDate: typeof deal.openedDate === "string" ? deal.openedDate : undefined,
                    closedDate: typeof deal.closedDate === "string" ? deal.closedDate : undefined,
                    legacyStatus,
                    dealSubtype,
                    activityLog: Array.isArray(deal.activityLog)
                        ? deal.activityLog
                        : undefined,
                },
                price: typeof deal.salePrice === "number" ? deal.salePrice : undefined,
                status: mapOldDealStatusToTransaction(statusRaw),
                closingDate: typeof deal.closeDate === "string" ? deal.closeDate : undefined,
                leadId: typeof deal.leadId === "string" ? deal.leadId : undefined,
                notes: typeof deal.notes === "string" ? deal.notes : undefined,
            }, { id });
            if (Array.isArray(deal.documents)) {
                migrateSigningDocuments(tx.id, deal.documents);
            }
            migrated++;
        }
        catch (err) {
            console.error("[TransactionsMigration] Failed to migrate deal:", deal, err);
            skipped++;
        }
    }
    return { migrated, skipped };
}
function countTransactions() {
    const row = getTransactionsDb()
        .prepare(`SELECT COUNT(*) AS c FROM transactions`)
        .get();
    return Number(row.c) || 0;
}
