import { getListingsDb, searchListings, type Listing } from "./listingsStore.js";
import type { Conversation, Lead } from "./types.js";

/**
 * Work out which MLS listing a lead is actually asking about.
 *
 * THE RULE: a wrong price is worse than no price. Telling a lead a house is
 * $534,149 when it is a different house on the same street costs Marco the
 * lead and possibly the licence; saying "let me pull that up" costs nothing.
 * So this returns a CONFIDENCE, and only `exact` is allowed to be quoted as
 * "the home you asked about". Anything softer is offered as options.
 *
 * Confidence levels:
 *   `exact`   — an MLS number, or a street number AND street name that resolve
 *               to exactly one listing. Safe to quote as theirs.
 *   `none`    — nothing identifiable. Show comparables instead, and never imply
 *               they are the property the lead mentioned.
 *
 * There is deliberately no "probably" tier. A middle confidence would only ever
 * be used the same way as one of the two ends, and having it would invite
 * quoting a guess.
 */

export type MatchConfidence = "exact" | "none";

export interface ListingMatch {
  confidence: MatchConfidence;
  listing: Listing | null;
  /** Why it matched, for the job log and for debugging a wrong answer later. */
  reason: string;
}

/** Text the lead has actually given us, newest first — recent mentions win. */
function leadText(lead: Lead, conversation: Conversation): string[] {
  const parts: string[] = [];
  if (lead.propertyInquired?.trim()) parts.push(lead.propertyInquired.trim());
  const inbound = (conversation.messages || []).filter((m) => m.role === "user");
  for (const m of inbound.slice(-8).reverse()) parts.push(m.text);
  return parts;
}

/**
 * An MLS number is the one unambiguous handle a lead can give us.
 *
 * Requires 6+ digits: SABOR numbers are 7, and matching on shorter runs would
 * turn a price ("365k"), a zip or a house number into a listing lookup.
 */
function mlsNumbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(\d{6,9})\b/g)) out.push(m[1]);
  return out;
}

const STREET_WORD =
  /\b(\d{1,6})\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3})\b/g;

export function matchListingForLead(lead: Lead, conversation: Conversation): ListingMatch {
  const texts = leadText(lead, conversation);
  const db = getListingsDb();

  for (const text of texts) {
    /* 1. An explicit MLS number. */
    for (const n of mlsNumbersIn(text)) {
      const row = db
        .prepare(`SELECT * FROM listings WHERE mls_number = ? OR listing_key = ? LIMIT 2`)
        .all(n, n) as Record<string, unknown>[];
      if (row.length === 1) {
        const found = searchListings({ q: n, limit: 1 });
        if (found.listings[0]) {
          return { confidence: "exact", listing: found.listings[0], reason: `MLS number ${n}` };
        }
      }
    }

    /* 2. A street number plus street name. Only accepted when it resolves to
       exactly ONE listing — "9923 Rockcress" is safe, "Rockcress Rd" alone
       matches a whole street of new builds and is not. */
    for (const m of text.matchAll(STREET_WORD)) {
      const number = m[1];
      const name = m[2].trim();
      if (name.length < 3) continue;
      const rows = db
        .prepare(
          `SELECT listing_key FROM listings
           WHERE street LIKE ? AND street LIKE ?
           LIMIT 3`,
        )
        .all(`${number} %`, `%${name}%`) as { listing_key: string }[];
      if (rows.length === 1) {
        const found = searchListings({ q: `${number} ${name}`, limit: 2 });
        const one = found.listings.find((l) => l.listingKey === rows[0].listing_key);
        if (one) {
          return { confidence: "exact", listing: one, reason: `address "${number} ${name}"` };
        }
      }
    }
  }

  return { confidence: "none", listing: null, reason: "no MLS number or unique address in what the lead said" };
}

/**
 * Real listings to offer this lead.
 *
 * Anchored on the matched property when there is one (same city, price within
 * ±25%), otherwise on whatever the lead told us they wanted. Falls back to
 * nothing rather than to a random selection: a list of homes unrelated to
 * anything the lead said is noise that reads as automated.
 */
export function comparablesFor(
  lead: Lead,
  anchor: Listing | null,
  limit = 3,
): Listing[] {
  const city = anchor?.city || lead.criteria?.area || null;
  const price = anchor?.listPrice ?? lead.criteria?.priceCap ?? null;
  const beds = anchor?.beds ?? lead.criteria?.beds ?? null;

  /* Without a city or a price there is no meaningful "similar", and guessing
     produces a list the lead did not ask for. */
  if (!city && !price) return [];

  const res = searchListings({
    city: city || undefined,
    status: "Active",
    minPrice: price ? Math.round(price * 0.75) : undefined,
    maxPrice: price ? Math.round(price * 1.25) : undefined,
    minBeds: beds || undefined,
    limit: limit + 4,
  });

  return res.listings
    .filter((l) => !anchor || l.listingKey !== anchor.listingKey)
    .slice(0, limit);
}

/** "$534,149" — the only price format that should ever reach a lead. */
export function money(n: number | null | undefined): string {
  if (n == null) return "price on request";
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** "4 bed / 3 bath, 2,296 sqft", skipping anything the feed did not give us. */
export function specLine(l: Listing): string {
  const bits: string[] = [];
  if (l.beds != null) bits.push(`${l.beds} bed`);
  if (l.baths != null) bits.push(`${l.baths} bath`);
  const head = bits.join(" / ");
  const area = l.livingArea ? `${Math.round(l.livingArea).toLocaleString("en-US")} sqft` : null;
  return [head, area].filter(Boolean).join(", ");
}
