/**
 * Pull Zernio inbox conversations into this account's local DM store so the
 * DM Agent tab can show threads that already exist on Zernio (and on the
 * standalone wesley-dm-ai app) without waiting for a fresh webhook.
 *
 * Uses upsertLeadQuiet / mergeConversationHistory — never createLead — so a
 * sync cannot fire phone texts or email drips for hundreds of historical leads.
 */
import { FunnelStage } from "./state.js";
import {
  getLead,
  mergeConversationHistory,
  upsertLeadQuiet,
} from "./db.js";
import {
  isZernioDmConfigured,
  listZernioInboxConversations,
  listZernioInboxMessages,
  zernioTikTokAccountId,
  type ZernioInboxConversation,
} from "../integrations/zernio/dm.js";
import { currentZernioSecrets } from "./zernioOwnerConfig.js";

export interface ZernioDmSyncResult {
  ok: boolean;
  configured: boolean;
  owner: string;
  accountId: string | null;
  conversationsSeen: number;
  leadsUpserted: number;
  messagesMerged: number;
  error?: string;
}

const PHONE_RE = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/;

function pickPhone(texts: string[]): string | null {
  for (const t of texts) {
    const m = t.match(PHONE_RE);
    if (m) return m[0].replace(/[^\d+]/g, "");
  }
  return null;
}

async function syncOneConversation(conv: ZernioInboxConversation): Promise<{ lead: boolean; messages: number }> {
  const userId = String(conv.participantId || "").trim();
  if (!userId) return { lead: false, messages: 0 };

  const platform = (conv.platform || "tiktok").toLowerCase() || "tiktok";
  const msgs = await listZernioInboxMessages(conv.id, {
    accountId: conv.accountId || zernioTikTokAccountId() || undefined,
    limit: 100,
  });
  if (!msgs.ok) return { lead: false, messages: 0 };

  const history = msgs.messages.filter((m) => m.text);
  const existing = await getLead(platform, userId);
  const phone =
    existing?.phone ||
    pickPhone(history.filter((m) => m.role === "user").map((m) => m.text));

  upsertLeadQuiet({
    ...(existing || {
      platform,
      userId,
      username: conv.participantUsername || null,
      name: conv.participantName || conv.participantUsername || null,
      email: null,
      state: FunnelStage.New,
      source: "zernio_sync",
      adCampaign: null,
      propertyInquired: null,
      criteria: null,
      brivityId: null,
      crmStatus: "new",
      crmStage: "new",
      crmPriority: "normal",
      crmIntent: null,
      crmCallQueue: "none",
      crmNotes: null,
    }),
    id: existing?.id,
    platform,
    userId,
    username: conv.participantUsername || existing?.username || null,
    name: conv.participantName || conv.participantUsername || existing?.name || null,
    phone: phone || existing?.phone || null,
    source: existing?.source || "zernio_sync",
  });

  const lead = await getLead(platform, userId);
  if (!lead) return { lead: false, messages: 0 };
  await mergeConversationHistory(lead.id, history);
  return { lead: true, messages: history.length };
}

/**
 * Sync this account's Zernio TikTok inbox into the local DM store.
 * Safe to call repeatedly — merges by provider message id / near-duplicate text.
 */
export async function syncZernioDmsToStore(opts: {
  maxConversations?: number;
} = {}): Promise<ZernioDmSyncResult> {
  const secrets = currentZernioSecrets();
  const accountId = zernioTikTokAccountId() || null;
  const base: ZernioDmSyncResult = {
    ok: false,
    configured: isZernioDmConfigured(),
    owner: secrets.ownerSlug,
    accountId,
    conversationsSeen: 0,
    leadsUpserted: 0,
    messagesMerged: 0,
  };

  if (!base.configured) {
    return { ...base, error: "Zernio is not configured for this account." };
  }
  if (!accountId) {
    return { ...base, error: "ZERNIO_TIKTOK_ACCOUNT_ID is not set for this account." };
  }

  try {
    const max = Math.max(1, Math.min(500, opts.maxConversations ?? 200));
    let cursor: string | null = null;
    let seen = 0;
    let leads = 0;
    let messages = 0;

    while (seen < max) {
      const pageLimit = Math.min(100, max - seen);
      const page = await listZernioInboxConversations({
        accountId,
        limit: pageLimit,
        cursor,
        sortOrder: "desc",
      });
      if (!page.ok) {
        return { ...base, conversationsSeen: seen, leadsUpserted: leads, messagesMerged: messages, error: page.error };
      }
      if (!page.conversations.length) break;

      for (const conv of page.conversations) {
        if (seen >= max) break;
        seen++;
        if (conv.platform && conv.platform !== "tiktok") continue;
        const r = await syncOneConversation(conv);
        if (r.lead) leads++;
        messages += r.messages;
      }

      if (!page.nextCursor || page.conversations.length < pageLimit) break;
      cursor = page.nextCursor;
    }

    return {
      ...base,
      ok: true,
      conversationsSeen: seen,
      leadsUpserted: leads,
      messagesMerged: messages,
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
