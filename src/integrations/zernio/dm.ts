/**
 * Zernio DM transport — TikTok direct messages, replacing ManyChat on that channel.
 *
 * WHY THIS EXISTS. ManyChat's TikTok connection broke and took the whole TikTok
 * DM funnel with it. Zernio added TikTok inbox support on 2026-09-10/11 and is
 * the only thing available that can both receive a TikTok DM and reply to one.
 *
 * WHY THIS IS `dm.ts` AND NOT `index.ts`, which is the trap here: `index.ts` in
 * this folder is ALREADY a different Zernio client — a social-analytics stub
 * consumed by `core/socialAnalytics.ts`. Same vendor, unrelated surface. The two
 * must not be merged, and in particular they must not share an env var:
 *
 *   · That analytics client arms itself on `ZERNIO_API_KEY` and then calls
 *     `https://api.zernio.com/v1/analytics/{platform}` — a host and a path shape
 *     that do not match Zernio's real API (`https://zernio.com/api/v1`). It was
 *     written against guessed field names before anyone had a key or the docs,
 *     and says so in its own header.
 *   · So setting `ZERNIO_API_KEY` would flip the Instagram/Facebook/YouTube tiles
 *     on the analytics page from the honest "Waiting on the Zernio connection"
 *     to a red "Zernio request failed", purely as a side effect of turning on
 *     TikTok DMs.
 *
 * Hence `ZERNIO_DM_API_KEY`. The VALUE is the same Zernio key; the separate name
 * is what keeps one feature from silently arming another. Wiring the analytics
 * client up properly is now possible (we have the docs) but it is a separate
 * decision with its own verification, not a side effect of this change.
 *
 * THE ONE ARCHITECTURAL DIFFERENCE FROM MANYCHAT, and it is the whole file.
 * ManyChat CALLED US and sent whatever we returned in the HTTP response body —
 * which is why `integrations/manychat/sendDM` is a stub and nothing here ever
 * needed an outbound sender. Zernio inverts that:
 *
 *   ManyChat:  POST /webhook  →  { reply }  →  ManyChat sends the DM
 *   Zernio:    POST /api/zernio/webhook  →  200 (fast)  →  WE call Zernio to send
 *
 * Two consequences follow, both load-bearing:
 *
 *   1. ZERNIO REQUIRES A 2xx WITHIN 5 SECONDS or it retries (7 attempts,
 *      exponential backoff, then a dead-letter queue). Our pipeline holds a
 *      4-second debounce and then makes two Haiku calls, so replying inline
 *      would blow that budget on most turns and earn duplicate deliveries of the
 *      same inbound — on a system that fought hard to stop duplicate DMs. The
 *      route therefore acks FIRST and processes after. Nothing in the pipeline
 *      changed to accommodate this.
 *   2. The reply is a second HTTP request we make, so it can fail on its own,
 *      after the pipeline has already written the assistant message to the
 *      thread. `sendZernioReply` carries an Idempotency-Key so a retry after an
 *      ambiguous failure cannot double-send.
 *
 * TIKTOK'S OWN RULES, inherited and not negotiable:
 *   · Reply-only. TikTok does not let a business START a conversation. This is
 *     already how Marco runs the channel: a VA opens the thread by hand in the
 *     app, and the agent takes over on the lead's reply.
 *   · 10 messages within 48 hours of the lead's last message. A send outside
 *     that window fails with TikTok's own error, which we surface, not swallow.
 *   · Text OR one image, never both.
 *   · The account must be a TikTok Business Account connected through TikTok's
 *     Business app, outside the EEA/Switzerland/UK, with DMs enabled. If any of
 *     those fail TikTok sends no webhook at all — silently. Verified present on
 *     @puga.realtor at build time (apiFlavor "business"; scopes message.list
 *     .read, .send and .manage all granted).
 *
 * NOT SUPPORTED ON TIKTOK, so nobody builds it by mistake: comment-to-DM.
 * Instagram and Facebook are the only platforms exposing private-reply-to-
 * comment. TikTok `comment.received` webhooks do work, so comments can be READ;
 * auto-DMing a commenter cannot be done through any API.
 */
import { createHmac, timingSafeEqual, randomUUID } from "crypto";

import type { IncomingWebhookPayload } from "../../core/types.js";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";

/** Zernio's documented budget for our webhook ack. We stay well inside it. */
export const ZERNIO_ACK_BUDGET_MS = 5000;

