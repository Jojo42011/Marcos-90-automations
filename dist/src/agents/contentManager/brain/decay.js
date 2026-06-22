"use strict";
/** Decay weighting — recent performance counts more than old data. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDecayWeight = getDecayWeight;
exports.computeDecayWeightedAvg = computeDecayWeightedAvg;
exports.computeDecayWeightedEngagement = computeDecayWeightedEngagement;
exports.computePillarDecayAvgs = computePillarDecayAvgs;
function getDecayWeight(publishedAt) {
    const published = new Date(publishedAt).getTime();
    if (!Number.isFinite(published))
        return 0.1;
    const days = (Date.now() - published) / (24 * 60 * 60 * 1000);
    if (days <= 7)
        return 1.0;
    if (days <= 30)
        return 0.6;
    if (days <= 60)
        return 0.3;
    return 0.1;
}
function computeDecayWeightedAvg(videos) {
    if (videos.length === 0)
        return 0;
    let weightedSum = 0;
    let weightSum = 0;
    for (const v of videos) {
        const w = getDecayWeight(v.publishedAt);
        weightedSum += v.views * w;
        weightSum += w;
    }
    return weightSum > 0 ? weightedSum / weightSum : 0;
}
function computeDecayWeightedEngagement(videos) {
    if (videos.length === 0)
        return 0;
    let weightedSum = 0;
    let weightSum = 0;
    for (const v of videos) {
        const w = getDecayWeight(v.publishedAt);
        const views = Math.max(1, v.views);
        const rate = (v.likes + v.comments + v.shares + v.saves) / views;
        weightedSum += rate * w;
        weightSum += w;
    }
    return weightSum > 0 ? weightedSum / weightSum : 0;
}
function computePillarDecayAvgs(videos) {
    const byPillar = {};
    for (const v of videos) {
        if (!byPillar[v.pillar])
            byPillar[v.pillar] = [];
        byPillar[v.pillar].push({ views: v.views, publishedAt: v.publishedAt });
    }
    const out = { education: 0, listings: 0, brand: 0 };
    for (const [pillar, list] of Object.entries(byPillar)) {
        out[pillar] = computeDecayWeightedAvg(list);
    }
    return out;
}
