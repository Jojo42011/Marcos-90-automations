/**
 * Module 05: Property Breakdown Generator.
 *
 * This used to promise a breakdown and then deliver nothing: "here's the
 * breakdown on location, specs, pricing, and a couple of other options" with no
 * property data behind it, because there was no MLS integration. 101 leads
 * reached this stage and received that message. It now answers with real
 * figures from the live SABOR feed.
 *
 * TWO RULES GOVERN EVERYTHING HERE.
 *
 * 1. A WRONG PRICE IS WORSE THAN NO PRICE. Specific figures are quoted as "the
 *    home you asked about" ONLY on an exact match (an MLS number, or a street
 *    number and name resolving to exactly one listing). Otherwise real listings
 *    are offered as options, and nothing is implied about which one they meant.
 *
 * 2. THE TONE REWRITE MUST NOT TOUCH THE NUMBERS. The reply is built
 *    deterministically, then passed through Marco's tone rewriter, and the
 *    result is REJECTED if any price, bed count, size or MLS number changed. An
 *    LLM that turns $534,149 into $535,000 has invented a price for a real
 *    house and sent it to a real buyer. Sounding like Marco is worth a lot; it
 *    is not worth that.
 *
 * When the feed is unconfigured or matches nothing, it falls back to the
 * original script. The funnel keeps moving; it just stops pretending to know
 * something it does not.
 */
import { prompts } from "../../../config/prompts.js";
import type { Conversation, Lead } from "../../core/types.js";
import { FunnelStage } from "../../core/state.js";
import { rewriteReplyWithTone } from "../../integrations/llm/index.js";
import { isMlsFeedConfigured } from "../../integrations/simplyrets/index.js";
import { comparablesFor, matchListingForLead, money, specLine } from "../../core/listingMatch.js";
import type { Listing } from "../../core/listingsStore.js";

export interface ModuleResult {
  lead: Lead;
  reply: string | null;
}

/** The message that shipped before the MLS existed. Still the honest fallback. */
const GENERIC =
  "For sure, for that home you inquired about, here's the breakdown on location, specs, " +
  "pricing, and a couple of other options in case it's not the right fit. " +
  "Was this what you were looking for, or something in a different price range or location?";

/**
 * Every figure that must survive the tone rewrite untouched.
 *
 * Extracted from the deterministic text, so the check is against what we MEANT
 * to say rather than against a second reading of the listing.
 */
export function factsIn(text: string): string[] {
  const facts: string[] = [];
  for (const m of text.matchAll(/\$[\d,]+/g)) facts.push(m[0].replace(/,/g, ""));
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(bed|bath)/gi)) {
    facts.push(`${m[1]}${m[2].toLowerCase()}`);
  }
  for (const m of text.matchAll(/\b([\d,]+)\s*sqft/gi)) facts.push(`${m[1].replace(/,/g, "")}sqft`);
  for (const m of text.matchAll(/\bMLS\s*#?\s*(\d{6,9})\b/gi)) facts.push(`mls${m[1]}`);
  return facts;
}

/**
 * True when the rewrite kept every number intact.
 *
 * Counts occurrences rather than testing set membership. A reply routinely
 * mentions the same figure twice — the matched home and a comparable can both
 * be "2 bed" — and with a Set, changing ONE of them left the other to satisfy
 * the check, so an altered bed count sailed through. Found by a test that
 * mutated only the first occurrence, which is exactly what a rewriter does.
 */
export function factsSurvived(original: string, rewritten: string): boolean {
  const want = factsIn(original);
  if (!want.length) return true;
  const got = new Map<string, number>();
  for (const f of factsIn(rewritten)) got.set(f, (got.get(f) ?? 0) + 1);
  const need = new Map<string, number>();
  for (const f of want) need.set(f, (need.get(f) ?? 0) + 1);
  for (const [f, n] of need) {
    if ((got.get(f) ?? 0) < n) return false;
  }
  return true;
}

function describe(l: Listing): string {
  const spec = specLine(l);
  const where = [l.street, l.city].filter(Boolean).join(", ");
  return `${where} at ${money(l.listPrice)}${spec ? `, ${spec}` : ""}`;
}

export function buildReply(matched: Listing | null, comps: Listing[]): string | null {
  if (matched) {
    const spec = specLine(matched);
    const where = [matched.street, matched.city].filter(Boolean).join(", ");
    const lines = [`For sure. ${where} is listed at ${money(matched.listPrice)}${spec ? `, ${spec}` : ""}.`];
    if (matched.status && matched.status.toLowerCase() !== "active") {
      /* Status matters more than price on a house that is already spoken for,
         and burying it wastes the lead's time and Marco's. */
      lines.push(`Heads up, it is currently ${matched.status}.`);
    }
    if (comps.length) {
      lines.push(`A couple of others in that range: ${comps.slice(0, 2).map(describe).join("; ")}.`);
    }
    lines.push("Want me to send full details and photos on any of these?");
    return lines.join(" ");
  }

  if (comps.length) {
    return (
      "For sure. Here is what is active right now in that range: " +
      `${comps.slice(0, 3).map(describe).join("; ")}. ` +
      "Any of these close to what you are after, or should I look in a different price range or area?"
    );
  }

  return null;
}

export async function process(lead: Lead, conversation: Conversation): Promise<ModuleResult> {
  if (!lead.phone) {
    return { lead, reply: null };
  }

  let deterministic = GENERIC;
  let hasRealData = false;

  if (isMlsFeedConfigured()) {
    try {
      const match = matchListingForLead(lead, conversation);
      const matched = match.confidence === "exact" ? match.listing : null;
      const comps = comparablesFor(lead, matched, matched ? 2 : 3);
      const built = buildReply(matched, comps);
      if (built) {
        deterministic = built;
        hasRealData = true;
        console.log(
          `[PropertyBreakdown] lead ${lead.id}: ${match.confidence} match (${match.reason}), ` +
            `${comps.length} comparable(s)`,
        );
      }
    } catch (err) {
      /* A broken lookup must not break the funnel. The lead still gets a reply;
         it just falls back to the message that promises nothing specific. */
      console.error("[PropertyBreakdown] listing lookup failed:", err);
    }
  }

  const rewritten = await rewriteReplyWithTone(prompts.propertyBreakdown, deterministic, conversation);

  let reply = rewritten ?? deterministic;
  if (hasRealData && rewritten && !factsSurvived(deterministic, rewritten)) {
    /* The rewrite changed a number. Send the exact version instead: it reads a
       little flatter and every figure in it is true. */
    console.warn(
      `[PropertyBreakdown] lead ${lead.id}: tone rewrite altered a figure; sending the exact text.`,
    );
    reply = deterministic;
  }

  return {
    lead: { ...lead, state: FunnelStage.PropertySent },
    reply,
  };
}
