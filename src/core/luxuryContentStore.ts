/**
 * Luxury content shortlist — the rolling list of $1M+ homes worth filming.
 *
 * The ask (operator spec, Aug 2026): search the MLS daily for content-worthy
 * homes over $1,000,000 — standout architecture, views, amenities, design —
 * and keep a rolling 5–7 each week for content tours.
 *
 * This store holds the candidates and their judgments. The judging itself
 * lives in agents/luxuryContent; here is only state, with the lifecycle:
 *
 *   candidate → shortlist → filmed        (toured; never resurfaces)
 *                        ↘ dismissed      (operator said no; never resurfaces)
 *   any state → off_market                (left the feed; kept for history)
 *
 * Scores are cached per listing so a home is judged ONCE — re-scoring 1,000
 * candidates daily would be pure spend for identical answers. A price change
 * big enough to matter re-enters through the sweep as a data update, not a
 * re-judgment.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

function resolveDbPath(): string {
  if (existsSync("/data")) return "/data/luxury-content.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "luxury-content.db");
}

let db: Database.Database | null = null;

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS luxury_candidates (
      listing_key TEXT PRIMARY KEY,
      mls_number TEXT,
      street TEXT,
      city TEXT,
      list_price REAL,
      beds INTEGER,
      baths REAL,
      living_area REAL,
      year_built INTEGER,
      subdivision TEXT,
      photo_url TEXT,
      remarks TEXT,
      listed_at TEXT,
      first_seen_at TEXT NOT NULL,
      score REAL,
      score_reasons TEXT,
      score_source TEXT,          -- 'claude' | 'heuristic'
      scored_at TEXT,
      status TEXT NOT NULL DEFAULT 'candidate',
      status_changed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lux_status ON luxury_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_lux_score ON luxury_candidates(score DESC);
  `);
}

export function getLuxuryDb(): Database.Database {
  if (db) return db;
  db = new Database(resolveDbPath());
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

export interface LuxuryCandidate {
  listingKey: string;
  mlsNumber: string | null;
  street: string | null;
  city: string | null;
  listPrice: number | null;
  beds: number | null;
  baths: number | null;
  livingArea: number | null;
  yearBuilt: number | null;
  subdivision: string | null;
  photoUrl: string | null;
  remarks: string | null;
  listedAt: string | null;
  firstSeenAt: string;
  score: number | null;
  scoreReasons: string | null;
  scoreSource: string | null;
  scoredAt: string | null;
  status: "candidate" | "shortlist" | "filmed" | "dismissed" | "off_market";
  statusChangedAt: string | null;
}

function rowToCandidate(r: Record<string, unknown>): LuxuryCandidate {
  return {
    listingKey: String(r.listing_key),
    mlsNumber: r.mls_number ? String(r.mls_number) : null,
    street: r.street ? String(r.street) : null,
    city: r.city ? String(r.city) : null,
    listPrice: r.list_price != null ? Number(r.list_price) : null,
    beds: r.beds != null ? Number(r.beds) : null,
    baths: r.baths != null ? Number(r.baths) : null,
    livingArea: r.living_area != null ? Number(r.living_area) : null,
    yearBuilt: r.year_built != null ? Number(r.year_built) : null,
    subdivision: r.subdivision ? String(r.subdivision) : null,
    photoUrl: r.photo_url ? String(r.photo_url) : null,
    remarks: r.remarks ? String(r.remarks) : null,
    listedAt: r.listed_at ? String(r.listed_at) : null,
    firstSeenAt: String(r.first_seen_at),
    score: r.score != null ? Number(r.score) : null,
    scoreReasons: r.score_reasons ? String(r.score_reasons) : null,
    scoreSource: r.score_source ? String(r.score_source) : null,
    scoredAt: r.scored_at ? String(r.scored_at) : null,
    status: String(r.status) as LuxuryCandidate["status"],
    statusChangedAt: r.status_changed_at ? String(r.status_changed_at) : null,
  };
}

/** Ingest sweep results. Existing rows get their FACTS refreshed (price cuts
 *  matter) but keep their score and status — filmed stays filmed. */
