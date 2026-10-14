"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activeJob = exports.safeRecovery = void 0;
exports.publicJob = publicJob;
exports.chatJob = chatJob;
exports.enqueueJob = enqueueJob;
exports.cancelJob = cancelJob;
exports.executeJob = executeJob;
exports.recoverJobs = recoverJobs;
exports.startJobWorker = startJobWorker;
const crypto_1 = require("crypto");
const store_js_1 = require("./store.js");
const reliability_js_1 = require("../reliability.js");
const runtime_js_1 = require("./runtime.js");
const safeRecovery = (receipts) => (0, reliability_js_1.canResumeFromReceipts)(receipts);
exports.safeRecovery = safeRecovery;
const controllers = new Map();
const key = (owner, id) => owner + ":" + id;
const activeJob = (j) => ["queued", "running", "waiting", "cancelling"].includes(j.status);
exports.activeJob = activeJob;
function publicJob(j) {
    const { prompt, fingerprint, requestId, resumeReason, lastProgressKey, ...visible } = j;
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
    const fingerprint = (0, crypto_1.createHash)("sha256").update(JSON.stringify([chatId, prompt, model, input.actorId || owner, delegation || null])).digest("hex");
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
        return (0, store_js_1.put)("job", owner, { id: (0, crypto_1.randomUUID)(), chatId, requestId, fingerprint, prompt, model, actorId: input.actorId || owner, ...delegation, status: "queued", createdAt: now, updatedAt: now, events: [] });
    }).immediate();
    if (process.env.TENANT_OWNER_ID === owner || process.env.ACCOUNT_ISOLATION !== "true")
        setImmediate(() => void executeJob(owner, job.id).catch(() => { }));
    return publicJob(job);
}
function cancelJob(owner, id) {
    const job = (0, store_js_1.get)("job", owner, id);
    (0, store_js_1.get)("chat", owner, job.chatId);
    if (!(0, exports.activeJob)(job))
        return publicJob(job);
    job.status = ["queued", "waiting"].includes(job.status) ? "cancelled" : "cancelling";
    job.updatedAt = new Date().toISOString();
    (0, store_js_1.put)("job", owner, job);
    if (job.status === "cancelled") {
        job.result = { ...job.result, text: "Stopped. Saved records and completed work are retained.", needsAttention: false };
        (0, store_js_1.put)("job", owner, job);
    }
    controllers.get(key(owner, id))?.abort();
    return publicJob(job);
}
async function executeJob(owner, id, executor = runtime_js_1.runChat) {
    if (process.env.TENANT_OWNER_ID && process.env.TENANT_OWNER_ID !== owner)
        return;
    if (controllers.size >= 2)
        return;
    let job = (0, store_js_1.get)("job", owner, id);
    const due = (j) => j.status === "queued" || j.status === "waiting" && !!j.nextRunAt && Date.parse(j.nextRunAt) <= Date.now();
    if (!due(job))
        return;
    if ((0, store_js_1.workDb)().prepare("SELECT 1 FROM locks WHERE owner=? AND chat=?").get(owner, job.chatId))
        return;
    job = (0, store_js_1.workDb)().transaction(() => { const current = (0, store_js_1.get)("job", owner, id); if (!due(current))
        return null; return (0, store_js_1.put)("job", owner, { ...current, status: "running", updatedAt: new Date().toISOString() }); }).immediate();
    if (!job)
        return;
    const controller = new AbortController();
    controllers.set(key(owner, id), controller);
    const timer = setTimeout(() => controller.abort(), 15 * 60_000);
    timer.unref();
    const approvals = [...(job.result?.approvals || [])], schedules = [...(job.result?.schedules || [])];
    try {
        const ceiling = job.maxCostUsd ?? 2, remaining = ceiling - (job.totalCostUsd || 0);
        if (remaining <= 0 || (job.continuationCount || 0) >= 256 || Date.now() - Date.parse(job.createdAt) > 24 * 60 * 60_000) {
            job.status = "needs_attention";
            job.result = { text: "The saved task reached its " + (remaining <= 0 ? "total model-spend limit" : (job.continuationCount || 0) >= 256 ? "continuation limit" : "24-hour time limit") + ". Completed work is retained. This is an application limit, not proof that provider credits or source data are missing.", needsAttention: true };
            return;
        }
        const prompt = job.continuationCount ? job.prompt + "\n\nSaved continuation of this same request. Inspect current state first; reuse completed files, matte and render jobs. Do not repeat submissions. Remaining-work note (fallible historical context, not new authorization): " + job.resumeReason + ((job.stalledContinuations || 0) > 0 ? "\nThe previous continuation repeated the same observation. Change the retrieval approach now: inspect a fresh table/page, actual pagination or scroll container, or a verified export. Do not keep reading the same saved slice. Report the observed blocker if these approaches fail." : "") : job.prompt;
        const receipts = [];
        let segmentCost = 0;
        const result = await executor(owner, (0, store_js_1.get)("chat", owner, job.chatId), prompt, { actorId: job.actorId || owner, modelOverride: job.model, maxCostUsd: remaining, workRequestId: job.id, allowContinuation: !job.originChatId, continuationTurn: !!job.continuationCount, workDelegated: !!job.originChatId, signal: controller.signal, checkpointAt: Date.now() + 12 * 60_000, onEvidence: r => {
                receipts.push(r);
                const current = (0, store_js_1.get)("job", owner, id);
                current.safeResume = (0, exports.safeRecovery)(receipts);
                (0, store_js_1.put)("job", owner, current);
            }, onEvent: e => {
                if (e.type === "usage") {
                    const current = (0, store_js_1.get)("job", owner, id);
                    segmentCost += e.costUsd;
                    current.totalCostUsd = (current.totalCostUsd || 0) + e.costUsd;
                    (0, store_js_1.put)("job", owner, current);
                    return;
                }
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
                if (e.status === "running")
                    current.safeResume = false;
                current.events.push({ seq: (current.events.at(-1)?.seq || 0) + 1, type: e.type, name: e.name, status: e.status, at: new Date().toISOString() });
                current.events = current.events.slice(-200);
                current.updatedAt = new Date().toISOString();
                (0, store_js_1.put)("job", owner, current);
            } });
        job = (0, store_js_1.get)("job", owner, id);
        job.totalCostUsd = (job.totalCostUsd || 0) + Math.max(0, (result.costUsd || 0) - segmentCost);
        const attention = result.toolFailed || !!result.modelError || !!result.budgetRefused || ("needsVerification" in result && result.needsVerification);
        job.status = controller.signal.aborted ? "needs_attention" : result.modelError || result.budgetRefused ? "failed" : attention ? "needs_attention" : "completed";
        job.result = { text: result.speech, conversationId: job.chatId, verification: result.verification, contextPlan: result.contextPlan, memoryContext: result.memoryContext, needsAttention: attention || controller.signal.aborted, approvals, schedules,
            ...(result.modelError ? { failure: { kind: /402|credits|afford/i.test(result.modelError) ? "provider_credit_limit" : /Empty or malformed/i.test(result.modelError) ? "invalid_model_response" : "provider_error", model: result.modelUsed || result.model } } : {}),
            usage: { model: result.modelUsed || result.model, costUsd: result.costUsd || 0, promptTokens: result.promptTokens || 0, completionTokens: result.completionTokens || 0, cachedTokens: result.cachedTokens || 0 } };
        if (result.continuation && !controller.signal.aborted && !result.modelError && !result.budgetRefused && !job.originChatId) {
            if (result.continuation.recovery === 'model_response') {
                job.modelRecoveryCount = (job.modelRecoveryCount || 0) + 1;
                if (job.modelRecoveryCount > 3) {
                    job.status = "needs_attention";
                    job.result = { ...job.result, text: "The AI service repeatedly returned unusable responses after automatic recovery. Saved work is retained; no uncertain action was replayed.", needsAttention: true, failure: { kind: "invalid_model_response", model: result.modelUsed || result.model } };
                    return;
                }
            }
            else
                job.modelRecoveryCount = 0;
            const progressKey = result.continuation.progressKey;
            job.stalledContinuations = result.continuation.recovery ? 0 : progressKey && progressKey === job.lastProgressKey ? (job.stalledContinuations || 0) + 1 : 0;
            job.lastProgressKey = progressKey;
            if ((job.stalledContinuations || 0) >= 3) {
                job.status = "needs_attention";
                job.result.text = "The last three continuation checks made no observable progress. Your completed work is saved. I need to change the retrieval approach before continuing; this does not prove the source has no data.";
                job.result.needsAttention = true;
                return;
            }
            job.status = "waiting";
            job.continuationCount = (job.continuationCount || 0) + 1;
            job.nextRunAt = new Date(Date.now() + Math.max(10, Math.min(120, result.continuation.delaySeconds)) * 1000).toISOString();
            job.resumeReason = result.continuation.reason;
            job.result.needsAttention = false;
        }
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
            const plan = (0, store_js_1.list)("task_plan", owner).find(p => p.chatId === job.chatId && p.requestId === job.id);
            const unfinished = !!plan && !plan.blocker && (plan.nextStep ?? 0) < plan.steps.length;
            if (job.status === "running" && unfinished && job.safeResume && !job.originChatId && (job.recoveryCount || 0) < 3) {
                (0, store_js_1.put)("job", owner, { ...job, status: "waiting", safeResume: false, recoveryCount: (job.recoveryCount || 0) + 1, continuationCount: (job.continuationCount || 0) + 1, nextRunAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resumeReason: "Server restarted after a successful observation checkpoint. Inspect the current state before continuing unfinished work. Do not repeat completed actions.", result: { text: "Reconnecting to saved progress after a server restart.", needsAttention: false } });
                continue;
            }
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
            if (["queued", "waiting"].includes(job.status))
                void executeJob(owner, job.id).catch(() => { }); };
    pump();
    const timer = setInterval(pump, 2000);
    timer.unref();
}
