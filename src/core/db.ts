import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { channelForLead } from "./messageChannels.js";

import type {
  CommandTask,
  CommandTaskChecklistItem,
  CommandTaskColor,
  CommandTaskColumn,
  CommandTasksSummary,
  CommandTaskStatus,
  Conversation,
  Criteria,
  Lead,
  Message,
  DashboardSnapshot,
  CrmStatus,
  CrmStatusValue,
  LeadDeal,
  LeadActivity,
  LeadActivityType,
  SkipTraceResult,
  ListingStatus,
  LeadAutoPlanEnrollment,
  SigningDocument,
  ShowingAppointment,
  MojoOutreach,
  ConversationEscalationTrigger,
  PreApprovalStatus,
} from "./types.js";
import { CRM_STATUSES, COMMAND_TASK_STATUSES } from "./types.js";
import { getDeals, sumClosedDealGCI } from "./deals.js";
import { getTagTemplates } from "./tagTemplates.js";
import { getUsers } from "./users.js";
import { buildTasksSummary } from "./tasks.js";
import { buildMarcoTasksSummary, getMarcoTasks } from "./marcoTasks.js";
import { sendTwilioMessage } from "../integrations/twilio/index.js";

const CRM_STATUS_SET = new Set<string>(CRM_STATUSES);

/** Normalize CRM intent; defaults to buyer. */
export function normalizeCrmIntent(raw: unknown): Lead["crmIntent"] {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (s === "seller") return "seller";
  if (s === "buyer_seller" || s === "buyer+seller" || s === "buyer/seller" || s === "buyer-seller") {
    return "buyer_seller";
  }
  return "buyer";
}

/** Normalize tag list — any non-empty strings; deduped. Legacy status-like labels may remain until cleaned up. */
export function normalizeCrmTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      const s = t.trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Map legacy / unknown status strings to current CrmStatus without throwing. */
export function normalizeCrmStatus(raw: unknown): CrmStatus {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  const legacy: Record<string, CrmStatus> = {
    not_contacted: "new",
    contacted: "hot",
    warm: "watch",
    cold: "unresponsive",
    nurture: "nurture",
    dead: "dead",
    new: "new",
    hot: "hot",
    watch: "watch",
    unresponsive: "unresponsive",
  };
  if (legacy[s]) return legacy[s];
  if (CRM_STATUS_SET.has(s)) return s as CrmStatus;
  return "new";
}

/**
 * File-backed store: persists to /data/db.json (Fly volume) or DB_JSON_PATH.
 * Local dev default: ./data/local-dashboard-db.json when the Fly path is missing.
 */
function resolveDbPath(): string {
  const explicit = process.env.DB_JSON_PATH?.trim();
  if (explicit) return explicit;
  const flyDefault = "/data/db.json";
  if (existsSync(flyDefault)) return flyDefault;
  return join(process.cwd(), "data", "local-dashboard-db.json");
}

const DB_PATH = resolveDbPath();

const leadsById = new Map<string, Lead>();
const leadKeyToId = new Map<string, string>(); // platform + userId -> leadId
const conversationsByLeadId = new Map<string, Conversation>();
let commandTasksStore: CommandTask[] = [];

let idCounter = 1;

function nowIso(): string {
  return new Date().toISOString();
}

const COMMAND_COLUMNS = new Set<CommandTaskColumn>([
  "urgent",
  "today",
  "tomorrow",
  "this_week",
  "this_month",
]);
const COMMAND_COLORS = new Set<CommandTaskColor>([
  "red",
  "amber",
  "green",
  "blue",
  "purple",
  "gray",
]);

type PersistedShape = {
  idCounter: number;
  leadsById: Record<string, Lead>;
  leadKeyToId: Record<string, string>;
  conversationsByLeadId: Record<string, Conversation>;
  commandTasks?: CommandTask[];
};

/**
 * Checklist items must survive the disk round trip. The board saves them fine,
 * but this load-path normalizer predates the checklist/dueTime/reminder/sort
 * fields and silently dropped all four on every restart — and the next
 * persistToFile() then wrote the stripped tasks back, so the loss looked like
 * "checklists vanish when the page refreshes" and was permanent.
 */
function normalizeChecklist(raw: unknown): CommandTaskChecklistItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: CommandTaskChecklistItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === "string" ? e.text.trim().slice(0, 500) : "";
    if (!text) continue;
    items.push({
      id: typeof e.id === "string" && e.id.trim() ? e.id.trim().slice(0, 64) : randomUUID(),
      text,
      done: e.done === true,
      taskId: typeof e.taskId === "string" && e.taskId.trim() ? e.taskId.trim().slice(0, 64) : undefined,
    });
    if (items.length >= 100) break;
  }
  return items.length ? items : undefined;
}

function normalizeCommandTask(raw: unknown): CommandTask | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const title = typeof t.title === "string" ? t.title.trim() : "";
  if (!title) return null;
  const column = COMMAND_COLUMNS.has(t.column as CommandTaskColumn)
    ? (t.column as CommandTaskColumn)
    : "today";
  const status: CommandTaskStatus = COMMAND_TASK_STATUSES.includes(t.status as CommandTaskStatus)
    ? (t.status as CommandTaskStatus)
    : "pending";
  const color = COMMAND_COLORS.has(t.color as CommandTaskColor)
    ? (t.color as CommandTaskColor)
    : "blue";
  return {
    id: typeof t.id === "string" && t.id ? t.id : randomUUID(),
    title,
    description: typeof t.description === "string" ? t.description : undefined,
    checklist: normalizeChecklist(t.checklist),
    column,
    status,
    previousStatus: COMMAND_TASK_STATUSES.includes(t.previousStatus as CommandTaskStatus)
      ? (t.previousStatus as CommandTaskStatus)
      : undefined,
    color,
    recurring: t.recurring === true,
    recurringInterval:
      t.recurringInterval === "daily" ||
      t.recurringInterval === "every_3_days" ||
      t.recurringInterval === "every_5_days" ||
      t.recurringInterval === "weekly" ||
      t.recurringInterval === "monthly" ||
      t.recurringInterval === "biweekly"
        ? t.recurringInterval === "biweekly"
          ? "every_3_days"
          : (t.recurringInterval as CommandTask["recurringInterval"])
        : undefined,
    createdBy: typeof t.createdBy === "string" ? t.createdBy : undefined,
    assignedTo: typeof t.assignedTo === "string" ? t.assignedTo : undefined,
    dueDate: typeof t.dueDate === "string" ? t.dueDate.slice(0, 10) : undefined,
    dueTime: typeof t.dueTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.dueTime)
      ? t.dueTime
      : undefined,
    reminderMinutes: Array.isArray(t.reminderMinutes)
      ? t.reminderMinutes
          .map((n) => Math.round(Number(n)))
          .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1440)
      : undefined,
    sortOrder: typeof t.sortOrder === "number" && Number.isFinite(t.sortOrder)
      ? t.sortOrder
      : undefined,
    completedAt: typeof t.completedAt === "string" ? t.completedAt : undefined,
    createdAt: typeof t.createdAt === "string" ? t.createdAt : nowIso(),
    updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : nowIso(),
    tags: Array.isArray(t.tags)
      ? t.tags.filter((x): x is string => typeof x === "string")
      : undefined,
  };
}

