"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = process;
const brivity_js_1 = require("../../integrations/brivity.js");
async function process(lead, _conversation) {
    try {
        await (0, brivity_js_1.syncLead)(lead);
    }
    catch (error) {
        // Never break DM pipeline on CRM sync failure.
        console.error("[Module08] Brivity sync failed:", error);
    }
    return { lead, reply: null };
}
