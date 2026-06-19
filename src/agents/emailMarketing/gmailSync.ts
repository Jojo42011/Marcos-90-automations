import {
  listGmailMessages,
  extractSenderEmail,
  type GmailMessageSummary,
} from "../../integrations/gmail/inbox.js";
import { isGmailConfigured } from "../../integrations/gmail/index.js";
import {
  cacheGmailMessage,
  getCachedGmailMessages,
  markEmailReplied,
  attachGmailMessageId,
} from "../../core/emailStore.js";
import { listAllLeads } from "../../core/db.js";

export async function syncGmailInbox(opts?: {
  maxResults?: number;
  query?: string;
}): Promise<{ synced: number; repliesMatched: number; messages: GmailMessageSummary[] }> {
  if (!isGmailConfigured()) {
    return { synced: 0, repliesMatched: 0, messages: [] };
  }

  const messages = await listGmailMessages({
    maxResults: opts?.maxResults ?? 30,
    query: opts?.query ?? "newer_than:14d",
  });

  const leads = await listAllLeads();
  const emailToLead = new Map<string, string>();
  for (const l of leads) {
    if (l.email?.trim()) emailToLead.set(l.email.trim().toLowerCase(), l.id);
  }

  const now = new Date().toISOString();
  let synced = 0;
  let repliesMatched = 0;

  for (const m of messages) {
    const sender = m.direction === "inbound" ? extractSenderEmail(m.from) : "";
    const leadId = sender ? emailToLead.get(sender) : undefined;
    if (m.direction === "inbound" && leadId) {
      markEmailReplied(leadId);
      repliesMatched++;
    }
    cacheGmailMessage({
      id: m.id,
      threadId: m.threadId,
      direction: m.direction,
      fromAddr: m.from,
      toAddr: m.to,
      subject: m.subject,
      snippet: m.snippet,
      body: m.snippet,
      receivedAt: m.date,
      leadId,
      syncedAt: now,
    });
    synced++;
  }

  console.log(`[GmailSync] synced ${synced} messages, matched ${repliesMatched} inbound replies`);
  return { synced, repliesMatched, messages };
}

export function getGmailInboxForHarvey(limit = 15): {
  configured: boolean;
  cached: ReturnType<typeof getCachedGmailMessages>;
} {
  return {
    configured: isGmailConfigured(),
    cached: getCachedGmailMessages(limit),
  };
}

/** After outbound send, link local email row to Gmail message id. */
export function linkSentEmailToGmail(localEmailId: string, gmailMessageId: string): void {
  attachGmailMessageId(localEmailId, gmailMessageId);
}
