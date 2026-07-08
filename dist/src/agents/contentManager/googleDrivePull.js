"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.driveConfigured = driveConfigured;
exports.getDriveStatus = getDriveStatus;
exports.pollGoogleDrive = pollGoogleDrive;
exports.scheduleGoogleDrivePoller = scheduleGoogleDrivePoller;
/**
 * Google Drive auto-pull — a new SOURCE for the existing Upload & Clip pipeline.
 *
 * Every 30 minutes, list new video files in Marco's shared Drive folder, pull
 * them to /data/uploads, and hand them to the SAME entry point a manual upload
 * uses (ingestContent → repurposeSession → OpenShorts → Review Queue). Nothing
 * is ever written back to Drive — read-only.
 *
 * Auth: a service-account JSON provided at runtime via the GOOGLE_DRIVE_CREDENTIALS
 * Fly secret (never hardcoded). This is entirely separate from Harvey's Gmail
 * OAuth credentials.
 *
 * Design notes:
 *  - google-auth-library (official) mints the service-account access token; the
 *    two Drive endpoints we need (files.list + files.get?alt=media) are plain
 *    fetch calls — matching this codebase's style and keeping the image lean.
 *  - Processed Drive file IDs are persisted (cm_drive_processed) so a file is
 *    never pulled twice, even across restarts.
 *  - Per-file failures are isolated AND quarantined: because we pull the single
 *    oldest unprocessed file per day, a file that fails downstream every time
 *    (e.g. OpenShorts judges it unclippable) would otherwise be retried forever
 *    and block every file behind it. Failures are tracked in cm_drive_failed;
 *    a permanent content failure quarantines on the first hit, a transient one
 *    after a few attempts, so the queue always advances to the next file.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const stream_1 = require("stream");
const promises_1 = require("stream/promises");
const google_auth_library_1 = require("google-auth-library");
const diskCleanup_js_1 = require("../../core/diskCleanup.js");
const ingest_js_1 = require("./ingest.js");
const repurpose_js_1 = require("./repurpose.js");
const contentDb_js_1 = require("../../core/contentDb.js");
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DEFAULT_FOLDER_ID = "1SQMevfe1HKLhRaqzGBg-ZN7LbQzEBV92";
const POLL_INTERVAL_MS = 30 * 60 * 1000; // every 30 min
const STARTUP_DELAY_MS = 90 * 1000; // let the server settle before the first poll
// Headroom mirrors the manual upload flow (UPLOAD_PROCESSING_HEADROOM_MB = 500):
// reserve space for the source file, its clips, and processing scratch.
const PROCESSING_HEADROOM_MB = 500;
// A transient failure (sidecar restarting, brief network/disk blip) is retried
// this many times before the file is quarantined. A PERMANENT content failure
// (the video has no usable speech, or the AI finds no viable clip) is quarantined
// on the first hit — retrying it daily forever would just block every file behind
// it (which is exactly what left the queue stuck at 5/8).
const MAX_TRANSIENT_ATTEMPTS = 3;
/** True when the failure is a content outcome that WILL recur on every retry, so
 * the file should be skipped rather than retried forever. These strings are the
 * sidecar's own user-facing failure messages (see main_marco / app_marco). */
