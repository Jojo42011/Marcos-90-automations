"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = process;
/**
 * Module 05: Property Breakdown Generator — specs, features, no address/builder/neighborhood.
 */
const prompts_js_1 = require("../../../config/prompts.js");
const state_js_1 = require("../../core/state.js");
const index_js_1 = require("../../integrations/llm/index.js");
async function process(lead, conversation) {
    // v0: no MLS/MLS integrations yet. We still replicate Marco's next-step script
    // so the DM flow continues immediately after phone capture.
    if (!lead.phone) {
        return { lead, reply: null };
    }
    const prefix = "For sure,";
    const deterministic = `${prefix} for that home you inquired about, here’s the breakdown on location, specs, ` +
        `pricing, and a couple of other options in case it’s not the right fit. ` +
        `Was this what you were looking for, or something in a different price range or location?`;
    const rewritten = await (0, index_js_1.rewriteReplyWithTone)(prompts_js_1.prompts.propertyBreakdown, deterministic, conversation);
    const reply = rewritten ?? deterministic;
    return {
        lead: { ...lead, state: state_js_1.FunnelStage.PropertySent },
        reply,
    };
}
