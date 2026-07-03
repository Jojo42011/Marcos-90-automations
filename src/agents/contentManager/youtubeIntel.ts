/**
 * YouTube Competitor Transcript Intelligence
 *
 * Uses yt-dlp + youtube-transcript-api (both running in the OpenShorts Python sidecar)
 * to pull full transcripts from competitor YouTube channels.
 *
 * No API keys. No authentication. No cost beyond Claude analysis.
 * Transcripts cached in SQLite for 7 days.
 */

import axios from "axios";
import type { ContentManagerBrain } from "./brain/index.js";
import { claudeContent, CONTENT_MODELS, logContentAiFailure } from "../../integrations/claude-content.js";
import { getWeekStart } from "./brain/stats.js";
import {
  getCachedYoutubeTranscript,
  getLatestYoutubeAnalysis,
  insertYoutubeAnalysis,
  listActiveYoutubeProfiles,
  markYoutubeProfileScraped,
  upsertYoutubeTranscript,
  upsertYoutubeVideoCache,
  type CmYoutubeAnalysis,
} from "../../core/contentDb.js";

const OPENSHORTS_URL = process.env.OPENSHORTS_URL || "http://localhost:8000";
const TRANSCRIPT_CACHE_DAYS = 7;
const MAX_VIDEOS_PER_CHANNEL = 8;

export interface YouTubeVideoMeta {
  video_id: string;
  title: string;
  url: string;
  upload_date: string;
  view_count: number;
  duration: number;
  channel: string;
  channel_id: string;
}

export interface BatchTranscriptResult {
  video_id: string;
  status: "success" | "failed";
  full_text: string | null;
  hook_text?: string;
  cta_text?: string;
  word_count?: number;
  error?: string;
}

interface CachedTranscriptData {
  videoId: string;
  title: string;
  channelName: string;
  viewCount: number;
  hookText: string;
  ctaText: string;
  fullText: string;
  wordCount: number;
}

// ─── Sidecar communication ────────────────────────────────────────────────────

/** Fetch recent video IDs from a YouTube channel URL using yt-dlp in the sidecar. */
export async function getChannelRecentVideos(
  channelUrl: string,
  maxVideos: number = MAX_VIDEOS_PER_CHANNEL,
): Promise<YouTubeVideoMeta[]> {
  try {
    const response = await axios.get(`${OPENSHORTS_URL}/api/youtube/channel-videos`, {
      params: { channel_url: channelUrl, max_videos: maxVideos },
      timeout: 45000,
    });
    return (response.data?.videos as YouTubeVideoMeta[]) || [];
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "ECONNREFUSED") {
      console.warn("[youtube-intel] OpenShorts sidecar not running — cannot fetch channel videos");
      return [];
    }
    console.error(`[youtube-intel] getChannelRecentVideos failed for ${channelUrl}:`, e.message);
    return [];
  }
}

/** Batch fetch transcripts for multiple video IDs. Skips unavailable ones. */
export async function batchFetchTranscripts(videoIds: string[]): Promise<BatchTranscriptResult[]> {
  if (!videoIds.length) return [];
  try {
    const form = new URLSearchParams();
    form.append("video_ids", videoIds.join(","));
    form.append("language", "en");
    const response = await axios.post(
      `${OPENSHORTS_URL}/api/youtube/batch-transcripts`,
      form.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 60000,
      },
    );
    return (response.data?.results as BatchTranscriptResult[]) || [];
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "ECONNREFUSED") {
      console.warn("[youtube-intel] OpenShorts sidecar not running — skipping batch transcript fetch");
      return [];
    }
    console.error("[youtube-intel] batchFetchTranscripts failed:", e.message);
    return [];
  }
}

/** Single-video transcript fetch via the sidecar. Never throws — returns a
 *  discriminated result so one bad video can't stop the loop. */
interface SingleTranscriptResult {
  status: "success" | "unavailable";
  fullText: string;
  hookText: string;
  ctaText: string;
  wordCount: number;
  error?: string;
}

