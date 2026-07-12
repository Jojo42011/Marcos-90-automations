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
  /** Listing/post/ad ID the lead's first message came in on, when ManyChat forwards one. */
  listingId: string | null;
  /** Short structured notes for Carlos/CRM handoff, e.g. "Lead wants: 5bd/3ba, Killeen TX area". */
  crmNotes: string[] | null;
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
  username: string | null;
  message: string;
  commentOrDm: "comment" | "dm";
  /**
   * "message_deleted" when the platform reports the lead removed a message.
   * Requires ManyChat to be configured to forward that event; defaults to "message".
   */
  event?: "message" | "message_deleted";
  /**
   * Which post/reel/ad the lead's comment or DM came from. ManyChat does not expose this
   * automatically in the raw webhook — it must be set as a custom field ("listing_id") inside
   * each Comments Growth Tool automation (one automation per listing/video), forwarded here via
   * the External Request body. Null when not configured or on an ordinary open DM.
   */
  listingId?: string | null;
}

