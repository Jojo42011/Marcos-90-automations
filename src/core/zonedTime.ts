/**
 * IANA timezone arithmetic, DST included, with no new dependency.
 *
 * WHY THIS FILE EXISTS. The content planner stores every scheduled time as a
 * UTC instant, but a human always types a wall clock ("10:00 AM") in some
 * place ("America/Chicago"). Turning one into the other is the part everybody
 * gets wrong, because the offset depends on the instant you are converting —
 * which is the thing you do not have yet. Naive `new Date("2026-03-08T02:30")`
 * plus a fixed offset silently produces the wrong hour twice a year.
 *
 * Node ships full ICU, so `Intl.DateTimeFormat` already knows every zone's
 * real DST rules. That is the "real timezone library" the spec asks for; the
 * only thing missing is the inverse direction (wall clock → instant), which is
 * what `zonedWallToUtc` implements below via the standard two-pass fixpoint.
 *
 * The two edge cases are handled explicitly rather than papered over:
 *
 *   nonexistent — spring forward. 2:30 AM on the changeover day never happens.
 *                 We return the instant the clock jumps to and say so.
 *   ambiguous   — fall back. 1:30 AM happens twice. We return the FIRST
 *                 (pre-transition) occurrence and say so.
 *
 * Callers surface both as a warning on the item rather than guessing quietly,
 * because "your 2:30 post actually goes out at 3:00" is exactly the kind of
 * thing an operator needs told.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

export type DstFlag = "ok" | "nonexistent" | "ambiguous";

export interface WallToUtcResult {
  utcMs: number;
  utcIso: string;
  dst: DstFlag;
  /** Offset actually used, in minutes east of UTC (e.g. -300 for CDT). */
  offsetMinutes: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** True if the runtime accepts this string as an IANA zone. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** The wall clock shown in `tz` at a given UTC instant. */
export function utcToZonedParts(utcMs: number, tz: string): ZonedParts {
  const parts = partsFormatter(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Offset of `tz` at a given instant, in minutes east of UTC.
 * Derived by formatting the instant in the zone and reading the wall clock
 * back as if it were UTC — the gap between the two IS the offset.
 */
export function zoneOffsetMinutes(utcMs: number, tz: string): number {
  const p = utcToZonedParts(utcMs, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - utcMs) / 60000);
}

/**
 * Wall clock in `tz` → UTC instant.
 *
 * Two passes: guess with the offset in force at the naive instant, then
 * re-read the offset at the candidate and correct. That converges everywhere
 * except inside a DST discontinuity, which the third step detects by asking
 * whether the answer round-trips back to the wall clock we were given.
 */
export function zonedWallToUtc(parts: ZonedParts, tz: string): WallToUtcResult {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0,
  );

  const matchesWall = (ms: number): boolean => {
    const b = utcToZonedParts(ms, tz);
    return (
      b.year === parts.year &&
      b.month === parts.month &&
      b.day === parts.day &&
      b.hour === parts.hour &&
      b.minute === parts.minute
    );
  };

  /*
   * Every offset this zone is in force for anywhere near the target. A day
   * either side brackets any transition, so on a normal date this is one
   * offset and on a changeover date it is exactly the two in play.
   */
  const dayBefore = zoneOffsetMinutes(naive - 86400000, tz);
  const candidateOffsets = Array.from(
    new Set([dayBefore, zoneOffsetMinutes(naive, tz), zoneOffsetMinutes(naive + 86400000, tz)]),
  );

  const valid: Array<{ ms: number; offset: number }> = [];
  for (const offset of candidateOffsets) {
    const ms = naive - offset * 60000;
    if (matchesWall(ms)) valid.push({ ms, offset });
  }

  if (valid.length === 1) {
    return { utcMs: valid[0].ms, utcIso: new Date(valid[0].ms).toISOString(), dst: "ok", offsetMinutes: valid[0].offset };
  }

  if (valid.length > 1) {
    // Fall back: this wall clock happens twice. Take the first pass, which is
    // what a person scheduling "1:30 AM" means, and say it was ambiguous.
    valid.sort((a, b) => a.ms - b.ms);
    return { utcMs: valid[0].ms, utcIso: new Date(valid[0].ms).toISOString(), dst: "ambiguous", offsetMinutes: valid[0].offset };
  }

  // Spring forward: this wall clock never happens. Reading it with the
  // PRE-transition offset lands just past the jump — 2:30 becomes 3:30, which
  // is both the conventional resolution and the one an operator expects.
  const ms = naive - dayBefore * 60000;
  return {
    utcMs: ms,
    utcIso: new Date(ms).toISOString(),
    dst: "nonexistent",
    offsetMinutes: zoneOffsetMinutes(ms, tz),
  };
}

