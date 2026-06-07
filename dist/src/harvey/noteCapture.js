"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isNoteTakingMessage = isNoteTakingMessage;
exports.tryCaptureNote = tryCaptureNote;
const harveyNotes_js_1 = require("../core/harveyNotes.js");
const TRIGGER_PATTERNS = [
    /^note\s+that\s+(.+)$/i,
    /^make\s+a\s+note[:\s]+(.+)$/i,
    /^remember\s+this[:\s]*(.+)$/i,
    /^write\s+this\s+down[:\s]*(.+)$/i,
    /^save\s+this[:\s]*(.+)$/i,
    /^note:\s*(.+)$/i,
    /^log\s+this[:\s]*(.+)$/i,
    /^add\s+to\s+notes[:\s]*(.+)$/i,
    /^don'?t\s+forget[:\s]*(.+)$/i,
];
function inferCategory(message, content) {
    const t = `${message} ${content}`.toLowerCase();
    if (/\b(meeting|appointment|sync|call with)\b/.test(t))
        return "meeting";
    if (/\b(follow[- ]?up|followup|check back|reach out)\b/.test(t))
        return "follow_up";
    if (/\b(listing|property|house|home tour|showing)\b/.test(t))
        return "listing";
    if (/\b(lead|client|buyer|seller|prospect)\b/.test(t))
        return "lead";
    if (/\b(idea|thought|concept)\b/.test(t))
        return "idea";
    return "general";
}
function extractContent(message) {
    const trimmed = message.trim();
    for (const pattern of TRIGGER_PATTERNS) {
        const m = trimmed.match(pattern);
        if (m?.[1]?.trim())
            return m[1].trim();
    }
    const lower = trimmed.toLowerCase();
    const inlineTriggers = [
        "note that ",
        "make a note ",
        "remember this ",
        "write this down ",
        "save this ",
        "log this ",
        "add to notes ",
        "don't forget ",
        "dont forget ",
    ];
    for (const trigger of inlineTriggers) {
        const idx = lower.indexOf(trigger);
        if (idx >= 0) {
            const rest = trimmed.slice(idx + trigger.length).trim();
            if (rest)
                return rest.replace(/^[:,-]\s*/, "");
        }
    }
    if (lower.startsWith("note:")) {
        return trimmed.slice(5).trim();
    }
    return null;
}
function isNoteTakingMessage(message) {
    return extractContent(message) !== null;
}
function tryCaptureNote(message, source = "text") {
    const content = extractContent(message);
    if (!content)
        return null;
    const category = inferCategory(message, content);
    const title = content.length > 60 ? content.slice(0, 57) + "..." : content;
    return (0, harveyNotes_js_1.createNote)({
        content,
        title,
        category,
        source,
    });
}