function persistToFile(): void {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const data: PersistedShape = {
      idCounter,
      leadsById: Object.fromEntries(leadsById),
      leadKeyToId: Object.fromEntries(leadKeyToId),
      conversationsByLeadId: Object.fromEntries(conversationsByLeadId),
      commandTasks: commandTasksStore,
    };
    writeFileSync(DB_PATH, JSON.stringify(data), "utf8");
  } catch (err) {
    console.error("[db] persistToFile failed:", err);
  }
}

function loadFromFile(): void {
  try {
    if (!existsSync(DB_PATH)) {
      return;
    }
    const raw = readFileSync(DB_PATH, "utf8");
    if (!raw.trim()) {
      return;
    }
    const data = JSON.parse(raw) as Partial<PersistedShape>;

    if (typeof data.idCounter === "number" && data.idCounter >= 1) {
      idCounter = data.idCounter;
    }

    leadsById.clear();
    leadKeyToId.clear();
    conversationsByLeadId.clear();
    commandTasksStore = [];

    if (data.leadsById && typeof data.leadsById === "object") {
      for (const [k, v] of Object.entries(data.leadsById)) {
        if (v && typeof v === "object") {
          leadsById.set(k, v as Lead);
        }
      }
    }

    if (data.leadKeyToId && typeof data.leadKeyToId === "object") {
      for (const [k, v] of Object.entries(data.leadKeyToId)) {
        if (typeof v === "string") {
          leadKeyToId.set(k, v);
        }
      }
    }

    if (data.conversationsByLeadId && typeof data.conversationsByLeadId === "object") {
      for (const [k, v] of Object.entries(data.conversationsByLeadId)) {
        const conv = v as Conversation;
        if (conv && typeof conv === "object" && Array.isArray(conv.messages)) {
          conversationsByLeadId.set(k, conv);
        }
      }
    }

    if (Array.isArray(data.commandTasks)) {
      commandTasksStore = data.commandTasks
        .map(normalizeCommandTask)
        .filter((t): t is CommandTask => t !== null);
    }
  } catch (err) {
    console.error("[db] loadFromFile failed, starting empty:", err);
  }
}

loadFromFile();

/** Clear all leads and conversations; persists empty state. */
export function resetMemoryStore(): void {
  leadsById.clear();
  leadKeyToId.clear();
  conversationsByLeadId.clear();
  commandTasksStore = [];
  idCounter = 1;
  persistToFile();
}

export function getCommandTasks(): CommandTask[] {
  return [...commandTasksStore];
}

export function saveCommandTasks(tasks: CommandTask[]): void {
  commandTasksStore = tasks;
  persistToFile();
}

export function buildCommandTasksSummary(tasks?: CommandTask[]): CommandTasksSummary {
  const list = tasks ?? commandTasksStore;
  const active = list.filter((t) => t.status !== "done");
  return {
    urgent: active.filter((t) => t.column === "urgent").length,
    today: active.filter((t) => t.column === "today").length,
    totalPending: active.length,
  };
}

export function seedCommandTasksIfEmpty(): CommandTask[] {
  if (commandTasksStore.length > 0) return commandTasksStore;

  const seeds: Omit<CommandTask, "id" | "createdAt" | "updatedAt" | "status">[] = [
    { title: "Draft weekly email to buyer leads", column: "today", color: "blue", assignedTo: "carlos", recurring: true, recurringInterval: "weekly", createdBy: "carlos" },
    { title: "Add new TikTok leads to Brivity CRM", column: "today", color: "amber", assignedTo: "carlos", createdBy: "carlos" },
    { title: "Confirm tomorrow's consultation appointments", column: "today", color: "green", assignedTo: "carlos", createdBy: "carlos" },
    { title: "Send listing agreement to new seller lead", column: "urgent", color: "red", assignedTo: "carlos", createdBy: "carlos" },
    { title: "Follow up on unsigned buyer rep for Geno Perez", column: "urgent", color: "red", assignedTo: "carlos", createdBy: "carlos" },
    { title: "Weekly check-in on all active transactions", column: "this_week", color: "purple", assignedTo: "carlos", recurring: true, recurringInterval: "weekly", createdBy: "carlos" },
    { title: "Post TikTok videos, 7 per day target", column: "today", color: "blue", assignedTo: "carlos", recurring: true, recurringInterval: "daily", createdBy: "carlos" },
    { title: "Send property options to Canyon Lake inquiry", column: "tomorrow", color: "blue", assignedTo: "carlos", createdBy: "carlos" },
    { title: "Geno Perez, every 3 week check-in re: August closing", column: "this_week", color: "green", assignedTo: "carlos", recurring: true, recurringInterval: "every_3_days", createdBy: "carlos" },
    { title: "Send weekly update to seller leads bucket", column: "this_week", color: "amber", assignedTo: "carlos", recurring: true, recurringInterval: "weekly", createdBy: "carlos" },
  ];

  for (const seed of seeds) {
    createCommandTask({ ...seed, status: "pending" });
  }
  return commandTasksStore;
}

