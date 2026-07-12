/**
 * Per-listing facts, keyed by ManyChat's "listing_id" custom field (set inside each
 * Comments Growth Tool automation — see IncomingWebhookPayload.listingId).
 *
 * ManyChat's raw webhook does not carry an ad/post ID on its own. The real mechanism is:
 * Marco creates one Comments Growth Tool automation per listing video/post, and inside that
 * automation's steps he sets a custom field (e.g. "listing_id" = "monticello-park") before the
 * External Request step that calls our webhook. That value shows up here as payload.listingId.
 *
 * Add one entry per active listing. Leave a listing out of this table (or leave listingId
 * unset in ManyChat) and the agent falls back to the safe "screenshot request" / "let me check
 * the video" bridge behavior instead of guessing — it will never invent facts for an unknown
 * listing.
 */
export interface ListingFacts {
  /** Human label for logs only, never sent verbatim unless it matches wording rules. */
  label: string;
  neighborhood: string | null;
  city: string;
  beds: number | null;
  baths: number | null;
  hasCasita: boolean;
  constructionType: "new" | "resale" | null;
  priceRangeLow: number | null;
  priceRangeHigh: number | null;
}

export const LISTINGS: Record<string, ListingFacts> = {
  // Example — replace with Marco's real listing IDs and facts:
  // "monticello-park": {
  //   label: "Monticello Park 4bd/2ba",
  //   neighborhood: "Monticello Park",
  //   city: "San Antonio",
  //   beds: 4,
  //   baths: 2,
  //   hasCasita: false,
  //   constructionType: "resale",
  //   priceRangeLow: 280000,
  //   priceRangeHigh: 320000,
  // },
};

export function getListingFacts(listingId: string | null | undefined): ListingFacts | null {
  if (!listingId) return null;
  return LISTINGS[listingId] ?? null;
}
