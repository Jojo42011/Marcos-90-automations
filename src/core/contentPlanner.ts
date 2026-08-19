/**
 * The content planner — the editorial calendar behind /content-planner.
 *
 * HOW THIS DIFFERS FROM THE CALENDAR ALREADY IN THE CONTENT MANAGER. That one
 * is a REPORT: it reads content_videos / content_publish_log and shows what was
 * actually filmed and published, seven slots a day. It is read-only by design
 * and it cannot hold an idea, because an idea has no video file.
 *
 * This is the other half — the PLAN. A planner item is a piece of content that
 * is intended, not necessarily made: a title, a hook, a caption, a script, the
 * platforms it is going out on, who owns it, and when. Crucially an item may
 * have NO date at all, which is the whole backlog / scratchpad model: capture
 * the idea now, place it on a day later.
 *
 * TIME IS A LITERAL WALL CLOCK. `scheduled_date` ("2026-08-20") and
 * `scheduled_time` ("09:00") are the source of truth for what a card says and
 * which cell it sits in. A post typed as August 15 at 10:00 AM is August 15 at
 * 10:00 AM on every screen in every country, full stop — no anchor zone, no
 * ±1d badge, no conversion at render time.
 *
 * WHY THIS REPLACED THE UTC MODEL. The original design stored a UTC instant and
 * re-derived the day cell from a configurable "grid anchor" zone, which was
 * correct for a team publishing to one audience clock — and wrong for how this
 * team actually works, where a date on the calendar is an editorial decision,
 * not an instant. Under the old model the same card could sit on two different
 * days for two people looking at the same screen. It cannot now.
 *
 * `scheduled_at_utc` is still written, DERIVED from the literal wall clock in
 * `authored_tz`. Nothing reads it for display or placement; it is kept so an
 * auto-publish integration has an instant to fire on, and so no data is thrown
 * away by this change. If the two ever disagree, the literal columns win.
 *
 * Own database file, per the repo convention — the planner is its own
 * subsystem and does not belong inside the content pipeline's tables.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";

import {
  dateKeyDiff,
  isValidTimeZone,
  shiftDateKey,
  zonedDateKey,
  zonedTimeInput,
  zonedWallToUtc,
} from "./zonedTime.js";

/* ────────────────────────── vocabulary ────────────────────────── */

/** Fallback colour for an item with no category — the planner's own teal. */
export const DEFAULT_ITEM_COLOR = "#06B6D4";

export type BacklogStatus = "brainstorm" | "drafting" | "ready";
export const BACKLOG_STATUSES: BacklogStatus[] = ["brainstorm", "drafting", "ready"];
export const BACKLOG_STATUS_LABELS: Record<BacklogStatus, string> = {
  brainstorm: "Brainstorm",
  drafting: "Drafting",
  ready: "Ready to Schedule",
};

export interface Assignee {
  userId: string;
  /** Their role on THIS item (owner / editor / reviewer), not their job title. */
  role: string;
}

