/**
 * The planner's master taxonomy: categories, platforms, and who can be assigned.
 *
 * WHY THIS EXISTS. All three of these lists used to be hardcoded constants —
 * ten palette colours that doubled as category names, nine platform strings,
 * and a team list derived from the roster. None of them could be edited without
 * a deploy, which is wrong for vocabulary the operator owns: "Threads" launches,
 * a category gets renamed, someone leaves. They are data, not code.
 *
 * THREE RULES THIS MODULE EXISTS TO ENFORCE, all of them about not losing work:
 *
 *  1. NOTHING IS DELETED OUT FROM UNDER CONTENT. Removing a category, platform
 *     or member that posts still reference is refused unless the caller says
 *     where those posts should land. The count comes back with the refusal so
 *     the UI can ask the real question ("12 posts use this — move them where?")
 *     instead of a generic error.
 *
 *  2. DELETING A PERSON HERE NEVER TOUCHES THEIR CRM ACCOUNT. Members are
 *     DERIVED from teamRoster + the CRM user table; this module keeps only an
 *     overlay on top (hidden / renamed / recoloured / merged). Letting the
 *     planner delete a row out of users.ts would sign someone out of the whole
 *     app because a content calendar had a duplicate on it. Hiding is scoped
 *     here and reversible; the UI says so out loud.
 *
 *  3. A NAME IS UNIQUE CASE-INSENSITIVELY. "Instagram" and "instagram" are the
 *     same platform to everyone except a string comparison, and two of them on
 *     a picker is how half the posts end up on the wrong one.
 *
 * Tables live in the planner's own database (content-planner.db) beside
 * planner_items, since they are meaningless outside it.
 */
import { randomUUID } from "crypto";

import { getPlannerDb } from "./contentPlanner.js";
import { listPlannerTeam } from "./plannerTeam.js";

/* ────────────────────────── the 20-colour palette ────────────────────────── */

/**
 * Twenty high-contrast, visually distinct colours — the only choices the
 * category picker offers, so a calendar full of categories stays readable
 * instead of drifting into twelve shades of blue.
 *
 * MEASURED, NOT ASSUMED: sixteen of these clear WCAG AA (4.5:1) for small text
 * against whichever of the two type colours suits them. Four do not, and cannot
 * with either — Royal Blue 4.36, Indigo Blue 4.47, Vivid Purple 4.23, Dark Mint
 * 4.25. They sit above the 3:1 AA-large threshold and below the 4.5 body-text
 * one. The hexes are the operator's choice and are kept exactly as specified;
 * badgeTextOn always picks the better of the two, which is the rule asked for.
 * If those four ever need to clear 4.5, the fix is a darker hex, not a
 * different rule, and it belongs in this list.
 */
export const PALETTE_20: Array<{ hex: string; name: string }> = [
  { hex: "#EF4444", name: "Bright Red" },
  { hex: "#F97316", name: "Vivid Orange" },
  { hex: "#F59E0B", name: "Amber Gold" },
  { hex: "#84CC16", name: "Lime Green" },
  { hex: "#10B981", name: "Emerald Green" },
  { hex: "#06B6D4", name: "Cyan Aqua" },
  { hex: "#0284C7", name: "Royal Blue" },
  { hex: "#6366F1", name: "Indigo Blue" },
  { hex: "#8B5CF6", name: "Vivid Purple" },
  { hex: "#D946EF", name: "Fuchsia Magenta" },
  { hex: "#EC4899", name: "Hot Pink" },
  { hex: "#14B8A6", name: "Deep Teal" },
  { hex: "#845EC2", name: "Deep Violet" },
  { hex: "#FF6F91", name: "Coral Pink" },
  { hex: "#FFC75F", name: "Mustard Yellow" },
  { hex: "#008E97", name: "Sea Cyan" },
  { hex: "#2C73D2", name: "Steel Blue" },
  { hex: "#008B74", name: "Dark Mint" },
  { hex: "#B0A8B9", name: "Slate Gray" },
  { hex: "#845136", name: "Warm Mocha" },
];