export function upsertCandidates(rows: Array<Omit<LuxuryCandidate,
  "firstSeenAt" | "score" | "scoreReasons" | "scoreSource" | "scoredAt" | "status" | "statusChangedAt">>): number {
  const database = getLuxuryDb();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    INSERT INTO luxury_candidates
      (listing_key, mls_number, street, city, list_price, beds, baths, living_area,
       year_built, subdivision, photo_url, remarks, listed_at, first_seen_at)
    VALUES (@listingKey, @mlsNumber, @street, @city, @listPrice, @beds, @baths, @livingArea,
       @yearBuilt, @subdivision, @photoUrl, @remarks, @listedAt, @firstSeenAt)
    ON CONFLICT(listing_key) DO UPDATE SET
      mls_number=excluded.mls_number, street=excluded.street, city=excluded.city,
      list_price=excluded.list_price, beds=excluded.beds, baths=excluded.baths,
      living_area=excluded.living_area, year_built=excluded.year_built,
      subdivision=excluded.subdivision, photo_url=excluded.photo_url,
      remarks=excluded.remarks, listed_at=excluded.listed_at
  `);
  let n = 0;
  const run = database.transaction((batch: typeof rows) => {
    for (const r of batch) {
      if (!r.listingKey) continue;
      stmt.run({ ...r, firstSeenAt: now });
      n++;
    }
  });
  run(rows);
  return n;
}

export function unscoredCandidates(limit = 40): LuxuryCandidate[] {
  return (getLuxuryDb()
    .prepare(`SELECT * FROM luxury_candidates
              WHERE score IS NULL AND status NOT IN ('filmed','dismissed','off_market')
              ORDER BY list_price DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[]).map(rowToCandidate);
}

export function setScore(listingKey: string, score: number, reasons: string, source: "claude" | "heuristic"): void {
  getLuxuryDb()
    .prepare(`UPDATE luxury_candidates SET score=?, score_reasons=?, score_source=?, scored_at=? WHERE listing_key=?`)
    .run(score, reasons, source, new Date().toISOString(), listingKey);
}

export function setStatus(listingKey: string, status: LuxuryCandidate["status"]): boolean {
  const r = getLuxuryDb()
    .prepare(`UPDATE luxury_candidates SET status=?, status_changed_at=? WHERE listing_key=?`)
    .run(status, new Date().toISOString(), listingKey);
  return r.changes > 0;
}

/** Mark everything that vanished from the given set of live keys. */
export function markOffMarket(liveKeys: Set<string>): number {
  const database = getLuxuryDb();
  const rows = database
    .prepare(`SELECT listing_key FROM luxury_candidates WHERE status IN ('candidate','shortlist')`)
    .all() as { listing_key: string }[];
  let n = 0;
  for (const r of rows) {
    if (!liveKeys.has(r.listing_key)) {
      setStatus(r.listing_key, "off_market");
      n++;
    }
  }
  return n;
}

export function currentShortlist(): LuxuryCandidate[] {
  return (getLuxuryDb()
    .prepare(`SELECT * FROM luxury_candidates WHERE status='shortlist' ORDER BY score DESC, list_price DESC`)
    .all() as Record<string, unknown>[]).map(rowToCandidate);
}

export function topCandidates(limit: number): LuxuryCandidate[] {
  return (getLuxuryDb()
    .prepare(`SELECT * FROM luxury_candidates
              WHERE status='candidate' AND score IS NOT NULL
              ORDER BY score DESC, list_price DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[]).map(rowToCandidate);
}

export function luxuryStats(): { total: number; byStatus: Record<string, number>; scored: number } {
  const database = getLuxuryDb();
  const total = (database.prepare(`SELECT COUNT(*) c FROM luxury_candidates`).get() as { c: number }).c;
  const scored = (database.prepare(`SELECT COUNT(*) c FROM luxury_candidates WHERE score IS NOT NULL`).get() as { c: number }).c;
  const byStatus: Record<string, number> = {};
  for (const r of database.prepare(`SELECT status s, COUNT(*) c FROM luxury_candidates GROUP BY status`).all() as { s: string; c: number }[]) {
    byStatus[r.s] = r.c;
  }
  return { total, byStatus, scored };
}
