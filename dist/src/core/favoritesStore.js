"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFavoritesDb = getFavoritesDb;
exports.addFavorite = addFavorite;
exports.removeFavorite = removeFavorite;
exports.countFavorites = countFavorites;
exports.listFavorites = listFavorites;
exports.favoriteSummaryByLead = favoriteSummaryByLead;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const listingsStore_js_1 = require("./listingsStore.js");
function resolveDbPath() {
    if ((0, fs_1.existsSync)("/data"))
        return "/data/favorites.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "favorites.db");
}
let db = null;
function initSchema(database) {
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
function getFavoritesDb() {
    if (db)
        return db;
    db = new better_sqlite3_1.default(resolveDbPath());
    db.pragma("journal_mode = WAL");
    initSchema(db);
    return db;
}
function addFavorite(leadId, listingKey, note) {
    const database = getFavoritesDb();
    const max = database
        .prepare(`SELECT COALESCE(MAX(position), -1) m FROM lead_favorites WHERE lead_id = ?`)
        .get(leadId).m;
    const r = database
        .prepare(`INSERT OR IGNORE INTO lead_favorites (lead_id, listing_key, note, position, added_at) VALUES (?, ?, ?, ?, ?)`)
        .run(leadId, listingKey, note ?? null, max + 1, new Date().toISOString());
    return { added: r.changes > 0, count: countFavorites(leadId) };
}
function removeFavorite(leadId, listingKey) {
    const r = getFavoritesDb()
        .prepare(`DELETE FROM lead_favorites WHERE lead_id = ? AND listing_key = ?`)
        .run(leadId, listingKey);
    return { removed: r.changes > 0, count: countFavorites(leadId) };
}
function countFavorites(leadId) {
    return getFavoritesDb()
        .prepare(`SELECT COUNT(*) c FROM lead_favorites WHERE lead_id = ?`)
        .get(leadId).c;
}
function listFavorites(leadId) {
    const rows = getFavoritesDb()
        .prepare(`SELECT listing_key, note, position, added_at FROM lead_favorites WHERE lead_id = ? ORDER BY position`)
        .all(leadId);
    return rows.map((r) => {
        const found = (0, listingsStore_js_1.getListing)(r.listing_key);
        const listing = found ? (({ raw, ...rest }) => rest)(found) : null;
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
function favoriteSummaryByLead() {
    const rows = getFavoritesDb()
        .prepare(`SELECT lead_id, listing_key FROM lead_favorites`)
        .all();
    const grouped = new Map();
    for (const r of rows) {
        const id = String(r.lead_id);
        if (!grouped.has(id))
            grouped.set(id, []);
        grouped.get(id).push(String(r.listing_key));
    }
    const out = new Map();
    for (const [leadId, keys] of grouped) {
        const prices = [];
        for (const k of keys) {
            try {
                const l = (0, listingsStore_js_1.getListing)(k);
                const p = l && typeof l.listPrice === "number" ? l.listPrice : null;
                if (p && p > 0)
                    prices.push(p);
            }
            catch {
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
