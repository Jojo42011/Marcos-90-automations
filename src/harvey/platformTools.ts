import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import {
  BUYER_STAGES,
  SELLER_STAGES,
  TRACKER_STATUSES,
  type CommandTask,
  type CommandTaskColumn,
  type CommandTaskStatus,
  type TrackerRecord,
} from "../core/types.js";
import {
  getTrackerRecord,
  listTrackerRecords,
  setTrackerStage,
  trackerCounts,
  updateTrackerRecord,
  type TrackerFilter,
} from "../core/trackerStore.js";
import { applyTaskState, applyTaskStateAll, pushChecklistToTasks } from "../core/trackerTasks.js";
import {
  buildCommandTasksSummary,
  createCommandTask,
  getCommandTasks,
  updateCommandTask,
} from "../core/db.js";
import { getNotifications, getPresence, chatUnreadCounts } from "../core/teamStore.js";
import { commandDateString, getCommandSettings } from "../core/commandSettings.js";
import {
  scheduleMessage,
  listScheduled,
  getScheduled,
  cancelScheduled,
  scheduledCounts,
} from "../core/scheduledMessages.js";
import { canSendOn } from "../core/scheduledSender.js";
import { parseSendTime, suggestNextGoodTime } from "../core/scheduleTime.js";
import { getLeadById } from "../core/db.js";

/**
 * Harvey tools for the platform surfaces that had none — the Buyers & Sellers
 * Tracker, Task Command, the team board and command settings.
 *
 * These existed as working subsystems Harvey simply could not see: it could
 * describe the CRM in detail while being blind to the 1,219-record tracker and
 * the task board the team actually works from. "No feature in a silo Harvey
 * cannot see" is the point of this file.
 *
 * Reads are unrestricted. Writes are deliberately narrow — stage moves, status
 * and notes, task create/update — because those are the actions someone would
 * genuinely delegate out loud. Deleting anything is not offered.
 */

const BUYER_STAGE_KEYS = BUYER_STAGES.map((s) => s.key);
const SELLER_STAGE_KEYS = SELLER_STAGES.map((s) => s.key);
const TASK_COLUMNS: CommandTaskColumn[] = ["urgent", "today", "tomorrow", "this_week", "this_month"];
const TASK_STATUSES: CommandTaskStatus[] = ["pending", "in_progress", "on_hold", "due_soon", "overdue", "done"];

/** Cards carry a lot of noise for a language model; this is the useful part. */
function slimRecord(r: TrackerRecord) {
  const checklist = r.checklist || [];
  return {
    id: r.id,
    name: r.name,
    sides: r.sides,
    status: r.status,
    buyerStage: r.buyerStage ?? null,
    sellerStage: r.sellerStage ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    address: r.address ?? null,
    source: r.source ?? null,
    assignedTo: r.assignedTo ?? null,
    contactable: Boolean((r.phone || "").trim() || (r.email || "").trim()),
    lastInteractionAt: r.lastInteractionAt ?? null,
    checklist: checklist.length
      ? { total: checklist.length, done: checklist.filter((c) => c.done).length }
      : null,
    notes: r.notes ? r.notes.slice(0, 400) : null,
  };
}