function apiKey(): string {
  return process.env.ZERNIO_DM_API_KEY?.trim() ?? "";
}

function webhookSecret(): string {
  return process.env.ZERNIO_WEBHOOK_SECRET?.trim() ?? "";
}

/** The Zernio account id for Marco's TikTok, needed on every send and read. */
export function zernioTikTokAccountId(): string {
  return process.env.ZERNIO_TIKTOK_ACCOUNT_ID?.trim() ?? "";
}

export function isZernioDmConfigured(): boolean {
  return Boolean(apiKey());
}

export function zernioWebhookSecretConfigured(): boolean {
  return Boolean(webhookSecret());
}

/**
 * Verify `X-Zernio-Signature`: lowercase hex HMAC-SHA256 of the RAW request
 * body, keyed by the secret we chose and registered.
 *
 * Must be given the raw bytes, not a re-serialized object — `JSON.stringify` of
 * a parsed body is not byte-identical to what was signed (key order, unicode
 * escaping, whitespace), so re-serializing would fail every legitimate
 * delivery. That is why the route mounts `express.raw` and parses afterwards.
 */
export function verifyZernioSignature(rawBody: Buffer | string, signature: string): boolean {
  const secret = webhookSecret();
  if (!secret) return false;
  const provided = signature?.trim().toLowerCase();
  if (!provided) return false;

  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  /* timingSafeEqual throws on a length mismatch, which would leak the expected
     length through the error path, so compare lengths first. */
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The subset of Zernio's `message.received` payload this integration reads. */
export interface ZernioInboundMessage {
  /** Stable webhook event id — used for retry dedup. */
  eventId: string;
  conversationId: string;
  accountId: string;
  platform: string;
  /** The sender's platform identifier. This becomes the lead key. */
  senderId: string;
  senderName: string | null;
  senderUsername: string | null;
  text: string;
  platformMessageId: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Normalize a `message.received` body, or return null when this is not an
 * inbound message we should act on.
 *
 * Refuses, deliberately:
 *   · any event other than `message.received`
 *   · `direction: "outgoing"` — our OWN sends echo back as events, and acting
 *     on them would have the agent answer itself in a loop
 *   · a missing sender id, which would otherwise key every such message to the
 *     same lead. That is the exact failure ManyChat's unsubstituted merge field
 *     caused on two production leads: losing one message is recoverable, a
 *     merged thread is not.
 */
export function parseZernioInboundMessage(body: unknown): ZernioInboundMessage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.event !== "message.received") return null;

  const message = (b.message ?? {}) as Record<string, unknown>;
  const conversation = (b.conversation ?? {}) as Record<string, unknown>;
  const account = (b.account ?? {}) as Record<string, unknown>;
  const sender = (message.sender ?? {}) as Record<string, unknown>;

  if (str(message.direction) === "outgoing") return null;

  const senderId = str(sender.id) ?? str(conversation.participantId);
  const conversationId = str(message.conversationId) ?? str(conversation.id);
  const accountId = str(account.accountId) ?? str(account.id);
  if (!senderId || !conversationId || !accountId) return null;

  return {
    eventId: str(b.id) ?? `${conversationId}:${str(message.id) ?? randomUUID()}`,
    conversationId,
    accountId,
    platform: str(message.platform) ?? str(account.platform) ?? "tiktok",
    senderId,
    senderName: str(sender.name) ?? str(conversation.participantName),
    senderUsername: str(sender.username) ?? str(conversation.participantUsername),
    /* Attachment-only messages arrive with a null text. Kept rather than
       dropped so the pipeline still sees a turn; it already treats an empty
       message as "no reply" instead of inventing one. */
    text: str(message.text) ?? "",
    platformMessageId: str(message.platformMessageId),
  };
}

