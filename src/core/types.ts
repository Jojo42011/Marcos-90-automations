import type { FunnelStage } from "./state.js";

export type CrmStatus = "not_contacted" | "contacted" | "nurture" | "dead";
export type CrmStage =
  | "new"
  | "hot"
  | "warm"
  | "cold"
  | "appointment_set"
  | "showing_set"
  | "under_contract"
  | "closed";
export type CrmPriority = "low" | "normal" | "high";
/** Buyer vs seller — drives dashboard funnels and seller (red) views. */
export type CrmIntent = "buyer" | "seller";
/** Marco call prioritization in CRM (two queues + unset). */
export type CrmCallQueue = "none" | "urgent" | "routine";

/**
 * Lead — single source of truth per platform + userId.
 */
export interface Lead {
  id: string;
  platform: string;
  userId: string;
  username: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  state: FunnelStage;
  source: string | null;
  /** Detected from first inbound message phrase (Instagram ad attribution). */
  adCampaign: string | null;
  propertyInquired: string | null;
  criteria: Criteria | null;
  brivityId: string | null;
  /** Lightweight CRM fields for Marco's mission terminal. */
  crmStatus: CrmStatus;
  crmStage: CrmStage;
  crmPriority: CrmPriority;
  crmIntent: CrmIntent;
  crmCallQueue: CrmCallQueue;
  crmNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Criteria {
  priceCap: number | null;
  beds: number | null;
  baths: number | null;
  area: string | null;
}

export interface Message {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface Conversation {
  messages: Message[];
}

/** Read-only aggregate for the lead desk dashboard (from file-backed DB). */
export interface DashboardLeadRow {
  id: string;
  platform: string;
  userId: string;
  username: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  state: string;
  source: string | null;
  adCampaign: string | null;
  propertyInquired: string | null;
  criteria: Criteria | null;
  brivityId: string | null;
  crmStatus: CrmStatus;
  crmStage: CrmStage;
  crmPriority: CrmPriority;
  crmIntent: CrmIntent;
  crmCallQueue: CrmCallQueue;
  crmNotes: string | null;
  createdAt: string;
  updatedAt: string;
  userMessageCount: number;
  assistantMessageCount: number;
  totalMessages: number;
  lastMessageAt: string | null;
}

export interface DashboardSnapshot {
  generatedAt: string;
  totals: {
    leads: number;
    withPhone: number;
    withEmail: number;
    shownLeads: number;
    totalUserMessages: number;
    totalAssistantMessages: number;
    totalMessages: number;
  };
  byPlatform: Record<string, number>;
  /** All leads with adCampaign set (includes leads without phone). */
  byAdCampaign: Record<string, number>;
  /** Phone-captured leads with adCampaign set. */
  byAdCampaignWithPhone: Record<string, number>;
  leads: DashboardLeadRow[];
}

export interface IncomingWebhookPayload {
  platform: string;
  userId: string;
  /** IG handle / stable id — stored on Lead.username for lookups and CRM. */
  username: string | null;
  /** Display name when ManyChat maps Full Name into `username` or sends full_name / name. */
  displayName: string | null;
  message: string;
  /** `comment` when the automation fired from an Instagram comment (ManyChat `comment_or_dm`). */
  commentOrDm: "comment" | "dm";
  /**
   * TikTok: Marco’s first DM was sent manually in-app. On the lead’s first reply, pass that exact text
   * so the thread has Marco’s opener before the user line — AI continues without duplicating it.
   */
  marcoPreviousOutbound: string | null;
}

