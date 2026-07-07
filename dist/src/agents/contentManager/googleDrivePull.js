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
 *  - Per-file failures are isolated; one bad file never blocks the cycle.
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
const status = {
    configured: false,
    connected: false,
    folderAccessible: false,
    lastPollAt: null,
    lastError: null,
    known: 0,
    processed: 0,
};
function getDriveStatus() {
    return { ...status, configured: driveConfigured(), processed: safeCount() };
}
function safeCount() {
    try {
        return (0, contentDb_js_1.countDriveProcessed)();
    }
    catch {
        return status.processed;
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
        `&fields=${encodeURIComponent("files(id,name,mimeType,size)")}` +
        `&pageSize=1000&orderBy=createdTime` +
        `&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Drive files.list failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json());
    return (data.files || []).map((f) => ({
        id: String(f.id),
        name: String(f.name || f.id),
        mimeType: String(f.mimeType || ""),
        size: Number(f.size) || 0,
    }));
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
/**
 * One poll cycle. Never throws — records the outcome in `status` and logs. A
 * single bad file is isolated and the rest of the cycle continues.
 */
async function pollGoogleDrive() {
    if (!driveConfigured()) {
        status.configured = false;
        status.connected = false;
        status.folderAccessible = false;
        status.lastError = "GOOGLE_DRIVE_CREDENTIALS not set or invalid JSON";
        return;
    }
    status.configured = true;
    let token;
    let files;
    try {
        token = await accessToken();
        files = await listVideoFiles(token);
        status.connected = true;
        status.folderAccessible = true;
        status.known = files.length;
        status.lastError = null;
    }
    catch (err) {
        status.connected = false;
        status.folderAccessible = false;
        status.lastError = err instanceof Error ? err.message : String(err);
        status.lastPollAt = new Date().toISOString();
        console.warn(`[drive-pull] poll failed (auth/list): ${status.lastError}`);
        return;
    }
    const fresh = files.filter((f) => !(0, contentDb_js_1.isDriveFileProcessed)(f.id));
    if (fresh.length)
        console.log(`[drive-pull] ${files.length} video(s) in folder, ${fresh.length} new`);
    for (const file of fresh) {
        try {
            // Disk pre-flight — same reserve the manual upload flow uses.
            const fileMB = Math.ceil((file.size || 0) / (1024 * 1024));
            const neededMB = fileMB + Math.max(fileMB, 200) + PROCESSING_HEADROOM_MB;
            const freeMB = await (0, diskCleanup_js_1.getFreeDiskMB)();
            if (Number.isFinite(freeMB) && freeMB < neededMB) {
                console.warn(`[drive-pull] Skipping "${file.name}" this cycle — need ~${neededMB}MB, ${freeMB}MB free. Will retry next poll.`);
                continue; // NOT marked processed — retried next cycle
            }
            const dest = path_1.default.join(uploadDir(), safeName(file.name));
            await downloadFile(file.id, token, dest);
            // Feed into the EXACT same entry point as a manual upload.
            const session = await (0, ingest_js_1.ingestContent)({
                type: "video",
                path: dest,
                meta: { originalName: file.name, source: "google_drive", driveFileId: file.id },
            });
            await (0, repurpose_js_1.repurposeSession)(session.id);
            (0, contentDb_js_1.markDriveFileProcessed)(file.id, file.name, session.id);
            console.log(`[drive-pull] pulled "${file.name}" → session ${session.id} (Review Queue)`);
        }
        catch (err) {
            // Isolate this file; keep going. It stays unprocessed so a later cycle retries.
            console.error(`[drive-pull] file "${file.name}" (${file.id}) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    status.processed = safeCount();
    status.lastPollAt = new Date().toISOString();
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
