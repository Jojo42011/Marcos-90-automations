"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapClipUrlForFrontend = mapClipUrlForFrontend;
exports.submitToOpenShorts = submitToOpenShorts;
exports.pollOpenShortsJob = pollOpenShortsJob;
exports.trimClipViaOpenShorts = trimClipViaOpenShorts;
exports.editClipViaOpenShorts = editClipViaOpenShorts;
exports.suggestCutsViaOpenShorts = suggestCutsViaOpenShorts;
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
const POLL_INTERVAL_MS = 8000;
const STATUS_CHECK_TIMEOUT_MS = 25000;
// Backstop poll ceiling: 900 × 8s = 7200s (2 hrs), matching the per-job budget
// in app_marco.py (_JOB_MAX_SECONDS). Large MOV files (400MB+) need the full
// analysis + reframe window. Override with OPENSHORTS_MAX_POLL_ATTEMPTS.
const MAX_POLL_ATTEMPTS = Number(process.env.OPENSHORTS_MAX_POLL_ATTEMPTS) || 900;
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
    const { filePath, pillar, trendBrief = "", targetClipCount = 7, enableCaptions = true, enableAutoZoom, enableBroll, userContext = "", scriptText = "", } = input;
    if (!fs_1.default.existsSync(filePath)) {
        throw new Error(`Video file not found at path: ${filePath}`);
    }
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
        // Only send explicit overrides — empty string means "sidecar env default".
        if (enableAutoZoom !== undefined)
            formData.append("enable_auto_zoom", String(enableAutoZoom));
        if (enableBroll !== undefined)
            formData.append("enable_broll", String(enableBroll));
        formData.append("user_context", userContext);
        formData.append("script_text", scriptText);
        const response = await axios_1.default.post(`${OPENSHORTS_BASE_URL}/api/process`, formData, {
            headers: formData.getHeaders(),
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
    let notFoundStreak = 0;
    let resetStreak = 0;
    // Remember the last stage the sidecar reported so we can still show real
    // progress ("transcribing — Ns elapsed") on polls that time out because the
    // sidecar is too CPU-busy to answer — otherwise a long transcription looks
    // like a stall with no stage/elapsed information.
    let lastKnownStatus = "starting";
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_INTERVAL_MS);
        try {
            const response = await axios_1.default.get(`${OPENSHORTS_BASE_URL}/api/jobs/${jobId}`, {
                timeout: STATUS_CHECK_TIMEOUT_MS,
            });
            unreachableStreak = 0;
            notFoundStreak = 0;
            resetStreak = 0;
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
            lastKnownStatus = job.status;
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
            // A 404 means the sidecar no longer knows this job. Because the job is
            // registered before its id is ever returned to us, a persistent 404 means
            // the sidecar process restarted and lost its in-memory job map — almost
            // always because it was OOM-killed mid-job. Fail fast instead of polling
            // to the 960s ceiling waiting for a result that can never arrive.
            if (axiosErr?.response?.status === 404) {
                notFoundStreak++;
                if (notFoundStreak >= 3) {
                    throw new Error(`OpenShorts job ${jobId} disappeared from the sidecar (HTTP 404 x${notFoundStreak}) — ` +
                        `the sidecar likely crashed/restarted mid-job (possible out-of-memory). Not retrying.`);
                }
                console.warn(`[openshorts] Job ${jobId} not found (404, ${notFoundStreak}/3) — sidecar may have restarted, retrying briefly`);
                continue;
            }
            if (axiosErr?.response) {
                console.warn(`[openshorts] Job ${jobId} status check got HTTP ${axiosErr.response.status} ` +
                    `(attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS}): ${JSON.stringify(axiosErr.response.data).slice(0, 300)}`);
                continue;
            }
            // Request/socket timeout: no response at all within STATUS_CHECK_TIMEOUT_MS.
            // The sidecar is alive but busy processing the video and couldn't answer
            // in time. Keep polling — this is expected while a clip job is running.
            if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(msg)) {
                console.warn(`[openshorts] Job ${jobId}: ${lastKnownStatus} — attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS} ` +
                    `(${Math.round((attempt * POLL_INTERVAL_MS) / 1000)}s elapsed); status check timed out after ` +
                    `${STATUS_CHECK_TIMEOUT_MS / 1000}s — sidecar busy processing, retrying`);
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
            // Connection reset / broken pipe mid-request ("socket hang up"): the
            // sidecar dropped the connection, almost always because it briefly
            // restarted (supervisord auto-restarts it). This is transient — retry a
            // few times instead of failing the whole batch on the first blip. If the
            // sidecar restarted, the job it was tracking is gone from its in-memory
            // map, so a later poll returns 404 and fails cleanly via the branch above;
            // if it was just a dropped connection, the next poll resumes normally.
            if (code === "ECONNRESET" || code === "EPIPE" || /socket hang up/i.test(msg)) {
                resetStreak++;
                if (resetStreak >= 4) {
                    throw new Error(`OpenShorts poll connection reset ${resetStreak}x (${code || "socket hang up"}) — ` +
                        `the sidecar keeps dropping the connection (likely crashed/restarted mid-job). ` +
                        `Check /tmp/openshorts_err.log on the machine for the traceback.`);
                }
                console.warn(`[openshorts] Job ${jobId} poll connection reset (${code || "socket hang up"}), ` +
                    `retry ${resetStreak}/4 — sidecar may be restarting`);
                continue;
            }
            console.error(`[openshorts] Job ${jobId} status check failed with an unexpected error ` +
                `(code=${code || "none"}, attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS}): ${msg}`);
            throw err;
        }
    }
    throw new Error(`OpenShorts job ${jobId} timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`);
}
/**
 * Re-cut an already-generated clip to a new [start, end] range via the sidecar.
 * The sidecar reuses the batch FFmpeg primitive + memory guardrails and returns
 * a NEW file — it never deletes the original. Surfaces the sidecar's own error
 * detail (busy / low-memory / invalid range / render failure) so the caller can
 * report it and leave the original clip untouched.
 */
