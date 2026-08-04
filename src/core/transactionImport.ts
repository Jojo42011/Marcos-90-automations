/**
 * Brivity transaction import (CSV).
 *
 * Why a CSV and not an API call: Brivity's Core API does not expose
 * transactions. `https://api.brivity.com/api/people` is the only route that
 * reaches authentication — it answers 401 "Bad Credentials" without a key.
 * Every other path (`/api/transactions`, `/api/deals`, `/api/listings`,
 * `/api/escrows`, `/api/closings`, `/api/v2/*`) returns an identical generic
 * `406 Not Acceptable`, and so does a deliberately nonsense path, which is the
 * proof that 406 is their catch-all rather than a real endpoint. Until Brivity
 * grants transaction API access there is nothing to poll, so the operator
 * exports the transaction report and this module ingests it.
 *
 * The design rule, same as the analytics roll-up: **anything derived from this
 * data must be able to state when it was true.** Every imported row carries
 * `importedAt` and every run is logged to `transaction_imports`, so the UI can
 * say "as of 14 Jul" instead of implying a live feed.
 *
 * Parsing is hand-rolled because the fast overlay deploy path cannot run
 * `npm install` — a CSV dependency would force a full image rebuild.
 */

import {
  createTransaction,
  getAllTransactions,
  getTransactionByExternalKey,
  recordTransactionImport,
  updateTransaction,
  type Transaction,
  type TransactionDealType,
  type TransactionStatus,
} from "./transactionsStore.js";

/* ─────────────────────────── CSV ─────────────────────────── */

/**
 * RFC4180-ish reader: quoted fields, embedded commas/newlines, doubled quotes,
 * CRLF, and a UTF-8 BOM (Excel writes one, and it otherwise poisons the first
 * header so the Address column is never found).
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/* ───────────────────── column mapping ───────────────────── */

/**
 * Brivity's export column names are not stable across report templates, so each
 * field accepts several spellings. Anything we cannot place is REPORTED as an
 * unmapped header rather than silently dropped — a column we ignored without
 * saying so is how a price ends up missing with nobody noticing.
 */
const ALIASES: Record<string, string[]> = {
  address: ["address", "property address", "property", "street address", "full address", "listing address", "title", "address / title"],
  city: ["city", "city state zip", "area"],
  side: ["type", "side", "representation", "transaction type", "deal type", "role"],
  status: ["status", "transaction status", "listing status", "stage", "deal status"],
  mls: ["mls", "mls #", "mls#", "mls number", "mls id"],
  agent: ["agent", "listing agent", "assigned agent", "owner", "team member"],
  listDate: ["list date", "date listed", "listing date", "start date"],
  listPrice: ["list price", "listing price", "original price", "asking price"],
  closePrice: ["close price", "sale price", "sold price", "selling price", "final price", "purchase price"],
  gci: ["gci", "commission", "gross commission", "commission amount", "total commission"],
  closeDate: ["close date", "closing date", "sold date", "settlement date", "coe"],
  contractDate: ["contract date", "mutual acceptance", "under contract date", "pending date", "accepted date"],
  source: ["source", "lead source"],
  expiration: ["expiration", "expiration date", "expire date"],
  client: ["client", "client name", "buyer", "seller", "customer", "contact"],
  notes: ["notes", "note", "description", "comments"],
};

function indexHeaders(headers: string[]): { ix: Record<string, number>; unmapped: string[] } {
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
  const ix: Record<string, number> = {};
  const claimed = new Set<number>();
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const at = norm.indexOf(n);
      if (at >= 0 && !claimed.has(at)) { ix[field] = at; claimed.add(at); break; }
    }
  }
  const unmapped = headers.filter((h, i) => h.trim() !== "" && !claimed.has(i)).map((h) => h.trim());
  return { ix, unmapped };
}

/**
 * Brivity's transaction statuses do not map one-to-one onto ours — theirs
 * include pipeline/coming soon/expired/withdrawn/referral, ours is the shorter
 * lifecycle the deadline engine drives off. The original string is preserved on
 * `parties.legacyStatus` so nothing is lost in translation.
 */
