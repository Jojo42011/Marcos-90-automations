"use strict";
/**
 * Luxury content scout — finds the $1M+ homes worth filming.
 *
 * Daily: sweep the local MLS mirror for active listings over $1M, judge the
 * new arrivals for content-worthiness, and keep a rolling shortlist of 5–7
 * for the week's content tours. Homes the operator marks filmed or dismissed
 * never resurface; homes that leave the market fall off on their own.
 *
 * JUDGMENT IS TWO-TIER, AND SAYS WHICH TIER SPOKE.
 *   - Claude reads the remarks and specs and scores 0–10 for "would this make
 *     a tour people watch" — architecture, views, water, acreage, named
 *     builders, drama. That is the real judgment.
 *   - When the API is unavailable, a keyword heuristic stands in so the
 *     pipeline never silently stops — but its rows are labeled
 *     `score_source: "heuristic"`, because a regex guessing at taste must
 *     never be dressed up as an opinion.
 *
 * Scores are cached per listing (see the store) — a home is judged once, not
 * re-billed nightly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runLuxurySweep = runLuxurySweep;
exports.getLuxuryShortlist = getLuxuryShortlist;
exports.setLuxuryStatus = setLuxuryStatus;
exports.scheduleLuxurySweep = scheduleLuxurySweep;
const listingsStore_js_1 = require("../../core/listingsStore.js");
const luxuryContentStore_js_1 = require("../../core/luxuryContentStore.js");
const index_js_1 = require("../../integrations/llm/index.js");
const MIN_PRICE = 1_000_000;
const SHORTLIST_TARGET = 7;
const SHORTLIST_FLOOR = 5;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Cap per run so a first run against ~1,000 candidates doesn't fire hundreds
 *  of model calls in one go; the daily cadence catches the tail within days. */
const MAX_SCORED_PER_RUN = 60;
const BATCH_SIZE = 10;
let running = false;
/* ── Scoring ──────────────────────────────────────────────────────────────── */
const SCORE_PROMPT = `You are picking luxury homes for short-form video tours for a San Antonio real-estate creator. Judge each listing ONLY on whether a tour of it would stop a scroll: standout architecture, views, water, acreage, striking pools/outdoor living, named custom builders, gated prestige communities, unusual features (courts, theaters, wine rooms, guest casitas), or sheer drama. Ordinary big houses score low even at high prices.

Score each 0-10. 8+ means "film this week". Reply with ONLY a JSON array, no prose:
[{"key":"<listingKey>","score":7,"reasons":"one short sentence naming the standout features"}]`;
function candidateBrief(c) {
    const specs = [
        c.listPrice ? `$${Math.round(c.listPrice).toLocaleString()}` : null,
        c.beds ? `${c.beds}bd` : null,
        c.baths ? `${c.baths}ba` : null,
        c.livingArea ? `${Math.round(c.livingArea).toLocaleString()}sqft` : null,
        c.yearBuilt ? `built ${c.yearBuilt}` : null,
        c.subdivision,
        c.city,
    ].filter(Boolean).join(" · ");
    const remarks = (c.remarks || "").replace(/\s+/g, " ").slice(0, 600);
    return `key=${c.listingKey}\n${c.street || "(no address)"} — ${specs}\nRemarks: ${remarks || "(none)"}`;
}
async function scoreWithClaude(batch) {
    const context = batch.map(candidateBrief).join("\n\n");
    const text = await (0, index_js_1.complete)(SCORE_PROMPT, context);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch)
        throw new Error("scorer returned no JSON array");
    const parsed = JSON.parse(jsonMatch[0]);
    let n = 0;
    for (const row of parsed) {
        const key = String(row.key || "").trim();
        const score = Number(row.score);
        if (!key || !Number.isFinite(score))
            continue;
        if (!batch.some((c) => c.listingKey === key))
            continue; // never trust an invented key
        (0, luxuryContentStore_js_1.setScore)(key, Math.max(0, Math.min(10, score)), String(row.reasons || "").slice(0, 300), "claude");
        n++;
    }
    return n;
}
/* The fallback taste-guesser. Deliberately conservative: it can put obviously
   feature-rich homes ahead of plain ones, and that is ALL it can do. */