function isPermanentContentFailure(msg) {
    const m = (msg || "").toLowerCase();
    return (m.includes("no usable speech") ||
        m.includes("no viable clip") ||
        m.includes("found no viable") ||
        m.includes("returned no clips") ||
        m.includes("no usable clips") ||
        m.includes("produced no usable speech") ||
        m.includes("could not be read") || // unreadable/corrupt source (ffprobe failed)
        m.includes("no readable output"));
}
function folderId() {
    return process.env.GOOGLE_DRIVE_FOLDER_ID?.trim() || DEFAULT_FOLDER_ID;
}
function driveConfigured() {
    const raw = process.env.GOOGLE_DRIVE_CREDENTIALS?.trim();
    if (!raw)
        return false;
    try {
        const parsed = JSON.parse(raw);
        return Boolean(parsed && parsed.client_email && parsed.private_key);
    }
    catch {
        return false;
    }
}
// Health/connectivity of the last cycle (in-memory); poll/pull timestamps and the
// processed set are read from the DB so they survive restarts.
const runtime = {
    connected: false,
    folderAccessible: false,
    lastError: null,
    known: 0,
    lastPullResult: null,
    lastPullFile: null,
    lastPullError: null,
    lastAttemptAt: null,
};
function getDriveStatus() {
    const persisted = safeState();
    const today = safeToday();
    const failures = safeFailures();
    const quarantinedCount = failures.filter((f) => f.quarantined).length;
    const processed = safeCount();
    // Pending excludes quarantined files — they are no longer waiting to be pulled.
    const pending = Math.max(0, runtime.known - processed - quarantinedCount);
    return {
        configured: driveConfigured(),
        connected: runtime.connected,
        folderAccessible: runtime.folderAccessible,
        lastPollAt: persisted.lastPollAt,
        lastPullDate: persisted.lastPullDate,
        lastError: runtime.lastError,
        known: runtime.known,
        processed,
        pending,
        pulledToday: Boolean(persisted.lastPullDate && persisted.lastPullDate === today),
        lastPullResult: runtime.lastPullResult,
        lastPullFile: runtime.lastPullFile,
        lastPullError: runtime.lastPullError,
        lastAttemptAt: runtime.lastAttemptAt,
        quarantined: quarantinedCount,
        processedFiles: safeProcessedList(),
        failedFiles: failures.map((f) => ({
            fileId: f.fileId,
            name: f.name,
            attempts: f.attempts,
            lastError: f.lastError,
            quarantined: f.quarantined,
            lastFailedAt: f.lastFailedAt,
        })),
    };
}
function safeCount() {
    try {
        return (0, contentDb_js_1.countDriveProcessed)();
    }
    catch {
        return 0;
    }
}
function safeState() {
    try {
        return (0, contentDb_js_1.getDriveState)();
    }
    catch {
        return { lastPollAt: null, lastPullDate: null };
    }
}
function safeProcessedList() {
    try {
        return (0, contentDb_js_1.listDriveProcessed)();
    }
    catch {
        return [];
    }
}
function safeToday() {
    try {
        return (0, contentDb_js_1.todayDateCst)();
    }
    catch {
        return "";
    }
}
function safeFailures() {
    try {
        return (0, contentDb_js_1.listDriveFailures)();
    }
    catch {
        return [];
    }
}
let auth = null;
function getAuth() {
    if (!auth) {
        const credentials = JSON.parse(process.env.GOOGLE_DRIVE_CREDENTIALS);
        auth = new google_auth_library_1.GoogleAuth({ credentials, scopes: [DRIVE_SCOPE] });
    }
    return auth;
}
async function accessToken() {
    const client = await getAuth().getClient();
    const t = await client.getAccessToken();
    const token = typeof t === "string" ? t : t?.token;
    if (!token)
        throw new Error("Google Drive: could not obtain an access token from the service account");
    return token;
}
async function listVideoFiles(token) {
    const q = `'${folderId()}' in parents and trashed = false and mimeType contains 'video/'`;
    const url = `https://www.googleapis.com/drive/v3/files?` +
        `q=${encodeURIComponent(q)}` +
        `&fields=${encodeURIComponent("files(id,name,mimeType,size,createdTime)")}` +
        `&pageSize=1000&orderBy=createdTime` +
        `&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Drive files.list failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json());
    const files = (data.files || []).map((f) => ({
        id: String(f.id),
        name: String(f.name || f.id),
        mimeType: String(f.mimeType || ""),
        size: Number(f.size) || 0,
        createdTime: String(f.createdTime || ""),
    }));
    // Sort oldest-first by real Drive creation time — never rely on API order.
    files.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    return files;
}
function uploadDir() {
    const base = fs_1.default.existsSync("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
    const dir = path_1.default.join(base, "uploads", "videos");
    fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
function safeName(name) {
    // Keep the extension, strip anything path-ish; matches the manual upload's
    // "<timestamp>-<uuid><ext>" spirit while staying readable.
    const cleaned = name.replace(/[/\\]/g, "_").replace(/[^\w.\- ]/g, "").trim() || "drive-video";
    return `drive-${Date.now()}-${cleaned}`;
}
async function downloadFile(fileId, token, destPath) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok || !res.body) {
        const body = res.body ? await res.text().catch(() => "") : "";
        throw new Error(`Drive download failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    // Stream to disk — never buffer a multi-GB video in memory.
    await (0, promises_1.pipeline)(stream_1.Readable.fromWeb(res.body), fs_1.default.createWriteStream(destPath));
}
let pollInFlight = false;
/**
 * One poll cycle. Checks the folder (cheap, every 30 min) but PULLS at most ONE
 * file per calendar day — the oldest unprocessed video by Drive creation time.
 * Never throws; a bad file is isolated. `force` (manual "poll now") bypasses the
 * once-a-day throttle to pull the single oldest file immediately for testing.
 * last_poll_at is recorded on EVERY cycle, whether or not a file was pulled.
 */
