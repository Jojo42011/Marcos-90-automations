/**
 * SmartPoster — account-local queue, calendar posts, Drive settings.
 *
 * Editors drop videos in a connected Drive folder named:
 *   YYYY-MM-DD__platform__slug.mp4
 *   platform = tiktok | instagram | facebook | youtube | all
 * Optional sidecar JSON with the same stem: { caption?, title?, platforms?[] }
 *
 * Imports draft captions into an unscheduled inbox. Operators explicitly choose
 * the time and target accounts before scheduling through Zernio.
 */
import { dataPath } from "./tenantData.js";
import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import path from "path";

export type SmartPosterStatus =
  | "inbox"
  | "draft"
  | "ready"
  | "scheduled"
  | "published"
  | "failed"
  | "skipped";

export interface SmartPosterSettings {
  driveFolderId: string;
  driveFolderName: string;
  timezone: string;
  /** HH:MM local times used to space posts across the day. */
  slots: string[];
  /** Legacy field retained for compatibility; always false. */
  autoSchedule: boolean;
  /** Local hour (0-23) when the daily Drive pull runs. */
  ingestHour: number;
  /** Zero = daily at ingestHour; otherwise repeat after this many minutes. */
  ingestIntervalMinutes: number;
  lastSuccessfulSyncAt: string | null;
  lastAutoAttemptAt: string | null;
  lastSyncAt: string | null;
  lastSyncNote: string | null;
}

export interface SmartPosterDriveAuth {
  connected: boolean;
  email: string | null;
  updatedAt: string | null;
}

export interface SmartPosterPost {
  id: string;
  driveFileId: string | null;
  fileName: string;
  title: string;
  caption: string;
  platforms: string[];
  accountIds: string[];
  status: SmartPosterStatus;
  targetDate: string | null;
  scheduledFor: string | null;
  timezone: string;
  mediaUrl: string | null;
  zernioPostId: string | null;
  platformPostUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_SLOTS = ["09:00", "12:30", "16:00", "19:00"];

function resolveDbPath(): string {
  if (existsSync(dataPath(""))) return dataPath("smart-poster.db");
  const localDir = dataPath();
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "smart-poster.db");
}

