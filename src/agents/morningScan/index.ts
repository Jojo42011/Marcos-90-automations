import {
  getSocialDb,
  getLatestMorningScanFromDb,
  getLatestSocialDashboardData,
  saveMorningScanResult,
  logAgentPull,
} from "../../core/socialStore.js";
import { fetchTikTokComments } from "../../integrations/apify/index.js";
import { generateCommentReply } from "../commentReply/index.js";
import { saveReportingSnapshot } from "../reporting/index.js";

export interface LeadIntentFlag {
  source: "comment" | "mention" | "dm";
  platform: "tiktok" | "instagram";
  authorUsername: string;
  text: string;
  postId?: string;
  detectedAt: string;
  intentSignals: string[];
}

export interface MorningScanResult {
  scannedAt: string;
  newComments: number;
  newMentions: number;
  leadIntentFlags: LeadIntentFlag[];
  fetchError?: string;
}

function detectIntentSignals(text: string): string[] {
  const lower = text.toLowerCase();
  const signals: string[] = [];

  if (/how much|price|cost/.test(lower)) signals.push("price_question");
  if (/where|location|address/.test(lower)) signals.push("location_question");
  if (/available|still|sold/.test(lower)) signals.push("availability_question");
  if (/dm me|message me|contact/.test(lower)) signals.push("contact_request");
  if (/interested|love this|want this/.test(lower)) signals.push("interest_expressed");
  if (/tour|see it|view it|showing/.test(lower)) signals.push("tour_request");

  return signals;
}

function tikTokUsername(): string {
  return (process.env.TIKTOK_USERNAME?.trim() || "puga.realtor").replace(/^@/, "");
}

async function fetchOvernightComments(): Promise<{
  comments: Array<{ text: string; authorUsername: string; postId: string }>;
  fetchError?: string;
}> {
  const token =
    process.env.APIFY_API_TOKEN?.trim() || process.env.APIFY_API_KEY?.trim() || "";
  if (!token) {
    console.warn("[MorningScan] No Apify token — skipping comment fetch");
    return { comments: [] };
  }

  try {
    const data = getLatestSocialDashboardData();
    const username = tikTokUsername();
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

    const recentVideos = (data.videos || []).filter((v) => {
      const postedAt = new Date(v.postedAt || 0).getTime();
      return postedAt >= threeDaysAgo;
    });

    if (recentVideos.length === 0) {
      console.log("[MorningScan] No recent videos to check comments on");
      return { comments: [] };
    }

    const postURLs = recentVideos.map(
      (v) =>
        v.url ||
        `https://www.tiktok.com/@${username}/video/${v.id}`,
    );

    const sinceTime = Date.now() - 24 * 60 * 60 * 1000;
    const fetched = await fetchTikTokComments(postURLs, sinceTime);

    const comments = fetched.map((c) => ({
      text: c.text,
      authorUsername: c.authorUsername,
      postId: c.postId,
    }));

    console.log(
      "[MorningScan] Fetched",
      comments.length,
      "overnight comments from",
      recentVideos.length,
      "recent videos",
    );

    return { comments };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MorningScan] Comment fetch error:", err);
    return { comments: [], fetchError: message };
  }
}

export async function runMorningScan(): Promise<MorningScanResult> {
  console.log("[MorningScan] Starting overnight scan...");

  const result: MorningScanResult = {
    scannedAt: new Date().toISOString(),
    newComments: 0,
    newMentions: 0,
    leadIntentFlags: [],
  };

  try {
    const { comments, fetchError } = await fetchOvernightComments();
    if (fetchError) {
      result.fetchError = fetchError;
    }
    result.newComments = comments.length;

    for (const comment of comments) {
      try {
        const signals = detectIntentSignals(comment.text);
        if (signals.length > 0) {
          result.leadIntentFlags.push({
            source: "comment",
            platform: "tiktok",
            authorUsername: comment.authorUsername,
            text: comment.text,
            postId: comment.postId,
            detectedAt: new Date().toISOString(),
            intentSignals: signals,
          });
        }

        await generateCommentReply(comment.text, comment.authorUsername, comment.postId);
      } catch (err) {
        console.error("[MorningScan] ERROR processing comment:", err);
      }
    }

    saveMorningScanResult(result);

    saveReportingSnapshot({
      type: "morning",
      generatedAt: result.scannedAt,
      summary: result.fetchError
        ? `Morning scan failed to fetch comments: ${result.fetchError}`
        : `${result.newComments} new comments scanned, ${result.leadIntentFlags.length} lead-intent flags detected overnight.`,
      data: result as unknown as Record<string, unknown>,
    });

    console.log(
      "[MorningScan] Complete —",
      result.newComments,
      "comments,",
      result.leadIntentFlags.length,
      "lead-intent flags",
      result.fetchError ? `(fetch error: ${result.fetchError})` : "",
    );

    logAgentPull({
      pulledAt: result.scannedAt,
      pullType: "morning_scan",
      status: result.fetchError ? "error" : "success",
      summary: result.fetchError
        ? `Failed: ${result.fetchError}`
        : `Scanned overnight — ${result.newComments} new comments, ${result.leadIntentFlags.length} lead-intent flags`,
      details: {
        newComments: result.newComments,
        flags: result.leadIntentFlags.length,
      },
    });
  } catch (err) {
    console.error("[MorningScan] ERROR:", err);
    result.fetchError =
      result.fetchError ?? (err instanceof Error ? err.message : String(err));
    saveMorningScanResult(result);
    logAgentPull({
      pulledAt: result.scannedAt,
      pullType: "morning_scan",
      status: "error",
      summary: `Failed: ${result.fetchError}`,
    });
  }

  return result;
}

export function getLatestMorningScan(): MorningScanResult | null {
  const row = getLatestMorningScanFromDb();
  if (!row) return null;
  return {
    scannedAt: row.scannedAt,
    newComments: row.newComments,
    newMentions: row.newMentions,
    leadIntentFlags: row.leadIntentFlags as LeadIntentFlag[],
    fetchError: row.fetchError,
  };
}

let lastScheduledMorningScanDate: string | null = null;

export function scheduleMorningScanDaily8am(): void {
  const checkAndRun = () => {
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);

    if (hour === 8 && minute >= 0 && minute < 2 && lastScheduledMorningScanDate !== dateStr) {
      lastScheduledMorningScanDate = dateStr;
      runMorningScan().catch((err) => console.error("[MorningScan] scheduled run failed:", err));
    }
  };

  setInterval(checkAndRun, 60 * 1000);
  console.log("[MorningScan] Scheduled for 8:00 AM Central daily");
}

/** Ensure morning_scans table exists when reading without a prior scan. */
export function ensureMorningScanTable(): void {
  const db = getSocialDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS morning_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scanned_at TEXT NOT NULL,
      new_comments INTEGER NOT NULL,
      new_mentions INTEGER NOT NULL,
      lead_intent_flags TEXT NOT NULL,
      fetch_error TEXT
    )
  `);
}
