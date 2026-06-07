"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeToolResult = normalizeToolResult;
exports.buildDailyPlanData = buildDailyPlanData;
exports.inferPanelFromMessage = inferPanelFromMessage;
exports.panelResultToUi = panelResultToUi;
function normalizeToolResult(toolName, result) {
    const r = result;
    switch (toolName) {
        case "daily_plan":
            return {
                panel: "daily_plan",
                data: {
                    date: r.date,
                    dayOfWeek: r.dayOfWeek,
                    videos: r.targets?.videos ?? 7,
                    calls: r.targets?.calls ?? 725,
                    description: r.targets?.description ?? "",
                    banked: r.goalStatus?.banked ?? 5956520,
                    gap: r.goalStatus?.gap ?? 14043480,
                    percentComplete: r.goalStatus?.percentComplete ?? 29.8,
                    deadline: r.goalStatus?.deadline ?? "Nov 30, 2026",
                    daysRemaining: r.goalStatus?.daysRemaining ?? 0,
                    needleMovers: r.needleMovers ?? [],
                    motivation: r.motivation ?? "",
                },
            };
        case "market_intel":
            return {
                panel: "market_intel",
                data: {
                    mortgageRate: r.mortgageRate ?? "--",
                    mortgageRateChange: r.mortgageRateChange ?? "",
                    fedRate: r.fedRate ?? "--",
                    fedNote: r.fedNote ?? "",
                    inflation: r.inflation ?? "--",
                    inflationNote: r.inflationNote ?? "",
                    nationalInventory: r.nationalInventory ?? "--",
                    medianHomePrice: r.medianHomePrice ?? "--",
                    marketTrend: r.marketTrend ?? "",
                    sanAntonioNote: r.sanAntonioNote ?? "",
                    weeklyInsight: r.weeklyInsight ?? "",
                    lastUpdated: r.lastUpdated ?? new Date().toISOString(),
                },
            };
        case "world_intel":
            return {
                panel: "world_intel",
                data: {
                    events: Array.isArray(r.events) ? r.events : [],
                    economicSummary: r.economicSummary ?? "",
                    realEstateImpact: r.realEstateImpact ?? "",
                    lastUpdated: r.lastUpdated ?? new Date().toISOString(),
                },
            };
        case "metrics":
            return {
                panel: "metrics",
                data: r,
            };
        default:
            return null;
    }
}
function buildDailyPlanData() {
    const now = new Date();
    const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });
    const dateStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const daysRemaining = Math.ceil((new Date("2026-11-30").getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return {
        date: dateStr,
        dayOfWeek,
        videos: 7,
        calls: 725,
        description: "Non-negotiable daily minimums for $20M by Nov 30",
        banked: 5956520,
        gap: 14043480,
        percentComplete: 29.8,
        deadline: "Nov 30, 2026",
        daysRemaining,
        needleMovers: [
            "7 videos posted today keeps the TikTok engine alive",
            "725 calls = 22 contacts at current rate = pipeline building",
            "Every video above 7 compounds — 10.3/week hits monthly closing pace",
            "Every 6,734 calls = 1 seller closing = $425K avg deal",
        ],
        motivation: `${dayOfWeek}. $14M gap. ${daysRemaining} days left. The only thing that moves the needle today is reps — videos and calls. Everything else is noise.`,
    };
}
/** Server-side panel routing from user message keywords. */
function inferPanelFromMessage(message) {
    const t = message.toLowerCase().trim();
    if (!t)
        return null;
    if (t.includes("daily") || t.includes("game plan") || t.includes("today") ||
        t.includes("what should i") || t.includes("plan for") || t.includes("focus") ||
        t.includes("needle") || t.includes("targets") || t.includes("goals today")) {
        return { panel: "daily_plan", data: buildDailyPlanData() };
    }
    if (t.includes("world") || t.includes("political") || t.includes("legislation") ||
        t.includes("geopolit") || t.includes("policy") || t.includes("global") ||
        (t.includes("news") && !t.includes("tiktok"))) {
        return { panel: "world_intel", data: { fetch: true } };
    }
    if (t.includes("market") || t.includes("mortgage") || t.includes("interest rate") ||
        t.includes("housing") || t.includes("economy") || t.includes("fed") ||
        t.includes("inflation") || t.includes("rates") || t.includes("inventory")) {
        return { panel: "market_intel", data: { fetch: true } };
    }
    if (t.includes("tiktok") || t.includes("tik tok") || t.includes("video") ||
        t.includes("views") || t.includes("content") || t.includes("watch time")) {
        return { panel: "tiktok", data: { fetch: true } };
    }
    if (t.includes("mojo") || t.includes("cold call") || t.includes("dialer") ||
        t.includes("prospecting")) {
        return { panel: "mojo", data: { fetch: true } };
    }
    if (t.includes("20m") || t.includes("$20") || t.includes("goal") ||
        t.includes("banked") || t.includes("gap") || t.includes("november") ||
        t.includes("pace") || t.includes("closing") || t.includes("deal")) {
        return { panel: "goal", data: { fetch: true } };
    }
    if (t.includes("number") || t.includes("metric") || t.includes("stat") ||
        t.includes("funnel") || t.includes("performance") || t.includes("show me")) {
        return { panel: "metrics", data: { fetch: true } };
    }
    return null;
}
function panelResultToUi(result) {
    if (!result)
        return null;
    return {
        panel: result.panel,
        action: "open",
        data: (result.data && typeof result.data === "object"
            ? result.data
            : {}),
    };
}