async function zernioFetch(
  path: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(`${ZERNIO_API_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* Non-JSON error bodies exist; the raw text is kept for the caller's log. */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * The VA's manually-sent opener, so the thread in our DB matches what the lead
 * actually sees.
 *
 * Marco's TikTok flow is: a VA DMs whoever comments, by hand, in the app; the
 * agent takes over when they reply. ManyChat passed that opener as
 * `marco_previous_outbound`; Zernio has no such field, so we read it back off
 * the conversation instead. Same value, different source — `maybeSeedTiktok
 * ManualOpener` in the pipeline then behaves exactly as it does today, which is
 * the point: this is a transport swap, not a funnel change.
 *
 * Returns null on any failure. A missing opener costs the model one piece of
 * context; a thrown error here would cost the lead their reply, so this never
 * throws.
 */
export async function fetchVaOpener(
  conversationId: string,
  accountId: string,
): Promise<string | null> {
  if (!isZernioDmConfigured()) return null;
  try {
    const qs = new URLSearchParams({ accountId, sortOrder: "asc", limit: "10" });
    const r = await zernioFetch(
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`,
      { method: "GET" },
    );
    if (!r.ok) return null;
    const payload = r.json as { messages?: unknown; data?: unknown } | null;
    const list = (Array.isArray(payload?.messages)
      ? payload?.messages
      : Array.isArray(payload?.data)
        ? payload?.data
        : []) as Record<string, unknown>[];
    /* The opener is the FIRST outgoing message in the thread — the VA's. */
    const first = list.find((m) => str(m.direction) === "outgoing");
    return first ? str(first.text) : null;
  } catch {
    return null;
  }
}

/** Map a normalized Zernio event onto the payload the existing pipeline takes. */
export function toIncomingWebhookPayload(
  evt: ZernioInboundMessage,
  vaOpener: string | null,
): IncomingWebhookPayload {
  return {
    /* "tiktok" so every existing platform check still fires — in particular the
       neutral-DM rule that forbids quoting a list price in a TikTok DM. */
    platform: evt.platform,
    userId: evt.senderId,
    username: evt.senderUsername,
    displayName: evt.senderName,
    message: evt.text,
    commentOrDm: "dm",
    marcoPreviousOutbound: vaOpener,
    /* TikTok DMs carry no post context, so there is no listing to resolve. A
       fabricated one would link the lead to the wrong house. */
    listingRef: null,
  };
}

export interface ZernioSendResult {
  success: boolean;
  status: number;
  messageId?: string;
  error?: string;
}

/**
 * Send the agent's reply back to the lead.
 *
 * `idempotencyKey` should be derived from the inbound event, so a retry of the
 * same inbound can never produce a second outbound: Zernio replays the original
 * response for a repeated key + identical body rather than sending again. Keys
 * are retained 24 hours.
 */
export async function sendZernioReply(input: {
  conversationId: string;
  accountId: string;
  text: string;
  idempotencyKey?: string;
}): Promise<ZernioSendResult> {
  if (!isZernioDmConfigured()) {
    return { success: false, status: 0, error: "ZERNIO_DM_API_KEY is not set" };
  }
  const text = input.text?.trim();
  if (!text) return { success: false, status: 0, error: "Empty reply, nothing sent" };

  try {
    const r = await zernioFetch(
      `/inbox/conversations/${encodeURIComponent(input.conversationId)}/messages`,
      {
        method: "POST",
        headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {},
        body: JSON.stringify({ accountId: input.accountId, message: text }),
      },
    );
    if (!r.ok) {
      /* Surfaced, not swallowed. The likeliest real-world failure is TikTok's
         48-hour / 10-message reply window having closed, and that must read as
         "TikTok refused" in the log rather than as a silent no-reply. */
      return {
        success: false,
        status: r.status,
        error: r.text.slice(0, 400) || `HTTP ${r.status}`,
      };
    }
    const sent = (r.json ?? {}) as { message?: { id?: unknown }; id?: unknown };
    return {
      success: true,
      status: r.status,
      messageId: str(sent.message?.id) ?? str(sent.id) ?? undefined,
    };
  } catch (err) {
    return {
      success: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Connected accounts — used by the status endpoint to prove the key works. */
export async function zernioAccounts(): Promise<{
  ok: boolean;
  status: number;
  accounts: { id: string; platform: string; username: string | null; active: boolean }[];
  error?: string;
}> {
  if (!isZernioDmConfigured()) {
    return { ok: false, status: 0, accounts: [], error: "ZERNIO_DM_API_KEY is not set" };
  }
  try {
    const r = await zernioFetch("/accounts", { method: "GET" });
    if (!r.ok) {
      return { ok: false, status: r.status, accounts: [], error: r.text.slice(0, 300) };
    }
    const payload = r.json as { accounts?: Record<string, unknown>[] } | null;
    const list = Array.isArray(payload?.accounts) ? payload.accounts : [];
    return {
      ok: true,
      status: r.status,
      accounts: list.map((a) => ({
        id: String(a._id ?? ""),
        platform: String(a.platform ?? ""),
        username: str(a.username),
        active: a.isActive !== false && a.needsReconnection !== true,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      accounts: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