export function createCommandTask(
  data: Omit<CommandTask, "id" | "createdAt" | "updatedAt">,
): CommandTask {
  const task: CommandTask = {
    ...data,
    id: randomUUID(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  commandTasksStore.push(task);
  persistToFile();
  return task;
}

export function updateCommandTask(id: string, updates: Partial<CommandTask>): CommandTask | null {
  const idx = commandTasksStore.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  commandTasksStore[idx] = {
    ...commandTasksStore[idx],
    ...updates,
    updatedAt: nowIso(),
  };
  if (updates.status === "done" && !commandTasksStore[idx].completedAt) {
    commandTasksStore[idx].completedAt = nowIso();
  }
  persistToFile();
  return commandTasksStore[idx];
}

export function deleteCommandTask(id: string): boolean {
  const filtered = commandTasksStore.filter((t) => t.id !== id);
  if (filtered.length === commandTasksStore.length) return false;
  commandTasksStore = filtered;
  persistToFile();
  return true;
}

function leadKey(platform: string, userId: string): string {
  return `${platform}::${userId}`;
}

export async function getLead(platform: string, userId: string): Promise<Lead | null> {
  const id = leadKeyToId.get(leadKey(platform, userId));
  if (!id) return null;
  return leadsById.get(id) ?? null;
}

/** Lookup by internal lead id (CRM / SMS). */
export async function getLeadById(leadId: string): Promise<Lead | null> {
  const id = String(leadId || "").trim();
  if (!id) return null;
  return leadsById.get(id) ?? null;
}

/** Alias for nurture/scoring modules. */
export const findLeadById = getLeadById;

/** Permanently remove a lead, its conversation, and platform key mapping. */
export function deleteLead(id: string): boolean {
  const leadId = String(id || "").trim();
  if (!leadId) return false;
  const lead = leadsById.get(leadId);
  if (!lead) return false;
  leadsById.delete(leadId);
  leadKeyToId.delete(leadKey(lead.platform, lead.userId));
  conversationsByLeadId.delete(leadId);
  return true;
}

/** Delete multiple leads; persists once if any were removed. */
export async function deleteLeads(ids: string[]): Promise<number> {
  let deleted = 0;
  for (const id of ids) {
    if (deleteLead(id)) deleted++;
  }
  if (deleted > 0) persistToFile();
  return deleted;
}

/** Last 10 digits — matches US numbers with or without +1. */
export function phoneMatchKey(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;
  const d = phone.replace(/\D/g, "");
  if (d.length < 10) return null;
  return d.slice(-10);
}

/** First lead whose stored phone matches the given E.164 / local number. */
export async function findLeadByPhoneDigits(phone: string): Promise<Lead | null> {
  const key = phoneMatchKey(phone);
  if (!key) return null;
  for (const lead of leadsById.values()) {
    if (phoneMatchKey(lead.phone) === key) {
      return lead;
    }
  }
  return null;
}

function leadHasPhone(phone: string | null | undefined): boolean {
  return Boolean(phone?.trim());
}

function leadHasEmail(email: string | null | undefined): boolean {
  return Boolean(email?.trim());
}

async function triggerEmailMarketingIfNeeded(lead: Lead): Promise<void> {
  if (!leadHasEmail(lead.email)) return;
  const { onLeadEmailCaptured } = await import("../agents/emailMarketing/hooks.js");
  onLeadEmailCaptured(lead);
}

async function notifyNewPhoneCapture(lead: Lead): Promise<void> {
  const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
  const carlosNumber = process.env.CARLOS_PHONE_NUMBER?.trim();
  const message =
    `📱 New phone captured: ${lead.name || lead.username || "Unknown lead"} ` +
    `(${lead.source || "unknown source"}) — ${lead.phone}. Check CRM Leads tab.`;
  const recipients = [marcoNumber, carlosNumber].filter(Boolean) as string[];

  if (recipients.length === 0) {
    console.warn(
      "[PhoneCapture] MARCO_PHONE_NUMBER / CARLOS_PHONE_NUMBER not set — skipping SMS notification",
    );
    return;
  }

  for (const number of recipients) {
    try {
      const result = await sendTwilioMessage({ to: number, content: message });
      if (!result.success) {
        console.error("[PhoneCapture] Notification failed for", number, ":", result.error);
      } else {
        console.log("[PhoneCapture] Notified", number);
      }
    } catch (err) {
      console.error("[PhoneCapture] Notification failed for", number, ":", err);
    }
  }
}

function applyPhoneCaptureTransition(existing: Lead | null, lead: Lead): Lead {
  const hadBefore = existing ? leadHasPhone(existing.phone) : false;
  const hasNow = leadHasPhone(lead.phone);

  if (!hadBefore && hasNow) {
    const enriched: Lead = {
      ...lead,
      phoneCapturedAt: nowIso(),
      phoneNumberSeen: false,
    };
    notifyNewPhoneCapture(enriched).catch((err) =>
      console.error("[PhoneCapture] Notification error:", err),
    );
    return enriched;
  }

  if (!existing) {
    return lead;
  }

  return {
    ...lead,
    phoneCapturedAt: lead.phoneCapturedAt ?? existing.phoneCapturedAt,
    phoneNumberSeen:
      lead.phoneNumberSeen !== undefined
        ? lead.phoneNumberSeen
        : existing.phoneNumberSeen ?? (existing.phoneCapturedAt ? false : true),
  };
}

function normalizePreApprovalStatus(raw: unknown): PreApprovalStatus | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "approved" || s === "in_progress" || s === "cash" || s === "not_approved") return s;
  return null;
}

async function triggerSourceRoutingIfNeeded(lead: Lead): Promise<Lead> {
  if (lead.sourceRoutingCompletedAt) return lead;

  const routedAt = nowIso();
  const marked: Lead = { ...lead, sourceRoutingCompletedAt: routedAt };
  leadsById.set(lead.id, marked);
  persistToFile();

  const { routeNewLead } = await import("../agents/leadNurture/sourceRouting.js");
  routeNewLead(marked).catch((err) => console.error("[SourceRouting]", err));
  return marked;
}

export async function createLead(lead: Omit<Lead, "id" | "createdAt" | "updatedAt">): Promise<Lead> {
  const id = String(idCounter++);
  const createdAt = nowIso();
  let next = normalizeCrmDefaults({ ...lead, id, createdAt, updatedAt: createdAt });
  if (leadHasPhone(next.phone)) {
    next = {
      ...next,
      phoneCapturedAt: createdAt,
      phoneNumberSeen: false,
    };
    notifyNewPhoneCapture(next).catch((err) =>
      console.error("[PhoneCapture] Notification error:", err),
    );
  }
  leadsById.set(id, next);
  leadKeyToId.set(leadKey(lead.platform, lead.userId), id);
  conversationsByLeadId.set(id, { messages: [] });
  persistToFile();
  const routed = await triggerSourceRoutingIfNeeded(next);
  if (leadHasEmail(routed.email) && !routed.autoReplyEmailSentAt) {
    void triggerEmailMarketingIfNeeded(routed);
  }
  return routed;
}

/**
 * Insert or update a lead with NO outbound side effects.
 *
 * `createLead` deliberately fires automations when a lead arrives: a phone
 * texts Marco and Carlos via Twilio, an email schedules a marketing auto-reply
 * and starts a drip. That is right for a new lead coming out of the DMs, and
 * badly wrong for a bulk import of contacts that already exist elsewhere —
 * filing 500 Brivity contacts through it would send hundreds of texts and email
 * hundreds of cold contacts unprompted.
 *
 * This is the import path: same store, same normalisation, no automations. Use
 * it only for records being filed, never for a lead that has just come in.
 */
