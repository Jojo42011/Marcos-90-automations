"use strict";
/**
 * Monthly reminder to import the Brivity transaction export.
 *
 * Brivity exposes no transaction API (see the header of
 * core/transactionImport.ts), so the transaction board is only ever as fresh as
 * the last CSV somebody uploaded. Left alone it rots silently, and a dashboard
 * that is stale without knowing it is worse than no dashboard.
 *
 * The task is created in the COMMAND task store — the one `/team-tasks` (the
 * "Tasks · Command Center" tab) actually renders. There is a second, separate
 * CRM task store behind `/api/crm-tasks`; writing there would have produced a
 * reminder nobody ever sees, which is the same failure as a button that does
 * nothing.
 *
 * Two deliberate departures from "fire a task on the 1st of every month":
 *
 * 1. **Driven by staleness, not the calendar.** Import on the 3rd and nothing
 *    nags on the 1st — the clock restarts from the import. A reminder that
 *    fires whether or not the work was already done is one the team learns to
 *    dismiss, and then it fails for the case that matters.
 * 2. **It clears itself.** When an import lands, any open reminder is closed.
 *    Otherwise dead reminders pile up and the live ones get lost among them.
 *
 * Exactly one open reminder exists at a time, recognised by its title, so the
 * check is safe to run on every tick and across restarts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REMINDER_TITLE = void 0;
exports.checkTransactionImportReminder = checkTransactionImportReminder;
exports.scheduleTransactionImportReminder = scheduleTransactionImportReminder;
const db_js_1 = require("../../core/db.js");
const transactionsStore_js_1 = require("../../core/transactionsStore.js");
/** Stable marker — this is how an existing reminder is found again. */
exports.REMINDER_TITLE = "Import the Brivity transaction export";
/** Days before the data counts as stale. Roughly monthly. */
const STALE_AFTER_DAYS = 30;
/** How overdue it gets before the task is escalated. */
const URGENT_AFTER_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;
function openReminder() {
    return (0, db_js_1.getCommandTasks)().find((t) => t.title === exports.REMINDER_TITLE && t.status !== "done");
}
function daysSince(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t))
        return Number.POSITIVE_INFINITY;
    return Math.floor((Date.now() - t) / DAY_MS);
}
function today() {
    return new Date().toISOString().slice(0, 10);
}
function body(last, age) {
    const where = "In the CRM open Transactions → Import CSV. It shows what it will change before writing " +
        "anything, and re-importing the same rows updates them rather than creating duplicates.";
    if (last && age !== null) {
        return (`Transaction data was last imported ${age} day(s) ago (${last.filename || "a CSV"}), so the ` +
            `Transactions board and the Transaction Snapshot are showing that date, not today.\n\n` +
            `Export the transaction report from Brivity, then ${where.charAt(0).toLowerCase()}${where.slice(1)}`);
    }
    const total = (0, transactionsStore_js_1.getAllTransactions)().length;
    return (`No transaction export has ever been imported${total ? ` (${total} transaction(s) were entered by hand)` : ""}, ` +
        `so the Transactions board and the Transaction Snapshot have nothing real behind them.\n\n` +
        `Brivity does not offer a transaction API — only contacts — so this is the supported route until ` +
        `they grant one. Export the transaction report from Brivity, then ${where.charAt(0).toLowerCase()}${where.slice(1)}`);
}
/**
 * Decide whether a reminder should exist right now, and make it so.
 *
 * Idempotent, so it is safe on any schedule. Returns what it decided, so the
 * caller (and a test) can assert on the decision rather than on a side effect.
 */
function checkTransactionImportReminder() {
    const last = (0, transactionsStore_js_1.getLastTransactionImport)();
    const existing = openReminder();
    const age = last ? daysSince(last.importedAt) : null;
    const fresh = age !== null && age < STALE_AFTER_DAYS;
    /* An import landed since the reminder went up — close it. The team should
       not have to tidy up after an automation. */
    if (existing && fresh) {
        (0, db_js_1.updateCommandTask)(existing.id, { status: "done" });
        return {
            action: "cleared",
            daysSinceImport: age,
            lastImportAt: last.importedAt,
            taskId: existing.id,
            reason: `Import ran ${age} day(s) ago — reminder closed automatically.`,
        };
    }
    if (fresh) {
        return {
            action: "none",
            daysSinceImport: age,
            lastImportAt: last.importedAt,
            reason: `Last import was ${age} day(s) ago — nothing due.`,
        };
    }
    if (existing) {
        /* Already raised. Escalate once it has been ignored long enough, but never
           create a second copy. */
        const overdue = age ?? daysSince(existing.createdAt);
        if (overdue >= URGENT_AFTER_DAYS && existing.column !== "urgent") {
            (0, db_js_1.updateCommandTask)(existing.id, { column: "urgent", color: "red" });
            return {
                action: "escalated",
                daysSinceImport: age,
                lastImportAt: last?.importedAt ?? null,
                taskId: existing.id,
                reason: `Ignored for ${overdue} day(s) — moved to Urgent.`,
            };
        }
        return {
            action: "kept",
            daysSinceImport: age,
            lastImportAt: last?.importedAt ?? null,
            taskId: existing.id,
            reason: `Reminder already open (${overdue} day(s)).`,
        };
    }
    const task = (0, db_js_1.createCommandTask)({
        title: exports.REMINDER_TITLE,
        description: body(last, age),
        column: "this_week",
        status: "pending",
        color: "amber",
        assignedTo: "marco",
        createdBy: "automation",
        dueDate: today(),
        tags: ["brivity", "transactions", "automation"],
    });
    return {
        action: "created",
        daysSinceImport: age,
        lastImportAt: last?.importedAt ?? null,
        taskId: task.id,
        reason: last
            ? `Last import was ${age} day(s) ago (over ${STALE_AFTER_DAYS}) — reminder raised.`
            : "No import has ever run — reminder raised.",
    };
}
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
/**
 * Twice a day rather than monthly. The check is cheap and idempotent, and a
 * once-a-month timer would be skipped outright by any deploy that landed on the
 * wrong day — and deploys here are frequent.
 */
function scheduleTransactionImportReminder() {
    const run = () => {
        try {
            const r = checkTransactionImportReminder();
            if (r.action !== "none")
                console.log(`[txImportReminder] ${r.action}: ${r.reason}`);
        }
        catch (err) {
            console.error("[txImportReminder] check failed:", err.message);
        }
    };
    run();
    setInterval(run, CHECK_INTERVAL_MS);
}
