"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRACKER_TAG = void 0;
exports.pushChecklistToTasks = pushChecklistToTasks;
exports.syncChecklistToTasks = syncChecklistToTasks;
exports.applyTaskState = applyTaskState;
exports.applyTaskStateAll = applyTaskStateAll;
exports.linkedTasks = linkedTasks;
exports.unlinkChecklistItem = unlinkChecklistItem;
const db_js_1 = require("./db.js");
const trackerStore_js_1 = require("./trackerStore.js");
/**
 * Bridge between a tracker record's checklist and the Task Command board.
 *
 * A checklist item can be *pushed* to the Task Manager, at which point it holds
 * the created task's id. From then on completion travels both ways: ticking the
 * item completes the task, and completing the task ticks the item. Everything is
 * derived from that one id, so there is no second copy of the truth to drift.
 *
 * Deliberately not synced: the item's text. Renaming a checklist line should not
 * silently rewrite a task someone else may already be working from.
 */
/** Tag every generated task carries, so they are identifiable on the board. */
exports.TRACKER_TAG = "tracker";
const RECORD_TAG_PREFIX = "tracker:";
/** Team ids the Task Manager knows about; anything else falls back to the default. */
const TEAM_IDS = new Set(["marco", "wesley", "kendrick", "carlos"]);
function assigneeFor(record) {
    const a = String(record.assignedTo || "").trim().toLowerCase();
    return TEAM_IDS.has(a) ? a : "carlos";
}
/** Enough context on the task that it can be acted on without opening the tracker. */
function describe(record) {
    const who = [record.phone, record.email].filter(Boolean).join(" · ");
    const side = (record.sides || []).includes("seller")
        ? ((record.sides || []).includes("buyer") ? "buyer + seller" : "seller")
        : "buyer";
    return [`Tracker · ${record.name} (${side})`, who].filter(Boolean).join("\n");
}
/**
 * Push checklist items to the Task Manager.
 *
 * @param itemIds  specific items, or undefined for every item that has no task yet
 */
function pushChecklistToTasks(recordId, itemIds, column = "today") {
    const record = (0, trackerStore_js_1.getTrackerRecord)(recordId);
    if (!record)
        return null;
    const want = itemIds && itemIds.length ? new Set(itemIds) : null;
    const checklist = (record.checklist || []).slice();
    const created = [];
    let skipped = 0;
    for (let i = 0; i < checklist.length; i++) {
        const item = checklist[i];
        if (want && !want.has(item.id))
            continue;
        // Already linked — pushing again would create a duplicate task, not a second
        // chance at the same one.
        if (item.taskId && taskExists(item.taskId)) {
            skipped++;
            continue;
        }
        if (!item.text.trim())
            continue;
        const task = (0, db_js_1.createCommandTask)({
            title: item.text.trim().slice(0, 300),
            description: describe(record),
            column,
            status: item.done ? "done" : "pending",
            color: "purple",
            assignedTo: assigneeFor(record),
            createdBy: assigneeFor(record),
            tags: [exports.TRACKER_TAG, `${RECORD_TAG_PREFIX}${record.id}`],
            completedAt: item.done ? new Date().toISOString() : undefined,
        });
        checklist[i] = { ...item, taskId: task.id };
        created.push(task);
    }
    if (!created.length)
        return { record, created, skipped };
    const taskIds = Array.from(new Set([...(record.taskIds || []), ...created.map((t) => t.id)]));
    const updated = (0, trackerStore_js_1.updateTrackerRecord)(record.id, { checklist, taskIds });
    return { record: updated || record, created, skipped };
}
function taskExists(id) {
    return (0, db_js_1.getCommandTasks)().some((t) => t.id === id);
}
/**
 * Called after a tracker checklist is saved: push any tick/untick through to the
 * linked tasks. Compares against what was stored so an unrelated edit (adding an
 * item, editing text) does not touch the board.
 */
function syncChecklistToTasks(before, after) {
    const prev = new Map((before || []).map((i) => [i.id, i]));
    let changed = 0;
    for (const item of after || []) {
        if (!item.taskId)
            continue;
        const was = prev.get(item.id);
        if (was && was.done === item.done)
            continue;
        const ok = (0, db_js_1.updateCommandTask)(item.taskId, {
            status: item.done ? "done" : "pending",
            completedAt: item.done ? new Date().toISOString() : undefined,
        });
        if (ok)
            changed++;
    }
    return changed;
}
/**
 * Overlay the current task state onto a record before it is served.
 *
 * The task is the source of truth for a linked item, so completing it on the
 * board shows up in the tracker without a second write. A task that has been
 * deleted drops its link rather than leaving the item pointing at nothing.
 */
function applyTaskState(record) {
    const checklist = record.checklist || [];
    if (!checklist.some((i) => i.taskId))
        return record;
    const byId = new Map((0, db_js_1.getCommandTasks)().map((t) => [t.id, t]));
    let dirty = false;
    const next = checklist.map((item) => {
        if (!item.taskId)
            return item;
        const task = byId.get(item.taskId);
        if (!task) {
            dirty = true;
            return { ...item, taskId: undefined };
        }
        const done = task.status === "done";
        if (done === item.done)
            return item;
        dirty = true;
        return { ...item, done };
    });
    return dirty ? { ...record, checklist: next } : record;
}
function applyTaskStateAll(records) {
    return records.map(applyTaskState);
}
/** Linked tasks for a record, for showing status in the tracker drawer. */
function linkedTasks(record) {
    const out = {};
    const ids = new Set((record.checklist || []).map((i) => i.taskId).filter(Boolean));
    if (!ids.size)
        return out;
    for (const t of (0, db_js_1.getCommandTasks)()) {
        if (!ids.has(t.id))
            continue;
        out[t.id] = { id: t.id, status: t.status, column: t.column, assignedTo: t.assignedTo, dueDate: t.dueDate };
    }
    return out;
}
/** Break the link without touching the task itself. */
function unlinkChecklistItem(recordId, itemId) {
    const record = (0, trackerStore_js_1.getTrackerRecord)(recordId);
    if (!record)
        return null;
    const checklist = (record.checklist || []).map((i) => i.id === itemId ? { ...i, taskId: undefined } : i);
    const stillLinked = new Set(checklist.map((i) => i.taskId).filter(Boolean));
    return (0, trackerStore_js_1.updateTrackerRecord)(record.id, {
        checklist,
        taskIds: (record.taskIds || []).filter((id) => stillLinked.has(id)),
    });
}
