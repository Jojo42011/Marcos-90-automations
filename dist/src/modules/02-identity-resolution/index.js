"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = process;
async function process(lead, _conversation) {
    // For now we keep this intentionally simple: if a name is already present we
    // leave it alone; otherwise we rely on the platform username and avoid
    // forcing an extra "what's your name?" step.
    //
    // Later we can plug in the LLM with the identityResolution prompt to extract
    // names from conversation when it is clearly provided.
    return { lead, reply: null };
}
