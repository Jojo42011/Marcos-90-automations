import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

import type { DealActivityLogEntry, SigningDocument } from "./types.js";

function resolveTransactionsDbPath(): string {
  const env = process.env.TRANSACTIONS_DB_PATH?.trim();
  if (env) return env;
  if (existsSync("/data")) return "/data/transactions.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "transactions.db");
}

let db: Database.Database | null = null;

function initTransactionsSchema(database: Database.Database): void {
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
  } catch {
    /* column exists */
  }
  try {
    database.exec(`ALTER TABLE transaction_documents ADD COLUMN missing_fields TEXT`);
  } catch {
    /* column exists */
  }

  try {
    database.exec(`ALTER TABLE transactions ADD COLUMN inspection_flow TEXT DEFAULT '{}'`);
  } catch {
    /* column exists */
  }
  try {
    database.exec(`ALTER TABLE transactions ADD COLUMN final_week_flow TEXT DEFAULT '{}'`);
  } catch {
    /* column exists */
  }
  try {
    database.exec(`ALTER TABLE transactions ADD COLUMN post_close_flow TEXT DEFAULT '{}'`);
  } catch {
    /* column exists */
  }

  try {
    database.exec(
      `ALTER TABLE transaction_deadlines ADD COLUMN missed_same_day_escalated INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
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
  ] as Array<[string, string]>) {
    try {
      database.exec(`ALTER TABLE transactions ADD COLUMN ${column} ${ddl}`);
    } catch {
      /* column exists */
    }
  }
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_transactions_external_key ON transactions(external_key)`,
  );

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

export interface TransactionImportRun {
  id: string;
  importedAt: string;
  filename: string | null;
  source: string;
  rowsSeen: number;
  created: number;
  updated: number;
  skipped: number;
  unmappedHeaders: string[];
  errors: string[];
}

export function recordTransactionImport(
  run: Omit<TransactionImportRun, "id" | "importedAt"> & { importedAt?: string },
): TransactionImportRun {
  const database = getTransactionsDb();
  const id = randomUUID();
  const importedAt = run.importedAt || new Date().toISOString();
  database
    .prepare(
      `INSERT INTO transaction_imports
        (id, imported_at, filename, source, rows_seen, created, updated, skipped, unmapped_headers, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      importedAt,
      run.filename ?? null,
      run.source,
      run.rowsSeen,
      run.created,
      run.updated,
      run.skipped,
      JSON.stringify(run.unmappedHeaders || []),
      JSON.stringify(run.errors || []),
    );
  return { ...run, id, importedAt, filename: run.filename ?? null };
}

/** The most recent import, or null if transactions have only ever been typed in by hand. */
export function getLastTransactionImport(): TransactionImportRun | null {
  const database = getTransactionsDb();
  const row = database
    .prepare(`SELECT * FROM transaction_imports ORDER BY imported_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    importedAt: String(row.imported_at),
    filename: row.filename ? String(row.filename) : null,
    source: String(row.source || "csv"),
    rowsSeen: Number(row.rows_seen || 0),
    created: Number(row.created || 0),
    updated: Number(row.updated || 0),
    skipped: Number(row.skipped || 0),
    unmappedHeaders: parseJsonColumn<string[]>(row.unmapped_headers, []),
    errors: parseJsonColumn<string[]>(row.errors, []),
  };
}

/** Look up a previously-imported transaction by its stable source key (MLS #, or address). */
export function getTransactionByExternalKey(key: string): Transaction | null {
  if (!key.trim()) return null;
  const database = getTransactionsDb();
  const row = database
    .prepare(`SELECT * FROM transactions WHERE external_key = ?`)
    .get(key.trim()) as Record<string, unknown> | undefined;
  return row ? rowToTransaction(row) : null;
}

export function getTransactionsDb(): Database.Database {
  if (!db) {
    db = new Database(resolveTransactionsDbPath());
    initTransactionsSchema(db);
  }
  return db;
}

export interface TransactionParties {
  buyerName?: string;
  buyerPhone?: string;
  buyerAgent?: string;
  buyerAgentPhone?: string;
  sellerName?: string;
  sellerPhone?: string;
  sellerAgent?: string;
  sellerAgentPhone?: string;
  lenderName?: string;
  lenderPhone?: string;
  loanOfficer?: string;
  titleCompany?: string;
  titleContact?: string;
  titleContactPhone?: string;
  leadName?: string;
  phone?: string;
  email?: string;
  assignedTo?: string;
  commissionPercent?: number;
  estimatedGCI?: number;
  openedDate?: string;
  closedDate?: string;
  legacyStatus?: string;
  dealSubtype?: string;
  activityLog?: DealActivityLogEntry[];
}

/* buyer/seller/dual are the legacy engine values; tenant/landlord/referral come
   from Brivity's Select Transaction Type flow (team feature list, Aug 2026). */
export type TransactionDealType = "buyer" | "seller" | "dual" | "tenant" | "landlord" | "referral";

export interface TransactionPlanEnrollment {
  planId: string;
  planName: string;
  enrolledAt: string;
  completedSteps: string[];
  completedAt?: Record<string, string>;
  status: "active" | "paused" | "completed";
}
export type TransactionStatus =
  | "active"
  | "under_contract"
  | "pending"
  | "closed"
  | "fell_through"
  | "cancelled"
  /* Brivity lifecycle statuses (team feature list). under_contract keeps
     driving the deadline engine; these are bookkeeping states around it. */
  | "pipeline"
  | "coming_soon"
  | "expired"
  | "withdrawn"
  | "archived";

export interface InspectionFlow {
  inspectorName?: string;
  inspectorPhone?: string;
  scheduledAt?: string;
  scheduleConfirmedParties?: string[];
  reportReceivedAt?: string;
  repairRequestDraftedAt?: string;
  repairRequestSentAt?: string;
  sellerResponseDeadline?: string;
  sellerResponseReceivedAt?: string;
  sellerResponseStatus?: "pending" | "accepted" | "countered" | "declined";
}

export interface FinalWeekFlow {
  walkthroughScheduledAt?: string;
  walkthroughConfirmed?: boolean;
  closingDisclosureReminderSentAt?: string;
  wireInstructionsConfirmedAt?: string;
  wireInstructionsConfirmedBy?: string;
  whatToExpectGuideSentAt?: string;
}

export interface PostCloseFlow {
  congratulationsSentAt?: string;
  reviewRequestTriggeredAt?: string;
  pastClientNurtureAddedAt?: string;
  checkIn30DayScheduledFor?: string;
  checkIn30DayCompletedAt?: string;
  checkIn1YearScheduledFor?: string;
  checkIn1YearCompletedAt?: string;
}

export interface Transaction {
  id?: string;
  address: string;
  dealType: TransactionDealType;
  parties: TransactionParties;
  price?: number;
  status: TransactionStatus;
  contractDate?: string;
  inspectionDate?: string;
  appraisalDate?: string;
  loanCommitmentDate?: string;
  titleDate?: string;
  closingDate?: string;
  possessionDate?: string;
  leadId?: string;
  dealFileUrl?: string;
  notes?: string;
  inspectionFlow?: InspectionFlow;
  finalWeekFlow?: FinalWeekFlow;
  postCloseFlow?: PostCloseFlow;
  /* Carried by a Brivity transaction export. `importedAt` is the honest
     as-of date for anything computed from these rows. */
  mls?: string;
  listPrice?: number;
  gci?: number;
  /** Listing-agreement expiration, ISO YYYY-MM-DD. */
  expiration?: string;
  /** Transaction Auto Plan enrollments (same shape as a lead's, minus enrolledVia). */
  autoPlans?: TransactionPlanEnrollment[];
  /** Brivity date fields (ISO). dateListed/dateCanceled/statusChangedAt drive the tx table's sort+columns. */
  dateListed?: string;
  dateCanceled?: string;
  statusChangedAt?: string;
  depositDue?: string;
  additionalDepositDue?: string;
  escrowSigningDate?: string;
  agent?: string;
  source?: string;
  externalKey?: string;
  importedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type DeadlineType =
  | "inspection"
  | "appraisal"
  | "loan_commitment"
  | "title"
  | "closing"
  | "option_period"
  | "earnest_money"
  | "custom";

export interface TransactionDeadline {
  id?: string;
  dealId: string;
  deadlineType: DeadlineType;
  label?: string;
  dueDate: string;
  alertSent: boolean;
  escalated: boolean;
  completed: boolean;
  completedAt?: string;
  missedSameDayEscalated?: boolean;
  createdAt?: string;
}

export type DocumentType =
  | "listing_agreement"
  | "buyer_rep"
  | "offer"
  | "amendment"
  | "disclosure"
  | "inspection_report"
  | "appraisal"
  | "title_commitment"
  | "closing_disclosure"
  | "other";

export type DocumentStatus = "pending" | "sent" | "signed" | "declined" | "expired";

export interface TransactionDocument {
  id?: string;
  dealId: string;
  documentType: DocumentType;
  status: DocumentStatus;
  parties?: string[];
  signedAt?: string;
  sentAt?: string;
  documentUrl?: string;
  notes?: string;
  needsReview?: boolean;
  missingFields?: string[];
  createdAt?: string;
}

export type TemplateType =
  | "purchase_agreement"
  | "disclosure"
  | "addendum"
  | "buyer_rep"
  | "listing_agreement"
  | "other";

export interface DocumentTemplate {
  id?: string;
  templateType: TemplateType;
  name: string;
  filePath: string;
  fieldMapping?: Record<string, string>;
  uploadedAt?: string;
  active: boolean;
}

export function resolveTemplatesDir(): string {
  if (existsSync("/data")) {
    const dir = "/data/templates";
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const localDir = path.join(process.cwd(), "data", "templates");
  mkdirSync(localDir, { recursive: true });
  return localDir;
}

export function resolveGeneratedDocsDir(): string {
  if (existsSync("/data")) {
    const dir = "/data/generated-docs";
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const localDir = path.join(process.cwd(), "data", "generated-docs");
  mkdirSync(localDir, { recursive: true });
  return localDir;
}

function rowToTransaction(row: Record<string, unknown>): Transaction {
  return {
    id: String(row.id),
    address: String(row.address),
    dealType: row.deal_type as TransactionDealType,
    parties: JSON.parse(String(row.parties || "{}")) as TransactionParties,
    price: typeof row.price === "number" ? row.price : row.price != null ? Number(row.price) : undefined,
    status: row.status as TransactionStatus,
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
    inspectionFlow: parseJsonColumn<InspectionFlow>(row.inspection_flow, {}),
    finalWeekFlow: parseJsonColumn<FinalWeekFlow>(row.final_week_flow, {}),
    postCloseFlow: parseJsonColumn<PostCloseFlow>(row.post_close_flow, {}),
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
        return Array.isArray(parsed) ? (parsed as TransactionPlanEnrollment[]) : undefined;
      } catch {
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

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function rowToDeadline(row: Record<string, unknown>): TransactionDeadline {
  return {
    id: String(row.id),
    dealId: String(row.deal_id),
    deadlineType: row.deadline_type as DeadlineType,
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

function rowToDocument(row: Record<string, unknown>): TransactionDocument {
  let missingFields: string[] | undefined;
  if (row.missing_fields) {
    try {
      missingFields = JSON.parse(String(row.missing_fields)) as string[];
    } catch {
      missingFields = undefined;
    }
  }
  return {
    id: String(row.id),
    dealId: String(row.deal_id),
    documentType: row.document_type as DocumentType,
    status: row.status as DocumentStatus,
    parties: JSON.parse(String(row.parties || "[]")) as string[],
    signedAt: row.signed_at ? String(row.signed_at) : undefined,
    sentAt: row.sent_at ? String(row.sent_at) : undefined,
    documentUrl: row.document_url ? String(row.document_url) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    needsReview: Number(row.needs_review) === 1,
    missingFields,
    createdAt: String(row.created_at),
  };
}

function rowToTemplate(row: Record<string, unknown>): DocumentTemplate {
  return {
    id: String(row.id),
    templateType: row.template_type as TemplateType,
    name: String(row.name),
    filePath: String(row.file_path),
    fieldMapping: JSON.parse(String(row.field_mapping || "{}")) as Record<string, string>,
    uploadedAt: String(row.uploaded_at),
    active: Number(row.active) === 1,
  };
}

export function createTransaction(
  tx: Omit<Transaction, "id" | "createdAt" | "updatedAt">,
  options?: { id?: string },
): Transaction {
  const database = getTransactionsDb();
  const id = options?.id?.trim() || randomUUID();
  const now = new Date().toISOString();

  database
    .prepare(
      `INSERT INTO transactions
        (id, address, deal_type, parties, price, status, contract_date, inspection_date,
         appraisal_date, loan_commitment_date, title_date, closing_date, possession_date,
         lead_id, deal_file_url, notes, mls, list_price, gci, expiration, auto_plans, agent, source, external_key,
         imported_at, date_listed, date_canceled, status_changed_at, deposit_due, additional_deposit_due, escrow_signing_date,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.address,
      tx.dealType,
      JSON.stringify(tx.parties || {}),
      tx.price ?? null,
      tx.status,
      tx.contractDate ?? null,
      tx.inspectionDate ?? null,
      tx.appraisalDate ?? null,
      tx.loanCommitmentDate ?? null,
      tx.titleDate ?? null,
      tx.closingDate ?? null,
      tx.possessionDate ?? null,
      tx.leadId ?? null,
      tx.dealFileUrl ?? null,
      tx.notes ?? null,
      tx.mls ?? null,
      tx.listPrice ?? null,
      tx.gci ?? null,
      tx.expiration ?? null,
      tx.autoPlans ? JSON.stringify(tx.autoPlans) : null,
      tx.agent ?? null,
      tx.source ?? null,
      tx.externalKey ?? null,
      tx.importedAt ?? null,
      tx.dateListed ?? null,
      tx.dateCanceled ?? null,
      tx.statusChangedAt ?? now,
      tx.depositDue ?? null,
      tx.additionalDepositDue ?? null,
      tx.escrowSigningDate ?? null,
      now,
      now,
    );

  const created = { ...tx, id, statusChangedAt: tx.statusChangedAt ?? now, createdAt: now, updatedAt: now };
  if (created.status === "under_contract") {
    syncDeadlinesFromTransaction(created);
  }
  return created;
}

export function updateTransaction(id: string, updates: Partial<Transaction>): Transaction | null {
  const existing = getTransaction(id);
  if (!existing) return null;

  const merged: Transaction = {
    ...existing,
    ...updates,
    /* Brivity's Status Changed At: stamped automatically whenever status
       actually moves, so the tx table's column and date-range filter are real. */
    statusChangedAt:
      updates.status !== undefined && updates.status !== existing.status
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
    .prepare(
      `UPDATE transactions SET
        address = ?, deal_type = ?, parties = ?, price = ?, status = ?,
        contract_date = ?, inspection_date = ?, appraisal_date = ?, loan_commitment_date = ?,
        title_date = ?, closing_date = ?, possession_date = ?, lead_id = ?, deal_file_url = ?,
        notes = ?, inspection_flow = ?, final_week_flow = ?, post_close_flow = ?,
        mls = ?, list_price = ?, gci = ?, expiration = ?, auto_plans = ?, agent = ?, source = ?, external_key = ?,
        imported_at = ?, date_listed = ?, date_canceled = ?, status_changed_at = ?,
        deposit_due = ?, additional_deposit_due = ?, escrow_signing_date = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      merged.address,
      merged.dealType,
      JSON.stringify(merged.parties || {}),
      merged.price ?? null,
      merged.status,
      merged.contractDate ?? null,
      merged.inspectionDate ?? null,
      merged.appraisalDate ?? null,
      merged.loanCommitmentDate ?? null,
      merged.titleDate ?? null,
      merged.closingDate ?? null,
      merged.possessionDate ?? null,
      merged.leadId ?? null,
      merged.dealFileUrl ?? null,
      merged.notes ?? null,
      JSON.stringify(merged.inspectionFlow || {}),
      JSON.stringify(merged.finalWeekFlow || {}),
      JSON.stringify(merged.postCloseFlow || {}),
      merged.mls ?? null,
      merged.listPrice ?? null,
      merged.gci ?? null,
      merged.expiration ?? null,
      merged.autoPlans ? JSON.stringify(merged.autoPlans) : null,
      merged.agent ?? null,
      merged.source ?? null,
      merged.externalKey ?? null,
      merged.importedAt ?? null,
      merged.dateListed ?? null,
      merged.dateCanceled ?? null,
      merged.statusChangedAt ?? null,
      merged.depositDue ?? null,
      merged.additionalDepositDue ?? null,
      merged.escrowSigningDate ?? null,
      merged.updatedAt,
      id,
    );

  if (merged.status === "under_contract") {
    syncDeadlinesFromTransaction(merged);
  }

  return merged;
}

export function getTransaction(id: string): Transaction | null {
  const database = getTransactionsDb();
  const row = database.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTransaction(row) : null;
}

export function getAllTransactions(statusFilter?: string): Transaction[] {
  const database = getTransactionsDb();
  const rows = statusFilter
    ? (database
        .prepare(`SELECT * FROM transactions WHERE status = ? ORDER BY closing_date ASC`)
        .all(statusFilter) as Record<string, unknown>[])
    : (database
        .prepare(`SELECT * FROM transactions ORDER BY closing_date ASC`)
        .all() as Record<string, unknown>[]);
  return rows.map(rowToTransaction);
}

export function deleteTransaction(id: string): boolean {
  const database = getTransactionsDb();
  database.prepare(`DELETE FROM transaction_deadlines WHERE deal_id = ?`).run(id);
  database.prepare(`DELETE FROM transaction_documents WHERE deal_id = ?`).run(id);
  const result = database.prepare(`DELETE FROM transactions WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function syncDeadlinesFromTransaction(tx: Transaction): void {
  if (!tx.id) return;
  const existing = getDeadlinesForDeal(tx.id);
  const existingTypes = new Set(existing.map((d) => d.deadlineType));

  const dateFieldMap: Array<[DeadlineType, string | undefined]> = [
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

/** Placeholder TX contract offsets — confirm with Marco/Jahan against actual contract forms. */
export interface DeadlineRule {
  type: DeadlineType;
  label: string;
  calculateFrom: "contract_date";
  offsetDays: number;
}

export const STANDARD_DEADLINE_RULES: DeadlineRule[] = [
  { type: "option_period", label: "Option Period Ends", calculateFrom: "contract_date", offsetDays: 10 },
  { type: "earnest_money", label: "Earnest Money Due", calculateFrom: "contract_date", offsetDays: 3 },
  { type: "inspection", label: "Inspection Deadline", calculateFrom: "contract_date", offsetDays: 10 },
  { type: "loan_commitment", label: "Loan Commitment Deadline", calculateFrom: "contract_date", offsetDays: 21 },
  { type: "appraisal", label: "Appraisal Deadline", calculateFrom: "contract_date", offsetDays: 21 },
  { type: "title", label: "Title Commitment Due", calculateFrom: "contract_date", offsetDays: 15 },
];

function explicitDateForDeadlineType(type: DeadlineType, tx: Transaction): string | undefined {
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

export function generateFullDeadlineTimeline(tx: Transaction): TransactionDeadline[] {
  if (!tx.contractDate) {
    console.warn("[Transactions] Cannot generate timeline without contractDate for", tx.id);
    return [];
  }

  const existing = getDeadlinesForDeal(tx.id!);
  const existingTypes = new Set(existing.map((d) => d.deadlineType));
  const created: TransactionDeadline[] = [];
  const contractDate = new Date(tx.contractDate);

  for (const rule of STANDARD_DEADLINE_RULES) {
    if (existingTypes.has(rule.type)) continue;

    const explicitDate = explicitDateForDeadlineType(rule.type, tx);
    const dueDate = explicitDate
      ? new Date(explicitDate)
      : new Date(contractDate.getTime() + rule.offsetDays * 24 * 60 * 60 * 1000);

    const deadline = createDeadline({
      dealId: tx.id!,
      deadlineType: rule.type,
      label: rule.label,
      dueDate: dueDate.toISOString(),
    });
    created.push(deadline);
  }

  if (tx.closingDate && !existingTypes.has("closing")) {
    const deadline = createDeadline({
      dealId: tx.id!,
      deadlineType: "closing",
      label: "Closing Date",
      dueDate: tx.closingDate,
    });
    created.push(deadline);
  }

  console.log("[Transactions] Generated", created.length, "deadlines for deal", tx.id);
  return created;
}

export function resolveFieldValues(tx: Transaction, fieldMapping: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [pdfFieldName, dataPath] of Object.entries(fieldMapping)) {
    const value = getValueByPath(tx, dataPath);
    resolved[pdfFieldName] = value !== undefined && value !== null ? String(value) : "";
  }
  return resolved;
}

function getValueByPath(obj: unknown, dataPath: string): unknown {
  return dataPath.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export function createDeadline(
  deadline: Omit<TransactionDeadline, "id" | "createdAt" | "alertSent" | "escalated" | "completed">,
): TransactionDeadline {
  const database = getTransactionsDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  database
    .prepare(
      `INSERT INTO transaction_deadlines (id, deal_id, deadline_type, label, due_date, alert_sent, escalated, completed, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)`,
    )
    .run(id, deadline.dealId, deadline.deadlineType, deadline.label ?? null, deadline.dueDate, now);

  return { ...deadline, id, alertSent: false, escalated: false, completed: false, createdAt: now };
}

export function getDeadlinesForDeal(dealId: string): TransactionDeadline[] {
  const database = getTransactionsDb();
  const rows = database
    .prepare(`SELECT * FROM transaction_deadlines WHERE deal_id = ? ORDER BY due_date ASC`)
    .all(dealId) as Record<string, unknown>[];
  return rows.map(rowToDeadline);
}

export function getUpcomingDeadlines(withinDays = 7): TransactionDeadline[] {
  const database = getTransactionsDb();
  const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = database
    .prepare(
      `SELECT * FROM transaction_deadlines
       WHERE due_date <= ? AND completed = 0
       ORDER BY due_date ASC`,
    )
    .all(cutoff) as Record<string, unknown>[];
  return rows.map(rowToDeadline);
}

export function getOverdueDeadlines(): TransactionDeadline[] {
  const database = getTransactionsDb();
  const now = new Date().toISOString();
  const rows = database
    .prepare(
      `SELECT * FROM transaction_deadlines
       WHERE due_date < ? AND completed = 0
       ORDER BY due_date ASC`,
    )
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToDeadline);
}

export function markDeadlineAlertSent(id: string): void {
  getTransactionsDb().prepare(`UPDATE transaction_deadlines SET alert_sent = 1 WHERE id = ?`).run(id);
}

export function markDeadlineEscalated(id: string): void {
  getTransactionsDb().prepare(`UPDATE transaction_deadlines SET escalated = 1 WHERE id = ?`).run(id);
}

export function markDeadlineMissedSameDayEscalated(id: string): void {
  getTransactionsDb()
    .prepare(`UPDATE transaction_deadlines SET missed_same_day_escalated = 1 WHERE id = ?`)
    .run(id);
}

export function markDeadlineCompleted(id: string): void {
  getTransactionsDb()
    .prepare(`UPDATE transaction_deadlines SET completed = 1, completed_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function createDocument(doc: Omit<TransactionDocument, "id" | "createdAt">): TransactionDocument {
  const database = getTransactionsDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const needsReview = doc.needsReview ? 1 : 0;
  const missingFieldsJson = doc.missingFields ? JSON.stringify(doc.missingFields) : null;

  database
    .prepare(
      `INSERT INTO transaction_documents (id, deal_id, document_type, status, parties, signed_at, sent_at, document_url, notes, created_at, needs_review, missing_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      doc.dealId,
      doc.documentType,
      doc.status,
      JSON.stringify(doc.parties || []),
      doc.signedAt ?? null,
      doc.sentAt ?? null,
      doc.documentUrl ?? null,
      doc.notes ?? null,
      now,
      needsReview,
      missingFieldsJson,
    );

  return {
    ...doc,
    id,
    createdAt: now,
    needsReview: doc.needsReview ?? false,
    missingFields: doc.missingFields,
  };
}

export function updateDocumentStatus(id: string, status: DocumentStatus, signedAt?: string): void {
  getTransactionsDb()
    .prepare(`UPDATE transaction_documents SET status = ?, signed_at = ? WHERE id = ?`)
    .run(status, signedAt ?? null, id);
}

export function getDocumentsForDeal(dealId: string): TransactionDocument[] {
  const database = getTransactionsDb();
  const rows = database
    .prepare(`SELECT * FROM transaction_documents WHERE deal_id = ? ORDER BY created_at ASC`)
    .all(dealId) as Record<string, unknown>[];
  return rows.map(rowToDocument);
}

export function getUnsignedDocuments(): TransactionDocument[] {
  const database = getTransactionsDb();
  const rows = database
    .prepare(
      `SELECT * FROM transaction_documents WHERE status IN ('sent', 'pending') ORDER BY sent_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToDocument);
}

export function getDocument(id: string): TransactionDocument | null {
  const database = getTransactionsDb();
  const row = database.prepare(`SELECT * FROM transaction_documents WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToDocument(row) : null;
}

export function flagDocumentForReview(id: string, documentUrl: string, missingFields: string[]): void {
  getTransactionsDb()
    .prepare(
      `UPDATE transaction_documents SET document_url = ?, needs_review = ?, missing_fields = ?, status = 'pending' WHERE id = ?`,
    )
    .run(documentUrl, missingFields.length > 0 ? 1 : 0, JSON.stringify(missingFields), id);
}

export function getDocumentsNeedingReview(): TransactionDocument[] {
  const database = getTransactionsDb();
  const rows = database
    .prepare(`SELECT * FROM transaction_documents WHERE needs_review = 1 ORDER BY created_at ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToDocument);
}

export function createDocumentTemplate(
  template: Omit<DocumentTemplate, "id" | "uploadedAt" | "active">,
): DocumentTemplate {
  const database = getTransactionsDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  database
    .prepare(
      `INSERT INTO document_templates (id, template_type, name, file_path, field_mapping, uploaded_at, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      id,
      template.templateType,
      template.name,
      template.filePath,
      JSON.stringify(template.fieldMapping || {}),
      now,
    );

  return { ...template, id, uploadedAt: now, active: true };
}

export function getAllTemplates(typeFilter?: TemplateType): DocumentTemplate[] {
  const database = getTransactionsDb();
  const rows = typeFilter
    ? (database
        .prepare(`SELECT * FROM document_templates WHERE template_type = ? AND active = 1`)
        .all(typeFilter) as Record<string, unknown>[])
    : (database
        .prepare(`SELECT * FROM document_templates WHERE active = 1`)
        .all() as Record<string, unknown>[]);
  return rows.map(rowToTemplate);
}

export function getTemplate(id: string): DocumentTemplate | null {
  const database = getTransactionsDb();
  const row = database.prepare(`SELECT * FROM document_templates WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTemplate(row) : null;
}

export function mapOldDealStatusToTransaction(status: string): TransactionStatus {
  const map: Record<string, TransactionStatus> = {
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

export function migrateSigningDocuments(dealId: string, documents: SigningDocument[]): void {
  for (const doc of documents) {
    const status: DocumentStatus =
      doc.status === "signed" || doc.status === "declined" || doc.status === "sent" || doc.status === "pending"
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

export function migrateFromDealsJson(deals: unknown[]): { migrated: number; skipped: number } {
  let migrated = 0;
  let skipped = 0;

  for (const raw of deals) {
    if (!raw || typeof raw !== "object") {
      skipped++;
      continue;
    }
    const deal = raw as Record<string, unknown>;
    const address =
      typeof deal.propertyAddress === "string" && deal.propertyAddress.trim()
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
    let dealType: TransactionDealType = "buyer";
    let dealSubtype: string | undefined;
    if (dealTypeRaw === "seller") dealType = "seller";
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

      const tx = createTransaction(
        {
          address,
          dealType,
          parties: {
            leadName,
            phone: typeof deal.phone === "string" ? deal.phone : undefined,
            email: typeof deal.email === "string" ? deal.email : undefined,
            assignedTo: typeof deal.assignedTo === "string" ? deal.assignedTo : undefined,
            commissionPercent:
              typeof deal.commissionPercent === "number" ? deal.commissionPercent : undefined,
            estimatedGCI: typeof deal.estimatedGCI === "number" ? deal.estimatedGCI : undefined,
            openedDate: typeof deal.openedDate === "string" ? deal.openedDate : undefined,
            closedDate: typeof deal.closedDate === "string" ? deal.closedDate : undefined,
            legacyStatus,
            dealSubtype,
            activityLog: Array.isArray(deal.activityLog)
              ? (deal.activityLog as DealActivityLogEntry[])
              : undefined,
          },
          price: typeof deal.salePrice === "number" ? deal.salePrice : undefined,
          status: mapOldDealStatusToTransaction(statusRaw),
          closingDate: typeof deal.closeDate === "string" ? deal.closeDate : undefined,
          leadId: typeof deal.leadId === "string" ? deal.leadId : undefined,
          notes: typeof deal.notes === "string" ? deal.notes : undefined,
        },
        { id },
      );

      if (Array.isArray(deal.documents)) {
        migrateSigningDocuments(
          tx.id!,
          deal.documents as SigningDocument[],
        );
      }
      migrated++;
    } catch (err) {
      console.error("[TransactionsMigration] Failed to migrate deal:", deal, err);
      skipped++;
    }
  }

  return { migrated, skipped };
}

export function countTransactions(): number {
  const row = getTransactionsDb()
    .prepare(`SELECT COUNT(*) AS c FROM transactions`)
    .get() as { c: number };
  return Number(row.c) || 0;
}