export function upsertLeadQuiet(
  input: Omit<Lead, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Lead {
  const now = nowIso();
  const existing = input.id ? leadsById.get(input.id) : undefined;
  if (existing) {
    const merged = normalizeCrmDefaults({ ...existing, ...input, id: existing.id, updatedAt: now });
    leadsById.set(existing.id, merged);
    persistToFile();
    return merged;
  }
  const id = input.id && !leadsById.has(input.id) ? input.id : String(idCounter++);
  const created = normalizeCrmDefaults({ ...input, id, createdAt: now, updatedAt: now } as Lead);
  leadsById.set(id, created);
  leadKeyToId.set(leadKey(created.platform, created.userId), id);
  if (!conversationsByLeadId.has(id)) conversationsByLeadId.set(id, { messages: [] });
  persistToFile();
  return created;
}

export async function updateLead(lead: Lead): Promise<Lead | undefined> {
  const existing = leadsById.get(lead.id);
  if (!existing) {
    let normalized = normalizeCrmDefaults({ ...lead, createdAt: nowIso(), updatedAt: nowIso() });
    normalized = applyPhoneCaptureTransition(null, normalized);
    leadsById.set(lead.id, normalized);
    persistToFile();
    return leadsById.get(lead.id);
  }
  const normalized = normalizeCrmDefaults({ ...lead, updatedAt: nowIso() });
  const updated = applyPhoneCaptureTransition(existing, normalized);
  leadsById.set(lead.id, updated);
  persistToFile();

  const phoneNewlyCaptured =
    existing && !leadHasPhone(existing.phone) && leadHasPhone(updated.phone);
  if (phoneNewlyCaptured && !updated.sourceRoutingCompletedAt) {
    return await triggerSourceRoutingIfNeeded(updated);
  }

  const emailNewlyCaptured =
    existing && !leadHasEmail(existing.email) && leadHasEmail(updated.email);
  if (emailNewlyCaptured && !updated.autoReplyEmailSentAt) {
    void triggerEmailMarketingIfNeeded(updated);
  }

  return updated;
}

export async function getConversation(leadId: string): Promise<Conversation> {
  return conversationsByLeadId.get(leadId) ?? { messages: [] };
}

/**
 * How many times this lead has replied over DM.
 *
 * Synchronous on purpose: lead scoring runs this across every lead in one pass
 * and is itself sync. The conversations live in an in-memory Map, so there is
 * nothing to await.
 *
 * A `user` message is a message FROM the lead. This is the DM equivalent of an
 * inbound SMS, and it is the number lead scoring should have been reading all
 * along on a business whose funnel runs on Instagram and TikTok.
 */
export function getInboundDmCount(leadId: string): number {
  const conv = conversationsByLeadId.get(leadId);
  if (!conv) return 0;
  return conv.messages.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0);
}

/**
 * When this lead last said something to us, or null if they never have.
 *
 * Deliberately the last INBOUND message rather than the last message: five
 * unanswered follow-ups we sent yesterday do not make a lead warm, and using
 * "last touched" would let the system mistake its own activity for interest.
 */
export function getLastInboundDmAt(leadId: string): string | null {
  const conv = conversationsByLeadId.get(leadId);
  if (!conv) return null;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === "user") return conv.messages[i].at;
  }
  return null;
}

export async function appendMessage(
  leadId: string,
  role: Message["role"],
  text: string,
): Promise<void> {
  const conversation = conversationsByLeadId.get(leadId) ?? { messages: [] };
  conversation.messages.push({ role, text, at: nowIso() });
  conversationsByLeadId.set(leadId, conversation);
  persistToFile();
}

const DEAL_STAGES = new Set(["prospect", "active", "under_contract", "closed"]);

/** Normalize an arbitrary deal payload to a LeadDeal or null. */
export function normalizeCrmDeal(raw: unknown): LeadDeal | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : "";
  if (!name) return null;
  const stageRaw = typeof d.stage === "string" ? d.stage : "prospect";
  const stage = (DEAL_STAGES.has(stageRaw) ? stageRaw : "prospect") as LeadDeal["stage"];
  const valueNum = d.value === null || d.value === undefined || d.value === "" ? null : Number(d.value);
  return {
    name,
    address: typeof d.address === "string" && d.address.trim() ? d.address.trim() : null,
    value: typeof valueNum === "number" && Number.isFinite(valueNum) ? valueNum : null,
    stage,
    closeDate: typeof d.closeDate === "string" && d.closeDate.trim() ? d.closeDate.trim() : null,
    notes: typeof d.notes === "string" && d.notes.trim() ? d.notes.trim() : null,
  };
}

const ACTIVITY_TYPES = new Set([
  "call",
  "call_made",
  "skip_trace",
  "text_sent",
  "text_received",
  "email_sent",
  "web_visit",
  "home_hearted",
  "home_clicked",
  "re_engagement",
  "listing_off_market",
  "listing_active",
  "task",
  "email_pending",
]);

/** Normalize an arbitrary activity payload to a LeadActivity[] (drops invalid entries). */
export function normalizeCrmActivity(raw: unknown): LeadActivity[] {
  if (!Array.isArray(raw)) return [];
  const out: LeadActivity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const type = typeof a.type === "string" && ACTIVITY_TYPES.has(a.type) ? (a.type as LeadActivityType) : null;
    if (!type) continue;
    const entry: LeadActivity = {
      type,
      description: typeof a.description === "string" ? a.description : "",
      timestamp: typeof a.timestamp === "string" && a.timestamp ? a.timestamp : nowIso(),
    };
    if (typeof a.notes === "string" && a.notes.trim()) entry.notes = a.notes.trim();
    out.push(entry);
  }
  return out;
}

function normalizeSkipTraceResults(raw: unknown): SkipTraceResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SkipTraceResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const runAt = typeof r.runAt === "string" && r.runAt ? r.runAt : nowIso();
    const source = typeof r.source === "string" ? r.source : "manual";
    const confidence =
      r.confidence === "high" || r.confidence === "medium" || r.confidence === "low" ? r.confidence : undefined;
    const ownership: SkipTraceResult["propertyOwnership"] = [];
    if (Array.isArray(r.propertyOwnership)) {
      for (const p of r.propertyOwnership) {
        if (!p || typeof p !== "object") continue;
        const po = p as Record<string, unknown>;
        const address = typeof po.address === "string" ? po.address : "";
        const owner = typeof po.owner === "string" ? po.owner : "";
        if (!address) continue;
        ownership.push({
          address,
          owner,
          estimatedValue: typeof po.estimatedValue === "number" ? po.estimatedValue : undefined,
          lastSaleDate: typeof po.lastSaleDate === "string" ? po.lastSaleDate : undefined,
          lastSalePrice: typeof po.lastSalePrice === "number" ? po.lastSalePrice : undefined,
        });
      }
    }
    const phones: string[] = [];
    if (Array.isArray(r.additionalPhones)) {
      for (const ph of r.additionalPhones) {
        if (typeof ph === "string" && ph.trim()) phones.push(ph.trim());
      }
    }
    out.push({
      runAt,
      source,
      foundName: typeof r.foundName === "string" ? r.foundName : undefined,
      foundEmail: typeof r.foundEmail === "string" ? r.foundEmail : undefined,
      foundAddress: typeof r.foundAddress === "string" ? r.foundAddress : undefined,
      propertyOwnership: ownership.length ? ownership : undefined,
      additionalPhones: phones.length ? phones : undefined,
      confidence,
      raw: r.raw,
    });
  }
  return out;
}