function slimTask(t: CommandTask) {
  return {
    id: t.id,
    title: t.title,
    column: t.column,
    status: t.status,
    assignedTo: t.assignedTo ?? null,
    dueDate: t.dueDate ?? null,
    dueTime: t.dueTime ?? null,
    recurring: Boolean(t.recurring),
    checklist: t.checklist?.length
      ? { total: t.checklist.length, done: t.checklist.filter((c) => c.done).length }
      : null,
    tags: t.tags ?? [],
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);

export const PLATFORM_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "schedule_message",
    description:
      "Queue a text or email to a lead to go out at a later time. Give `when` in plain language — 'Tuesday morning', 'tomorrow at 9am', 'in 2 hours' — or an exact date; omit it to use the next good business hour. ALWAYS tell the user the interpreted time that comes back, and if a `warning` is returned say so plainly: the message is queued but that channel cannot currently deliver. If the time can't be understood the tool returns an error — ask the user rather than picking a time yourself.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "Lead id. Use search_leads first if you only have a name." },
        channel: { type: "string", enum: ["sms", "email"], description: "sms or email." },
        body: { type: "string", description: "The message to send." },
        subject: { type: "string", description: "Subject line — email only." },
        when: {
          type: "string",
          description: "Plain-language or exact send time. Omit for the next good business hour.",
        },
      },
      required: ["leadId", "channel", "body"],
    },
  },
  {
    name: "list_scheduled_messages",
    description:
      "Messages queued to send later, newest first. Filter by status (pending/sent/failed/canceled) or by lead. Also reports whether SMS and email can actually deliver right now — use that to explain failures instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "sent", "failed", "canceled"] },
        leadId: { type: "string" },
        limit: { type: "number", description: "Default 20." },
      },
      required: [],
    },
  },
  {
    name: "cancel_scheduled_message",
    description:
      "Cancel a queued message that hasn't gone out yet. Returns an error if it already sent — a sent message cannot be unsent.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Scheduled message id." } },
      required: ["id"],
    },
  },
  {
    name: "get_tracker_summary",
    description:
      "Buyers & Sellers Tracker totals: how many people, how many on each side, counts by status and by pipeline stage, and how many are actually contactable (have a phone or email). Use this for 'how many sellers do we have', 'what's in the pipeline', 'how many hot leads'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_tracker_pipelines",
    description:
      "The stage vocabulary: the ordered buyer pipeline (11 stages) and seller pipeline (15 stages), plus the status list. Call this before moving anyone so the stage key used is valid.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_tracker",
    description:
      "Find people in the tracker. Filter by side (buyer/seller), status, pipeline stage, source, assignee, or a free-text query matching name, phone digits, email or address. Returns the matching people with their stage and contact details.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, phone, email or address fragment." },
        side: { type: "string", enum: ["buyer", "seller"] },
        status: { type: "string", description: `One of: ${TRACKER_STATUSES.join(", ")}` },
        buyerStage: { type: "string", description: `One of: ${BUYER_STAGE_KEYS.join(", ")}` },
        sellerStage: { type: "string", description: `One of: ${SELLER_STAGE_KEYS.join(", ")}` },
        source: { type: "string" },
        assignedTo: { type: "string" },
        contactableOnly: {
          type: "boolean",
          description: "Only people with a phone or email. 472 records are social handles with neither.",
        },
        limit: { type: "number", description: "Default 25, max 200." },
      },
      required: [],
    },
  },
  {
    name: "get_tracker_record",
    description:
      "Everything about one tracker person: both pipeline stages, stage history and timeline dates, notes, full checklist including which items are linked to Task Command.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Tracker record id." } },
      required: ["id"],
    },
  },
  {
    name: "set_tracker_stage",
    description:
      "Move one side of a person along their pipeline — e.g. move a seller to 'listing_appointment_set'. Buyer and seller sides move independently. Pass stage null to move them back to Unstaged. Call get_tracker_pipelines first if unsure of the stage key.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        side: { type: "string", enum: ["buyer", "seller"] },
        stage: { type: "string", description: "Stage key, or empty string for Unstaged." },
        timelineDate: {
          type: "string",
          description: "Optional YYYY-MM-DD, when they are looking to buy or list.",
        },
      },
      required: ["id", "side", "stage"],
    },
  },
  {
    name: "update_tracker_record",
    description:
      "Update a tracker person's status, notes, assignee, or record that they were contacted today. Does not move pipeline stages — use set_tracker_stage for that.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", description: `One of: ${TRACKER_STATUSES.join(", ")}` },
        notes: { type: "string" },
        assignedTo: { type: "string" },
        contactedNow: { type: "boolean", description: "Stamp last contact as right now." },
      },
      required: ["id"],
    },
  },
  {
    name: "push_tracker_checklist_to_tasks",
    description:
      "Send a tracker person's checklist items to the Task Command board as real tasks, assigned to whoever that person is assigned to. Already-sent items are skipped. Completion then syncs both ways between the checklist and the task.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Tracker record id." },
        column: { type: "string", enum: TASK_COLUMNS, description: "Default 'today'." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_task_board",
    description:
      "Task Command board: counts plus the tasks themselves. Filter by column (urgent/today/tomorrow/this_week/this_month), status, or assignee. Use for 'what's due today', 'what is Wesley working on', 'what's overdue'.",
    input_schema: {
      type: "object",
      properties: {
        column: { type: "string", enum: TASK_COLUMNS },
        status: { type: "string", enum: TASK_STATUSES },
        assignedTo: { type: "string", description: "marco, wesley, kendrick or carlos." },
        includeDone: { type: "boolean", description: "Default false." },
        limit: { type: "number", description: "Default 40, max 200." },
      },
      required: [],
    },
  },
  {
    name: "create_task",
    description:
      "Put a task on the Task Command board. Use when asked to remember, schedule or delegate something.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        column: { type: "string", enum: TASK_COLUMNS, description: "Default 'today'." },
        assignedTo: { type: "string", description: "marco, wesley, kendrick or carlos." },
        description: { type: "string" },
        dueDate: { type: "string", description: "YYYY-MM-DD." },
        dueTime: { type: "string", description: "HH:MM, 24h." },
        urgent: { type: "boolean", description: "Puts it in the urgent column, red." },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description:
      "Change a task: mark it done, move it to another column, reassign it, or change its due date.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: TASK_STATUSES },
        column: { type: "string", enum: TASK_COLUMNS },
        assignedTo: { type: "string" },
        dueDate: { type: "string", description: "YYYY-MM-DD." },
        title: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_team_status",
    description:
      "Who is online, unread team chat counts, and recent notifications for a team member. Use for 'is Wesley around', 'what did I miss'.",
    input_schema: {
      type: "object",
      properties: {
        user: { type: "string", description: "Team member id; default marco." },
        limit: { type: "number", description: "Notifications to return, default 15." },
      },
      required: [],
    },
  },
  {
    name: "get_command_settings",
    description:
      "The team-wide command settings — most importantly the shared time zone that every due date, deadline and task rollover resolves against, plus today's date in that zone.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export const PLATFORM_TOOL_NAMES = new Set(PLATFORM_TOOL_DEFINITIONS.map((t) => t.name));

export async function executePlatformTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "schedule_message": {
      const leadId = str(input.leadId);
      const channel = input.channel === "email" ? "email" : "sms";
      const body = str(input.body);
      if (!leadId || !body) return { error: "leadId and body are required" };

      const whenRaw = str(input.when);
      // Refuse to invent a time. A wrong guess here is a real message to a
      // real client at the wrong hour, so an unparseable phrase comes back as
      // a question for the user instead of a best guess.
      const parsed = whenRaw ? parseSendTime(whenRaw) : suggestNextGoodTime();
      if (!parsed) {
        return {
          error: `Couldn't understand the send time "${whenRaw}". Ask the user for a clearer time.`,
          examples: ["tomorrow at 9am", "Tuesday morning", "in 2 hours", "2026-08-05 14:30"],
        };
      }

      const lead = await getLeadById(leadId);
      if (!lead) return { error: `No lead with id ${leadId}` };
      const leadName = lead.name || lead.username || "Lead";
      const to = channel === "sms" ? lead.phone : lead.email;
      if (!to) return { error: `${leadName} has no ${channel === "sms" ? "phone number" : "email address"} on file` };

      const msg = scheduleMessage({
        leadId,
        leadName,
        channel,
        to,
        subject: str(input.subject) || undefined,
        body,
        sendAt: parsed.sendAt,
        createdBy: "harvey",
        requestedTime: whenRaw || undefined,
      });

      const capability = await canSendOn(channel);
      return {
        scheduled: true,
        id: msg.id,
        to,
        leadName,
        channel,
        sendAt: msg.sendAt,
        interpreted: parsed.interpreted,
        // Queued ≠ deliverable. Never let Harvey imply this will arrive.
        warning: capability.ok
          ? undefined
          : `Queued, but it will NOT be delivered: ${capability.reason}`,
      };
    }

    case "list_scheduled_messages": {
      const msgs = listScheduled({
        status: (str(input.status) || undefined) as never,
        leadId: str(input.leadId) || undefined,
        limit: Math.min(100, Math.max(1, num(input.limit, 20))),
      });
      return {
        counts: scheduledCounts(),
        canDeliver: { sms: await canSendOn("sms"), email: await canSendOn("email") },
        messages: msgs.map((m) => ({
          id: m.id,
          leadName: m.leadName,
          channel: m.channel,
          to: m.to,
          sendAt: m.sendAt,
          status: m.status,
          createdBy: m.createdBy,
          preview: m.body.slice(0, 120),
          error: m.error,
        })),
      };
    }

    case "cancel_scheduled_message": {
      const id = str(input.id);
      if (!id) return { error: "id is required" };
      const existing = getScheduled(id);
      if (!existing) return { error: `No scheduled message with id ${id}` };
      if (!cancelScheduled(id)) {
        return { error: `That message is already ${existing.status} — it can't be canceled.` };
      }
      return { canceled: true, id, leadName: existing.leadName, channel: existing.channel };
    }

    case "get_tracker_summary": {
      const c = trackerCounts();
      const all = listTrackerRecords({});
      const contactable = all.filter(
        (r) => (r.phone || "").trim() || (r.email || "").trim(),
      ).length;
      return {
        ...c,
        contactable,
        noContactInfo: all.length - contactable,
        note:
          "Records with no phone or email are Instagram/TikTok handles from the DM funnel — they cannot be called or emailed yet.",
      };
    }

    case "get_tracker_pipelines":
      return {
        statuses: TRACKER_STATUSES,
        buyerStages: BUYER_STAGES,
        sellerStages: SELLER_STAGES,
        note: "Stages are per side and move independently; a person can be both a buyer and a seller.",
      };

    case "search_tracker": {
      const filter: TrackerFilter = {
        q: str(input.query) || undefined,
        side: input.side === "buyer" || input.side === "seller" ? input.side : undefined,
        status: str(input.status) ? [str(input.status) as never] : undefined,
        buyerStage: str(input.buyerStage) ? [str(input.buyerStage) as never] : undefined,
        sellerStage: str(input.sellerStage) ? [str(input.sellerStage) as never] : undefined,
        source: str(input.source) ? [str(input.source)] : undefined,
        assignedTo: str(input.assignedTo) || undefined,
      };
      let rows = applyTaskStateAll(listTrackerRecords(filter));
      if (input.contactableOnly === true) {
        rows = rows.filter((r) => (r.phone || "").trim() || (r.email || "").trim());
      }
      const limit = Math.min(200, Math.max(1, num(input.limit, 25)));
      return {
        matched: rows.length,
        returned: Math.min(limit, rows.length),
        records: rows.slice(0, limit).map(slimRecord),
      };
    }

    case "get_tracker_record": {
      const raw = getTrackerRecord(str(input.id));
      if (!raw) return { error: "No tracker record with that id." };
      const r = applyTaskState(raw);
      return {
        ...slimRecord(r),
        stageMeta: r.stageMeta || {},
        checklistItems: (r.checklist || []).map((c) => ({
          id: c.id,
          text: c.text,
          done: c.done,
          inTaskManager: Boolean(c.taskId),
        })),
        legacyStage: r.legacyStage ?? null,
        leadId: r.leadId ?? null,
        addedAt: r.addedAt,
      };
    }

    case "set_tracker_stage": {
      const id = str(input.id);
      const side = input.side === "seller" ? "seller" : "buyer";
      const stage = str(input.stage);
      const valid = side === "buyer" ? BUYER_STAGE_KEYS : SELLER_STAGE_KEYS;
      if (stage && !valid.includes(stage as never)) {
        return { error: `'${stage}' is not a ${side} stage.`, validStages: valid };
      }
      const meta = str(input.timelineDate) ? { timelineDate: str(input.timelineDate) } : undefined;
      const rec = setTrackerStage(id, side, stage || null, meta);
      if (!rec) return { error: "No tracker record with that id." };
      return {
        ok: true,
        moved: `${rec.name} → ${side}: ${stage || "Unstaged"}`,
        record: slimRecord(rec),
      };
    }

    case "update_tracker_record": {
      const id = str(input.id);
      const patch: Record<string, unknown> = {};
      if (str(input.status)) {
        if (!TRACKER_STATUSES.includes(str(input.status) as never)) {
          return { error: `'${input.status}' is not a status.`, validStatuses: TRACKER_STATUSES };
        }
        patch.status = str(input.status);
      }
      if (typeof input.notes === "string") patch.notes = input.notes;
      if (str(input.assignedTo)) patch.assignedTo = str(input.assignedTo);
      if (input.contactedNow === true) patch.lastInteractionAt = new Date().toISOString();
      if (!Object.keys(patch).length) return { error: "Nothing to update." };
      const rec = updateTrackerRecord(id, patch as never);
      if (!rec) return { error: "No tracker record with that id." };
      return { ok: true, updated: Object.keys(patch), record: slimRecord(rec) };
    }

    case "push_tracker_checklist_to_tasks": {
      const column = TASK_COLUMNS.includes(input.column as CommandTaskColumn)
        ? (input.column as CommandTaskColumn)
        : "today";
      const out = pushChecklistToTasks(str(input.id), undefined, column);
      if (!out) return { error: "No tracker record with that id." };
      return {
        ok: true,
        created: out.created.length,
        alreadyLinked: out.skipped,
        tasks: out.created.map((t) => ({ id: t.id, title: t.title, assignedTo: t.assignedTo })),
      };
    }

    case "get_task_board": {
      const all = getCommandTasks();
      const includeDone = input.includeDone === true;
      const column = str(input.column);
      const status = str(input.status);
      const who = str(input.assignedTo).toLowerCase();
      let rows = all.filter((t) => {
        if (!includeDone && t.status === "done") return false;
        if (column && t.column !== column) return false;
        if (status && t.status !== status) return false;
        if (who && String(t.assignedTo || "").toLowerCase() !== who) return false;
        return true;
      });
      const limit = Math.min(200, Math.max(1, num(input.limit, 40)));
      const today = commandDateString();
      return {
        summary: buildCommandTasksSummary(all),
        today,
        timeZone: getCommandSettings().timeZone,
        overdue: rows.filter((t) => t.dueDate && t.dueDate < today && t.status !== "done").length,
        matched: rows.length,
        tasks: rows.slice(0, limit).map(slimTask),
      };
    }

    case "create_task": {
      const title = str(input.title);
      if (!title) return { error: "title is required." };
      const urgent = input.urgent === true;
      const column = urgent
        ? "urgent"
        : TASK_COLUMNS.includes(input.column as CommandTaskColumn)
          ? (input.column as CommandTaskColumn)
          : "today";
      const task = createCommandTask({
        title: title.slice(0, 300),
        description: str(input.description) || undefined,
        column,
        status: "pending",
        color: urgent ? "red" : "blue",
        assignedTo: str(input.assignedTo).toLowerCase() || "carlos",
        createdBy: "harvey",
        dueDate: str(input.dueDate).slice(0, 10) || undefined,
        dueTime: /^\d{2}:\d{2}$/.test(str(input.dueTime)) ? str(input.dueTime) : undefined,
        tags: ["harvey"],
      });
      return { ok: true, task: slimTask(task) };
    }

    case "update_task": {
      const id = str(input.id);
      const patch: Partial<CommandTask> = {};
      if (str(input.status)) patch.status = str(input.status) as CommandTaskStatus;
      if (str(input.column)) patch.column = str(input.column) as CommandTaskColumn;
      if (str(input.assignedTo)) patch.assignedTo = str(input.assignedTo).toLowerCase();
      if (str(input.dueDate)) patch.dueDate = str(input.dueDate).slice(0, 10);
      if (str(input.title)) patch.title = str(input.title).slice(0, 300);
      if (patch.status === "done") patch.completedAt = new Date().toISOString();
      if (!Object.keys(patch).length) return { error: "Nothing to update." };
      const task = updateCommandTask(id, patch);
      if (!task) return { error: "No task with that id." };
      return { ok: true, task: slimTask(task) };
    }

    case "get_team_status": {
      const user = str(input.user).toLowerCase() || "marco";
      const limit = Math.min(100, Math.max(1, num(input.limit, 15)));
      return {
        user,
        presence: getPresence(),
        unreadChat: chatUnreadCounts(user),
        notifications: getNotifications(user, limit).map((n) => ({
          type: n.type,
          title: n.title,
          body: n.body,
          from: n.from ?? null,
          read: Boolean(n.readAt),
          at: n.at,
        })),
      };
    }

    case "get_command_settings": {
      const s = getCommandSettings();
      return {
        timeZone: s.timeZone,
        todayInCommandZone: commandDateString(),
        note:
          "This one zone drives every due date, deadline and task rollover for the whole team, regardless of where each person is.",
        updatedAt: s.updatedAt,
      };
    }

    default:
      return { error: `Unknown platform tool: ${name}` };
  }
}