async function fetchSingleTranscript(videoId: string): Promise<SingleTranscriptResult> {
  const empty = { fullText: "", hookText: "", ctaText: "", wordCount: 0 };
  try {
    const form = new URLSearchParams();
    form.append("video_id", videoId);
    form.append("language", "en");
    const response = await axios.post(
      `${OPENSHORTS_URL}/api/youtube/transcript`,
      form.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000 },
    );
    const d = (response.data || {}) as {
      full_text?: string;
      word_count?: number;
      sections?: { hook?: string; cta?: string };
      error?: string;
      message?: string;
    };
    if (d.error || !d.full_text || !d.full_text.trim()) {
      return { status: "unavailable", ...empty, error: d.message || d.error || "no transcript" };
    }
    return {
      status: "success",
      fullText: d.full_text,
      hookText: d.sections?.hook || "",
      ctaText: d.sections?.cta || "",
      wordCount: d.word_count || d.full_text.split(/\s+/).length,
    };
  } catch (err) {
    const e = err as { code?: string; message?: string; response?: { data?: { detail?: string } } };
    if (e.code === "ECONNREFUSED") {
      return { status: "unavailable", ...empty, error: "sidecar not running" };
    }
    return { status: "unavailable", ...empty, error: e.response?.data?.detail || e.message || "request failed" };
  }
}

// ─── Live progress (read by GET /api/content/youtube-intel/progress) ────────────

export type YouTubeIntelStage =
  | "idle"
  | "fetching_videos"
  | "fetching_transcripts"
  | "analyzing"
  | "complete";

export interface YouTubeIntelProgress {
  running: boolean;
  stage: YouTubeIntelStage;
  currentChannel: string;
  channelsComplete: number;
  channelsTotal: number;
  videosProcessed: number;
  videosTotal: number;
  transcriptsFetched: number;
  suggestionsGenerated: number;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
}

let ytProgress: YouTubeIntelProgress = {
  running: false,
  stage: "idle",
  currentChannel: "",
  channelsComplete: 0,
  channelsTotal: 0,
  videosProcessed: 0,
  videosTotal: 0,
  transcriptsFetched: 0,
  suggestionsGenerated: 0,
  message: "",
  startedAt: null,
  finishedAt: null,
};

/** Snapshot of the current (or last) analysis run for the UI progress bar. */
export function getYouTubeIntelProgress(): YouTubeIntelProgress {
  return { ...ytProgress };
}

// ─── Main analysis ────────────────────────────────────────────────────────────

/**
 * Full YouTube competitor intelligence run.
 * Pass 1 lists each channel's recent videos (so we know the total up front for
 * the progress bar); pass 2 fetches transcripts one video at a time — checking
 * the 7-day cache first and saving each fresh transcript immediately so a crash
 * loses nothing — then Claude analyzes them all. A single video or channel
 * failure never stops the run.
 */
