"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMorningScan = runMorningScan;
exports.getLatestMorningScan = getLatestMorningScan;
exports.scheduleMorningScanDaily8am = scheduleMorningScanDaily8am;
exports.ensureMorningScanTable = ensureMorningScanTable;
const socialStore_js_1 = require("../../core/socialStore.js");
const index_js_1 = require("../../integrations/apify/index.js");
const index_js_2 = require("../commentReply/index.js");
const index_js_3 = require("../reporting/index.js");
function detectIntentSignals(text) {
    const lower = text.toLowerCase();
    const signals = [];
    if (/how much|price|cost/.test(lower))
        signals.push("price_question");
    if (/where|location|address/.test(lower))
        signals.push("location_question");
    if (/available|still|sold/.test(lower))
        signals.push("availability_question");
    if (/dm me|message me|contact/.test(lower))
        signals.push("contact_request");
    if (/interested|love this|want this/.test(lower))
        signals.push("interest_expressed");
    if (/tour|see it|view it|showing/.test(lower))
        signals.push("tour_request");
    return signals;
}
function tikTokUsername() {
    return (process.env.TIKTOK_USERNAME?.trim() || "puga.realtor").replace(/^@/, "");
}
async function fetchOvernightComments() {
    const token = process.env.APIFY_API_TOKEN?.trim() || process.env.APIFY_API_KEY?.trim() || "";
    if (!token) {
        console.warn("[MorningScan] No Apify token — skipping comment fetch");
        return { comments: [] };
    }
    try {
        const data = (0, socialStore_js_1.getLatestSocialDashboardData)();
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
        const postURLs = recentVideos.map((v) => v.url ||
            `https://www.tiktok.com/@${username}/video/${v.id}`);
        const sinceTime = Date.now() - 24 * 60 * 60 * 1000;
        const fetched = await (0, index_js_1.fetchTikTokComments)(postURLs, sinceTime);
        const comments = fetched.map((c) => ({
            text: c.text,
            authorUsername: c.authorUsername,
            postId: c.postId,
        }));
        console.log("[MorningScan] Fetched", comments.length, "overnight comments from", recentVideos.length, "recent videos");
        return { comments };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[MorningScan] Comment fetch error:", err);
        return { comments: [], fetchError: message };
    }
}
async function runMorningScan() {
    console.log("[MorningScan] Starting overnight scan...");
    const result = {
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
                await (0, index_js_2.generateCommentReply)(comment.text, comment.authorUsername, comment.postId);
            }
            catch (err) {
                console.error("[MorningScan] ERROR processing comment:", err);
            }
        }
        (0, socialStore_js_1.saveMorningScanResult)(result);
        (0, index_js_3.saveReportingSnapshot)({
            type: "morning",
            generatedAt: result.scannedAt,
            summary: result.fetchError
                ? `Morning scan failed to fetch comments: ${result.fetchError}`
                : `${result.newComments} new comments scanned, ${result.leadIntentFlags.length} lead-intent flags detected overnight.`,
            data: result,
        });
        console.log("[MorningScan] Complete —", result.newComments, "comments,", result.leadIntentFlags.length, "lead-intent flags", result.fetchError ? `(fetch error: ${result.fetchError})` : "");
        (0, socialStore_js_1.logAgentPull)({
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
    }
    catch (err) {
        console.error("[MorningScan] ERROR:", err);
        result.fetchError =
            result.fetchError ?? (err instanceof Error ? err.message : String(err));
        (0, socialStore_js_1.saveMorningScanResult)(result);
        (0, socialStore_js_1.logAgentPull)({
            pulledAt: result.scannedAt,
            pullType: "morning_scan",
            status: "error",
            summary: `Failed: ${result.fetchError}`,
        });
    }
    return result;
}
function getLatestMorningScan() {
    const row = (0, socialStore_js_1.getLatestMorningScanFromDb)();
    if (!row)
        return null;
    return {
        scannedAt: row.scannedAt,
        newComments: row.newComments,
        newMentions: row.newMentions,
        leadIntentFlags: row.leadIntentFlags,
        fetchError: row.fetchError,
    };
}
let lastScheduledMorningScanDate = null;
function scheduleMorningScanDaily8am() {
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
function ensureMorningScanTable() {
    const db = (0, socialStore_js_1.getSocialDb)();
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
