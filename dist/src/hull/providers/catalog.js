"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toSlug = toSlug;
exports.toAnthropicId = toAnthropicId;
exports.refreshCatalog = refreshCatalog;
exports.refreshCatalogInBackground = refreshCatalogInBackground;
exports.catalogIsLive = catalogIsLive;
exports.configuredProviders = configuredProviders;
exports.modelIsReachable = modelIsReachable;
exports.getCatalog = getCatalog;
exports.getModelInfo = getModelInfo;
exports.availableModels = availableModels;
exports.blendedPrice = blendedPrice;
exports.cheapestModel = cheapestModel;
exports.estimateCostUsd = estimateCostUsd;
/**
 * Hand-maintained catalog. Context is in tokens; prices are USD per million.
 *
 * Ordering inside a tier is cheapest-first, because `cheapestModel()` and the
 * picker both read this array in order.
 */
const STATIC_CATALOG = [
    /* ── cheap: classification, summarising, extraction, pleasantries and the
       scheduled-task planner. Fast, and every one can still call a tool. ── */
    {
        id: "inception/mercury-2.5",
        label: "Mercury 2.5",
        family: "other",
        contextTokens: 260_000,
        inputPerM: 0.04,
        outputPerM: 0.15,
        supportsTools: true,
        supportsVision: false,
        tier: "cheap",
    },
    {
        id: "z-ai/glm-5.3-flash",
        label: "GLM 5.3 Flash",
        family: "zhipu",
        contextTokens: 1_310_720,
        inputPerM: 0.09,
        outputPerM: 0.3,
        supportsTools: true,
        supportsVision: true,
        tier: "cheap",
    },
    {
        id: "deepseek/deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash",
        family: "deepseek",
        contextTokens: 1_048_576,
        inputPerM: 0.15,
        outputPerM: 0.6,
        supportsTools: true,
        supportsVision: true,
        tier: "cheap",
    },
    {
        id: "qwen/qwen3.8-flash",
        label: "Qwen 3.8 Flash",
        family: "qwen",
        contextTokens: 1_000_000,
        inputPerM: 0.15,
        outputPerM: 0.47,
        supportsTools: true,
        supportsVision: true,
        tier: "cheap",
    },
    {
        /* An alias, not a pinned id: OpenRouter publishes no dated Luna build. The
           `~` is part of the id, and the tradeoff is that the price can move under
           us — which is exactly why recorded spend comes from the response body. */
        id: "~openai/gpt-luna-latest",
        label: "GPT Luna",
        family: "openai",
        contextTokens: 1_050_000,
        inputPerM: 0.2,
        outputPerM: 1.2,
        supportsTools: true,
        supportsVision: true,
        tier: "cheap",
    },
    {
        id: "minimax/minimax-m2",
        label: "MiniMax M2",
        family: "minimax",
        contextTokens: 204_800,
        inputPerM: 0.26,
        outputPerM: 1.02,
        supportsTools: true,
        supportsVision: false,
        tier: "cheap",
    },
    {
        id: "google/gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        family: "google",
        contextTokens: 1_048_576,
        inputPerM: 0.3,
        outputPerM: 2.5,
        supportsTools: true,
        supportsVision: true,
        tier: "cheap",
    },
    {
        id: "google/gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
        family: "google",
        contextTokens: 1_048_576,
        inputPerM: 0.75,
        outputPerM: 3.75,
        supportsTools: true,
        supportsVision: true,
        tier: "cheap",
    },
    {
        id: "anthropic/claude-haiku-4.5",
        label: "Claude Haiku 4.5",
        family: "anthropic",
        contextTokens: 200_000,
        inputPerM: 1.0,
        outputPerM: 5.0,
        supportsTools: true,
        supportsVision: true,
        tier: "cheap",
    },
    /* ── mid: the workhorses. Operator chat with tools, and background agents. ── */
    {
        /* Two million tokens of context at cheap-tier prices, which is the widest
           window in the catalog by a factor of two. */
        id: "x-ai/grok-4.20",
        label: "Grok 4.20",
        family: "xai",
        contextTokens: 2_000_000,
        inputPerM: 1.25,
        outputPerM: 2.5,
        supportsTools: true,
        supportsVision: true,
        tier: "mid",
    },
    {
        id: "openai/gpt-5.1",
        label: "GPT-5.1",
        family: "openai",
        contextTokens: 400_000,
        inputPerM: 1.25,
        outputPerM: 10.0,
        supportsTools: true,
        supportsVision: true,
        tier: "mid",
    },
    {
        id: "meta/muse-spark-1.3",
        label: "Muse Spark 1.3",
        family: "meta",
        contextTokens: 1_048_576,
        inputPerM: 1.25,
        outputPerM: 4.25,
        supportsTools: true,
        supportsVision: true,
        tier: "mid",
    },
    {
        id: "~openai/gpt-sol-latest",
        label: "GPT Sol",
        family: "openai",
        contextTokens: 1_050_000,
        inputPerM: 2.0,
        outputPerM: 10.0,
        supportsTools: true,
        supportsVision: true,
        tier: "mid",
    },
    {
        id: "x-ai/grok-4.6",
        label: "Grok 4.6",
        family: "xai",
        contextTokens: 500_000,
        inputPerM: 2.0,
        outputPerM: 6.0,
        supportsTools: true,
        supportsVision: true,
        tier: "mid",
    },
    {
        id: "qwen/qwen3.8-max-0902",
        label: "Qwen 3.8 Max",
        family: "qwen",
        contextTokens: 1_000_000,
        inputPerM: 2.0,
        outputPerM: 6.0,
        supportsTools: true,
        supportsVision: true,
        tier: "mid",
    },
    {
        id: "sakana/fugu-max",
        label: "Fugu Max",
        family: "other",
        contextTokens: 1_000_000,
        inputPerM: 2.0,
        outputPerM: 6.0,
        supportsTools: true,
        supportsVision: true,
        tier: "mid",
    },
    {
        /* The default for `chat_deep`, and it is the cheapest strong option here
           rather than the most expensive one, because prompt caching only applies
           explicit breakpoints on Anthropic models. Sonnet with a cached 16k
           preamble costs less per turn than a nominally cheaper model paying full
           price for that preamble every time. */
        id: "anthropic/claude-sonnet-4.6",
        label: "Claude Sonnet 4.6",
        family: "anthropic",
        contextTokens: 1_000_000,
        inputPerM: 3.0,
        outputPerM: 15.0,
        supportsTools: true,
        supportsVision: true,
        tier: "mid",
    },
    /* ── premium: only when an operator asks for it by name. Never a default. ── */
    {
        id: "anthropic/claude-opus-5",
        label: "Claude Opus 5",
        family: "anthropic",
        contextTokens: 1_000_000,
        inputPerM: 5.0,
        outputPerM: 25.0,
        supportsTools: true,
        supportsVision: true,
        tier: "premium",
    },
    {
        id: "sakana/fugu-ultra-v2",
        label: "Fugu Ultra v2",
        family: "other",
        contextTokens: 1_000_000,
        inputPerM: 5.0,
        outputPerM: 30.0,
        supportsTools: true,
        supportsVision: true,
        tier: "premium",
    },
    {
        id: "openai/gpt-6-astra",
        label: "GPT-6 Astra",
        family: "openai",
        contextTokens: 1_050_000,
        inputPerM: 10.0,
        outputPerM: 50.0,
        supportsTools: true,
        supportsVision: true,
        tier: "premium",
    },
    {
        id: "anthropic/claude-fable-5.1",
        label: "Claude Fable 5.1",
        family: "anthropic",
        contextTokens: 1_000_000,
        inputPerM: 10.0,
        outputPerM: 50.0,
        supportsTools: true,
        supportsVision: true,
        tier: "premium",
    },
];
/**
 * Bare Anthropic ids that already live in production env vars, mapped to the
 * slug form the rest of this layer speaks.
 *
 * `AETHON_MODEL=claude-sonnet-4-6` is set on the live machine today. If that
 * value stopped resolving the moment this layer landed, the deploy would
 * silently downgrade Harvey to whatever the default was, so both directions of
 * the mapping are kept.
 */
