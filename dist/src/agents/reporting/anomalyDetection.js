"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectAnomalies = detectAnomalies;
const reportingStore_js_1 = require("../../core/reportingStore.js");
const ANOMALY_CHECKS = [
    {
        path: "social.followers",
        label: "Follower count",
        warningThresholdPct: 5,
        criticalThresholdPct: 15,
        direction: "down_only",
    },
    {
        path: "social.avgViewsLast7Days",
        label: "Avg video views",
        warningThresholdPct: 30,
        criticalThresholdPct: 60,
        direction: "both",
    },
    {
        path: "social.newDmLeads",
        label: "New DM leads",
        warningThresholdPct: 40,
        criticalThresholdPct: 80,
        direction: "down_only",
    },
    {
        path: "texts.sentToday",
        label: "Texts sent today",
        warningThresholdPct: 50,
        criticalThresholdPct: 90,
        direction: "down_only",
    },
    {
        path: "texts.replyRate",
        label: "Text reply rate",
        warningThresholdPct: 30,
        criticalThresholdPct: 60,
        direction: "down_only",
    },
    {
        path: "pipeline.newLeadsToday",
        label: "New leads today",
        warningThresholdPct: 50,
        criticalThresholdPct: 100,
        direction: "down_only",
    },
    {
        path: "pipeline.hotLeads",
        label: "Hot leads count",
        warningThresholdPct: 40,
        criticalThresholdPct: 80,
        direction: "down_only",
    },
    {
        path: "transactions.missedDeadlines",
        label: "Missed deadlines",
        warningThresholdPct: 0,
        criticalThresholdPct: 0,
        direction: "up_only",
    },
];
function getValueByPath(obj, path) {
    const val = path.split(".").reduce((acc, key) => {
        if (acc && typeof acc === "object" && key in acc) {
            return acc[key];
        }
        return undefined;
    }, obj);
    return typeof val === "number" && Number.isFinite(val) ? val : 0;
}
function detectAnomalies(current) {
    const historical = (0, reportingStore_js_1.getSnapshotsForAnomaly)("daily_digest", 28);
    if (historical.length < 3) {
        console.log("[AnomalyDetection] Not enough historical data yet (need 3+ days) — skipping anomaly checks");
        return [];
    }
    const anomalies = [];
    for (const check of ANOMALY_CHECKS) {
        const currentValue = getValueByPath(current, check.path);
        const historicalValues = historical
            .map((s) => getValueByPath(s.data, check.path))
            .filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
        if (historicalValues.length === 0)
            continue;
        const avg = historicalValues.reduce((s, v) => s + v, 0) / historicalValues.length;
        if (avg === 0 && check.path !== "transactions.missedDeadlines")
            continue;
        const deviation = avg === 0 ? (currentValue > 0 ? 100 : 0) : ((currentValue - avg) / avg) * 100;
        const absDeviation = Math.abs(deviation);
        const direction = deviation >= 0 ? "up" : "down";
        if (check.path === "transactions.missedDeadlines" && currentValue > 0) {
            anomalies.push({
                field: check.path,
                currentValue,
                averageValue: Math.round(avg * 10) / 10,
                deviation: Math.round(deviation),
                direction,
                severity: "critical",
                message: `${currentValue} missed deadline(s) — immediate attention required`,
            });
            continue;
        }
        const relevantDeviation = (check.direction === "down_only" && direction === "down") ||
            (check.direction === "up_only" && direction === "up") ||
            check.direction === "both";
        if (!relevantDeviation)
            continue;
        if (absDeviation >= check.criticalThresholdPct) {
            anomalies.push({
                field: check.path,
                currentValue: Math.round(currentValue * 10) / 10,
                averageValue: Math.round(avg * 10) / 10,
                deviation: Math.round(deviation),
                direction,
                severity: "critical",
                message: `${check.label} is ${Math.abs(Math.round(deviation))}% ${direction === "up" ? "above" : "below"} the 4-week average (${Math.round(avg * 10) / 10} → ${Math.round(currentValue * 10) / 10})`,
            });
        }
        else if (absDeviation >= check.warningThresholdPct) {
            anomalies.push({
                field: check.path,
                currentValue: Math.round(currentValue * 10) / 10,
                averageValue: Math.round(avg * 10) / 10,
                deviation: Math.round(deviation),
                direction,
                severity: "warning",
                message: `${check.label} is ${Math.abs(Math.round(deviation))}% ${direction === "up" ? "above" : "below"} the 4-week average`,
            });
        }
    }
    console.log("[AnomalyDetection] Found", anomalies.length, "anomalies (", anomalies.filter((a) => a.severity === "critical").length, "critical)");
    return anomalies;
}