/** Normalize an arbitrary payload to LeadAutoPlanEnrollment[] (drops invalid entries). */
export function normalizeAutoPlanEnrollments(raw: unknown): LeadAutoPlanEnrollment[] {
  if (!Array.isArray(raw)) return [];
  const out: LeadAutoPlanEnrollment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const planId = typeof e.planId === "string" ? e.planId : "";
    if (!planId) continue;
    const status =
      e.status === "paused" || e.status === "completed" ? (e.status as "paused" | "completed") : "active";
    out.push({
      planId,
      planName: typeof e.planName === "string" ? e.planName : "",
      enrolledAt: typeof e.enrolledAt === "string" && e.enrolledAt ? e.enrolledAt : nowIso(),
      currentStepIndex: typeof e.currentStepIndex === "number" && e.currentStepIndex >= 0 ? e.currentStepIndex : 0,
      completedSteps: Array.isArray(e.completedSteps)
        ? e.completedSteps.filter((s): s is string => typeof s === "string")
        : [],
      status,
    });
  }
  return out;
}

const DOC_STATUSES = new Set(["pending", "sent", "signed", "declined"]);

/** Normalize an arbitrary payload to SigningDocument[] (drops invalid entries). */
export function normalizeDocuments(raw: unknown): SigningDocument[] {
  if (!Array.isArray(raw)) return [];
  const out: SigningDocument[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    const id = typeof d.id === "string" ? d.id : "";
    if (!id) continue;
    const status = typeof d.status === "string" && DOC_STATUSES.has(d.status)
      ? (d.status as SigningDocument["status"])
      : "pending";
    const doc: SigningDocument = {
      id,
      name: typeof d.name === "string" ? d.name : "Document",
      fileData: typeof d.fileData === "string" ? d.fileData : "",
      status,
    };
    if (typeof d.sentAt === "string") doc.sentAt = d.sentAt;
    if (typeof d.signedAt === "string") doc.signedAt = d.signedAt;
    if (typeof d.signerEmail === "string") doc.signerEmail = d.signerEmail;
    if (typeof d.signerName === "string") doc.signerName = d.signerName;
    out.push(doc);
  }
  return out;
}

function normalizeShowingAppointment(raw: unknown): ShowingAppointment | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const address = typeof a.address === "string" ? a.address.trim() : "";
  const scheduledAt = typeof a.scheduledAt === "string" ? a.scheduledAt.trim() : "";
  if (!address || !scheduledAt) return null;
  const statusRaw = typeof a.confirmationStatus === "string" ? a.confirmationStatus.trim().toLowerCase() : "pending";
  const confirmationStatus: ShowingAppointment["confirmationStatus"] =
    statusRaw === "confirmed" ||
    statusRaw === "no_response" ||
    statusRaw === "cancelled" ||
    statusRaw === "pending"
      ? statusRaw
      : "pending";
  const out: ShowingAppointment = {
    address,
    scheduledAt,
    confirmationStatus,
  };
  if (typeof a.reminderSentAt === "string" && a.reminderSentAt) out.reminderSentAt = a.reminderSentAt;
  if (typeof a.confirmationReceivedAt === "string" && a.confirmationReceivedAt) {
    out.confirmationReceivedAt = a.confirmationReceivedAt;
  }
  if (typeof a.followUpSentAt === "string" && a.followUpSentAt) out.followUpSentAt = a.followUpSentAt;
  if (typeof a.followUpResponse === "string" && a.followUpResponse) out.followUpResponse = a.followUpResponse;
  const sentimentRaw = typeof a.followUpSentiment === "string" ? a.followUpSentiment.trim().toLowerCase() : "";
  if (sentimentRaw === "positive" || sentimentRaw === "negative" || sentimentRaw === "neutral") {
    out.followUpSentiment = sentimentRaw;
  }
  return out;
}

function normalizeMojoOutreach(raw: unknown): MojoOutreach | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const statusRaw = typeof m.status === "string" ? m.status.trim().toLowerCase() : "active";
  const status: MojoOutreach["status"] =
    statusRaw === "paused" || statusRaw === "replied" || statusRaw === "completed" || statusRaw === "active"
      ? statusRaw
      : "active";
  const textsSent =
    typeof m.textsSent === "number" && Number.isFinite(m.textsSent)
      ? Math.max(0, Math.min(2, Math.floor(m.textsSent)))
      : 0;
  const out: MojoOutreach = {
    sequenceStarted: m.sequenceStarted === true,
    textsSent,
    status,
  };
  if (typeof m.lastTextSentAt === "string" && m.lastTextSentAt) out.lastTextSentAt = m.lastTextSentAt;
  if (typeof m.pausedUntil === "string" && m.pausedUntil) out.pausedUntil = m.pausedUntil;
  return out;
}

function normalizeAutomationPausedReason(raw: unknown): ConversationEscalationTrigger | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "ready_to_offer" || s === "angry_client" || s === "legal_question") return s;
  return null;
}