const LEGACY_TO_SLUG = {
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
    "claude-sonnet-4-5": "anthropic/claude-sonnet-4.6",
    "claude-sonnet-4-5-20250929": "anthropic/claude-sonnet-4.6",
    "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
    "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5",
    "claude-opus-4-5": "anthropic/claude-opus-5",
    "claude-opus-5": "anthropic/claude-opus-5",
};
/**
 * Slug → the id the Anthropic SDK itself accepts.
 *
 * Anthropic's own API does not know the OpenRouter slug, so the direct-provider
 * path has to translate back. Dated ids are used where production already runs
 * one, because a dated id is the only one guaranteed not to move underneath us.
 */
const SLUG_TO_ANTHROPIC = {
    "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
    "anthropic/claude-haiku-4.5": "claude-haiku-4-5-20251001",
    "anthropic/claude-opus-5": "claude-opus-5",
    "anthropic/claude-fable-5.1": "claude-fable-5-1",
};
/** Bare Anthropic id → OpenRouter slug. Returns the input when it is already a slug. */
function toSlug(modelId) {
    const id = String(modelId || "").trim();
    if (!id)
        return id;
    if (id.includes("/"))
        return id;
    if (LEGACY_TO_SLUG[id])
        return LEGACY_TO_SLUG[id];
    /* An unknown bare `claude-*` id is still an Anthropic model; guessing the
       vendor prefix beats refusing to route it. */
    if (/^claude[-.]/i.test(id))
        return `anthropic/${id}`;
    return id;
}
/** OpenRouter slug → the id Anthropic's own API accepts. */
function toAnthropicId(modelId) {
    const id = String(modelId || "").trim();
    if (SLUG_TO_ANTHROPIC[id])
        return SLUG_TO_ANTHROPIC[id];
    if (!id.startsWith("anthropic/"))
        return id;
    /* `anthropic/claude-sonnet-4.6` → `claude-sonnet-4-6`: Anthropic writes the
       version with dashes where OpenRouter writes a dot. */
    return id.slice("anthropic/".length).replace(/\./g, "-");
}
/* ────────────────────────── live refresh ────────────────────────── */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 5000;
/** Live overlay, keyed by model id. Empty until a refresh succeeds. */
let liveOverlay = new Map();
let lastRefreshAt = 0;
let inFlight = null;
/** USD-per-token string from OpenRouter → USD per million, or null if unusable. */
function perMillion(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0)
        return null;
    /* Rounded to six decimals: the multiply lands on values like
       0.19999999999999998, which is noise in a price a human reads. */
    return Math.round(n * 1_000_000 * 1e6) / 1e6;
}
/**
 * Pull pricing and context windows from OpenRouter and overlay them on the
 * curated catalog. Returns whether anything was merged; never throws.
 *
 * Only ids already in the static catalog are touched. The endpoint's job here
 * is to keep numbers honest, not to turn the picker into a 400-row list.
 */
