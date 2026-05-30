"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INSTAGRAM_CANYON_LAKE_LISTING = void 0;
exports.instagramListingFactsHint = instagramListingFactsHint;
exports.instagramDmCloseGoalHint = instagramDmCloseGoalHint;
exports.isInstagramDm = isInstagramDm;
/**
 * Active Instagram ad listing context (Canyon Lake). Used by IG DM prompts and runtime hints only.
 * TikTok and legacy shared prompts are unchanged.
 */
exports.INSTAGRAM_CANYON_LAKE_LISTING = {
    label: "Canyon Lake listing",
    locationArea: "Canyon Lake, TX",
    propertyType: "single-family home",
    beds: 3,
    baths: 2,
    listPriceUsd: 365_000,
    /** Marco's own listing — price, specs, and address may be shared in Instagram DM when relevant. */
    marcoOwnListing: true,
};
/** One-line facts block for dynamic LLM hints (not a script). */
function instagramListingFactsHint() {
    const L = exports.INSTAGRAM_CANYON_LAKE_LISTING;
    return (`ACTIVE_LISTING (Instagram ad — Marco's listing): ${L.propertyType}, ${L.beds} bed / ${L.baths} bath, ` +
        `listed at $${L.listPriceUsd.toLocaleString("en-US")}, ${L.locationArea}. Marco is the listing agent; ` +
        `you may state price, beds/baths, specs, and the property address in DM when it helps the lead. ` +
        `Do not invent extra specs, HOA, lot size, or features not implied by the thread.`);
}
/** Funnel goal for Instagram DM (replaces phone-capture / SMS breakdown path). */
function instagramDmCloseGoalHint() {
    return ("INSTAGRAM_DM_GOAL: Close in this DM thread — book an in-person showing or a consultation call with Marco. " +
        "Do not ask for a phone number to text a breakdown. Do not promise SMS, end-of-day text delivery, or an off-platform packet. " +
        "Answer questions in-thread; when they are warm, offer concrete next steps (days/times for a showing, or a quick call to walk the home).");
}
function isInstagramDm(platform, channel) {
    const p = (platform ?? "").toLowerCase();
    return p.includes("insta") && channel === "dm";
}
