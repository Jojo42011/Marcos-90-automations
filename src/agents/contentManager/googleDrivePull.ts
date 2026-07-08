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
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { GoogleAuth } from "google-auth-library";
import { getFreeDiskMB } from "../../core/diskCleanup.js";
import { ingestContent } from "./ingest.js";
import { repurposeSession } from "./repurpose.js";
import {
  isDriveFileProcessed,
  markDriveFileProcessed,
  countDriveProcessed,
  listDriveProcessed,
  getDriveState,
  setDriveLastPollAt,
  setDriveLastPullDate,
  todayDateCst,
} from "../../core/contentDb.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DEFAULT_FOLDER_ID = "1SQMevfe1HKLhRaqzGBg-ZN7LbQzEBV92";
const POLL_INTERVAL_MS = 30 * 60 * 1000; // every 30 min
const STARTUP_DELAY_MS = 90 * 1000; // let the server settle before the first poll
// Headroom mirrors the manual upload flow (UPLOAD_PROCESSING_HEADROOM_MB = 500):
// reserve space for the source file, its clips, and processing scratch.
const PROCESSING_HEADROOM_MB = 500;

function folderId(): string {
  return process.env.GOOGLE_DRIVE_FOLDER_ID?.trim() || DEFAULT_FOLDER_ID;
}

export function driveConfigured(): boolean {
  const raw = process.env.GOOGLE_DRIVE_CREDENTIALS?.trim();
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed && parsed.client_email && parsed.private_key);
  } catch {
    return false;
  }
}

interface DriveStatus {
  configured: boolean;
  connected: boolean;
  folderAccessible: boolean;
  lastPollAt: string | null;
  lastPullDate: string | null; // calendar day (CST) a file was last actually pulled
  lastError: string | null;
  known: number; // video files currently visible in the folder
  processed: number; // total pulled + handed off so far
  pending: number; // detected in folder but not yet pulled
  pulledToday: boolean; // whether the one-per-day pull already happened today
  lastPullResult: "success" | "failed" | null; // outcome of the last pull ATTEMPT
  lastPullFile: string | null; // file the last attempt targeted
  lastPullError: string | null; // real error from the last failed pull (download/ingest/clip)
  lastAttemptAt: string | null; // when the last pull attempt ran
  processedFiles?: Array<{ fileId: string; name: string; processedAt: string }>;
}

// Health/connectivity of the last cycle (in-memory); poll/pull timestamps and the
// processed set are read from the DB so they survive restarts.
const runtime = {
  connected: false,
  folderAccessible: false,
  lastError: null as string | null,
  known: 0,
  lastPullResult: null as "success" | "failed" | null,
  lastPullFile: null as string | null,
  lastPullError: null as string | null,
  lastAttemptAt: null as string | null,
};

export function getDriveStatus(): DriveStatus {
  const persisted = safeState();
  const today = safeToday();
  return {
    configured: driveConfigured(),
    connected: runtime.connected,
    folderAccessible: runtime.folderAccessible,
    lastPollAt: persisted.lastPollAt,
    lastPullDate: persisted.lastPullDate,
    lastError: runtime.lastError,
    known: runtime.known,
    processed: safeCount(),
    pending: Math.max(0, runtime.known - safeCount()),
    pulledToday: Boolean(persisted.lastPullDate && persisted.lastPullDate === today),
    lastPullResult: runtime.lastPullResult,
    lastPullFile: runtime.lastPullFile,
    lastPullError: runtime.lastPullError,
    lastAttemptAt: runtime.lastAttemptAt,
    processedFiles: safeProcessedList(),
  };
}

function safeCount(): number {
  try {
    return countDriveProcessed();
  } catch {
    return 0;
  }
}
function safeState(): { lastPollAt: string | null; lastPullDate: string | null } {
  try {
    return getDriveState();
  } catch {
    return { lastPollAt: null, lastPullDate: null };
  }
}
function safeProcessedList(): Array<{ fileId: string; name: string; processedAt: string }> {
  try {
    return listDriveProcessed();
  } catch {
    return [];
  }
}
function safeToday(): string {
  try {
    return todayDateCst();
  } catch {
    return "";
  }
}

let auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!auth) {
    const credentials = JSON.parse(process.env.GOOGLE_DRIVE_CREDENTIALS as string);
    auth = new GoogleAuth({ credentials, scopes: [DRIVE_SCOPE] });
  }
  return auth;
}

async function accessToken(): Promise<string> {
  const client = await getAuth().getClient();
  const t = await client.getAccessToken();
  const token = typeof t === "string" ? t : t?.token;
  if (!token) throw new Error("Google Drive: could not obtain an access token from the service account");
  return token;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number; // bytes (0 if Drive didn't report it)
  createdTime: string; // RFC3339 — used to sort oldest-first
}

