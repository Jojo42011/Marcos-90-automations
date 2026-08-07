/**
 * Resolve the listing a ManyChat automation says the lead messaged about.
 *
 * Until now the DM agent had no idea WHICH home a lead was asking about. Every
 * thread opened blind, which is why the funnel leaned so hard on "would it help
 * if I sent the entire breakdown" — it is the only honest thing you can offer
 * when you cannot name the house. ManyChat, meanwhile, already knows: the flow
 * fires from a specific post or video. Passing that through removes a whole
 * round trip and lets Marco answer specifics in the first reply.
 *
 * Two deliberate constraints:
 *
 * 1. **We only trust a value the MLS mirror confirms.** A `listing_id` typed
 *    into a ManyChat field by hand is as likely to be stale, a typo, or a
 *    Zillow id as it is to be real. An unresolved ref is logged and dropped,
 *    never stored — a wrong listing link is worse than none, because the drips,
 *    the matcher and the property PDF all key off it and would confidently send
 *    a lead the wrong house.
 *
 * 2. **We never overwrite a link that already exists.** `mlsListingKey` is
 *    documented as "only ever written on an exact match", and Marco or Carlos
 *    can set it by hand from the CRM. A later inbound naming a different post
 *    is real information, but silently retargeting a lead someone deliberately
 *    linked is not our call to make. The conflict is logged so it is visible.
 */
import { getListing } from "../core/listingsStore.js";

export interface ListingRefResolution {
  /** "none" when the automation sent nothing — the overwhelmingly common case. */
  outcome: "none" | "resolved" | "unresolved" | "already_linked" | "conflict";
  /** Set only on "resolved": the canonical listingKey to store on the lead. */
  listingKey?: string;
  /** Human-readable address for logs and prompt context. */
  address?: string;
  /** What the automation actually sent, for the log line. */
  ref?: string;
}

/**
 * `getListing` accepts a listingKey OR an MLS number, which is exactly the
 * ambiguity a ManyChat custom field produces — whoever built the flow may have
 * pasted either one, and both are legitimate.
 */
export function resolveInboundListingRef(
  ref: string | null | undefined,
  existingKey: string | null | undefined,
): ListingRefResolution {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return { outcome: "none" };

  const found = getListing(trimmed);
  if (!found) return { outcome: "unresolved", ref: trimmed };

  const address = [found.street, found.city].filter(Boolean).join(", ") || found.listingKey;

  if (existingKey) {
    return existingKey === found.listingKey
      ? { outcome: "already_linked", listingKey: found.listingKey, address, ref: trimmed }
      : { outcome: "conflict", listingKey: found.listingKey, address, ref: trimmed };
  }
  return { outcome: "resolved", listingKey: found.listingKey, address, ref: trimmed };
}
