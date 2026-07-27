import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/**
 * Small shared settings for Task Command.
 *
 * The important one is `timeZone`. Day boundaries used to come from whatever
 * machine happened to be looking, so Marco in Texas and Wesley elsewhere
 * disagreed about which day a task was due and whether it had rolled over.
 * Everything that asks "what day is it" now resolves against this one zone.
 */
/** One widget's placement on the 12-column dashboard grid. */
export interface WidgetPlacement {
  id: string;
  x: number;      // 0-11
  y: number;      // row index
  w: number;      // columns
  h: number;      // rows
  hidden?: boolean;
}

export interface CommandSettings {
  /** IANA zone, e.g. "America/Chicago". */
  timeZone: string;
  /** Per-user dashboard layouts, keyed by user id, so they follow between machines. */
  layouts?: Record<string, WidgetPlacement[]>;
  updatedAt: string;
  updatedBy?: string;
}

const DEFAULT_TIME_ZONE = "America/Chicago";

function resolveSettingsPath(): string {
  const explicit = process.env.COMMAND_SETTINGS_JSON_PATH?.trim();
  if (explicit) return explicit;
  const flyDb = "/data/db.json";
  const localDb = join(process.cwd(), "data", "local-dashboard-db.json");
  const dbPath = process.env.DB_JSON_PATH?.trim() || (existsSync(flyDb) ? flyDb : localDb);
  return join(dirname(dbPath), "command-settings.json");
}

const SETTINGS_PATH = resolveSettingsPath();

/** True when the runtime actually knows this zone, so we never store a dud. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function defaults(): CommandSettings {
  return { timeZone: DEFAULT_TIME_ZONE, layouts: {}, updatedAt: new Date().toISOString() };
}

/** Keep stored placements sane: whole numbers, on-grid, bounded size. */
function sanitizeLayout(raw: unknown): WidgetPlacement[] {
  if (!Array.isArray(raw)) return [];
  const out: WidgetPlacement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const w = item as Record<string, unknown>;
    const id = typeof w.id === "string" ? w.id.trim().slice(0, 40) : "";
    if (!id) continue;
    const num = (v: unknown, min: number, max: number, dflt: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
    };
    out.push({
      id,
      x: num(w.x, 0, 11, 0),
      y: num(w.y, 0, 200, 0),
      w: num(w.w, 2, 12, 6),
      h: num(w.h, 2, 60, 8),
      hidden: w.hidden === true,
    });
    if (out.length >= 24) break;
  }
  return out;
}

export function getCommandSettings(): CommandSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return defaults();
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Partial<CommandSettings>;
    return {
      timeZone: isValidTimeZone(raw?.timeZone) ? raw.timeZone : DEFAULT_TIME_ZONE,
      updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      layouts: raw?.layouts && typeof raw.layouts === "object"
        ? Object.fromEntries(Object.entries(raw.layouts as Record<string, unknown>)
            .slice(0, 50)
            .map(([k, v]) => [k, sanitizeLayout(v)]))
        : {},
      updatedBy: typeof raw?.updatedBy === "string" ? raw.updatedBy : undefined,
    };
  } catch {
    return defaults();
  }
}

export function setCommandTimeZone(timeZone: string, updatedBy?: string): CommandSettings {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Unknown time zone: ${timeZone}`);
  }
  const next: CommandSettings = {
    timeZone: timeZone.trim(),
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy?.trim() || undefined,
  };
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

/** "YYYY-MM-DD" for `at` in the command zone. */
export function commandDateString(at: Date = new Date(), tz = getCommandSettings().timeZone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
}

/** Today in the command zone, offset by whole days. */
export function commandDatePlus(days: number, at: Date = new Date(), tz = getCommandSettings().timeZone): string {
  const base = commandDateString(at, tz);
  const [y, m, d] = base.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Save one user's dashboard arrangement without touching anyone else's. */
export function setUserLayout(userId: string, layout: unknown): WidgetPlacement[] {
  const uid = String(userId || "").trim().slice(0, 60);
  if (!uid) throw new Error("userId required");
  const current = getCommandSettings();
  const layouts = { ...(current.layouts || {}) };
  const clean = sanitizeLayout(layout);
  if (clean.length) layouts[uid] = clean;
  else delete layouts[uid];
  const next: CommandSettings = { ...current, layouts, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return clean;
}

export function getUserLayout(userId: string): WidgetPlacement[] {
  const uid = String(userId || "").trim();
  return (getCommandSettings().layouts || {})[uid] || [];
}
