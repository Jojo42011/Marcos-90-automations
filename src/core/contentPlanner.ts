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
 * have NO date at all (`scheduled_at_utc IS NULL`), which is the whole backlog
 * / scratchpad model: capture the idea now, place it on a day later.
 *
 * TIME IS STORED AS A UTC INSTANT, always. `authored_tz` records the zone the
 * human typed the time in, which is not decoration: "move this post three days
 * later, same time" only means anything relative to a wall clock, and across a
 * DST changeover the wall clock and the instant disagree. See zonedTime.ts.
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
  dayDelta,
  dayDeltaLabel,
  isValidTimeZone,
  shiftDaysInZone,
  zonedDateKey,
  zonedTimeInput,
  zonedTimeLabel,
  zonedWallToUtc,
  zoneLabel,
  type DstFlag,
} from "./zonedTime.js";

/* ────────────────────────── vocabulary ────────────────────────── */

/** The platforms a planner item can be tagged for. An item may carry several. */
export const PLATFORMS = [
  "Instagram",
  "TikTok",
  "YouTube",
  "Facebook",
  "LinkedIn",
  "X",
  "Pinterest",
  "Blog",
  "Newsletter",
] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * The ten category colours. Each carries the text colour that is actually
 * readable on it — computed once from WCAG relative luminance rather than
 * guessed, so a yellow chip gets black type and a navy chip gets white.
 */
export interface PaletteColor {
  hex: string;
  name: string;
  /** "#000000" or "#ffffff", whichever has the higher contrast ratio. */
  text: string;
  contrast: number;
}

