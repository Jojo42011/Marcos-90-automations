/**
 * CMA sessions and the comparables selected into them.
 *
 * A CMA is a saved piece of work, not a query: the agent picks specific
 * comparable homes across four market states (active, pending, sold, off
 * market), five slots each, and those exact picks are the report. Re-running
 * the search tomorrow would return a different set — which is precisely why
 * the selection is persisted rather than recomputed.
 *
 * WHAT THIS BOARD CAN AND CANNOT SUPPLY. The wizard's four selection steps do
 * not have four equal data sources behind them, and the difference is not
 * cosmetic:
 *
 *   · ACTIVE and PENDING come from the SABOR mirror. Both are real and large
 *     (~25.9k active, ~6.0k pending at time of writing).
 *   · SOLD is not in the feed at all. `mlsFacets` counts the statuses in the
 *     mirror on every run and finds exactly two — Active and Pending. So the
 *     sold comps here come from Marco's OWN closed transactions, which carry a
 *     real list price and a real sold price, plus anything typed in by hand.
 *     That is a genuinely smaller and more partial set than a board-wide sold
 *     search, and the UI says so rather than presenting 21 of Marco's closings
 *     as "the sold comps in this area".
 *   · OFF MARKET (expired / withdrawn / cancelled) has no source here at all.
 *     Manual entry is the only way a row gets in, and the step says that
 *     instead of showing an empty feed that reads as "no expired listings
 *     nearby".
 *
 * NO COORDINATES, SO NO MAP. Every row in the mirror has `geo.lat === null` —
 * checked across all ~32k rows, not sampled. The spec's map rail, price pins,
 * "redo search here" against map bounds, distance sort and mile radius all
 * rest on coordinates that do not exist. They are not drawn as an empty canvas;
 * the area is resolved by the same widening place ladder the market report
 * uses (postal → city → county → board), which is a real answer to the same
 * question and reports which rung it settled on.
 *
 * ONE TABLE FOR COMPARABLES, NOT FOUR. The spec normalises per-status metadata
 * into `cma_pending_details` / `cma_sold_details` / `cma_off_market_details`,
 * each a 1:1 optional row holding two or three columns. Folded here into
 * nullable columns on `cma_comparables`: it is nine columns against three
 * joins, the statuses are a closed set, and every read wants the parent row
 * anyway. The constraints the spec cares about are kept exactly — a tray slot
 * is 1..5 and unique per session, and the same property cannot be selected
 * twice into the same step.
 */
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import path from "path";

import Database from "better-sqlite3";

/* ────────────────────────── shapes ────────────────────────── */

/** The four market states the wizard selects across, in step order. */
export type CompStatus = "ACTIVE" | "PENDING" | "SOLD" | "OFF_MKT";
export const COMP_STATUSES: CompStatus[] = ["ACTIVE", "PENDING", "SOLD", "OFF_MKT"];

/** Where a comparable row came from. Shown on the row — it is not decoration. */
export type CompSource = "mls" | "transaction" | "manual";

/** Brivity's three off-market reasons. */
export type OffMarketType = "EXPIRED" | "WITHDRAWN" | "CANCELED";

/** Fixed tray capacity, per the spec. Five slots per step, not per session. */
export const TRAY_SLOTS = 5;

