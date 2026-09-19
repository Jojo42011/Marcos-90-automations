"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEDULE_TOOL_NAMES = exports.SCHEDULE_TOOL_DEFINITIONS = void 0;
exports.executeScheduleTool = executeScheduleTool;
exports.previewSchedule = previewSchedule;
const harveyTaskStore_js_1 = require("../core/harveyTaskStore.js");
const cron_js_1 = require("./cron.js");
exports.SCHEDULE_TOOL_DEFINITIONS = [
    {
        name: "schedule_task",
        description: "Put a recurring job on the schedule. Use this whenever the operator asks for something to happen repeatedly — 'every morning', 'each Monday', 'every weekday at 7'. The `prompt` is what you will be asked to do when it fires, so write it as a complete instruction to yourself, including who the result goes to. `schedule` takes plain language ('every weekday at 7am') or a 5-field cron expression. If the timing is vague, ASK the operator instead of choosing for them — this runs forever, so a wrong guess repeats. Always read back the schedule label and next run time that comes back so they can confirm it.",
        input_schema: {
            type: "object",
            properties: {
                title: { type: "string", description: "Short name, e.g. 'Morning pipeline report'." },
                prompt: {
                    type: "string",
                    description: "The full instruction to run when it fires. Write it standalone — the future run has no memory of this conversation.",
                },
                schedule: {
                    type: "string",
                    description: "Plain language ('every weekday at 7am') or 5-field cron ('0 7 * * 1-5').",
                },
                timezone: { type: "string", description: `IANA zone. Defaults to ${cron_js_1.DEFAULT_TIMEZONE}.` },
                deliver: {
                    type: "string",
                    enum: ["chat", "sms", "email", "none"],
                    description: "Where the result goes. Defaults to chat. sms/email still require approval when they send.",
                },
            },
            required: ["title", "prompt", "schedule"],
        },
    },
    {
        name: "list_scheduled_tasks",
        description: "Every scheduled task: its schedule in plain English, when it next runs, when it last ran and whether that worked. Use this before creating one so you do not duplicate a job that already exists, and to answer 'what do you have running'.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "update_scheduled_task",
        description: "Change a scheduled task: pause it (`enabled: false`), resume it, or change its schedule, prompt or title. Pausing is reversible and is the right answer when the operator says 'stop that for now'. A task that failed three times in a row is paused automatically, and resuming it without fixing the cause will just fail again.",
        input_schema: {
            type: "object",
            properties: {
                id: { type: "string" },
                enabled: { type: "boolean" },
                schedule: { type: "string", description: "New schedule, plain language or cron." },
                prompt: { type: "string" },
                title: { type: "string" },
                deliver: { type: "string", enum: ["chat", "sms", "email", "none"] },
            },
            required: ["id"],
        },
    },
    {
        name: "delete_scheduled_task",
        description: "Delete a scheduled task and its run history. Use pause instead when the operator may want it back.",
        input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
        name: "get_scheduled_task_runs",
        description: "Run history for one scheduled task: when each run started, whether it worked, what it cost and any error. This is how you answer 'did the report go out' and 'why did it stop'.",
        input_schema: {
            type: "object",
            properties: { id: { type: "string" }, limit: { type: "number", description: "Default 10." } },
            required: ["id"],
        },
    },
];
exports.SCHEDULE_TOOL_NAMES = new Set(exports.SCHEDULE_TOOL_DEFINITIONS.map((t) => t.name));
const str = (v) => (typeof v === "string" ? v.trim() : "");
/**
 * Turn whatever the operator said into a validated cron, or explain why not.
 *
 * Two failure modes, deliberately distinct: we could not UNDERSTAND it (ask), or
 * we understood it and it is too expensive to allow (say the number).
 */
