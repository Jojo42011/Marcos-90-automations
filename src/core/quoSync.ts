/**
 * Pull Quo SMS into the local mirror.
 *
 * The shape of this sync is forced by the API: there is no "list my inbox"
 * call. `GET /v1/messages` demands both a phoneNumberId and the participants,
 * so the only route to a full picture is conversations-first, then messages
 * per conversation. With ~286 conversations on the account that is ~286
 * requests for a full pass, which is why:
 *
 *   - the default pass is INCREMENTAL: only conversations whose lastActivityAt
 *     moved since the previous run are re-read
 *   - a full pass is opt-in (`full: true`), used once on first connect
 *   - requests are issued with a small concurrency, not all at once
 *
 * Most of those conversations are CALLS. A call thread simply returns no
 * messages, and is skipped — it never becomes an empty "SMS thread" in the
 * CRM. That distinction is not visible on the conversation row, so it can only
 * be discovered by asking, which is the reason the sync looks expensive.
 */
import {
  listConversations,
  listMessages,
  isQuoConfigured,
  getQuoPhoneNumberId,
  listPhoneNumbers,
  phoneKey,
  type QuoConversation,
} from "../integrations/quo/index.js";
import { quoMetaGet, quoMetaSet, upsertQuoMessage } from "./quoStore.js";

const META_LAST_SYNC = "last_sync_at";
const META_LAST_FULL = "last_full_sync_at";

export interface QuoSyncResult {
  ok: boolean;
  conversationsSeen: number;
  conversationsWithMessages: number;
  messagesStored: number;
  newMessages: number;
  skippedCallThreads: number;
  full: boolean;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

/** Resolve the sending line: pinned by env, else the first on the account. */
async function resolvePhoneNumberId(): Promise<string | null> {
  const pinned = getQuoPhoneNumberId();
  if (pinned) return pinned;
  try {
    const numbers = await listPhoneNumbers();
    return numbers[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Run `worker` over `items` with a modest concurrency cap. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

export async function syncQuoMessages(opts: { full?: boolean } = {}): Promise<QuoSyncResult> {
  const startedAt = new Date().toISOString();
  const base: QuoSyncResult = {
    ok: false, conversationsSeen: 0, conversationsWithMessages: 0, messagesStored: 0,
    newMessages: 0, skippedCallThreads: 0, full: opts.full === true,
    startedAt, finishedAt: startedAt,
  };
  if (!isQuoConfigured()) {
    return { ...base, error: "QUO_API_KEY is not set", finishedAt: new Date().toISOString() };
  }
  const phoneNumberId = await resolvePhoneNumberId();
  if (!phoneNumberId) {
    return { ...base, error: "No Quo phone number available on this account", finishedAt: new Date().toISOString() };
  }

  const lastSync = quoMetaGet(META_LAST_SYNC);
  const everFull = quoMetaGet(META_LAST_FULL);
  /* First run is always full, whatever was asked for: an incremental first
     pass would mirror only whatever happened to move today and quietly
     present it as the whole history. */
  const full = opts.full === true || !everFull;

  try {
    const conversations: QuoConversation[] = await listConversations(
      full || !lastSync ? {} : { updatedAfter: lastSync },
    );
    base.conversationsSeen = conversations.length;

    let stored = 0, fresh = 0, withMsgs = 0, calls = 0;
    await mapLimit(conversations, 4, async (c) => {
      const participants = (c.participants || []).filter(Boolean);
      if (!participants.length) return;
      let msgs;
      try {
        msgs = await listMessages({
          phoneNumberId: c.phoneNumberId || phoneNumberId,
          participants,
          maxResults: 100,
          maxPages: full ? 5 : 2,
        });
      } catch {
        /* One unreadable thread must not fail the pass. */
        return;
      }
      if (!msgs.length) { calls++; return; }
      withMsgs++;
      for (const m of msgs) {
        /* The counterparty is whichever end is not our own line. Quo puts the
           other party in `to` on an outgoing message and in `from` on an
           incoming one. */
        const peer = m.direction === "outgoing" ? (m.to || [])[0] : m.from;
        if (!peer) continue;
        stored++;
        if (upsertQuoMessage({
          id: m.id,
          conversationId: m.conversationId || c.id,
          phoneNumberId: m.phoneNumberId || phoneNumberId,
          peerKey: phoneKey(peer),
          peer,
          direction: m.direction === "outgoing" ? "outgoing" : "incoming",
          text: m.text || "",
          status: m.status || "",
          createdAt: m.createdAt,
          userId: m.userId || null,
        })) fresh++;
      }
    });

    const finishedAt = new Date().toISOString();
    quoMetaSet(META_LAST_SYNC, finishedAt);
    if (full) quoMetaSet(META_LAST_FULL, finishedAt);
    return {
      ...base, ok: true, full,
      conversationsWithMessages: withMsgs, messagesStored: stored,
      newMessages: fresh, skippedCallThreads: calls, finishedAt,
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      finishedAt: new Date().toISOString(),
    };
  }
}

export function lastQuoSyncAt(): string | null {
  return quoMetaGet(META_LAST_SYNC);
}

/**
 * Poll on a timer. Quo supports webhooks and those are wired too, but a poll
 * is the safety net: a webhook missed while the app was restarting would
 * otherwise leave a message permanently absent from the CRM.
 */
export function scheduleQuoSync(intervalMinutes = 5): void {
  if (!isQuoConfigured()) {
    console.log("[Quo] not configured — SMS sync disabled");
    return;
  }
  const run = () => {
    syncQuoMessages()
      .then((r) => {
        if (!r.ok) console.error("[Quo] sync failed:", r.error);
        else if (r.newMessages) console.log(`[Quo] sync: ${r.newMessages} new message(s) across ${r.conversationsWithMessages} thread(s)`);
      })
      .catch((e) => console.error("[Quo] sync threw:", e));
  };
  setTimeout(run, 15000);                       // let boot settle first
  setInterval(run, Math.max(1, intervalMinutes) * 60 * 1000);
  console.log(`[Quo] SMS sync scheduled every ${intervalMinutes}m`);
}
