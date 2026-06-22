import Anthropic from "@anthropic-ai/sdk";
import { createLead, getLead, updateLeadCrmFields } from "../../core/db.js";
import { FunnelStage } from "../../core/state.js";
import {
  incrementDailyTarget,
  insertLeadCapture,
  todayDateCst,
} from "../../core/contentDb.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type DmClassification = "lead_inquiry" | "general_question" | "spam" | "existing_client";

export interface TriageDmInput {
  platform: string;
  userId: string;
  message: string;
  username?: string;
}

export interface TriageDmResult {
  classification: DmClassification;
  phoneFound: boolean;
  phone: string | null;
  leadCaptureId: string | null;
}

const US_PHONE_RE =
  /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/;

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return raw.trim();
}

function extractPhone(message: string): string | null {
  const match = message.match(US_PHONE_RE);
  if (!match) return null;
  return normalizePhone(match[0]);
}

async function classifyDm(message: string): Promise<DmClassification> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    if (/\b(price|tour|showing|buy|interested|available|bedroom)\b/i.test(message)) {
      return "lead_inquiry";
    }
    return "general_question";
  }

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 50,
    system:
      'Classify this social DM for a real estate agent. Reply with exactly one label: lead_inquiry, general_question, spam, or existing_client. JSON only: { "classification": "..." }',
    messages: [{ role: "user", content: message }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  const match = text.match(/lead_inquiry|general_question|spam|existing_client/);
  return (match?.[0] as DmClassification) ?? "general_question";
}

async function routePhoneToCrm(input: {
  platform: string;
  userId: string;
  username?: string;
  phone: string;
}): Promise<void> {
  const existing = await getLead(input.platform, input.userId);
  if (existing) {
    if (!existing.phone?.trim()) {
      await updateLeadCrmFields({
        leadId: existing.id,
        phone: input.phone,
        name: existing.name ?? input.username ?? null,
        source: existing.source ?? "content_dm",
      });
    }
    return;
  }

  await createLead({
    platform: input.platform,
    userId: input.userId,
    username: input.username ?? null,
    name: input.username ?? null,
    phone: input.phone,
    email: null,
    state: FunnelStage.New,
    source: "content_dm",
    adCampaign: null,
    propertyInquired: null,
    criteria: null,
    brivityId: null,
    crmStatus: "new",
    crmStage: "new",
    crmPriority: "normal",
    crmIntent: "buyer",
    crmCallQueue: "urgent",
    crmNotes: "Captured via Content Manager DM triage",
  });
}

export async function triageDm(input: TriageDmInput): Promise<TriageDmResult> {
  const classification = await classifyDm(input.message);
  const phone = extractPhone(input.message);
  let leadCaptureId: string | null = null;

  if (phone) {
    let routed = false;
    try {
      await routePhoneToCrm({
        platform: input.platform,
        userId: input.userId,
        username: input.username,
        phone,
      });
      routed = true;
    } catch (err) {
      console.error("[content-manager/community] CRM route failed:", err);
    }

    const capture = insertLeadCapture({
      platform: input.platform,
      platformUserId: input.userId,
      phoneNumber: phone,
      capturedFrom: "dm",
      rawMessage: input.message,
      routedToCrm: routed,
      routedAt: routed ? new Date().toISOString() : null,
    });

    incrementDailyTarget(todayDateCst(), "phone_numbers_captured");
    leadCaptureId = capture.id;
  }

  trackDmTriaged();

  return {
    classification,
    phoneFound: Boolean(phone),
    phone,
    leadCaptureId,
  };
}

export function trackCommentManaged(): void {
  incrementDailyTarget(todayDateCst(), "comments_managed");
}

export function trackDmTriaged(): void {
  incrementDailyTarget(todayDateCst(), "dms_triaged");
}
