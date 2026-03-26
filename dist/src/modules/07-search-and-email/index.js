"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = process;
const state_js_1 = require("../../core/state.js");
async function process(lead, _conversation) {
    if (!lead.email) {
        return { lead, reply: null };
    }
    const reply = "Noted, I’ll send a personalized list of matching homes to that email now. " +
        "Once you review it, just reply with what you like and I’ll line up a quick showing for you.";
    return { lead: { ...lead, state: state_js_1.FunnelStage.Closed }, reply };
}