function normalizeCrmDefaults(lead: Lead): Lead {
  const crmStatus = normalizeCrmStatus((lead as Partial<Lead>).crmStatus);
  const crmStage = (lead as Partial<Lead>).crmStage ?? "new";
  const crmPriority = (lead as Partial<Lead>).crmPriority ?? "normal";
  const crmNotes = (lead as Partial<Lead>).crmNotes ?? null;
  const crmIntent = normalizeCrmIntent((lead as Partial<Lead>).crmIntent);
  const rawQ = (lead as Partial<Lead>).crmCallQueue;
  const crmCallQueue: Lead["crmCallQueue"] =
    rawQ === "urgent" || rawQ === "routine" ? rawQ : "none";
  const adCampaign = (lead as Partial<Lead>).adCampaign ?? null;
  const tags = normalizeCrmTags((lead as Partial<Lead>).tags);
  const prevTags = normalizeCrmTags(lead.tags);
  const tagsSame = prevTags.length === tags.length && prevTags.every((t, i) => t === tags[i]);
  const rawAlerts = (lead as Partial<Lead>).alerts;
  const alerts = typeof rawAlerts === "number" && rawAlerts > 0 ? rawAlerts : 0;
  const rawReports = (lead as Partial<Lead>).reports;
  const reports = typeof rawReports === "number" && rawReports > 0 ? rawReports : 0;
  const deal = normalizeCrmDeal((lead as Partial<Lead>).deal);
  const activity = normalizeCrmActivity((lead as Partial<Lead>).activity);
  const rawLast = (lead as Partial<Lead>).lastActivity;
  const lastActivity = typeof rawLast === "string" && rawLast ? rawLast : null;
  const rawListing = (lead as Partial<Lead>).listingStatus;
  const listingStatus = rawListing === "active" || rawListing === "off_market" ? rawListing : null;
  const autoPlanEnrollments = normalizeAutoPlanEnrollments((lead as Partial<Lead>).autoPlanEnrollments);
  const documents = normalizeDocuments((lead as Partial<Lead>).documents);
  const skipTraceResults = normalizeSkipTraceResults((lead as Partial<Lead>).skipTraceResults);
  const rawAssignId = (lead as Partial<Lead>).assignedUserId;
  const assignedUserId = typeof rawAssignId === "string" && rawAssignId.trim() ? rawAssignId.trim() : null;
  const rawAssignName = (lead as Partial<Lead>).assignedUserName;
  const assignedUserName = typeof rawAssignName === "string" && rawAssignName.trim() ? rawAssignName.trim() : null;
  const dealSame = JSON.stringify(lead.deal ?? null) === JSON.stringify(deal);
  const activitySame = JSON.stringify(lead.activity ?? []) === JSON.stringify(activity);
  const enrollmentsSame = JSON.stringify(lead.autoPlanEnrollments ?? []) === JSON.stringify(autoPlanEnrollments);
  const documentsSame = JSON.stringify(lead.documents ?? []) === JSON.stringify(documents);
  const skipSame = JSON.stringify(lead.skipTraceResults ?? []) === JSON.stringify(skipTraceResults);
  const showingAppointment = normalizeShowingAppointment((lead as Partial<Lead>).showingAppointment);
  const prevShowing = normalizeShowingAppointment(lead.showingAppointment);
  const showingSame = JSON.stringify(prevShowing) === JSON.stringify(showingAppointment);
  const mojoOutreach = normalizeMojoOutreach((lead as Partial<Lead>).mojoOutreach);
  const prevMojo = normalizeMojoOutreach(lead.mojoOutreach);
  const mojoSame = JSON.stringify(prevMojo) === JSON.stringify(mojoOutreach);
  const automationPaused = (lead as Partial<Lead>).automationPaused === true;
  const automationPausedReason = normalizeAutomationPausedReason((lead as Partial<Lead>).automationPausedReason);
  const rawPausedAt = (lead as Partial<Lead>).automationPausedAt;
  const automationPausedAt = typeof rawPausedAt === "string" && rawPausedAt ? rawPausedAt : null;
  const preApprovalStatus = normalizePreApprovalStatus((lead as Partial<Lead>).preApprovalStatus);
  const rawViews = (lead as Partial<Lead>).propertyViewsCount;
  const propertyViewsCount =
    typeof rawViews === "number" && Number.isFinite(rawViews) && rawViews > 0 ? Math.floor(rawViews) : 0;
  const rawRoutingAt = (lead as Partial<Lead>).sourceRoutingCompletedAt;
  const sourceRoutingCompletedAt =
    typeof rawRoutingAt === "string" && rawRoutingAt ? rawRoutingAt : null;
  if (
    lead.crmStatus === crmStatus &&
    lead.crmStage === crmStage &&
    lead.crmPriority === crmPriority &&
    lead.crmNotes === crmNotes &&
    lead.crmIntent === crmIntent &&
    lead.crmCallQueue === crmCallQueue &&
    lead.adCampaign === adCampaign &&
    lead.alerts === alerts &&
    lead.reports === reports &&
    (lead.lastActivity ?? null) === lastActivity &&
    (lead.listingStatus ?? null) === listingStatus &&
    tagsSame &&
    dealSame &&
    activitySame &&
    enrollmentsSame &&
    documentsSame &&
    skipSame &&
    showingSame &&
    mojoSame &&
    lead.automationPaused === automationPaused &&
    (lead.automationPausedReason ?? null) === automationPausedReason &&
    (lead.automationPausedAt ?? null) === automationPausedAt &&
    (lead.assignedUserId ?? null) === assignedUserId &&
    (lead.assignedUserName ?? null) === assignedUserName &&
    (lead.preApprovalStatus ?? null) === preApprovalStatus &&
    (lead.propertyViewsCount ?? 0) === propertyViewsCount &&
    (lead.sourceRoutingCompletedAt ?? null) === sourceRoutingCompletedAt
  ) {
    return lead;
  }
  const phoneCapturedAt =
    typeof (lead as Partial<Lead>).phoneCapturedAt === "string"
      ? (lead as Partial<Lead>).phoneCapturedAt
      : undefined;
  const rawSeen = (lead as Partial<Lead>).phoneNumberSeen;
  const phoneNumberSeen = rawSeen === false ? false : rawSeen === true ? true : undefined;
  return {
    ...lead,
    crmStatus,
    crmStage,
    crmPriority,
    crmNotes,
    crmIntent,
    crmCallQueue,
    adCampaign,
    tags,
    alerts,
    reports,
    deal,
    activity,
    lastActivity,
    listingStatus,
    autoPlanEnrollments,
    documents,
    skipTraceResults,
    assignedUserId,
    assignedUserName,
    phoneCapturedAt,
    phoneNumberSeen,
    showingAppointment,
    mojoOutreach,
    automationPaused,
    automationPausedReason,
    automationPausedAt,
    preApprovalStatus,
    propertyViewsCount,
    sourceRoutingCompletedAt,
  };
}

/**
 * Snapshot of all leads + message counts for dashboard UI (read-only).
 * For the DM Agent table, we only SHOW leads that have a phone number on file.
 */
