import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type {
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
} from "./types.js";
import { CRM_STATUSES } from "./types.js";
import { getDeals, sumClosedDealGCI } from "./deals.js";
import { getTagTemplates } from "./tagTemplates.js";
import { getUsers } from "./users.js";
import { buildTasksSummary } from "./tasks.js";

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

let idCounter = 1;

type PersistedShape = {
  idCounter: number;
  leadsById: Record<string, Lead>;
  leadKeyToId: Record<string, string>;
  conversationsByLeadId: Record<string, Conversation>;
};

function persistToFile(): void {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const data: PersistedShape = {
      idCounter,
      leadsById: Object.fromEntries(leadsById),
      leadKeyToId: Object.fromEntries(leadKeyToId),
      conversationsByLeadId: Object.fromEntries(conversationsByLeadId),
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
  idCounter = 1;
  persistToFile();
}

function nowIso(): string {
  return new Date().toISOString();
}

function leadKey(platform: string, userId: string): string {
  return `${platform}::${userId}`;
}

export async function getLead(platform: string, userId: string): Promise<Lead | null> {
  const id = leadKeyToId.get(leadKey(platform, userId));
  if (!id) return null;
  return leadsById.get(id) ?? null;
}

/** Lookup by internal lead id (CRM / Sendblue). */
export async function getLeadById(leadId: string): Promise<Lead | null> {
  const id = String(leadId || "").trim();
  if (!id) return null;
  return leadsById.get(id) ?? null;
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

export async function createLead(lead: Omit<Lead, "id" | "createdAt" | "updatedAt">): Promise<Lead> {
  const id = String(idCounter++);
  const createdAt = nowIso();
  const next: Lead = normalizeCrmDefaults({ ...lead, id, createdAt, updatedAt: createdAt });
  leadsById.set(id, next);
  leadKeyToId.set(leadKey(lead.platform, lead.userId), id);
  conversationsByLeadId.set(id, { messages: [] });
  persistToFile();
  return next;
}

export async function updateLead(lead: Lead): Promise<Lead | undefined> {
  const existing = leadsById.get(lead.id);
  if (!existing) {
    leadsById.set(lead.id, normalizeCrmDefaults({ ...lead, createdAt: nowIso(), updatedAt: nowIso() }));
    persistToFile();
    return leadsById.get(lead.id);
  }
  const updated: Lead = normalizeCrmDefaults({ ...lead, updatedAt: nowIso() });
  leadsById.set(lead.id, updated);
  persistToFile();
  return updated;
}

export async function getConversation(leadId: string): Promise<Conversation> {
  return conversationsByLeadId.get(leadId) ?? { messages: [] };
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
    (lead.assignedUserId ?? null) === assignedUserId &&
    (lead.assignedUserName ?? null) === assignedUserName
  ) {
    return lead;
  }
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
    });
  }

  leads.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  const deals = getDeals();
  const totalGCI = sumClosedDealGCI(deals);
  const tasksSummary = buildTasksSummary();

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
}): Promise<Lead | null> {
  const existing = leadsById.get(input.leadId);
  if (!existing) return null;
  const lead = normalizeCrmDefaults(existing);
  let criteria = lead.criteria;
  if (input.criteria !== undefined) {
    if (input.criteria === null) {
      criteria = null;
    } else {
      const base = criteria ?? { priceCap: null, beds: null, baths: null, area: null };
      criteria = {
        priceCap: input.criteria.priceCap !== undefined ? input.criteria.priceCap : base.priceCap,
        beds: input.criteria.beds !== undefined ? input.criteria.beds : base.beds,
        baths: input.criteria.baths !== undefined ? input.criteria.baths : base.baths,
        area: input.criteria.area !== undefined ? input.criteria.area : base.area,
      };
    }
  }
  const next: Lead = {
    ...lead,
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
  };
  await updateLead(next);
  return next;
}
