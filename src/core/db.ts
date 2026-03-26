import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

import type { Conversation, Lead, Message } from "./types.js";

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

