import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

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

function resolveListingsDbPath(): string {
  const env = process.env.LISTINGS_DB_PATH?.trim();
  if (env) return env;
  if (existsSync("/data")) return "/data/listings.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "listings.db");
}

let db: Database.Database | null = null;

function initListingsSchema(database: Database.Database): void {
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

export function getListingsDb(): Database.Database {
  if (!db) {
    db = new Database(resolveListingsDbPath());
    initListingsSchema(db);
  }
  return db;
}

export interface Listing {
  listingKey: string;
  mlsNumber: string | null;
  status: string | null;
  listPrice: number | null;
  closePrice: number | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  beds: number | null;
  baths: number | null;
  livingArea: number | null;
  lotSize: number | null;
  yearBuilt: number | null;
  propertyType: string | null;
  subdivision: string | null;
  listAgent: string | null;
  listOffice: string | null;
  photoUrl: string | null;
  publicRemarks: string | null;
  modificationTs: string | null;
  listedAt: string | null;
  closedAt: string | null;
  syncedAt: string;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
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
export function fromResoProperty(p: Record<string, unknown>): Omit<Listing, "syncedAt"> & { raw: string } {
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
  const baths =
    num(p.BathroomsTotalInteger) ??
    num(p.BathroomsFull) ??
    num((p as { BathroomsTotalDecimal?: unknown }).BathroomsTotalDecimal);

  const media = Array.isArray(p.Media) ? (p.Media as Record<string, unknown>[]) : [];
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

export function upsertListings(rows: (Omit<Listing, "syncedAt"> & { raw: string })[]): number {
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
  const tx = database.transaction((items: typeof rows) => {
    for (const r of items) {
      if (!r.listingKey) continue;
      stmt.run({ ...r, syncedAt: now });
      n++;
    }
  });
  tx(rows);
  return n;
}

function rowToListing(r: Record<string, unknown>): Listing {
  return {
    listingKey: String(r.listing_key),
    mlsNumber: (r.mls_number as string) ?? null,
    status: (r.status as string) ?? null,
    listPrice: (r.list_price as number) ?? null,
    closePrice: (r.close_price as number) ?? null,
    street: (r.street as string) ?? null,
    city: (r.city as string) ?? null,
    state: (r.state as string) ?? null,
    postalCode: (r.postal_code as string) ?? null,
    beds: (r.beds as number) ?? null,
    baths: (r.baths as number) ?? null,
    livingArea: (r.living_area as number) ?? null,
    lotSize: (r.lot_size as number) ?? null,
    yearBuilt: (r.year_built as number) ?? null,
    propertyType: (r.property_type as string) ?? null,
    subdivision: (r.subdivision as string) ?? null,
    listAgent: (r.list_agent as string) ?? null,
    listOffice: (r.list_office as string) ?? null,
    photoUrl: (r.photo_url as string) ?? null,
    publicRemarks: (r.public_remarks as string) ?? null,
    modificationTs: (r.modification_ts as string) ?? null,
    listedAt: (r.listed_at as string) ?? null,
    closedAt: (r.closed_at as string) ?? null,
    syncedAt: String(r.synced_at),
  };
}

export interface ListingQuery {
  q?: string;
  city?: string;
  status?: string;
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  minBaths?: number;
  propertyType?: string;
  limit?: number;
}

export function searchListings(query: ListingQuery = {}): { total: number; listings: Listing[] } {
  const database = getListingsDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

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
  const total = (
    database.prepare(`SELECT COUNT(*) AS c FROM listings ${clause}`).get(params) as { c: number }
  ).c;
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 200);
  const rows = database
    .prepare(`SELECT * FROM listings ${clause} ORDER BY COALESCE(modification_ts, synced_at) DESC LIMIT @limit`)
    .all({ ...params, limit }) as Record<string, unknown>[];
  return { total, listings: rows.map(rowToListing) };
}

export function getListing(keyOrMls: string): (Listing & { raw: unknown }) | null {
  const database = getListingsDb();
  const row = database
    .prepare(`SELECT * FROM listings WHERE listing_key = ? OR mls_number = ? LIMIT 1`)
    .get(keyOrMls, keyOrMls) as Record<string, unknown> | undefined;
  if (!row) return null;
  let raw: unknown = null;
  try {
    raw = JSON.parse(String(row.raw));
  } catch {
    raw = null;
  }
  return { ...rowToListing(row), raw };
}

export function listingCounts(): { total: number; byStatus: Record<string, number> } {
  const database = getListingsDb();
  const total = (database.prepare(`SELECT COUNT(*) AS c FROM listings`).get() as { c: number }).c;
  const rows = database
    .prepare(`SELECT COALESCE(status,'(unknown)') AS s, COUNT(*) AS c FROM listings GROUP BY s`)
    .all() as { s: string; c: number }[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.s] = r.c;
  return { total, byStatus };
}

/** Newest ModificationTimestamp we hold — the high-water mark an incremental sync resumes from. */
export function newestModificationTs(): string | null {
  const row = getListingsDb()
    .prepare(`SELECT MAX(modification_ts) AS m FROM listings`)
    .get() as { m: string | null };
  return row?.m ?? null;
}

export function startSyncRun(): number {
  const info = getListingsDb()
    .prepare(`INSERT INTO listing_syncs (started_at) VALUES (?)`)
    .run(new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function finishSyncRun(
  id: number,
  data: { ok: boolean; fetched?: number; upserted?: number; error?: string },
): void {
  getListingsDb()
    .prepare(
      `UPDATE listing_syncs SET finished_at=?, ok=?, fetched=?, upserted=?, error=? WHERE id=?`,
    )
    .run(
      new Date().toISOString(),
      data.ok ? 1 : 0,
      data.fetched ?? 0,
      data.upserted ?? 0,
      data.error ?? null,
      id,
    );
}

export interface SyncRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  fetched: number;
  upserted: number;
  error: string | null;
}

export function recentSyncRuns(limit = 5): SyncRun[] {
  const rows = getListingsDb()
    .prepare(`SELECT * FROM listing_syncs ORDER BY id DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    startedAt: String(r.started_at),
    finishedAt: (r.finished_at as string) ?? null,
    ok: Number(r.ok) === 1,
    fetched: Number(r.fetched),
    upserted: Number(r.upserted),
    error: (r.error as string) ?? null,
  }));
}

export function lastSuccessfulSync(): SyncRun | null {
  const r = getListingsDb()
    .prepare(`SELECT * FROM listing_syncs WHERE ok = 1 ORDER BY id DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: Number(r.id),
    startedAt: String(r.started_at),
    finishedAt: (r.finished_at as string) ?? null,
    ok: true,
    fetched: Number(r.fetched),
    upserted: Number(r.upserted),
    error: null,
  };
}