export interface PlannerItem {
  id: string;
  title: string;
  hook: string;
  caption: string;
  script: string;
  /** Denormalised from the item's category so the grid needs no join. */
  color: string;
  categoryId: string | null;
  platforms: string[];
  assignedUsers: Assignee[];
  assetDriveUrl: string | null;
  /**
   * THE SOURCE OF TRUTH for where this card sits and what it says.
   * NULL means unscheduled — the item lives in the scratchpad backlog.
   */
  scheduledDate: string | null;
  /** "HH:MM" 24h wall clock. Null exactly when scheduledDate is null. */
  scheduledTime: string | null;
  /** Derived from the literal wall clock. Never read for display. */
  scheduledAtUtc: string | null;
  authoredTz: string;
  isCompleted: boolean;
  backlogStatus: BacklogStatus;
  sortOrder: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

/* ────────────────────────── database ────────────────────────── */

function resolveDbPath(): string {
  const base = existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
  mkdirSync(base, { recursive: true });
  return process.env.CONTENT_PLANNER_DB_PATH?.trim() || path.join(base, "content-planner.db");
}

let db: Database.Database | null = null;

export function getPlannerDb(): Database.Database {
  if (db) return db;
  db = new Database(resolveDbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS planner_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      hook TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      script TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#2dd4ee',
      platforms TEXT NOT NULL DEFAULT '[]',
      assigned_users TEXT NOT NULL DEFAULT '[]',
      asset_drive_url TEXT,
      scheduled_at_utc TEXT,
      authored_tz TEXT NOT NULL DEFAULT 'America/Chicago',
      is_completed INTEGER NOT NULL DEFAULT 0,
      backlog_status TEXT NOT NULL DEFAULT 'brainstorm',
      sort_order INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_planner_sched ON planner_items(scheduled_at_utc);
    CREATE INDEX IF NOT EXISTS idx_planner_backlog ON planner_items(backlog_status);

    CREATE TABLE IF NOT EXISTS planner_activity (
      id TEXT PRIMARY KEY,
      item_id TEXT,
      item_title TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_planner_activity_at ON planner_activity(at);

    CREATE TABLE IF NOT EXISTS planner_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  migrateToLiteralDates(db);
  return db;
}

/**
 * Add the literal wall-clock columns and fill them from the UTC instants.
 *
 * The repo's ALTER-migration pattern: add if absent, backfill once, leave the
 * old column in place. The backfill reads each instant back in the row's OWN
 * `authored_tz`, which recovers exactly the date and time the human originally
 * typed — so an item scheduled under the old model keeps the day it was put on,
 * rather than jumping when the anchor stopped being consulted.
 */
function migrateToLiteralDates(d: Database.Database): void {
  const cols = new Set(
    (d.prepare(`PRAGMA table_info(planner_items)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("scheduled_date")) d.exec(`ALTER TABLE planner_items ADD COLUMN scheduled_date TEXT`);
  if (!cols.has("scheduled_time")) d.exec(`ALTER TABLE planner_items ADD COLUMN scheduled_time TEXT`);
  if (!cols.has("category_id")) d.exec(`ALTER TABLE planner_items ADD COLUMN category_id TEXT`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_planner_date ON planner_items(scheduled_date)`);

  const stale = d
    .prepare(
      `SELECT id, scheduled_at_utc, authored_tz FROM planner_items
       WHERE scheduled_at_utc IS NOT NULL AND (scheduled_date IS NULL OR scheduled_date = '')`,
    )
    .all() as Array<{ id: string; scheduled_at_utc: string; authored_tz: string }>;
  if (!stale.length) return;

  const upd = d.prepare(`UPDATE planner_items SET scheduled_date=?, scheduled_time=? WHERE id=?`);
  const run = d.transaction(() => {
    for (const row of stale) {
      const ms = Date.parse(row.scheduled_at_utc);
      if (!Number.isFinite(ms)) continue;
      const tz = row.authored_tz && isValidTimeZone(row.authored_tz) ? row.authored_tz : "America/Chicago";
      upd.run(zonedDateKey(ms, tz), zonedTimeInput(ms, tz), row.id);
    }
  });
  run();
  console.log(`[planner] migrated ${stale.length} scheduled item(s) to literal wall-clock dates`);
}

const nowIso = () => new Date().toISOString();

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rowToItem(row: Record<string, unknown>): PlannerItem {
  const assigned = parseJsonArray(row.assigned_users)
    .map((a) => {
      if (typeof a === "string") return { userId: a, role: "owner" };
      const o = a as Record<string, unknown>;
      const userId = typeof o?.userId === "string" ? o.userId : "";
      return userId ? { userId, role: typeof o.role === "string" && o.role ? o.role : "owner" } : null;
    })
    .filter((a): a is Assignee => !!a);

  const status = String(row.backlog_status || "brainstorm");
  const date = row.scheduled_date ? String(row.scheduled_date) : null;
  return {
    id: String(row.id),
    title: String(row.title || ""),
    hook: String(row.hook || ""),
    caption: String(row.caption || ""),
    script: String(row.script || ""),
    color: String(row.color || DEFAULT_ITEM_COLOR),
    categoryId: row.category_id ? String(row.category_id) : null,
    platforms: parseJsonArray(row.platforms).filter((p): p is string => typeof p === "string"),
    assignedUsers: assigned,
    assetDriveUrl: row.asset_drive_url ? String(row.asset_drive_url) : null,
    scheduledDate: date,
    scheduledTime: date ? String(row.scheduled_time || "09:00") : null,
    scheduledAtUtc: row.scheduled_at_utc ? String(row.scheduled_at_utc) : null,
    authoredTz: String(row.authored_tz || defaultAuthoringTz()),
    isCompleted: Number(row.is_completed) === 1,
    backlogStatus: (BACKLOG_STATUSES as string[]).includes(status) ? (status as BacklogStatus) : "brainstorm",
    sortOrder: Number(row.sort_order || 0),
    notes: String(row.notes || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    createdBy: row.created_by ? String(row.created_by) : null,
  };
}

/* ────────────────────────── settings ────────────────────────── */

export type WeekStart = "SUNDAY" | "MONDAY";

export interface PlannerSettings {
  /**
   * The zone a typed wall clock is assumed to be in when the derived UTC
   * instant is computed. It is NOT a display setting: no screen converts into
   * or out of it, and changing it never moves a card. It exists so the stored
   * `scheduled_at_utc` means something to a future publisher.
   */
  authoringTz: string;
  /** Which day the calendar grid starts on. Sunday is the default. */
  weekStart: WeekStart;
  /**
   * Which US zone the second reference clock shows. Display only — the clocks
   * are a glance at what time it is elsewhere, nothing more.
   */
  usClockTz: string;
  dragMode: "DOMINO" | "DIRECT";
}

function defaultAuthoringTz(): string {
  const env = process.env.PLANNER_PRIMARY_TZ?.trim();
  if (env && isValidTimeZone(env)) return env;
  return "America/Chicago";
}

export function settingsDefaults(): PlannerSettings {
  return {
    authoringTz: defaultAuthoringTz(),
    weekStart: "SUNDAY",
    usClockTz: "America/New_York",
    dragMode: "DOMINO",
  };
}

export function getSettings(): PlannerSettings {
  const rows = getPlannerDb().prepare(`SELECT key, value FROM planner_settings`).all() as Array<{
    key: string;
    value: string;
  }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const d = settingsDefaults();
  // `primaryTz` is read as a fallback so a database written by the pre-literal
  // version keeps authoring in the zone it was already using.
  const authoringTz = map.get("authoringTz") || map.get("primaryTz");
  const usClockTz = map.get("usClockTz");
  return {
    authoringTz: authoringTz && isValidTimeZone(authoringTz) ? authoringTz : d.authoringTz,
    weekStart: map.get("weekStart") === "MONDAY" ? "MONDAY" : "SUNDAY",
    usClockTz: usClockTz && isValidTimeZone(usClockTz) ? usClockTz : d.usClockTz,
    dragMode: map.get("dragMode") === "DIRECT" ? "DIRECT" : "DOMINO",
  };
}

export function saveSettings(patch: Partial<PlannerSettings>): PlannerSettings {
  const d = getPlannerDb();
  const stmt = d.prepare(
    `INSERT INTO planner_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const write = d.transaction(() => {
    if (patch.authoringTz && isValidTimeZone(patch.authoringTz)) stmt.run("authoringTz", patch.authoringTz);
    if (patch.weekStart === "SUNDAY" || patch.weekStart === "MONDAY") stmt.run("weekStart", patch.weekStart);
    if (patch.usClockTz && isValidTimeZone(patch.usClockTz)) stmt.run("usClockTz", patch.usClockTz);
    if (patch.dragMode === "DOMINO" || patch.dragMode === "DIRECT") stmt.run("dragMode", patch.dragMode);
  });
  write();
  return getSettings();
}

/* ────────────────────────── activity log ────────────────────────── */

export interface PlannerActivity {
  id: string;
  itemId: string | null;
  itemTitle: string;
  actor: string;
  kind: string;
  message: string;
  at: string;
}

export function logActivity(entry: Omit<PlannerActivity, "id" | "at">): PlannerActivity {
  const row: PlannerActivity = { ...entry, id: randomUUID(), at: nowIso() };
  getPlannerDb()
    .prepare(
      `INSERT INTO planner_activity (id, item_id, item_title, actor, kind, message, at)
       VALUES (@id, @itemId, @itemTitle, @actor, @kind, @message, @at)`,
    )
    .run(row);
  return row;
}

export function listActivity(limit = 50): PlannerActivity[] {
  const rows = getPlannerDb()
    .prepare(`SELECT * FROM planner_activity ORDER BY at DESC LIMIT ?`)
    .all(Math.min(500, Math.max(1, limit))) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    itemId: r.item_id ? String(r.item_id) : null,
    itemTitle: String(r.item_title || ""),
    actor: String(r.actor || ""),
    kind: String(r.kind || ""),
    message: String(r.message || ""),
    at: String(r.at || ""),
  }));
}

/* ────────────────────────── CRUD ────────────────────────── */

export function getItem(id: string): PlannerItem | null {
  const row = getPlannerDb().prepare(`SELECT * FROM planner_items WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToItem(row) : null;
}

export function allItems(): PlannerItem[] {
  const rows = getPlannerDb()
    .prepare(
      `SELECT * FROM planner_items
       ORDER BY COALESCE(scheduled_date, '9999'), COALESCE(scheduled_time, '99:99'), sort_order, created_at`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToItem);
}

export interface NewItemInput {
  title: string;
  hook?: string;
  caption?: string;
  script?: string;
  color?: string;
  categoryId?: string | null;
  platforms?: string[];
  assignedUsers?: Assignee[];
  assetDriveUrl?: string | null;
  /** Literal calendar date, or null/absent to land in the backlog. */
  date?: string | null;
  /** "HH:MM" 24h. Defaults to 09:00 when a date is given without one. */
  time?: string | null;
  authoredTz?: string;
  backlogStatus?: BacklogStatus;
  notes?: string;
  createdBy?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "09:00" → "09:00 AM". The card label, formatted from the literal clock. */
export function timeLabel(time: string | null): string {
  if (!time || !TIME_RE.test(time)) return "";
  const [h, m] = time.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Anything unparseable becomes 09:00 rather than corrupting the row. */
function normalizeTime(time: string | null | undefined, fallback = "09:00"): string {
  const t = String(time || "").trim();
  return TIME_RE.test(t) ? t : fallback;
}

/**
 * The derived UTC instant for a literal wall clock.
 *
 * Nothing displays this. It exists so the row still carries an instant a
 * publisher could fire on. A DST-nonexistent wall clock resolves to the instant
 * the clock jumps to, which does not change the literal date or time the
 * operator typed — those are stored verbatim either way.
 */
function deriveUtc(date: string, time: string, tz: string): string | null {
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  try {
    return zonedWallToUtc({ year: y, month: mo, day: d, hour: hh, minute: mm, second: 0 }, tz).utcIso;
  } catch {
    return null;
  }
}

export function createItem(input: NewItemInput): { item: PlannerItem } {
  const settings = getSettings();
  const tz = input.authoredTz && isValidTimeZone(input.authoredTz) ? input.authoredTz : settings.authoringTz;
  const hasDate = !!(input.date && DATE_RE.test(input.date));
  const scheduledDate = hasDate ? String(input.date) : null;
  const scheduledTime = hasDate ? normalizeTime(input.time) : null;
  const ts = nowIso();
  const item: PlannerItem = {
    id: randomUUID(),
    title: String(input.title || "").trim() || "Untitled content",
    hook: input.hook || "",
    caption: input.caption || "",
    script: input.script || "",
    color: input.color || DEFAULT_ITEM_COLOR,
    categoryId: input.categoryId || null,
    platforms: (input.platforms || []).filter((p) => typeof p === "string"),
    assignedUsers: input.assignedUsers || [],
    assetDriveUrl: input.assetDriveUrl || null,
    scheduledDate,
    scheduledTime,
    scheduledAtUtc: scheduledDate && scheduledTime ? deriveUtc(scheduledDate, scheduledTime, tz) : null,
    authoredTz: tz,
    isCompleted: false,
    backlogStatus: input.backlogStatus && BACKLOG_STATUSES.includes(input.backlogStatus) ? input.backlogStatus : "brainstorm",
    sortOrder: 0,
    notes: input.notes || "",
    createdAt: ts,
    updatedAt: ts,
    createdBy: input.createdBy || null,
  };
  writeItem(item, true);
  logActivity({
    itemId: item.id,
    itemTitle: item.title,
    actor: item.createdBy || "system",
    kind: scheduledDate ? "created_scheduled" : "created_backlog",
    message: scheduledDate
      ? `Created "${item.title}" for ${scheduledDate} ${timeLabel(scheduledTime)}`
      : `Captured "${item.title}" in the scratchpad`,
  });
  return { item };
}

function writeItem(item: PlannerItem, isInsert = false): void {
  const payload = {
    id: item.id,
    title: item.title,
    hook: item.hook,
    caption: item.caption,
    script: item.script,
    color: item.color,
    category_id: item.categoryId,
    platforms: JSON.stringify(item.platforms),
    assigned_users: JSON.stringify(item.assignedUsers),
    asset_drive_url: item.assetDriveUrl,
    scheduled_date: item.scheduledDate,
    scheduled_time: item.scheduledTime,
    scheduled_at_utc: item.scheduledAtUtc,
    authored_tz: item.authoredTz,
    is_completed: item.isCompleted ? 1 : 0,
    backlog_status: item.backlogStatus,
    sort_order: item.sortOrder,
    notes: item.notes,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    created_by: item.createdBy,
  };
  const d = getPlannerDb();
  if (isInsert) {
    d.prepare(
      `INSERT INTO planner_items
        (id, title, hook, caption, script, color, category_id, platforms, assigned_users, asset_drive_url,
         scheduled_date, scheduled_time, scheduled_at_utc, authored_tz, is_completed, backlog_status,
         sort_order, notes, created_at, updated_at, created_by)
       VALUES
        (@id, @title, @hook, @caption, @script, @color, @category_id, @platforms, @assigned_users, @asset_drive_url,
         @scheduled_date, @scheduled_time, @scheduled_at_utc, @authored_tz, @is_completed, @backlog_status,
         @sort_order, @notes, @created_at, @updated_at, @created_by)`,
    ).run(payload);
    return;
  }
  d.prepare(
    `UPDATE planner_items SET
       title=@title, hook=@hook, caption=@caption, script=@script, color=@color, category_id=@category_id,
       platforms=@platforms, assigned_users=@assigned_users, asset_drive_url=@asset_drive_url,
       scheduled_date=@scheduled_date, scheduled_time=@scheduled_time, scheduled_at_utc=@scheduled_at_utc,
       authored_tz=@authored_tz, is_completed=@is_completed,
       backlog_status=@backlog_status, sort_order=@sort_order, notes=@notes, updated_at=@updated_at
     WHERE id=@id`,
  ).run(payload);
}

export interface UpdateItemInput {
  title?: string;
  hook?: string;
  caption?: string;
  script?: string;
  color?: string;
  categoryId?: string | null;
  platforms?: string[];
  assignedUsers?: Assignee[];
  assetDriveUrl?: string | null;
  isCompleted?: boolean;
  backlogStatus?: BacklogStatus;
  sortOrder?: number;
  notes?: string;
  /** Set date+time (schedules it) or pass date:null to send it back to the backlog. */
  date?: string | null;
  time?: string | null;
  authoredTz?: string;
  actor?: string;
}

export function updateItem(id: string, patch: UpdateItemInput): { item: PlannerItem } | null {
  const item = getItem(id);
  if (!item) return null;
  const before = { ...item, assignedUsers: item.assignedUsers.map((a) => ({ ...a })) };

  if (typeof patch.title === "string") item.title = patch.title.trim() || item.title;
  if (typeof patch.hook === "string") item.hook = patch.hook;
  if (typeof patch.caption === "string") item.caption = patch.caption;
  if (typeof patch.script === "string") item.script = patch.script;
  if (typeof patch.color === "string" && /^#[0-9a-f]{6}$/i.test(patch.color)) item.color = patch.color;
  if (patch.categoryId !== undefined) item.categoryId = patch.categoryId || null;
  if (Array.isArray(patch.platforms)) item.platforms = patch.platforms.filter((p) => typeof p === "string");
  if (Array.isArray(patch.assignedUsers)) {
    item.assignedUsers = patch.assignedUsers
      .filter((a) => a && typeof a.userId === "string" && a.userId)
      .map((a) => ({ userId: a.userId, role: a.role || "owner" }));
  }
  if (patch.assetDriveUrl !== undefined) item.assetDriveUrl = patch.assetDriveUrl || null;
  if (typeof patch.isCompleted === "boolean") item.isCompleted = patch.isCompleted;
  if (patch.backlogStatus && BACKLOG_STATUSES.includes(patch.backlogStatus)) item.backlogStatus = patch.backlogStatus;
  if (typeof patch.sortOrder === "number") item.sortOrder = patch.sortOrder;
  if (typeof patch.notes === "string") item.notes = patch.notes;
  if (patch.authoredTz && isValidTimeZone(patch.authoredTz)) item.authoredTz = patch.authoredTz;

  if (patch.date === null) {
    // Reverse-drag: a scheduled post goes back to the backlog, keeping every
    // other field. Nothing is deleted, which is why unscheduling is safe.
    item.scheduledDate = null;
    item.scheduledTime = null;
  } else if (typeof patch.date === "string" && DATE_RE.test(patch.date)) {
    item.scheduledDate = patch.date;
    item.scheduledTime = normalizeTime(patch.time, item.scheduledTime || "09:00");
  } else if (typeof patch.time === "string" && item.scheduledDate) {
    item.scheduledTime = normalizeTime(patch.time, item.scheduledTime || "09:00");
  }

  item.scheduledAtUtc =
    item.scheduledDate && item.scheduledTime
      ? deriveUtc(item.scheduledDate, item.scheduledTime, item.authoredTz)
      : null;

  item.updatedAt = nowIso();
  writeItem(item);

  recordSemanticChanges(before, item, patch.actor || "system");
  return { item };
}

/** Which field changes are worth a line in the activity feed. */
function recordSemanticChanges(before: PlannerItem, after: PlannerItem, actor: string): void {
  const beforeIds = before.assignedUsers.map((a) => a.userId);
  const afterIds = after.assignedUsers.map((a) => a.userId);
  const added = afterIds.filter((u) => !beforeIds.includes(u));
  const removed = beforeIds.filter((u) => !afterIds.includes(u));
  for (const userId of added) {
    logActivity({
      itemId: after.id,
      itemTitle: after.title,
      actor,
      kind: "assigned",
      message: `${displayName(userId)} was assigned to "${after.title}"`,
    });
  }
  for (const userId of removed) {
    logActivity({
      itemId: after.id,
      itemTitle: after.title,
      actor,
      kind: "unassigned",
      message: `${displayName(userId)} was removed from "${after.title}"`,
    });
  }
  if (before.isCompleted !== after.isCompleted) {
    logActivity({
      itemId: after.id,
      itemTitle: after.title,
      actor,
      kind: after.isCompleted ? "completed" : "reopened",
      message: `"${after.title}" marked ${after.isCompleted ? "complete" : "not complete"}`,
    });
  }
  if (before.scheduledDate && !after.scheduledDate) {
    logActivity({
      itemId: after.id,
      itemTitle: after.title,
      actor,
      kind: "unscheduled",
      message: `"${after.title}" moved back to the scratchpad`,
    });
  } else if (!before.scheduledDate && after.scheduledDate) {
    logActivity({
      itemId: after.id,
      itemTitle: after.title,
      actor,
      kind: "scheduled",
      message: `"${after.title}" scheduled for ${after.scheduledDate} ${timeLabel(after.scheduledTime)}`,
    });
  }
  if (before.backlogStatus !== after.backlogStatus) {
    logActivity({
      itemId: after.id,
      itemTitle: after.title,
      actor,
      kind: "status",
      message: `"${after.title}" moved to ${BACKLOG_STATUS_LABELS[after.backlogStatus]}`,
    });
  }
}

export function deleteItem(id: string, actor = "system"): boolean {
  const item = getItem(id);
  if (!item) return false;
  getPlannerDb().prepare(`DELETE FROM planner_items WHERE id = ?`).run(id);
  logActivity({ itemId: id, itemTitle: item.title, actor, kind: "deleted", message: `"${item.title}" deleted` });
  return true;
}

/* ────────────────────────── views ────────────────────────── */

/**
 * What the browser renders. Deliberately thin: the card's day and time ARE the
 * stored values, so there is no conversion here to get wrong. `timeDisplay` is
 * the same clock formatted for reading.
 */
export interface ItemView extends PlannerItem {
  /** The date cell this card sits in. Identical to scheduledDate, always. */
  date: string | null;
  /** "HH:MM", for <input type="time">. */
  time: string | null;
  /** "09:00 AM", for the card and the accordion header. */
  timeDisplay: string;
}

function describeTimes(item: PlannerItem): ItemView {
  return {
    ...item,
    date: item.scheduledDate,
    time: item.scheduledTime,
    timeDisplay: timeLabel(item.scheduledTime),
  };
}

export function viewItem(item: PlannerItem): ItemView {
  return describeTimes(item);
}

/** Every scheduled item whose literal date falls in [from, to]. */
export function scheduledBetween(from: string, to: string): ItemView[] {
  const views = allItems()
    .filter((i) => i.scheduledDate && i.scheduledDate >= from && i.scheduledDate <= to)
    .map(describeTimes);
  views.sort(
    (a, b) =>
      String(a.scheduledDate).localeCompare(String(b.scheduledDate)) ||
      String(a.scheduledTime).localeCompare(String(b.scheduledTime)) ||
      a.createdAt.localeCompare(b.createdAt),
  );
  return views;
}

export function backlogItems(): ItemView[] {
  return allItems()
    .filter((i) => !i.scheduledDate)
    .sort((a, b) => a.sortOrder - b.sortOrder || b.createdAt.localeCompare(a.createdAt))
    .map(describeTimes);
}

/* ────────────────────────── drag modes ────────────────────────── */

export interface PlannedMove {
  id: string;
  title: string;
  fromDate: string | null;
  toDate: string;
  fromTime: string | null;
  toTime: string;
  /** true for the card the operator actually dragged. */
  dragged: boolean;
}

export interface ReschedulePlan {
  mode: "DOMINO" | "DIRECT";
  deltaDays: number;
  moves: PlannedMove[];
  warnings: string[];
}

/**
 * Work out every date change a drop implies, without writing anything.
 *
 * DOMINO — the whole schedule downstream moves with the card. Every OTHER
 *   scheduled item on or after the dragged card's original date shifts by the
 *   same number of days. That is the point of the mode: the sequence is what
 *   matters, so inserting a delay pushes the run rather than colliding.
 * DIRECT — only the dragged card moves, to the exact day (and, when a drop
 *   time is supplied by the hourly timeline, the exact hour). Nothing else
 *   is touched.
 *
 * An item coming from the backlog has no original date, so there is nothing to
 * ripple from and both modes behave identically: it simply lands.
 *
 * Both modes are plain calendar-date arithmetic on YYYY-MM-DD keys. A post
 * moved three days later keeps its wall clock and lands three days later, on
 * every date in the year — there is no zone in the calculation to disagree with
 * it, and no changeover that can turn "+3 days" into 71 or 73 hours on screen.
 */
export function planReschedule(input: {
  itemId: string;
  toDate: string;
  time?: string | null;
  mode?: "DOMINO" | "DIRECT";
  settings?: PlannerSettings;
}): ReschedulePlan | null {
  const settings = input.settings || getSettings();
  const mode = input.mode === "DIRECT" ? "DIRECT" : input.mode === "DOMINO" ? "DOMINO" : settings.dragMode;
  const dragged = getItem(input.itemId);
  if (!dragged) return null;

  const warnings: string[] = [];
  const moves: PlannedMove[] = [];

  const fromDate = dragged.scheduledDate;
  const fromTime = dragged.scheduledTime;
  const deltaDays = fromDate ? dateKeyDiff(fromDate, input.toDate) : 0;

  moves.push({
    id: dragged.id,
    title: dragged.title,
    fromDate,
    toDate: input.toDate,
    fromTime,
    toTime: normalizeTime(input.time, fromTime || "09:00"),
    dragged: true,
  });

  if (mode === "DOMINO" && fromDate && deltaDays !== 0) {
    for (const other of allItems()) {
      if (other.id === dragged.id || !other.scheduledDate) continue;
      if (other.scheduledDate < fromDate) continue;
      moves.push({
        id: other.id,
        title: other.title,
        fromDate: other.scheduledDate,
        toDate: shiftDateKey(other.scheduledDate, deltaDays),
        fromTime: other.scheduledTime,
        // Every rippled post keeps its own wall clock, untouched.
        toTime: other.scheduledTime || "09:00",
        dragged: false,
      });
    }
  }

  return { mode, deltaDays, moves, warnings };
}

/** Apply a plan. One transaction, so a ripple is all-or-nothing. */
export function applyReschedule(plan: ReschedulePlan, actor = "system"): ItemView[] {
  const d = getPlannerDb();
  const touched: PlannerItem[] = [];
  const run = d.transaction(() => {
    for (const move of plan.moves) {
      const item = getItem(move.id);
      if (!item) continue;
      item.scheduledDate = move.toDate;
      item.scheduledTime = normalizeTime(move.toTime, "09:00");
      item.scheduledAtUtc = deriveUtc(item.scheduledDate, item.scheduledTime, item.authoredTz);
      item.updatedAt = nowIso();
      writeItem(item);
      touched.push(item);
    }
  });
  run();
  const dragged = plan.moves.find((m) => m.dragged);
  if (dragged) {
    const rippled = plan.moves.length - 1;
    logActivity({
      itemId: dragged.id,
      itemTitle: dragged.title,
      actor,
      kind: "rescheduled",
      message:
        `"${dragged.title}" moved ${dragged.fromDate ? `from ${dragged.fromDate} ` : "from the scratchpad "}to ${dragged.toDate}` +
        (rippled > 0 ? ` — ${rippled} later post${rippled === 1 ? "" : "s"} shifted ${plan.deltaDays > 0 ? "+" : ""}${plan.deltaDays}d with it` : ` (${plan.mode === "DIRECT" ? "direct insert, nothing else moved" : "nothing downstream to shift"})`),
    });
  }
  return touched.map(describeTimes);
}

/** Names for the activity feed — resolved lazily so the roster stays one file. */
let nameResolver: ((userId: string) => string) | null = null;
export function setNameResolver(fn: (userId: string) => string): void {
  nameResolver = fn;
}
function displayName(userId: string): string {
  try {
    return nameResolver ? nameResolver(userId) : userId;
  } catch {
    return userId;
  }
}

export function plannerCounts(): { scheduled: number; backlog: number; completed: number } {
  const d = getPlannerDb();
  const row = d
    .prepare(
      `SELECT
         SUM(CASE WHEN scheduled_date IS NOT NULL THEN 1 ELSE 0 END) AS scheduled,
         SUM(CASE WHEN scheduled_date IS NULL THEN 1 ELSE 0 END) AS backlog,
         SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) AS completed
       FROM planner_items`,
    )
    .get() as Record<string, unknown>;
  return {
    scheduled: Number(row?.scheduled || 0),
    backlog: Number(row?.backlog || 0),
    completed: Number(row?.completed || 0),
  };
}
