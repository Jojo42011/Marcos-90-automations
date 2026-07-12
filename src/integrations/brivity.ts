import axios from "axios";
import type { Lead } from "../core/types.js";

const BRIVITY_BASE_URL = process.env.BRIVITY_BASE_URL || "https://app.brivityidx.com/api";
const BRIVITY_API_KEY = process.env.BRIVITY_API_KEY || "";

const brivityClient = axios.create({
  baseURL: BRIVITY_BASE_URL,
  headers: {
    Authorization: BRIVITY_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 12000,
});

function normalizeSource(platform: string): string {
  return platform.toLowerCase().includes("tik") ? "TikTok" : "Instagram";
}

function leadStage(lead: Lead): string {
  return String(lead.state);
}

function firstNameFromLead(lead: Lead): string {
  if (lead.name?.trim()) return lead.name.trim();
  if (lead.username?.trim()) return lead.username.trim();
  return "Lead";
}

function toContactPayload(lead: Lead): {
  first_name: string;
  phone?: string;
  email?: string;
  source: string;
  stage: string;
  notes?: string;
} {
  return {
    first_name: firstNameFromLead(lead),
    phone: lead.phone ?? undefined,
    email: lead.email ?? undefined,
    source: normalizeSource(lead.platform),
    stage: leadStage(lead),
    notes: lead.crmNotes && lead.crmNotes.length > 0 ? lead.crmNotes.join("; ") : undefined,
  };
}

async function findByPhone(phone: string): Promise<{ id?: string } | null> {
  try {
    const response = await brivityClient.get("/contacts", { params: { phone } });
    const data = response.data as unknown;
    if (Array.isArray(data) && data.length > 0) return data[0];
    if (data && typeof data === "object") {
      const maybe = data as { contacts?: unknown; data?: unknown };
      if (Array.isArray(maybe.contacts) && maybe.contacts.length > 0) return maybe.contacts[0] as any;
      if (Array.isArray(maybe.data) && maybe.data.length > 0) return maybe.data[0] as any;
    }
    return null;
  } catch (error) {
    console.error("[Brivity] findByPhone failed:", error);
    return null;
  }
}

export async function createOrUpdateLead(lead: Lead): Promise<unknown | null> {
  try {
    const payload = toContactPayload(lead);
    const response = await brivityClient.post("/contacts", payload);
    return (response.data as unknown) ?? null;
  } catch (error) {
    console.error("[Brivity] createOrUpdateLead failed:", error);
    return null;
  }
}

export async function syncLead(lead: Lead): Promise<unknown | null> {
  try {
    if (!lead.phone && !lead.email) {
      return null;
    }

    if (lead.phone) {
      const existing = await findByPhone(lead.phone);
      if (existing?.id) {
        const payload = toContactPayload(lead);
        const response = await brivityClient.put(`/contacts/${existing.id}`, payload);
        return (response.data as unknown) ?? existing;
      }
    }

    return await createOrUpdateLead(lead);
  } catch (error) {
    console.error("[Brivity] syncLead failed:", error);
    return null;
  }
}

