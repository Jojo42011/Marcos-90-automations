/**
 * The tools that let Harvey put his own work on a schedule.
 *
 * THE POINT. "Send me the pipeline report every weekday at 7" should be a
 * sentence, not a deploy. Every recurring job in this system used to be a
 * hand-written agent in `src/agents/` wired into `scheduleContentJobs()`, which
 * means the operator could not create one and neither could Harvey. These tools
 * turn a schedule into data: a title, a prompt, and a cron expression.
 *
 * WHAT IT REFUSES, AND WHY THAT MATTERS MORE THAN WHAT IT ACCEPTS.
 *
 *   · An unparseable time is a QUESTION, never a guess. A schedule fires
 *     forever, so guessing "morning" as 9am and being wrong is a mistake that
 *     repeats daily until someone notices.
 *   · A schedule faster than the floor is refused with the number, because each
 *     run is a paid agent turn and `* * * * *` is 1,440 of them a day.
 *   · The prompt is stored verbatim and run through the normal agent loop with
 *     the approval gate ON, so a scheduled task cannot quietly do the thing a
 *     live chat would have to ask about first.
 */
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

import {
  createTask,
  deleteTask,
  getTask,
  listRuns,
  listTasks,
  updateTask,
  type TaskDelivery,
} from "../core/harveyTaskStore.js";
import { DEFAULT_TIMEZONE, describeCron, minIntervalMinutes, nextRun, parseNaturalSchedule, validateSchedule } from "./cron.js";

export const SCHEDULE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "schedule_task",
    description:
      "Put a recurring job on the schedule. Use this whenever the operator asks for something to happen repeatedly — 'every morning', 'each Monday', 'every weekday at 7'. The `prompt` is what you will be asked to do when it fires, so write it as a complete instruction to yourself, including who the result goes to. `schedule` takes plain language ('every weekday at 7am') or a 5-field cron expression. If the timing is vague, ASK the operator instead of choosing for them — this runs forever, so a wrong guess repeats. Always read back the schedule label and next run time that comes back so they can confirm it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short name, e.g. 'Morning pipeline report'." },
        prompt: {
          type: "string",
          description:
            "The full instruction to run when it fires. Write it standalone — the future run has no memory of this conversation.",
        },
        schedule: {
          type: "string",
          description: "Plain language ('every weekday at 7am') or 5-field cron ('0 7 * * 1-5').",
        },
        timezone: { type: "string", description: `IANA zone. Defaults to ${DEFAULT_TIMEZONE}.` },
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
    description:
      "Every scheduled task: its schedule in plain English, when it next runs, when it last ran and whether that worked. Use this before creating one so you do not duplicate a job that already exists, and to answer 'what do you have running'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_scheduled_task",
    description:
      "Change a scheduled task: pause it (`enabled: false`), resume it, or change its schedule, prompt or title. Pausing is reversible and is the right answer when the operator says 'stop that for now'. A task that failed three times in a row is paused automatically, and resuming it without fixing the cause will just fail again.",
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
    description:
      "Run history for one scheduled task: when each run started, whether it worked, what it cost and any error. This is how you answer 'did the report go out' and 'why did it stop'.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, limit: { type: "number", description: "Default 10." } },
      required: ["id"],
    },
  },
];

export const SCHEDULE_TOOL_NAMES = new Set(SCHEDULE_TOOL_DEFINITIONS.map((t) => t.name));

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Turn whatever the operator said into a validated cron, or explain why not.
 *
 * Two failure modes, deliberately distinct: we could not UNDERSTAND it (ask), or
 * we understood it and it is too expensive to allow (say the number).
 */
function resolveSchedule(raw: string, timezone: string): { cron: string } | { error: string; examples?: string[] } {
  const cron = parseNaturalSchedule(raw);
  if (!cron) {
    return {
      error:
        `Could not turn "${raw}" into a schedule. Ask the operator for a specific cadence and time rather than ` +
        `choosing one — this repeats forever.`,
      examples: ["every weekday at 7am", "every day at 6pm", "every Monday at 9am", "every 30 minutes", "0 7 * * 1-5"],
    };
  }
  const valid = validateSchedule(cron, timezone);
  if (!valid.ok) return { error: valid.error || "That schedule is not allowed." };
  return { cron: valid.cron };
}

export async function executeScheduleTool(
  name: string,
  input: Record<string, unknown>,
  ctx?: { sessionId?: string | null; createdBy?: string | null },
): Promise<unknown> {
  switch (name) {
    case "schedule_task": {
      const title = str(input.title);
      const prompt = str(input.prompt);
      const scheduleRaw = str(input.schedule);
      if (!title || !prompt || !scheduleRaw) {
        return { error: "title, prompt and schedule are all required." };
      }

      const timezone = str(input.timezone) || DEFAULT_TIMEZONE;
      const resolved = resolveSchedule(scheduleRaw, timezone);
      if ("error" in resolved) return resolved;

      /* Duplicate guard: the same title on the same cadence is almost always the
         operator asking twice, not wanting two identical reports. */
      const clash = listTasks().find(
        (t) => t.title.toLowerCase() === title.toLowerCase() && t.cron === resolved.cron,
      );
      if (clash) {
        return {
          error: `A task called "${clash.title}" already runs on that schedule (${clash.scheduleLabel}).`,
          existingTaskId: clash.id,
          hint: "Update that one instead of creating a second identical job.",
        };
      }

      const task = createTask({
        title,
        prompt,
        cron: resolved.cron,
        timezone,
        deliver: (str(input.deliver) || "chat") as TaskDelivery,
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
        note:
          "It runs with the approval gate on, so anything that sends to a real person will still wait for the " +
          "operator. Read the schedule and next run back to them.",
      };
    }

    case "list_scheduled_tasks": {
      const tasks = listTasks();
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
        minIntervalMinutes: minIntervalMinutes(),
      };
    }

    case "update_scheduled_task": {
      const id = str(input.id);
      const existing = getTask(id);
      if (!existing) return { error: `No scheduled task with id ${id}` };

      const patch: Parameters<typeof updateTask>[1] = {};
      if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
      if (str(input.prompt)) patch.prompt = str(input.prompt);
      if (str(input.title)) patch.title = str(input.title);
      if (str(input.deliver)) patch.deliver = str(input.deliver) as TaskDelivery;

      if (str(input.schedule)) {
        const resolved = resolveSchedule(str(input.schedule), existing.timezone);
        if ("error" in resolved) return resolved;
        patch.cron = resolved.cron;
      }

      const updated = updateTask(id, patch);
      if (!updated) return { error: "Update failed." };
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
      const existing = getTask(id);
      if (!existing) return { error: `No scheduled task with id ${id}` };
      deleteTask(id);
      return { deleted: true, id, title: existing.title };
    }

    case "get_scheduled_task_runs": {
      const id = str(input.id);
      const task = getTask(id);
      if (!task) return { error: `No scheduled task with id ${id}` };
      const limit = Number.isFinite(input.limit as number) ? Number(input.limit) : 10;
      const runs = listRuns(id, limit);
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
export function previewSchedule(raw: string, timezone = DEFAULT_TIMEZONE): {
  ok: boolean;
  cron?: string;
  label?: string;
  nextRun?: string | null;
  error?: string;
  examples?: string[];
} {
  const resolved = resolveSchedule(raw, timezone);
  if ("error" in resolved) return { ok: false, error: resolved.error, examples: resolved.examples };
  const next = nextRun(resolved.cron, timezone);
  return {
    ok: true,
    cron: resolved.cron,
    label: describeCron(resolved.cron, timezone),
    nextRun: next ? new Date(next).toISOString() : null,
  };
}