/** "2026-08-15" as seen in `tz` at this instant. */
export function zonedDateKey(utcMs: number, tz: string): string {
  const p = utcToZonedParts(utcMs, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "10:00 AM" as seen in `tz`. */
export function zonedTimeLabel(utcMs: number, tz: string): string {
  const p = utcToZonedParts(utcMs, tz);
  const suffix = p.hour < 12 ? "AM" : "PM";
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${String(h12).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ${suffix}`;
}

/** "HH:MM" 24h, for <input type="time">. */
export function zonedTimeInput(utcMs: number, tz: string): string {
  const p = utcToZonedParts(utcMs, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * Whole-day difference between the same instant read in two zones: +1, 0, -1.
 * This is what makes the "+1d" badge on a card honest — a 10 PM Manila post is
 * a 9 AM New York post on the PREVIOUS day, and the card has to say so.
 */
export function dayDelta(utcMs: number, fromTz: string, toTz: string): number {
  const a = zonedDateKey(utcMs, fromTz);
  const b = zonedDateKey(utcMs, toTz);
  if (a === b) return 0;
  const da = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const db = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((db - da) / 86400000);
}

/** "+1d" / "-1d" / "" — the badge suffix itself. */
export function dayDeltaLabel(delta: number): string {
  if (!delta) return "";
  return delta > 0 ? `+${delta}d` : `${delta}d`;
}

/**
 * Shift an instant by whole days, keeping the wall clock in `tz` intact.
 *
 * Adding 86400000 ms is NOT the same thing across a DST boundary: it turns a
 * 10:00 post into a 9:00 or 11:00 post. Moving the calendar date and
 * re-resolving the wall clock is what a person means by "same time, next day".
 */
export function shiftDaysInZone(utcMs: number, tz: string, days: number): WallToUtcResult {
  const p = utcToZonedParts(utcMs, tz);
  const moved = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedWallToUtc(
    {
      year: moved.getUTCFullYear(),
      month: moved.getUTCMonth() + 1,
      day: moved.getUTCDate(),
      hour: p.hour,
      minute: p.minute,
      second: 0,
    },
    tz,
  );
}

/** Whole days between two YYYY-MM-DD keys (b - a). */
export function dateKeyDiff(a: string, b: string): number {
  const pa = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const pb = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((pb - pa) / 86400000);
}

/** Short zone label with its current offset, e.g. "CDT (UTC-5)". */
export function zoneLabel(tz: string, atMs = Date.now()): string {
  const mins = zoneOffsetMinutes(atMs, tz);
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const offset = `UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
  let abbr = "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date(atMs));
    abbr = parts.find((p) => p.type === "timeZoneName")?.value || "";
  } catch {
    abbr = "";
  }
  return abbr && !/^GMT/.test(abbr) ? `${abbr} (${offset})` : offset;
}

/**
 * Does a DST transition fall between two instants in this zone? Used to warn
 * when a domino shift drags a batch of posts across a changeover, since their
 * offset — not their wall clock — is what moves.
 */
export function crossesDstTransition(fromMs: number, toMs: number, tz: string): boolean {
  if (fromMs === toMs) return false;
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  return zoneOffsetMinutes(lo, tz) !== zoneOffsetMinutes(hi, tz);
}
