"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = process;
const state_js_1 = require("../../core/state.js");
const index_js_1 = require("../../integrations/gmail/index.js");
async function process(lead, _conversation) {
    if (!lead.email) {
        return { lead, reply: null };
    }
    const reply = "Noted, I’ll send a personalized list of matching homes to that email now. " +
        "Once you review it, just reply with what you like and I’ll line up a quick showing for you.";
    if ((0, index_js_1.isGmailConfigured)()) {
        const name = lead.name || lead.username || "there";
        try {
            await (0, index_js_1.sendPropertyEmail)(lead.email, "Homes matching what you're looking for — Marco Puga", `<p>Hi ${name},</p><p>Thanks for reaching out. I'm putting together a personalized list of homes that match what you described and will follow up shortly with specific options.</p><p>Marco Puga<br>San Antonio Real Estate</p>`);
        }
        catch (err) {
            console.error("[module07] Gmail send failed:", err instanceof Error ? err.message : err);
        }
    }
    return { lead: { ...lead, state: state_js_1.FunnelStage.Closed }, reply };
}