async function pollGoogleDrive(opts) {
    const force = Boolean(opts?.force);
    if (pollInFlight) {
        console.log("[drive-pull] a poll is already running — skipping this tick");
        return;
    }
    pollInFlight = true;
    const stampPoll = () => {
        try {
            (0, contentDb_js_1.setDriveLastPollAt)(new Date().toISOString());
        }
        catch {
            /* ignore */
        }
    };
    try {
        if (!driveConfigured()) {
            runtime.connected = false;
            runtime.folderAccessible = false;
            runtime.lastError = "GOOGLE_DRIVE_CREDENTIALS not set or invalid JSON";
            return; // not configured — nothing to stamp
        }
        let token;
        let files;
        try {
            token = await accessToken();
            files = await listVideoFiles(token);
            runtime.connected = true;
            runtime.folderAccessible = true;
            runtime.known = files.length;
            runtime.lastError = null;
        }
        catch (err) {
            runtime.connected = false;
            runtime.folderAccessible = false;
            runtime.lastError = err instanceof Error ? err.message : String(err);
            console.warn(`[drive-pull] poll failed (auth/list): ${runtime.lastError}`);
            stampPoll();
            return;
        }
        // Oldest unprocessed first (listVideoFiles already sorts by createdTime).
        // Quarantined files (permanently failing / poison) are skipped so the queue
        // always advances to the next pullable file instead of retrying the same one.
        const fresh = files.filter((f) => !(0, contentDb_js_1.isDriveFileProcessed)(f.id) && !(0, contentDb_js_1.isDriveFileQuarantined)(f.id));
        // One-per-day throttle: if a file was already pulled today, only check —
        // don't pull again (unless this is a forced manual poll).
        const today = (0, contentDb_js_1.todayDateCst)();
        const lastPullDate = safeState().lastPullDate;
        if (!force && lastPullDate === today) {
            console.log(`[drive-pull] already pulled a file today (${today}); ${fresh.length} still queued for the coming days`);
            stampPoll();
            return;
        }
        if (!fresh.length) {
            stampPoll();
            return;
        }
        const file = fresh[0]; // the single oldest unprocessed video
        runtime.lastPullFile = file.name;
        runtime.lastAttemptAt = new Date().toISOString();
        try {
            // Disk pre-flight — same reserve the manual upload flow uses.
            const fileMB = Math.ceil((file.size || 0) / (1024 * 1024));
            const neededMB = fileMB + Math.max(fileMB, 200) + PROCESSING_HEADROOM_MB;
            const freeMB = await (0, diskCleanup_js_1.getFreeDiskMB)();
            if (Number.isFinite(freeMB) && freeMB < neededMB) {
                const msg = `Not enough disk: need ~${neededMB}MB, ${freeMB}MB free`;
                console.warn(`[drive-pull] Skipping "${file.name}" — ${msg}. Will retry next cycle (day not consumed).`);
                runtime.lastPullResult = "failed";
                runtime.lastPullError = msg;
                stampPoll();
                return; // NOT marked processed and day NOT consumed — retried next cycle
            }
            const dest = path_1.default.join(uploadDir(), safeName(file.name));
            await downloadFile(file.id, token, dest);
            // Feed into the EXACT same entry point as a manual upload → OpenShorts →
            // Review Queue (fully automatic; only the final approve/reject is manual).
            const session = await (0, ingest_js_1.ingestContent)({
                type: "video",
                path: dest,
                meta: { originalName: file.name, source: "google_drive", driveFileId: file.id },
            });
            await (0, repurpose_js_1.repurposeSession)(session.id);
            (0, contentDb_js_1.markDriveFileProcessed)(file.id, file.name, session.id);
            (0, contentDb_js_1.clearDriveFileFailure)(file.id); // clear any earlier transient-failure record
            (0, contentDb_js_1.setDriveLastPullDate)(today); // consume today's one-per-day slot only on success
            runtime.lastPullResult = "success";
            runtime.lastPullError = null;
            console.log(`[drive-pull] pulled oldest "${file.name}" → session ${session.id} (Review Queue). ${fresh.length - 1} remaining.`);
        }
        catch (err) {
            // Isolate the failure and record it. A permanent content failure (no
            // speech / no viable clip / unreadable) is quarantined immediately so it
            // never blocks the files behind it; a transient failure gets a few retries
            // first. Either way the real reason is surfaced in status. The day is NOT
            // consumed, so a quarantine lets the NEXT oldest file pull on the next cycle.
            const msg = err instanceof Error ? err.message : String(err);
            const permanent = isPermanentContentFailure(msg);
            const attempts = (0, contentDb_js_1.recordDriveFileFailure)(file.id, file.name, msg, permanent || ((0, contentDb_js_1.getDriveFailure)(file.id)?.attempts ?? 0) + 1 >= MAX_TRANSIENT_ATTEMPTS);
            const quarantined = (0, contentDb_js_1.isDriveFileQuarantined)(file.id);
            runtime.lastPullResult = "failed";
            runtime.lastPullError = msg;
            console.error(`[drive-pull] file "${file.name}" (${file.id}) failed (attempt ${attempts}${permanent ? ", permanent" : ""}): ${msg}` +
                (quarantined
                    ? " — QUARANTINED; the next oldest file will pull on the next cycle."
                    : ` — will retry (up to ${MAX_TRANSIENT_ATTEMPTS} attempts).`));
        }
        stampPoll();
    }
    finally {
        pollInFlight = false;
    }
}
let pollTimer = null;
/** Start the 30-minute Drive poll loop (first run shortly after startup). */
function scheduleGoogleDrivePoller() {
    const run = () => {
        void pollGoogleDrive().catch((err) => console.error(`[drive-pull] unexpected: ${err instanceof Error ? err.message : String(err)}`));
    };
    setTimeout(run, STARTUP_DELAY_MS);
    if (pollTimer)
        clearInterval(pollTimer);
    pollTimer = setInterval(run, POLL_INTERVAL_MS);
    console.log(driveConfigured()
        ? "[drive-pull] scheduled (every 30 min)"
        : "[drive-pull] scheduled (every 30 min) — idle until GOOGLE_DRIVE_CREDENTIALS is set");
}
