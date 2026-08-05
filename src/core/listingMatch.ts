import {
  getListing,
  getListingsDb,
  marketStats,
  searchListings,
  type Listing,
  type MarketStats,
} from "./listingsStore.js";
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
    limit: Math.max(limit * 6, 12),
  });

  return spreadAcrossStreets(
    res.listings.filter((l) => !anchor || l.listingKey !== anchor.listingKey),
    limit,
  );
}

/**
 * One home per street, then fill.
 *
 * The mirror is ordered by how recently a listing changed, and in a new-build
 * subdivision that means three consecutive doors on the same road — the first
 * shortlist this produced was 9923, 9911 and 9918 Rockcress. Technically three
 * matches; reads as a machine that only knows one street. Falls back to the
 * duplicates rather than returning a short list, because a buyer would rather
 * see three homes on one road than one home.
 */
function spreadAcrossStreets(rows: Listing[], limit: number): Listing[] {
  const seen = new Set<string>();
  const first: Listing[] = [];
  const rest: Listing[] = [];
  for (const l of rows) {
    /* Street name without the house number — "9923 Rockcress Rd" -> "rockcress rd". */
    const road = (l.street || "").toLowerCase().replace(/^\s*\d+\s*/, "").trim();
    if (road && seen.has(road)) rest.push(l);
    else {
      if (road) seen.add(road);
      first.push(l);
    }
  }
  return [...first, ...rest].slice(0, limit);
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

/**
 * The live listing for a lead, and whether it has moved since anyone looked.
 *
 * Prefers the stored `mlsListingKey` (a match we already made and were sure
 * about) over re-deriving one from free text, so a lead's property does not
 * silently change identity because the conversation grew.
 *
 * Returns the CURRENT record, so a property that has since gone Pending or
 * changed price reads as it is today rather than as it was when the lead asked.
 * That difference is the whole reason to look it up live instead of copying
 * price into the lead at capture time.
 */
export function liveListingForLead(
  lead: Lead,
  conversation?: Conversation,
): { listing: Listing | null; source: "linked" | "matched" | "none" } {
  if (lead.mlsListingKey) {
    const l = getListing(lead.mlsListingKey);
    if (l) return { listing: l, source: "linked" };
  }
  if (conversation) {
    const m = matchListingForLead(lead, conversation);
    if (m.confidence === "exact" && m.listing) return { listing: m.listing, source: "matched" };
  }
  return { listing: null, source: "none" };
}

/**
 * Active listings that fit what a lead told us they want.
 *
 * Used by the drips, where there is no conversation to match against — only
 * whatever criteria were captured. Returns EMPTY rather than a default city
 * when we know nothing: an email headed "homes you might like" containing homes
 * chosen at random is worse than not sending that email at all.
 *
 * Never includes the home they already asked about. Everywhere this is used,
 * it is captioned "a few OTHERS" and sits directly under that property — the
 * first CRM drawer built on it listed 9923 Rockcress as an alternative to
 * 9923 Rockcress.
 */
export function listingsForCriteria(lead: Lead, limit = 3): Listing[] {
  const c = lead.criteria;
  const hasSomething = Boolean(c?.area || c?.priceCap || c?.beds);
  if (!hasSomething) return [];
  const cap = c?.priceCap ?? null;
  const rows = searchListings({
    city: c?.area || undefined,
    status: "Active",
    /* A price cap is a ceiling, not a target: showing homes above it wastes
       the lead's time and reads as not having listened. */
    maxPrice: cap || undefined,
    minPrice: cap ? Math.round(cap * 0.6) : undefined,
    minBeds: c?.beds || undefined,
    /* Baths were captured on every lead and then ignored here — a client who
       asked for 3 baths was shown 2-bath homes and read it as not listening. */
    minBaths: c?.baths || undefined,
    limit: Math.max(limit * 6, 12),
  }).listings.filter((l) => l.listingKey !== lead.mlsListingKey);
  return spreadAcrossStreets(rows, limit);
}

/**
 * The market a lead actually cares about, if we can name it.
 *
 * City comes from the listing we linked them to first (a seller's own home, a
 * buyer's exact match) and only then from the area they typed. Free text like
 * "north side" or "somewhere quiet" is not a city, and `marketStats` returns
 * null for it rather than guessing — which is the behaviour we want, because
 * the alternative is quoting San Antonio numbers at someone in Boerne.
 */
export function marketForLead(lead: Lead): MarketStats | null {
  const linked = lead.mlsListingKey ? getListing(lead.mlsListingKey) : null;
  const city = linked?.city || lead.criteria?.area || null;
  if (!city) return null;
  try {
    return marketStats(city);
  } catch {
    return null;
  }
}

/**
 * One sentence of market context, or null.
 *
 * NEVER says "sold". The feed carries Active and Pending only, so every figure
 * available here is an asking price. Writing "homes near you sold for" over
 * list-price data would hand a seller a number to price against that no buyer
 * ever paid, and it is the kind of wrong that only shows up months later when
 * the house does not move.
 */
export function marketSentence(m: MarketStats | null): string | null {
  if (!m) return null;
  const bits: string[] = [`${m.active.toLocaleString("en-US")} homes are on the market in ${m.city} right now`];
  if (m.medianActivePrice) bits.push(`the median asking price is ${money(m.medianActivePrice)}`);
  if (m.pending) {
    bits.push(`${m.pending.toLocaleString("en-US")} more are already under contract`);
  }
  return bits.join(", ") + ".";
}
