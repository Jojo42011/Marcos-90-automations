import {
  getSnapshotsByType,
  saveSnapshot,
  markSnapshotDelivered,
  type DailyDigestData,
  type WeeklyKPIData,
} from "../../core/reportingStore.js";
import {
  collectPipelineSection,
  collectTextsSection,
  collectSocialSection,
  collectTransactionsSection,
  collectBusinessHealthSection,
} from "./collectors.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";
import { centralDateString } from "./centralTime.js";

function calcWeekOverWeek(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function sumDigestField(
  snapshots: Array<{ data: DailyDigestData | WeeklyKPIData }>,
  path: string,
): number {
  return snapshots.reduce((sum, snap) => {
    const parts = path.split(".");
    let val: unknown = snap.data;
    for (const key of parts) {
      if (val && typeof val === "object" && key in (val as Record<string, unknown>)) {
        val = (val as Record<string, unknown>)[key];
      } else {
        val = 0;
        break;
      }
    }
    return sum + (typeof val === "number" ? val : 0);
  }, 0);
}

function avgDigestField(
  snapshots: Array<{ data: DailyDigestData | WeeklyKPIData }>,
  path: string,
): number | null {
  if (snapshots.length === 0) return null;
  return sumDigestField(snapshots, path) / snapshots.length;
}

export async function runWeeklyKPI(): Promise<{ snapshotId: number }> {
  console.log("[WeeklyKPI] Generating weekly KPI scorecard...");

  const allSnapshots = getSnapshotsByType("daily_digest", 14);

  const now = new Date();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - 7);
  const lastWeekStart = new Date(now);
  lastWeekStart.setDate(now.getDate() - 14);

  const thisWeekSnaps = allSnapshots.filter(
    (s) => new Date(s.generatedAt) >= thisWeekStart && s.snapshotType === "daily_digest",
  );
  const lastWeekSnaps = allSnapshots.filter(
    (s) =>
      new Date(s.generatedAt) >= lastWeekStart &&
      new Date(s.generatedAt) < thisWeekStart &&
      s.snapshotType === "daily_digest",
  );

  const [pipeline, texts, social, transactions, health] = await Promise.all([
    collectPipelineSection(),
    collectTextsSection(),
    collectSocialSection(),
    collectTransactionsSection(),
    collectBusinessHealthSection(),
  ]);

  const newLeadsThisWeek = sumDigestField(thisWeekSnaps, "pipeline.newLeadsToday");
  const appointmentsThisWeek = sumDigestField(thisWeekSnaps, "texts.appointmentsBooked");

  const metrics: WeeklyKPIData["metrics"] = {
    newLeads: {
      value: newLeadsThisWeek || pipeline.newLeadsToday,
      weekOverWeek: calcWeekOverWeek(
        newLeadsThisWeek || pipeline.newLeadsToday,
        avgLastWeek(lastWeekSnaps, "pipeline.newLeadsToday"),
      ),
    },
    hotLeads: {
      value: pipeline.hotLeads,
      weekOverWeek: calcWeekOverWeek(pipeline.hotLeads, avgLastWeek(lastWeekSnaps, "pipeline.hotLeads")),
    },
    appointmentsBooked: {
      value: appointmentsThisWeek || texts.appointmentsBooked,
      weekOverWeek: calcWeekOverWeek(
        appointmentsThisWeek || texts.appointmentsBooked,
        avgLastWeek(lastWeekSnaps, "texts.appointmentsBooked"),
      ),
    },
    closingsThisWeek: {
      value: transactions.closingsThisWeek,
      weekOverWeek: calcWeekOverWeek(
        transactions.closingsThisWeek,
        avgLastWeek(lastWeekSnaps, "transactions.closingsThisWeek"),
      ),
    },
    textReplyRate: {
      value: texts.replyRate,
      weekOverWeek: calcWeekOverWeek(texts.replyRate, avgLastWeek(lastWeekSnaps, "texts.replyRate")),
    },
    socialFollowers: {
      value: social.followers,
      weekOverWeek: calcWeekOverWeek(social.followers, avgLastWeek(lastWeekSnaps, "social.followers")),
    },
    pipelineGCI: {
      value: health.pipelineGCI,
      weekOverWeek: calcWeekOverWeek(
        health.pipelineGCI,
        avgLastWeek(lastWeekSnaps, "businessHealth.pipelineGCI"),
      ),
    },
  };

  const weekOf = centralDateString();
  const kpiData: WeeklyKPIData = { weekOf, metrics };

  const snapshotId = saveSnapshot({
    snapshotDate: weekOf,
    snapshotType: "weekly_kpi",
    data: kpiData,
    generatedAt: new Date().toISOString(),
    deliveredSms: false,
    deliveredHarvey: false,
  });

  const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
  if (marcoNumber) {
    const formatWoW = (val: number | null) =>
      val === null ? "no prior data" : `${val > 0 ? "+" : ""}${val}% WoW`;

    const kpiLines = [
      `📈 Weekly KPI Scorecard — Week of ${new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/Chicago",
      })}`,
      "",
      `🔥 Hot leads: ${metrics.hotLeads.value} (${formatWoW(metrics.hotLeads.weekOverWeek)})`,
      `📅 Appointments: ${metrics.appointmentsBooked.value} (${formatWoW(metrics.appointmentsBooked.weekOverWeek)})`,
      `🏠 Closings this week: ${metrics.closingsThisWeek.value} (${formatWoW(metrics.closingsThisWeek.weekOverWeek)})`,
      `💬 Reply rate: ${Math.round(metrics.textReplyRate.value * 100)}% (${formatWoW(metrics.textReplyRate.weekOverWeek)})`,
      `📱 Followers: ${metrics.socialFollowers.value.toLocaleString()} (${formatWoW(metrics.socialFollowers.weekOverWeek)})`,
      `💰 Pipeline GCI: $${(metrics.pipelineGCI.value / 1000).toFixed(0)}k (${formatWoW(metrics.pipelineGCI.weekOverWeek)})`,
      "",
      "Ask Harvey for the full breakdown.",
    ].join("\n");

    const result = await sendTwilioMessage(marcoNumber, kpiLines);
    if (result.success) markSnapshotDelivered(snapshotId, "sms");
  }

  markSnapshotDelivered(snapshotId, "harvey");
  console.log("[WeeklyKPI] Scorecard generated and delivered, snapshot ID:", snapshotId);

  return { snapshotId };
}

function avgLastWeek(
  lastWeekSnaps: Array<{ data: DailyDigestData | WeeklyKPIData }>,
  field: string,
): number | null {
  return avgDigestField(lastWeekSnaps, field);
}

let lastWeeklyKpiDate: string | null = null;

export function scheduleWeeklyKPI(): void {
  const checkAndRun = () => {
    const now = new Date();
    const dateStr = centralDateString(now);
    const centralDay = now.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "long" });
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);

    if (
      centralDay === "Friday" &&
      hour === 17 &&
      minute >= 0 &&
      minute < 2 &&
      lastWeeklyKpiDate !== dateStr
    ) {
      lastWeeklyKpiDate = dateStr;
      runWeeklyKPI().catch((err) => console.error("[WeeklyKPI]", err));
    }
  };

  setInterval(checkAndRun, 60 * 1000);
  console.log("[WeeklyKPI] Scheduled — Fridays 5:00 PM Central");
}
