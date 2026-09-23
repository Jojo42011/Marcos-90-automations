/**
 * The approval gate: what Harvey may do on his own, and what has to be asked.
 *
 * WHY THIS IS CODE AND NOT A PROMPT. The operational prompt already tells Harvey
 * to "wait for approval on anything that leaves the building". That is a good
 * instruction and it is not a control — a model that misreads it sends the email
 * anyway, and there is no undo on a sent email, a posted comment, or an SMS to
 * 1,300 contacts. So the rule is enforced here, in front of the executor, where
 * the model's cooperation is not required.
 *
 * THE LINE. Reading is free. Writing inside this system is cheap and reversible.
 * Anything that reaches a real person, spends money, or cannot be taken back
 * stops and waits. That line is drawn per tool below, and `crm_api` is
 * classified by its METHOD rather than its name, because the same tool is a
 * harmless read and a bulk write depending on one argument.
 *
 * WHY PENDING APPROVALS ARE IN MEMORY. An approval is a live question — the
 * operator is looking at the card. If the process restarts before they answer,
 * the right outcome is that the action does NOT happen: it fails closed, and the
 * model can propose it again. Persisting them would create the opposite risk, an
 * approval granted hours earlier firing against state that has since changed.
 */
import { randomUUID } from "crypto";

export type RiskLevel = "low" | "medium" | "high";

export interface ToolRisk {
  level: RiskLevel;
  /** Plain-English reason, shown on the approval card. Never jargon. */
  reason: string;
}

/**
 * Tools that reach the outside world or cannot be undone.
 *
 * Every entry here is a thing a real person receives, a permanent public
 * artefact, a spend, or a change to how the system itself behaves.
 */
const HIGH_RISK: Record<string, string> = {
  gmail_send: "Sends a real email from Marco's account.",
  whatsapp_send: "Sends a real WhatsApp message.",
  schedule_message: "Queues a real text or email to a contact.",
  run_script: "Executes code on the server.",
  delete_file: "Deletes a file, which cannot be undone.",
  change_agent_logic: "Changes how the automation behaves for everyone.",
  tune_personality: "Changes Harvey's own operating instructions.",
  update_seller_listing_status: "Changes a live listing's status, which triggers client-facing automation.",
  trigger_website_revisit: "Fires re-engagement outreach to a lead.",
};

/**
 * Tools that spend money or touch many records at once.
 *
 * Allowed by default because blocking them would make Harvey useless, but
 * flagged so they appear in the audit trail, and promoted to an approval when
 * strict mode is on.
 */
const MEDIUM_RISK: Record<string, string> = {
  lead_nurture_score_all: "Rescores every lead in the database.",
  lead_nurture_rescore_cold: "Rescores a whole segment of leads.",
  browser_click: "Clicks inside a real web page, which can submit something.",
  browser_fill: "Types into a real web page.",
  browser_navigate: "Navigates a live browser session.",
  write_file: "Writes a file on the server.",
  edit_file: "Edits a file on the server.",
};

/** Writes inside this system: cheap, visible, and reversible by hand. */
const LOW_RISK_WRITES = new Set([
  "create_lead",
  "update_lead",
  "create_task",
  "update_task",
  "update_tracker_record",
  "set_tracker_stage",
  "log_lead_activity",
  "push_tracker_checklist_to_tasks",
  "memory_store",
  "cancel_scheduled_message",
  "lead_nurture_route_lead",
]);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True when the approval gate is armed. Default on; `false` disables it. */
export function approvalRequired(): boolean {
  const v = process.env.HARVEY_APPROVAL_REQUIRED?.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off" || v === "no");
}

/** Strict mode also holds medium-risk calls for approval. */
export function strictApproval(): boolean {
  const v = process.env.HARVEY_APPROVAL_STRICT?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

/**
 * How dangerous is this specific call?
 *
 * Argument-aware on purpose: `crm_api` with `GET` is a read and `crm_api` with
 * `DELETE` is not, and a name-only classifier would have to treat both as the
 * worst case (blocking normal reads) or the best case (letting deletes through).
 */
export function classifyToolCall(name: string, args: Record<string, unknown> = {}): ToolRisk {
  if (HIGH_RISK[name]) return { level: "high", reason: HIGH_RISK[name] };

  if (name === "crm_api" || name === "crm_api_index") {
    const method = String(args.method || "GET").toUpperCase();
    if (WRITE_METHODS.has(method)) {
      const path = String(args.path || args.endpoint || "").slice(0, 120);
      return {
        level: "high",
        reason: `Writes to the CRM (${method} ${path || "unspecified path"}), which can change or delete real records.`,
      };
    }
    return { level: "low", reason: "Reads from the CRM." };
  }

  if (MEDIUM_RISK[name]) return { level: "medium", reason: MEDIUM_RISK[name] };
  if (LOW_RISK_WRITES.has(name)) return { level: "low", reason: "Writes inside this system only." };

  /* A tool nobody classified is treated as a read, because the overwhelming
     majority here are `get_*` / `search_*` and holding those for approval would
     make every turn require a click. The named lists above are what matters:
     anything that can reach a person is on one of them explicitly. */
  return { level: "low", reason: "Reads data." };
}

/** Does this call have to stop and ask? */
export function needsApproval(name: string, args: Record<string, unknown> = {}): boolean {
  if (!approvalRequired()) return false;
  const risk = classifyToolCall(name, args);
  if (risk.level === "high") return true;
  return risk.level === "medium" && strictApproval();
}

export interface PendingApproval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  reason: string;
  /** One line describing what will happen, built for a human. */
  summary: string;
  sessionId: string | null;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt?: string;
  decidedBy?: string | null;
  denyReason?: string;
}

