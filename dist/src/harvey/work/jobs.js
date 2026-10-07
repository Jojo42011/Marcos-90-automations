"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activeJob = void 0;
exports.publicJob = publicJob;
exports.chatJob = chatJob;
exports.enqueueJob = enqueueJob;
exports.cancelJob = cancelJob;
exports.executeJob = executeJob;
exports.recoverJobs = recoverJobs;
exports.startJobWorker = startJobWorker;
const crypto_1 = require("crypto");
const store_js_1 = require("./store.js");
const runtime_js_1 = require("./runtime.js");
const controllers = new Map();
const key = (owner, id) => owner + ":" + id;
const activeJob = (j) => ["queued", "running", "cancelling"].includes(j.status);
exports.activeJob = activeJob;
function publicJob(j) {
    const { prompt, fingerprint, requestId, ...visible } = j;
    return visible;
}
function chatJob(owner, chatId) {
    (0, store_js_1.get)("chat", owner, chatId);
    return (0, store_js_1.list)("job", owner).find(j => j.chatId === chatId && (0, exports.activeJob)(j));
}
function enqueueJob(owner, chatId, input, delegation) {
    const chat = (0, store_js_1.get)("chat", owner, chatId);
    const requestId = (0, store_js_1.text)(input.requestId, "Request ID", 100), prompt = (0, store_js_1.text)(input.message, "Message", 50000);
    const model = (0, store_js_1.text)(input.model === undefined ? chat.model || "auto" : input.model, "Model", 150);
    const fingerprint = (0, crypto_1.createHash)("sha256").update(JSON.stringify([chatId, prompt, model, delegation || null])).digest("hex");
    const job = (0, store_js_1.workDb)().transaction(() => {
        const existing = (0, store_js_1.list)("job", owner).find(j => j.requestId === requestId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw new Error("Request ID already belongs to different input");
            return existing;
        }
        if (chatJob(owner, chatId) || (0, store_js_1.workDb)().prepare("SELECT 1 FROM locks WHERE owner=? AND chat=?").get(owner, chatId))
            throw new Error("This chat already has a run in progress");
        const now = new Date().toISOString();
        return (0, store_js_1.put)("job", owner, { id: (0, crypto_1.randomUUID)(), chatId, requestId, fingerprint, prompt, model, ...delegation, status: "queued", createdAt: now, updatedAt: now, events: [] });
    })();
    setImmediate(() => void executeJob(owner, job.id).catch(() => { }));
    return publicJob(job);
}
function cancelJob(owner, id) {
    const job = (0, store_js_1.get)("job", owner, id);
    (0, store_js_1.get)("chat", owner, job.chatId);
    if (!(0, exports.activeJob)(job))
        return publicJob(job);
    job.status = job.status === "queued" ? "cancelled" : "cancelling";
    job.updatedAt = new Date().toISOString();
    (0, store_js_1.put)("job", owner, job);
    controllers.get(key(owner, id))?.abort();
    return publicJob(job);
}
async function executeJob(owner, id, executor = runtime_js_1.runChat) {
    if (process.env.TENANT_OWNER_ID && process.env.TENANT_OWNER_ID !== owner)
        return;
    if (controllers.size >= 2)
        return;
    let job = (0, store_js_1.get)("job", owner, id);
    if (job.status !== "queued")
        return;
    if ((0, store_js_1.workDb)().prepare("SELECT 1 FROM locks WHERE owner=? AND chat=?").get(owner, job.chatId))
        return;
    job = (0, store_js_1.workDb)().transaction(() => { const current = (0, store_js_1.get)("job", owner, id); if (current.status !== "queued")
        return null; return (0, store_js_1.put)("job", owner, { ...current, status: "running", updatedAt: new Date().toISOString() }); })();
    if (!job)
        return;
    const controller = new AbortController();
    controllers.set(key(owner, id), controller);
    const timer = setTimeout(() => controller.abort(), 15 * 60_000);
    timer.unref();
    const approvals = [], schedules = [];
    try {
        const result = await executor(owner, (0, store_js_1.get)("chat", owner, job.chatId), job.prompt, { modelOverride: job.model, maxCostUsd: job.maxCostUsd, workDelegated: !!job.originChatId, signal: controller.signal, onEvent: e => {
                // Persist progress without tool arguments, passwords or raw response data.
                if (e.type === "approval") {
                    approvals.push(e.approval);
                    return;
                }
                if (e.type === "schedule") {
                    schedules.push(e.schedule);
                    return;
                }
                if (e.type !== "tool")
                    return;
                const current = (0, store_js_1.get)("job", owner, id);
                current.events.push({ seq: (current.events.at(-1)?.seq || 0) + 1, type: e.type, name: e.name, status: e.status, at: new Date().toISOString() });
                current.events = current.events.slice(-200);
                current.updatedAt = new Date().toISOString();
                (0, store_js_1.put)("job", owner, current);
            } });
        job = (0, store_js_1.get)("job", owner, id);
        const attention = result.toolFailed || !!result.modelError || !!result.budgetRefused || ("needsVerification" in result && result.needsVerification);
        job.status = controller.signal.aborted ? "needs_attention" : result.modelError || result.budgetRefused ? "failed" : attention ? "needs_attention" : "completed";
        job.result = { text: result.speech, conversationId: job.chatId, verification: result.verification, contextPlan: result.contextPlan, memoryContext: result.memoryContext, needsAttention: attention || controller.signal.aborted, approvals, schedules,
            usage: { model: result.modelUsed || result.model, costUsd: result.costUsd || 0, promptTokens: result.promptTokens || 0, completionTokens: result.completionTokens || 0, cachedTokens: result.cachedTokens || 0 } };
    }
    catch {
        job = (0, store_js_1.get)("job", owner, id);
        job.status = "needs_attention";
        job.result = { text: controller.signal.aborted ? "Stopped. Inspect any action already in progress before retrying." : "The task was interrupted. Review saved chat and verification checkpoints before retrying; no automatic replay was performed.", needsAttention: true };
    }
    finally {
        clearTimeout(timer);
        controllers.delete(key(owner, id));
        job.updatedAt = new Date().toISOString();
        (0, store_js_1.put)("job", owner, job);
    }
}
function recoverJobs() {
    for (const owner of (0, store_js_1.owners)("job"))
        for (const job of (0, store_js_1.list)("job", owner)) {
            if (process.env.TENANT_OWNER_ID && process.env.TENANT_OWNER_ID !== owner)
                continue;
            if (["running", "cancelling"].includes(job.status))
                (0, store_js_1.put)("job", owner, { ...job, status: "needs_attention", updatedAt: new Date().toISOString(), result: { text: "Server restarted during this task. Inspect completed actions before retrying. The task was not replayed.", needsAttention: true } });
        }
}
let started = false;
function startJobWorker() {
    if (started)
        return;
    started = true;
    recoverJobs();
    const pump = () => { for (const owner of (0, store_js_1.owners)("job"))
        for (const job of (0, store_js_1.list)("job", owner))
            if (job.status === "queued")
                void executeJob(owner, job.id).catch(() => { }); };
    pump();
    const timer = setInterval(pump, 2000);
    timer.unref();
}
