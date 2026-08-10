import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/**
 * Per-user UI preferences — today: table column layout and sort, per view.
 *
 * Brivity persists Columns and Sort By per agent, not globally, and that is
 * the point of the feature: each person's working list can look different.
 * Same storage shape as command-settings.json (one JSON file with
 * Record<userId, T> maps) but its own file, so a bug here can never wipe the
 * team's dashboard layouts and vice versa.
 */

export interface TablePrefs {
  /** Column keys hidden from the table. */
  hidden?: string[];
  /** Column keys in display order; columns not listed keep their default position after these. */
  order?: string[];
  /** Sort field key, or null for the view's default ordering. */
  sortField?: string | null;
  /** 1 = ascending, -1 = descending. */
  sortDir?: 1 | -1;
}

type PrefsFile = {
  /** userId -> tableKey ("leads" | "people" | "tx" | ...) -> prefs */
  tables?: Record<string, Record<string, TablePrefs>>;
  updatedAt?: string;
};

const MAX_USERS = 50;
const MAX_TABLES_PER_USER = 12;
const MAX_COLS = 40;

function resolvePrefsPath(): string {
  const explicit = process.env.USER_PREFS_JSON_PATH?.trim();
  if (explicit) return explicit;
  const flyDb = "/data/db.json";
  const localDb = join(process.cwd(), "data", "local-dashboard-db.json");
  const dbPath = process.env.DB_JSON_PATH?.trim() || (existsSync(flyDb) ? flyDb : localDb);
  return join(dirname(dbPath), "user-prefs.json");
}

const PREFS_PATH = resolvePrefsPath();

function readFile(): PrefsFile {
  try {
    if (!existsSync(PREFS_PATH)) return {};
    const raw = readFileSync(PREFS_PATH, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PrefsFile) : {};
  } catch (err) {
    console.error("[userPrefs] read failed:", err);
    return {};
  }
}

function writeFileSafe(data: PrefsFile): void {
  try {
    mkdirSync(dirname(PREFS_PATH), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("[userPrefs] write failed:", err);
  }
}

function cleanKey(raw: unknown, max = 64): string {
  return typeof raw === "string" ? raw.trim().slice(0, max) : "";
}

function sanitizeTablePrefs(raw: unknown): TablePrefs {
  const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const strList = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 64));
    return out.slice(0, MAX_COLS);
  };
  const out: TablePrefs = {};
  const hidden = strList(p.hidden);
  if (hidden) out.hidden = hidden;
  const order = strList(p.order);
  if (order) out.order = order;
  if (p.sortField === null) out.sortField = null;
  else if (typeof p.sortField === "string" && p.sortField.trim()) out.sortField = p.sortField.trim().slice(0, 64);
  if (p.sortDir === 1 || p.sortDir === -1) out.sortDir = p.sortDir;
  return out;
}

/** All table prefs for one user (empty object when none saved). */
export function getUserTablePrefs(userId: string): Record<string, TablePrefs> {
  const uid = cleanKey(userId);
  if (!uid) return {};
  const data = readFile();
  return data.tables?.[uid] ?? {};
}

/** Merge-write one table's prefs for one user; returns the saved prefs. */
export function setUserTablePrefs(userId: string, tableKey: string, prefs: unknown): TablePrefs {
  const uid = cleanKey(userId);
  const table = cleanKey(tableKey, 32);
  if (!uid || !table) throw new Error("user and table are required");
  const clean = sanitizeTablePrefs(prefs);
  const data = readFile();
  const tables = data.tables ?? {};
  if (!tables[uid] && Object.keys(tables).length >= MAX_USERS) {
    throw new Error("too many users with saved preferences");
  }
  const mine = tables[uid] ?? {};
  if (!mine[table] && Object.keys(mine).length >= MAX_TABLES_PER_USER) {
    throw new Error("too many tables with saved preferences");
  }
  mine[table] = clean;
  tables[uid] = mine;
  writeFileSafe({ ...data, tables, updatedAt: new Date().toISOString() });
  return clean;
}
