import type { FunnelStage } from "./state.js";

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
  propertyInquired: string | null;
  criteria: Criteria | null;
  brivityId: string | null;
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