export interface CmaSession {
  id: string;
  clientName: string;
  leadId: string | null;
  /** The board this CMA searched. One entry today; stored so it stays true. */
  mls: string | null;
  subjectAddress: string;
  subjectCity: string | null;
  subjectState: string | null;
  subjectPostalCode: string | null;
  subjectPropertyType: string | null;
  subjectBeds: number | null;
  subjectBaths: number | null;
  subjectSqft: number | null;
  subjectLotSize: number | null;
  subjectYearBuilt: number | null;
  /** Comparable search criteria, a `ListingCriteria` shape. */
  criteria: Record<string, unknown>;
  /** Which rung of the place ladder the comp search settled on. */
  areaRung: string | null;
  areaLabel: string | null;
  /* Step 6's "Estimated Pricing and Days on Market" — the agent's own
     recommendation, seeded from the comp averages and then editable. Stored on
     the session because it IS the opinion the CMA delivers; recomputing it from
     the comps later would silently overwrite what the agent decided. */
  suggestedMinListPrice: number | null;
  suggestedMaxListPrice: number | null;
  estimatedDomMin: number | null;
  estimatedDomMax: number | null;
  currentStep: number;
  status: "draft" | "published";
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CmaComparable {
  id: string;
  sessionId: string;
  listingStatus: CompStatus;
  traySlotIndex: number;
  source: CompSource;
  /** MLS listing key, transaction id, or null for a hand-typed row. */
  sourceKey: string | null;
  mlsNumber: string | null;
  address: string;
  city: string | null;
  postalCode: string | null;
  /** The headline price for this row's status — list, pending, sold or last list. */
  price: number | null;
  originalListPrice: number | null;
  soldPrice: number | null;
  sellerConcessions: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  lotSize: number | null;
  yearBuilt: number | null;
  listDate: string | null;
  /** Pending date / sold date / off-market date, depending on status. */
  statusDate: string | null;
  estimatedClosingDate: string | null;
  daysOnMarket: number | null;
  offMarketType: OffMarketType | null;
  photoUrl: string | null;
  notes: string | null;
  isManualEntry: boolean;
  createdAt: string;
}

/* ────────────────────────── database ────────────────────────── */

function resolveCmaDbPath(): string {
  const env = process.env.CMA_DB_PATH?.trim();
  if (env) return env;
  if (existsSync("/data")) return "/data/cma.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "cma.db");
}

let db: Database.Database | null = null;

export function initCmaSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cma_sessions (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      lead_id TEXT,
      mls TEXT,
      subject_address TEXT NOT NULL,
      subject_city TEXT,
      subject_state TEXT,
      subject_postal_code TEXT,
      subject_property_type TEXT,
      subject_beds REAL,
      subject_baths REAL,
      subject_sqft INTEGER,
      subject_lot_size REAL,
      subject_year_built INTEGER,
      criteria TEXT NOT NULL DEFAULT '{}',
      suggested_min_list_price INTEGER,
      suggested_max_list_price INTEGER,
      estimated_dom_min INTEGER,
      estimated_dom_max INTEGER,
      area_rung TEXT,
      area_label TEXT,
      current_step INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_cma_sessions_lead ON cma_sessions(lead_id)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_cma_sessions_updated ON cma_sessions(updated_at DESC)`);

  database.exec(`
    CREATE TABLE IF NOT EXISTS cma_comparables (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES cma_sessions(id) ON DELETE CASCADE,
      listing_status TEXT NOT NULL CHECK (listing_status IN ('ACTIVE','PENDING','SOLD','OFF_MKT')),
      tray_slot_index INTEGER NOT NULL CHECK (tray_slot_index BETWEEN 1 AND 5),
      source TEXT NOT NULL CHECK (source IN ('mls','transaction','manual')),
      source_key TEXT,
      mls_number TEXT,
      address TEXT NOT NULL,
      city TEXT,
      postal_code TEXT,
      price INTEGER,
      original_list_price INTEGER,
      sold_price INTEGER,
      seller_concessions INTEGER,
      beds REAL,
      baths REAL,
      sqft INTEGER,
      lot_size REAL,
      year_built INTEGER,
      list_date TEXT,
      status_date TEXT,
      estimated_closing_date TEXT,
      days_on_market INTEGER,
      off_market_type TEXT,
      photo_url TEXT,
      notes TEXT,
      is_manual_entry INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, listing_status, tray_slot_index)
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_cma_comps_session ON cma_comparables(session_id, listing_status)`);

  /* Every send, successful or not. A failed send that leaves no row is
     indistinguishable from one nobody tried, and "did the client get it?" is
     the first question asked when a seller says they never saw it. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS cma_deliveries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES cma_sessions(id) ON DELETE CASCADE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      market_drip_scheduled INTEGER NOT NULL DEFAULT 0,
      report_id TEXT,
      lead_id TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      sent_at TEXT NOT NULL
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_cma_deliveries_session ON cma_deliveries(session_id, sent_at DESC)`);
  /* Partial unique index rather than a plain UNIQUE: a hand-typed row has no
     source key, and several NULLs in one column would collide under some
     engines while meaning "these are all different rows" here. */
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cma_comps_unique_source
      ON cma_comparables(session_id, listing_status, source_key)
      WHERE source_key IS NOT NULL
  `);
}

export interface CmaDelivery {
  id: string;
  sessionId: string;
  firstName: string;
  lastName: string;
  email: string;
  /** True only when a market report was really created and enrolled. */
  marketDripScheduled: boolean;
  /** The report the drip runs on, when one was created. */
  reportId: string | null;
  leadId: string | null;
  ok: boolean;
  error: string | null;
  sentAt: string;
}

export function getCmaDb(): Database.Database {
  if (!db) {
    db = new Database(resolveCmaDbPath());
    db.pragma("foreign_keys = ON");
    initCmaSchema(db);
  }
  return db;
}

/* ────────────────────────── coercion ────────────────────────── */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

function rowToSession(r: Record<string, unknown>): CmaSession {
  let criteria: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(r.criteria ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) criteria = parsed;
  } catch {
    /* A row whose criteria JSON is unreadable still describes a real subject
       property and real picks; it opens with an empty search rather than 500ing
       the whole session. */
  }
  return {
    id: String(r.id),
    clientName: String(r.client_name),
    leadId: (r.lead_id as string) ?? null,
    mls: (r.mls as string) ?? null,
    subjectAddress: String(r.subject_address),
    subjectCity: (r.subject_city as string) ?? null,
    subjectState: (r.subject_state as string) ?? null,
    subjectPostalCode: (r.subject_postal_code as string) ?? null,
    subjectPropertyType: (r.subject_property_type as string) ?? null,
    subjectBeds: (r.subject_beds as number) ?? null,
    subjectBaths: (r.subject_baths as number) ?? null,
    subjectSqft: (r.subject_sqft as number) ?? null,
    subjectLotSize: (r.subject_lot_size as number) ?? null,
    subjectYearBuilt: (r.subject_year_built as number) ?? null,
    criteria,
    suggestedMinListPrice: (r.suggested_min_list_price as number) ?? null,
    suggestedMaxListPrice: (r.suggested_max_list_price as number) ?? null,
    estimatedDomMin: (r.estimated_dom_min as number) ?? null,
    estimatedDomMax: (r.estimated_dom_max as number) ?? null,
    areaRung: (r.area_rung as string) ?? null,
    areaLabel: (r.area_label as string) ?? null,
    currentStep: Number(r.current_step ?? 1),
    status: String(r.status) === "published" ? "published" : "draft",
    publishedAt: (r.published_at as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToComparable(r: Record<string, unknown>): CmaComparable {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    listingStatus: String(r.listing_status) as CompStatus,
    traySlotIndex: Number(r.tray_slot_index),
    source: String(r.source) as CompSource,
    sourceKey: (r.source_key as string) ?? null,
    mlsNumber: (r.mls_number as string) ?? null,
    address: String(r.address),
    city: (r.city as string) ?? null,
    postalCode: (r.postal_code as string) ?? null,
    price: (r.price as number) ?? null,
    originalListPrice: (r.original_list_price as number) ?? null,
    soldPrice: (r.sold_price as number) ?? null,
    sellerConcessions: (r.seller_concessions as number) ?? null,
    beds: (r.beds as number) ?? null,
    baths: (r.baths as number) ?? null,
    sqft: (r.sqft as number) ?? null,
    lotSize: (r.lot_size as number) ?? null,
    yearBuilt: (r.year_built as number) ?? null,
    listDate: (r.list_date as string) ?? null,
    statusDate: (r.status_date as string) ?? null,
    estimatedClosingDate: (r.estimated_closing_date as string) ?? null,
    daysOnMarket: (r.days_on_market as number) ?? null,
    offMarketType: (r.off_market_type as OffMarketType) ?? null,
    photoUrl: (r.photo_url as string) ?? null,
    notes: (r.notes as string) ?? null,
    isManualEntry: Number(r.is_manual_entry) === 1,
    createdAt: String(r.created_at),
  };
}

/* ────────────────────────── sessions ────────────────────────── */

export interface CreateSessionInput {
  clientName: string;
  leadId?: string | null;
  mls?: string | null;
  subjectAddress: string;
  subjectCity?: string | null;
  subjectState?: string | null;
  subjectPostalCode?: string | null;
  subjectPropertyType?: string | null;
  subjectBeds?: number | null;
  subjectBaths?: number | null;
  subjectSqft?: number | null;
  subjectLotSize?: number | null;
  subjectYearBuilt?: number | null;
  criteria?: Record<string, unknown>;
}

export function createSession(input: CreateSessionInput): CmaSession {
  const database = getCmaDb();
  const now = new Date().toISOString();
  const id = `cma_${randomUUID()}`;
  database
    .prepare(
      `INSERT INTO cma_sessions (
         id, client_name, lead_id, mls, subject_address, subject_city, subject_state,
         subject_postal_code, subject_property_type, subject_beds, subject_baths,
         subject_sqft, subject_lot_size, subject_year_built, criteria,
         current_step, status, created_at, updated_at
       ) VALUES (
         @id, @clientName, @leadId, @mls, @subjectAddress, @subjectCity, @subjectState,
         @subjectPostalCode, @subjectPropertyType, @subjectBeds, @subjectBaths,
         @subjectSqft, @subjectLotSize, @subjectYearBuilt, @criteria,
         2, 'draft', @now, @now
       )`,
    )
    .run({
      id,
      clientName: String(input.clientName).trim(),
      leadId: str(input.leadId),
      mls: str(input.mls),
      subjectAddress: String(input.subjectAddress).trim(),
      subjectCity: str(input.subjectCity),
      subjectState: str(input.subjectState),
      subjectPostalCode: str(input.subjectPostalCode),
      subjectPropertyType: str(input.subjectPropertyType),
      subjectBeds: num(input.subjectBeds),
      subjectBaths: num(input.subjectBaths),
      subjectSqft: int(input.subjectSqft),
      subjectLotSize: num(input.subjectLotSize),
      subjectYearBuilt: int(input.subjectYearBuilt),
      criteria: JSON.stringify(input.criteria ?? {}),
      now,
    });
  return getSession(id)!;
}

export function getSession(id: string): CmaSession | null {
  const r = getCmaDb().prepare(`SELECT * FROM cma_sessions WHERE id = ?`).get(String(id)) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToSession(r) : null;
}

export function listSessions(opts: { leadId?: string | null; limit?: number } = {}): CmaSession[] {
  const database = getCmaDb();
  const limit = Math.min(Math.max(Number(opts.limit ?? 100), 1), 500);
  const rows = opts.leadId
    ? (database
        .prepare(`SELECT * FROM cma_sessions WHERE lead_id = ? ORDER BY updated_at DESC LIMIT ?`)
        .all(String(opts.leadId), limit) as Record<string, unknown>[])
    : (database
        .prepare(`SELECT * FROM cma_sessions ORDER BY updated_at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]);
  return rows.map(rowToSession);
}

