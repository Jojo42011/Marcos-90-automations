/**
 * Client property shortlists — the homes picked for (or by) a specific lead.
 *
 * Until now a lead could be linked to exactly ONE listing (`mlsListingKey`,
 * "their property"). "The five homes Jason wants to see Saturday" had nowhere
 * to live, which is why the client-PDF ask had nothing to draw from. This is
 * that missing shape: a small ordered set of listings per lead.
 *
 * Rows hold only the (leadId, listingKey) relationship plus a note — listing
 * FACTS are joined live from the MLS mirror at read time, so a price cut
 * shows in the shortlist the same hour it lands in the feed instead of being
 * frozen at whatever it was the day the home was added. A listing that has
 * left the feed comes back flagged `gone` rather than silently dropped:
 * "the home you shortlisted sold" is information, not noise.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { getListing, type Listing } from "./listingsStore.js";

function resolveDbPath(): string {
  if (existsSync("/data")) return "/data/favorites.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "favorites.db");
}

let db: Database.Database | null = null;

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS lead_favorites (
      lead_id TEXT NOT NULL,
      listing_key TEXT NOT NULL,
      note TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
      PRIMARY KEY (lead_id, listing_key)
    );
    CREATE INDEX IF NOT EXISTS idx_fav_lead ON lead_favorites(lead_id, position);
  `);
}

export function getFavoritesDb(): Database.Database {
  if (db) return db;
  db = new Database(resolveDbPath());
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

export interface FavoriteEntry {
  listingKey: string;
  note: string | null;
  addedAt: string;
  position: number;
  /** Live listing facts; null when the listing has left the feed. */
  listing: Listing | null;
  gone: boolean;
}

export function addFavorite(leadId: string, listingKey: string, note?: string): { added: boolean; count: number } {
  const database = getFavoritesDb();
  const max = (database
    .prepare(`SELECT COALESCE(MAX(position), -1) m FROM lead_favorites WHERE lead_id = ?`)
    .get(leadId) as { m: number }).m;
  const r = database
    .prepare(`INSERT OR IGNORE INTO lead_favorites (lead_id, listing_key, note, position, added_at) VALUES (?, ?, ?, ?, ?)`)
    .run(leadId, listingKey, note ?? null, max + 1, new Date().toISOString());
  return { added: r.changes > 0, count: countFavorites(leadId) };
}

export function removeFavorite(leadId: string, listingKey: string): { removed: boolean; count: number } {
  const r = getFavoritesDb()
    .prepare(`DELETE FROM lead_favorites WHERE lead_id = ? AND listing_key = ?`)
    .run(leadId, listingKey);
  return { removed: r.changes > 0, count: countFavorites(leadId) };
}

export function countFavorites(leadId: string): number {
  return (getFavoritesDb()
    .prepare(`SELECT COUNT(*) c FROM lead_favorites WHERE lead_id = ?`)
    .get(leadId) as { c: number }).c;
}

export function listFavorites(leadId: string): FavoriteEntry[] {
  const rows = getFavoritesDb()
    .prepare(`SELECT listing_key, note, position, added_at FROM lead_favorites WHERE lead_id = ? ORDER BY position`)
    .all(leadId) as Array<{ listing_key: string; note: string | null; position: number; added_at: string }>;
  return rows.map((r) => {
    const found = getListing(r.listing_key);
    const listing = found ? (({ raw, ...rest }) => rest)(found) as Listing : null;
    return {
      listingKey: r.listing_key,
      note: r.note,
      addedAt: r.added_at,
      position: r.position,
      listing,
      gone: !listing,
    };
  });
}

/**
 * Favourite counts for every lead at once, with the average asking price of
 * what they saved. The average is over the favourites still IN the feed — a
 * home that has left the market has no current price, and averaging it in as a
 * zero would drag a buyer's apparent price point down for no reason.
 */
export function favoriteSummaryByLead(): Map<string, { favorites: number; avgFavPrice: number | null }> {
  const rows = getFavoritesDb()
    .prepare(`SELECT lead_id, listing_key FROM lead_favorites`)
    .all() as Array<{ lead_id: string; listing_key: string }>;
  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    const id = String(r.lead_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id)!.push(String(r.listing_key));
  }
  const out = new Map<string, { favorites: number; avgFavPrice: number | null }>();
  for (const [leadId, keys] of grouped) {
    const prices: number[] = [];
    for (const k of keys) {
      try {
        const l = getListing(k);
        const p = l && typeof (l as { listPrice?: unknown }).listPrice === "number" ? (l as { listPrice: number }).listPrice : null;
        if (p && p > 0) prices.push(p);
      } catch {
        /* the mirror being unavailable must not fail the whole summary */
      }
    }
    out.set(leadId, {
      favorites: keys.length,
      avgFavPrice: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null,
    });
  }
  return out;
}
