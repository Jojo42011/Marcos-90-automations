"use strict";
/**
 * In-memory Harvey session memory (last N turns per sessionId).
 *
 * The window is deliberately wide (24 turns, per the conversational playbook —
 * ChatGPT-style continuity needs recent turns verbatim) but each stored turn
 * is capped at 700 chars so a pasted wall of text can't blow up every later
 * call. The CURRENT message is never trimmed — trimming applies to history
 * only, on the way in. Turns that scroll out of the window are folded into a
 * rolling per-session summary (hull/conversation.ts) off the latency path.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrCreateSessionId = getOrCreateSessionId;
exports.getSessionHistory = getSessionHistory;
exports.appendSessionTurn = appendSessionTurn;
exports.historyToAnthropicMessages = historyToAnthropicMessages;
const conversation_js_1 = require("../hull/conversation.js");
const MAX_TURNS = 24;
const MAX_TURN_CHARS = 700;
const sessions = new Map();
function getOrCreateSessionId(sessionId) {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    if (id.length >= 8 && id.length <= 128)
        return id;
    return `hs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
function getSessionHistory(sessionId) {
    return [...(sessions.get(sessionId) ?? [])];
}
function appendSessionTurn(sessionId, role, content) {
    const text = content.trim();
    if (!text)
        return;
    const list = sessions.get(sessionId) ?? [];
    list.push({
        role,
        content: text.length > MAX_TURN_CHARS ? text.slice(0, MAX_TURN_CHARS) + " […]" : text,
        at: new Date().toISOString(),
    });
    const evicted = [];
    while (list.length > MAX_TURNS * 2) {
        const turn = list.shift();
        if (turn)
            evicted.push(turn);
    }
    if (evicted.length)
        (0, conversation_js_1.noteEvictedTurns)(sessionId, evicted);
    sessions.set(sessionId, list);
}
/** Anthropic messages shape for multi-turn (user/assistant only). */
function historyToAnthropicMessages(history) {
    return history.map((t) => ({
        role: t.role,
        content: t.content,
    }));
}
