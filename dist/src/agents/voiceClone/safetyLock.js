"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkScriptSafety = checkScriptSafety;
exports.requiresApproval = requiresApproval;
const voiceCloneStore_js_1 = require("../../core/voiceCloneStore.js");
/**
 * The ONLY way a script gets to VoxCPM is if:
 * 1. It was submitted via the dashboard (human-submitted)
 * 2. Marco or an authorized user explicitly approved it (approval_status = 'approved')
 * 3. It passes content checks
 */
function checkScriptSafety(script, requestId, requestedBy) {
    if (!script || script.trim().length < 5) {
        const reason = "Script too short or empty";
        (0, voiceCloneStore_js_1.logSafetyBlock)(requestId, script, reason, requestedBy);
        return { allowed: false, reason };
    }
    const impersonationPatterns = [
        /\bI am (?!Marco\b)/i,
        /\bThis is (?!Marco\b)/i,
        /\bmy name is (?!Marco\b)/i,
    ];
    for (const pattern of impersonationPatterns) {
        if (pattern.test(script)) {
            const reason = "Script may contain impersonation of another person";
            (0, voiceCloneStore_js_1.logSafetyBlock)(requestId, script, reason, requestedBy);
            return { allowed: false, reason };
        }
    }
    const illegalPatterns = [
        /guaranteed? (returns?|profits?|income)/i,
        /you will (make|earn|profit)/i,
        /100% (guaranteed?|certain|sure)/i,
    ];
    for (const pattern of illegalPatterns) {
        if (pattern.test(script)) {
            const reason = "Script contains potentially illegal financial guarantee language";
            (0, voiceCloneStore_js_1.logSafetyBlock)(requestId, script, reason, requestedBy);
            return { allowed: false, reason };
        }
    }
    if (script.length > 5000) {
        const reason = "Script exceeds maximum allowed length (5000 chars)";
        (0, voiceCloneStore_js_1.logSafetyBlock)(requestId, script, reason, requestedBy);
        return { allowed: false, reason };
    }
    return { allowed: true };
}
function requiresApproval(approvalStatus) {
    return approvalStatus !== "approved";
}