async function refreshCatalog(opts = {}) {
    const fresh = Date.now() - lastRefreshAt < REFRESH_TTL_MS;
    if (!opts.force && fresh && liveOverlay.size > 0)
        return true;
    if (inFlight)
        return inFlight;
    inFlight = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
        try {
            const key = process.env.OPENROUTER_API_KEY?.trim();
            const res = await fetch(OPENROUTER_MODELS_URL, {
                headers: key ? { Authorization: `Bearer ${key}` } : {},
                signal: controller.signal,
            });
            if (!res.ok)
                return false;
            const body = (await res.json());
            const list = Array.isArray(body?.data) ? body.data : [];
            if (!list.length)
                return false;
            const known = new Set(STATIC_CATALOG.map((m) => m.id));
            const next = new Map();
            for (const raw of list) {
                const row = raw;
                const id = typeof row?.id === "string" ? row.id : "";
                if (!known.has(id))
                    continue;
                const patch = {};
                const ctx = Number(row?.context_length ?? row?.top_provider?.context_length);
                if (Number.isFinite(ctx) && ctx > 0)
                    patch.contextTokens = Math.round(ctx);
                const inP = perMillion(row?.pricing?.prompt);
                const outP = perMillion(row?.pricing?.completion);
                if (inP !== null)
                    patch.inputPerM = inP;
                if (outP !== null)
                    patch.outputPerM = outP;
                const modality = row?.architecture?.input_modalities;
                if (Array.isArray(modality))
                    patch.supportsVision = modality.includes("image");
                const params = row?.supported_parameters;
                if (Array.isArray(params))
                    patch.supportsTools = params.includes("tools");
                if (Object.keys(patch).length)
                    next.set(id, patch);
            }
            if (!next.size)
                return false;
            liveOverlay = next;
            lastRefreshAt = Date.now();
            return true;
        }
        catch {
            /* No key, DNS failure, timeout, HTML error page — all the same answer:
               keep the static table and say nothing. Pricing is not worth an outage. */
            return false;
        }
        finally {
            clearTimeout(timer);
            inFlight = null;
        }
    })();
    return inFlight;
}
/** Kick a refresh without waiting for it. Safe to call from a request handler. */
function refreshCatalogInBackground() {
    void refreshCatalog().catch(() => undefined);
}
/** True when live pricing has been merged in, so the UI can say which it shows. */
function catalogIsLive() {
    return liveOverlay.size > 0;
}
/* ────────────────────────── reads ────────────────────────── */
function withOverlay(entry) {
    const patch = liveOverlay.get(entry.id);
    return patch ? { ...entry, ...patch } : entry;
}
/** Which providers the configured keys can actually reach. */
function configuredProviders() {
    return {
        openrouter: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    };
}
/** True when this model can be reached with the keys that exist right now. */
function modelIsReachable(modelId) {
    const { openrouter, anthropic } = configuredProviders();
    if (openrouter)
        return true;
    return anthropic && toSlug(modelId).startsWith("anthropic/");
}
/** The catalog with live pricing merged, `available` left for `availableModels`. */
function getCatalog() {
    return STATIC_CATALOG.map((e) => ({ ...withOverlay(e), available: modelIsReachable(e.id) }));
}
/** One model, by slug or by legacy bare id. Null when it is not in the catalog. */
function getModelInfo(modelId) {
    const id = toSlug(modelId);
    const entry = STATIC_CATALOG.find((m) => m.id === id);
    if (!entry)
        return null;
    return { ...withOverlay(entry), available: modelIsReachable(id) };
}
/**
 * The catalog as the picker shows it: available models first, then by tier and
 * price. Unreachable models are still listed — the operator should be able to
 * see that Opus exists and that it needs a key, rather than wonder where it went.
 */
