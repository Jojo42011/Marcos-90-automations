"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const db_js_1 = require("../../core/db.js");
const brivity_js_1 = require("../../integrations/brivity.js");
/** Repair cold-call contacts using the existing phone lookup, without replaying lead automations. */
async function run() {
    const result = { synced: 0, failed: 0, skipped: 0, configured: Boolean(process.env.BRIVITY_API_KEY) };
    if (!result.configured)
        return result;
    for (const lead of await (0, db_js_1.listAllLeads)()) {
        if (lead.brivityId || !/mojo|cold.?call/i.test(`${lead.platform} ${lead.source}`))
            continue;
        if (!lead.phone) {
            result.skipped++;
            continue;
        }
        const response = await (0, brivity_js_1.syncLead)(lead);
        const id = response?.id || response?.contact?.id || response?.data?.id;
        if (!id) {
            result.failed++;
            continue;
        }
        (0, db_js_1.upsertLeadQuiet)({ ...lead, brivityId: String(id) });
        result.synced++;
    }
    return result;
}
