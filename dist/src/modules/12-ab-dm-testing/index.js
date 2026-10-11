"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateVariants = evaluateVariants;
const db_js_1 = require("../../core/db.js");
const atomicJson_js_1 = require("../../core/atomicJson.js");
const tenantData_js_1 = require("../../core/tenantData.js");
/** Evaluate explicitly attributed variants only. Never invent attribution or change live DM wording. */
async function evaluateVariants() {
    const groups = Object.create(null);
    for (const lead of await (0, db_js_1.listAllLeads)()) {
        const variant = lead.dmVariant;
        if (typeof variant !== "string" || !variant.trim())
            continue;
        const row = groups[variant] ||= { leads: 0, captured: 0, messagesToPhone: 0 };
        row.leads++;
        if (!lead.phone || !lead.phoneCapturedAt)
            continue;
        const conversation = await (0, db_js_1.getConversation)(lead.id);
        row.captured++;
        row.messagesToPhone += conversation.messages.filter(m => m.role === "user" && m.at <= lead.phoneCapturedAt).length;
    }
    const variants = Object.entries(groups).map(([variant, g]) => ({ variant, ...g, captureRate: g.captured / g.leads, averageMessagesToPhone: g.captured ? g.messagesToPhone / g.captured : null }));
    const result = { at: new Date().toISOString(), variants, winner: null, note: "Descriptive results only. A randomized assignment policy and minimum sample size must be agreed before declaring a winner." };
    (0, atomicJson_js_1.atomicJson)((0, tenantData_js_1.dataPath)("dm-variant-results.json"), result);
    return result;
}
