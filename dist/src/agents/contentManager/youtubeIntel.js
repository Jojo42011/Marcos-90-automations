"use strict";
/**
 * YouTube Competitor Transcript Intelligence
 *
 * Uses yt-dlp + youtube-transcript-api (both running in the OpenShorts Python sidecar)
 * to pull full transcripts from competitor YouTube channels.
 *
 * No API keys. No authentication. No cost beyond Gemini analysis.
 * Transcripts cached in SQLite for 7 days.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChannelRecentVideos = getChannelRecentVideos;
exports.batchFetchTranscripts = batchFetchTranscripts;
exports.runYouTubeCompetitorAnalysis = runYouTubeCompetitorAnalysis;
exports.getLatestYouTubeAnalysis = getLatestYouTubeAnalysis;
const axios_1 = __importDefault(require("axios"));
const stats_js_1 = require("./brain/stats.js");
const contentDb_js_1 = require("../../core/contentDb.js");
const OPENSHORTS_URL = process.env.OPENSHORTS_URL || "http://localhost:8000";
const TRANSCRIPT_CACHE_DAYS = 7;
const MAX_VIDEOS_PER_CHANNEL = 8;
// ─── Sidecar communication ────────────────────────────────────────────────────
/** Fetch recent video IDs from a YouTube channel URL using yt-dlp in the sidecar. */
async function getChannelRecentVideos(channelUrl, maxVideos = MAX_VIDEOS_PER_CHANNEL) {
    try {
        const response = await axios_1.default.get(`${OPENSHORTS_URL}/api/youtube/channel-videos`, {
            params: { channel_url: channelUrl, max_videos: maxVideos },
            timeout: 45000,
        });
        return response.data?.videos || [];
    }
    catch (err) {
        const e = err;
        if (e.code === "ECONNREFUSED") {
            console.warn("[youtube-intel] OpenShorts sidecar not running — cannot fetch channel videos");
            return [];
        }
        console.error(`[youtube-intel] getChannelRecentVideos failed for ${channelUrl}:`, e.message);
        return [];
    }
}
/** Batch fetch transcripts for multiple video IDs. Skips unavailable ones. */
async function batchFetchTranscripts(videoIds) {
    if (!videoIds.length)
        return [];
    try {
        const form = new URLSearchParams();
        form.append("video_ids", videoIds.join(","));
        form.append("language", "en");
        const response = await axios_1.default.post(`${OPENSHORTS_URL}/api/youtube/batch-transcripts`, form.toString(), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 60000,
        });
        return response.data?.results || [];
    }
    catch (err) {
        const e = err;
        if (e.code === "ECONNREFUSED") {
            console.warn("[youtube-intel] OpenShorts sidecar not running — skipping batch transcript fetch");
            return [];
        }
        console.error("[youtube-intel] batchFetchTranscripts failed:", e.message);
        return [];
    }
}
// ─── Main analysis ────────────────────────────────────────────────────────────
/**
 * Full YouTube competitor intelligence run.
 * For each active profile: list videos → check cache → fetch missing transcripts →
 * analyze all with Gemini → store in cm_youtube_analysis. Cached for the week.
 */
