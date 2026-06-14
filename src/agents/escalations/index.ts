import {
  getSocialDb,
  getLatestSocialDashboardData,
  getPendingCommentReplies,
  logAgentPull,
} from "../../core/socialStore.js";
import type { SocialDashboardVideo } from "../../core/socialStore.js";
import { sendSendblueMessage } from "../../integrations/sendblue/index.js";
import { getLatestMorningScan } from "../morningScan/index.js";

export type EscalationType =
  | "negative_comment_traction"
  | "lead_intent_dm"
  | "video_viral_spike";

export interface Escalation {
  id?: number;
  type: EscalationType;
  detectedAt: string;
  details: Record<string, unknown>;
  message: string;
  smsSent: boolean;
}

function saveEscalation(esc: Omit<Escalation, "id">): void {
  const db = getSocialDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      details TEXT NOT NULL,
      message TEXT NOT NULL,
      sms_sent INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.prepare(
    `INSERT INTO escalations (type, detected_at, details, message, sms_sent)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    esc.type,
    esc.detectedAt,
    JSON.stringify(esc.details),
    esc.message,
    esc.smsSent ? 1 : 0,
  );
}

export function getRecentEscalations(limit = 20): Escalation[] {
  const db = getSocialDb();
  try {
    const rows = db
      .prepare(`SELECT * FROM escalations ORDER BY detected_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: Number(row.id),
      type: row.type as EscalationType,
      detectedAt: String(row.detected_at),
      details: JSON.parse(String(row.details)) as Record<string, unknown>,
      message: String(row.message),
      smsSent: Number(row.sms_sent) === 1,
    }));
  } catch {
    return [];
  }
}

function wasRecentlyEscalated(type: string, identifier: string, withinMinutes = 60): boolean {
  const db = getSocialDb();
  try {
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
    const row = db
      .prepare(
        `SELECT id FROM escalations
         WHERE type = ? AND detected_at > ? AND details LIKE ?
         LIMIT 1`,
      )
      .get(type, cutoff, `%${identifier}%`) as Record<string, unknown> | undefined;
    return !!row;
  } catch {
    return false;
  }
}

async function sendEscalationSms(message: string): Promise<boolean> {
  const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
  if (!marcoNumber) {
    console.warn("[Escalation] MARCO_PHONE_NUMBER not set — cannot send SMS alert");
    return false;
  }

  try {
    const result = await sendSendblueMessage({ to: marcoNumber, content: message });
    return result.ok;
  } catch (err) {
    console.error("[Escalation] SMS send failed:", err);
    return false;
  }
}

export async function checkNegativeCommentTraction(): Promise<void> {
  try {
    const pending = getPendingCommentReplies();
    const negatives = pending.filter((r) => r.sentiment === "negative");

    for (const reply of negatives) {
      const ageMs = Date.now() - new Date(reply.createdAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);

      if (ageHours >= 2 && !wasRecentlyEscalated("negative_comment_traction", String(reply.id), 240)) {
        const message = `⚠️ Negative comment needs review: "@${reply.authorUsername}: ${reply.commentText.substring(0, 80)}" — pending ${Math.round(ageHours)}h. Check Content Manager.`;

        const smsSent = await sendEscalationSms(message);

        saveEscalation({
          type: "negative_comment_traction",
          detectedAt: new Date().toISOString(),
          details: {
            replyId: reply.id,
            authorUsername: reply.authorUsername,
            commentText: reply.commentText,
            ageHours: Math.round(ageHours),
          },
          message,
          smsSent,
        });

        console.log("[Escalation] Negative comment traction flagged:", reply.authorUsername);
      }
    }
  } catch (err) {
    console.error("[Escalation] checkNegativeCommentTraction ERROR:", err);
  }
}

