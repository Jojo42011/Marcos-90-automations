import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

import type { Conversation, Criteria, Lead, Message, DashboardSnapshot } from "./types.js";

/**
 * File-backed store: persists to /data/db.json (Fly volume) or DB_JSON_PATH.
 * Loads on module init; sync write after createLead, updateLead, appendMessage, resetMemoryStore.
 */
const DB_PATH = process.env.DB_JSON_PATH?.trim() || "/data/db.json";

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
  const next: Lead = { ...lead, id, createdAt, updatedAt: createdAt };
  leadsById.set(id, next);
  leadKeyToId.set(leadKey(lead.platform, lead.userId), id);
  conversationsByLeadId.set(id, { messages: [] });
  persistToFile();
  return next;
}

export async function updateLead(lead: Lead): Promise<Lead | undefined> {
  const existing = leadsById.get(lead.id);
  if (!existing) {
    leadsById.set(lead.id, { ...lead, createdAt: nowIso(), updatedAt: nowIso() });
    persistToFile();
    return leadsById.get(lead.id);
  }
  const updated: Lead = { ...lead, updatedAt: nowIso() };
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

function normalizeCrmDefaults(lead: Lead): Lead {
  const crmStatus = (lead as Partial<Lead>).crmStatus ?? "not_contacted";
  const crmStage = (lead as Partial<Lead>).crmStage ?? "new";
  const crmPriority = (lead as Partial<Lead>).crmPriority ?? "normal";
  const crmNotes = (lead as Partial<Lead>).crmNotes ?? null;
  const rawIntent = (lead as Partial<Lead>).crmIntent;
  const crmIntent: Lead["crmIntent"] = rawIntent === "seller" ? "seller" : "buyer";
  const rawQ = (lead as Partial<Lead>).crmCallQueue;
  const crmCallQueue: Lead["crmCallQueue"] =
    rawQ === "urgent" || rawQ === "routine" ? rawQ : "none";
  const adCampaign = (lead as Partial<Lead>).adCampaign ?? null;
  if (
    lead.crmStatus === crmStatus &&
    lead.crmStage === crmStage &&
    lead.crmPriority === crmPriority &&
    lead.crmNotes === crmNotes &&
    lead.crmIntent === crmIntent &&
    lead.crmCallQueue === crmCallQueue &&
    lead.adCampaign === adCampaign
  ) {
    return lead;
  }
  return { ...lead, crmStatus, crmStage, crmPriority, crmNotes, crmIntent, crmCallQueue, adCampaign };
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
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      userMessageCount,
      assistantMessageCount,
      totalMessages: msgs.length,
      lastMessageAt,
    });
  }

  leads.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

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

export async function updateLeadCrmFields(input: {
  leadId: string;
  crmStatus?: Lead["crmStatus"];
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
    crmStatus: input.crmStatus ?? lead.crmStatus,
    crmStage: input.crmStage ?? lead.crmStage,
    crmPriority: input.crmPriority ?? lead.crmPriority,
    crmIntent: input.crmIntent ?? lead.crmIntent,
    crmCallQueue: input.crmCallQueue ?? lead.crmCallQueue,
    crmNotes: input.crmNotes !== undefined ? input.crmNotes : lead.crmNotes,
    name: input.name !== undefined ? input.name : lead.name,
    email: input.email !== undefined ? input.email : lead.email,
    phone: input.phone !== undefined ? input.phone : lead.phone,
    source: input.source !== undefined ? input.source : lead.source,
    propertyInquired: input.propertyInquired !== undefined ? input.propertyInquired : lead.propertyInquired,
    brivityId: input.brivityId !== undefined ? input.brivityId : lead.brivityId,
    criteria,
  };
  await updateLead(next);
  return next;
}
