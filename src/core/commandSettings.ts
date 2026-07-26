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
export interface CommandSettings {
  /** IANA zone, e.g. "America/Chicago". */
  timeZone: string;
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
  return { timeZone: DEFAULT_TIME_ZONE, updatedAt: new Date().toISOString() };
}

export function getCommandSettings(): CommandSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return defaults();
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Partial<CommandSettings>;
    return {
      timeZone: isValidTimeZone(raw?.timeZone) ? raw.timeZone : DEFAULT_TIME_ZONE,
      updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
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
