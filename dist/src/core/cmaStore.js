"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DuplicateComparableError = exports.TrayFullError = exports.TRAY_SLOTS = exports.COMP_STATUSES = void 0;
exports.initCmaSchema = initCmaSchema;
exports.getCmaDb = getCmaDb;
exports.createSession = createSession;
exports.getSession = getSession;
exports.listSessions = listSessions;
exports.updateSession = updateSession;
exports.deleteSession = deleteSession;
exports.listComparables = listComparables;
exports.getComparable = getComparable;
exports.firstOpenSlot = firstOpenSlot;
exports.addComparable = addComparable;
exports.updateComparable = updateComparable;
exports.removeComparable = removeComparable;
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
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
exports.COMP_STATUSES = ["ACTIVE", "PENDING", "SOLD", "OFF_MKT"];
/** Fixed tray capacity, per the spec. Five slots per step, not per session. */
exports.TRAY_SLOTS = 5;
/* ────────────────────────── database ────────────────────────── */
function resolveCmaDbPath() {
    const env = process.env.CMA_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/cma.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "cma.db");
}
let db = null;
function initCmaSchema(database) {
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
    /* Partial unique index rather than a plain UNIQUE: a hand-typed row has no
       source key, and several NULLs in one column would collide under some
       engines while meaning "these are all different rows" here. */
    database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cma_comps_unique_source
      ON cma_comparables(session_id, listing_status, source_key)
      WHERE source_key IS NOT NULL
  `);
}
function getCmaDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveCmaDbPath());
        db.pragma("foreign_keys = ON");
        initCmaSchema(db);
    }
    return db;
}
/* ────────────────────────── coercion ────────────────────────── */
const num = (v) => {
    if (v === null || v === undefined || v === "")
        return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const int = (v) => {
    const n = num(v);
    return n === null ? null : Math.round(n);
};
const str = (v) => {
    if (v === null || v === undefined)
        return null;
    const s = String(v).trim();
    return s ? s : null;
};
function rowToSession(r) {
    let criteria = {};
    try {
        const parsed = JSON.parse(String(r.criteria ?? "{}"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            criteria = parsed;
    }
    catch {
        /* A row whose criteria JSON is unreadable still describes a real subject
           property and real picks; it opens with an empty search rather than 500ing
           the whole session. */
    }
    return {
        id: String(r.id),
        clientName: String(r.client_name),
        leadId: r.lead_id ?? null,
        mls: r.mls ?? null,
        subjectAddress: String(r.subject_address),
        subjectCity: r.subject_city ?? null,
        subjectState: r.subject_state ?? null,
        subjectPostalCode: r.subject_postal_code ?? null,
        subjectPropertyType: r.subject_property_type ?? null,
        subjectBeds: r.subject_beds ?? null,
        subjectBaths: r.subject_baths ?? null,
        subjectSqft: r.subject_sqft ?? null,
        subjectLotSize: r.subject_lot_size ?? null,
        subjectYearBuilt: r.subject_year_built ?? null,
        criteria,
        areaRung: r.area_rung ?? null,
        areaLabel: r.area_label ?? null,
        currentStep: Number(r.current_step ?? 1),
        status: String(r.status) === "published" ? "published" : "draft",
        publishedAt: r.published_at ?? null,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
    };
}
function rowToComparable(r) {
    return {
        id: String(r.id),
        sessionId: String(r.session_id),
        listingStatus: String(r.listing_status),
        traySlotIndex: Number(r.tray_slot_index),
        source: String(r.source),
        sourceKey: r.source_key ?? null,
        mlsNumber: r.mls_number ?? null,
        address: String(r.address),
        city: r.city ?? null,
        postalCode: r.postal_code ?? null,
        price: r.price ?? null,
        originalListPrice: r.original_list_price ?? null,
        soldPrice: r.sold_price ?? null,
        sellerConcessions: r.seller_concessions ?? null,
        beds: r.beds ?? null,
        baths: r.baths ?? null,
        sqft: r.sqft ?? null,
        lotSize: r.lot_size ?? null,
        yearBuilt: r.year_built ?? null,
        listDate: r.list_date ?? null,
        statusDate: r.status_date ?? null,
        estimatedClosingDate: r.estimated_closing_date ?? null,
        daysOnMarket: r.days_on_market ?? null,
        offMarketType: r.off_market_type ?? null,
        photoUrl: r.photo_url ?? null,
        notes: r.notes ?? null,
        isManualEntry: Number(r.is_manual_entry) === 1,
        createdAt: String(r.created_at),
    };
}
function createSession(input) {
    const database = getCmaDb();
    const now = new Date().toISOString();
    const id = `cma_${(0, crypto_1.randomUUID)()}`;
    database
        .prepare(`INSERT INTO cma_sessions (
         id, client_name, lead_id, mls, subject_address, subject_city, subject_state,
         subject_postal_code, subject_property_type, subject_beds, subject_baths,
         subject_sqft, subject_lot_size, subject_year_built, criteria,
         current_step, status, created_at, updated_at
       ) VALUES (
         @id, @clientName, @leadId, @mls, @subjectAddress, @subjectCity, @subjectState,
         @subjectPostalCode, @subjectPropertyType, @subjectBeds, @subjectBaths,
         @subjectSqft, @subjectLotSize, @subjectYearBuilt, @criteria,
         2, 'draft', @now, @now
       )`)
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
    return getSession(id);
}
function getSession(id) {
    const r = getCmaDb().prepare(`SELECT * FROM cma_sessions WHERE id = ?`).get(String(id));
    return r ? rowToSession(r) : null;
}
function listSessions(opts = {}) {
    const database = getCmaDb();
    const limit = Math.min(Math.max(Number(opts.limit ?? 100), 1), 500);
    const rows = opts.leadId
        ? database
            .prepare(`SELECT * FROM cma_sessions WHERE lead_id = ? ORDER BY updated_at DESC LIMIT ?`)
            .all(String(opts.leadId), limit)
        : database
            .prepare(`SELECT * FROM cma_sessions ORDER BY updated_at DESC LIMIT ?`)
            .all(limit);
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
function updateSession(id, patch) {
    const existing = getSession(id);
    if (!existing)
        return null;
    const cols = {
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
        currentStep: "current_step",
        status: "status",
        publishedAt: "published_at",
        areaRung: "area_rung",
        areaLabel: "area_label",
    };
    const numeric = new Set(["subjectBeds", "subjectBaths", "subjectLotSize"]);
    const integer = new Set(["subjectSqft", "subjectYearBuilt", "currentStep"]);
    const sets = [];
    const params = { id: String(id), now: new Date().toISOString() };
    for (const [key, col] of Object.entries(cols)) {
        if (!(key in patch))
            continue;
        const raw = patch[key];
        params[key] = numeric.has(key) ? num(raw) : integer.has(key) ? int(raw) : str(raw);
        sets.push(`${col} = @${key}`);
    }
    if ("criteria" in patch) {
        params.criteria = JSON.stringify(patch.criteria ?? {});
        sets.push(`criteria = @criteria`);
    }
    if (!sets.length)
        return existing;
    sets.push(`updated_at = @now`);
    getCmaDb().prepare(`UPDATE cma_sessions SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return getSession(id);
}
function deleteSession(id) {
    const info = getCmaDb().prepare(`DELETE FROM cma_sessions WHERE id = ?`).run(String(id));
    return info.changes > 0;
}
/* ────────────────────────── comparables ────────────────────────── */
function listComparables(sessionId, status) {
    const database = getCmaDb();
    const rows = status
        ? database
            .prepare(`SELECT * FROM cma_comparables WHERE session_id = ? AND listing_status = ?
           ORDER BY tray_slot_index ASC`)
            .all(String(sessionId), status)
        : database
            .prepare(`SELECT * FROM cma_comparables WHERE session_id = ? ORDER BY listing_status, tray_slot_index`)
            .all(String(sessionId));
    return rows.map(rowToComparable);
}
function getComparable(id) {
    const r = getCmaDb().prepare(`SELECT * FROM cma_comparables WHERE id = ?`).get(String(id));
    return r ? rowToComparable(r) : null;
}
/** The lowest free slot 1..5, or null when the tray for that status is full. */
function firstOpenSlot(sessionId, status) {
    const taken = new Set(getCmaDb()
        .prepare(`SELECT tray_slot_index s FROM cma_comparables WHERE session_id = ? AND listing_status = ?`)
        .all(String(sessionId), status).map((r) => Number(r.s)));
    for (let i = 1; i <= exports.TRAY_SLOTS; i++)
        if (!taken.has(i))
            return i;
    return null;
}
class TrayFullError extends Error {
    constructor(status) {
        super(`All ${exports.TRAY_SLOTS} ${status} slots are taken. Remove one before adding another.`);
        this.name = "TrayFullError";
    }
}
exports.TrayFullError = TrayFullError;
class DuplicateComparableError extends Error {
    constructor() {
        super("That property is already selected in this step.");
        this.name = "DuplicateComparableError";
    }
}
exports.DuplicateComparableError = DuplicateComparableError;
function addComparable(input) {
    const database = getCmaDb();
    const key = str(input.sourceKey);
    if (key) {
        const dupe = database
            .prepare(`SELECT id FROM cma_comparables WHERE session_id = ? AND listing_status = ? AND source_key = ?`)
            .get(String(input.sessionId), input.listingStatus, key);
        if (dupe)
            throw new DuplicateComparableError();
    }
    const slot = firstOpenSlot(input.sessionId, input.listingStatus);
    if (slot === null)
        throw new TrayFullError(input.listingStatus);
    const id = `cmac_${(0, crypto_1.randomUUID)()}`;
    database
        .prepare(`INSERT INTO cma_comparables (
         id, session_id, listing_status, tray_slot_index, source, source_key, mls_number,
         address, city, postal_code, price, original_list_price, sold_price, seller_concessions,
         beds, baths, sqft, lot_size, year_built, list_date, status_date, estimated_closing_date,
         days_on_market, off_market_type, photo_url, notes, is_manual_entry, created_at
       ) VALUES (
         @id, @sessionId, @listingStatus, @slot, @source, @sourceKey, @mlsNumber,
         @address, @city, @postalCode, @price, @originalListPrice, @soldPrice, @sellerConcessions,
         @beds, @baths, @sqft, @lotSize, @yearBuilt, @listDate, @statusDate, @estimatedClosingDate,
         @daysOnMarket, @offMarketType, @photoUrl, @notes, @isManual, @now
       )`)
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
    return getComparable(id);
}
/** Same omit-what-was-not-sent rule as `updateSession`. */
function updateComparable(id, patch) {
    const existing = getComparable(id);
    if (!existing)
        return null;
    const cols = {
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
    const sets = [];
    const params = { id: String(id) };
    for (const [key, col] of Object.entries(cols)) {
        if (!(key in patch))
            continue;
        const raw = patch[key];
        params[key] = numeric.has(key) ? num(raw) : integer.has(key) ? int(raw) : str(raw);
        sets.push(`${col} = @${key}`);
    }
    if (!sets.length)
        return existing;
    getCmaDb().prepare(`UPDATE cma_comparables SET ${sets.join(", ")} WHERE id = @id`).run(params);
    touchSession(existing.sessionId);
    return getComparable(id);
}
function removeComparable(id) {
    const existing = getComparable(id);
    if (!existing)
        return false;
    const info = getCmaDb().prepare(`DELETE FROM cma_comparables WHERE id = ?`).run(String(id));
    if (info.changes > 0)
        touchSession(existing.sessionId);
    return info.changes > 0;
}
function touchSession(sessionId) {
    getCmaDb()
        .prepare(`UPDATE cma_sessions SET updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), String(sessionId));
}
