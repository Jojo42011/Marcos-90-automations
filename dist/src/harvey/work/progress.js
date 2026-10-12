"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readProgress = readProgress;
exports.recordProgress = recordProgress;
const store_js_1 = require("./store.js");
// Structured execution history, not model-authored instructions or authorization.
// Never retain tool arguments, page text, mailbox contents, credentials or signed URLs.
function readProgress(owner, chatId) {
    try {
        return (0, store_js_1.get)("execution_progress", owner, chatId);
    }
    catch {
        return { id: chatId, events: [] };
    }
}
function recordProgress(owner, chatId, name, input, result) {
    if (!["computer", "workspace_download", "edit_video", "inspect_video"].includes(name))
        return;
    if (name === "computer" && input.action !== "call")
        return;
    const old = readProgress(owner, chatId);
    const event = { tool: name, at: new Date().toISOString(), outcome: result?.error || result?.isError ? "failed" : "returned" };
    if (name === "computer") {
        event.action = String(input.tool || "").slice(0, 80);
        if (result?.recovery)
            event.recovery = { kind: result.recovery.kind, actionOutcome: result.recovery.actionOutcome, safeToRetry: result.recovery.safeToRetry === true };
        // A successful click is not proof a remote operation completed.
        event.note = "Inspect current page before repeating an action; use fresh targets, never historical refs.";
    }
    else if (event.outcome === "returned") {
        for (const k of ["file", "filename", "source", "size", "durationSeconds", "frames", "fps", "verified"])
            if (["string", "number", "boolean"].includes(typeof result?.[k]))
                event[k] = typeof result[k] === "string" ? result[k].slice(0, 250) : result[k];
    }
    if (result?.diagnostic?.code)
        event.failureCode = String(result.diagnostic.code).slice(0, 80);
    // Keep completed media milestones even when many browser observations follow.
    const events = [...(old.events || []), event];
    const media = events.filter((e) => e.tool !== "computer").slice(-12);
    const browser = events.filter((e) => e.tool === "computer").slice(-8);
    (0, store_js_1.put)("execution_progress", owner, { id: chatId, updatedAt: event.at, events: [...media, ...browser] });
}
