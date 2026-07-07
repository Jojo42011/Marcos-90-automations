"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadsRoot = uploadsRoot;
exports.uploadsVideosDir = uploadsVideosDir;
exports.clipsRoot = clipsRoot;
exports.getFreeDiskMB = getFreeDiskMB;
exports.deleteSourceFile = deleteSourceFile;
exports.deleteClipFile = deleteClipFile;
exports.resolveClipDiskPath = resolveClipDiskPath;
exports.deleteClipByStoredPath = deleteClipByStoredPath;
exports.computeCleanupCandidates = computeCleanupCandidates;
exports.runSafetyDiskCleanup = runSafetyDiskCleanup;
/**
 * Disk cleanup for the OpenShorts pipeline volume (/data).
 *
 * The Fly volume accumulates two kinds of files that are safe to reclaim once
 * they are no longer needed:
 *   - source uploads in /data/uploads/videos  (after a job processes them)
 *   - generated clips in /data/clips/{jobId}  (after a clip is published/rejected)
 *
 * This module provides the lifecycle deletions (called at the exact moment a
 * file stops being needed), a state-aware daily safety sweep for orphans, and a
 * pre-job free-space check. It NEVER deletes outside /data/uploads or
 * /data/clips, and never touches database files.
 */
const fs_1 = __importDefault(require("fs"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const contentDb_js_1 = require("./contentDb.js");
function dataBase() {
    return fs_1.default.existsSync("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
}
function uploadsRoot() {
    return path_1.default.join(dataBase(), "uploads");
}
function uploadsVideosDir() {
    return path_1.default.join(uploadsRoot(), "videos");
}
function clipsRoot() {
    return path_1.default.join(dataBase(), "clips");
}
function isInside(child, parent) {
    const rel = path_1.default.relative(path_1.default.resolve(parent), path_1.default.resolve(child));
    return rel.length > 0 && !rel.startsWith("..") && !path_1.default.isAbsolute(rel);
}
function toMb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
}
function looksLikeDatabase(name) {
    return /\.(db|sqlite|sqlite3|db-wal|db-shm)$/i.test(name);
}
// Phase 5c — headroom below which the daily sweep logs a prominent warning.
const LOW_DISK_WARNING_THRESHOLD_MB = 15 * 1024; // 15GB
/**
 * Free space in MB on the volume that holds `dir`. Returns +Infinity if it
 * can't be determined, so callers never block a job on an unknown value.
 */
async function getFreeDiskMB(dir = dataBase()) {
    try {
        const target = fs_1.default.existsSync(dir) ? dir : dataBase();
        const s = await promises_1.default.statfs(target);
        return Math.floor((Number(s.bsize) * Number(s.bavail)) / (1024 * 1024));
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
/** Fix 1 — delete a source upload after its job has completed successfully. */
function deleteSourceFile(filePath) {
    if (!filePath)
        return { deleted: false, freedBytes: 0 };
    const abs = path_1.default.resolve(filePath);
    if (!isInside(abs, uploadsRoot())) {
        console.warn(`[cleanup] Refusing to delete source outside uploads: ${abs}`);
        return { deleted: false, freedBytes: 0 };
    }
    try {
        const st = fs_1.default.statSync(abs);
        fs_1.default.unlinkSync(abs);
        console.log(`[cleanup] Deleted source file: ${abs} (${toMb(st.size)}MB freed)`);
        logFreeSpaceAfterDeletion();
        return { deleted: true, freedBytes: st.size };
    }
    catch (err) {
        const e = err;
        if (e?.code === "ENOENT")
            return { deleted: false, freedBytes: 0 }; // already gone
        console.error(`[cleanup] Failed to delete source file ${abs}: ${e?.message || String(err)}`);
        return { deleted: false, freedBytes: 0 };
    }
}
// Phase 5b — fire-and-forget follow-up log so each lifecycle deletion shows
// its effect on headroom, not just the file that was removed. Deliberately
// not awaited by callers (deleteSourceFile/deleteClipFile stay synchronous)
// — this is a log-only side effect, not part of either function's contract.
function logFreeSpaceAfterDeletion() {
    void getFreeDiskMB().then((freeMB) => {
        if (Number.isFinite(freeMB)) {
            console.log(`[cleanup] /data now has ${(freeMB / 1024).toFixed(1)}GB free`);
        }
    });
}
/**
 * Fix 2 — delete a clip file after it is published or rejected.
 * Pass the resolved on-disk path (server.ts resolveClipFileForVideo).
 */
function deleteClipFile(clipPath) {
    if (!clipPath)
        return { deleted: false, freedBytes: 0 };
    const abs = path_1.default.resolve(clipPath);
    if (!isInside(abs, clipsRoot())) {
        console.warn(`[cleanup] Refusing to delete clip outside clips dir: ${abs}`);
        return { deleted: false, freedBytes: 0 };
    }
    if (looksLikeDatabase(path_1.default.basename(abs))) {
        console.warn(`[cleanup] Refusing to delete database-like file: ${abs}`);
        return { deleted: false, freedBytes: 0 };
    }
    try {
        const st = fs_1.default.statSync(abs);
        fs_1.default.unlinkSync(abs);
        console.log(`[cleanup] Deleted clip: ${abs} (${toMb(st.size)}MB freed)`);
        logFreeSpaceAfterDeletion();
        return { deleted: true, freedBytes: st.size };
    }
    catch (err) {
        const e = err;
        if (e?.code === "ENOENT")
            return { deleted: false, freedBytes: 0 }; // already cleaned — silent
        console.error(`[cleanup] Failed to delete clip ${abs}: ${e?.message || String(err)}`);
        return { deleted: false, freedBytes: 0 };
    }
}
/**
 * Resolve a stored clip path (absolute, `/clips/...`, or `/openshorts/clips/...`)
 * to a real on-disk path INSIDE the clips dir. Returns null if it can't be
 * located under the clips root (never resolves to anything outside it).
 */
function resolveClipDiskPath(storedPath) {
    if (!storedPath || storedPath.startsWith("mock://"))
        return null;
    const normalized = storedPath.replace(/\\/g, "/");
    const clips = clipsRoot();
    const stripped = normalized.replace(/^\/data\//, "").replace(/^data\//, "");
    const candidates = [
        normalized.startsWith("/openshorts/clips/")
            ? path_1.default.join(clips, normalized.replace("/openshorts/clips/", ""))
            : "",
        normalized.startsWith("/clips/") ? path_1.default.join(clips, normalized.replace("/clips/", "")) : "",
        storedPath,
        path_1.default.join(dataBase(), stripped),
        path_1.default.join(clips, path_1.default.basename(stripped)),
    ].filter(Boolean);
    for (const c of candidates) {
        const abs = path_1.default.resolve(c);
        if (isInside(abs, clips) && fs_1.default.existsSync(abs))
            return abs;
    }
    return null;
}
/** Convenience: resolve a stored clip path and delete it if found under /data/clips. */
function deleteClipByStoredPath(storedPath) {
    const abs = resolveClipDiskPath(storedPath);
    if (!abs)
        return { deleted: false, freedBytes: 0 };
    return deleteClipFile(abs);
}
// Uploads whose job is NOT terminal must be kept (queued/submitted/processing).
const TERMINAL_UPLOAD_STATUSES = new Set(["complete", "failed"]);
// Clip files for videos in these states are still needed (in review, or awaiting
// / at posting — publishVideo hands video.filePath to the uploader). Only
// published/rejected clips (and true orphans) are reclaimable.
// "submitted" = handed to Upload-Post but not yet confirmed live, so its file
// must be kept until publishing is genuinely confirmed (or fails).
const KEEP_CLIP_STATUSES = new Set(["processing", "pending_review", "approved", "scheduled", "submitted"]);
/**
 * Compute the set of files that are safe to delete right now, using DB state.
 * Pure/read-only — used by both the scheduled safety job and the one-time
 * script (dry-run). `now` is injectable for testing.
 */
function computeCleanupCandidates(now = Date.now()) {
    const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000; // 24h
    const CLIP_GRACE_MS = 60 * 60 * 1000; // 1h
    const candidates = [];
    let sourceRefs = [];
    let videoRefs = [];
    try {
        sourceRefs = (0, contentDb_js_1.listAllBatchSourceFileRefs)();
    }
    catch (err) {
        console.error(`[disk-cleanup] Could not read source-file state: ${err.message}`);
    }
    try {
        videoRefs = (0, contentDb_js_1.listAllContentVideoFileRefs)();
    }
    catch (err) {
        console.error(`[disk-cleanup] Could not read clip state: ${err.message}`);
    }
    // Protected uploads: absolute paths of source files with a non-terminal job.
    const protectedUploads = new Set(sourceRefs
        .filter((s) => !TERMINAL_UPLOAD_STATUSES.has(s.opusStatus))
        .map((s) => path_1.default.resolve(s.filePath)));
    // Protected clips: basenames of clip files for videos still needing them.
    // Also protect each clip's editable siblings — the uncaptioned base (_base.mp4)
    // and caption file (_base.ass) the clip editor re-renders from — while the clip
    // is in a KEEP state, so a mid-review edit isn't broken by the daily sweep.
    const protectedClipNames = new Set();
    for (const v of videoRefs) {
        if (!v.filePath || !KEEP_CLIP_STATUSES.has(v.status))
            continue;
        const base = path_1.default.basename(String(v.filePath).replace(/\\/g, "/"));
        protectedClipNames.add(base);
        const stem = base.replace(/_captioned\.mp4$/i, "").replace(/_vertical\.mp4$/i, "").replace(/\.mp4$/i, "");
        protectedClipNames.add(`${stem}_base.mp4`);
        protectedClipNames.add(`${stem}_base.ass`);
        protectedClipNames.add(`${stem}_base.lines.json`);
    }
    // Also protect retained prior-version clip files (revert targets) while their
    // clip is still in a KEEP state — reclaimed once the clip is published/rejected.
    const keepVideoIds = new Set(videoRefs.filter((v) => KEEP_CLIP_STATUSES.has(v.status)).map((v) => v.id));
    try {
        for (const ref of (0, contentDb_js_1.listClipVersionFileRefs)()) {
            if (keepVideoIds.has(ref.videoId) && ref.filePath) {
                protectedClipNames.add(path_1.default.basename(String(ref.filePath).replace(/\\/g, "/")));
            }
        }
    }
    catch (err) {
        console.error(`[disk-cleanup] Could not read clip-version refs: ${err.message}`);
    }
    // Uploads sweep
    const uv = uploadsVideosDir();
    if (fs_1.default.existsSync(uv)) {
        for (const name of safeReaddir(uv)) {
            const abs = path_1.default.join(uv, name);
            const st = safeStat(abs);
            if (!st || !st.isFile())
                continue;
            if (protectedUploads.has(path_1.default.resolve(abs)))
                continue; // job still active
            const ageMs = now - st.mtimeMs;
            if (ageMs < UPLOAD_GRACE_MS)
                continue;
            candidates.push({
                path: abs,
                bytes: st.size,
                ageHours: Math.round(ageMs / 3_600_000),
                reason: "source: job terminal/orphan, >24h",
            });
        }
    }
    // Clips sweep — /data/clips/{jobId}/{file}
    const cr = clipsRoot();
    if (fs_1.default.existsSync(cr)) {
        for (const jobDir of safeReaddir(cr)) {
            const dirAbs = path_1.default.join(cr, jobDir);
            const dirSt = safeStat(dirAbs);
            if (!dirSt || !dirSt.isDirectory())
                continue;
            for (const name of safeReaddir(dirAbs)) {
                const abs = path_1.default.join(dirAbs, name);
                const st = safeStat(abs);
                if (!st || !st.isFile())
                    continue;
                if (looksLikeDatabase(name))
                    continue; // never DBs
                if (protectedClipNames.has(name))
                    continue; // in review / awaiting post
                const ageMs = now - st.mtimeMs;
                if (ageMs < CLIP_GRACE_MS)
                    continue;
                candidates.push({
                    path: abs,
                    bytes: st.size,
                    ageHours: Math.round(ageMs / 3_600_000),
                    reason: "clip: published/rejected/orphan, >1h",
                });
            }
        }
    }
    return candidates;
}
function safeReaddir(dir) {
    try {
        return fs_1.default.readdirSync(dir);
    }
    catch {
        return [];
    }
}
function safeStat(p) {
    try {
        return fs_1.default.statSync(p);
    }
    catch {
        return null;
    }
}
/** Remove now-empty {jobId} dirs under /data/clips. */
function pruneEmptyClipDirs() {
    const cr = clipsRoot();
    if (!fs_1.default.existsSync(cr))
        return;
    for (const jobDir of safeReaddir(cr)) {
        const dirAbs = path_1.default.join(cr, jobDir);
        const st = safeStat(dirAbs);
        if (!st || !st.isDirectory())
            continue;
        if (safeReaddir(dirAbs).length === 0) {
            try {
                fs_1.default.rmdirSync(dirAbs);
            }
            catch {
                /* ignore */
            }
        }
    }
}
/** Fix 3 — scheduled state-aware safety sweep for orphaned/leftover files. */
async function runSafetyDiskCleanup() {
    const candidates = computeCleanupCandidates();
    let deleted = 0;
    let freed = 0;
    for (const c of candidates) {
        if (!isInside(path_1.default.resolve(c.path), uploadsRoot()) && !isInside(path_1.default.resolve(c.path), clipsRoot())) {
            continue; // defensive — never delete outside the two roots
        }
        try {
            fs_1.default.unlinkSync(c.path);
            deleted++;
            freed += c.bytes;
            console.log(`[disk-cleanup] Deleted (${c.reason}): ${c.path} (${toMb(c.bytes)}MB)`);
        }
        catch (err) {
            const e = err;
            if (e?.code !== "ENOENT") {
                console.error(`[disk-cleanup] Failed to delete ${c.path}: ${e?.message || String(err)}`);
            }
        }
    }
    pruneEmptyClipDirs();
    const freedMB = Math.round(freed / (1024 * 1024));
    console.log(`[disk-cleanup] Complete: ${deleted} files deleted, ${freedMB}MB freed`);
    const freeMB = await getFreeDiskMB();
    console.log(`[disk-cleanup] /data free space: ${Number.isFinite(freeMB) ? freeMB : "unknown"}MB`);
    // Phase 5c — warn before it becomes an error: the cleanup lifecycle only
    // reclaims space once clips are actioned, so a review queue that's
    // backing up (nobody publishing/rejecting) will still slowly starve the
    // volume even with cleanup running correctly. Surface that early.
    if (Number.isFinite(freeMB) && freeMB < LOW_DISK_WARNING_THRESHOLD_MB) {
        let pendingReviewCount = 0;
        try {
            pendingReviewCount = (0, contentDb_js_1.listAllContentVideoFileRefs)().filter((v) => v.status === "pending_review").length;
        }
        catch (err) {
            console.error(`[disk-cleanup] Could not count pending-review clips: ${err.message}`);
        }
        console.warn(`[DISK WARNING] /data only ${(freeMB / 1024).toFixed(1)}GB free — review queue has ${pendingReviewCount} clips pending publish. ` +
            `Consider publishing or rejecting clips to free space.`);
    }
    return { deleted, freedBytes: freed };
}
