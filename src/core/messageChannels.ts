/**
 * Message channels — which inbox a conversation belongs to.
 *
 * The Message Center used to be one undifferentiated list. In production that
 * list is 228 threads and **every one of them is a social DM** (151 TikTok,
 * 77 Instagram) — so "reply fast, this is a live DM" and "this is an SMS or an
 * email thread" were visually identical despite having completely different
 * urgency. Splitting them is the point of this module.
 *
 * Classification is deliberately server-side rather than in the CRM page, so
 * the UI tabs, the unread counts and anything Harvey answers about "unread
 * Instagram DMs" all agree on one definition instead of drifting apart.
 *
 * Channel is derived from `Lead.platform`, which the intake paths already set:
 *   - webhook.ts   → "instagram"  (IG DMs + comments)
 *   - TikTok DMs   → "tiktok"
 *   - sinch/index  → "sms"
 *   - Brivity import → "brivity"  (CRM contacts, not a live thread)
 */

export type MessageChannel = "instagram" | "tiktok" | "sms" | "email" | "other";

export interface MessageChannelMeta {
  id: MessageChannel;
  label: string;
  /** True for Instagram/TikTok — the "social DM" group the spec calls out. */
  social: boolean;
}

/** Display order in the Message Center: social first, then real SMS/email. */
export const MESSAGE_CHANNELS: MessageChannelMeta[] = [
  { id: "instagram", label: "Instagram", social: true },
  { id: "tiktok", label: "TikTok", social: true },
  { id: "sms", label: "SMS", social: false },
  { id: "email", label: "Email", social: false },
  { id: "other", label: "Other", social: false },
];

const CHANNEL_IDS = new Set<string>(MESSAGE_CHANNELS.map((c) => c.id));

export function isMessageChannel(value: unknown): value is MessageChannel {
  return typeof value === "string" && CHANNEL_IDS.has(value);
}

/**
 * Which inbox a lead's thread belongs in.
 *
 * **`platform` only — `source` is deliberately ignored.** Origin is not
 * channel. A Brivity contact carries a source describing where the person
 * originally came from ("Instagram", "Zillow"); that says nothing about where
 * their messages actually arrive. 86 production contacts have a social
 * `source` and no social thread at all — inferring from source would file
 * them under Instagram/TikTok, and would mis-file them again the moment
 * Marco texts one of them, since that thread is SMS.
 *
 * Anything without a messaging platform of its own (brivity, manual) is
 * "other" rather than a guess.
 */
export function channelForLead(lead: { platform?: string | null }): MessageChannel {
  const platform = String(lead.platform || "").toLowerCase().trim();

  if (platform.includes("instagram") || platform === "ig") return "instagram";
  if (platform.includes("tiktok") || platform === "tt") return "tiktok";
  if (platform === "sms" || platform.includes("twilio") || platform.includes("sinch")) return "sms";
  if (platform.includes("email") || platform.includes("gmail")) return "email";
  return "other";
}

export function isSocialChannel(channel: MessageChannel): boolean {
  return channel === "instagram" || channel === "tiktok";
}

export function channelLabel(channel: MessageChannel): string {
  return MESSAGE_CHANNELS.find((c) => c.id === channel)?.label || "Other";
}