/* ===================== Workspace files + background jobs =====================
   Harvey could read everything and produce nothing durable, and could not run
   anything longer than 8 tool rounds inside one HTTP request. These close both. */

export const WORKSPACE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_files",
    description:
      "List files in Harvey's workspace — the durable scratch space where drafts, reports, exports and notes live. Optionally filter by a path prefix like 'reports/'.",
    input_schema: {
      type: "object",
      properties: { prefix: { type: "string", description: "Optional folder prefix." } },
      required: [],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path, e.g. 'reports/hot-sellers.md'." } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a workspace file. Use for drafts, reports, exports, call lists, notes — anything that should outlive the conversation. Paths are relative and folders are created as needed. Allowed types: .md .txt .csv .json .html .yaml .log .tsv .xml .sql .ics",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        append: { type: "boolean", description: "Append instead of overwriting." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact snippet in a workspace file. Fails if the snippet is missing or appears more than once (unless replaceAll), so a partial match can never rewrite the wrong line.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        find: { type: "string", description: "Exact text to replace." },
        replace: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "find", "replace"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a workspace file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "start_background_job",
    description:
      "Hand a long task to a background worker that runs to completion on its own — many tool calls, minutes of work, no further prompting. Use when the task is too big to finish in this reply (e.g. 'go through every hot seller and draft a follow-up'). Returns a job id immediately; check it with get_job. Do NOT use for quick questions you can answer directly.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Complete, self-contained instructions. The worker cannot ask questions.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "get_job",
    description: "Status, steps taken and result of a background job.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_jobs",
    description: "Recent background jobs and their status.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 10." } },
      required: [],
    },
  },
];