const PALETTE_SEED: Array<{ hex: string; name: string }> = [
  { hex: "#ef4444", name: "Paid Ad" },
  { hex: "#f97316", name: "Testimonial" },
  { hex: "#f59e0b", name: "Promo" },
  { hex: "#facc15", name: "Announcement" },
  { hex: "#22c55e", name: "Listing" },
  { hex: "#14b8a6", name: "Behind the Scenes" },
  { hex: "#2dd4ee", name: "Market Update" },
  { hex: "#1d4ed8", name: "Educational" },
  { hex: "#8b5cf6", name: "Story" },
  { hex: "#ec4899", name: "Community" },
];

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a #rrggbb string, 0-1. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = channelLuminance((n >> 16) & 255);
  const g = channelLuminance((n >> 8) & 255);
  const b = channelLuminance(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between a colour and black or white, per WCAG 2.1. */
function contrastWith(lum: number, otherLum: number): number {
  const hi = Math.max(lum, otherLum);
  const lo = Math.min(lum, otherLum);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Black or white type on this background, whichever is actually more legible.
 * Returned to the browser so the colour rule lives in exactly one place.
 */
export function readableTextOn(hex: string): { text: string; contrast: number } {
  const lum = relativeLuminance(hex);
  const onWhite = contrastWith(lum, 1);
  const onBlack = contrastWith(lum, 0);
  return onBlack >= onWhite
    ? { text: "#000000", contrast: Math.round(onBlack * 100) / 100 }
    : { text: "#ffffff", contrast: Math.round(onWhite * 100) / 100 };
}

export function palette(): PaletteColor[] {
  return PALETTE_SEED.map((c) => ({ ...c, ...readableTextOn(c.hex) }));
}

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
  color: string;
  platforms: string[];
  assignedUsers: Assignee[];
  assetDriveUrl: string | null;
  /** NULL means unscheduled — the item lives in the scratchpad backlog. */
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
  return db;
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
  return {
    id: String(row.id),
    title: String(row.title || ""),
    hook: String(row.hook || ""),
    caption: String(row.caption || ""),
    script: String(row.script || ""),
    color: String(row.color || "#2dd4ee"),
    platforms: parseJsonArray(row.platforms).filter((p): p is string => typeof p === "string"),
    assignedUsers: assigned,
    assetDriveUrl: row.asset_drive_url ? String(row.asset_drive_url) : null,
    scheduledAtUtc: row.scheduled_at_utc ? String(row.scheduled_at_utc) : null,
    authoredTz: String(row.authored_tz || defaultPrimaryTz()),
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

export interface PlannerSettings {
  /** The creator's own zone — what times are authored in by default. */
  primaryTz: string;
  /** The audience's zone — the second time shown on every card. */
  secondaryTz: string;
  /**
   * Which zone decides WHICH DAY CELL a card sits in. Flipping this genuinely
   * re-sorts the grid: a 9 AM Manila post is the previous evening in New York,
   * so it moves cells, it does not just re-label.
   */
  gridAnchor: "primary" | "secondary";
  dragMode: "DOMINO" | "DIRECT";
}

function defaultPrimaryTz(): string {
  const env = process.env.PLANNER_PRIMARY_TZ?.trim();
  if (env && isValidTimeZone(env)) return env;
  return "America/Chicago";
}

const SETTINGS_DEFAULTS: PlannerSettings = {
  primaryTz: defaultPrimaryTz(),
  secondaryTz: "America/New_York",
  gridAnchor: "primary",
  dragMode: "DOMINO",
};

export function getSettings(): PlannerSettings {
  const rows = getPlannerDb().prepare(`SELECT key, value FROM planner_settings`).all() as Array<{
    key: string;
    value: string;
  }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const primaryTz = map.get("primaryTz");
  const secondaryTz = map.get("secondaryTz");
  const gridAnchor = map.get("gridAnchor");
  const dragMode = map.get("dragMode");
  return {
    primaryTz: primaryTz && isValidTimeZone(primaryTz) ? primaryTz : SETTINGS_DEFAULTS.primaryTz,
    secondaryTz: secondaryTz && isValidTimeZone(secondaryTz) ? secondaryTz : SETTINGS_DEFAULTS.secondaryTz,
    gridAnchor: gridAnchor === "secondary" ? "secondary" : "primary",
    dragMode: dragMode === "DIRECT" ? "DIRECT" : "DOMINO",
  };
}

export function saveSettings(patch: Partial<PlannerSettings>): PlannerSettings {
  const d = getPlannerDb();
  const stmt = d.prepare(
    `INSERT INTO planner_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const write = d.transaction(() => {
    if (patch.primaryTz && isValidTimeZone(patch.primaryTz)) stmt.run("primaryTz", patch.primaryTz);
    if (patch.secondaryTz && isValidTimeZone(patch.secondaryTz)) stmt.run("secondaryTz", patch.secondaryTz);
    if (patch.gridAnchor === "primary" || patch.gridAnchor === "secondary") stmt.run("gridAnchor", patch.gridAnchor);
    if (patch.dragMode === "DOMINO" || patch.dragMode === "DIRECT") stmt.run("dragMode", patch.dragMode);
  });
  write();
  return getSettings();
}

/** The zone the grid is anchored to right now. */
export function anchorTz(s: PlannerSettings = getSettings()): string {
  return s.gridAnchor === "secondary" ? s.secondaryTz : s.primaryTz;
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
    .prepare(`SELECT * FROM planner_items ORDER BY COALESCE(scheduled_at_utc, '9999'), sort_order, created_at`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToItem);
}

export interface NewItemInput {
  title: string;
  hook?: string;
  caption?: string;
  script?: string;
  color?: string;
  platforms?: string[];
  assignedUsers?: Assignee[];
  assetDriveUrl?: string | null;
  /** Wall-clock date in `authoredTz`, or null/absent to land in the backlog. */
  date?: string | null;
  /** "HH:MM" 24h. Defaults to 09:00 when a date is given without one. */
  time?: string | null;
  authoredTz?: string;
  backlogStatus?: BacklogStatus;
  notes?: string;
  createdBy?: string | null;
}

/** Resolve a date+time in a zone to a stored instant, reporting DST oddities. */
export function resolveWallClock(
  date: string,
  time: string | null | undefined,
  tz: string,
): { utcIso: string; dst: DstFlag } {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = String(time || "09:00").split(":").map(Number);
  const r = zonedWallToUtc(
    { year: y, month: m, day: d, hour: Number.isFinite(hh) ? hh : 9, minute: Number.isFinite(mm) ? mm : 0, second: 0 },
    tz,
  );
  return { utcIso: r.utcIso, dst: r.dst };
}

export function createItem(input: NewItemInput): { item: PlannerItem; dst: DstFlag } {
  const settings = getSettings();
  const tz = input.authoredTz && isValidTimeZone(input.authoredTz) ? input.authoredTz : settings.primaryTz;
  let scheduledAtUtc: string | null = null;
  let dst: DstFlag = "ok";
  if (input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    const r = resolveWallClock(input.date, input.time, tz);
    scheduledAtUtc = r.utcIso;
    dst = r.dst;
  }
  const ts = nowIso();
  const item: PlannerItem = {
    id: randomUUID(),
    title: String(input.title || "").trim() || "Untitled content",
    hook: input.hook || "",
    caption: input.caption || "",
    script: input.script || "",
    color: input.color || PALETTE_SEED[6].hex,
    platforms: (input.platforms || []).filter((p) => typeof p === "string"),
    assignedUsers: input.assignedUsers || [],
    assetDriveUrl: input.assetDriveUrl || null,
    scheduledAtUtc,
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
    kind: scheduledAtUtc ? "created_scheduled" : "created_backlog",
    message: scheduledAtUtc
      ? `Created "${item.title}" for ${zonedDateKey(Date.parse(scheduledAtUtc), tz)} ${zonedTimeLabel(Date.parse(scheduledAtUtc), tz)} ${zoneLabel(tz)}`
      : `Captured "${item.title}" in the scratchpad`,
  });
  return { item, dst };
}

function writeItem(item: PlannerItem, isInsert = false): void {
  const payload = {
    id: item.id,
    title: item.title,
    hook: item.hook,
    caption: item.caption,
    script: item.script,
    color: item.color,
    platforms: JSON.stringify(item.platforms),
    assigned_users: JSON.stringify(item.assignedUsers),
    asset_drive_url: item.assetDriveUrl,
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
        (id, title, hook, caption, script, color, platforms, assigned_users, asset_drive_url,
         scheduled_at_utc, authored_tz, is_completed, backlog_status, sort_order, notes,
         created_at, updated_at, created_by)
       VALUES
        (@id, @title, @hook, @caption, @script, @color, @platforms, @assigned_users, @asset_drive_url,
         @scheduled_at_utc, @authored_tz, @is_completed, @backlog_status, @sort_order, @notes,
         @created_at, @updated_at, @created_by)`,
    ).run(payload);
    return;
  }
  d.prepare(
    `UPDATE planner_items SET
       title=@title, hook=@hook, caption=@caption, script=@script, color=@color,
       platforms=@platforms, assigned_users=@assigned_users, asset_drive_url=@asset_drive_url,
       scheduled_at_utc=@scheduled_at_utc, authored_tz=@authored_tz, is_completed=@is_completed,
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

export function updateItem(id: string, patch: UpdateItemInput): { item: PlannerItem; dst: DstFlag } | null {
  const item = getItem(id);
  if (!item) return null;
  const before = { ...item, assignedUsers: item.assignedUsers.map((a) => ({ ...a })) };
  let dst: DstFlag = "ok";

  if (typeof patch.title === "string") item.title = patch.title.trim() || item.title;
  if (typeof patch.hook === "string") item.hook = patch.hook;
  if (typeof patch.caption === "string") item.caption = patch.caption;
  if (typeof patch.script === "string") item.script = patch.script;
  if (typeof patch.color === "string" && /^#[0-9a-f]{6}$/i.test(patch.color)) item.color = patch.color;
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
    item.scheduledAtUtc = null;
  } else if (typeof patch.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(patch.date)) {
    const keepTime =
      patch.time || (item.scheduledAtUtc ? zonedTimeInput(Date.parse(item.scheduledAtUtc), item.authoredTz) : "09:00");
    const r = resolveWallClock(patch.date, keepTime, item.authoredTz);
    item.scheduledAtUtc = r.utcIso;
    dst = r.dst;
  } else if (typeof patch.time === "string" && item.scheduledAtUtc) {
    const dateKey = zonedDateKey(Date.parse(item.scheduledAtUtc), item.authoredTz);
    const r = resolveWallClock(dateKey, patch.time, item.authoredTz);
    item.scheduledAtUtc = r.utcIso;
    dst = r.dst;
  }

  item.updatedAt = nowIso();
  writeItem(item);

  recordSemanticChanges(before, item, patch.actor || "system");
  return { item, dst };
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
  if (before.scheduledAtUtc && !after.scheduledAtUtc) {
    logActivity({
      itemId: after.id,
      itemTitle: after.title,
      actor,
      kind: "unscheduled",
      message: `"${after.title}" moved back to the scratchpad`,
    });
  } else if (!before.scheduledAtUtc && after.scheduledAtUtc) {
    logActivity({
      itemId: after.id,
      itemTitle: after.title,
      actor,
      kind: "scheduled",
      message: `"${after.title}" scheduled for ${zonedDateKey(Date.parse(after.scheduledAtUtc), after.authoredTz)}`,
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

export interface ItemView extends PlannerItem {
  /** The date cell this card belongs in, in the anchor zone. */
  gridDate: string | null;
  primary: { tz: string; label: string; time: string; date: string; input: string } | null;
  secondary: { tz: string; label: string; time: string; date: string; dayDelta: number; deltaLabel: string } | null;
  /** Set when the stored instant sits on a DST oddity in its authored zone. */
  dstWarning: DstFlag;
}

function describeTimes(item: PlannerItem, settings: PlannerSettings): ItemView {
  if (!item.scheduledAtUtc) {
    return { ...item, gridDate: null, primary: null, secondary: null, dstWarning: "ok" };
  }
  const ms = Date.parse(item.scheduledAtUtc);
  const anchor = anchorTz(settings);
  const p = settings.primaryTz;
  const s = settings.secondaryTz;
  const delta = dayDelta(ms, p, s);
  // Re-resolving the stored wall clock tells us whether this instant sits on a
  // DST oddity — worth a badge, because the time on the card is not the time
  // the operator typed.
  const round = resolveWallClock(zonedDateKey(ms, item.authoredTz), zonedTimeInput(ms, item.authoredTz), item.authoredTz);
  return {
    ...item,
    gridDate: zonedDateKey(ms, anchor),
    primary: {
      tz: p,
      label: zoneLabel(p, ms),
      time: zonedTimeLabel(ms, p),
      date: zonedDateKey(ms, p),
      input: zonedTimeInput(ms, p),
    },
    secondary: {
      tz: s,
      label: zoneLabel(s, ms),
      time: zonedTimeLabel(ms, s),
      date: zonedDateKey(ms, s),
      dayDelta: delta,
      deltaLabel: dayDeltaLabel(delta),
    },
    dstWarning: round.dst,
  };
}

export function viewItem(item: PlannerItem, settings: PlannerSettings = getSettings()): ItemView {
  return describeTimes(item, settings);
}

/** Every scheduled item whose anchor-zone date falls in [from, to]. */
export function scheduledBetween(from: string, to: string, settings: PlannerSettings = getSettings()): ItemView[] {
  const views = allItems()
    .filter((i) => i.scheduledAtUtc)
    .map((i) => describeTimes(i, settings))
    .filter((v) => v.gridDate && v.gridDate >= from && v.gridDate <= to);
  views.sort((a, b) => String(a.scheduledAtUtc).localeCompare(String(b.scheduledAtUtc)));
  return views;
}

export function backlogItems(settings: PlannerSettings = getSettings()): ItemView[] {
  return allItems()
    .filter((i) => !i.scheduledAtUtc)
    .sort((a, b) => a.sortOrder - b.sortOrder || b.createdAt.localeCompare(a.createdAt))
    .map((i) => describeTimes(i, settings));
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
  dst: DstFlag;
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

  const anchor = anchorTz(settings);
  const warnings: string[] = [];
  const moves: PlannedMove[] = [];

  const fromMs = dragged.scheduledAtUtc ? Date.parse(dragged.scheduledAtUtc) : null;
  const fromDate = fromMs != null ? zonedDateKey(fromMs, anchor) : null;
  const fromTime = fromMs != null ? zonedTimeInput(fromMs, dragged.authoredTz) : null;
  const deltaDays = fromDate ? dateKeyDiff(fromDate, input.toDate) : 0;

  const dropTime = input.time || fromTime || "09:00";
  const draggedResolved = resolveWallClock(input.toDate, dropTime, dragged.authoredTz);
  moves.push({
    id: dragged.id,
    title: dragged.title,
    fromDate,
    toDate: zonedDateKey(Date.parse(draggedResolved.utcIso), anchor),
    fromTime,
    toTime: zonedTimeInput(Date.parse(draggedResolved.utcIso), dragged.authoredTz),
    dragged: true,
    dst: draggedResolved.dst,
  });
  if (draggedResolved.dst === "nonexistent") {
    warnings.push(
      `${dropTime} does not exist on ${input.toDate} in ${zoneLabel(dragged.authoredTz)} — clocks jump forward. Saved as ${zonedTimeLabel(Date.parse(draggedResolved.utcIso), dragged.authoredTz)}.`,
    );
  } else if (draggedResolved.dst === "ambiguous") {
    warnings.push(
      `${dropTime} happens twice on ${input.toDate} in ${zoneLabel(dragged.authoredTz)} — clocks fall back. Saved as the first occurrence.`,
    );
  }

  if (mode === "DOMINO" && fromDate && deltaDays !== 0) {
    for (const other of allItems()) {
      if (other.id === dragged.id || !other.scheduledAtUtc) continue;
      const otherMs = Date.parse(other.scheduledAtUtc);
      const otherDate = zonedDateKey(otherMs, anchor);
      if (otherDate < fromDate) continue;
      const shifted = shiftDaysInZone(otherMs, other.authoredTz, deltaDays);
      moves.push({
        id: other.id,
        title: other.title,
        fromDate: otherDate,
        toDate: zonedDateKey(shifted.utcMs, anchor),
        fromTime: zonedTimeInput(otherMs, other.authoredTz),
        toTime: zonedTimeInput(shifted.utcMs, other.authoredTz),
        dragged: false,
        dst: shifted.dst,
      });
      if (shifted.dst !== "ok") {
        warnings.push(`"${other.title}" lands on a daylight-saving change and was adjusted to ${zonedTimeLabel(shifted.utcMs, other.authoredTz)}.`);
      }
    }
  }

  return { mode, deltaDays, moves, warnings };
}

/** Apply a plan. One transaction, so a ripple is all-or-nothing. */
export function applyReschedule(plan: ReschedulePlan, actor = "system"): ItemView[] {
  const settings = getSettings();
  const d = getPlannerDb();
  const touched: PlannerItem[] = [];
  const run = d.transaction(() => {
    for (const move of plan.moves) {
      const item = getItem(move.id);
      if (!item) continue;
      const r = resolveWallClock(move.toDate, move.toTime, item.authoredTz);
      item.scheduledAtUtc = r.utcIso;
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
  return touched.map((i) => describeTimes(i, settings));
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
         SUM(CASE WHEN scheduled_at_utc IS NOT NULL THEN 1 ELSE 0 END) AS scheduled,
         SUM(CASE WHEN scheduled_at_utc IS NULL THEN 1 ELSE 0 END) AS backlog,
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
