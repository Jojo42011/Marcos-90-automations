import { knownCities } from "./listingsStore.js";

/**
 * Work out which CITY a lead is talking about.
 *
 * THE BUG THIS REPLACES. The old rule was "the words after `in`", up to four of
 * them. It ran on every inbound message, so a lead saying "I'm in the market
 * for something" had their target area recorded as **"the market for
 * something"**. Of 762 production leads, 36 had an area stored and only about
 * four of those were a place: the rest were "my own my home", "the mornings",
 * "a home and this", "the property if it", "la cantera how far". Every one of
 * those then flowed into listing search and market stats, which is why the MLS
 * wiring looked empty — the guards downstream were correctly refusing to treat
 * "the mornings" as a city.
 *
 * THE FIX IS TO CHECK AGAINST REALITY. The listings mirror holds every city the
 * board covers, so it is the authority on whether a phrase is a place. No
 * hand-maintained town list to fall out of date, and it cannot disagree with
 * what Marco can actually sell.
 *
 * TWO TIERS, ON PURPOSE:
 *
 *   1. A known MLS city anywhere in the message, any casing → the canonical
 *      name from the feed. This is the case that matters: "looking around
 *      boerne" becomes "Boerne", which searches and market stats can use.
 *
 *   2. Anything else must look like a PROPER NOUN in the lead's own typing to
 *      be kept at all. "Austin" and "Grand Rapids" survive as out-of-area
 *      signals worth having; "the mornings" does not, because nobody
 *      capitalises it. Casing is a weak signal, and it is used deliberately
 *      only here, where the alternative is storing a fragment of a sentence.
 *      Inside the service area tier 1 already caught it regardless of casing.
 *
 * Returning null is a good outcome. An empty area means the drips and the CRM
 * fall back to copy that promises nothing, which is what should happen when we
 * do not know where someone wants to live.
 */

/** Words that are never part of a city name, used to reject a candidate outright. */
const NOT_A_PLACE = new Set([
  "the", "a", "an", "my", "our", "your", "his", "her", "their", "this", "that", "these", "those",
  "for", "so", "and", "or", "but", "if", "how", "what", "when", "where", "why", "who",
  "is", "are", "was", "am", "be", "been", "do", "does", "did", "can", "could", "would", "will",
  "i", "im", "me", "we", "you", "it", "they", "he", "she",
  "market", "home", "homes", "house", "houses", "property", "properties", "area", "areas",
  "price", "prices", "range", "budget", "something", "anything", "nothing", "everything",
  "morning", "mornings", "evening", "evenings", "afternoon", "night", "nights",
  "week", "weeks", "month", "months", "year", "years", "day", "days", "time", "times",
  "bed", "beds", "bath", "baths", "sqft", "acre", "acres", "lot", "yard",
  "looking", "want", "need", "like", "love", "hoping", "thinking", "interested",
  "mind", "idea", "process", "future", "moment", "way", "case", "fact",
  /* Neighbourhood words are not cities. "Downtown" or "the north side" matches
     no `listings.city`, so storing one only produces a lead who looks like they
     told us where they want to live when they did not. */
  "downtown", "uptown", "midtown", "suburbs", "suburb", "side",
]);

/**
 * Rejected on their own, kept as part of a name.
 *
 * A bare "north" is a direction; "West Lake Hills" and "North Richland Hills"
 * are places. Blocking the word outright cost both, which is why this is
 * separate from NOT_A_PLACE rather than another entry in it.
 */
const BARE_DIRECTIONS = new Set(["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]);

function isPlacePhrase(words: string[]): boolean {
  if (!words.length || words.length > 3) return false;
  if (words.some((w) => NOT_A_PLACE.has(w.toLowerCase()))) return false;
  if (words.length === 1 && BARE_DIRECTIONS.has(words[0].toLowerCase())) return false;
  if (!words.every((w) => /^[A-Z]/.test(w))) return false;
  return words.join(" ").length >= 3;
}

/**
 * Trimmed off the front of a candidate before judging it.
 *
 * Prepositions belong here as well as determiners: the "<something> area"
 * pattern matches greedily from the left, so "in the RGV area" arrives as
 * "in the RGV" and the real name is the third word.
 */
const LEADING_TRIM = new Set([
  "the", "a", "an", "my", "our", "your", "this", "that",
  "in", "on", "at", "to", "from", "near", "around", "of", "for",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A city from the board's own coverage, matched anywhere in the message.
 *
 * Longest name first so "New Braunfels" cannot be shadowed by a shorter entry,
 * and word-bounded so "Boerne" does not match inside another word.
 */
export function matchKnownCity(text: string): string | null {
  if (!text) return null;
  for (const { city } of knownCities()) {
    const re = new RegExp(`(^|[^A-Za-z])${escapeRe(city)}([^A-Za-z]|$)`, "i");
    if (re.test(text)) return city;
  }
  return null;
}

/**
 * Tier 2: a capitalised place name we do not cover.
 *
 * Kept because "I'm looking in Austin" is a real fact worth having on the
 * record — it is the difference between a lead Marco can serve and one he
 * should refer out. It is deliberately strict: determiners are trimmed, any
 * function or non-place word disqualifies the whole phrase, and every
 * remaining word must be capitalised as the lead typed it.
 */
function properNounPlace(text: string): string | null {
  const patterns = [
    /\b(?:in|around|near|to)\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})/,
    /\b([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})\s+area\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    let words = m[1].trim().split(/\s+/);
    while (words.length && LEADING_TRIM.has(words[0].toLowerCase())) words = words.slice(1);
    /* Capitalised, or an all-caps abbreviation people actually use — "RGV". */
    if (!isPlacePhrase(words)) continue;
    return words.join(" ");
  }
  return null;
}

export function extractArea(text: string): string | null {
  if (!text || !text.trim()) return null;
  return matchKnownCity(text) ?? properNounPlace(text);
}

/**
 * Clean up an area written by the old rule, or return null if it is not a place.
 *
 * Containment, not equality, is the right test for the stored values: real rows
 * hold **"San Antonio yes"** and **"the new braunfels and"**, which carry a
 * genuine city inside a fragment of the sentence. Those normalise to the
 * canonical name rather than being thrown away. Only a value with no place in
 * it at all — "the mornings", "my own my home" — resolves to null.
 *
 * Normalising matters beyond tidiness: listing search compares the stored area
 * to `listings.city` exactly, so "San Antonio yes" finds nothing at all while
 * "San Antonio" finds 12,616 homes.
 */
export function normalizeArea(area: string | null | undefined): string | null {
  const s = (area || "").trim();
  if (!s) return null;
  const city = matchKnownCity(s);
  if (city) return city;
  let words = s.split(/\s+/);
  while (words.length && LEADING_TRIM.has(words[0].toLowerCase())) words = words.slice(1);
  if (isPlacePhrase(words)) return words.join(" ");
  /* The stored value is often a phrase, not a bare name — "the RGV area so"
     carries a real name that the whole-string test rejects because of the
     words around it. Run the same extraction used on live messages over it. */
  return properNounPlace(s);
}

/** True when a stored area holds no place at all and should be cleared. */
export function isJunkArea(area: string | null | undefined): boolean {
  const s = (area || "").trim();
  if (!s) return false;
  return normalizeArea(s) === null;
}