/** Dark type on a light chip. Deliberately not pure black — matches the app. */
export const TEXT_DARK = "#0F172A";
export const TEXT_LIGHT = "#FFFFFF";

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a #rrggbb string, 0-1. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (
    0.2126 * channelLuminance((n >> 16) & 255) +
    0.7152 * channelLuminance((n >> 8) & 255) +
    0.0722 * channelLuminance(n & 255)
  );
}

function ratio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Which of the two type colours is actually legible on this background.
 *
 * Computed, never chosen by eye: the whole point of a 20-colour palette is that
 * the operator picks a colour and the badge stays readable without anyone
 * checking. The ratio is returned alongside so a caller can show it.
 */
export function badgeTextOn(hex: string): { text: string; contrast: number } {
  const lum = relativeLuminance(hex);
  const onLight = ratio(lum, relativeLuminance(TEXT_LIGHT));
  const onDark = ratio(lum, relativeLuminance(TEXT_DARK));
  return onDark >= onLight
    ? { text: TEXT_DARK, contrast: Math.round(onDark * 100) / 100 }
    : { text: TEXT_LIGHT, contrast: Math.round(onLight * 100) / 100 };
}

export function paletteWithText(): Array<{ hex: string; name: string; text: string; contrast: number }> {
  return PALETTE_20.map((c) => ({ ...c, ...badgeTextOn(c.hex) }));
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const nowIso = () => new Date().toISOString();
const normName = (s: unknown) => String(s ?? "").trim().toLowerCase();

/* ────────────────────────── schema ────────────────────────── */

/**
 * The categories the planner ships with. These are exactly the ten that used to
 * be hardcoded as the palette, seeded once with their original hexes so every
 * card that already carries one keeps the colour it has always had.
 */
const CATEGORY_SEED: Array<{ name: string; hex: string }> = [
  { name: "Paid Ad", hex: "#EF4444" },
  { name: "Testimonial", hex: "#F97316" },
  { name: "Promo", hex: "#F59E0B" },
  { name: "Announcement", hex: "#FFC75F" },
  { name: "Listing", hex: "#10B981" },
  { name: "Behind the Scenes", hex: "#14B8A6" },
  { name: "Market Update", hex: "#06B6D4" },
  { name: "Educational", hex: "#2C73D2" },
  { name: "Story", hex: "#8B5CF6" },
  { name: "Community", hex: "#EC4899" },
];

/** The nine platforms that were hardcoded before this table existed. */
const PLATFORM_SEED: Array<{ name: string; iconKey: string }> = [
  { name: "Instagram", iconKey: "instagram" },
  { name: "TikTok", iconKey: "tiktok" },
  { name: "YouTube", iconKey: "youtube" },
  { name: "Facebook", iconKey: "facebook" },
  { name: "LinkedIn", iconKey: "linkedin" },
  { name: "X", iconKey: "x" },
  { name: "Pinterest", iconKey: "pinterest" },
  { name: "Blog", iconKey: "blog" },
  { name: "Newsletter", iconKey: "newsletter" },
];

let ensured = false;

export function ensureTaxonomySchema(): void {
  if (ensured) return;
  const d = getPlannerDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS planner_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color_hex TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS planner_platforms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon_key TEXT NOT NULL DEFAULT '',
      active_status INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS planner_members (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      avatar_initials TEXT NOT NULL DEFAULT '',
      badge_color TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'planner',
      hidden INTEGER NOT NULL DEFAULT 0,
      merged_into TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const catCount = Number(
    (d.prepare(`SELECT COUNT(*) AS n FROM planner_categories`).get() as { n: number })?.n || 0,
  );
  if (catCount === 0) {
    const ts = nowIso();
    const stmt = d.prepare(
      `INSERT INTO planner_categories (id, name, color_hex, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const seed = d.transaction(() => {
      CATEGORY_SEED.forEach((c, i) => stmt.run(randomUUID(), c.name, c.hex, i, ts, ts));
    });
    seed();
  }

  const platCount = Number(
    (d.prepare(`SELECT COUNT(*) AS n FROM planner_platforms`).get() as { n: number })?.n || 0,
  );
  if (platCount === 0) {
    const ts = nowIso();
    const stmt = d.prepare(
      `INSERT INTO planner_platforms (id, name, icon_key, active_status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    );
    const seed = d.transaction(() => {
      PLATFORM_SEED.forEach((p, i) => stmt.run(randomUUID(), p.name, p.iconKey, i, ts, ts));
    });
    seed();
  }

  ensured = true;
}

/** Test-only: forget that the schema was ensured, so a fresh DB re-seeds. */
export function _resetTaxonomyForTests(): void {
  ensured = false;
}

/* ────────────────────────── categories ────────────────────────── */

export interface PlannerCategory {
  id: string;
  name: string;
  colorHex: string;
  /** Type colour that is legible on colorHex, computed not chosen. */
  textColor: string;
  contrast: number;
  sortOrder: number;
  /** How many planner items currently carry it. */
  usageCount: number;
}

function categoryUsage(): Map<string, number> {
  const rows = getPlannerDb()
    .prepare(`SELECT category_id AS id, COUNT(*) AS n FROM planner_items WHERE category_id IS NOT NULL GROUP BY category_id`)
    .all() as Array<{ id: string; n: number }>;
  return new Map(rows.map((r) => [String(r.id), Number(r.n)]));
}

export function listCategories(): PlannerCategory[] {
  ensureTaxonomySchema();
  const usage = categoryUsage();
  const rows = getPlannerDb()
    .prepare(`SELECT * FROM planner_categories ORDER BY sort_order, name`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const hex = String(r.color_hex);
    const legible = badgeTextOn(hex);
    return {
      id: String(r.id),
      name: String(r.name),
      colorHex: hex,
      textColor: legible.text,
      contrast: legible.contrast,
      sortOrder: Number(r.sort_order || 0),
      usageCount: usage.get(String(r.id)) || 0,
    };
  });
}

export function getCategory(id: string): PlannerCategory | null {
  return listCategories().find((c) => c.id === id) || null;
}

export class TaxonomyError extends Error {
  status: number;
  details: Record<string, unknown>;
  constructor(message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function assertUniqueName(table: "planner_categories" | "planner_platforms", name: string, exceptId?: string): void {
  const rows = getPlannerDb().prepare(`SELECT id, name FROM ${table}`).all() as Array<{ id: string; name: string }>;
  const clash = rows.find((r) => normName(r.name) === normName(name) && r.id !== exceptId);
  if (clash) {
    throw new TaxonomyError(
      `"${clash.name}" already exists. Names are compared without case, so "${name}" would be a duplicate.`,
      409,
      { conflictId: clash.id, conflictName: clash.name },
    );
  }
}

export function createCategory(input: { name: string; colorHex: string }): PlannerCategory {
  ensureTaxonomySchema();
  const name = String(input.name || "").trim();
  if (!name) throw new TaxonomyError("A category name is required");
  if (!HEX_RE.test(String(input.colorHex || ""))) {
    throw new TaxonomyError("colorHex must be a #rrggbb value from the palette");
  }
  assertUniqueName("planner_categories", name);
  const d = getPlannerDb();
  const maxSort = Number(
    (d.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM planner_categories`).get() as { m: number })?.m ?? -1,
  );
  const id = randomUUID();
  const ts = nowIso();
  d.prepare(
    `INSERT INTO planner_categories (id, name, color_hex, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, String(input.colorHex).toUpperCase(), maxSort + 1, ts, ts);
  return getCategory(id)!;
}

export function updateCategory(id: string, patch: { name?: string; colorHex?: string; sortOrder?: number }): PlannerCategory | null {
  ensureTaxonomySchema();
  const existing = getCategory(id);
  if (!existing) return null;
  const name = patch.name === undefined ? existing.name : String(patch.name).trim();
  if (!name) throw new TaxonomyError("A category name is required");
  if (patch.name !== undefined) assertUniqueName("planner_categories", name, id);
  const colorHex = patch.colorHex === undefined ? existing.colorHex : String(patch.colorHex).toUpperCase();
  if (!HEX_RE.test(colorHex)) throw new TaxonomyError("colorHex must be a #rrggbb value from the palette");
  getPlannerDb()
    .prepare(`UPDATE planner_categories SET name=?, color_hex=?, sort_order=?, updated_at=? WHERE id=?`)
    .run(name, colorHex, patch.sortOrder === undefined ? existing.sortOrder : Number(patch.sortOrder), nowIso(), id);
  return getCategory(id);
}

/**
 * Delete a category, moving anything that used it somewhere explicit.
 *
 * `reassignTo` is a category id, or the literal string "unassigned" to clear
 * the field. Omitting it while posts still reference the category is REFUSED
 * with the count, because the alternative — silently orphaning them — is how a
 * month of content loses its colour coding with nobody noticing.
 */
export function deleteCategory(id: string, reassignTo?: string | null): { deleted: boolean; reassigned: number } {
  ensureTaxonomySchema();
  const existing = getCategory(id);
  if (!existing) return { deleted: false, reassigned: 0 };
  const d = getPlannerDb();

  if (existing.usageCount > 0 && !reassignTo) {
    throw new TaxonomyError(
      `${existing.usageCount} content item${existing.usageCount === 1 ? " still uses" : "s still use"} "${existing.name}". Choose where they should go before deleting it.`,
      409,
      { usageCount: existing.usageCount, requires: "reassignTo" },
    );
  }

  let target: PlannerCategory | null = null;
  if (reassignTo && reassignTo !== "unassigned") {
    target = getCategory(reassignTo);
    if (!target) throw new TaxonomyError("The category to move these items to does not exist", 400);
    if (target.id === id) throw new TaxonomyError("Items cannot be moved to the category being deleted", 400);
  }

  let reassigned = 0;
  const run = d.transaction(() => {
    if (existing.usageCount > 0) {
      const info = target
        ? d.prepare(`UPDATE planner_items SET category_id=?, color=?, updated_at=? WHERE category_id=?`)
            .run(target.id, target.colorHex, nowIso(), id)
        : d.prepare(`UPDATE planner_items SET category_id=NULL, updated_at=? WHERE category_id=?`).run(nowIso(), id);
      reassigned = Number(info.changes || 0);
    }
    d.prepare(`DELETE FROM planner_categories WHERE id=?`).run(id);
  });
  run();
  return { deleted: true, reassigned };
}

/* ────────────────────────── platforms ────────────────────────── */

export interface PlannerPlatform {
  id: string;
  name: string;
  iconKey: string;
  activeStatus: boolean;
  sortOrder: number;
  usageCount: number;
}

/** Platforms are stored on items by NAME, so usage counts by name too. */
function platformUsage(): Map<string, number> {
  const rows = getPlannerDb().prepare(`SELECT platforms FROM planner_items`).all() as Array<{ platforms: string }>;
  const out = new Map<string, number>();
  for (const r of rows) {
    let list: unknown = [];
    try {
      list = JSON.parse(String(r.platforms || "[]"));
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) continue;
    for (const p of new Set(list.filter((x): x is string => typeof x === "string"))) {
      out.set(normName(p), (out.get(normName(p)) || 0) + 1);
    }
  }
  return out;
}

export function listPlatforms(): PlannerPlatform[] {
  ensureTaxonomySchema();
  const usage = platformUsage();
  const rows = getPlannerDb()
    .prepare(`SELECT * FROM planner_platforms ORDER BY sort_order, name`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    iconKey: String(r.icon_key || ""),
    activeStatus: Number(r.active_status) === 1,
    sortOrder: Number(r.sort_order || 0),
    usageCount: usage.get(normName(r.name)) || 0,
  }));
}

export function getPlatform(id: string): PlannerPlatform | null {
  return listPlatforms().find((p) => p.id === id) || null;
}

export function createPlatform(input: { name: string; iconKey?: string; activeStatus?: boolean }): PlannerPlatform {
  ensureTaxonomySchema();
  const name = String(input.name || "").trim();
  if (!name) throw new TaxonomyError("A platform name is required");
  assertUniqueName("planner_platforms", name);
  const d = getPlannerDb();
  const maxSort = Number(
    (d.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM planner_platforms`).get() as { m: number })?.m ?? -1,
  );
  const id = randomUUID();
  const ts = nowIso();
  d.prepare(
    `INSERT INTO planner_platforms (id, name, icon_key, active_status, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    String(input.iconKey || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    input.activeStatus === false ? 0 : 1,
    maxSort + 1,
    ts,
    ts,
  );
  return getPlatform(id)!;
}

export function updatePlatform(
  id: string,
  patch: { name?: string; iconKey?: string; activeStatus?: boolean; sortOrder?: number },
): PlannerPlatform | null {
  ensureTaxonomySchema();
  const existing = getPlatform(id);
  if (!existing) return null;
  const name = patch.name === undefined ? existing.name : String(patch.name).trim();
  if (!name) throw new TaxonomyError("A platform name is required");
  if (patch.name !== undefined) assertUniqueName("planner_platforms", name, id);

  const d = getPlannerDb();
  const run = d.transaction(() => {
    // Renaming has to carry the posts with it: platforms are stored on items by
    // name, so a rename that only touched this table would orphan every post
    // tagged with the old spelling.
    if (name !== existing.name) {
      const rows = d.prepare(`SELECT id, platforms FROM planner_items`).all() as Array<{ id: string; platforms: string }>;
      const upd = d.prepare(`UPDATE planner_items SET platforms=?, updated_at=? WHERE id=?`);
      for (const r of rows) {
        let list: string[] = [];
        try {
          const parsed = JSON.parse(String(r.platforms || "[]"));
          list = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
        } catch {
          list = [];
        }
        if (!list.some((p) => normName(p) === normName(existing.name))) continue;
        const next = Array.from(new Set(list.map((p) => (normName(p) === normName(existing.name) ? name : p))));
        upd.run(JSON.stringify(next), nowIso(), r.id);
      }
    }
    d.prepare(`UPDATE planner_platforms SET name=?, icon_key=?, active_status=?, sort_order=?, updated_at=? WHERE id=?`).run(
      name,
      patch.iconKey === undefined ? existing.iconKey : String(patch.iconKey),
      patch.activeStatus === undefined ? (existing.activeStatus ? 1 : 0) : patch.activeStatus ? 1 : 0,
      patch.sortOrder === undefined ? existing.sortOrder : Number(patch.sortOrder),
      nowIso(),
      id,
    );
  });
  run();
  return getPlatform(id);
}

/**
 * Delete a platform. Same contract as categories: posts using it must be told
 * where to go — either onto another platform, or "unassigned", which strips the
 * tag and leaves the post itself alone.
 */
export function deletePlatform(id: string, reassignTo?: string | null): { deleted: boolean; reassigned: number } {
  ensureTaxonomySchema();
  const existing = getPlatform(id);
  if (!existing) return { deleted: false, reassigned: 0 };
  if (existing.usageCount > 0 && !reassignTo) {
    throw new TaxonomyError(
      `${existing.usageCount} content item${existing.usageCount === 1 ? "" : "s"} are still going out on "${existing.name}". Choose where they should go before deleting it.`,
      409,
      { usageCount: existing.usageCount, requires: "reassignTo" },
    );
  }
  let target: PlannerPlatform | null = null;
  if (reassignTo && reassignTo !== "unassigned") {
    target = getPlatform(reassignTo);
    if (!target) throw new TaxonomyError("The platform to move these items to does not exist", 400);
    if (target.id === id) throw new TaxonomyError("Items cannot be moved to the platform being deleted", 400);
  }

  const d = getPlannerDb();
  let reassigned = 0;
  const run = d.transaction(() => {
    const rows = d.prepare(`SELECT id, platforms FROM planner_items`).all() as Array<{ id: string; platforms: string }>;
    const upd = d.prepare(`UPDATE planner_items SET platforms=?, updated_at=? WHERE id=?`);
    for (const r of rows) {
      let list: string[] = [];
      try {
        const parsed = JSON.parse(String(r.platforms || "[]"));
        list = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
      } catch {
        list = [];
      }
      if (!list.some((p) => normName(p) === normName(existing.name))) continue;
      const stripped = list.filter((p) => normName(p) !== normName(existing.name));
      const next = target ? Array.from(new Set(stripped.concat([target.name]))) : stripped;
      upd.run(JSON.stringify(next), nowIso(), r.id);
      reassigned++;
    }
    d.prepare(`DELETE FROM planner_platforms WHERE id=?`).run(id);
  });
  run();
  return { deleted: true, reassigned };
}

/* ────────────────────────── team members ────────────────────────── */

export interface PlannerMemberView {
  userId: string;
  fullName: string;
  role: string;
  avatarInitials: string;
  badgeColor: string;
  active: boolean;
  /** Where the record comes from: the roster, the CRM user table, or here. */
  source: "roster" | "crm" | "planner";
  /** True when this planner has renamed / recoloured / deactivated the derived row. */
  overridden: boolean;
  /** False for planner-created members: only those can be deleted outright. */
  derived: boolean;
  usageCount: number;
}

interface MemberOverlayRow {
  id: string;
  full_name: string;
  role: string;
  avatar_initials: string;
  badge_color: string;
  active: number;
  origin: string;
  hidden: number;
  merged_into: string | null;
  sort_order: number;
}

function memberOverlay(): Map<string, MemberOverlayRow> {
  ensureTaxonomySchema();
  const rows = getPlannerDb().prepare(`SELECT * FROM planner_members`).all() as MemberOverlayRow[];
  return new Map(rows.map((r) => [String(r.id), r]));
}

function memberUsage(): Map<string, number> {
  const rows = getPlannerDb().prepare(`SELECT assigned_users FROM planner_items`).all() as Array<{ assigned_users: string }>;
  const out = new Map<string, number>();
  for (const r of rows) {
    let list: unknown = [];
    try {
      list = JSON.parse(String(r.assigned_users || "[]"));
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) continue;
    const ids = new Set<string>();
    for (const a of list) {
      if (typeof a === "string") ids.add(a);
      else if (a && typeof (a as { userId?: unknown }).userId === "string") ids.add((a as { userId: string }).userId);
    }
    for (const id of ids) out.set(id, (out.get(id) || 0) + 1);
  }
  return out;
}

function initialsOf(name: string): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Everyone assignable, derived rows and planner-created rows in one list.
 *
 * A derived row that this planner has hidden is dropped; one it has renamed or
 * recoloured keeps its id and shows the override. Hiding is scoped to the
 * planner on purpose — see rule 2 in the file header.
 */
export function listMembers(): PlannerMemberView[] {
  const overlay = memberOverlay();
  const usage = memberUsage();
  const out: PlannerMemberView[] = [];

  for (const m of listPlannerTeam()) {
    const o = overlay.get(m.userId);
    if (o && Number(o.hidden) === 1) continue;
    out.push({
      userId: m.userId,
      fullName: o?.full_name || m.fullName,
      role: o?.role || m.role,
      avatarInitials: o?.avatar_initials || m.avatarInitials,
      badgeColor: o?.badge_color || m.accentColor,
      active: o ? Number(o.active) === 1 && m.active : m.active,
      source: m.source,
      overridden: !!o,
      derived: true,
      usageCount: usage.get(m.userId) || 0,
    });
  }

  for (const o of overlay.values()) {
    if (o.origin !== "planner" || Number(o.hidden) === 1) continue;
    out.push({
      userId: o.id,
      fullName: o.full_name,
      role: o.role,
      avatarInitials: o.avatar_initials || initialsOf(o.full_name),
      badgeColor: o.badge_color || "#06B6D4",
      active: Number(o.active) === 1,
      source: "planner",
      overridden: false,
      derived: false,
      usageCount: usage.get(o.id) || 0,
    });
  }

  return out;
}

export function getMember(userId: string): PlannerMemberView | null {
  return listMembers().find((m) => m.userId === userId) || null;
}

/** Display name for an id, with "(Inactive)" appended when they are offboarded. */
export function memberName(userId: string): string {
  const m = getMember(userId);
  if (!m) return userId;
  return m.active ? m.fullName : `${m.fullName} (Inactive)`;
}

function upsertOverlay(id: string, patch: Partial<MemberOverlayRow>): void {
  ensureTaxonomySchema();
  const d = getPlannerDb();
  const existing = d.prepare(`SELECT * FROM planner_members WHERE id=?`).get(id) as MemberOverlayRow | undefined;
  const ts = nowIso();
  if (existing) {
    d.prepare(
      `UPDATE planner_members SET full_name=?, role=?, avatar_initials=?, badge_color=?, active=?, hidden=?, merged_into=?, sort_order=?, updated_at=? WHERE id=?`,
    ).run(
      patch.full_name ?? existing.full_name,
      patch.role ?? existing.role,
      patch.avatar_initials ?? existing.avatar_initials,
      patch.badge_color ?? existing.badge_color,
      patch.active === undefined ? existing.active : patch.active,
      patch.hidden === undefined ? existing.hidden : patch.hidden,
      patch.merged_into === undefined ? existing.merged_into : patch.merged_into,
      patch.sort_order === undefined ? existing.sort_order : patch.sort_order,
      ts,
      id,
    );
    return;
  }
  d.prepare(
    `INSERT INTO planner_members (id, full_name, role, avatar_initials, badge_color, active, origin, hidden, merged_into, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    patch.full_name ?? "",
    patch.role ?? "",
    patch.avatar_initials ?? "",
    patch.badge_color ?? "",
    patch.active === undefined ? 1 : patch.active,
    patch.origin ?? "override",
    patch.hidden ?? 0,
    patch.merged_into ?? null,
    patch.sort_order ?? 0,
    ts,
    ts,
  );
}

export function createMember(input: {
  fullName: string;
  role?: string;
  avatarInitials?: string;
  badgeColor?: string;
}): PlannerMemberView {
  ensureTaxonomySchema();
  const fullName = String(input.fullName || "").trim();
  if (!fullName) throw new TaxonomyError("A name is required");
  const clash = listMembers().find((m) => normName(m.fullName) === normName(fullName));
  if (clash) {
    throw new TaxonomyError(
      `"${clash.fullName}" is already on the team list. Names are compared without case.`,
      409,
      { conflictId: clash.userId },
    );
  }
  const badgeColor = String(input.badgeColor || "").trim();
  if (badgeColor && !HEX_RE.test(badgeColor)) throw new TaxonomyError("badgeColor must be a #rrggbb value");
  const id = `pm_${randomUUID()}`;
  upsertOverlay(id, {
    full_name: fullName,
    role: String(input.role || "Team member"),
    avatar_initials: String(input.avatarInitials || initialsOf(fullName)).slice(0, 3).toUpperCase(),
    badge_color: badgeColor || PALETTE_20[5].hex,
    active: 1,
    origin: "planner",
    hidden: 0,
  });
  return getMember(id)!;
}

export function updateMember(
  userId: string,
  patch: { fullName?: string; role?: string; avatarInitials?: string; badgeColor?: string; active?: boolean },
): PlannerMemberView | null {
  const existing = getMember(userId);
  if (!existing) return null;
  if (patch.fullName !== undefined) {
    const name = String(patch.fullName).trim();
    if (!name) throw new TaxonomyError("A name is required");
    const clash = listMembers().find((m) => m.userId !== userId && normName(m.fullName) === normName(name));
    if (clash) {
      throw new TaxonomyError(`"${clash.fullName}" is already on the team list.`, 409, { conflictId: clash.userId });
    }
  }
  if (patch.badgeColor !== undefined && !HEX_RE.test(String(patch.badgeColor))) {
    throw new TaxonomyError("badgeColor must be a #rrggbb value");
  }
  upsertOverlay(userId, {
    full_name: patch.fullName === undefined ? existing.fullName : String(patch.fullName).trim(),
    role: patch.role === undefined ? existing.role : String(patch.role),
    avatar_initials:
      patch.avatarInitials === undefined
        ? existing.avatarInitials
        : String(patch.avatarInitials).slice(0, 3).toUpperCase(),
    badge_color: patch.badgeColor === undefined ? existing.badgeColor : String(patch.badgeColor).toUpperCase(),
    active: patch.active === undefined ? (existing.active ? 1 : 0) : patch.active ? 1 : 0,
    origin: existing.derived ? "override" : "planner",
  });
  return getMember(userId);
}

/**
 * Remove a member from the planner, moving their content to someone else.
 *
 * This is the deduplication path: two "Marco" records exist because the roster
 * and the CRM user table each hold one under a different spelling, and merging
 * them by name is exactly what listPlannerTeam could not do. Deleting the
 * secondary record with `mergeInto` set to the primary rewrites every
 * assignment first, so no post is left pointing at an id nobody renders.
 *
 * Assignments are rewritten with the target DEDUPED IN — a post that already
 * had both Marcos on it must end up with one, not the same person twice.
 */
export function deleteMember(
  userId: string,
  mergeInto?: string | null,
): { deleted: boolean; reassigned: number; hiddenOnly: boolean } {
  const existing = getMember(userId);
  if (!existing) return { deleted: false, reassigned: 0, hiddenOnly: false };

  if (existing.usageCount > 0 && !mergeInto) {
    throw new TaxonomyError(
      `${existing.fullName} is assigned to ${existing.usageCount} content item${existing.usageCount === 1 ? "" : "s"}. Choose who should take them over before removing the account.`,
      409,
      { usageCount: existing.usageCount, requires: "mergeInto" },
    );
  }

  let target: PlannerMemberView | null = null;
  if (mergeInto && mergeInto !== "unassigned") {
    target = getMember(mergeInto);
    if (!target) throw new TaxonomyError("The team member to merge into does not exist", 400);
    if (target.userId === userId) throw new TaxonomyError("A member cannot be merged into themselves", 400);
  }

  const d = getPlannerDb();
  let reassigned = 0;
  const run = d.transaction(() => {
    const rows = d.prepare(`SELECT id, assigned_users FROM planner_items`).all() as Array<{
      id: string;
      assigned_users: string;
    }>;
    const upd = d.prepare(`UPDATE planner_items SET assigned_users=?, updated_at=? WHERE id=?`);
    for (const r of rows) {
      let list: Array<{ userId: string; role: string }> = [];
      try {
        const parsed = JSON.parse(String(r.assigned_users || "[]"));
        if (Array.isArray(parsed)) {
          list = parsed
            .map((a) =>
              typeof a === "string"
                ? { userId: a, role: "owner" }
                : a && typeof a.userId === "string"
                  ? { userId: a.userId, role: typeof a.role === "string" && a.role ? a.role : "owner" }
                  : null,
            )
            .filter((a): a is { userId: string; role: string } => !!a);
        }
      } catch {
        list = [];
      }
      if (!list.some((a) => a.userId === userId)) continue;
      const kept = list.filter((a) => a.userId !== userId);
      if (target && !kept.some((a) => a.userId === target!.userId)) {
        const role = list.find((a) => a.userId === userId)?.role || "owner";
        kept.push({ userId: target.userId, role });
      }
      upd.run(JSON.stringify(kept), nowIso(), r.id);
      reassigned++;
    }

    if (existing.derived) {
      // Scoped removal: hidden here, untouched in the roster and the CRM.
      upsertOverlay(userId, { hidden: 1, merged_into: target ? target.userId : null, origin: "override" });
    } else {
      d.prepare(`DELETE FROM planner_members WHERE id=?`).run(userId);
    }
  });
  run();
  return { deleted: true, reassigned, hiddenOnly: existing.derived };
}

/** Undo a scoped removal — a derived member hidden here comes back. */
export function restoreMember(userId: string): boolean {
  ensureTaxonomySchema();
  const d = getPlannerDb();
  const row = d.prepare(`SELECT * FROM planner_members WHERE id=?`).get(userId) as MemberOverlayRow | undefined;
  if (!row || Number(row.hidden) !== 1) return false;
  d.prepare(`UPDATE planner_members SET hidden=0, merged_into=NULL, updated_at=? WHERE id=?`).run(nowIso(), userId);
  return true;
}

/** Derived members this planner is currently hiding, for the "removed" list. */
export function hiddenMembers(): Array<{ userId: string; fullName: string; mergedInto: string | null }> {
  ensureTaxonomySchema();
  const rows = getPlannerDb().prepare(`SELECT * FROM planner_members WHERE hidden=1`).all() as MemberOverlayRow[];
  const derived = new Map(listPlannerTeam().map((m) => [m.userId, m.fullName]));
  return rows.map((r) => ({
    userId: r.id,
    fullName: r.full_name || derived.get(r.id) || r.id,
    mergedInto: r.merged_into,
  }));
}
