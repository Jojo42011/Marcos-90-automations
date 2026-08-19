"use strict";
/**
 * IANA timezone arithmetic, DST included, with no new dependency.
 *
 * SCOPE NOTE, read this first. The content planner no longer converts anything
 * for display: a card's date and time are stored and shown literally, so
 * nothing on screen depends on this file. What is left needs it for two narrow
 * jobs — deriving the `scheduled_at_utc` instant that a future auto-publisher
 * would fire on, and reading a live wall clock for the reference clocks in the
 * header. The day-shifting helpers that used to move cards between cells
 * (dayDelta, dayDeltaLabel, shiftDaysInZone) were deleted with that model;
 * calendar-date arithmetic is `shiftDateKey`, which has no zone in it at all.
 *
 * The hard part it still does. A human types a wall clock ("10:00 AM") in some
 * place ("America/Chicago"). Turning that into an instant is what everybody
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
 * Both only affect the DERIVED instant now — the literal date and time the
 * operator typed are stored verbatim regardless, so neither case can move a
 * card or change what a card says.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidTimeZone = isValidTimeZone;
exports.utcToZonedParts = utcToZonedParts;
exports.zoneOffsetMinutes = zoneOffsetMinutes;
exports.zonedWallToUtc = zonedWallToUtc;
exports.zonedDateKey = zonedDateKey;
exports.zonedTimeLabel = zonedTimeLabel;
exports.zonedTimeInput = zonedTimeInput;
exports.shiftDateKey = shiftDateKey;
exports.dateKeyDiff = dateKeyDiff;
exports.zoneLabel = zoneLabel;
exports.clockNow = clockNow;
const FORMATTERS = new Map();
/** True if the runtime accepts this string as an IANA zone. */
function isValidTimeZone(tz) {
    if (!tz || typeof tz !== "string")
        return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
function partsFormatter(tz) {
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
function utcToZonedParts(utcMs, tz) {
    const parts = partsFormatter(tz).formatToParts(new Date(utcMs));
    const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
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
function zoneOffsetMinutes(utcMs, tz) {
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
function zonedWallToUtc(parts, tz) {
    const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
    const matchesWall = (ms) => {
        const b = utcToZonedParts(ms, tz);
        return (b.year === parts.year &&
            b.month === parts.month &&
            b.day === parts.day &&
            b.hour === parts.hour &&
            b.minute === parts.minute);
    };
    /*
     * Every offset this zone is in force for anywhere near the target. A day
     * either side brackets any transition, so on a normal date this is one
     * offset and on a changeover date it is exactly the two in play.
     */
    const dayBefore = zoneOffsetMinutes(naive - 86400000, tz);
    const candidateOffsets = Array.from(new Set([dayBefore, zoneOffsetMinutes(naive, tz), zoneOffsetMinutes(naive + 86400000, tz)]));
    const valid = [];
    for (const offset of candidateOffsets) {
        const ms = naive - offset * 60000;
        if (matchesWall(ms))
            valid.push({ ms, offset });
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
function zonedDateKey(utcMs, tz) {
    const p = utcToZonedParts(utcMs, tz);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
/** "10:00 AM" as seen in `tz`. */
function zonedTimeLabel(utcMs, tz) {
    const p = utcToZonedParts(utcMs, tz);
    const suffix = p.hour < 12 ? "AM" : "PM";
    const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    return `${String(h12).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ${suffix}`;
}
/** "HH:MM" 24h, for <input type="time">. */
function zonedTimeInput(utcMs, tz) {
    const p = utcToZonedParts(utcMs, tz);
    return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
/**
 * Move a YYYY-MM-DD key by whole days.
 *
 * Deliberately zone-free. The planner's dates are literal calendar dates, so
 * "three days later" is a question about the calendar and nothing else — no
 * instant, no offset, no changeover that could make the answer 71 hours. The
 * arithmetic runs in UTC purely because UTC has no DST to trip over.
 */
function shiftDateKey(key, days) {
    const ms = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) + days * 86400000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
/** Whole days between two YYYY-MM-DD keys (b - a). */
function dateKeyDiff(a, b) {
    const pa = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
    const pb = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
    return Math.round((pb - pa) / 86400000);
}
/** Short zone label with its current offset, e.g. "CDT (UTC-5)". */
function zoneLabel(tz, atMs = Date.now()) {
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
    }
    catch {
        abbr = "";
    }
    return abbr && !/^GMT/.test(abbr) ? `${abbr} (${offset})` : offset;
}
/** Live wall clock in a zone, e.g. "09:30 PM" — what the reference clocks read. */
function clockNow(tz, atMs = Date.now()) {
    const p = utcToZonedParts(atMs, tz);
    const suffix = p.hour < 12 ? "AM" : "PM";
    const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    return `${String(h12).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ${suffix}`;
}
