import { atomicJson } from "./atomicJson.js";
import { dataPath } from "./tenantData.js";
/** Account-local scheduled messages. Pending and unresolved work is never pruned. */
import { existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";

export type ScheduledChannel = "sms" | "email";
export type ScheduledStatus = "pending" | "sending" | "uncertain" | "sent" | "failed" | "canceled";

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
  if (existsSync(dataPath(""))) return dataPath("scheduled-messages.json");
  return dataPath("scheduled-messages.json");
}

const PATH = resolvePath();
const MAX_KEPT = 5000;
/** Give up after this many tries so a bad number can't retry forever. */
export const MAX_ATTEMPTS = 3;

let state: Persisted = { messages: [] };
let loaded = false;

let committed = JSON.stringify(state);
function load(): void {
  if (loaded) return;
  if (existsSync(PATH)) {
    const data = JSON.parse(readFileSync(PATH, "utf8"));
    if (!data || !Array.isArray(data.messages)) throw new Error("Invalid scheduled message store; preserved for recovery");
    state = data;
    // A provider may have accepted an interrupted send. Never automatically replay it.
    for (const message of state.messages) if (message.status === "sending") {
      message.status = "uncertain";
      message.error = "Delivery interrupted; verify with the provider before scheduling another send.";
    }
  }
  committed = JSON.stringify(state);
  loaded = true;
}
function persist(): void {
  try {
    const terminal = state.messages.filter(m => ["sent", "canceled"].includes(m.status));
    const keep = new Set(terminal.slice(-MAX_KEPT).map(m => m.id));
    state.messages = state.messages.filter(m => !["sent", "canceled"].includes(m.status) || keep.has(m.id));
    atomicJson(PATH, state);
    committed = JSON.stringify(state);
  } catch (error) { state = JSON.parse(committed); throw error; }
}
export function claimScheduled(id: string): ScheduledMessage | undefined {
  load();
  const message = state.messages.find(m => m.id === id && m.status === "pending");
  if (!message) return;
  message.status = "sending";
  message.attempts++;
  persist();
  return {...message};
}
export function markUncertain(id: string, error: string): void {
  load();
  const message = state.messages.find(m => m.id === id);
  if (!message) return;
  message.status = "uncertain"; message.error = error;
  persist();
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
  if (m.status !== "sending") m.attempts += 1;
  m.error = error;
  m.status = m.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
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
  const out: Record<ScheduledStatus, number> = { pending: 0, sending: 0, uncertain: 0, sent: 0, failed: 0, canceled: 0 };
  for (const m of state.messages) out[m.status]++;
  return out;
}