export async function runYouTubeCompetitorAnalysis(
  brain: ContentManagerBrain,
): Promise<CmYoutubeAnalysis | null> {
  if (ytProgress.running) {
    console.log("[youtube-intel] Analysis already running — skipping duplicate trigger");
    return null;
  }

  console.log("[youtube-intel] Starting YouTube competitor transcript analysis");

  const profiles = listActiveYoutubeProfiles();
  if (!profiles.length) {
    console.log("[youtube-intel] No active YouTube profiles configured");
    return null;
  }

  ytProgress = {
    running: true,
    stage: "fetching_videos",
    currentChannel: "",
    channelsComplete: 0,
    channelsTotal: profiles.length,
    videosProcessed: 0,
    videosTotal: 0,
    transcriptsFetched: 0,
    suggestionsGenerated: 0,
    message: "Fetching channel video lists…",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  const allTranscripts: CachedTranscriptData[] = [];

  try {
    console.log(`[youtube-intel] Analyzing ${profiles.length} YouTube channels`);

    // ── Pass 1: list videos per channel so videosTotal is known up front ──
    const perChannel: Array<{ profile: (typeof profiles)[number]; videos: YouTubeVideoMeta[] }> = [];
    for (const profile of profiles) {
      ytProgress.currentChannel = profile.channelName || profile.youtubeHandle || "channel";
      ytProgress.message = `Fetching videos from ${ytProgress.currentChannel}…`;
      let videos: YouTubeVideoMeta[] = [];
      try {
        videos = await getChannelRecentVideos(profile.youtubeChannelUrl, MAX_VIDEOS_PER_CHANNEL);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[youtube-intel] Channel video list failed for ${profile.channelName}: ${msg}`);
      }
      if (!videos.length) {
        console.warn(`[youtube-intel] No videos found for ${profile.channelName}`);
        continue;
      }
      console.log(`[youtube-intel] Found ${videos.length} recent videos for ${profile.channelName}`);
      for (const video of videos) {
        upsertYoutubeVideoCache({
          youtubeProfileId: profile.id,
          videoId: video.video_id,
          title: video.title,
          channelName: video.channel || profile.channelName || "",
          channelUrl: profile.youtubeChannelUrl,
          uploadDate: video.upload_date,
          viewCount: video.view_count || 0,
          durationSeconds: video.duration || 0,
          url: video.url,
        });
      }
      perChannel.push({ profile, videos });
      ytProgress.videosTotal += videos.length;
    }

    // ── Pass 2: fetch transcripts one video at a time (cache-first) ──
    ytProgress.stage = "fetching_transcripts";
    ytProgress.channelsComplete = 0;
    for (const { profile, videos } of perChannel) {
      const channelName = profile.channelName || profile.youtubeHandle || "channel";
      ytProgress.currentChannel = channelName;
      let cachedCount = 0;
      let fetchedCount = 0;
      let unavailableCount = 0;

      for (const video of videos) {
        ytProgress.message = `Fetching transcripts from ${channelName}…`;
        const vid = video.video_id;

        const cached = getCachedYoutubeTranscript(vid);
        if (cached && cached.fullText) {
          console.log(`[youtube-intel] cached: ${vid}`);
          cachedCount++;
          allTranscripts.push({
            videoId: vid,
            title: video.title,
            channelName,
            viewCount: video.view_count || 0,
            hookText: cached.hookText || "",
            ctaText: cached.ctaText || "",
            fullText: cached.fullText,
            wordCount: cached.wordCount || 0,
          });
          ytProgress.videosProcessed++;
          continue;
        }

        const result = await fetchSingleTranscript(vid);
        if (result.status === "success") {
          console.log(`[youtube-intel] fetched: ${vid} (${result.fullText.length} chars)`);
          fetchedCount++;
          // Save immediately so a crash mid-run loses nothing.
          upsertYoutubeTranscript({
            videoId: vid,
            videoTitle: video.title,
            channelName,
            viewCount: video.view_count || 0,
            fullText: result.fullText,
            hookText: result.hookText,
            bodyText: "",
            ctaText: result.ctaText,
            wordCount: result.wordCount,
            fetchStatus: "success",
            errorMessage: null,
            cacheDays: TRANSCRIPT_CACHE_DAYS,
          });
          allTranscripts.push({
            videoId: vid,
            title: video.title,
            channelName,
            viewCount: video.view_count || 0,
            hookText: result.hookText,
            ctaText: result.ctaText,
            fullText: result.fullText,
            wordCount: result.wordCount,
          });
          ytProgress.transcriptsFetched++;
        } else {
          console.log(`[youtube-intel] unavailable: ${vid} — ${result.error || "no transcript"}`);
          unavailableCount++;
          // Cache the miss so we don't re-hit it every run for 7 days.
          upsertYoutubeTranscript({
            videoId: vid,
            videoTitle: video.title,
            channelName,
            viewCount: 0,
            fullText: null,
            hookText: null,
            bodyText: null,
            ctaText: null,
            wordCount: 0,
            fetchStatus: "failed",
            errorMessage: result.error || "No transcript available",
            cacheDays: TRANSCRIPT_CACHE_DAYS,
          });
        }
        ytProgress.videosProcessed++;
      }

      console.log(
        `[youtube-intel] ${channelName}: ${cachedCount} cached, ${fetchedCount} fetched fresh, ${unavailableCount} unavailable`,
      );
      ytProgress.channelsComplete++;
      markYoutubeProfileScraped(profile.id, videos.length);
    }

    if (!allTranscripts.length) {
      console.warn("[youtube-intel] No transcripts available for analysis");
      ytProgress.stage = "complete";
      ytProgress.message = "No transcripts available — nothing to analyze";
      return null;
    }

    ytProgress.stage = "analyzing";
    ytProgress.message = `Analyzing ${allTranscripts.length} transcripts with Claude…`;
    console.log(`[youtube-intel] Analyzing ${allTranscripts.length} transcripts with Claude`);
    const analysis = await analyzeTranscriptsWithBrain(allTranscripts, brain);

    const channelsAnalyzed = new Set(allTranscripts.map((t) => t.channelName)).size;
    const suggestionCount =
      (analysis.contentGaps?.length || 0) +
      (analysis.topHookStructures?.length || 0) +
      (analysis.topTopics?.length || 0) +
      (analysis.topRecommendedVideoIdea ? 1 : 0);
    console.log(
      `[youtube-intel] Generated ${suggestionCount} suggestions from ${allTranscripts.length} transcripts across ${channelsAnalyzed} channels`,
    );

    ytProgress.stage = "complete";
    ytProgress.suggestionsGenerated = suggestionCount;
    ytProgress.message = `Analysis complete — ${suggestionCount} suggestions generated`;
    return analysis;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[youtube-intel] Analysis run failed: ${msg}`);
    ytProgress.stage = "complete";
    ytProgress.message = `Analysis failed: ${msg}`;
    return null;
  } finally {
    ytProgress.running = false;
    ytProgress.currentChannel = "";
    ytProgress.finishedAt = new Date().toISOString();
  }
}

interface RawAnalysis {
  top_hook_structures?: string[];
  top_opening_phrases?: string[];
  top_topics?: string[];
  top_data_points?: string[];
  top_cta_patterns?: string[];
  content_gaps?: string[];
  key_insights?: string;
  top_recommended_video_idea?: string;
}

async function analyzeTranscriptsWithBrain(
  transcripts: CachedTranscriptData[],
  brain: ContentManagerBrain,
): Promise<CmYoutubeAnalysis> {
  const transcriptSummaries = transcripts.map((t) => ({
    channel: t.channelName,
    title: t.title,
    views: t.viewCount,
    hook: t.hookText?.slice(0, 400) || t.fullText?.slice(0, 400) || "",
    cta: t.ctaText?.slice(0, 300) || t.fullText?.slice(-300) || "",
    body_sample: t.fullText ? t.fullText.slice(400, Math.min(800, t.fullText.length)) : "",
  }));

  const prompt = `
You are the Content Manager for Marco Puga Realty (@puga.realtor), a San Antonio real estate agent.
You are analyzing transcripts from ${transcripts.length} competitor YouTube videos to extract actionable intelligence for Marco's content strategy.

COMPETITOR VIDEO TRANSCRIPTS:
${JSON.stringify(transcriptSummaries, null, 2)}

Marco's current baseline:
- Average TikTok views: 5,957 per video
- Benchmark target: 6,006 views per video
- Daily targets: 7 videos, 22 phone numbers
- Primary audience: first-time buyers, ages 25-40, San Antonio TX
- Content pillars: Brand > Education > Listings

Analyze these transcripts and return a comprehensive competitive intelligence report as JSON with this exact structure:

{
  "top_hook_structures": ["5-8 specific hook structures that appear repeatedly in high-view competitor videos. Include the actual pattern, e.g. 'I just [verb] a [property type] in [area] for [price]'"],
  "top_opening_phrases": ["5-8 exact or near-exact opening phrases from the transcripts that could work for Marco"],
  "top_topics": ["8-10 content topics that appear most frequently across high-view competitor videos"],
  "top_data_points": ["5-8 specific types of numbers, stats, or data points competitors use"],
  "top_cta_patterns": ["5 CTA patterns from the last sections of high-performing videos"],
  "content_gaps": ["5-7 topics or formats competitors cover consistently that Marco has NOT been covering"],
  "key_insights": "2-3 paragraph analysis of the most important patterns. Be specific. Reference actual examples. Tell Marco what is working and exactly why, and what to do differently.",
  "top_recommended_video_idea": "The single most actionable video idea for Marco. Include the specific hook to use, the content structure, and why this format is proven to work based on what you found."
}

Return ONLY valid JSON. No markdown, no explanation outside the JSON.
`;

  let parsed: RawAnalysis = {};
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.QUALITY,
      max_tokens: 3072,
      system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) {
      parsed = JSON.parse(clean.slice(start, end + 1)) as RawAnalysis;
    }
  } catch (parseErr) {
    logContentAiFailure("youtube transcript analysis", parseErr);
  }

  const channelsAnalyzed = new Set(transcripts.map((t) => t.channelName)).size;

  return insertYoutubeAnalysis({
    videosAnalyzed: transcripts.length,
    channelsAnalyzed,
    topHookStructures: parsed.top_hook_structures || [],
    topOpeningPhrases: parsed.top_opening_phrases || [],
    topTopics: parsed.top_topics || [],
    topDataPoints: parsed.top_data_points || [],
    topCtaPatterns: parsed.top_cta_patterns || [],
    contentGaps: parsed.content_gaps || [],
    keyInsights: parsed.key_insights || "Analysis parsing failed. Raw data was collected successfully.",
    topRecommendedVideoIdea: parsed.top_recommended_video_idea || "",
    weekStart: getWeekStart(),
  });
}

export function getLatestYouTubeAnalysis(): CmYoutubeAnalysis | null {
  return getLatestYoutubeAnalysis();
}
