/**
 * Cron for Harvey's scheduled tasks: parsing, DST-correct next-run, and the
 * English-to-cron path an operator actually uses.
 *
 * WHY NO LIBRARY. The deploy path here cannot run `npm install` (a new
 * dependency forces a full image rebuild), and the repo's rule is to prefer
 * Node built-ins. Everything hard about cron in this system is the timezone,
 * and `core/zonedTime.ts` already solves that with full-ICU `Intl` — including
 * the two DST discontinuities that naive offset math gets wrong twice a year.
 * So this file is field parsing plus a search, and the zone work is delegated.
 *
 * WHY NEXT-RUN IS COMPUTED IN WALL-CLOCK SPACE. "Every day at 7am" means 7am on
 * the operator's clock, not a fixed number of milliseconds. Stepping UTC
 * instants forward would drift an hour across a changeover and quietly deliver
 * the 7am report at 6am for half the year. So the search walks candidate
 * *calendar* days and *wall* times in the target zone, and only converts to an
 * instant once a match is found.
 *
 * WHY THERE IS A MINIMUM INTERVAL. A cron is a standing instruction to spend
 * money. `* * * * *` against a tool-using agent is 1,440 agent runs a day, and
 * the operator who typed it would not find out until the bill. The floor is
 * enforced at parse time so the mistake cannot be stored, and it is the reason
 * `validateSchedule` exists separately from `parseCron`.
 */
import { isValidTimeZone, utcToZonedParts, zonedWallToUtc } from "../core/zonedTime.js";

/** The business runs on Central time; a task with no zone means Marco's clock. */
export const DEFAULT_TIMEZONE = "America/Chicago";

