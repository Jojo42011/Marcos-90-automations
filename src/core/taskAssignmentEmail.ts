/**
 * "You've been assigned a task" email.
 *
 * Sends from Marco's OAuth-linked Gmail (the same sender the email-marketing
 * agents use), so it lands in the assignee's inbox as a normal note from him.
 *
 * Fire-and-forget by design: creating a task must never fail, block, or slow
 * down because Gmail is unreachable. Every failure path logs and returns —
 * the in-app notification and popup are the primary signal, the email is the
 * out-of-app nudge on top.
 */
import type { CommandTask } from "./types.js";
import { isEmailConfigured, sendEmail } from "../integrations/email/index.js";
import { resolveTeamEmail, teamMemberName } from "./teamRoster.js";

function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function boardUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return `${base || "https://marco-90-automation.fly.dev"}/shell?tab=tasks`;
}

/** "Mon, Aug 3" from a YYYY-MM-DD string, or the raw value if unparseable. */
function prettyDate(due: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!m) return due;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return due;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Email `task.assignedTo` that `assignerId` gave them this task.
 * Never throws. Returns whether an email actually went out.
 */
export async function sendAssignmentEmail(
  task: CommandTask,
  assignerId: string | undefined,
): Promise<boolean> {
  try {
    const assignee = task.assignedTo;
    if (!assignee) return false;

    if (!isEmailConfigured()) {
      console.warn("[TaskEmail] Gmail not configured — no assignment email for", assignee);
      return false;
    }

    const to = resolveTeamEmail(assignee);
    if (!to) {
      console.warn(
        `[TaskEmail] No address for "${assignee}" — set TEAM_EMAIL_${assignee.toUpperCase()}. In-app notification still sent.`,
      );
      return false;
    }

    const fromName = teamMemberName(assignerId || "");
    const toName = teamMemberName(assignee);

    const due = task.dueDate
      ? prettyDate(task.dueDate) + (task.dueTime ? ` at ${task.dueTime}` : "")
      : "No due date";
    const urgent = task.column === "urgent";

    const subject = `${fromName} assigned you a task: ${task.title}`;

    const rows: string[] = [
      `<tr><td style="padding:6px 14px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap">Due</td>
        <td style="padding:6px 0;color:#111827;font-size:13px;font-weight:600">${esc(due)}</td></tr>`,
      `<tr><td style="padding:6px 14px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap">Assigned by</td>
        <td style="padding:6px 0;color:#111827;font-size:13px;font-weight:600">${esc(fromName)}</td></tr>`,
    ];
    if (urgent) {
      rows.push(
        `<tr><td style="padding:6px 14px 6px 0;color:#6b7280;font-size:13px">Priority</td>
          <td style="padding:6px 0;color:#b91c1c;font-size:13px;font-weight:700">Urgent</td></tr>`,
      );
    }

    const body = `
<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f9fbfb;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #edf0f0;border-radius:14px;overflow:hidden">
    <div style="border-left:5px solid ${urgent ? "#dc2626" : "#59c4c4"};padding:22px 24px">
      <p style="margin:0 0 4px;color:#6b7280;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase">New task assigned</p>
      <h1 style="margin:0 0 6px;font-size:19px;line-height:1.35;color:#111827">${esc(task.title)}</h1>
      <p style="margin:0 0 18px;color:#4b5563;font-size:14px">Hi ${esc(toName)}, ${esc(fromName)} just assigned this to you on the Task Command Center.</p>
      ${task.description ? `<p style="margin:0 0 18px;padding:12px 14px;background:#f9fafb;border-radius:9px;color:#374151;font-size:13.5px;line-height:1.55;white-space:pre-wrap">${esc(task.description)}</p>` : ""}
      <table style="border-collapse:collapse;margin:0 0 22px">${rows.join("")}</table>
      <a href="${boardUrl()}" style="display:inline-block;background:#59c4c4;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:9px">Open Task Command</a>
    </div>
  </div>
  <p style="max-width:560px;margin:14px auto 0;color:#9ca3af;font-size:11.5px;text-align:center">
    Sent automatically by the Marco Puga Realty command center.
  </p>
</div>`.trim();

    const result = await sendEmail(to, subject, body);
    if (result.success) {
      console.log(`[TaskEmail] Assignment email sent to ${assignee} <${to}>`);
      return true;
    }
    console.error(`[TaskEmail] Send to ${assignee} <${to}> failed:`, result.error);
    return false;
  } catch (err) {
    console.error("[TaskEmail] Unexpected failure:", err);
    return false;
  }
}