function mapStatus(raw: string): TransactionStatus {
  const s = raw.trim().toLowerCase();
  if (!s) return "active";
  if (s.includes("clos") || s.includes("sold") || s.includes("settl")) return "closed";
  if (s.includes("under contract") || s.includes("mutual") || s.includes("contract")) return "under_contract";
  if (s.includes("pend")) return "pending";
  if (s.includes("cancel") || s.includes("withdraw") || s.includes("expir") || s.includes("terminat")) return "cancelled";
  if (s.includes("fell") || s.includes("fall")) return "fell_through";
  return "active";
}

function mapSide(raw: string): TransactionDealType {
  const s = raw.trim().toLowerCase();
  if (s.includes("dual") || s.includes("both")) return "dual";
  if (s.startsWith("s") || s.includes("sell") || s.includes("list")) return "seller";
  return "buyer";
}

function money(raw: string): number | undefined {
  const n = Number(String(raw || "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n !== 0 ? Math.round(n) : undefined;
}

/** Dates are normalised to YYYY-MM-DD; anything unparseable is dropped, not guessed. */
function isoDate(raw: string): string | undefined {
  const v = String(raw || "").trim();
  if (!v) return undefined;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})/.exec(v);           // US M/D/Y
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** Stable identity for re-imports: MLS # when present, otherwise the address. */
function externalKey(address: string, mls: string): string {
  const m = mls.trim();
  if (m) return `mls:${m.toLowerCase()}`;
  return `addr:${address.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/* ───────────────────── plan / apply ───────────────────── */

export interface PlannedRow {
  line: number;
  action: "create" | "update" | "skip";
  reason?: string;
  externalKey: string;
  existingId?: string;
  transaction: Omit<Transaction, "id" | "createdAt" | "updatedAt">;
}

export interface TransactionImportPlan {
  rowsSeen: number;
  unmappedHeaders: string[];
  missingRequired: string[];
  errors: string[];
  rows: PlannedRow[];
  create: number;
  update: number;
  skip: number;
}

/**
 * Read the CSV and decide what WOULD happen. Nothing is written — same
 * dry-run-first shape as the Brivity people import, so a bad column mapping is
 * caught by looking at the plan rather than by looking at damaged records.
 */
export function planTransactionImport(csvText: string, opts?: { importedAt?: string }): TransactionImportPlan {
  const importedAt = opts?.importedAt || new Date().toISOString();
  const rows = parseCsv(csvText);
  const plan: TransactionImportPlan = {
    rowsSeen: Math.max(0, rows.length - 1),
    unmappedHeaders: [], missingRequired: [], errors: [],
    rows: [], create: 0, update: 0, skip: 0,
  };
  if (rows.length < 2) {
    plan.errors.push("No data rows found — the file has a header or nothing at all.");
    return plan;
  }

  const { ix, unmapped } = indexHeaders(rows[0]);
  plan.unmappedHeaders = unmapped;
  if (ix.address == null) {
    plan.missingRequired.push("address");
    plan.errors.push(
      `No Address/Property column found. Headers seen: ${rows[0].map((h) => h.trim()).filter(Boolean).join(", ")}`,
    );
    return plan;
  }

  const get = (r: string[], k: string): string => (ix[k] != null ? String(r[ix[k]] ?? "").trim() : "");
  const seenInFile = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const address = get(r, "address");
    if (!address) { plan.skip++; plan.rows.push({ line: i + 1, action: "skip", reason: "no address", externalKey: "", transaction: null as never }); continue; }

    const mls = get(r, "mls");
    const key = externalKey(address, mls);
    if (seenInFile.has(key)) {
      plan.skip++;
      plan.rows.push({ line: i + 1, action: "skip", reason: "duplicate row in this file", externalKey: key, transaction: null as never });
      continue;
    }
    seenInFile.add(key);

    const rawStatus = get(r, "status");
    const status = mapStatus(rawStatus);
    const city = get(r, "city");
    const closePrice = money(get(r, "closePrice"));
    const listPrice = money(get(r, "listPrice"));

    const tx: Omit<Transaction, "id" | "createdAt" | "updatedAt"> = {
      address: city && !address.toLowerCase().includes(city.toLowerCase()) ? `${address}, ${city}` : address,
      dealType: mapSide(get(r, "side")),
      status,
      /* Closed deals are worth what they sold for; anything still open is
         carried at its list price. Never invent one from the other. */
      price: status === "closed" ? closePrice ?? listPrice : listPrice ?? closePrice,
      listPrice,
      gci: money(get(r, "gci")),
      mls: mls || undefined,
      /* The Expiration column was mapped from day one and then silently
         dropped on the floor — an alias with no consumer. It feeds the
         listing-expiration column and calendar now. */
      expiration: isoDate(get(r, "expiration")),
      agent: get(r, "agent") || undefined,
      contractDate: isoDate(get(r, "contractDate")),
      closingDate: isoDate(get(r, "closeDate")),
      notes: get(r, "notes") || undefined,
      source: get(r, "source") || "Brivity CSV",
      externalKey: key,
      importedAt,
      parties: {
        leadName: get(r, "client") || undefined,
        assignedTo: get(r, "agent") || undefined,
        estimatedGCI: money(get(r, "gci")),
        openedDate: isoDate(get(r, "listDate")),
        closedDate: status === "closed" ? isoDate(get(r, "closeDate")) : undefined,
        /* Kept verbatim: our six statuses cannot represent "coming soon" or
           "referral", and throwing the original away would make the import
           lossy in a way nobody could audit afterwards. */
        legacyStatus: rawStatus || undefined,
      },
    };

    const existing = getTransactionByExternalKey(key);
    if (existing) {
      plan.update++;
      plan.rows.push({ line: i + 1, action: "update", externalKey: key, existingId: existing.id, transaction: tx });
    } else {
      plan.create++;
      plan.rows.push({ line: i + 1, action: "create", externalKey: key, transaction: tx });
    }
  }

  return plan;
}

export interface TransactionImportResult {
  created: number;
  updated: number;
  skipped: number;
  rowsSeen: number;
  unmappedHeaders: string[];
  errors: string[];
  importedAt: string;
  total: number;
}

/**
 * Commit a plan. Re-planning is the caller's job so that apply always runs
 * against a plan built from the same text it is about to write.
 *
 * An update deliberately does NOT clobber the workflow state a human has built
 * on top of a transaction — inspection/final-week/post-close flows, deadlines
 * and documents are untouched. A re-import refreshes the facts that came from
 * Brivity and nothing else.
 */
export function applyTransactionImport(
  plan: TransactionImportPlan,
  meta?: { filename?: string; source?: string },
): TransactionImportResult {
  const importedAt = new Date().toISOString();
  let created = 0;
  let updated = 0;
  const errors = [...plan.errors];

  for (const row of plan.rows) {
    if (row.action === "skip" || !row.transaction) continue;
    try {
      if (row.action === "update" && row.existingId) {
        updateTransaction(row.existingId, { ...row.transaction, importedAt });
        updated++;
      } else {
        createTransaction({ ...row.transaction, importedAt });
        created++;
      }
    } catch (err) {
      errors.push(`line ${row.line}: ${(err as Error).message}`);
    }
  }

  recordTransactionImport({
    filename: meta?.filename ?? null,
    source: meta?.source || "csv",
    rowsSeen: plan.rowsSeen,
    created,
    updated,
    skipped: plan.skip,
    unmappedHeaders: plan.unmappedHeaders,
    errors,
  });

  return {
    created, updated, skipped: plan.skip, rowsSeen: plan.rowsSeen,
    unmappedHeaders: plan.unmappedHeaders, errors, importedAt,
    total: getAllTransactions().length,
  };
}
