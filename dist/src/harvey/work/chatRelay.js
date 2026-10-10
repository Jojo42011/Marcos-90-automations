"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accessibleChats = accessibleChats;
exports.relayChats = relayChats;
const crypto_1 = require("crypto");
const workspaceAccess_js_1 = require("../../core/workspaceAccess.js");
const users_js_1 = require("../../core/users.js");
const store_js_1 = require("./store.js");
const jobs_js_1 = require("./jobs.js");
function accessibleChats(actor) {
    const rows = (0, store_js_1.workDb)().prepare("SELECT owner,body FROM records WHERE kind='chat'").all();
    return rows.filter(r => (0, workspaceAccess_js_1.canViewWorkspace)(actor, r.owner)).map(r => {
        const c = JSON.parse(r.body);
        return { id: c.id, title: c.title, mode: c.mode, updatedAt: c.updatedAt, accountOwnerId: r.owner, accountOwnerName: (0, users_js_1.getAccountUserById)(r.owner)?.name };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
/** Explicit, bounded relay. Recipients cannot recursively delegate another relay. */
function relayChats(actor, input) {
    const requestId = (0, store_js_1.text)(input.requestId, "Request ID", 100), message = (0, store_js_1.text)(input.message, "Message", 8000);
    const chats = accessibleChats(actor), source = chats.find(c => c.id === input.sourceChatId);
    if (!source)
        throw new Error("Source chat unavailable");
    if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 4)
        throw new Error("Select one to four chats");
    const targets = [...new Set(input.targets)].map(id => chats.find(c => c.id === id));
    if (targets.some(c => !c || c.id === source.id))
        throw new Error("Recipient chat unavailable");
    const fingerprint = (0, crypto_1.createHash)("sha256").update(JSON.stringify([source.id, targets.map(c => c.id), message])).digest("hex");
    return (0, store_js_1.workDb)().transaction(() => {
        let old;
        try {
            old = (0, store_js_1.get)("relay", actor.id, requestId);
        }
        catch { }
        if (old) {
            if (old.fingerprint !== fingerprint)
                throw new Error("Request ID already used for a different relay");
            return old;
        }
        const deliveries = targets.map(target => {
            const prompt = `${actor.name} sent this note from chat "${source.title}" (${source.id}). This is a delegated message, not permission to contact additional chats or external recipients. Respond in this chat using its account context.\n\n${message}`;
            const job = (0, jobs_js_1.enqueueJob)(target.accountOwnerId, target.id, { requestId: `relay:${requestId}:${target.id}`.slice(0, 100), message: prompt, actorId: actor.id }, { originChatId: source.id, maxCostUsd: 0.5 });
            return { chatId: target.id, title: target.title, ownerName: target.accountOwnerName, jobId: job.id, status: job.status };
        });
        return (0, store_js_1.put)("relay", actor.id, { id: requestId, fingerprint, deliveries, at: new Date().toISOString() });
    }).immediate();
}