const FEATURE_WORDS = [
    [/hill country view|panoramic|breathtaking view|views? of/i, 2, "views"],
    [/waterfront|lake|river frontage/i, 2.5, "water"],
    [/acre/i, 1.5, "acreage"],
    [/custom (built|home|estate)|architect/i, 1.5, "custom build"],
    [/infinity|resort-style|negative edge/i, 2, "standout pool"],
    /* Word-bounded: bare /spa/ scored "Spacious home" as having a spa. */
    [/\bpool\b|\bspa\b/i, 1, "pool"],
    [/gated|guarded|dominion/i, 1, "gated community"],
    [/casita|guest house|guest quarters/i, 1.5, "guest house"],
    [/wine (room|cellar)|theater|theatre|sport court|tennis/i, 1.5, "amenity rooms"],
    [/wall(s)? of glass|floor.to.ceiling|soaring|cantilever|modern masterpiece/i, 2, "architecture"],
];
function scoreHeuristically(c) {
    const text = `${c.remarks || ""} ${c.subdivision || ""}`;
    let score = 3; // a $1M+ home starts as "maybe"
    const hits = [];
    for (const [re, pts, label] of FEATURE_WORDS) {
        if (re.test(text)) {
            score += pts;
            hits.push(label);
        }
    }
    if ((c.livingArea || 0) > 5000) {
        score += 1;
        hits.push("scale");
    }
    (0, luxuryContentStore_js_1.setScore)(c.listingKey, Math.min(10, score), hits.length ? `keyword match: ${hits.join(", ")}` : "no standout keywords found", "heuristic");
}
/* ── Shortlist upkeep ─────────────────────────────────────────────────────── */
/** Keep the rolling list at 5–7: refill from the best-scored candidates.
 *  Never evicts on score — only filmed/dismissed/off-market open seats, so the
 *  list doesn't churn under the operator between Monday and Friday. */
function refreshShortlist() {
    const current = (0, luxuryContentStore_js_1.currentShortlist)();
    const seats = SHORTLIST_TARGET - current.length;
    if (seats > 0) {
        for (const c of (0, luxuryContentStore_js_1.topCandidates)(seats))
            (0, luxuryContentStore_js_1.setStatus)(c.listingKey, "shortlist");
    }
    const size = (0, luxuryContentStore_js_1.currentShortlist)().length;
    if (size < SHORTLIST_FLOOR) {
        console.warn(`[luxury] shortlist is at ${size} — not enough scored candidates yet`);
    }
    return size;
}
/* ── The sweep ────────────────────────────────────────────────────────────── */
async function runLuxurySweep() {
    if (running)
        return { ran: false, error: "already running" };
    running = true;
    try {
        const live = (0, listingsStore_js_1.searchListings)({ status: "Active", minPrice: MIN_PRICE, limit: 2000 });
        const rows = live.listings;
        const ingested = (0, luxuryContentStore_js_1.upsertCandidates)(rows.map((l) => ({
            listingKey: l.listingKey,
            mlsNumber: l.mlsNumber,
            street: l.street,
            city: l.city,
            listPrice: l.listPrice,
            beds: l.beds,
            baths: l.baths,
            livingArea: l.livingArea,
            yearBuilt: l.yearBuilt,
            subdivision: l.subdivision,
            photoUrl: l.photoUrl,
            remarks: l.publicRemarks,
            listedAt: l.listedAt,
        })));
        const wentOffMarket = (0, luxuryContentStore_js_1.markOffMarket)(new Set(rows.map((l) => l.listingKey)));
        let scored = 0;
        let usedClaude = false;
        let usedHeuristic = false;
        const pending = (0, luxuryContentStore_js_1.unscoredCandidates)(MAX_SCORED_PER_RUN);
        if ((0, index_js_1.isAnthropicApiKeyConfigured)()) {
            for (let i = 0; i < pending.length; i += BATCH_SIZE) {
                const batch = pending.slice(i, i + BATCH_SIZE);
                try {
                    scored += await scoreWithClaude(batch);
                    usedClaude = true;
                }
                catch (err) {
                    console.warn("[luxury] claude scoring failed, falling back to heuristic for this batch:", err instanceof Error ? err.message : err);
                    for (const c of batch)
                        scoreHeuristically(c);
                    scored += batch.length;
                    usedHeuristic = true;
                }
            }
        }
        else {
            for (const c of pending)
                scoreHeuristically(c);
            scored = pending.length;
            usedHeuristic = pending.length > 0;
        }
        const shortlistSize = refreshShortlist();
        const scoreSource = usedClaude && usedHeuristic ? "mixed" : usedClaude ? "claude" : usedHeuristic ? "heuristic" : "none";
        console.log(`[luxury] sweep: ${rows.length} live $1M+ · ${ingested} upserted · ${scored} scored (${scoreSource}) · ${wentOffMarket} off-market · shortlist ${shortlistSize}`);
        return { ran: true, candidatesSeen: rows.length, newlyIngested: ingested, scored, scoreSource, wentOffMarket, shortlistSize };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[luxury] sweep failed:", msg);
        return { ran: true, error: msg };
    }
    finally {
        running = false;
    }
}
function getLuxuryShortlist() {
    return { shortlist: (0, luxuryContentStore_js_1.currentShortlist)(), stats: (0, luxuryContentStore_js_1.luxuryStats)() };
}
function setLuxuryStatus(listingKey, status) {
    return (0, luxuryContentStore_js_1.setStatus)(listingKey, status);
}
function scheduleLuxurySweep() {
    /* A few minutes after boot (the MLS mirror sync gets first crack), then daily. */
    setTimeout(() => void runLuxurySweep(), 5 * 60_000).unref();
    setInterval(() => void runLuxurySweep(), SWEEP_INTERVAL_MS).unref();
}
