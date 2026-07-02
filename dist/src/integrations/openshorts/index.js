"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapClipUrlForFrontend = mapClipUrlForFrontend;
exports.submitToOpenShorts = submitToOpenShorts;
exports.pollOpenShortsJob = pollOpenShortsJob;
exports.checkOpenShortsHealth = checkOpenShortsHealth;
exports.generateMockClips = generateMockClips;
/**
 * OpenShorts integration for Marco Puga Realty
 * Replaces OpusClip. Communicates with the local OpenShorts Python sidecar at port 8000.
 */
const axios_1 = __importDefault(require("axios"));
const fs_1 = __importDefault(require("fs"));
const form_data_1 = __importDefault(require("form-data"));
const crypto_1 = require("crypto");
const OPENSHORTS_BASE_URL = process.env.OPENSHORTS_URL || "http://localhost:8000";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const POLL_INTERVAL_MS = 8000;
const STATUS_CHECK_TIMEOUT_MS = 25000;
const MAX_POLL_ATTEMPTS = 120;
function validateGeminiKey(key) {
    if (!key)
        return;
    if (!key.startsWith("AIza")) {
        console.warn(`[openshorts] GEMINI_API_KEY invalid format: got ${key.slice(0, 12)}… (expected AIza…). ` +
            `Clip analysis will fall back to OpenAI/Anthropic or fail. ` +
            `Get a valid API key from https://aistudio.google.com/app/apikey.`);
    }
}
/** Map OpenShorts clip URL to Node proxy path for frontend. */
function mapClipUrlForFrontend(url) {
    if (!url)
        return url;
    if (url.startsWith("mock://"))
        return url;
    if (url.startsWith("/clips/"))
        return `/openshorts${url}`;
    if (url.startsWith("http://localhost:8000/clips/")) {
        return url.replace("http://localhost:8000", "/openshorts");
    }
    return url;
}
async function submitToOpenShorts(input) {
    const { filePath, pillar, trendBrief = "", targetClipCount = 7, enableCaptions = true } = input;
    if (!fs_1.default.existsSync(filePath)) {
        throw new Error(`Video file not found at path: ${filePath}`);
    }
    validateGeminiKey(GEMINI_API_KEY);
    // Pre-submission health check: fail fast if sidecar is offline.
    // This prevents silent fallback to mock clips when sidecar is clearly down.
    const health = await checkOpenShortsHealth();
    if (!health.running) {
        throw new Error(`OpenShorts sidecar is not running. ` +
            `Start it with: npm run sidecar:start (in a separate terminal) ` +
            `then retry this operation. ` +
            `Without the sidecar, only mock clips will be generated.`);
    }
    try {
        const formData = new form_data_1.default();
        formData.append("file_path", filePath);
        formData.append("pillar", pillar);
        formData.append("trend_brief", trendBrief);
        formData.append("target_clips", String(targetClipCount));
        formData.append("enable_captions", String(enableCaptions));
        const response = await axios_1.default.post(`${OPENSHORTS_BASE_URL}/api/process`, formData, {
            headers: {
                ...formData.getHeaders(),
                "X-Gemini-Key": GEMINI_API_KEY,
            },
            timeout: 30000,
        });
        return {
            jobId: response.data.job_id,
            status: response.data.status,
        };
    }
    catch (err) {
        const code = err?.code;
        // If the health check passed but submission failed, it's a transient issue or sidecar crashed mid-request.
        // Rethrow rather than silently falling back to mock.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`OpenShorts submission failed: ${msg}`);
    }
}
async function pollOpenShortsJob(jobId) {
    if (jobId.startsWith("mock_")) {
        const parts = jobId.split("_");
        const count = Math.min(5, Math.max(1, parseInt(parts[2], 10) || 7));
        console.log(`[openshorts] Mock job ${jobId} — returning ${count} mock clips`);
        await sleep(500);
        return {
            status: "complete",
            clips: generateMockClips(count),
        };
    }
    let unreachableStreak = 0;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_INTERVAL_MS);
        try {
            const response = await axios_1.default.get(`${OPENSHORTS_BASE_URL}/api/jobs/${jobId}`, {
                timeout: STATUS_CHECK_TIMEOUT_MS,
            });
            unreachableStreak = 0;
            const job = response.data;
            if (job.status === "complete") {
                return {
                    status: "complete",
                    clips: (job.clips ?? []).map(normalizeClipResult),
                };
            }
            if (job.status === "failed") {
                throw new Error(`OpenShorts job failed: ${job.error}`);
            }
            console.log(`[openshorts] Job ${jobId}: ${job.status} — attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS} (${Math.round((attempt * POLL_INTERVAL_MS) / 1000)}s elapsed)`);
        }
        catch (err) {
            const axiosErr = err;
            const code = axiosErr?.code;
            const msg = err instanceof Error ? err.message : String(err);
            // A genuine job failure reported by the sidecar — surface it, don't retry.
            if (msg.startsWith("OpenShorts job failed")) {
                throw err;
            }
            // The sidecar answered but with an HTTP error status — this is NOT a
            // timeout and previously got silently swallowed into the generic
            // "sidecar busy" bucket below (or an unlogged throw). Surface exactly
            // what it said so a real server-side error is diagnosable, not mistaken
            // for the sidecar just being busy.
            if (axiosErr?.response) {
                console.warn(`[openshorts] Job ${jobId} status check got HTTP ${axiosErr.response.status} ` +
                    `(attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS}): ${JSON.stringify(axiosErr.response.data).slice(0, 300)}`);
                continue;
            }
            // Request/socket timeout: no response at all within STATUS_CHECK_TIMEOUT_MS.
            // The sidecar is alive but busy processing the video and couldn't answer
            // in time. Keep polling — this is expected while a clip job is running.
            if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(msg)) {
                console.warn(`[openshorts] Job ${jobId} status check got no response within ${STATUS_CHECK_TIMEOUT_MS / 1000}s ` +
                    `(attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS}, code=${code || "timeout"}) — sidecar still processing, retrying`);
                continue;
            }
            // Connection refused / DNS failure: sidecar may be down or restarting.
            // Tolerate a few transient blips before giving up to mock clips.
            if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
                unreachableStreak++;
                if (unreachableStreak >= 5) {
                    console.warn(`[openshorts] Sidecar unreachable ${unreachableStreak}x during poll — falling back to mock clips`);
                    return { status: "complete", clips: generateMockClips(7) };
                }
                console.warn(`[openshorts] Sidecar unreachable (${code}) during poll — retry ${unreachableStreak}/5`);
                continue;
            }
            console.error(`[openshorts] Job ${jobId} status check failed with an unexpected error ` +
                `(code=${code || "none"}, attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS}): ${msg}`);
            throw err;
        }
    }
    throw new Error(`OpenShorts job ${jobId} timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`);
}
async function checkOpenShortsHealth() {
    try {
        const response = await axios_1.default.get(`${OPENSHORTS_BASE_URL}/health`, { timeout: 5000 });
        return {
            running: response.data.status === "ok",
            model: response.data.model,
            activeJobs: response.data.active_jobs,
        };
    }
    catch {
        return { running: false };
    }
}
function normalizeClipResult(raw) {
    const clipUrl = String(raw.clip_url || raw.clipUrl || "");
    const thumbUrl = raw.thumbnail_url || raw.thumbnailUrl;
    return {
        clipId: String(raw.clip_id || raw.clipId || (0, crypto_1.randomUUID)()),
        clipPath: String(raw.clip_path || raw.clipPath || ""),
        clipUrl: mapClipUrlForFrontend(clipUrl),
        thumbnailPath: raw.thumbnail_path ? String(raw.thumbnail_path) : null,
        thumbnailUrl: thumbUrl ? mapClipUrlForFrontend(String(thumbUrl)) : null,
        startTime: Number(raw.start_time ?? raw.startTime ?? 0),
        endTime: Number(raw.end_time ?? raw.endTime ?? 0),
        duration: Number(raw.duration ?? 0),
        viralScore: Number(raw.viral_score ?? raw.viralScore ?? 50),
        hookType: String(raw.hook_type || raw.hookType || "uncategorized"),
        hookPreview: String(raw.hook_preview || raw.hookPreview || ""),
        transcriptSegment: String(raw.transcript_segment || raw.transcriptSegment || ""),
        suggestedTitle: String(raw.suggested_title || raw.suggestedTitle || ""),
        suggestedCaption: String(raw.suggested_caption || raw.suggestedCaption || ""),
        pillar: String(raw.pillar || "brand"),
        whyThisClip: String(raw.why_this_clip || raw.whyThisClip || ""),
    };
}
function generateMockClips(count) {
    const hookTypes = ["data", "personal_story", "local", "controversy", "question"];
    const pillars = ["brand", "education", "listings"];
    const mockHooks = [
        "Here's what $400K actually gets you in San Antonio right now",
        "I just walked this Stone Oak listing and the price surprised even me",
        "Did you know you can buy in Canyon Lake for under $350K?",
        "Stop waiting for rates to drop — here's the real math",
        "This is the mistake I see first-time buyers make every single week",
        "What's the one thing nobody tells you about buying your first home in San Antonio?",
        "I just closed a deal that saved my client $40K — here's exactly how",
    ];
    return Array.from({ length: count }, (_, i) => {
        const clipId = `mock-clip-${i + 1}-${Date.now()}`;
        const duration = 40 + Math.random() * 20;
        return {
            clipId,
            clipPath: `mock://clip/${i + 1}`,
            clipUrl: "",
            thumbnailPath: null,
            thumbnailUrl: null,
            startTime: i * 45,
            endTime: i * 45 + duration,
            duration,
            viralScore: Math.round(60 + Math.random() * 35),
            hookType: hookTypes[i % hookTypes.length],
            hookPreview: mockHooks[i % mockHooks.length],
            transcriptSegment: mockHooks[i % mockHooks.length],
            suggestedTitle: `BRAND — ${mockHooks[i % mockHooks.length].substring(0, 25)} — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
            suggestedCaption: `${mockHooks[i % mockHooks.length]} DM me for the full breakdown.`,
            pillar: pillars[i % pillars.length],
            whyThisClip: `Strong ${hookTypes[i % hookTypes.length]} hook with San Antonio market specificity`,
        };
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
