"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDailyDigest = runDailyDigest;
exports.scheduleDailyDigest = scheduleDailyDigest;
exports.deliverDigest = deliverDigest;
const collectors_js_1 = require("./collectors.js");
const anomalyDetection_js_1 = require("./anomalyDetection.js");
const reportingStore_js_1 = require("../../core/reportingStore.js");
const index_js_1 = require("../../integrations/twilio/index.js");
const centralTime_js_1 = require("./centralTime.js");
async function runDailyDigest() {
    console.log("[DailyDigest] Starting daily digest generation...");
    const startTime = Date.now();
    const social = (0, collectors_js_1.collectSocialSection)();
    const email = await (0, collectors_js_1.collectEmailSection)();
    const texts = await (0, collectors_js_1.collectTextsSection)();
    const transactions = (0, collectors_js_1.collectTransactionsSection)();
    const pipeline = await (0, collectors_js_1.collectPipelineSection)();
    const businessHealth = (0, collectors_js_1.collectBusinessHealthSection)();
    const data = {
        social,
        email,
        texts,
        transactions,
        pipeline,
        businessHealth,
    };
    const anomalies = (0, anomalyDetection_js_1.detectAnomalies)(data);
    data.businessHealth.anomalyFlag = anomalies.some((a) => a.field.startsWith("transactions") || a.field.startsWith("pipeline"));
    const snapshotDate = (0, centralTime_js_1.centralDateString)();
    const snapshotId = (0, reportingStore_js_1.saveSnapshot)({
        snapshotDate,
        snapshotType: "daily_digest",
        data,
        anomalies,
        generatedAt: new Date().toISOString(),
        deliveredSms: false,
        deliveredHarvey: false,
    });
    console.log("[DailyDigest] Generated in", Date.now() - startTime, "ms, snapshot ID:", snapshotId, "— anomalies:", anomalies.length);
    return { snapshotId, anomalyCount: anomalies.length };
}
let lastDailyDigestDate = null;
function scheduleDailyDigest() {
    const checkAndRun = () => {
        const now = new Date();
        const dateStr = (0, centralTime_js_1.centralDateString)(now);
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);
        if (hour === 7 && minute >= 0 && minute < 2 && lastDailyDigestDate !== dateStr) {
            lastDailyDigestDate = dateStr;
            runDailyDigest()
                .then((result) => deliverDigest(result.snapshotId))
                .catch((err) => console.error("[DailyDigest]", err));
        }
    };
    setInterval(checkAndRun, 60 * 1000);
    console.log("[DailyDigest] Scheduled — 7:00 AM Central daily");
}
async function deliverDigest(snapshotId) {
    const snapshot = (0, reportingStore_js_1.getLatestSnapshot)("daily_digest");
    if (!snapshot)
        return;
    const data = snapshot.data;
    const anomalies = snapshot.anomalies || [];
    const criticalAnomalies = anomalies.filter((a) => a.severity === "critical");
    const smsLines = [
        `📊 Marco's Morning Digest — ${new Date().toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            timeZone: "America/Chicago",
        })}`,
        "",
        `📱 Social: ${data.social.followers.toLocaleString()} followers · ${data.social.avgViewsLast7Days.toLocaleString()} avg views · ${data.social.newDmLeads} new DM leads`,
        `💬 Texts: ${data.texts.sentToday} sent · ${data.texts.receivedToday} received · ${Math.round(data.texts.replyRate * 100)}% reply rate · ${data.texts.appointmentsBooked} appts`,
        `🏠 Transactions: ${data.transactions.dealsInEscrow} in escrow · ${data.transactions.closingsThisWeek} closing this week · ${data.transactions.deadlinesIn48Hours.length} deadlines in 48h`,
        `🔥 Pipeline: ${data.pipeline.hotLeads} hot · ${data.pipeline.warmLeads} warm · ${data.pipeline.coldLeads} cold · ${data.pipeline.newLeadsToday} new today`,
        `💰 GCI: $${(data.businessHealth.pipelineGCI / 1000).toFixed(0)}k pipeline · $${(data.businessHealth.mtdClosedGCI / 1000).toFixed(0)}k MTD closed`,
        criticalAnomalies.length > 0
            ? `🚨 ${criticalAnomalies.length} alert(s): ${criticalAnomalies.map((a) => a.message).join(" | ")}`
            : null,
        "",
        "Ask Harvey for details on any section.",
    ]
        .filter(Boolean)
        .join("\n");
    const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
    if (marcoNumber) {
        const result = await (0, index_js_1.sendTwilioMessage)(marcoNumber, smsLines);
        if (result.success) {
            (0, reportingStore_js_1.markSnapshotDelivered)(snapshotId, "sms");
            console.log("[DailyDigest] SMS delivered to Marco");
        }
    }
    (0, reportingStore_js_1.markSnapshotDelivered)(snapshotId, "harvey");
    console.log("[DailyDigest] Digest available for Harvey");
}
