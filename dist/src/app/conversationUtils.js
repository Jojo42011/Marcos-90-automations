"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeUserMessageText = normalizeUserMessageText;
exports.isLastUserMessageRepeated = isLastUserMessageRepeated;
exports.isShortDuplicateUserPair = isShortDuplicateUserPair;
/** Normalize for comparing lead messages (repeat taps, etc.). */
function normalizeUserMessageText(text) {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}
/**
 * True if the latest user message matches the immediately previous user message (normalized).
 */
function isLastUserMessageRepeated(conversation) {
    const userTexts = [];
    for (const m of conversation.messages) {
        if (m.role === "user") {
            userTexts.push(normalizeUserMessageText(m.text));
        }
    }
    if (userTexts.length < 2)
        return false;
    const last = userTexts[userTexts.length - 1];
    const prev = userTexts[userTexts.length - 2];
    if (!last || !prev)
        return false;
    if (last !== prev)
        return false;
    // Short duplicates like "yes"/"ok" twice — still let the funnel advance normally.
    if (last.length < 12)
        return false;
    return true;
}
/** Same short line twice (e.g. double-tap "yes") — do not treat as stuck/repeat for funnel logic. */
function isShortDuplicateUserPair(conversation) {
    const userTexts = [];
    for (const m of conversation.messages) {
        if (m.role === "user") {
            userTexts.push(normalizeUserMessageText(m.text));
        }
    }
    if (userTexts.length < 2)
        return false;
    const last = userTexts[userTexts.length - 1];
    const prev = userTexts[userTexts.length - 2];
    return last === prev && last.length < 12;
}
