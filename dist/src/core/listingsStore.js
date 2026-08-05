"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getListingsDb = getListingsDb;
exports.fromSimplyRets = fromSimplyRets;
exports.upsertListings = upsertListings;
exports.searchListings = searchListings;
exports.allActiveListingsOver = allActiveListingsOver;
exports.knownCities = knownCities;
exports.marketStats = marketStats;
exports.getListing = getListing;
exports.listingCounts = listingCounts;
exports.newestModificationTs = newestModificationTs;
exports.startSyncRun = startSyncRun;
exports.finishSyncRun = finishSyncRun;
exports.recentSyncRuns = recentSyncRuns;
exports.lastSuccessfulSync = lastSuccessfulSync;
exports.getBackfillState = getBackfillState;
exports.setBackfillState = setBackfillState;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
/**
 * MLS listings, pulled from SimplyRETS (SABOR / San Antonio Board of REALTORS)
 * and cached locally.
 *
 * WHY CACHE AT ALL. Every MLS feed is rate-limited and most licences forbid
 * hammering them per user request. A local mirror also means the DM pipeline
 * can answer "what's the price on that Canyon Lake place" in milliseconds
 * instead of blocking a lead's reply on a third-party round trip.
 *
 * COLUMNS ARE FLATTENED, RAW IS KEPT. SimplyRETS nests the interesting parts
 * three levels down (`property.bedrooms`, `address.city`, `mls.status`), which
 * is fine to read and impossible to index. The columns below are the handful
 * worth querying on; everything else stays in `raw`.
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
    /* Backfill progress. Without this the mirror is silently incomplete: the
       incremental walk goes newest-first and stops at the first listing already
       held, so anything below a capped first pull would never be reached and the
       status endpoint would still report a healthy feed. */
    database.exec(`
    CREATE TABLE IF NOT EXISTS listing_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      backfill_complete INTEGER NOT NULL DEFAULT 0,
      backfill_offset INTEGER NOT NULL DEFAULT 0
    )
  `);
    database.exec(`INSERT OR IGNORE INTO listing_sync_state (id) VALUES (1)`);
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
/** Fallback address when the feed omits the pre-assembled `full`. */
function fromParts(addr) {
    return [str(addr.streetNumberText) ?? str(addr.streetNumber), str(addr.streetName)]
        .filter(Boolean)
        .join(" ");
}
/**
 * Flatten one SimplyRETS listing into the columns we query on.
 *
 * Mapped against the LIVE payload rather than the docs — verified on real SABOR
 * records, which is why `street` uses `address.full` (already assembled and
 * correct) instead of rebuilding it from `streetNumber` + `streetName`, and why
 * baths combine `bathsFull` with a half-count that the feed reports separately.
 *
 * `mlsId` is the stable primary key; `listingId` is the human-facing MLS number
 * an agent actually types. Both are kept because they are asked for by
 * different people.
 */