export async function checkLeadIntentInDMs(): Promise<void> {
  try {
    const scan = getLatestMorningScan();
    if (!scan) {
      console.log("[Escalation] No morning scan available for lead-intent check");
      return;
    }

    const scanAge = Date.now() - new Date(scan.scannedAt).getTime();
    if (scanAge > 2 * 60 * 60 * 1000) {
      console.log("[Escalation] Morning scan too old for lead-intent escalation (>2h)");
      return;
    }

    const strongIntentFlags = scan.leadIntentFlags.filter(
      (f) =>
        f.intentSignals.includes("contact_request") ||
        f.intentSignals.includes("tour_request") ||
        f.intentSignals.length >= 3,
    );

    console.log(
      "[Escalation] Lead-intent filter:",
      scan.leadIntentFlags.length,
      "total flags →",
      strongIntentFlags.length,
      "strong (contact/tour or 3+ signals)",
    );

    for (const flag of strongIntentFlags) {
      const identifier = `${flag.authorUsername}_${flag.detectedAt}`;
      if (wasRecentlyEscalated("lead_intent_dm", identifier, 1440)) continue;

      const message = `🔥 Strong lead intent: @${flag.authorUsername} on ${flag.platform} — "${flag.text.substring(0, 80)}" Signals: ${flag.intentSignals.join(", ")}`;

      const smsSent = await sendEscalationSms(message);

      saveEscalation({
        type: "lead_intent_dm",
        detectedAt: new Date().toISOString(),
        details: {
          authorUsername: flag.authorUsername,
          platform: flag.platform,
          text: flag.text,
          signals: flag.intentSignals,
        },
        message,
        smsSent,
      });

      console.log("[Escalation] Strong lead intent flagged:", flag.authorUsername);
    }
  } catch (err) {
    console.error("[Escalation] checkLeadIntentInDMs ERROR:", err);
  }
}

const videoViewSnapshots = new Map<string, { views: number; timestamp: number }[]>();

function videoCaption(v: SocialDashboardVideo): string {
  return (v.caption || "").trim();
}

export async function checkViralSpike(): Promise<void> {
  try {
    const data = getLatestSocialDashboardData();
    const videos = data.videos || [];

    if (videos.length === 0) return;

  const avgViews = videos.reduce((sum, v) => sum + (v.views || 0), 0) / videos.length;

  const now = Date.now();
  const fourHoursAgo = now - 4 * 60 * 60 * 1000;

  for (const video of videos) {
    const postId = video.id;
    const currentViews = video.views || 0;

    if (!videoViewSnapshots.has(postId)) {
      videoViewSnapshots.set(postId, []);
    }
    const snapshots = videoViewSnapshots.get(postId)!;
    snapshots.push({ views: currentViews, timestamp: now });

    const dayAgo = now - 24 * 60 * 60 * 1000;
    const filtered = snapshots.filter((s) => s.timestamp >= dayAgo);
    videoViewSnapshots.set(postId, filtered);

    const snapshot4hAgo = filtered.find((s) => s.timestamp <= fourHoursAgo);
    if (!snapshot4hAgo) continue;

    const viewsGained = currentViews - snapshot4hAgo.views;
    const expectedGain = avgViews * 0.1;

    if (expectedGain > 0 && viewsGained > expectedGain * 3 && viewsGained > 500) {
      if (wasRecentlyEscalated("video_viral_spike", postId, 240)) continue;

      const multiplier = Math.round(viewsGained / expectedGain);
      const message = `🚀 Viral spike! "${videoCaption(video).substring(0, 60)}" gained ${viewsGained.toLocaleString()} views in 4h (${multiplier}x normal). Consider boosting engagement now.`;

      const smsSent = await sendEscalationSms(message);

      saveEscalation({
        type: "video_viral_spike",
        detectedAt: new Date().toISOString(),
        details: {
          postId,
          description: videoCaption(video),
          viewsGained,
          currentViews,
          multiplier,
        },
        message,
        smsSent,
      });

      console.log("[Escalation] Viral spike detected:", postId, viewsGained, "views in 4h");
    }
  }
  } catch (err) {
    console.error("[Escalation] checkViralSpike ERROR:", err);
  }
}

export async function runAllEscalationChecks(): Promise<void> {
  const startTime = Date.now();
  console.log("[Escalation] Running all checks...");

  await checkNegativeCommentTraction();
  await checkLeadIntentInDMs();
  await checkViralSpike();

  const recent = getRecentEscalations(5);
  const newCount = recent.filter(
    (e) => new Date(e.detectedAt).getTime() > Date.now() - 60000,
  ).length;

  logAgentPull({
    pulledAt: new Date().toISOString(),
    pullType: "escalation_check",
    status: "success",
    summary: newCount > 0 ? `Found ${newCount} new escalation(s)` : "No new escalations",
    details: { newEscalations: newCount },
    durationMs: Date.now() - startTime,
  });
}

export function scheduleEscalationChecks(): void {
  setInterval(() => {
    runAllEscalationChecks().catch((err) => console.error("[Escalation] Check error:", err));
  }, 30 * 60 * 1000);

  console.log("[Escalation] Scheduled to run every 30 minutes");
}
