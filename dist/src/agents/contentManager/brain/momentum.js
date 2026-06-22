"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateMomentumState = updateMomentumState;
exports.getMomentumStrategyAdjustment = getMomentumStrategyAdjustment;
const contentDb_js_1 = require("../../../core/contentDb.js");
function updateMomentumState() {
    const pulls = (0, contentDb_js_1.listRecentPerformancePulls)(10);
    let hotStreak = 0;
    let coldStreak = 0;
    for (const p of pulls) {
        if (p.views >= contentDb_js_1.CONTENT_BENCHMARK_VIEWS) {
            if (coldStreak > 0)
                break;
            hotStreak++;
        }
        else if (p.views > 0) {
            if (hotStreak > 0)
                break;
            coldStreak++;
        }
        else {
            break;
        }
    }
    let streakType = "neutral";
    let streakCount = 0;
    if (hotStreak >= 3) {
        streakType = "hot";
        streakCount = hotStreak;
    }
    else if (coldStreak >= 3) {
        streakType = "cold";
        streakCount = coldStreak;
    }
    const existing = (0, contentDb_js_1.getPerformanceModel)();
    const prevType = existing?.currentStreakType ?? "neutral";
    const changed = prevType !== streakType;
    const now = new Date().toISOString();
    (0, contentDb_js_1.upsertPerformanceModel)({
        hotStreakCount: hotStreak,
        coldStreakCount: coldStreak,
        currentStreakType: streakType,
        streakStartedAt: changed ? now : existing?.streakStartedAt ?? null,
    });
    return { streakType, streakCount, changed };
}
function getMomentumStrategyAdjustment(streakType, streakCount) {
    if (streakType === "hot" && streakCount >= 5) {
        return "You are on a strong hot streak. Double down on the exact format that is working. Do not change anything that is not broken. Maintain cadence above all else.";
    }
    if (streakType === "hot" && streakCount >= 3) {
        return "You have positive momentum. Continue current format mix. Slight increase in top-performing pillar allocation.";
    }
    if (streakType === "cold" && streakCount >= 5) {
        return "You are in an extended cold streak. Major format intervention needed. Recommend switching primary pillar and testing at least 2 new hook types this week. Alert Harvey.";
    }
    if (streakType === "cold" && streakCount >= 3) {
        return "You are in a cold streak. Recommend a format pivot this week. Try a different hook type and posting time than the current defaults.";
    }
    return "Performance is mixed. Continue current strategy. Focus on executing the top combination patterns.";
}
