"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkBudget = checkBudget;
exports.estimateCallCostUsd = estimateCallCostUsd;
/**
 * The spend gate, checked BEFORE the network call.
 *
 * A request that has been made is money that has been spent; there is no
 * refund path and no way to un-send it. So every dollar decision happens here,
 * on numbers read from `/data/ai-usage.db`, and the only enforcement mechanism
 * is refusing to call.
 *
 * THREE DIALS, THREE BEHAVIOURS:
 *   · Over the daily or monthly cap → refuse, with a sentence an operator can
 *     read on a card in the chat. Not a stack trace, not a 500.
 *   · Within 80% of either cap → keep working but DEGRADE: cheap-eligible jobs
 *     drop to the cheapest model instead of failing. Harvey getting dumber near
 *     the cap is a far better failure than Harvey going silent.
 *   · A single call whose pre-flight estimate exceeds the per-call ceiling →
 *     refuse, and say the number. This is the runaway-loop guard: one enormous
 *     context or a 100k-token completion cannot quietly eat the day's budget.
 *
 * The estimate uses the catalog's prices, so it is approximate on purpose —
 * the RECORDED cost is whatever the provider reports. An estimate is the only
 * number available before the call, which is the only time it matters.
 */
const aiUsageStore_js_1 = require("../../core/aiUsageStore.js");
const catalog_js_1 = require("./catalog.js");
/** Fraction of a cap at which cheap-eligible jobs start degrading. */
const DEGRADE_AT = 0.8;
/**
 * Jobs that may be silently downgraded to the cheapest model.
 *
 * `agent` is excluded: a long autonomous tool run that switches to a weaker
 * model halfway does not fail, it produces confidently wrong work nobody is
 * watching. Better it refuses and says why.
 */
const DEGRADABLE = ["chat_fast", "chat_deep", "classify", "summarize", "extract", "schedule", "vision"];
const usd = (n) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
function checkBudget(input) {
    const caps = safe(() => (0, aiUsageStore_js_1.getCaps)(), {
        dailyCapUsd: 10,
        monthlyCapUsd: 150,
        maxCostPerCallUsd: 0.5,
    });
    const spentTodayUsd = safe(() => (0, aiUsageStore_js_1.spentToday)(), 0);
    const spentMonthUsd = safe(() => (0, aiUsageStore_js_1.spentThisMonth)(), 0);
    const base = {
        allowed: true,
        spentTodayUsd,
        spentMonthUsd,
        dailyCapUsd: caps.dailyCapUsd,
        monthlyCapUsd: caps.monthlyCapUsd,
    };
    const maxTokens = Math.max(0, Math.round(input.maxTokens ?? 1024));
    const estimate = (0, catalog_js_1.estimateCostUsd)(input.model, Math.max(0, input.estimatedInputTokens || 0), maxTokens);
    const perCallCeiling = Math.min(caps.maxCostPerCallUsd, input.maxCostUsd && input.maxCostUsd > 0 ? input.maxCostUsd : Number.POSITIVE_INFINITY);
    if (caps.monthlyCapUsd > 0 && spentMonthUsd >= caps.monthlyCapUsd) {
        return {
            ...base,
            allowed: false,
            reason: `Monthly AI cap reached — ${usd(spentMonthUsd)} of ${usd(caps.monthlyCapUsd)} spent this month. Raise the cap in Settings to keep going.`,
        };
    }
    if (caps.dailyCapUsd > 0 && spentTodayUsd >= caps.dailyCapUsd) {
        return {
            ...base,
            allowed: false,
            reason: `Daily AI cap reached — ${usd(spentTodayUsd)} of ${usd(caps.dailyCapUsd)} spent today. It resets at midnight, or raise the cap in Settings.`,
        };
    }
    if (Number.isFinite(perCallCeiling) && estimate > perCallCeiling) {
        return {
            ...base,
            allowed: false,
            reason: `This one call is estimated at ${usd(estimate)}, over the ${usd(perCallCeiling)} per-call ceiling. Shorten the request or raise HARVEY_MAX_COST_PER_CALL_USD.`,
        };
    }
    if (caps.dailyCapUsd > 0 && spentTodayUsd + estimate > caps.dailyCapUsd) {
        return {
            ...base,
            allowed: false,
            reason: `This call (est. ${usd(estimate)}) would take today past the ${usd(caps.dailyCapUsd)} daily cap — ${usd(spentTodayUsd)} is already spent.`,
        };
    }
    const dayUsed = caps.dailyCapUsd > 0 ? spentTodayUsd / caps.dailyCapUsd : 0;
    const monthUsed = caps.monthlyCapUsd > 0 ? spentMonthUsd / caps.monthlyCapUsd : 0;
    if (Math.max(dayUsed, monthUsed) >= DEGRADE_AT && DEGRADABLE.includes(input.job)) {
        return {
            ...base,
            degradeToCheap: true,
            reason: `Past ${Math.round(DEGRADE_AT * 100)}% of the spend cap (${usd(spentTodayUsd)} today, ${usd(spentMonthUsd)} this month) — running this on the cheapest model.`,
        };
    }
    return base;
}
/** Pre-flight cost estimate on its own, for the UI and for logging. */
function estimateCallCostUsd(model, inputTokens, maxTokens) {
    return (0, catalog_js_1.estimateCostUsd)(model, inputTokens, maxTokens);
}
function safe(fn, fallback) {
    try {
        return fn();
    }
    catch {
        /* The gate must never be the thing that breaks a turn. An unreadable store
           falls back to the conservative defaults rather than to "allow". */
        return fallback;
    }
}
