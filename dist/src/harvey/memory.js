"use strict";
/**
 * In-memory Harvey session memory (last N turns per sessionId).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrCreateSessionId = getOrCreateSessionId;
exports.getSessionHistory = getSessionHistory;
exports.appendSessionTurn = appendSessionTurn;
exports.historyToAnthropicMessages = historyToAnthropicMessages;
const MAX_TURNS = 6;
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
    list.push({ role, content: text, at: new Date().toISOString() });
    while (list.length > MAX_TURNS * 2) {
        list.shift();
    }
    sessions.set(sessionId, list);
}
/** Anthropic messages shape for multi-turn (user/assistant only). */
function historyToAnthropicMessages(history) {
    return history.map((t) => ({
        role: t.role,
        content: t.content,
    }));
}