export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const generatedAt = nowIso();
  const leads: DashboardSnapshot["leads"] = [];
  const byPlatform: Record<string, number> = {};
  const byAdCampaign: Record<string, number> = {};
  const byAdCampaignWithPhone: Record<string, number> = {};

  let withPhone = 0;
  let withEmail = 0;
  let totalUserMessages = 0;
  let totalAssistantMessages = 0;

  for (const raw of leadsById.values()) {
    const lead = normalizeCrmDefaults(raw);
    const conv = conversationsByLeadId.get(lead.id) ?? { messages: [] };
    const msgs = conv.messages;
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let lastMessageAt: string | null = null;
    for (const m of msgs) {
      if (m.role === "user") userMessageCount++;
      else assistantMessageCount++;
      if (m.at && (!lastMessageAt || m.at > lastMessageAt)) lastMessageAt = m.at;
    }
    totalUserMessages += userMessageCount;
    totalAssistantMessages += assistantMessageCount;

    const hasPhone = Boolean(lead.phone?.trim());
    const hasEmail = Boolean(lead.email?.trim());
    if (hasPhone) withPhone++;
    if (hasEmail) withEmail++;

    const plat = lead.platform || "unknown";
    byPlatform[plat] = (byPlatform[plat] ?? 0) + 1;

    if (lead.adCampaign) {
      byAdCampaign[lead.adCampaign] = (byAdCampaign[lead.adCampaign] ?? 0) + 1;
      if (hasPhone) {
        byAdCampaignWithPhone[lead.adCampaign] = (byAdCampaignWithPhone[lead.adCampaign] ?? 0) + 1;
      }
    }

    if (!hasPhone) continue;

    leads.push({
      id: lead.id,
      platform: lead.platform,
      channel: channelForLead(lead),
      userId: lead.userId,
      username: lead.username,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      state: String(lead.state),
      source: lead.source,
      adCampaign: lead.adCampaign,
      propertyInquired: lead.propertyInquired,
      criteria: lead.criteria,
      brivityId: lead.brivityId,
      crmStatus: lead.crmStatus,
      crmStage: lead.crmStage,
      crmPriority: lead.crmPriority,
      crmIntent: lead.crmIntent,
      crmCallQueue: lead.crmCallQueue,
      crmNotes: lead.crmNotes,
      tags: normalizeCrmTags(lead.tags),
      address: typeof lead.address === "string" && lead.address.trim() ? lead.address.trim() : null,
      birthday: normalizeIsoDay(lead.birthday),
      homeAnniversary: normalizeIsoDay(lead.homeAnniversary),
      alerts: typeof lead.alerts === "number" && lead.alerts > 0 ? lead.alerts : 0,
      reports: typeof lead.reports === "number" && lead.reports > 0 ? lead.reports : 0,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      userMessageCount,
      assistantMessageCount,
      totalMessages: msgs.length,
      lastMessageAt,
      messages: msgs,
      activity: normalizeCrmActivity(lead.activity),
      deal: normalizeCrmDeal(lead.deal),
      lastActivity: typeof lead.lastActivity === "string" && lead.lastActivity ? lead.lastActivity : null,
      listingStatus: lead.listingStatus === "active" || lead.listingStatus === "off_market" ? lead.listingStatus : null,
      autoPlanEnrollments: normalizeAutoPlanEnrollments(lead.autoPlanEnrollments),
      documents: normalizeDocuments(lead.documents),
      assignedUserId: lead.assignedUserId ?? null,
      assignedUserName: lead.assignedUserName ?? null,
      skipTraceResults: normalizeSkipTraceResults(lead.skipTraceResults),
      phoneCapturedAt: lead.phoneCapturedAt ?? undefined,
      phoneNumberSeen: lead.phoneNumberSeen ?? (lead.phoneCapturedAt ? false : true),
    });
  }

  leads.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  const deals = getDeals();
  const totalGCI = sumClosedDealGCI(deals);
  const tasksSummary = buildTasksSummary();
  const commandTasksSummary = buildCommandTasksSummary();
  const marcoTasksSummary = buildMarcoTasksSummary(getMarcoTasks());

  return {
    generatedAt,
    totals: {
      leads: leadsById.size,
      withPhone,
      withEmail,
      shownLeads: leads.length,
      totalUserMessages,
      totalAssistantMessages,
      totalMessages: totalUserMessages + totalAssistantMessages,
    },
    byPlatform,
    byAdCampaign,
    byAdCampaignWithPhone,
    leads,
    tagTemplates: getTagTemplates(),
    users: getUsers(),
    deals,
    totalGCI,
    tasksSummary,
    commandTasksSummary,
    marcoTasksSummary,
  };
}

export async function listCrmLeads(): Promise<DashboardSnapshot["leads"]> {
  const snap = await getDashboardSnapshot();
  return snap.leads;
}