function resolveSchedule(raw, timezone) {
    const cron = (0, cron_js_1.parseNaturalSchedule)(raw);
    if (!cron) {
        return {
            error: `Could not turn "${raw}" into a schedule. Ask the operator for a specific cadence and time rather than ` +
                `choosing one — this repeats forever.`,
            examples: ["every weekday at 7am", "every day at 6pm", "every Monday at 9am", "every 30 minutes", "0 7 * * 1-5"],
        };
    }
    const valid = (0, cron_js_1.validateSchedule)(cron, timezone);
    if (!valid.ok)
        return { error: valid.error || "That schedule is not allowed." };
    return { cron: valid.cron };
}
async function executeScheduleTool(name, input, ctx) {
    switch (name) {
        case "schedule_task": {
            const title = str(input.title);
            const prompt = str(input.prompt);
            const scheduleRaw = str(input.schedule);
            if (!title || !prompt || !scheduleRaw) {
                return { error: "title, prompt and schedule are all required." };
            }
            const timezone = str(input.timezone) || cron_js_1.DEFAULT_TIMEZONE;
            const resolved = resolveSchedule(scheduleRaw, timezone);
            if ("error" in resolved)
                return resolved;
            /* Duplicate guard: the same title on the same cadence is almost always the
               operator asking twice, not wanting two identical reports. */
            const clash = (0, harveyTaskStore_js_1.listTasks)().find((t) => t.title.toLowerCase() === title.toLowerCase() && t.cron === resolved.cron);
            if (clash) {
                return {
                    error: `A task called "${clash.title}" already runs on that schedule (${clash.scheduleLabel}).`,
                    existingTaskId: clash.id,
                    hint: "Update that one instead of creating a second identical job.",
                };
            }
            const task = (0, harveyTaskStore_js_1.createTask)({
                title,
                prompt,
                cron: resolved.cron,
                timezone,
                deliver: (str(input.deliver) || "chat"),
                sessionId: ctx?.sessionId ?? null,
                createdBy: ctx?.createdBy ?? null,
            });
            return {
                created: true,
                id: task.id,
                title: task.title,
                schedule: task.scheduleLabel,
                cron: task.cron,
                timezone: task.timezone,
                nextRun: task.nextRunAt,
                note: "It runs with the approval gate on, so anything that sends to a real person will still wait for the " +
                    "operator. Read the schedule and next run back to them.",
            };
        }
        case "list_scheduled_tasks": {
            const tasks = (0, harveyTaskStore_js_1.listTasks)();
            if (!tasks.length) {
                return { tasks: [], note: "Nothing is scheduled yet." };
            }
            return {
                tasks: tasks.map((t) => ({
                    id: t.id,
                    title: t.title,
                    schedule: t.scheduleLabel,
                    cron: t.cron,
                    enabled: t.enabled,
                    nextRun: t.nextRunAt,
                    lastRun: t.lastRunAt,
                    lastStatus: t.lastStatus,
                    consecutiveFailures: t.consecutiveFailures,
                    deliver: t.deliver,
                    pausedAfterFailures: !t.enabled && t.consecutiveFailures >= 3,
                })),
                minIntervalMinutes: (0, cron_js_1.minIntervalMinutes)(),
            };
        }
        case "update_scheduled_task": {
            const id = str(input.id);
            const existing = (0, harveyTaskStore_js_1.getTask)(id);
            if (!existing)
                return { error: `No scheduled task with id ${id}` };
            const patch = {};
            if (typeof input.enabled === "boolean")
                patch.enabled = input.enabled;
            if (str(input.prompt))
                patch.prompt = str(input.prompt);
            if (str(input.title))
                patch.title = str(input.title);
            if (str(input.deliver))
                patch.deliver = str(input.deliver);
            if (str(input.schedule)) {
                const resolved = resolveSchedule(str(input.schedule), existing.timezone);
                if ("error" in resolved)
                    return resolved;
                patch.cron = resolved.cron;
            }
            const updated = (0, harveyTaskStore_js_1.updateTask)(id, patch);
            if (!updated)
                return { error: "Update failed." };
            return {
                updated: true,
                id: updated.id,
                title: updated.title,
                schedule: updated.scheduleLabel,
                enabled: updated.enabled,
                nextRun: updated.nextRunAt,
            };
        }
        case "delete_scheduled_task": {
            const id = str(input.id);
            const existing = (0, harveyTaskStore_js_1.getTask)(id);
            if (!existing)
                return { error: `No scheduled task with id ${id}` };
            (0, harveyTaskStore_js_1.deleteTask)(id);
            return { deleted: true, id, title: existing.title };
        }
        case "get_scheduled_task_runs": {
            const id = str(input.id);
            const task = (0, harveyTaskStore_js_1.getTask)(id);
            if (!task)
                return { error: `No scheduled task with id ${id}` };
            const limit = Number.isFinite(input.limit) ? Number(input.limit) : 10;
            const runs = (0, harveyTaskStore_js_1.listRuns)(id, limit);
            return {
                task: { id: task.id, title: task.title, schedule: task.scheduleLabel, enabled: task.enabled },
                runs: runs.map((r) => ({
                    startedAt: r.startedAt,
                    finishedAt: r.finishedAt,
                    ok: r.ok,
                    costUsd: Number(r.costUsd.toFixed(4)),
                    trigger: r.trigger,
                    error: r.error,
                    output: r.output ? r.output.slice(0, 1200) : null,
                })),
                note: runs.length ? undefined : "This task has not run yet.",
            };
        }
        default:
            return { error: `Unknown schedule tool: ${name}` };
    }
}
/** Preview used by the UI's create form, so it can show the label before saving. */
function previewSchedule(raw, timezone = cron_js_1.DEFAULT_TIMEZONE) {
    const resolved = resolveSchedule(raw, timezone);
    if ("error" in resolved)
        return { ok: false, error: resolved.error, examples: resolved.examples };
    const next = (0, cron_js_1.nextRun)(resolved.cron, timezone);
    return {
        ok: true,
        cron: resolved.cron,
        label: (0, cron_js_1.describeCron)(resolved.cron, timezone),
        nextRun: next ? new Date(next).toISOString() : null,
    };
}
