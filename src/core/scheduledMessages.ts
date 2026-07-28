/**
 * Scheduled sending — queue a text or an email to go out later.
 *
 * Two ways in, both landing in the same queue:
 *   1. The user picks a send time in the CRM.
 *   2. Harvey queues it, either at a time described in plain language
 *      ("send this Tuesday morning") or at a suggested good hour.
 *
 * File-backed JSON on the /data volume, same pattern as teamStore — the
 * volume is what makes a queue survive the deploys this app does constantly.
 *
 * IMPORTANT — this queue is real, but delivery depends on credentials this
 * app does not currently have. As of 2026-07-28 Twilio is unconfigured and
 * the Gmail refresh token is dead, so a due message will attempt, fail, and
 * be recorded `status: "failed"` with the provider's reason. That is the
 * honest behaviour: nothing is silently dropped and nothing pretends to have
 * sent. `canSendOn()` lets callers say so up front instead of queueing into
 * a channel that cannot deliver.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

export type ScheduledChannel = "sms" | "email";
export type ScheduledStatus = "pending" | "sent" | "failed" | "canceled";

export interface ScheduledMessage {
  id: string;
  leadId: string;
  /** Denormalised so the queue is readable without a lead lookup. */
  leadName: string;
  channel: ScheduledChannel;
  /** Resolved destination at queue time (phone for sms, address for email). */
  to: string;
  subject?: string;
  body: string;
  /** When it should go out (ISO, UTC). */
  sendAt: string;
  status: ScheduledStatus;
  /** Who queued it — a team member id, or "harvey". */
  createdBy: string;
  /** Plain-language time the user gave, when there was one. */
  requestedTime?: string;
  createdAt: string;
  sentAt?: string;
  error?: string;
  /** Attempts made; a message is retried a couple of times before failing. */
  attempts: number;
}

interface Persisted {
  messages: ScheduledMessage[];
}

function resolvePath(): string {
  const explicit = process.env.SCHEDULED_MESSAGES_PATH?.trim();
  if (explicit) return explicit;
  if (existsSync("/data")) return "/data/scheduled-messages.json";
  return join(process.cwd(), "data", "scheduled-messages.json");
}

const PATH = resolvePath();
const MAX_KEPT = 5000;
/** Give up after this many tries so a bad number can't retry forever. */
export const MAX_ATTEMPTS = 3;

let state: Persisted = { messages: [] };
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(PATH)) return;
    const raw = readFileSync(PATH, "utf8");
    if (!raw.trim()) return;
    const data = JSON.parse(raw) as Partial<Persisted>;
    state.messages = Array.isArray(data.messages) ? data.messages : [];
  } catch (err) {
    console.error("[scheduled] load failed:", err);
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    if (state.messages.length > MAX_KEPT) {
      state.messages = state.messages.slice(-MAX_KEPT);
    }
    writeFileSync(PATH, JSON.stringify(state), "utf8");
  } catch (err) {
    console.error("[scheduled] persist failed:", err);
  }
}

const nowIso = () => new Date().toISOString();

export interface ScheduleInput {
  leadId: string;
  leadName?: string;
  channel: ScheduledChannel;
  to: string;
  subject?: string;
  body: string;
  sendAt: string;
  createdBy: string;
  requestedTime?: string;
}

export function scheduleMessage(input: ScheduleInput): ScheduledMessage {
  load();
  const entry: ScheduledMessage = {
    id: randomUUID(),
    leadId: input.leadId,
    leadName: input.leadName || "",
    channel: input.channel,
    to: input.to,
    subject: input.subject,
    body: input.body,
    sendAt: input.sendAt,
    status: "pending",
    createdBy: input.createdBy,
    requestedTime: input.requestedTime,
    createdAt: nowIso(),
    attempts: 0,
  };
  state.messages.push(entry);
  persist();
  return entry;
}

export interface ListOptions {
  status?: ScheduledStatus;
  leadId?: string;
  channel?: ScheduledChannel;
  limit?: number;
}

/** Newest-scheduled first. */
export function listScheduled(opts: ListOptions = {}): ScheduledMessage[] {
  load();
  let out = state.messages.slice();
  if (opts.status) out = out.filter((m) => m.status === opts.status);
  if (opts.leadId) out = out.filter((m) => m.leadId === opts.leadId);
  if (opts.channel) out = out.filter((m) => m.channel === opts.channel);
  out.sort((a, b) => b.sendAt.localeCompare(a.sendAt));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export function getScheduled(id: string): ScheduledMessage | undefined {
  load();
  return state.messages.find((m) => m.id === id);
}

/** Pending and due now. */
export function dueMessages(at: Date = new Date()): ScheduledMessage[] {
  load();
  const cutoff = at.toISOString();
  return state.messages.filter((m) => m.status === "pending" && m.sendAt <= cutoff);
}

export function cancelScheduled(id: string): boolean {
  load();
  const m = state.messages.find((x) => x.id === id);
  // Only a pending message can be canceled — "cancel" on something already
  // sent would be a lie.
  if (!m || m.status !== "pending") return false;
  m.status = "canceled";
  persist();
  return true;
}

export function markSent(id: string): void {
  load();
  const m = state.messages.find((x) => x.id === id);
  if (!m) return;
  m.status = "sent";
  m.sentAt = nowIso();
  m.attempts += 1;
  persist();
}

/**
 * Record a failed attempt. Stays `pending` for another try until
 * MAX_ATTEMPTS, then sticks as `failed` with the last error — so a transient
 * outage recovers on its own but a genuinely bad address stops.
 */
export function markAttemptFailed(id: string, error: string): void {
  load();
  const m = state.messages.find((x) => x.id === id);
  if (!m) return;
  m.attempts += 1;
  m.error = error;
  if (m.attempts >= MAX_ATTEMPTS) m.status = "failed";
  persist();
}

/** Reschedule a pending message. Returns false if it already went out. */
export function rescheduleMessage(id: string, sendAt: string): boolean {
  load();
  const m = state.messages.find((x) => x.id === id);
  if (!m || m.status !== "pending") return false;
  m.sendAt = sendAt;
  persist();
  return true;
}

export function scheduledCounts(): Record<ScheduledStatus, number> {
  load();
  const out: Record<ScheduledStatus, number> = { pending: 0, sent: 0, failed: 0, canceled: 0 };
  for (const m of state.messages) out[m.status]++;
  return out;
}
