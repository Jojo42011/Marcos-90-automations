"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BudgetRefusedError = exports.toolUsesFromOpenAi = exports.fromOpenAiMessages = exports.toOpenAiTools = exports.toOpenAiMessages = exports.MODEL_JOBS = exports.routingTable = exports.resolveModel = exports.classifyChatTurn = exports.checkBudget = exports.budgetFor = exports.estimateTokens = exports.planContext = exports.toAnthropicId = exports.toSlug = exports.refreshCatalog = exports.getModelInfo = exports.getCatalog = exports.cheapestModel = exports.availableModels = exports.redactSecrets = exports.ModelLayerError = void 0;
exports.complete = complete;
exports.providerStatus = providerStatus;
exports.listModelsForUi = listModelsForUi;
exports.describeModel = describeModel;
/**
 * The model layer's front door. Everything outside `src/hull/providers/`
 * should import from HERE and from nowhere else in this folder.
 *
 * One call, `complete()`, runs the whole pipeline:
 *
 *   resolve the model  → which model for this job, with fallbacks
 *   plan the context   → trim and compact history to a pre-rot budget
 *   check the budget   → refuse, degrade, or proceed
 *   call the provider  → OpenRouter first, direct Anthropic as the backstop
 *   fall forward       → next model in the chain if one is down or parked
 *   record usage       → ALWAYS, success or failure
 *
 * WHY USAGE IS RECORDED ON FAILURES TOO. A failed call still costs latency,
 * often still costs money, and is the only evidence of an outage after the
 * fact. A row with `ok = 0` and the provider's error text is what turns "Harvey
 * was weird this afternoon" into "the 402 started at 14:05".
 *
 * NOTHING HERE LEAKS A KEY. Provider errors are wrapped in `ModelLayerError`,
 * which redacts anything key-shaped out of the message and the body before it
 * can reach SQLite, a log line or the browser.
 */
const aiUsageStore_js_1 = require("../../core/aiUsageStore.js");
const anthropicDirect_js_1 = require("./anthropicDirect.js");
const budget_js_1 = require("./budget.js");
const catalog_js_1 = require("./catalog.js");
const contextBudget_js_1 = require("./contextBudget.js");
const internal_js_1 = require("./internal.js");
const openrouter_js_1 = require("./openrouter.js");
const routing_js_1 = require("./routing.js");
__exportStar(require("./types.js"), exports);
var internal_js_2 = require("./internal.js");
Object.defineProperty(exports, "ModelLayerError", { enumerable: true, get: function () { return internal_js_2.ModelLayerError; } });
Object.defineProperty(exports, "redactSecrets", { enumerable: true, get: function () { return internal_js_2.redactSecrets; } });
var catalog_js_2 = require("./catalog.js");
Object.defineProperty(exports, "availableModels", { enumerable: true, get: function () { return catalog_js_2.availableModels; } });
Object.defineProperty(exports, "cheapestModel", { enumerable: true, get: function () { return catalog_js_2.cheapestModel; } });
Object.defineProperty(exports, "getCatalog", { enumerable: true, get: function () { return catalog_js_2.getCatalog; } });
Object.defineProperty(exports, "getModelInfo", { enumerable: true, get: function () { return catalog_js_2.getModelInfo; } });
Object.defineProperty(exports, "refreshCatalog", { enumerable: true, get: function () { return catalog_js_2.refreshCatalog; } });
Object.defineProperty(exports, "toSlug", { enumerable: true, get: function () { return catalog_js_2.toSlug; } });
Object.defineProperty(exports, "toAnthropicId", { enumerable: true, get: function () { return catalog_js_2.toAnthropicId; } });
var contextBudget_js_2 = require("./contextBudget.js");
Object.defineProperty(exports, "planContext", { enumerable: true, get: function () { return contextBudget_js_2.planContext; } });
Object.defineProperty(exports, "estimateTokens", { enumerable: true, get: function () { return contextBudget_js_2.estimateTokens; } });
Object.defineProperty(exports, "budgetFor", { enumerable: true, get: function () { return contextBudget_js_2.budgetFor; } });
var budget_js_2 = require("./budget.js");
Object.defineProperty(exports, "checkBudget", { enumerable: true, get: function () { return budget_js_2.checkBudget; } });
var routing_js_2 = require("./routing.js");
Object.defineProperty(exports, "classifyChatTurn", { enumerable: true, get: function () { return routing_js_2.classifyChatTurn; } });
Object.defineProperty(exports, "resolveModel", { enumerable: true, get: function () { return routing_js_2.resolveModel; } });
Object.defineProperty(exports, "routingTable", { enumerable: true, get: function () { return routing_js_2.routingTable; } });
Object.defineProperty(exports, "MODEL_JOBS", { enumerable: true, get: function () { return routing_js_2.MODEL_JOBS; } });
var translate_js_1 = require("./translate.js");
Object.defineProperty(exports, "toOpenAiMessages", { enumerable: true, get: function () { return translate_js_1.toOpenAiMessages; } });
Object.defineProperty(exports, "toOpenAiTools", { enumerable: true, get: function () { return translate_js_1.toOpenAiTools; } });
Object.defineProperty(exports, "fromOpenAiMessages", { enumerable: true, get: function () { return translate_js_1.fromOpenAiMessages; } });
Object.defineProperty(exports, "toolUsesFromOpenAi", { enumerable: true, get: function () { return translate_js_1.toolUsesFromOpenAi; } });
/** Raised when the spend gate refuses. Carries the verdict the UI should show. */
class BudgetRefusedError extends internal_js_1.ModelLayerError {
    verdict;
    constructor(verdict) {
        super("budget", verdict.reason || "AI spend cap reached");
        this.name = "BudgetRefusedError";
        this.verdict = verdict;
    }
}
exports.BudgetRefusedError = BudgetRefusedError;
/** Output reservations by job. A classifier does not need 8k tokens of room. */
const MAX_TOKENS_BY_JOB = {
    chat_fast: 1024,
    chat_deep: 8192,
    agent: 8192,
    summarize: 2048,
    extract: 2048,
    classify: 512,
    vision: 2048,
    schedule: 512,
};
function defaultMaxTokens(job) {
    return MAX_TOKENS_BY_JOB[job] ?? 4096;
}
function providerChainFor(model) {
    const chain = [];
    if ((0, openrouter_js_1.openRouterConfigured)())
        chain.push("openrouter");
    /* Direct Anthropic can only serve Anthropic models, but for those it is a
       genuinely independent path — a different key, a different network route —
       which is exactly what a fallback should be. */
    if ((0, anthropicDirect_js_1.anthropicConfigured)() && (0, catalog_js_1.toSlug)(model).startsWith("anthropic/"))
        chain.push("anthropic");
    return chain;
}
async function callProvider(provider, req) {
    return provider === "openrouter" ? (0, openrouter_js_1.callOpenRouter)(req) : (0, anthropicDirect_js_1.callAnthropic)(req);
}
function usageRow(base, res, err) {
    return {
        provider: base.provider,
        model: base.model,
        job: base.job,
        promptTokens: res.promptTokens ?? 0,
        completionTokens: res.completionTokens ?? 0,
        cachedTokens: res.cachedTokens ?? 0,
        costUsd: res.costUsd ?? 0,
        costEstimated: res.costEstimated ?? true,
        latencyMs: base.latencyMs,
        ok: !err,
        error: err,
        sessionId: base.sessionId,
        modelUsed: res.modelUsed ?? base.model,
    };
}
/**
 * Run one completion.
 *
 * Throws `BudgetRefusedError` when the spend gate says no and
 * `ModelLayerError` when every candidate model failed. Both are typed, both
 * carry an operator-readable message, and neither can contain a key.
 */