/** Floor on how often a schedule may fire. Each run costs tokens. */
export function minIntervalMinutes(): number {
  const n = parseInt(process.env.HARVEY_CRON_MIN_INTERVAL_MINUTES || "15", 10);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

export interface CronFields {
  minutes: number[];
  hours: number[];
  /** Days of month, 1-31. */
  doms: number[];
  /** Months, 1-12. */
  months: number[];
  /** Days of week, 0-6, Sunday = 0. */
  dows: number[];
  /**
   * Vixie cron's day rule: when BOTH day-of-month and day-of-week are
   * restricted, a day matches if EITHER does. Tracking which fields were
   * restricted is the only way to reproduce that, and getting it wrong makes
   * "1st of the month" and "every Monday" silently intersect to almost never.
   */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export class CronError extends Error {}

function expandField(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
  fieldName: string,
): { values: number[]; restricted: boolean } {
  const field = raw.trim().toLowerCase();
  if (!field) throw new CronError(`Empty ${fieldName} field.`);

  const out = new Set<number>();
  let restricted = true;

  for (const part of field.split(",")) {
    const chunk = part.trim();
    if (!chunk) throw new CronError(`Empty entry in the ${fieldName} field.`);

    let step = 1;
    let range = chunk;
    const slash = chunk.indexOf("/");
    if (slash >= 0) {
      range = chunk.slice(0, slash);
      const stepRaw = chunk.slice(slash + 1);
      step = parseInt(stepRaw, 10);
      if (!Number.isFinite(step) || step < 1) {
        throw new CronError(`"${stepRaw}" is not a step value in the ${fieldName} field.`);
      }
    }

    const resolve = (token: string): number => {
      const t = token.trim();
      if (names && names[t] !== undefined) return names[t];
      const n = parseInt(t, 10);
      if (!Number.isFinite(n)) throw new CronError(`"${token}" is not valid in the ${fieldName} field.`);
      return n;
    };

    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
      if (step === 1) restricted = false;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = resolve(a);
      hi = resolve(b);
    } else {
      lo = resolve(range);
      hi = slash >= 0 ? max : lo;
    }

    if (lo < min || hi > max || lo > hi) {
      throw new CronError(`"${chunk}" is out of range for the ${fieldName} field (${min}-${max}).`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  if (!out.size) throw new CronError(`The ${fieldName} field matches nothing.`);
  return { values: [...out].sort((a, b) => a - b), restricted };
}

/** Parse a 5-field cron expression (or a supported `@macro`). */
export function parseCron(expr: string): CronFields {
  if (!expr || typeof expr !== "string") throw new CronError("A schedule is required.");
  const trimmed = expr.trim().toLowerCase();
  const normalized = MACROS[trimmed] || trimmed;

  const fields = normalized.split(/\s+/);
  if (fields.length === 6) {
    /* Quartz-style expressions lead with seconds. Accepting them silently would
       shift every field by one and schedule something an operator never asked
       for, so this refuses and says exactly what to remove. */
    throw new CronError(
      "This looks like a 6-field cron with seconds. Use 5 fields: minute hour day-of-month month day-of-week.",
    );
  }
  if (fields.length !== 5) {
    throw new CronError(`A cron expression needs 5 fields, got ${fields.length}.`);
  }

  const minutes = expandField(fields[0], 0, 59, null, "minute");
  const hours = expandField(fields[1], 0, 23, null, "hour");
  const doms = expandField(fields[2], 1, 31, null, "day-of-month");
  const months = expandField(fields[3], 1, 12, MONTH_NAMES, "month");
  const dowRaw = expandField(fields[4], 0, 7, DOW_NAMES, "day-of-week");

  // Cron accepts 7 for Sunday. Fold it so matching only ever sees 0-6.
  const dows = [...new Set(dowRaw.values.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);

  return {
    minutes: minutes.values,
    hours: hours.values,
    doms: doms.values,
    months: months.values,
    dows,
    domRestricted: doms.restricted,
    dowRestricted: dowRaw.restricted,
  };
}

/** Smallest gap this schedule can produce, in minutes. Used to enforce the floor. */
export function smallestIntervalMinutes(fields: CronFields): number {
  const { minutes, hours } = fields;

  // More than one minute slot inside the same hour: the gap is between them.
  if (minutes.length > 1) {
    let smallest = Infinity;
    for (let i = 1; i < minutes.length; i++) smallest = Math.min(smallest, minutes[i] - minutes[i - 1]);
    // Wrap to the next matching hour when hours are consecutive.
    if (hours.length > 1 || hours.length === 24) {
      smallest = Math.min(smallest, 60 - minutes[minutes.length - 1] + minutes[0]);
    }
    return smallest;
  }

  // One minute per hour: the gap is the hour spacing.
  if (hours.length > 1) {
    let smallest = Infinity;
    for (let i = 1; i < hours.length; i++) smallest = Math.min(smallest, (hours[i] - hours[i - 1]) * 60);
    smallest = Math.min(smallest, (24 - hours[hours.length - 1] + hours[0]) * 60);
    return smallest;
  }

  // Once a day at most.
  return 24 * 60;
}

export interface ScheduleValidation {
  ok: boolean
  cron: string;
  timezone: string;
  fields?: CronFields;
  error?: string;
}

/**
 * Parse and admit a schedule, or refuse it with a reason an operator can act on.
 * This is the only function callers should use before storing a task.
 */
export function validateSchedule(cron: string, timezone = DEFAULT_TIMEZONE): ScheduleValidation {
  const tz = timezone && isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  let fields: CronFields;
  try {
    fields = parseCron(cron);
  } catch (err) {
    return { ok: false, cron, timezone: tz, error: err instanceof Error ? err.message : String(err) };
  }

  const floor = minIntervalMinutes();
  const smallest = smallestIntervalMinutes(fields);
  if (smallest < floor) {
    return {
      ok: false,
      cron,
      timezone: tz,
      error:
        `That schedule can fire every ${smallest} minute${smallest === 1 ? "" : "s"}, and the floor is ` +
        `${floor}. Every run spends tokens, so anything faster has to be raised deliberately ` +
        `(HARVEY_CRON_MIN_INTERVAL_MINUTES).`,
    };
  }

  return { ok: true, cron: cron.trim().toLowerCase(), timezone: tz, fields };
}

function dayMatches(fields: CronFields, month: number, dom: number, dow: number): boolean {
  if (!fields.months.includes(month)) return false;
  const domHit = fields.doms.includes(dom);
  const dowHit = fields.dows.includes(dow);

  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/**
 * The next instant this schedule fires, strictly after `fromMs`.
 *
 * Returns null when nothing matches inside the search horizon, which for a
 * valid 5-field expression means an impossible date like Feb 30.
 */
export function nextRun(cron: string, timezone = DEFAULT_TIMEZONE, fromMs = Date.now()): number | null {
  let fields: CronFields;
  try {
    fields = parseCron(cron);
  } catch {
    return null;
  }
  const tz = timezone && isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;

  // Search from the start of the next minute; a schedule never fires in the past.
  const start = utcToZonedParts(fromMs + 60000, tz);
  const startKey = start.year * 10000 + start.month * 100 + start.day;

  /* Walk calendar days in the zone, then wall times inside the matching day.
     Four years of horizon covers Feb 29 on a `29 2 *` schedule. */
  for (let dayOffset = 0; dayOffset <= 366 * 4; dayOffset++) {
    // Date arithmetic in UTC purely because UTC has no DST to trip over; the
    // result is read back as a calendar date, not an instant.
    const dayMs = Date.UTC(start.year, start.month - 1, start.day) + dayOffset * 86400000;
    const d = new Date(dayMs);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const dom = d.getUTCDate();
    const dow = d.getUTCDay();

    if (!dayMatches(fields, month, dom, dow)) continue;

    const dateKey = year * 10000 + month * 100 + dom;
    for (const hour of fields.hours) {
      for (const minute of fields.minutes) {
        // Skip wall times already gone today.
        if (dateKey === startKey && (hour < start.hour || (hour === start.hour && minute < start.minute))) {
          continue;
        }
        const resolved = zonedWallToUtc({ year, month, day: dom, hour, minute, second: 0 }, tz);
        /* A nonexistent wall clock (spring forward) resolves to the instant the
           clock jumps to, which can land before `fromMs` if we are sitting
           inside the gap. Refusing it here keeps "strictly after" true. */
        if (resolved.utcMs > fromMs) return resolved.utcMs;
      }
    }
  }

  return null;
}

/* ─────────────────── English → cron ───────────────────
   An operator says "every weekday at 7am", not "0 7 * * 1-5". This covers the
   handful of shapes people actually type. Anything it does not recognise
   returns null and the caller asks a model to do the translation instead —
   guessing here would schedule the wrong thing, which is worse than asking. */

const DOW_WORDS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** Pull a time of day out of free text. Defaults to 9:00 when absent. */
function parseTimeOfDay(text: string): { hour: number; minute: number } | null {
  // "7am", "7:30 am", "07:30", "19:00", "noon", "midnight"
  if (/\bnoon\b/.test(text)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(text)) return { hour: 0, minute: 0 };

  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3];

  if (mer === "am") {
    if (hour === 12) hour = 0;
  } else if (mer === "pm") {
    if (hour !== 12) hour += 12;
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Best-effort English → 5-field cron. Returns null when unsure.
 *
 * Deliberately narrow: it only answers when the phrasing is unambiguous, so a
 * vague instruction reaches the model rather than being silently guessed into
 * a schedule that fires at the wrong time forever.
 */
export function parseNaturalSchedule(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const text = input.trim().toLowerCase();
  if (!text) return null;

  // Already a cron expression or macro.
  if (MACROS[text]) return MACROS[text];
  if (/^[\d*,\-/]+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(text)) {
    try {
      parseCron(text);
      return text;
    } catch {
      /* fall through to the English shapes */
    }
  }

  // "every N minutes"
  const everyMin = text.match(/\bevery\s+(\d+)\s*(?:min|mins|minute|minutes)\b/);
  if (everyMin) {
    const n = parseInt(everyMin[1], 10);
    if (n >= 1 && n <= 59) return `*/${n} * * * *`;
  }

  // "every N hours" / "hourly"
  const everyHour = text.match(/\bevery\s+(\d+)\s*(?:hr|hrs|hour|hours)\b/);
  if (everyHour) {
    const n = parseInt(everyHour[1], 10);
    if (n >= 1 && n <= 23) {
      const at = parseTimeOfDay(text.replace(everyHour[0], ""));
      return `${at ? at.minute : 0} */${n} * * *`;
    }
  }
  if (/\bhourly\b/.test(text) || /\bevery hour\b/.test(text)) return "0 * * * *";

  const at = parseTimeOfDay(text);

  // "every weekday", "weekdays"
  if (/\bweekdays?\b/.test(text) || /\bevery business day\b/.test(text)) {
    const t = at || { hour: 9, minute: 0 };
    return `${t.minute} ${t.hour} * * 1-5`;
  }

  // "every monday", "on fridays", "every monday and thursday"
  const dows: number[] = [];
  for (const [word, num] of Object.entries(DOW_WORDS)) {
    if (new RegExp(`\\b${word}s?\\b`).test(text) && !dows.includes(num)) dows.push(num);
  }
  if (dows.length) {
    const t = at || { hour: 9, minute: 0 };
    return `${t.minute} ${t.hour} * * ${dows.sort((a, b) => a - b).join(",")}`;
  }

  // "every month on the 1st at 8am" / "monthly"
  const domMatch = text.match(/\b(?:on the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (/\bmonthly\b/.test(text) || /\bevery month\b/.test(text)) {
    const t = at || { hour: 9, minute: 0 };
    const dom = domMatch ? parseInt(domMatch[1], 10) : 1;
    if (dom >= 1 && dom <= 31) return `${t.minute} ${t.hour} ${dom} * *`;
  }

  // "every day at 7am" / "daily at 7" / "each morning at 7"
  if (/\b(every ?day|daily|each day|every morning|each morning|every night|every evening)\b/.test(text)) {
    const t = at || { hour: 9, minute: 0 };
    return `${t.minute} ${t.hour} * * *`;
  }

  /* A bare time with no cadence ("at 7am") reads as daily to a person, and it
     is the single most common way this gets typed. */
  if (at && /\bat\b/.test(text) && !/\bonce\b/.test(text)) {
    return `${at.minute} ${at.hour} * * *`;
  }

  return null;
}

const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function timeLabel(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** Plain-English rendering of a schedule, for the UI and for Harvey's replies. */
export function describeCron(cron: string, timezone = DEFAULT_TIMEZONE): string {
  let f: CronFields;
  try {
    f = parseCron(cron);
  } catch {
    return cron;
  }

  const zoneShort = timezone === DEFAULT_TIMEZONE ? "Central" : timezone;
  const everyMinute = f.minutes.length === 60;
  const everyHour = f.hours.length === 24;

  // Step forms read better as intervals than as lists.
  if (everyHour && f.minutes.length > 1 && !everyMinute) {
    const gap = f.minutes[1] - f.minutes[0];
    if (f.minutes.every((m, i) => i === 0 || m - f.minutes[i - 1] === gap)) {
      return `Every ${gap} minutes`;
    }
  }
  if (everyMinute) return "Every minute";
  if (everyHour && f.minutes.length === 1) {
    return f.minutes[0] === 0 ? "Every hour" : `Every hour at :${String(f.minutes[0]).padStart(2, "0")}`;
  }

  const times = f.hours
    .flatMap((h) => f.minutes.map((m) => timeLabel(h, m)))
    .slice(0, 4)
    .join(", ");
  const timePart = `${times}${f.hours.length * f.minutes.length > 4 ? "…" : ""} ${zoneShort}`;

  const weekdayOnly = f.dowRestricted && f.dows.length === 5 && f.dows.every((d) => d >= 1 && d <= 5);
  if (weekdayOnly && !f.domRestricted) return `Weekdays at ${timePart}`;

  if (f.dowRestricted && !f.domRestricted) {
    const names = f.dows.map((d) => DOW_LABELS[d]).join(", ");
    return `Every ${names} at ${timePart}`;
  }

  if (f.domRestricted) {
    const days = f.doms.join(", ");
    const monthPart =
      f.months.length === 12
        ? "month"
        : f.months.map((m) => Object.keys(MONTH_NAMES).find((k) => MONTH_NAMES[k] === m)?.toUpperCase()).join(", ");
    return `Day ${days} of every ${monthPart} at ${timePart}`;
  }

  return `Every day at ${timePart}`;
}
