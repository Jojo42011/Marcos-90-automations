"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.failureReport = failureReport;
const store_js_1 = require("./store.js");
/** Answer diagnostic-only follow-ups from saved execution facts, not a model guess. */
function failureReport(owner, chatId, message) {
    if (!/\b(?:what|waht|why|whats|what's)\b.{0,60}\b(?:fail\w*|fial\w*|error\w*|erroo\w*|problem|wrong)\b/i.test(message) || /\b(?:fix|retry|resume|continue|try again|execute)\b/i.test(message))
        return;
    const job = (0, store_js_1.list)('job', owner).find(j => j.chatId === chatId && j.result);
    if (job?.status === 'completed')
        return;
    const checkpoint = (0, store_js_1.list)('verification', owner).find(v => v.chatId === chatId && v.receipts?.length);
    const diagnostics = (checkpoint?.receipts || []).filter((r) => r.outcome === 'failed' && r.diagnostic).map((r) => r.diagnostic);
    const failure = job?.result?.failure?.kind === 'tool_error' ? job.result.failure : [...diagnostics].reverse().find((d) => d.code !== 'repeat_refused') || diagnostics.at(-1);
    if (failure)
        return `The saved run failed at ${failure.detail}: ${failure.message}. That is the recorded tool error. The run did not establish a lazy-loading or timing cause. Saved work is retained.`;
    if (job?.result?.verification?.receipts?.some((r) => r.outcome === 'failed'))
        return 'The saved run contains failed tool calls, but that older run did not retain their error details. I cannot honestly identify their cause from the saved record; lazy loading and timing were not established.';
}
