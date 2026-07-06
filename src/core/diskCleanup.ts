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
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

import {
  listAllBatchSourceFileRefs,
  listAllContentVideoFileRefs,
} from "./contentDb.js";

function dataBase(): string {
  return fs.existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
}
export function uploadsRoot(): string {
  return path.join(dataBase(), "uploads");
}
export function uploadsVideosDir(): string {
  return path.join(uploadsRoot(), "videos");
}
export function clipsRoot(): string {
  return path.join(dataBase(), "clips");
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function toMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
function looksLikeDatabase(name: string): boolean {
  return /\.(db|sqlite|sqlite3|db-wal|db-shm)$/i.test(name);
}

// Phase 5c — headroom below which the daily sweep logs a prominent warning.
const LOW_DISK_WARNING_THRESHOLD_MB = 15 * 1024; // 15GB

/**
 * Free space in MB on the volume that holds `dir`. Returns +Infinity if it
 * can't be determined, so callers never block a job on an unknown value.
 */
export async function getFreeDiskMB(dir: string = dataBase()): Promise<number> {
  try {
    const target = fs.existsSync(dir) ? dir : dataBase();
    const s = await fsp.statfs(target);
    return Math.floor((Number(s.bsize) * Number(s.bavail)) / (1024 * 1024));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Fix 1 — delete a source upload after its job has completed successfully. */
export function deleteSourceFile(filePath: string): { deleted: boolean; freedBytes: number } {
  if (!filePath) return { deleted: false, freedBytes: 0 };
  const abs = path.resolve(filePath);
  if (!isInside(abs, uploadsRoot())) {
    console.warn(`[cleanup] Refusing to delete source outside uploads: ${abs}`);
    return { deleted: false, freedBytes: 0 };
  }
  try {
    const st = fs.statSync(abs);
    fs.unlinkSync(abs);
    console.log(`[cleanup] Deleted source file: ${abs} (${toMb(st.size)}MB freed)`);
    logFreeSpaceAfterDeletion();
    return { deleted: true, freedBytes: st.size };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return { deleted: false, freedBytes: 0 }; // already gone
    console.error(`[cleanup] Failed to delete source file ${abs}: ${e?.message || String(err)}`);
    return { deleted: false, freedBytes: 0 };
  }
}

// Phase 5b — fire-and-forget follow-up log so each lifecycle deletion shows
// its effect on headroom, not just the file that was removed. Deliberately
// not awaited by callers (deleteSourceFile/deleteClipFile stay synchronous)
// — this is a log-only side effect, not part of either function's contract.
function logFreeSpaceAfterDeletion(): void {
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
export function deleteClipFile(clipPath: string | null): { deleted: boolean; freedBytes: number } {
  if (!clipPath) return { deleted: false, freedBytes: 0 };
  const abs = path.resolve(clipPath);
  if (!isInside(abs, clipsRoot())) {
    console.warn(`[cleanup] Refusing to delete clip outside clips dir: ${abs}`);
    return { deleted: false, freedBytes: 0 };
  }
  if (looksLikeDatabase(path.basename(abs))) {
    console.warn(`[cleanup] Refusing to delete database-like file: ${abs}`);
    return { deleted: false, freedBytes: 0 };
  }
  try {
    const st = fs.statSync(abs);
    fs.unlinkSync(abs);
    console.log(`[cleanup] Deleted clip: ${abs} (${toMb(st.size)}MB freed)`);
    logFreeSpaceAfterDeletion();
    return { deleted: true, freedBytes: st.size };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return { deleted: false, freedBytes: 0 }; // already cleaned — silent
    console.error(`[cleanup] Failed to delete clip ${abs}: ${e?.message || String(err)}`);
    return { deleted: false, freedBytes: 0 };
  }
}

/**
 * Resolve a stored clip path (absolute, `/clips/...`, or `/openshorts/clips/...`)
 * to a real on-disk path INSIDE the clips dir. Returns null if it can't be
 * located under the clips root (never resolves to anything outside it).
 */
export function resolveClipDiskPath(storedPath: string | null): string | null {
  if (!storedPath || storedPath.startsWith("mock://")) return null;
  const normalized = storedPath.replace(/\\/g, "/");
  const clips = clipsRoot();
  const stripped = normalized.replace(/^\/data\//, "").replace(/^data\//, "");
  const candidates = [
    normalized.startsWith("/openshorts/clips/")
      ? path.join(clips, normalized.replace("/openshorts/clips/", ""))
      : "",
    normalized.startsWith("/clips/") ? path.join(clips, normalized.replace("/clips/", "")) : "",
    storedPath,
    path.join(dataBase(), stripped),
    path.join(clips, path.basename(stripped)),
  ].filter(Boolean);
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (isInside(abs, clips) && fs.existsSync(abs)) return abs;
  }
  return null;
}

/** Convenience: resolve a stored clip path and delete it if found under /data/clips. */
export function deleteClipByStoredPath(storedPath: string | null): { deleted: boolean; freedBytes: number } {
  const abs = resolveClipDiskPath(storedPath);
  if (!abs) return { deleted: false, freedBytes: 0 };
  return deleteClipFile(abs);
}

// Uploads whose job is NOT terminal must be kept (queued/submitted/processing).
const TERMINAL_UPLOAD_STATUSES = new Set(["complete", "failed"]);
// Clip files for videos in these states are still needed (in review, or awaiting
// / at posting — publishVideo hands video.filePath to the uploader). Only
// published/rejected clips (and true orphans) are reclaimable.
const KEEP_CLIP_STATUSES = new Set(["processing", "pending_review", "approved", "scheduled"]);

export interface CleanupCandidate {
  path: string;
  bytes: number;
  ageHours: number;
  reason: string;
}

/**
 * Compute the set of files that are safe to delete right now, using DB state.
 * Pure/read-only — used by both the scheduled safety job and the one-time
 * script (dry-run). `now` is injectable for testing.
 */
export function computeCleanupCandidates(now: number = Date.now()): CleanupCandidate[] {
  const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000; // 24h
  const CLIP_GRACE_MS = 60 * 60 * 1000; // 1h
  const candidates: CleanupCandidate[] = [];

  let sourceRefs: { filePath: string; opusStatus: string }[] = [];
  let videoRefs: { id: string; status: string; filePath: string | null }[] = [];
  try {
    sourceRefs = listAllBatchSourceFileRefs();
  } catch (err) {
    console.error(`[disk-cleanup] Could not read source-file state: ${(err as Error).message}`);
  }
  try {
    videoRefs = listAllContentVideoFileRefs();
  } catch (err) {
    console.error(`[disk-cleanup] Could not read clip state: ${(err as Error).message}`);
  }

  // Protected uploads: absolute paths of source files with a non-terminal job.
  const protectedUploads = new Set(
    sourceRefs
      .filter((s) => !TERMINAL_UPLOAD_STATUSES.has(s.opusStatus))
      .map((s) => path.resolve(s.filePath)),
  );
  // Protected clips: basenames of clip files for videos still needing them.
  // Also protect each clip's editable siblings — the uncaptioned base (_base.mp4)
  // and caption file (_base.ass) the clip editor re-renders from — while the clip
  // is in a KEEP state, so a mid-review edit isn't broken by the daily sweep.
  const protectedClipNames = new Set<string>();
  for (const v of videoRefs) {
    if (!v.filePath || !KEEP_CLIP_STATUSES.has(v.status)) continue;
    const base = path.basename(String(v.filePath).replace(/\\/g, "/"));
    protectedClipNames.add(base);
    const stem = base.replace(/_captioned\.mp4$/i, "").replace(/_vertical\.mp4$/i, "").replace(/\.mp4$/i, "");
    protectedClipNames.add(`${stem}_base.mp4`);
    protectedClipNames.add(`${stem}_base.ass`);
    protectedClipNames.add(`${stem}_base.lines.json`);
  }

  // Uploads sweep
  const uv = uploadsVideosDir();
  if (fs.existsSync(uv)) {
    for (const name of safeReaddir(uv)) {
      const abs = path.join(uv, name);
      const st = safeStat(abs);
      if (!st || !st.isFile()) continue;
      if (protectedUploads.has(path.resolve(abs))) continue; // job still active
      const ageMs = now - st.mtimeMs;
      if (ageMs < UPLOAD_GRACE_MS) continue;
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
  if (fs.existsSync(cr)) {
    for (const jobDir of safeReaddir(cr)) {
      const dirAbs = path.join(cr, jobDir);
      const dirSt = safeStat(dirAbs);
      if (!dirSt || !dirSt.isDirectory()) continue;
      for (const name of safeReaddir(dirAbs)) {
        const abs = path.join(dirAbs, name);
        const st = safeStat(abs);
        if (!st || !st.isFile()) continue;
        if (looksLikeDatabase(name)) continue; // never DBs
        if (protectedClipNames.has(name)) continue; // in review / awaiting post
        const ageMs = now - st.mtimeMs;
        if (ageMs < CLIP_GRACE_MS) continue;
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

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Remove now-empty {jobId} dirs under /data/clips. */
function pruneEmptyClipDirs(): void {
  const cr = clipsRoot();
  if (!fs.existsSync(cr)) return;
  for (const jobDir of safeReaddir(cr)) {
    const dirAbs = path.join(cr, jobDir);
    const st = safeStat(dirAbs);
    if (!st || !st.isDirectory()) continue;
    if (safeReaddir(dirAbs).length === 0) {
      try {
        fs.rmdirSync(dirAbs);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Fix 3 — scheduled state-aware safety sweep for orphaned/leftover files. */
export async function runSafetyDiskCleanup(): Promise<{ deleted: number; freedBytes: number }> {
  const candidates = computeCleanupCandidates();
  let deleted = 0;
  let freed = 0;
  for (const c of candidates) {
    if (!isInside(path.resolve(c.path), uploadsRoot()) && !isInside(path.resolve(c.path), clipsRoot())) {
      continue; // defensive — never delete outside the two roots
    }
    try {
      fs.unlinkSync(c.path);
      deleted++;
      freed += c.bytes;
      console.log(`[disk-cleanup] Deleted (${c.reason}): ${c.path} (${toMb(c.bytes)}MB)`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
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
      pendingReviewCount = listAllContentVideoFileRefs().filter((v) => v.status === "pending_review").length;
    } catch (err) {
      console.error(`[disk-cleanup] Could not count pending-review clips: ${(err as Error).message}`);
    }
    console.warn(
      `[DISK WARNING] /data only ${(freeMB / 1024).toFixed(1)}GB free — review queue has ${pendingReviewCount} clips pending publish. ` +
      `Consider publishing or rejecting clips to free space.`,
    );
  }

  return { deleted, freedBytes: freed };
}