async function listVideoFiles(token: string): Promise<DriveFile[]> {
  const q = `'${folderId()}' in parents and trashed = false and mimeType contains 'video/'`;
  const url =
    `https://www.googleapis.com/drive/v3/files?` +
    `q=${encodeURIComponent(q)}` +
    `&fields=${encodeURIComponent("files(id,name,mimeType,size,createdTime)")}` +
    `&pageSize=1000&orderBy=createdTime` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drive files.list failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { files?: Array<Record<string, unknown>> };
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

function uploadDir(): string {
  const base = fs.existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
  const dir = path.join(base, "uploads", "videos");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name: string): string {
  // Keep the extension, strip anything path-ish; matches the manual upload's
  // "<timestamp>-<uuid><ext>" spirit while staying readable.
  const cleaned = name.replace(/[/\\]/g, "_").replace(/[^\w.\- ]/g, "").trim() || "drive-video";
  return `drive-${Date.now()}-${cleaned}`;
}

async function downloadFile(fileId: string, token: string, destPath: string): Promise<void> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) {
    const body = res.body ? await res.text().catch(() => "") : "";
    throw new Error(`Drive download failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  // Stream to disk — never buffer a multi-GB video in memory.
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(destPath));
}

let pollInFlight = false;

/**
 * One poll cycle. Checks the folder (cheap, every 30 min) but PULLS at most ONE
 * file per calendar day — the oldest unprocessed video by Drive creation time.
 * Never throws; a bad file is isolated. `force` (manual "poll now") bypasses the
 * once-a-day throttle to pull the single oldest file immediately for testing.
 * last_poll_at is recorded on EVERY cycle, whether or not a file was pulled.
 */
export async function pollGoogleDrive(opts?: { force?: boolean }): Promise<void> {
  const force = Boolean(opts?.force);
  if (pollInFlight) {
    console.log("[drive-pull] a poll is already running — skipping this tick");
    return;
  }
  pollInFlight = true;
  const stampPoll = () => {
    try {
      setDriveLastPollAt(new Date().toISOString());
    } catch {
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

    let token: string;
    let files: DriveFile[];
    try {
      token = await accessToken();
      files = await listVideoFiles(token);
      runtime.connected = true;
      runtime.folderAccessible = true;
      runtime.known = files.length;
      runtime.lastError = null;
    } catch (err) {
      runtime.connected = false;
      runtime.folderAccessible = false;
      runtime.lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[drive-pull] poll failed (auth/list): ${runtime.lastError}`);
      stampPoll();
      return;
    }

    // Oldest unprocessed first (listVideoFiles already sorts by createdTime).
    const fresh = files.filter((f) => !isDriveFileProcessed(f.id));

    // One-per-day throttle: if a file was already pulled today, only check —
    // don't pull again (unless this is a forced manual poll).
    const today = todayDateCst();
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
      const freeMB = await getFreeDiskMB();
      if (Number.isFinite(freeMB) && freeMB < neededMB) {
        const msg = `Not enough disk: need ~${neededMB}MB, ${freeMB}MB free`;
        console.warn(`[drive-pull] Skipping "${file.name}" — ${msg}. Will retry next cycle (day not consumed).`);
        runtime.lastPullResult = "failed";
        runtime.lastPullError = msg;
        stampPoll();
        return; // NOT marked processed and day NOT consumed — retried next cycle
      }

      const dest = path.join(uploadDir(), safeName(file.name));
      await downloadFile(file.id, token, dest);

      // Feed into the EXACT same entry point as a manual upload → OpenShorts →
      // Review Queue (fully automatic; only the final approve/reject is manual).
      const session = await ingestContent({
        type: "video",
        path: dest,
        meta: { originalName: file.name, source: "google_drive", driveFileId: file.id },
      });
      await repurposeSession(session.id);

      markDriveFileProcessed(file.id, file.name, session.id);
      setDriveLastPullDate(today); // consume today's one-per-day slot only on success
      runtime.lastPullResult = "success";
      runtime.lastPullError = null;
      console.log(`[drive-pull] pulled oldest "${file.name}" → session ${session.id} (Review Queue). ${fresh.length - 1} remaining.`);
    } catch (err) {
      // Isolate the failure; day NOT consumed so the next cycle retries this file.
      // Surface the real reason in status so it isn't invisible.
      const msg = err instanceof Error ? err.message : String(err);
      runtime.lastPullResult = "failed";
      runtime.lastPullError = msg;
      console.error(`[drive-pull] file "${file.name}" (${file.id}) failed: ${msg}`);
    }

    stampPoll();
  } finally {
    pollInFlight = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Start the 30-minute Drive poll loop (first run shortly after startup). */
export function scheduleGoogleDrivePoller(): void {
  const run = () => {
    void pollGoogleDrive().catch((err) =>
      console.error(`[drive-pull] unexpected: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  setTimeout(run, STARTUP_DELAY_MS);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(run, POLL_INTERVAL_MS);
  console.log(
    driveConfigured()
      ? "[drive-pull] scheduled (every 30 min)"
      : "[drive-pull] scheduled (every 30 min) — idle until GOOGLE_DRIVE_CREDENTIALS is set",
  );
}