/**
 * Patch a session.
 *
 * Only the keys present in `patch` are written. This is the same trap the
 * appointment PATCH fell into (FORAI, 2026-08-21): building a full row from a
 * fixed field list and writing it back erases everything the caller did not
 * happen to send.
 */
export function updateSession(
  id: string,
  patch: Partial<CreateSessionInput> & {
    currentStep?: number;
    suggestedMinListPrice?: number | null;
    suggestedMaxListPrice?: number | null;
    estimatedDomMin?: number | null;
    estimatedDomMax?: number | null;
    status?: "draft" | "published";
    publishedAt?: string | null;
    areaRung?: string | null;
    areaLabel?: string | null;
  },
): CmaSession | null {
  const existing = getSession(id);
  if (!existing) return null;

  const cols: Record<string, string> = {
    clientName: "client_name",
    leadId: "lead_id",
    mls: "mls",
    subjectAddress: "subject_address",
    subjectCity: "subject_city",
    subjectState: "subject_state",
    subjectPostalCode: "subject_postal_code",
    subjectPropertyType: "subject_property_type",
    subjectBeds: "subject_beds",
    subjectBaths: "subject_baths",
    subjectSqft: "subject_sqft",
    subjectLotSize: "subject_lot_size",
    subjectYearBuilt: "subject_year_built",
    suggestedMinListPrice: "suggested_min_list_price",
    suggestedMaxListPrice: "suggested_max_list_price",
    estimatedDomMin: "estimated_dom_min",
    estimatedDomMax: "estimated_dom_max",
    currentStep: "current_step",
    status: "status",
    publishedAt: "published_at",
    areaRung: "area_rung",
    areaLabel: "area_label",
  };
  const numeric = new Set(["subjectBeds", "subjectBaths", "subjectLotSize"]);
  const integer = new Set([
    "subjectSqft", "subjectYearBuilt", "currentStep",
    "suggestedMinListPrice", "suggestedMaxListPrice", "estimatedDomMin", "estimatedDomMax",
  ]);

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: String(id), now: new Date().toISOString() };
  for (const [key, col] of Object.entries(cols)) {
    if (!(key in patch)) continue;
    const raw = (patch as Record<string, unknown>)[key];
    params[key] = numeric.has(key) ? num(raw) : integer.has(key) ? int(raw) : str(raw);
    sets.push(`${col} = @${key}`);
  }
  if ("criteria" in patch) {
    params.criteria = JSON.stringify(patch.criteria ?? {});
    sets.push(`criteria = @criteria`);
  }
  if (!sets.length) return existing;
  sets.push(`updated_at = @now`);
  getCmaDb().prepare(`UPDATE cma_sessions SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return getSession(id);
}

export function deleteSession(id: string): boolean {
  const info = getCmaDb().prepare(`DELETE FROM cma_sessions WHERE id = ?`).run(String(id));
  return info.changes > 0;
}

/* ────────────────────────── comparables ────────────────────────── */

export function listComparables(sessionId: string, status?: CompStatus): CmaComparable[] {
  const database = getCmaDb();
  const rows = status
    ? (database
        .prepare(
          `SELECT * FROM cma_comparables WHERE session_id = ? AND listing_status = ?
           ORDER BY tray_slot_index ASC`,
        )
        .all(String(sessionId), status) as Record<string, unknown>[])
    : (database
        .prepare(`SELECT * FROM cma_comparables WHERE session_id = ? ORDER BY listing_status, tray_slot_index`)
        .all(String(sessionId)) as Record<string, unknown>[]);
  return rows.map(rowToComparable);
}

export function getComparable(id: string): CmaComparable | null {
  const r = getCmaDb().prepare(`SELECT * FROM cma_comparables WHERE id = ?`).get(String(id)) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToComparable(r) : null;
}

/** The lowest free slot 1..5, or null when the tray for that status is full. */
export function firstOpenSlot(sessionId: string, status: CompStatus): number | null {
  const taken = new Set(
    (
      getCmaDb()
        .prepare(`SELECT tray_slot_index s FROM cma_comparables WHERE session_id = ? AND listing_status = ?`)
        .all(String(sessionId), status) as { s: number }[]
    ).map((r) => Number(r.s)),
  );
  for (let i = 1; i <= TRAY_SLOTS; i++) if (!taken.has(i)) return i;
  return null;
}

export interface AddComparableInput {
  sessionId: string;
  listingStatus: CompStatus;
  source: CompSource;
  sourceKey?: string | null;
  mlsNumber?: string | null;
  address: string;
  city?: string | null;
  postalCode?: string | null;
  price?: number | null;
  originalListPrice?: number | null;
  soldPrice?: number | null;
  sellerConcessions?: number | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  lotSize?: number | null;
  yearBuilt?: number | null;
  listDate?: string | null;
  statusDate?: string | null;
  estimatedClosingDate?: string | null;
  daysOnMarket?: number | null;
  offMarketType?: OffMarketType | null;
  photoUrl?: string | null;
  notes?: string | null;
}

export class TrayFullError extends Error {
  constructor(status: CompStatus) {
    super(`All ${TRAY_SLOTS} ${status} slots are taken. Remove one before adding another.`);
    this.name = "TrayFullError";
  }
}

export class DuplicateComparableError extends Error {
  constructor() {
    super("That property is already selected in this step.");
    this.name = "DuplicateComparableError";
  }
}

export function addComparable(input: AddComparableInput): CmaComparable {
  const database = getCmaDb();
  const key = str(input.sourceKey);
  if (key) {
    const dupe = database
      .prepare(
        `SELECT id FROM cma_comparables WHERE session_id = ? AND listing_status = ? AND source_key = ?`,
      )
      .get(String(input.sessionId), input.listingStatus, key);
    if (dupe) throw new DuplicateComparableError();
  }
  const slot = firstOpenSlot(input.sessionId, input.listingStatus);
  if (slot === null) throw new TrayFullError(input.listingStatus);

  const id = `cmac_${randomUUID()}`;
  database
    .prepare(
      `INSERT INTO cma_comparables (
         id, session_id, listing_status, tray_slot_index, source, source_key, mls_number,
         address, city, postal_code, price, original_list_price, sold_price, seller_concessions,
         beds, baths, sqft, lot_size, year_built, list_date, status_date, estimated_closing_date,
         days_on_market, off_market_type, photo_url, notes, is_manual_entry, created_at
       ) VALUES (
         @id, @sessionId, @listingStatus, @slot, @source, @sourceKey, @mlsNumber,
         @address, @city, @postalCode, @price, @originalListPrice, @soldPrice, @sellerConcessions,
         @beds, @baths, @sqft, @lotSize, @yearBuilt, @listDate, @statusDate, @estimatedClosingDate,
         @daysOnMarket, @offMarketType, @photoUrl, @notes, @isManual, @now
       )`,
    )
    .run({
      id,
      sessionId: String(input.sessionId),
      listingStatus: input.listingStatus,
      slot,
      source: input.source,
      sourceKey: key,
      mlsNumber: str(input.mlsNumber),
      address: String(input.address).trim(),
      city: str(input.city),
      postalCode: str(input.postalCode),
      price: int(input.price),
      originalListPrice: int(input.originalListPrice),
      soldPrice: int(input.soldPrice),
      sellerConcessions: int(input.sellerConcessions),
      beds: num(input.beds),
      baths: num(input.baths),
      sqft: int(input.sqft),
      lotSize: num(input.lotSize),
      yearBuilt: int(input.yearBuilt),
      listDate: str(input.listDate),
      statusDate: str(input.statusDate),
      estimatedClosingDate: str(input.estimatedClosingDate),
      daysOnMarket: int(input.daysOnMarket),
      offMarketType: str(input.offMarketType),
      photoUrl: str(input.photoUrl),
      notes: str(input.notes),
      isManual: input.source === "manual" ? 1 : 0,
      now: new Date().toISOString(),
    });
  touchSession(input.sessionId);
  return getComparable(id)!;
}

/** Same omit-what-was-not-sent rule as `updateSession`. */
export function updateComparable(
  id: string,
  patch: Partial<Omit<AddComparableInput, "sessionId" | "listingStatus" | "source">>,
): CmaComparable | null {
  const existing = getComparable(id);
  if (!existing) return null;

  const cols: Record<string, string> = {
    sourceKey: "source_key",
    mlsNumber: "mls_number",
    address: "address",
    city: "city",
    postalCode: "postal_code",
    price: "price",
    originalListPrice: "original_list_price",
    soldPrice: "sold_price",
    sellerConcessions: "seller_concessions",
    beds: "beds",
    baths: "baths",
    sqft: "sqft",
    lotSize: "lot_size",
    yearBuilt: "year_built",
    listDate: "list_date",
    statusDate: "status_date",
    estimatedClosingDate: "estimated_closing_date",
    daysOnMarket: "days_on_market",
    offMarketType: "off_market_type",
    photoUrl: "photo_url",
    notes: "notes",
  };
  const numeric = new Set(["beds", "baths", "lotSize"]);
  const integer = new Set([
    "price", "originalListPrice", "soldPrice", "sellerConcessions", "sqft", "yearBuilt", "daysOnMarket",
  ]);

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: String(id) };
  for (const [key, col] of Object.entries(cols)) {
    if (!(key in patch)) continue;
    const raw = (patch as Record<string, unknown>)[key];
    params[key] = numeric.has(key) ? num(raw) : integer.has(key) ? int(raw) : str(raw);
    sets.push(`${col} = @${key}`);
  }
  if (!sets.length) return existing;
  getCmaDb().prepare(`UPDATE cma_comparables SET ${sets.join(", ")} WHERE id = @id`).run(params);
  touchSession(existing.sessionId);
  return getComparable(id);
}

export function removeComparable(id: string): boolean {
  const existing = getComparable(id);
  if (!existing) return false;
  const info = getCmaDb().prepare(`DELETE FROM cma_comparables WHERE id = ?`).run(String(id));
  if (info.changes > 0) touchSession(existing.sessionId);
  return info.changes > 0;
}

function touchSession(sessionId: string): void {
  getCmaDb()
    .prepare(`UPDATE cma_sessions SET updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), String(sessionId));
}