let db: Database.Database | null = null;

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS smart_poster_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smart_poster_drive (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT,
      secret TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smart_poster_posts (
      id TEXT PRIMARY KEY,
      drive_file_id TEXT,
      file_name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      platforms TEXT NOT NULL DEFAULT '[]',
      account_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      target_date TEXT,
      scheduled_for TEXT,
      timezone TEXT NOT NULL,
      media_url TEXT,
      zernio_post_id TEXT,
      platform_post_url TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sp_posts_status ON smart_poster_posts(status);
    CREATE INDEX IF NOT EXISTS idx_sp_posts_scheduled ON smart_poster_posts(scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_sp_posts_drive ON smart_poster_posts(drive_file_id);
  `);
}

export function getSmartPosterDb(): Database.Database {
  if (db) return db;
  db = new Database(resolveDbPath());
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

function defaultSettings(): SmartPosterSettings {
  return {
    driveFolderId: "",
    driveFolderName: "SmartPoster",
    timezone: "America/Chicago",
    slots: [...DEFAULT_SLOTS],
    autoSchedule: false,
    ingestHour: 7,
    ingestIntervalMinutes: 0,
    lastSuccessfulSyncAt: null,
    lastAutoAttemptAt: null,
    lastSyncAt: null,
    lastSyncNote: null,
  };
}

export function getSettings(): SmartPosterSettings {
  const row = getSmartPosterDb()
    .prepare("SELECT body FROM smart_poster_settings WHERE id = 1")
    .get() as { body: string } | undefined;
  if (!row) return defaultSettings();
  try {
    const parsed = JSON.parse(row.body) as Partial<SmartPosterSettings>;
    const base = defaultSettings();
    return {
      ...base,
      ...parsed,
      slots: Array.isArray(parsed.slots) && parsed.slots.length
        ? parsed.slots.map((s) => String(s)).filter(Boolean)
        : base.slots,
      timezone: String(parsed.timezone || base.timezone),
      autoSchedule: false, // Imports are review-only; never auto-publish existing settings.
      ingestHour: Number.isFinite(Number(parsed.ingestHour))
        ? Math.min(23, Math.max(0, Math.floor(Number(parsed.ingestHour))))
        : base.ingestHour,
    };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(patch: Partial<SmartPosterSettings>): SmartPosterSettings {
  const current = getSettings();
  const next: SmartPosterSettings = {
    ...current,
    ...patch,
    autoSchedule: false,
    slots: Array.isArray(patch.slots)
      ? patch.slots.map((s) => String(s).trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s))
      : current.slots,
  };
  new Intl.DateTimeFormat("en-US", {timeZone:next.timezone}).format(new Date());
  if (!Number.isInteger(next.ingestHour) || next.ingestHour < 0 || next.ingestHour > 23) throw new Error("Import hour must be a whole number from 0 to 23.");
  if (![0,15,60,240,720].includes(next.ingestIntervalMinutes)) throw new Error("Choose a supported import cadence.");
  if (!next.slots.length) next.slots = [...DEFAULT_SLOTS];
  getSmartPosterDb()
    .prepare(
      "INSERT INTO smart_poster_settings (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
    )
    .run(JSON.stringify(next));
  return next;
}

function vaultKey(): Buffer | null {
  const hex = process.env.HARVEY_VAULT_KEY?.trim() || "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

function sealSecret(value: unknown): string {
  const key = vaultKey();
  if (!key) throw new Error("HARVEY_VAULT_KEY is required to store Google Drive credentials");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ciphertext]).toString("base64");
}

function unsealSecret<T>(value: string): T {
  const key = vaultKey();
  if (!key) throw new Error("HARVEY_VAULT_KEY is required to read Google Drive credentials");
  const b = Buffer.from(value, "base64");
  const c = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  c.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([c.update(b.subarray(28)), c.final()]).toString()) as T;
}

export function getDriveAuth(): SmartPosterDriveAuth {
  const row = getSmartPosterDb()
    .prepare("SELECT email, updated_at FROM smart_poster_drive WHERE id = 1")
    .get() as { email: string | null; updated_at: string } | undefined;
  if (!row) return { connected: false, email: null, updatedAt: null };
  return { connected: true, email: row.email, updatedAt: row.updated_at };
}

export function saveDriveTokens(tokens: Record<string, unknown>, email: string | null): void {
  const secret = sealSecret(tokens);
  getSmartPosterDb()
    .prepare(
      `INSERT INTO smart_poster_drive (id, email, secret, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, secret = excluded.secret, updated_at = excluded.updated_at`,
    )
    .run(email, secret, new Date().toISOString());
}

export function readDriveTokens(): Record<string, unknown> | null {
  const row = getSmartPosterDb()
    .prepare("SELECT secret FROM smart_poster_drive WHERE id = 1")
    .get() as { secret: string } | undefined;
  if (!row) return null;
  try {
    return unsealSecret(row.secret);
  } catch {
    return null;
  }
}

export function clearDriveAuth(): void {
  getSmartPosterDb().prepare("DELETE FROM smart_poster_drive WHERE id = 1").run();
}

function mapPost(row: Record<string, unknown>): SmartPosterPost {
  return {
    id: String(row.id),
    driveFileId: row.drive_file_id != null ? String(row.drive_file_id) : null,
    fileName: String(row.file_name || ""),
    title: String(row.title || ""),
    caption: String(row.caption || ""),
    platforms: JSON.parse(String(row.platforms || "[]")) as string[],
    accountIds: JSON.parse(String(row.account_ids || "[]")) as string[],
    status: String(row.status) as SmartPosterStatus,
    targetDate: row.target_date != null ? String(row.target_date) : null,
    scheduledFor: row.scheduled_for != null ? String(row.scheduled_for) : null,
    timezone: String(row.timezone || "America/Chicago"),
    mediaUrl: row.media_url != null ? String(row.media_url) : null,
    zernioPostId: row.zernio_post_id != null ? String(row.zernio_post_id) : null,
    platformPostUrl: row.platform_post_url != null ? String(row.platform_post_url) : null,
    error: row.error != null ? String(row.error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listPosts(opts?: {
  status?: SmartPosterStatus | SmartPosterStatus[];
  from?: string;
  to?: string;
  limit?: number;
}): SmartPosterPost[] {
  const limit = opts?.limit === 0 ? Infinity : Math.min(500, Math.max(1, opts?.limit || 200));
  const rows = getSmartPosterDb()
    .prepare(
      `SELECT * FROM smart_poster_posts
       ORDER BY COALESCE(scheduled_for, target_date, created_at) ASC`,
    )
    .all() as Record<string, unknown>[];
  let posts = rows.map(mapPost);
  if (opts?.status) {
    const set = new Set(Array.isArray(opts.status) ? opts.status : [opts.status]);
    posts = posts.filter((p) => set.has(p.status));
  }
  if (opts?.from) posts = posts.filter((p) => (p.scheduledFor || p.targetDate || "") >= opts.from!);
  if (opts?.to) posts = posts.filter((p) => (p.scheduledFor || p.targetDate || "") <= opts.to!);
  return posts.slice(0, limit);
}

export function getPost(id: string): SmartPosterPost | null {
  const row = getSmartPosterDb()
    .prepare("SELECT * FROM smart_poster_posts WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapPost(row) : null;
}

export function findByDriveFileId(driveFileId: string): SmartPosterPost | null {
  const row = getSmartPosterDb()
    .prepare("SELECT * FROM smart_poster_posts WHERE drive_file_id = ?")
    .get(driveFileId) as Record<string, unknown> | undefined;
  return row ? mapPost(row) : null;
}

export function upsertPost(
  input: Partial<SmartPosterPost> & { fileName: string; status: SmartPosterStatus },
): SmartPosterPost {
  const now = new Date().toISOString();
  const existing = input.id
    ? getPost(input.id)
    : input.driveFileId
      ? findByDriveFileId(input.driveFileId)
      : null;
  const id = existing?.id || input.id || randomUUID();
  const post: SmartPosterPost = {
    id,
    driveFileId: input.driveFileId ?? existing?.driveFileId ?? null,
    fileName: input.fileName || existing?.fileName || "",
    title: input.title ?? existing?.title ?? "",
    caption: input.caption ?? existing?.caption ?? "",
    platforms: input.platforms ?? existing?.platforms ?? [],
    accountIds: input.accountIds ?? existing?.accountIds ?? [],
    status: input.status || existing?.status || "inbox",
    targetDate: input.targetDate !== undefined ? input.targetDate : existing?.targetDate ?? null,
    scheduledFor:
      input.scheduledFor !== undefined ? input.scheduledFor : existing?.scheduledFor ?? null,
    timezone: input.timezone || existing?.timezone || getSettings().timezone,
    mediaUrl: input.mediaUrl !== undefined ? input.mediaUrl : existing?.mediaUrl ?? null,
    zernioPostId:
      input.zernioPostId !== undefined ? input.zernioPostId : existing?.zernioPostId ?? null,
    platformPostUrl:
      input.platformPostUrl !== undefined
        ? input.platformPostUrl
        : existing?.platformPostUrl ?? null,
    error: input.error !== undefined ? input.error : existing?.error ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  getSmartPosterDb()
    .prepare(
      `INSERT INTO smart_poster_posts (
        id, drive_file_id, file_name, title, caption, platforms, account_ids,
        status, target_date, scheduled_for, timezone, media_url, zernio_post_id,
        platform_post_url, error, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        drive_file_id=excluded.drive_file_id,
        file_name=excluded.file_name,
        title=excluded.title,
        caption=excluded.caption,
        platforms=excluded.platforms,
        account_ids=excluded.account_ids,
        status=excluded.status,
        target_date=excluded.target_date,
        scheduled_for=excluded.scheduled_for,
        timezone=excluded.timezone,
        media_url=excluded.media_url,
        zernio_post_id=excluded.zernio_post_id,
        platform_post_url=excluded.platform_post_url,
        error=excluded.error,
        updated_at=excluded.updated_at`,
    )
    .run(
      post.id,
      post.driveFileId,
      post.fileName,
      post.title,
      post.caption,
      JSON.stringify(post.platforms),
      JSON.stringify(post.accountIds),
      post.status,
      post.targetDate,
      post.scheduledFor,
      post.timezone,
      post.mediaUrl,
      post.zernioPostId,
      post.platformPostUrl,
      post.error,
      post.createdAt,
      post.updatedAt,
    );
  return post;
}

export function deletePost(id: string): boolean {
  const r = getSmartPosterDb().prepare("DELETE FROM smart_poster_posts WHERE id = ?").run(id);
  return r.changes > 0;
}

/** Local calendar YYYY-MM-DD for a timezone. */
export function localDateISO(tz = getSettings().timezone, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Build an ISO instant for date + HH:MM in the given timezone. */
export function zonedDateTimeToIso(date: string, hm: string, tz: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hm.split(":").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(utcGuess)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = asUtc - utcGuess;
  return new Date(utcGuess - offset).toISOString();
}

export function nextOpenSlot(
  date: string,
  occupiedIso: string[],
  slots = getSettings().slots,
  tz = getSettings().timezone,
): string | null {
  const occupied = new Set(occupiedIso.map((s) => s.slice(0, 16)));
  for (const slot of slots) {
    const iso = zonedDateTimeToIso(date, slot, tz);
    if (!occupied.has(iso.slice(0, 16))) return iso;
  }
  /* Overflow: space 45 minutes after the last slot. */
  if (!slots.length) return null;
  const last = zonedDateTimeToIso(date, slots[slots.length - 1], tz);
  let t = Date.parse(last) + 45 * 60_000;
  while (occupied.has(new Date(t).toISOString().slice(0, 16))) t += 45 * 60_000;
  return new Date(t).toISOString();
}
