"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUTO_PLAN_ROLES = exports.MAX_RECURRING_RUNS = void 0;
exports.offsetMs = offsetMs;
exports.describeOffset = describeOffset;
exports.recurrenceMs = recurrenceMs;
exports.specificDateDueMs = specificDateDueMs;
exports.resolveSender = resolveSender;
const teamRoster_js_1 = require("./teamRoster.js");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The step's offset in milliseconds, honouring its unit (default days). */
function offsetMs(step) {
    const amount = Number(step.dayOffset) || 0;
    switch (step.offsetUnit) {
        case "minutes":
            return amount * MIN;
        case "hours":
            return amount * HOUR;
        default:
            return amount * DAY;
    }
}
/** "3 days", "30 minutes" — for task bodies and activity lines. */
function describeOffset(step) {
    const amount = Number(step.dayOffset) || 0;
    const unit = step.offsetUnit || "days";
    const n = Math.abs(amount);
    const word = n === 1 ? unit.replace(/s$/, "") : unit;
    if (amount === 0)
        return "immediately";
    return `${n} ${word} ${amount < 0 ? "before" : "after"}`;
}
/** Milliseconds between repeats, or null when the step does not repeat. */
function recurrenceMs(recurrence) {
    switch (recurrence) {
        case "daily":
            return DAY;
        case "weekly":
            return 7 * DAY;
        case "monthly":
            return 30 * DAY;
        case "yearly":
            return 365 * DAY;
        default:
            return null;
    }
}
/**
 * A recurring step is never "done", so something has to stop it. This is the
 * backstop for a contact nobody ever unenrolled: a daily step hits it in two
 * months, a yearly one effectively never.
 */
exports.MAX_RECURRING_RUNS = 60;
/**
 * Due time for a step pinned to a calendar date on the contact (Brivity's
 * "Specific Dates": birthday, home anniversary).
 *
 * Picking the right year is the whole problem, and the obvious rule is wrong.
 * "Due at the first occurrence after enrollment" silently skips a WHOLE YEAR
 * for anyone enrolled inside the reminder window: a plan with "3 days before
 * their birthday", applied to someone whose birthday is in 2 days, would go
 * quiet until next year — the plan looks broken and the birthday is missed.
 *
 * So a candidate year counts when EITHER its due time is still ahead, OR the
 * date itself is still ahead (a late reminder for an event that has not
 * happened yet is still worth sending, and fires immediately). Of those, the
 * soonest due wins. Both edges land the way a person would expect:
 *   birthday in 2 days, "-3 days"  -> due now (late, but the day is coming)
 *   birthday yesterday, "+2 days"  -> due tomorrow (the window is still open)
 *   birthday last month, "-3 days" -> next year
 *
 * Null when the contact has no such date: the step simply never becomes due,
 * which is the honest outcome for "wish them happy birthday" on a record with
 * no birthday on file.
 */
function specificDateDueMs(step, lead, notBeforeMs) {
    const raw = step.anchor === "birthday" ? lead.birthday : lead.homeAnniversary;
    if (!raw)
        return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw));
    if (!m)
        return null;
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const startYear = new Date(notBeforeMs).getUTCFullYear();
    let best = null;
    for (let year = startYear - 1; year <= startYear + 2; year++) {
        const occurrence = Date.UTC(year, month, day, 12, 0, 0);
        const due = occurrence + offsetMs(step);
        if (due < notBeforeMs && occurrence < notBeforeMs)
            continue; // wholly past
        if (best === null || due < best)
            best = due;
    }
    return best;
}
/**
 * Roles, so a plan survives staffing changes — Brivity's own guidance is to
 * put a ROLE in Send From rather than a person's name, and the same applies to
 * a task's assignee.
 */
exports.AUTO_PLAN_ROLES = [
    { key: "primary_agent", label: "Primary Agent (whoever the contact is assigned to)" },
    { key: "lead_agent", label: "Lead Agent (Marco)" },
    { key: "listing_agent", label: "Listing Agent" },
    { key: "buyers_agent", label: "Buyer's Agent" },
    { key: "transaction_coordinator", label: "Transaction Coordinator" },
    { key: "isa", label: "ISA / Inside Sales" },
];
const ROLE_KEYS = new Set(exports.AUTO_PLAN_ROLES.map((r) => r.key));
const DEFAULT_SENDER = "Marco Puga";
/**
 * Resolve a `sendFrom` / `assignedTo` value, which may be a role key, a team
 * member id, or a plain typed name (every pre-existing plan stores a name).
 */
function resolveSender(value, lead) {
    const raw = String(value || "").trim();
    if (!raw)
        return { name: DEFAULT_SENDER };
    const team = (0, teamRoster_js_1.listTeamMembers)();
    const byId = team.find((m) => m.id === raw.toLowerCase());
    if (byId)
        return { name: byId.name, userId: byId.id };
    if (ROLE_KEYS.has(raw.toLowerCase())) {
        const role = raw.toLowerCase();
        if (role === "primary_agent") {
            if (lead?.assignedUserName)
                return { name: lead.assignedUserName, userId: lead.assignedUserId ?? undefined };
            return { name: DEFAULT_SENDER, fallbackFrom: "Primary Agent (contact is unassigned)" };
        }
        if (role === "lead_agent")
            return { name: DEFAULT_SENDER, userId: "marco" };
        /* The remaining roles have no seat mapped in this system yet. Falling back
           to the lead agent keeps the plan running; saying so keeps it honest. */
        const label = exports.AUTO_PLAN_ROLES.find((r) => r.key === role)?.label ?? role;
        return { name: DEFAULT_SENDER, userId: "marco", fallbackFrom: label };
    }
    const byName = team.find((m) => m.name.toLowerCase() === raw.toLowerCase());
    if (byName)
        return { name: byName.name, userId: byName.id };
    return { name: raw };
}