export const WORKSPACE_TOOL_NAMES = new Set(WORKSPACE_TOOL_DEFINITIONS.map((t) => t.name));

export async function executeWorkspaceTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const ws = await import("../core/workspace.js");
  const jobs = await import("../core/jobStore.js");
  try {
    switch (name) {
      case "list_files": {
        const files = await ws.listFiles(str(input.prefix) || undefined);
        return { count: files.length, files: files.slice(0, 200) };
      }
      case "read_file":
        return await ws.readFile(str(input.path));
      case "write_file": {
        const f = await ws.writeFile(str(input.path), String(input.content ?? ""), {
          append: input.append === true,
        });
        return { ok: true, ...f };
      }
      case "edit_file":
        return {
          ok: true,
          ...(await ws.editFile(
            str(input.path),
            String(input.find ?? ""),
            String(input.replace ?? ""),
            input.replaceAll === true,
          )),
        };
      case "delete_file": {
        const gone = await ws.deleteFile(str(input.path));
        return gone ? { ok: true, deleted: str(input.path) } : { error: "No such file." };
      }
      case "start_background_job": {
        const task = str(input.task);
        if (!task) return { error: "task is required." };
        const { startJob } = await import("../hull/jobRunner.js");
        const job = startJob(task, "harvey");
        return {
          ok: true,
          id: job.id,
          status: job.status,
          note: "Running in the background. Check it with get_job.",
        };
      }
      case "get_job": {
        const j = jobs.getJob(str(input.id));
        if (!j) return { error: "No job with that id." };
        return {
          id: j.id,
          status: j.status,
          prompt: j.prompt,
          toolCalls: j.toolCalls,
          steps: j.steps.length,
          result: j.result,
          error: j.error,
          startedAt: j.startedAt,
          finishedAt: j.finishedAt,
          recentSteps: j.steps.slice(-8).map((s) => ({ n: s.n, kind: s.kind, tool: s.tool ?? null })),
        };
      }
      case "list_jobs":
        return {
          jobs: jobs.listJobs(Math.min(50, Math.max(1, num(input.limit, 10)))).map((j) => ({
            id: j.id,
            status: j.status,
            prompt: j.prompt.slice(0, 120),
            toolCalls: j.toolCalls,
            createdAt: j.createdAt,
          })),
        };
      default:
        return { error: `Unknown workspace tool: ${name}` };
    }
  } catch (err) {
    // Workspace errors are meaningful to the model (bad path, missing file,
    // ambiguous edit) — surface them rather than throwing the job away.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
