/**
 * One-time safe disk cleanup for the OpenShorts volume.
 * Self-contained (uses only production deps: better-sqlite3 + fs) so it runs on
 * Fly via:  fly ssh console -a marco-90-automation -C "node scripts/disk-cleanup-now.mjs --dry-run"
 *
 * Flags:
 *   --dry-run   (default) list what WOULD be deleted, with sizes
 *   --execute   actually delete
 *   --data DIR  override the data root (default: /data if present, else ./data)
 *
 * State-aware — mirrors src/core/diskCleanup.ts:
 *   - source uploads: deletable if their job is terminal (complete/failed) or
 *     orphaned (no DB row), AND older than 24h
 *   - clip files: deletable if the owning video is published/rejected or the
 *     file is orphaned (no matching video), AND older than 1h
 *   Never deletes files still needed (queued/processing uploads;
 *   processing/pending_review/approved/scheduled clips) or any DB file.
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const dataFlagIdx = args.indexOf("--data");
const DATA_BASE =
  dataFlagIdx >= 0 && args[dataFlagIdx + 1]
    ? args[dataFlagIdx + 1]
    : fs.existsSync("/data")
      ? "/data"
      : path.join(process.cwd(), "data");

const uploadsVideosDir = path.join(DATA_BASE, "uploads", "videos");
const clipsRoot = path.join(DATA_BASE, "clips");
const dbPath = path.join(DATA_BASE, "content.db");

const TERMINAL_UPLOAD = new Set(["complete", "failed"]);
const KEEP_CLIP = new Set(["processing", "pending_review", "approved", "scheduled"]);
const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;
const CLIP_GRACE_MS = 60 * 60 * 1000;
const isDb = (name) => /\.(db|sqlite|sqlite3|db-wal|db-shm)$/i.test(name);
const mb = (b) => (b / (1024 * 1024)).toFixed(1);
const rd = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const st = (p) => { try { return fs.statSync(p); } catch { return null; } };

// --- Load DB state (best-effort; empty sets if DB missing → treat as orphans) ---
let protectedUploads = new Set();
let protectedClipNames = new Set();
let dbOk = false;
try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  dbOk = true;
  for (const r of db.prepare("SELECT file_path, opus_status FROM cm_batch_source_files").all()) {
    if (r.file_path && !TERMINAL_UPLOAD.has(String(r.opus_status ?? "queued"))) {
      protectedUploads.add(path.resolve(String(r.file_path)));
    }
  }
  for (const r of db.prepare("SELECT status, file_path FROM content_videos").all()) {
    if (r.file_path && KEEP_CLIP.has(String(r.status))) {
      protectedClipNames.add(path.basename(String(r.file_path).replace(/\\/g, "/")));
    }
  }
  db.close();
} catch (e) {
  console.warn(`[disk-cleanup-now] DB not read (${e.message}) — treating all files as orphans by age.`);
}

const now = Date.now();
const candidates = [];

// Uploads
for (const name of rd(uploadsVideosDir)) {
  const abs = path.join(uploadsVideosDir, name);
  const s = st(abs);
  if (!s || !s.isFile()) continue;
  if (protectedUploads.has(path.resolve(abs))) continue;
  const age = now - s.mtimeMs;
  if (age < UPLOAD_GRACE_MS) continue;
  candidates.push({ path: abs, bytes: s.size, ageH: Math.round(age / 3.6e6), reason: "source: terminal/orphan >24h" });
}

// Clips
for (const jobDir of rd(clipsRoot)) {
  const dirAbs = path.join(clipsRoot, jobDir);
  const ds = st(dirAbs);
  if (!ds || !ds.isDirectory()) continue;
  for (const name of rd(dirAbs)) {
    const abs = path.join(dirAbs, name);
    const s = st(abs);
    if (!s || !s.isFile()) continue;
    if (isDb(name)) continue;
    if (protectedClipNames.has(name)) continue;
    const age = now - s.mtimeMs;
    if (age < CLIP_GRACE_MS) continue;
    candidates.push({ path: abs, bytes: s.size, ageH: Math.round(age / 3.6e6), reason: "clip: published/rejected/orphan >1h" });
  }
}

// --- Report ---
console.log(`\n[disk-cleanup-now] data root: ${DATA_BASE}  (DB ${dbOk ? "loaded" : "unavailable"})`);
console.log(`[disk-cleanup-now] mode: ${EXECUTE ? "EXECUTE (deleting)" : "DRY-RUN (no deletions)"}\n`);

let total = 0;
if (candidates.length === 0) {
  console.log("  nothing safe to delete right now.");
} else {
  for (const c of candidates) {
    total += c.bytes;
    const verb = EXECUTE ? "DELETE" : "WOULD DELETE";
    console.log(`  ${verb}  ${mb(c.bytes).padStart(7)}MB  ${String(c.ageH).padStart(4)}h  ${c.reason}`);
    console.log(`           ${c.path}`);
    if (EXECUTE) {
      try { fs.unlinkSync(c.path); } catch (e) { if (e.code !== "ENOENT") console.error(`    FAILED: ${e.message}`); }
    }
  }
}

// Prune empty clip job dirs (execute only)
if (EXECUTE) {
  for (const jobDir of rd(clipsRoot)) {
    const dirAbs = path.join(clipsRoot, jobDir);
    const ds = st(dirAbs);
    if (ds && ds.isDirectory() && rd(dirAbs).length === 0) {
      try { fs.rmdirSync(dirAbs); } catch { /* ignore */ }
    }
  }
}

console.log(`\n[disk-cleanup-now] ${EXECUTE ? "Deleted" : "Would delete"}: ${candidates.length} files, ${mb(total)}MB total`);
if (!EXECUTE && candidates.length) console.log("[disk-cleanup-now] Re-run with --execute to delete.\n");
