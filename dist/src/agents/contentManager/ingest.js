"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestContent = ingestContent;
const contentDb_js_1 = require("../../core/contentDb.js");
function classifyPillar(type, meta) {
    const text = JSON.stringify(meta ?? {}).toLowerCase();
    if (type === "listing_url")
        return "listings";
    if (type === "video") {
        if (/\b(testimonial|win|marco|wesley|brand)\b/.test(text))
            return "brand";
        if (/\b(listing|tour|sold|listed)\b/.test(text))
            return "listings";
        return "brand";
    }
    if (type === "market_stat" || type === "calendar")
        return "education";
    return "education";
}
function resolveNextStep(type) {
    return type === "video" ? "repurpose" : "caption_generator";
}
/**
 * Creates a content_sessions record and returns session metadata for downstream chaining.
 * Does not call repurpose/caption modules directly.
 */
async function ingestContent(input) {
    const pillar = classifyPillar(input.type, input.meta);
    const nextStep = resolveNextStep(input.type);
    const rawInputPath = input.path?.trim() || input.url?.trim() || null;
    const session = (0, contentDb_js_1.createContentSession)({
        rawInputType: input.type,
        rawInputPath,
        rawInputMeta: {
            ...(input.meta ?? {}),
            pillar,
            nextStep,
            sourceUrl: input.url ?? null,
        },
        status: "processing",
    });
    console.log(`[content-manager/ingest] session ${session.id} type=${input.type} pillar=${pillar} next=${nextStep}`);
    return {
        ...session,
        pillar,
        nextStep,
    };
}