function availableModels() {
    const tierOrder = { cheap: 0, mid: 1, premium: 2 };
    return getCatalog().sort((a, b) => {
        if (a.available !== b.available)
            return a.available ? -1 : 1;
        if (tierOrder[a.tier] !== tierOrder[b.tier])
            return tierOrder[a.tier] - tierOrder[b.tier];
        return blendedPrice(a) - blendedPrice(b);
    });
}
/**
 * One number to sort cheapness by. Weighted 1:3 input:output because Harvey's
 * traffic is long prompts and short answers, but output is the expensive side —
 * sorting on input alone picks models that are cheap right up until they reply.
 */
function blendedPrice(m) {
    return (m.inputPerM + 3 * m.outputPerM) / 4;
}
/** The cheapest model meeting the constraints, or null when nothing qualifies. */
function cheapestModel(opts = {}) {
    const tierOrder = { cheap: 0, mid: 1, premium: 2 };
    const ceiling = tierOrder[opts.maxTier ?? "premium"];
    const exclude = new Set((opts.exclude ?? []).map(toSlug));
    const candidates = getCatalog()
        .filter((m) => (opts.reachableOnly === false ? true : m.available))
        .filter((m) => !exclude.has(m.id))
        .filter((m) => tierOrder[m.tier] <= ceiling)
        .filter((m) => (opts.needsTools ? m.supportsTools : true))
        .filter((m) => (opts.needsVision ? m.supportsVision : true))
        .sort((a, b) => blendedPrice(a) - blendedPrice(b));
    return candidates[0] ?? null;
}
/**
 * Pre-flight cost estimate in USD. Used to refuse a call before it is made;
 * the recorded cost comes from the provider whenever it reports one.
 */
function estimateCostUsd(modelId, inputTokens, outputTokens) {
    const info = getModelInfo(modelId);
    if (!info)
        return 0;
    return (inputTokens / 1e6) * info.inputPerM + (outputTokens / 1e6) * info.outputPerM;
}