async function trimClipViaOpenShorts(input) {
    const health = await checkOpenShortsHealth();
    if (!health.running) {
        throw new Error("OpenShorts sidecar is not running — cannot trim clips. Start the sidecar and retry.");
    }
    try {
        const formData = new form_data_1.default();
        formData.append("clip_path", input.clipPath);
        formData.append("start", String(input.start));
        formData.append("end", String(input.end));
        // A trim is a single re-encode bounded by the sidecar's 180s ffmpeg timeout;
        // give the HTTP call headroom above that so the sidecar's own fail-fast wins.
        const response = await axios_1.default.post(`${OPENSHORTS_BASE_URL}/api/clips/trim`, formData, {
            headers: formData.getHeaders(),
            timeout: 210000,
        });
        return {
            newClipPath: String(response.data.new_clip_path || ""),
            newClipUrl: String(response.data.new_clip_url || ""),
            newDuration: Number(response.data.new_duration || 0),
        };
    }
    catch (err) {
        const axiosErr = err;
        const detail = axiosErr?.response?.data?.detail;
        throw new Error(detail || axiosErr?.message || "OpenShorts trim failed");
    }
}
/**
 * Structural edit of an already-generated clip (trim ends, remove middle
 * sections, mute/remove audio) via the sidecar's memory-safe edit engine.
 * Returns a NEW file; never deletes the original. Surfaces the sidecar's error
 * detail (busy / invalid spec / render failure) for honest reporting.
 */
async function editClipViaOpenShorts(input) {
    const health = await checkOpenShortsHealth();
    if (!health.running) {
        throw new Error("OpenShorts sidecar is not running — cannot edit clips. Start the sidecar and retry.");
    }
    try {
        const formData = new form_data_1.default();
        formData.append("clip_path", input.clipPath);
        formData.append("edit_spec", JSON.stringify(input.editSpec));
        const response = await axios_1.default.post(`${OPENSHORTS_BASE_URL}/api/clips/edit`, formData, {
            headers: formData.getHeaders(),
            timeout: 210000,
        });
        return {
            newClipPath: String(response.data.new_clip_path || ""),
            newClipUrl: String(response.data.new_clip_url || ""),
            newDuration: Number(response.data.new_duration || 0),
        };
    }
    catch (err) {
        const axiosErr = err;
        const detail = axiosErr?.response?.data?.detail;
        throw new Error(detail || axiosErr?.message || "OpenShorts edit failed");
    }
}
/**
 * Phase 3 — ask the sidecar which dead-air cuts it would suggest for a clip
 * (plus the dramatic pauses it would KEEP, filler lines, and scene changes),
 * WITHOUT applying anything. Read-only; renders nothing. The caller decides what
 * to apply via editClipViaOpenShorts.
 */
async function suggestCutsViaOpenShorts(input) {
    const health = await checkOpenShortsHealth();
    if (!health.running) {
        throw new Error("OpenShorts sidecar is not running — cannot analyse clips. Start the sidecar and retry.");
    }
    try {
        const formData = new form_data_1.default();
        formData.append("clip_path", input.clipPath);
        if (input.maxGap !== undefined)
            formData.append("max_gap", String(input.maxGap));
        if (input.noiseDb !== undefined)
            formData.append("noise_db", String(input.noiseDb));
        const response = await axios_1.default.post(`${OPENSHORTS_BASE_URL}/api/clips/suggest-cuts`, formData, {
            headers: formData.getHeaders(),
            timeout: 120000,
        });
        const d = response.data ?? {};
        return {
            duration: Number(d.duration ?? 0),
            suggestedCuts: Array.isArray(d.suggested_cuts) ? d.suggested_cuts : [],
            estimatedRemovedSeconds: Number(d.estimated_removed_seconds ?? 0),
            estimatedResultSeconds: Number(d.estimated_result_seconds ?? 0),
            dramaticPausesKept: Array.isArray(d.dramatic_pauses_kept) ? d.dramatic_pauses_kept : [],
            fillerLines: Array.isArray(d.filler_lines) ? d.filler_lines : [],
            sceneChanges: Array.isArray(d.scene_changes) ? d.scene_changes : [],
        };
    }
    catch (err) {
        const axiosErr = err;
        const detail = axiosErr?.response?.data?.detail;
        throw new Error(detail || axiosErr?.message || "OpenShorts suggest-cuts failed");
    }
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
        enhancementsApplied: Array.isArray(raw.enhancements_applied)
            ? raw.enhancements_applied.map(String)
            : Array.isArray(raw.enhancementsApplied)
                ? raw.enhancementsApplied.map(String)
                : [],
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
            enhancementsApplied: [],
        };
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