/** All leads in the store (including without phone) — for Harvey ops perception. */
export async function listAllLeads(): Promise<Lead[]> {
  const out: Lead[] = [];
  for (const raw of leadsById.values()) {
    out.push(normalizeCrmDefaults(raw));
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

const INACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

/** True if no conversation messages and no activity entries in the last 30 days. */
export async function isLeadInactive30Days(leadId: string): Promise<boolean> {
  const lead = await getLeadById(leadId);
  if (!lead) return false;
  const cutoff = Date.now() - INACTIVE_MS;
  const conv = await getConversation(leadId);
  for (const m of conv.messages) {
    if (m.at && new Date(m.at).getTime() >= cutoff) return false;
  }
  const activity = normalizeCrmActivity(lead.activity);
  for (const a of activity) {
    if (a.timestamp && new Date(a.timestamp).getTime() >= cutoff) return false;
  }
  if (lead.lastActivity && new Date(lead.lastActivity).getTime() >= cutoff) return false;
  return true;
}

/** Append one or more activity entries and optionally bump lastActivity. */
export async function appendLeadActivity(
  leadId: string,
  entries: LeadActivity[],
  opts?: { lastActivity?: string },
): Promise<Lead | null> {
  const existing = leadsById.get(leadId);
  if (!existing) return null;
  const lead = normalizeCrmDefaults(existing);
  const merged = [...normalizeCrmActivity(lead.activity), ...entries];
  const stamp = opts?.lastActivity ?? nowIso();
  return updateLeadCrmFields({
    leadId,
    activity: merged,
    lastActivity: stamp,
  });
}

/** A date-only field is either a valid YYYY-MM-DD string or null — junk never sticks. */
export function normalizeIsoDay(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : s;
}

export async function updateLeadCrmFields(input: {
  leadId: string;
  crmStatus?: CrmStatusValue;
  crmStage?: Lead["crmStage"];
  crmPriority?: Lead["crmPriority"];
  crmIntent?: Lead["crmIntent"];
  crmCallQueue?: Lead["crmCallQueue"];
  crmNotes?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  propertyInquired?: string | null;
  brivityId?: string | null;
  criteria?: Partial<Criteria> | null;
  tags?: string[] | null;
  address?: string | null;
  birthday?: string | null;
  homeAnniversary?: string | null;
  deal?: unknown;
  activity?: unknown;
  lastActivity?: string | null;
  listingStatus?: ListingStatus | null;
  alerts?: number;
  autoPlanEnrollments?: unknown;
  documents?: unknown;
  skipTraceResults?: unknown;
  assignedUserId?: string | null;
  assignedUserName?: string | null;
  phoneNumberSeen?: boolean;
  showingAppointment?: ShowingAppointment | null;
  mojoOutreach?: MojoOutreach | null;
  automationPaused?: boolean;
  automationPausedReason?: ConversationEscalationTrigger | null;
  automationPausedAt?: string | null;
  isPastClient?: boolean;
  pastClientSince?: string | null;
  preApprovalStatus?: PreApprovalStatus | null;
  propertyViewsCount?: number;
  sourceRoutingCompletedAt?: string | null;
  autoReplyEmailSentAt?: string | null;
  movedToColdNurtureAt?: string | null;
  lastWebsiteVisitAt?: string | null;
  lastReEngagementTriggeredAt?: string | null;
  /** Set only when a match was certain; see listingMatch.ts. */
  mlsListingKey?: string | null;
}): Promise<Lead | null> {
  const existing = leadsById.get(input.leadId);
  if (!existing) return null;
  const lead = normalizeCrmDefaults(existing);
  let criteria = lead.criteria;
  if (input.criteria !== undefined) {
    if (input.criteria === null) {
      criteria = null;
    } else {
      const base = criteria ?? { priceCap: null, beds: null, baths: null, area: null, timeline: null };
      criteria = {
        priceCap: input.criteria.priceCap !== undefined ? input.criteria.priceCap : base.priceCap,
        beds: input.criteria.beds !== undefined ? input.criteria.beds : base.beds,
        baths: input.criteria.baths !== undefined ? input.criteria.baths : base.baths,
        area: input.criteria.area !== undefined ? input.criteria.area : base.area,
        timeline:
          input.criteria.timeline !== undefined
            ? input.criteria.timeline === null
              ? null
              : String(input.criteria.timeline)
            : base.timeline ?? null,
      };
    }
  }
  const next: Lead = {
    ...lead,
    mlsListingKey:
      input.mlsListingKey !== undefined ? input.mlsListingKey : lead.mlsListingKey,
    crmStatus: input.crmStatus !== undefined ? normalizeCrmStatus(input.crmStatus) : lead.crmStatus,
    crmStage: input.crmStage ?? lead.crmStage,
    crmPriority: input.crmPriority ?? lead.crmPriority,
    crmIntent: input.crmIntent !== undefined ? normalizeCrmIntent(input.crmIntent) : normalizeCrmIntent(lead.crmIntent),
    crmCallQueue: input.crmCallQueue ?? lead.crmCallQueue,
    crmNotes: input.crmNotes !== undefined ? input.crmNotes : lead.crmNotes,
    name: input.name !== undefined ? input.name : lead.name,
    email: input.email !== undefined ? input.email : lead.email,
    phone: input.phone !== undefined ? input.phone : lead.phone,
    source: input.source !== undefined ? input.source : lead.source,
    propertyInquired: input.propertyInquired !== undefined ? input.propertyInquired : lead.propertyInquired,
    brivityId: input.brivityId !== undefined ? input.brivityId : lead.brivityId,
    criteria,
    tags: input.tags !== undefined ? normalizeCrmTags(input.tags) : normalizeCrmTags(lead.tags),
    address:
      input.address !== undefined
        ? input.address === null || !String(input.address).trim()
          ? null
          : String(input.address).trim()
        : lead.address ?? null,
    birthday: input.birthday !== undefined ? normalizeIsoDay(input.birthday) : normalizeIsoDay(lead.birthday),
    homeAnniversary:
      input.homeAnniversary !== undefined
        ? normalizeIsoDay(input.homeAnniversary)
        : normalizeIsoDay(lead.homeAnniversary),
    deal: input.deal !== undefined ? normalizeCrmDeal(input.deal) : normalizeCrmDeal(lead.deal),
    activity: input.activity !== undefined ? normalizeCrmActivity(input.activity) : normalizeCrmActivity(lead.activity),
    lastActivity: input.lastActivity !== undefined ? input.lastActivity : (lead.lastActivity ?? null),
    listingStatus:
      input.listingStatus !== undefined
        ? input.listingStatus === "active" || input.listingStatus === "off_market"
          ? input.listingStatus
          : null
        : lead.listingStatus === "active" || lead.listingStatus === "off_market"
          ? lead.listingStatus
          : null,
    alerts: input.alerts !== undefined ? (input.alerts > 0 ? input.alerts : 0) : (typeof lead.alerts === "number" && lead.alerts > 0 ? lead.alerts : 0),
    autoPlanEnrollments:
      input.autoPlanEnrollments !== undefined
        ? normalizeAutoPlanEnrollments(input.autoPlanEnrollments)
        : normalizeAutoPlanEnrollments(lead.autoPlanEnrollments),
    documents:
      input.documents !== undefined ? normalizeDocuments(input.documents) : normalizeDocuments(lead.documents),
    skipTraceResults:
      input.skipTraceResults !== undefined
        ? normalizeSkipTraceResults(input.skipTraceResults)
        : normalizeSkipTraceResults(lead.skipTraceResults),
    assignedUserId:
      input.assignedUserId !== undefined
        ? input.assignedUserId === null || input.assignedUserId === ""
          ? null
          : String(input.assignedUserId).trim()
        : lead.assignedUserId ?? null,
    assignedUserName:
      input.assignedUserName !== undefined
        ? input.assignedUserName === null || input.assignedUserName === ""
          ? null
          : String(input.assignedUserName).trim()
        : lead.assignedUserName ?? null,
    phoneNumberSeen:
      input.phoneNumberSeen !== undefined ? input.phoneNumberSeen : lead.phoneNumberSeen,
    showingAppointment:
      input.showingAppointment !== undefined
        ? normalizeShowingAppointment(input.showingAppointment)
        : normalizeShowingAppointment(lead.showingAppointment),
    mojoOutreach:
      input.mojoOutreach !== undefined
        ? normalizeMojoOutreach(input.mojoOutreach)
        : normalizeMojoOutreach(lead.mojoOutreach),
    automationPaused: input.automationPaused !== undefined ? input.automationPaused : lead.automationPaused ?? false,
    automationPausedReason:
      input.automationPausedReason !== undefined
        ? normalizeAutomationPausedReason(input.automationPausedReason)
        : normalizeAutomationPausedReason(lead.automationPausedReason),
    automationPausedAt:
      input.automationPausedAt !== undefined
        ? input.automationPausedAt === null || input.automationPausedAt === ""
          ? null
          : String(input.automationPausedAt)
        : lead.automationPausedAt ?? null,
    isPastClient: input.isPastClient !== undefined ? input.isPastClient : lead.isPastClient ?? false,
    pastClientSince:
      input.pastClientSince !== undefined
        ? input.pastClientSince === null || input.pastClientSince === ""
          ? null
          : String(input.pastClientSince)
        : lead.pastClientSince ?? null,
    preApprovalStatus:
      input.preApprovalStatus !== undefined
        ? normalizePreApprovalStatus(input.preApprovalStatus)
        : lead.preApprovalStatus ?? null,
    propertyViewsCount:
      input.propertyViewsCount !== undefined
        ? typeof input.propertyViewsCount === "number" && input.propertyViewsCount > 0
          ? Math.floor(input.propertyViewsCount)
          : 0
        : lead.propertyViewsCount ?? 0,
    sourceRoutingCompletedAt:
      input.sourceRoutingCompletedAt !== undefined
        ? input.sourceRoutingCompletedAt === null || input.sourceRoutingCompletedAt === ""
          ? null
          : String(input.sourceRoutingCompletedAt)
        : lead.sourceRoutingCompletedAt ?? null,
    autoReplyEmailSentAt:
      input.autoReplyEmailSentAt !== undefined
        ? input.autoReplyEmailSentAt === null || input.autoReplyEmailSentAt === ""
          ? null
          : String(input.autoReplyEmailSentAt)
        : lead.autoReplyEmailSentAt ?? null,
    movedToColdNurtureAt:
      input.movedToColdNurtureAt !== undefined
        ? input.movedToColdNurtureAt === null || input.movedToColdNurtureAt === ""
          ? null
          : String(input.movedToColdNurtureAt)
        : lead.movedToColdNurtureAt ?? null,
    lastWebsiteVisitAt:
      input.lastWebsiteVisitAt !== undefined
        ? input.lastWebsiteVisitAt === null || input.lastWebsiteVisitAt === ""
          ? null
          : String(input.lastWebsiteVisitAt)
        : lead.lastWebsiteVisitAt ?? null,
    lastReEngagementTriggeredAt:
      input.lastReEngagementTriggeredAt !== undefined
        ? input.lastReEngagementTriggeredAt === null || input.lastReEngagementTriggeredAt === ""
          ? null
          : String(input.lastReEngagementTriggeredAt)
        : lead.lastReEngagementTriggeredAt ?? null,
  };
  await updateLead(next);
  return next;
}