/* ────────────────────────── deliveries ────────────────────────── */

export function recordDelivery(d: Omit<CmaDelivery, "id" | "sentAt"> & { sentAt?: string }): CmaDelivery {
  const id = `cmad_${randomUUID()}`;
  const sentAt = d.sentAt || new Date().toISOString();
  getCmaDb()
    .prepare(
      `INSERT INTO cma_deliveries (
         id, session_id, first_name, last_name, email, market_drip_scheduled,
         report_id, lead_id, ok, error, sent_at
       ) VALUES (@id, @sessionId, @firstName, @lastName, @email, @drip, @reportId, @leadId, @ok, @error, @sentAt)`,
    )
    .run({
      id,
      sessionId: d.sessionId,
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email,
      drip: d.marketDripScheduled ? 1 : 0,
      reportId: d.reportId,
      leadId: d.leadId,
      ok: d.ok ? 1 : 0,
      error: d.error,
      sentAt,
    });
  return { ...d, id, sentAt };
}

export function listDeliveries(sessionId: string): CmaDelivery[] {
  return (
    getCmaDb()
      .prepare(`SELECT * FROM cma_deliveries WHERE session_id = ? ORDER BY sent_at DESC`)
      .all(String(sessionId)) as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    sessionId: String(r.session_id),
    firstName: String(r.first_name),
    lastName: String(r.last_name),
    email: String(r.email),
    marketDripScheduled: Number(r.market_drip_scheduled) === 1,
    reportId: (r.report_id as string) ?? null,
    leadId: (r.lead_id as string) ?? null,
    ok: Number(r.ok) === 1,
    error: (r.error as string) ?? null,
    sentAt: String(r.sent_at),
  }));
}
