"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runScheduledFollowUp = runScheduledFollowUp;
const noReplyFollowup_js_1 = require("../../agents/emailMarketing/noReplyFollowup.js");
/** Use the existing reply-aware follow-up engine; do not start a second campaign. */
async function runScheduledFollowUp() {
    return (0, noReplyFollowup_js_1.checkNoReplyFollowups)();
}
