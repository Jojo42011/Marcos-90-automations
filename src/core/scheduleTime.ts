/**
 * Turn a plain-language send time into a real instant.
 *
 * "send this Tuesday morning" has to mean Tuesday morning **where Marco is**,
 * not UTC — so everything resolves against the team's command time zone
 * (commandSettings.timeZone, default America/Chicago), the same zone the task
 * board already uses for day boundaries.
 *
 * Deliberately narrow: it parses the handful of shapes people actually say
 * and returns `null` for anything else, so Harvey asks a clarifying question
 * instead of guessing a time to send a real message to a real client. Silent
 * guesses are exactly what this codebase's conventions rule out, and the cost
 * of being wrong here is a text arriving at 3am.
 *
 * No new dependency (the fast overlay deploy path can't npm install), so the
 * zone math is done with Intl rather than a date library.
 */
import { getCommandSettings } from "./commandSettings.js";

export interface ParsedSendTime {
  /** UTC ISO instant to send at. */
  sendAt: string;
  /** Human echo of what was understood, e.g. "Tue, Aug 4, 9:00 AM CDT". */
  interpreted: string;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/** Vague parts of day → a concrete hour. */
const DAYPARTS: Record<string, number> = {
  morning: 9,
  noon: 12,
  midday: 12,
  afternoon: 14,
  evening: 18,
  tonight: 19,
  night: 20,
};

/** The wall-clock fields of an instant, as seen in a time zone. */
function partsIn(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    // Intl gives "24" for midnight in hour12:false; normalise it.
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second),
    weekday: p.weekday,
  };
}

/**
 * Wall-clock in `tz` → UTC instant. Iterates twice because the offset itself
 * depends on the instant (DST), so the first guess can be an hour off on a
 * transition day.
 */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  for (let i = 0; i < 2; i++) {
    const seen = partsIn(guess, tz);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0);
    const wantAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
    const drift = wantAsUtc - seenAsUtc;
    if (drift === 0) break;
    guess = new Date(guess.getTime() + drift);
  }
  return guess;
}

function describe(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(date);
}

/** "3pm", "9:30 am", "15:00" → minutes since midnight, or null. */
function parseClock(text: string): number | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (hour > 23 || min > 59) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  // Bare "at 3" with no am/pm and no colon: assume working hours, not 3am.
  if (!ampm && !m[2] && hour >= 1 && hour <= 7) hour += 12;
  return hour * 60 + min;
}

/**
 * Parse a phrase into an instant. Returns null when unsure — callers should
 * ask rather than assume.
 */
export function parseSendTime(
  phrase: string,
  now: Date = new Date(),
  tz: string = getCommandSettings().timeZone,
): ParsedSendTime | null {
  const raw = String(phrase || "").trim().toLowerCase();
  if (!raw) return null;

  // Backward-looking phrases are never a send time. Without this, "at 4pm
  // last tuesday" matched on the weekday, ignored "last", and scheduled for
  // the NEXT Tuesday — silently sending something a week late.
  if (/\b(last|yesterday|ago|previous)\b/.test(raw)) return null;

  const finish = (d: Date): ParsedSendTime | null => {
    if (!Number.isFinite(d.getTime())) return null;
    // Never schedule into the past; a time that has passed is a mistake, not
    // an instruction to send immediately.
    if (d.getTime() < now.getTime() - 60_000) return null;
    return { sendAt: d.toISOString(), interpreted: describe(d, tz) };
  };

  // Explicit ISO instant — trust it as given.
  if (/^\d{4}-\d{2}-\d{2}t/i.test(raw)) {
    const d = new Date(phrase);
    return Number.isFinite(d.getTime()) ? finish(d) : null;
  }

  // "YYYY-MM-DD [HH:MM]" — a date the user typed, so it means local wall clock.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?:[ t]+(\d{1,2}):(\d{2}))?$/.exec(raw);
  if (ymd) {
    const mins = ymd[4] ? Number(ymd[4]) * 60 + Number(ymd[5]) : 9 * 60;
    return finish(zonedToUtc(+ymd[1], +ymd[2], +ymd[3], Math.floor(mins / 60), mins % 60, tz));
  }

  // "in 20 minutes" / "in 2 hours" / "in 3 days"
  const rel = /^in\s+(\d+)\s*(minute|min|hour|hr|day)s?$/.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit.startsWith("min") ? n * 60_000 : unit.startsWith("h") ? n * 3_600_000 : n * 86_400_000;
    return finish(new Date(now.getTime() + ms));
  }

  const nowParts = partsIn(now, tz);
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;

  // Time of day: an explicit clock wins over a vague daypart word.
  let minuteOfDay: number | null = null;
  const clockMatch = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(raw)
    || /\b(\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i.exec(raw)
    || /\b(\d{1,2}\s*(?:am|pm))\b/i.exec(raw);
  if (clockMatch) minuteOfDay = parseClock(clockMatch[1]);
  if (minuteOfDay == null) {
    for (const [word, hour] of Object.entries(DAYPARTS)) {
      if (new RegExp(`\\b${word}\\b`).test(raw)) { minuteOfDay = hour * 60; break; }
    }
  }

  const at = (dayOffset: number, mins: number) => {
    const base = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));
    base.setUTCDate(base.getUTCDate() + dayOffset);
    return zonedToUtc(
      base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(),
      Math.floor(mins / 60), mins % 60, tz,
    );
  };

  if (/\btomorrow\b/.test(raw)) return finish(at(1, minuteOfDay ?? 9 * 60));
  if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/.test(raw)) {
    return finish(at(0, minuteOfDay ?? DAYPARTS.tonight * 60));
  }

  // Weekday: next occurrence. "next friday" always skips to the following
  // week even when today is Friday; bare "friday" means the soonest Friday
  // that hasn't passed.
  for (const [word, target] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${word}\\b`).test(raw)) continue;
    const todayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(nowParts.weekday);
    if (todayIdx < 0) return null;
    let delta = (target - todayIdx + 7) % 7;
    const mins = minuteOfDay ?? 9 * 60;
    if (delta === 0 && (/(\bnext\b)/.test(raw) || mins <= nowMinutes)) delta = 7;
    if (/\bnext\b/.test(raw) && delta !== 7 && delta < 7) delta += 0; // "next tue" from Sun = this coming Tue
    return finish(at(delta, mins));
  }

  // Bare time with no day ("at 4pm") → today if still ahead, else tomorrow.
  if (minuteOfDay != null) {
    return finish(at(minuteOfDay > nowMinutes ? 0 : 1, minuteOfDay));
  }

  return null;
}

/**
 * A sensible default when nobody named a time — the next weekday 9am local.
 * Used only when the caller explicitly asks for a suggestion.
 */
export function suggestNextGoodTime(
  now: Date = new Date(),
  tz: string = getCommandSettings().timeZone,
): ParsedSendTime {
  const p = partsIn(now, tz);
  const nowMinutes = p.hour * 60 + p.minute;
  let offset = nowMinutes < 9 * 60 ? 0 : 1;
  for (let i = 0; i < 7; i++) {
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
    base.setUTCDate(base.getUTCDate() + offset);
    const d = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 9, 0, tz);
    const wd = partsIn(d, tz).weekday;
    if (wd !== "Sat" && wd !== "Sun") return { sendAt: d.toISOString(), interpreted: describe(d, tz) };
    offset++;
  }
  const fallback = new Date(now.getTime() + 86_400_000);
  return { sendAt: fallback.toISOString(), interpreted: describe(fallback, tz) };
}
