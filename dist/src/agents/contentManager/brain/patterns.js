"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateCombinationPatterns = updateCombinationPatterns;
exports.getTopCombinations = getTopCombinations;
exports.getWorstCombinations = getWorstCombinations;
exports.getBestHourForPillar = getBestHourForPillar;
const contentDb_js_1 = require("../../../core/contentDb.js");
const hookClassifier_js_1 = require("./hookClassifier.js");
const decay_js_1 = require("./decay.js");
function hourBucket(hour) {
    if (hour >= 6 && hour <= 11)
        return "morning";
    if (hour >= 12 && hour <= 16)
        return "afternoon";
    if (hour >= 17 && hour <= 21)
        return "evening";
    return "night";
}
function captionBucket(len) {
    if (len < 80)
        return "short";
    if (len <= 150)
        return "medium";
    return "long";
}
function updateCombinationPatterns() {
    const videos = (0, contentDb_js_1.listVideosForPatternAnalysis)();
    const groups = new Map();
    for (const v of videos) {
        if (!v.publishedAt || v.views <= 0)
            continue;
        const hookType = v.hookType || (0, hookClassifier_js_1.classifyHook)(v.hook).hookType;
        const d = new Date(v.publishedAt);
        const postingDay = d.toLocaleDateString("en-US", {
            weekday: "long",
            timeZone: "America/Chicago",
        });
        const hour = Number(new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            hour: "numeric",
            hour12: false,
        }).format(d));
        const key = `${v.pillar}|${hookType}|${postingDay}|${hourBucket(hour)}|${captionBucket(v.caption.length)}`;
        const g = groups.get(key) ?? {
            pillar: v.pillar,
            hookType,
            postingDay,
            postingHourBucket: hourBucket(hour),
            captionLengthBucket: captionBucket(v.caption.length),
            videos: [],
        };
        g.videos.push({
            views: v.views,
            publishedAt: v.publishedAt,
            above: v.views >= contentDb_js_1.CONTENT_BENCHMARK_VIEWS,
        });
        groups.set(key, g);
    }
    let upserted = 0;
    for (const g of groups.values()) {
        const avgViews = (0, decay_js_1.computeDecayWeightedAvg)(g.videos);
        const above = g.videos.filter((x) => x.above).length;
        (0, contentDb_js_1.upsertCombinationPattern)({
            pillar: g.pillar,
            hookType: g.hookType,
            postingDay: g.postingDay,
            postingHourBucket: g.postingHourBucket,
            captionLengthBucket: g.captionLengthBucket,
            sampleCount: g.videos.length,
            avgViews,
            avgEngagementRate: 0,
            aboveBenchmarkCount: above,
        });
        upserted++;
    }
    return upserted;
}
function getTopCombinations(limit = 5) {
    return (0, contentDb_js_1.listCombinationPatterns)({ minSamples: 2, limit, order: "desc" });
}
function getWorstCombinations(limit = 3) {
    return (0, contentDb_js_1.listCombinationPatterns)({ minSamples: 3, limit, order: "asc" });
}
function getBestHourForPillar(pillar) {
    const patterns = (0, contentDb_js_1.listCombinationPatterns)({ pillar, minSamples: 2, limit: 100, order: "desc" });
    if (patterns.length === 0)
        return null;
    const best = patterns[0];
    return {
        day: best.postingDay,
        hour_bucket: best.postingHourBucket,
        avg_views: best.avgViews,
    };
}