/** An unanswered approval is dropped rather than left armed indefinitely. */
const APPROVAL_TTL_MS = 30 * 60 * 1000;

const pending = new Map<string, PendingApproval>();

function sweep(): void {
  const now = Date.now();
  for (const [id, a] of pending) {
    if (a.status === "pending" && new Date(a.expiresAt).getTime() < now) {
      a.status = "expired";
    }
    // Keep decided records briefly so the UI can show the outcome, then drop.
    if (a.status !== "pending" && now - new Date(a.createdAt).getTime() > 2 * APPROVAL_TTL_MS) {
      pending.delete(id);
    }
  }
}

/** A short, human sentence for the card. Long argument dumps read as noise. */
function summarize(tool: string, args: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };

  switch (tool) {
    case "gmail_send": {
      const to = pick("to", "recipient", "email") || "an unspecified recipient";
      const subject = pick("subject") || "(no subject)";
      return `Email "${subject}" to ${to}`;
    }
    case "whatsapp_send":
      return `WhatsApp to ${pick("to", "contact") || "an unspecified contact"}`;
    case "schedule_message": {
      const channel = pick("channel", "kind") || "message";
      const who = pick("leadId", "to", "phone", "name") || "a contact";
      return `Queue a ${channel} to ${who}`;
    }
    case "crm_api":
    case "crm_api_index":
      return `${String(args.method || "GET").toUpperCase()} ${pick("path", "endpoint") || "the CRM API"}`;
    case "run_script":
      return `Run a script on the server`;
    case "delete_file":
      return `Delete ${pick("path", "file") || "a file"}`;
    case "update_seller_listing_status":
      return `Set listing status to ${pick("status") || "a new value"}`;
    default: {
      const first = pick("path", "to", "id", "leadId", "query", "prompt", "task");
      return first ? `${tool}: ${first.slice(0, 80)}` : tool;
    }
  }
}

export function requestApproval(input: {
  tool: string;
  args: Record<string, unknown>;
  sessionId?: string | null;
}): PendingApproval {
  sweep();
  const risk = classifyToolCall(input.tool, input.args);
  const now = Date.now();
  const approval: PendingApproval = {
    id: randomUUID(),
    tool: input.tool,
    args: input.args,
    risk: risk.level,
    reason: risk.reason,
    summary: summarize(input.tool, input.args),
    sessionId: input.sessionId ?? null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    status: "pending",
  };
  pending.set(approval.id, approval);
  return approval;
}

export function getApproval(id: string): PendingApproval | null {
  sweep();
  return pending.get(id) ?? null;
}

export function listPendingApprovals(sessionId?: string): PendingApproval[] {
  sweep();
  return [...pending.values()]
    .filter((a) => a.status === "pending" && (!sessionId || a.sessionId === sessionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Mark an approval decided. Returns the record, or null when it is unknown or
 * no longer pending — an expired approval must not be executable.
 */
export function decideApproval(
  id: string,
  decision: "approved" | "denied",
  opts?: { by?: string | null; reason?: string },
): PendingApproval | null {
  sweep();
  const approval = pending.get(id);
  if (!approval || approval.status !== "pending") return null;
  approval.status = decision;
  approval.decidedAt = new Date().toISOString();
  approval.decidedBy = opts?.by ?? null;
  if (decision === "denied" && opts?.reason) approval.denyReason = opts.reason.slice(0, 500);
  return approval;
}

/** What the model is told when a call was held. It must not retry blindly. */
export function heldToolResultText(approval: PendingApproval): string {
  return (
    `HELD FOR APPROVAL. ${approval.summary}. ` +
    `Reason: ${approval.reason} ` +
    `This action has NOT run. The operator has been shown an Approve/Deny card. ` +
    `Do not retry it, do not call another tool to work around it, and do not tell the operator it is done. ` +
    `Say plainly that it is waiting on their approval, then continue with anything else that does not need it.`
  );
}

/** Test seam: drop all in-memory approvals. */
export function __resetApprovals(): void {
  pending.clear();
}
