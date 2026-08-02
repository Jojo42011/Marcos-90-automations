"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getListingsDb = getListingsDb;
exports.fromResoProperty = fromResoProperty;
exports.upsertListings = upsertListings;
exports.searchListings = searchListings;
exports.getListing = getListing;
exports.listingCounts = listingCounts;
exports.newestModificationTs = newestModificationTs;
exports.startSyncRun = startSyncRun;
exports.finishSyncRun = finishSyncRun;
exports.recentSyncRuns = recentSyncRuns;
exports.lastSuccessfulSync = lastSuccessfulSync;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
/**
 * MLS listings, pulled from Bridge Interactive and cached locally.
 *
 * WHY CACHE AT ALL. Every MLS feed is rate-limited and most licences forbid
 * hammering them per user request. A local mirror also means the DM pipeline
 * can answer "what's the price on that Canyon Lake place" in milliseconds
 * instead of blocking a lead's reply on a third-party round trip.
 *
 * FIELD NAMES ARE RESO. `ListingKey`, `StandardStatus`, `ListPrice` and the
 * rest are the RESO Data Dictionary spellings that Bridge returns verbatim.
 * Renaming them to something prettier would mean maintaining a translation
 * table against a spec that changes yearly, and would make every future
 * question ("does Bridge send LivingArea or AboveGradeFinishedArea?")
 * unanswerable without reading two files instead of one.
 *
 * `raw` keeps the untouched record. MLS feeds carry hundreds of fields, vary
 * by board, and the ones nobody thought to map are exactly the ones an agent
 * asks about later. Storing the original costs a few KB per listing and means
 * a new question never requires a re-sync.
 */
