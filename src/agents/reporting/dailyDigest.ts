import {
  collectSocialSection,
  collectEmailSection,
  collectTextsSection,
  collectTransactionsSection,
  collectPipelineSection,
  collectBusinessHealthSection,
} from "./collectors.js";
import { detectAnomalies } from "./anomalyDetection.js";
import {
  saveSnapshot,
  getLatestSnapshot,
  markSnapshotDelivered,
  type DailyDigestData,
} from "../../core/reportingStore.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";
import { centralDateString } from "./centralTime.js";

export async function runDailyDigest(): Promise<{ snapshotId: number; anomalyCount: number }> {
  console.log("[DailyDigest] Starting daily digest generation...");

  const startTime = Date.now();

  const social = collectSocialSection();
  const email = await collectEmailSection();
  const texts = await collectTextsSection();
  const transactions = collectTransactionsSection();
  const pipeline = await collectPipelineSection();
  const businessHealth = collectBusinessHealthSection();

  const data: DailyDigestData = {
    social,
    email,
    texts,
    transactions,
    pipeline,
    businessHealth,
  };

  const anomalies = detectAnomalies(data);

  data.businessHealth.anomalyFlag = anomalies.some(
    (a) => a.field.startsWith("transactions") || a.field.startsWith("pipeline"),
  );

  const snapshotDate = centralDateString();

  const snapshotId = saveSnapshot({
    snapshotDate,
    snapshotType: "daily_digest",
    data,
    anomalies,
    generatedAt: new Date().toISOString(),
    deliveredSms: false,
    deliveredHarvey: false,
  });

  console.log(
    "[DailyDigest] Generated in",
    Date.now() - startTime,
    "ms, snapshot ID:",
    snapshotId,
    "— anomalies:",
    anomalies.length,
  );

  return { snapshotId, anomalyCount: anomalies.length };
}

let lastDailyDigestDate: string | null = null;

export function scheduleDailyDigest(): void {
  const checkAndRun = () => {
    const now = new Date();
    const dateStr = centralDateString(now);
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

export async function deliverDigest(snapshotId: number): Promise<void> {
  const snapshot = getLatestSnapshot("daily_digest");
  if (!snapshot) return;

  const data = snapshot.data as DailyDigestData;
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
    const result = await sendTwilioMessage(marcoNumber, smsLines);
    if (result.success) {
      markSnapshotDelivered(snapshotId, "sms");
      console.log("[DailyDigest] SMS delivered to Marco");
    }
  }

  markSnapshotDelivered(snapshotId, "harvey");
  console.log("[DailyDigest] Digest available for Harvey");
}