function fromSimplyRets(p) {
    const prop = (p.property ?? {});
    const addr = (p.address ?? {});
    const mls = (p.mls ?? {});
    const sales = (p.sales ?? {});
    const agent = (p.agent ?? {});
    const office = (p.office ?? {});
    const photos = Array.isArray(p.photos) ? p.photos : [];
    /* A half bath is half a bath to a buyer; the feed keeps them in separate
       fields, so "2.5 baths" only exists if we add them up. */
    const full = num(prop.bathsFull) ?? 0;
    const half = num(prop.bathsHalf) ?? 0;
    const baths = num(prop.bathrooms) ?? (full + half * 0.5 || null);
    const agentName = [str(agent.firstName), str(agent.lastName)].filter(Boolean).join(" ") || null;
    return {
        listingKey: String(p.mlsId ?? p.listingId ?? "").trim(),
        mlsNumber: str(p.listingId),
        status: str(mls.status),
        listPrice: num(p.listPrice),
        closePrice: num(sales.closePrice),
        street: str(addr.full) ?? (fromParts(addr) || null),
        city: str(addr.city),
        state: str(addr.state),
        postalCode: str(addr.postalCode),
        beds: num(prop.bedrooms),
        baths,
        livingArea: num(prop.area),
        lotSize: num(prop.acres) ?? num(prop.lotSize),
        yearBuilt: num(prop.yearBuilt),
        propertyType: str(prop.type),
        subdivision: str(prop.subdivision),
        listAgent: agentName,
        listOffice: str(office.name),
        photoUrl: typeof photos[0] === "string" ? photos[0] : null,
        publicRemarks: str(p.remarks),
        modificationTs: str(p.modified),
        listedAt: str(p.listDate),
        closedAt: str(sales.closeDate),
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
/**
 * Every city the board actually covers, longest name first.
 *
 * This is the authority for "is that a place?" — it comes from the 27,083
 * listings themselves, so it needs no maintenance and cannot drift from what
 * Marco can actually sell. Longest-first matters: "New Braunfels" has to be
 * tried before "Braunfels" would ever match, and "San Antonio" before "Antonio".
 *
 * Cached for the process. The city list changes when a new subdivision is
 * annexed, not between two DMs, and this is called on every inbound message.
 */
let cityCache = null;
const CITY_CACHE_MS = 60 * 60 * 1000;
/**
 * Every active listing at or above a price — for sweeps, not for the API.
 * `searchListings` clamps its limit to 200 (correct for a request that renders
 * a page, silently wrong for an agent that believes it saw the whole market:
 * the luxury scout's first production run reported 200 candidates as if they
 * were all ~1,059). No clamp here, by design and by name.
 */
function allActiveListingsOver(minPrice) {
    const database = getListingsDb();
    const rows = database
        .prepare(`SELECT * FROM listings
       WHERE LOWER(status) = 'active' AND list_price >= ?
       ORDER BY COALESCE(modification_ts, synced_at) DESC`)
        .all(minPrice);
    return rows.map(rowToListing);
}
function knownCities() {
    if (cityCache && Date.now() - cityCache.at < CITY_CACHE_MS)
        return cityCache.rows;
    let rows = [];
    try {
        rows = getListingsDb()
            .prepare(`SELECT city, COUNT(*) AS c FROM listings
           WHERE city IS NOT NULL AND TRIM(city) <> '' GROUP BY city`)
            .all()
            .map((r) => ({ city: r.city.trim(), count: Number(r.c) }))
            /* One stray listing does not make a city, and single-row rows in an MLS
               feed are usually a typo in someone's data entry. */
            .filter((r) => r.count >= 2 && r.city.length >= 3)
            .sort((a, b) => b.city.length - a.city.length);
    }
    catch {
        rows = [];
    }
    cityCache = { at: Date.now(), rows };
    return rows;
}
/**
 * What the mirror can honestly say about one city's market.
 *
 * DELIBERATELY NO SOLD DATA. The SABOR feed we are entitled to returns Active
 * and Pending only — 23,205 and 3,878 rows against 2 with a close price — so
 * anything phrased as "homes near you sold for X" would be a number we do not
 * have. Everything here is asking price and inventory, and the copy that uses
 * it has to say so. A seller who prices off a "sold" figure that was really a
 * list price loses real money.
 *
 * Returns null below a floor of 5 active listings: a median of two houses is
 * not a market, and quoting it would be worse than saying nothing.
 */
function marketStats(city) {
    const database = getListingsDb();
    const name = city.trim();
    if (!name)
        return null;
    const counts = database
        .prepare(`SELECT
         SUM(CASE WHEN LOWER(status) = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN LOWER(status) = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM listings WHERE LOWER(city) = LOWER(?)`)
        .get(name);
    const active = Number(counts?.active ?? 0);
    if (active < 5)
        return null;
    /* SQLite has no median, and the average is the wrong statistic here: one
       $12M ranch drags the mean for a whole suburb. */
    const median = (column) => {
        const row = database
            .prepare(`SELECT ${column} AS v FROM listings
         WHERE LOWER(city) = LOWER(?) AND LOWER(status) = 'active' AND ${column} > 0
         ORDER BY ${column} LIMIT 1 OFFSET (
           SELECT COUNT(*) / 2 FROM listings
           WHERE LOWER(city) = LOWER(?) AND LOWER(status) = 'active' AND ${column} > 0
         )`)
            .get(name, name);
        return row ? Number(row.v) : null;
    };
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = database
        .prepare(`SELECT COUNT(*) AS c FROM listings
       WHERE LOWER(city) = LOWER(?) AND LOWER(status) = 'active' AND listed_at >= ?`)
        .get(name, cutoff);
    return {
        city: name,
        active,
        pending: Number(counts?.pending ?? 0),
        medianActivePrice: median("list_price"),
        medianSqft: median("living_area"),
        newLast30: Number(fresh?.c ?? 0),
    };
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
function getBackfillState() {
    const r = getListingsDb()
        .prepare(`SELECT backfill_complete, backfill_offset FROM listing_sync_state WHERE id = 1`)
        .get();
    return { complete: Number(r?.backfill_complete) === 1, offset: Number(r?.backfill_offset ?? 0) };
}
function setBackfillState(state) {
    const cur = getBackfillState();
    getListingsDb()
        .prepare(`UPDATE listing_sync_state SET backfill_complete = ?, backfill_offset = ? WHERE id = 1`)
        .run((state.complete ?? cur.complete) ? 1 : 0, Math.max(0, state.offset ?? cur.offset));
}