function resolveListingsDbPath() {
    const env = process.env.LISTINGS_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/listings.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "listings.db");
}
let db = null;
function initListingsSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      listing_key TEXT PRIMARY KEY,
      mls_number TEXT,
      status TEXT,
      list_price INTEGER,
      close_price INTEGER,
      street TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      beds REAL,
      baths REAL,
      living_area REAL,
      lot_size REAL,
      year_built INTEGER,
      property_type TEXT,
      subdivision TEXT,
      list_agent TEXT,
      list_office TEXT,
      photo_url TEXT,
      public_remarks TEXT,
      modification_ts TEXT,
      listed_at TEXT,
      closed_at TEXT,
      raw TEXT NOT NULL,
      synced_at TEXT NOT NULL
    )
  `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_listings_city ON listings(city)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(list_price)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_listings_mls ON listings(mls_number)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_listings_modts ON listings(modification_ts)`);
    /* One row per sync attempt, successes AND failures. A feed that silently
       stopped updating looks exactly like a quiet market until you can see that
       the last successful run was eleven days ago. */
    database.exec(`
    CREATE TABLE IF NOT EXISTS listing_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      fetched INTEGER NOT NULL DEFAULT 0,
      upserted INTEGER NOT NULL DEFAULT 0,
      error TEXT
    )
  `);
}
function getListingsDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveListingsDbPath());
        initListingsSchema(db);
    }
    return db;
}
const num = (v) => {
    if (v === null || v === undefined || v === "")
        return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const str = (v) => {
    if (v === null || v === undefined)
        return null;
    const s = String(v).trim();
    return s ? s : null;
};
/**
 * Flatten a RESO Property record into the columns we query on.
 *
 * Address is assembled from the RESO parts rather than trusting
 * `UnparsedAddress`, which many boards leave empty even when the components
 * are all present.
 */
function fromResoProperty(p) {
    const streetParts = [
        p.StreetNumber,
        p.StreetDirPrefix,
        p.StreetName,
        p.StreetSuffix,
        p.StreetDirSuffix,
        p.UnitNumber ? `#${String(p.UnitNumber)}` : null,
    ]
        .map(str)
        .filter(Boolean);
    const street = streetParts.length ? streetParts.join(" ") : str(p.UnparsedAddress);
    /* Boards disagree on which bath field is authoritative; take the first that
       is actually populated rather than assuming one spelling. */
    const baths = num(p.BathroomsTotalInteger) ??
        num(p.BathroomsFull) ??
        num(p.BathroomsTotalDecimal);
    const media = Array.isArray(p.Media) ? p.Media : [];
    const photoUrl = str(media[0]?.MediaURL) ?? str(p.PhotosURL);
    return {
        listingKey: String(p.ListingKey ?? p.ListingId ?? "").trim(),
        mlsNumber: str(p.ListingId) ?? str(p.MLSNumber),
        status: str(p.StandardStatus) ?? str(p.MlsStatus),
        listPrice: num(p.ListPrice),
        closePrice: num(p.ClosePrice),
        street,
        city: str(p.City),
        state: str(p.StateOrProvince),
        postalCode: str(p.PostalCode),
        beds: num(p.BedroomsTotal),
        baths,
        livingArea: num(p.LivingArea) ?? num(p.AboveGradeFinishedArea),
        lotSize: num(p.LotSizeAcres) ?? num(p.LotSizeSquareFeet),
        yearBuilt: num(p.YearBuilt),
        propertyType: str(p.PropertyType) ?? str(p.PropertySubType),
        subdivision: str(p.SubdivisionName),
        listAgent: str(p.ListAgentFullName),
        listOffice: str(p.ListOfficeName),
        photoUrl,
        publicRemarks: str(p.PublicRemarks),
        modificationTs: str(p.ModificationTimestamp),
        listedAt: str(p.OnMarketDate) ?? str(p.ListingContractDate),
        closedAt: str(p.CloseDate),
        raw: JSON.stringify(p),
    };
}
function upsertListings(rows) {
    const database = getListingsDb();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO listings (
      listing_key, mls_number, status, list_price, close_price, street, city, state, postal_code,
      beds, baths, living_area, lot_size, year_built, property_type, subdivision,
      list_agent, list_office, photo_url, public_remarks, modification_ts, listed_at, closed_at, raw, synced_at
    ) VALUES (
      @listingKey, @mlsNumber, @status, @listPrice, @closePrice, @street, @city, @state, @postalCode,
      @beds, @baths, @livingArea, @lotSize, @yearBuilt, @propertyType, @subdivision,
      @listAgent, @listOffice, @photoUrl, @publicRemarks, @modificationTs, @listedAt, @closedAt, @raw, @syncedAt
    )
    ON CONFLICT(listing_key) DO UPDATE SET
      mls_number=excluded.mls_number, status=excluded.status, list_price=excluded.list_price,
      close_price=excluded.close_price, street=excluded.street, city=excluded.city, state=excluded.state,
      postal_code=excluded.postal_code, beds=excluded.beds, baths=excluded.baths,
      living_area=excluded.living_area, lot_size=excluded.lot_size, year_built=excluded.year_built,
      property_type=excluded.property_type, subdivision=excluded.subdivision,
      list_agent=excluded.list_agent, list_office=excluded.list_office, photo_url=excluded.photo_url,
      public_remarks=excluded.public_remarks, modification_ts=excluded.modification_ts,
      listed_at=excluded.listed_at, closed_at=excluded.closed_at, raw=excluded.raw, synced_at=excluded.synced_at
  `);
    let n = 0;
    const tx = database.transaction((items) => {
        for (const r of items) {
            if (!r.listingKey)
                continue;
            stmt.run({ ...r, syncedAt: now });
            n++;
        }
    });
    tx(rows);
    return n;
}
function rowToListing(r) {
    return {
        listingKey: String(r.listing_key),
        mlsNumber: r.mls_number ?? null,
        status: r.status ?? null,
        listPrice: r.list_price ?? null,
        closePrice: r.close_price ?? null,
        street: r.street ?? null,
        city: r.city ?? null,
        state: r.state ?? null,
        postalCode: r.postal_code ?? null,
        beds: r.beds ?? null,
        baths: r.baths ?? null,
        livingArea: r.living_area ?? null,
        lotSize: r.lot_size ?? null,
        yearBuilt: r.year_built ?? null,
        propertyType: r.property_type ?? null,
        subdivision: r.subdivision ?? null,
        listAgent: r.list_agent ?? null,
        listOffice: r.list_office ?? null,
        photoUrl: r.photo_url ?? null,
        publicRemarks: r.public_remarks ?? null,
        modificationTs: r.modification_ts ?? null,
        listedAt: r.listed_at ?? null,
        closedAt: r.closed_at ?? null,
        syncedAt: String(r.synced_at),
    };
}
function searchListings(query = {}) {
    const database = getListingsDb();
    const where = [];
    const params = {};
    if (query.q?.trim()) {
        where.push("(street LIKE @q OR city LIKE @q OR subdivision LIKE @q OR mls_number LIKE @q OR public_remarks LIKE @q)");
        params.q = `%${query.q.trim()}%`;
    }
    if (query.city?.trim()) {
        where.push("LOWER(city) = LOWER(@city)");
        params.city = query.city.trim();
    }
    if (query.status?.trim()) {
        where.push("LOWER(status) = LOWER(@status)");
        params.status = query.status.trim();
    }
    if (query.propertyType?.trim()) {
        where.push("LOWER(property_type) LIKE LOWER(@ptype)");
        params.ptype = `%${query.propertyType.trim()}%`;
    }
    if (Number.isFinite(query.minPrice)) {
        where.push("list_price >= @minPrice");
        params.minPrice = query.minPrice;
    }
    if (Number.isFinite(query.maxPrice)) {
        where.push("list_price <= @maxPrice");
        params.maxPrice = query.maxPrice;
    }
    if (Number.isFinite(query.minBeds)) {
        where.push("beds >= @minBeds");
        params.minBeds = query.minBeds;
    }
    if (Number.isFinite(query.minBaths)) {
        where.push("baths >= @minBaths");
        params.minBaths = query.minBaths;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = database.prepare(`SELECT COUNT(*) AS c FROM listings ${clause}`).get(params).c;
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 200);
    const rows = database
        .prepare(`SELECT * FROM listings ${clause} ORDER BY COALESCE(modification_ts, synced_at) DESC LIMIT @limit`)
        .all({ ...params, limit });
    return { total, listings: rows.map(rowToListing) };
}
function getListing(keyOrMls) {
    const database = getListingsDb();
    const row = database
        .prepare(`SELECT * FROM listings WHERE listing_key = ? OR mls_number = ? LIMIT 1`)
        .get(keyOrMls, keyOrMls);
    if (!row)
        return null;
    let raw = null;
    try {
        raw = JSON.parse(String(row.raw));
    }
    catch {
        raw = null;
    }
    return { ...rowToListing(row), raw };
}
function listingCounts() {
    const database = getListingsDb();
    const total = database.prepare(`SELECT COUNT(*) AS c FROM listings`).get().c;
    const rows = database
        .prepare(`SELECT COALESCE(status,'(unknown)') AS s, COUNT(*) AS c FROM listings GROUP BY s`)
        .all();
    const byStatus = {};
    for (const r of rows)
        byStatus[r.s] = r.c;
    return { total, byStatus };
}
/** Newest ModificationTimestamp we hold — the high-water mark an incremental sync resumes from. */
function newestModificationTs() {
    const row = getListingsDb()
        .prepare(`SELECT MAX(modification_ts) AS m FROM listings`)
        .get();
    return row?.m ?? null;
}
function startSyncRun() {
    const info = getListingsDb()
        .prepare(`INSERT INTO listing_syncs (started_at) VALUES (?)`)
        .run(new Date().toISOString());
    return Number(info.lastInsertRowid);
}
function finishSyncRun(id, data) {
    getListingsDb()
        .prepare(`UPDATE listing_syncs SET finished_at=?, ok=?, fetched=?, upserted=?, error=? WHERE id=?`)
        .run(new Date().toISOString(), data.ok ? 1 : 0, data.fetched ?? 0, data.upserted ?? 0, data.error ?? null, id);
}
function recentSyncRuns(limit = 5) {
    const rows = getListingsDb()
        .prepare(`SELECT * FROM listing_syncs ORDER BY id DESC LIMIT ?`)
        .all(limit);
    return rows.map((r) => ({
        id: Number(r.id),
        startedAt: String(r.started_at),
        finishedAt: r.finished_at ?? null,
        ok: Number(r.ok) === 1,
        fetched: Number(r.fetched),
        upserted: Number(r.upserted),
        error: r.error ?? null,
    }));
}
function lastSuccessfulSync() {
    const r = getListingsDb()
        .prepare(`SELECT * FROM listing_syncs WHERE ok = 1 ORDER BY id DESC LIMIT 1`)
        .get();
    if (!r)
        return null;
    return {
        id: Number(r.id),
        startedAt: String(r.started_at),
        finishedAt: r.finished_at ?? null,
        ok: true,
        fetched: Number(r.fetched),
        upserted: Number(r.upserted),
        error: null,
    };
}