async function complete(req) {
    const job = req.job || "chat_deep";
    const maxTokens = req.maxTokens && req.maxTokens > 0 ? req.maxTokens : defaultMaxTokens(job);
    let resolved = (0, routing_js_1.resolveModel)(job, { modelOverride: req.modelOverride });
    let planned = (0, contextBudget_js_1.planContext)({
        job,
        model: resolved.model,
        system: req.system,
        messages: req.messages || [],
        tools: req.tools,
        maxTokens,
    });
    const verdict = (0, budget_js_1.checkBudget)({
        job,
        model: resolved.model,
        estimatedInputTokens: planned.plan.estimatedTokens,
        maxTokens,
        maxCostUsd: req.maxCostUsd,
    });
    if (!verdict.allowed) {
        /* Record the refusal. A turn that never reached a provider still belongs
           in the log — otherwise "Harvey stopped answering at 4pm" has no row. */
        (0, aiUsageStore_js_1.recordUsage)(usageRow({ provider: resolved.provider, model: resolved.model, job, sessionId: req.sessionId, latencyMs: 0 }, { costUsd: 0, costEstimated: true }, `budget refused: ${verdict.reason || "cap reached"}`));
        throw new BudgetRefusedError(verdict);
    }
    if (verdict.degradeToCheap) {
        const cheap = (0, routing_js_1.resolveModel)(job, { forceCheap: true });
        if (cheap.model !== resolved.model) {
            resolved = cheap;
            planned = (0, contextBudget_js_1.planContext)({
                job,
                model: resolved.model,
                system: req.system,
                messages: req.messages || [],
                tools: req.tools,
                maxTokens,
            });
        }
    }
    /* Candidate order: the resolved primary, then its fallbacks. Models the
       breaker has parked are skipped — unless that would leave nothing, in
       which case trying a parked model beats refusing to answer at all. */
    const all = [resolved.model, ...resolved.fallbacks].filter((m, i, a) => m && a.indexOf(m) === i);
    const live = all.filter((m) => !safeBool(() => (0, aiUsageStore_js_1.isModelPaused)(m)));
    const candidates = live.length ? live : all.slice(0, 1);
    let lastError = null;
    for (let i = 0; i < candidates.length; i++) {
        const model = candidates[i];
        const providers = providerChainFor(model);
        if (!providers.length) {
            lastError = new internal_js_1.ModelLayerError("no_key", `No API key configured that can reach ${model}. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY.`, { model });
            continue;
        }
        /* AN EXPLICIT PICK IS HONOURED OR IT FAILS. It is never quietly swapped.
         *
         * Handing OpenRouter a `models` chain lets it fail over server-side, which
         * is one round trip instead of two and is right when Harvey chose the model.
         * It is wrong when the OPERATOR chose it: OpenRouter then treats the chain
         * as permission to run something else, and the only signal is a different
         * name in the usage footer. That is how a picker set to GPT-5.1 spent an
         * afternoon answering on Mercury — a free-tier key caps prompt tokens per
         * request, the 14k tool preamble exceeded it for every mid-tier model, and
         * the cheapest entry in the chain was the only one allowed.
         *
         * So an explicit pick sends no chain. If it cannot run, the real error
         * surfaces (including the 402 that says to add credits) instead of a silent
         * downgrade nobody asked for. */
        const explicitPick = resolved.source === "explicit";
        const providerRequest = {
            model,
            fallbacks: explicitPick ? [] : candidates.slice(i + 1),
            system: req.system,
            messages: planned.messages,
            tools: req.tools,
            maxTokens,
            temperature: req.temperature,
            onToken: req.onToken,
            maxCostUsd: req.maxCostUsd,
        };
        for (const provider of providers) {
            const startedAt = Date.now();
            try {
                const res = await callProvider(provider, providerRequest);
                const latencyMs = Date.now() - startedAt;
                const usage = usageRow({ provider, model, job, sessionId: req.sessionId, latencyMs }, res);
                (0, aiUsageStore_js_1.recordUsage)(usage);
                safeVoid(() => (0, aiUsageStore_js_1.noteSuccess)(model));
                const ran = res.modelUsed || model;
                return {
                    text: res.text,
                    toolUses: res.toolUses,
                    stopReason: res.stopReason,
                    usage,
                    modelUsed: ran,
                    contextPlan: planned.plan,
                    budget: verdict,
                    resolved,
                    substituted: ran !== model ? { asked: model, ran } : undefined,
                };
            }
            catch (err) {
                const latencyMs = Date.now() - startedAt;
                const wrapped = err instanceof internal_js_1.ModelLayerError
                    ? err
                    : new internal_js_1.ModelLayerError("network", err instanceof Error ? err.message : String(err), {
                        provider,
                        model,
                    });
                lastError = wrapped;
                /* Same rule for our own loop: an explicit pick that fails is reported,
                   not replaced. Trying the next candidate here would reintroduce the
                   silent downgrade one layer down. */
                if (resolved.source === "explicit") {
                    (0, aiUsageStore_js_1.recordUsage)(usageRow({ provider, model, job, sessionId: req.sessionId, latencyMs }, { costUsd: 0, costEstimated: true }, wrapped.summary));
                    safeVoid(() => (0, aiUsageStore_js_1.noteFailure)(model, wrapped.summary));
                    throw wrapped;
                }
                (0, aiUsageStore_js_1.recordUsage)(usageRow({ provider, model, job, sessionId: req.sessionId, latencyMs }, { costUsd: 0, costEstimated: true }, wrapped.summary));
                safeVoid(() => (0, aiUsageStore_js_1.noteFailure)(model, wrapped.summary));
                console.error(`[models] ${provider} ${model} failed: ${wrapped.summary}`);
            }
        }
    }
    throw new internal_js_1.ModelLayerError("all_failed", `Every model for this request failed. Last error: ${lastError?.summary || "unknown"}`, { model: resolved.model, status: lastError?.status });
}
/** Which keys exist, and therefore who actually runs the tokens. */
function providerStatus() {
    const { openrouter, anthropic } = (0, catalog_js_1.configuredProviders)();
    return {
        openrouter,
        anthropic,
        primary: openrouter ? "openrouter" : anthropic ? "anthropic" : null,
        catalogLive: (0, catalog_js_1.catalogIsLive)(),
    };
}
/**
 * The model picker's data. Kicks a live pricing refresh in the background —
 * this endpoint can afford to be a few hundred ms stale, a chat turn cannot,
 * which is why the refresh lives here and not in `complete()`.
 */
function listModelsForUi() {
    (0, catalog_js_1.refreshCatalogInBackground)();
    return { models: (0, catalog_js_1.availableModels)(), routing: (0, routing_js_1.routingTable)(), provider: providerStatus() };
}
/** Everything the models endpoint needs about one model, resolved. */
function describeModel(model) {
    return (0, catalog_js_1.getModelInfo)(model);
}
function safeBool(fn) {
    try {
        return fn();
    }
    catch {
        return false;
    }
}
function safeVoid(fn) {
    try {
        fn();
    }
    catch {
        /* Breaker bookkeeping is best-effort; it must not mask a real answer. */
    }
}