async function runYouTubeCompetitorAnalysis(brain) {
    console.log("[youtube-intel] Starting YouTube competitor transcript analysis");
    const profiles = (0, contentDb_js_1.listActiveYoutubeProfiles)();
    if (!profiles.length) {
        console.log("[youtube-intel] No active YouTube profiles configured");
        return null;
    }
    console.log(`[youtube-intel] Analyzing ${profiles.length} YouTube channels`);
    const allTranscripts = [];
    let totalVideosFetched = 0;
    for (const profile of profiles) {
        try {
            console.log(`[youtube-intel] Processing channel: ${profile.channelName} (${profile.youtubeChannelUrl})`);
            const videos = await getChannelRecentVideos(profile.youtubeChannelUrl, MAX_VIDEOS_PER_CHANNEL);
            if (!videos.length) {
                console.warn(`[youtube-intel] No videos found for ${profile.channelName}`);
                continue;
            }
            console.log(`[youtube-intel] Found ${videos.length} recent videos for ${profile.channelName}`);
            for (const video of videos) {
                (0, contentDb_js_1.upsertYoutubeVideoCache)({
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
            const videoIdsNeedingTranscript = [];
            const cachedForProfile = [];
            for (const video of videos) {
                const cached = (0, contentDb_js_1.getCachedYoutubeTranscript)(video.video_id);
                if (cached && cached.fullText) {
                    cachedForProfile.push({
                        videoId: video.video_id,
                        title: video.title,
                        channelName: profile.channelName || "",
                        viewCount: video.view_count || 0,
                        hookText: cached.hookText || "",
                        ctaText: cached.ctaText || "",
                        fullText: cached.fullText,
                        wordCount: cached.wordCount || 0,
                    });
                }
                else {
                    videoIdsNeedingTranscript.push(video.video_id);
                }
            }
            console.log(`[youtube-intel] ${cachedForProfile.length} cached, ${videoIdsNeedingTranscript.length} need fetching for ${profile.channelName}`);
            if (videoIdsNeedingTranscript.length > 0) {
                const batchResults = await batchFetchTranscripts(videoIdsNeedingTranscript);
                for (const result of batchResults) {
                    const videoMeta = videos.find((v) => v.video_id === result.video_id);
                    if (result.status === "success" && result.full_text) {
                        const wordCount = result.full_text.split(" ").length;
                        (0, contentDb_js_1.upsertYoutubeTranscript)({
                            videoId: result.video_id,
                            videoTitle: videoMeta?.title || "",
                            channelName: profile.channelName || "",
                            viewCount: videoMeta?.view_count || 0,
                            fullText: result.full_text,
                            hookText: result.hook_text || "",
                            bodyText: "",
                            ctaText: result.cta_text || "",
                            wordCount,
                            fetchStatus: "success",
                            errorMessage: null,
                            cacheDays: TRANSCRIPT_CACHE_DAYS,
                        });
                        cachedForProfile.push({
                            videoId: result.video_id,
                            title: videoMeta?.title || "",
                            channelName: profile.channelName || "",
                            viewCount: videoMeta?.view_count || 0,
                            hookText: result.hook_text || "",
                            ctaText: result.cta_text || "",
                            fullText: result.full_text,
                            wordCount,
                        });
                    }
                    else {
                        // Cache the failed fetch so we don't retry for 7 days
                        (0, contentDb_js_1.upsertYoutubeTranscript)({
                            videoId: result.video_id,
                            videoTitle: videoMeta?.title || "",
                            channelName: profile.channelName || "",
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
                }
            }
            allTranscripts.push(...cachedForProfile);
            totalVideosFetched += cachedForProfile.length;
            (0, contentDb_js_1.markYoutubeProfileScraped)(profile.id, videos.length);
        }
        catch (profileErr) {
            const msg = profileErr instanceof Error ? profileErr.message : String(profileErr);
            console.error(`[youtube-intel] Failed processing ${profile.channelName}:`, msg);
        }
    }
    if (!allTranscripts.length) {
        console.warn("[youtube-intel] No transcripts available for analysis");
        return null;
    }
    console.log(`[youtube-intel] Analyzing ${allTranscripts.length} transcripts with Gemini`);
    const analysis = await analyzeTranscriptsWithBrain(allTranscripts, brain);
    console.log(`[youtube-intel] YouTube analysis complete — ${totalVideosFetched} videos analyzed`);
    return analysis;
}
async function analyzeTranscriptsWithBrain(transcripts, brain) {
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
    let parsed = {};
    try {
        const response = await brain.chat(prompt);
        const clean = (typeof response === "string" ? response : "")
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        if (start >= 0 && end > start) {
            parsed = JSON.parse(clean.slice(start, end + 1));
        }
    }
    catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        console.error("[youtube-intel] Failed to parse Brain analysis:", msg);
    }
    const channelsAnalyzed = new Set(transcripts.map((t) => t.channelName)).size;
    return (0, contentDb_js_1.insertYoutubeAnalysis)({
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
        weekStart: (0, stats_js_1.getWeekStart)(),
    });
}
function getLatestYouTubeAnalysis() {
    return (0, contentDb_js_1.getLatestYoutubeAnalysis)();
}
