/**
 * Quo — Marco's business phone line (SMS + calls).
 *
 * Base URL https://api.quo.com. Authentication is the API key sent RAW in the
 * Authorization header: `Authorization: <key>`, with no "Bearer " prefix.
 * Quo's own docs call this out explicitly, and sending Bearer fails with 401.
 *
 * WHAT THE ACCOUNT ACTUALLY LOOKS LIKE (measured against the live workspace
 * before any of this was written, because it changes the design):
 *   - one number, "Primary" +1 737 283 4703 (PNo1mCxawI)
 *   - 286 conversations, and the LARGE majority are calls, not texts
 * That last point is the important one. `GET /v1/conversations` returns call
 * threads and message threads in one list with nothing on the row to tell them
 * apart, so the only way to know a thread has texts is to ask for its messages
 * and see. A sync that assumed "conversation = text thread" would fill the CRM
 * with hundreds of empty call logs pretending to be SMS.
 *
 * The other shape that dictates the code: `GET /v1/messages` REQUIRES both
 * `phoneNumberId` and `participants`. There is no "give me the inbox" call, so
 * a full sync is necessarily conversations-first, then messages per thread.
 * Arrays go on the query string as a repeated single-valued key
 * (`participants=%2B1210...`) — `participants[]=` is rejected as "Expected
 * array", which is a confusing error for the syntax that usually means array.
 */

import { createHash } from "crypto";

/* Overridable only so the verification suite can point the client at a stub
   that returns real 429s — the retry path is the whole reason this file has
   a rate limiter, and it cannot be proven against the live API without
   deliberately abusing Marco's account. */
const BASE = process.env.QUO_API_BASE?.trim().replace(/\/+$/, "") || "https://api.quo.com";

export interface QuoPhoneNumber {
  id: string;
  name: string | null;
  number: string;
  formattedNumber: string | null;
  users?: Array<{ id: string; email: string; firstName: string | null; lastName: string | null; role: string }>;
}

export interface QuoConversation {
  id: string;
  name: string | null;
  participants: string[];
  phoneNumberId: string;
  assignedTo?: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  lastActivityId: string | null;
}

export interface QuoMessage {
  id: string;
  to: string[];
  from: string;
  text: string | null;
  phoneNumberId: string;
  conversationId: string;
  direction: "incoming" | "outgoing";
  userId?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function getQuoApiKey(): string | null {
  return process.env.QUO_API_KEY?.trim() || null;
}

export function isQuoConfigured(): boolean {
  return Boolean(getQuoApiKey());
}

/** The number texts are sent from. Discovered from the API when not pinned. */
export function getQuoPhoneNumberId(): string | null {
  return process.env.QUO_PHONE_NUMBER_ID?.trim() || null;
}

export function getQuoPhoneNumber(): string | null {
  return process.env.QUO_PHONE_NUMBER?.trim() || null;
}

export class QuoError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "QuoError";
  }
}

/**
 * Rate limiting. Quo advertises its policy on every response:
 *
 *   ratelimit-policy: "per-second"; q=10; w=1
 *   ratelimit:        "per-second"; r=6; t=1
 *
 * i.e. TEN requests per second, with `r` remaining and `t` seconds until the
 * window resets. This matters more here than it would elsewhere: a full sync
 * is one request per conversation over ~286 conversations, so the limit is not
 * a corner case, it is the normal path. The first production sync stored only
 * 8 of 16 threads because half the reads came back 429 and were swallowed.
 *
 * Two defences, because either alone is not enough: pace requests to stay
 * under the quota, and retry the ones that get refused anyway.
 */
const RATE_PER_SEC = 8;                 // under the advertised 10, leaving headroom
const MIN_INTERVAL_MS = Math.ceil(1000 / RATE_PER_SEC);
/** When the next request may be dispatched. */
let nextSlotAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Block until it is this request's turn.
 *
 * Requests are SPACED, not merely counted. A counting window — even a sliding
 * one — lets the whole quota leave in a single burst, and the gap between
 * taking a slot and the request actually landing is not constant: a cold
 * socket costs ~75ms, a warm one ~5ms. Measured against a stub, a limiter
 * "capped at 8/sec" delivered 16 in one second purely from that jitter. Fixed
 * spacing removes the burst, so what the server sees matches what we intended.
 *
 * The reservation is taken synchronously before any await, so concurrent
 * callers each get their own slot rather than racing for the same one.
 */
async function takeRateSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + MIN_INTERVAL_MS;
  if (at > now) await sleep(at - now);
}

/** Hold every pending request back — a 429 is about the account, not one call. */
function backOffAll(ms: number): void {
  nextSlotAt = Math.max(nextSlotAt, Date.now() + ms);
}

/** Seconds to wait after a 429, from Quo's own headers where it says so. */
function retryDelayMs(res: Response, attempt: number): number {
  const after = Number(res.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(10000, after * 1000);
  const m = /t=(\d+)/.exec(res.headers.get("ratelimit") || "");
  if (m) return Math.min(10000, (Number(m[1]) + 1) * 1000);
  return Math.min(8000, 400 * 2 ** attempt);       // exponential fallback
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; attempts?: number } = {},
): Promise<T> {
  const key = getQuoApiKey();
  if (!key) throw new QuoError("QUO_API_KEY is not set", 0);
  const maxAttempts = init.attempts ?? 4;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await takeRateSlot();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 25000);
    try {
      const res = await fetch(BASE + path, {
        method: init.method || "GET",
        headers: {
          /* Raw key, NOT "Bearer <key>" — Quo rejects the bearer form. */
          Authorization: key,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: ctrl.signal,
      });

      /* Throttled or a server wobble — worth asking again. A 4xx that is not
         429 is our mistake and will fail identically on a retry, so it is
         raised immediately. */
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts - 1) {
        const wait = retryDelayMs(res, attempt);
        await res.text().catch(() => "");
        if (res.status === 429) backOffAll(wait);
        await sleep(wait);
        continue;
      }

      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text.slice(0, 400) };
      }
      if (!res.ok) {
        const msg =
          (parsed && typeof parsed === "object" && "message" in parsed
            ? String((parsed as { message: unknown }).message)
            : "") || `HTTP ${res.status}`;
        throw new QuoError(`Quo ${init.method || "GET"} ${path} failed: ${msg}`, res.status, parsed);
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof QuoError) throw err;
      lastErr = err;
      /* A timeout or a dropped socket: retry, unless that was the last go. */
      if (attempt < maxAttempts - 1) { await sleep(Math.min(8000, 400 * 2 ** attempt)); continue; }
    } finally {
      clearTimeout(timer);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "rate limited");
  throw new QuoError(`Quo ${init.method || "GET"} ${path} failed after ${maxAttempts} attempts: ${msg}`, 0);
}

export async function listPhoneNumbers(): Promise<QuoPhoneNumber[]> {
  const res = await call<{ data: QuoPhoneNumber[] }>("/v1/phone-numbers");
  return res.data || [];
}

/** All conversations, following pagination. Calls AND texts — see the header. */
export async function listConversations(opts: { maxPages?: number; updatedAfter?: string } = {}): Promise<QuoConversation[]> {
  const out: QuoConversation[] = [];
  let token: string | null = null;
  const maxPages = opts.maxPages ?? 20;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ maxResults: "100" });
    if (token) params.set("pageToken", token);
    if (opts.updatedAfter) params.set("updatedAfter", opts.updatedAfter);
    const res: { data: QuoConversation[]; nextPageToken: string | null } = await call(
      `/v1/conversations?${params.toString()}`,
    );
    out.push(...(res.data || []));
    token = res.nextPageToken || null;
    if (!token) break;
  }
  return out;
}

/**
 * Messages exchanged with `participants` on `phoneNumberId`.
 *
 * `participants` is serialised as a repeated single key. URLSearchParams'
 * append does exactly that, and it is the only form the API accepts.
 */
export async function listMessages(input: {
  phoneNumberId: string;
  participants: string[];
  maxResults?: number;
  createdAfter?: string;
  maxPages?: number;
}): Promise<QuoMessage[]> {
  const out: QuoMessage[] = [];
  let token: string | null = null;
  const maxPages = input.maxPages ?? 5;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams();
    params.set("phoneNumberId", input.phoneNumberId);
    for (const p of input.participants) params.append("participants", p);
    params.set("maxResults", String(Math.min(100, Math.max(1, input.maxResults ?? 100))));
    if (input.createdAfter) params.set("createdAfter", input.createdAfter);
    if (token) params.set("pageToken", token);
    const res: { data: QuoMessage[]; nextPageToken: string | null } = await call(
      `/v1/messages?${params.toString()}`,
    );
    out.push(...(res.data || []));
    token = res.nextPageToken || null;
    if (!token) break;
  }
  return out;
}

/**
 * Send a text. Resolves only on Quo's 202 accept; anything else throws with
 * Quo's own words, because "message sent" must never be reported on a guess.
 *
 * A2P: an unregistered/unapproved brand returns 400 with an A2P message. That
 * is a carrier-registration problem on the Quo account, not something this
 * code can retry around, so it is surfaced verbatim.
 */
export async function sendText(input: {
  to: string;
  content: string;
  from?: string;
  userId?: string;
}): Promise<QuoMessage> {
  const from = input.from || getQuoPhoneNumberId() || getQuoPhoneNumber();
  if (!from) throw new QuoError("No Quo sending number configured (QUO_PHONE_NUMBER_ID)", 0);
  const content = String(input.content || "").trim();
  if (!content) throw new QuoError("Message text is required", 0);
  if (content.length > 1600) throw new QuoError("Quo caps a message at 1600 characters", 0);
  const to = String(input.to || "").trim();
  if (!/^\+[1-9]\d{1,14}$/.test(to)) {
    throw new QuoError(`Recipient must be E.164 (e.g. +12105550123), got "${to}"`, 0);
  }
  const res = await call<{ data: QuoMessage }>("/v1/messages", {
    method: "POST",
    body: { content, from, to: [to], ...(input.userId ? { userId: input.userId } : {}) },
  });
  return res.data;
}

export interface QuoWebhook {
  id: string;
  url: string;
  events?: string[];
  status?: string;
  label?: string | null;
  createdAt?: string;
}

export async function listWebhooks(): Promise<QuoWebhook[]> {
  const res = await call<{ data: QuoWebhook[] }>("/v1/webhooks");
  return res.data || [];
}

/**
 * Point Quo at our inbound endpoint. Idempotent: an existing webhook on the
 * same URL is left alone rather than duplicated, because Quo will happily
 * register the same URL twice and then deliver everything twice.
 *
 * The only valid events are `message.received` and `message.delivered` — the
 * API rejects anything else, which is how that list was established.
 */
export async function ensureMessageWebhook(url: string): Promise<{ created: boolean; webhook: QuoWebhook }> {
  const existing = await listWebhooks();
  const match = existing.find((w) => w.url === url);
  if (match) return { created: false, webhook: match };
  const res = await call<{ data: QuoWebhook }>("/v1/webhooks/messages", {
    method: "POST",
    body: { url, events: ["message.received", "message.delivered"] },
  });
  return { created: true, webhook: res.data };
}

/** Verify the key and report the line it belongs to, without sending anything. */
export async function checkQuo(): Promise<{ ok: boolean; error?: string; numbers?: QuoPhoneNumber[] }> {
  if (!isQuoConfigured()) return { ok: false, error: "QUO_API_KEY is not set" };
  try {
    const numbers = await listPhoneNumbers();
    return { ok: true, numbers };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Shared secret for the inbound webhook, carried as `?key=` on the URL we
 * register with Quo.
 *
 * Quo's webhook create call takes only a URL and an event list — it offers no
 * signing secret — so an unguarded endpoint would let anyone who guessed the
 * path post fabricated texts into the CRM. Deriving the guard from the API key
 * means there is no second secret to provision or rotate, and it changes
 * automatically if the key is ever replaced.
 */
export function quoWebhookSecret(): string | null {
  const key = getQuoApiKey();
  if (!key) return null;
  return createHash("sha256").update("quo-webhook:" + key).digest("hex").slice(0, 24);
}

/** Digits-only comparison key, so +1 (210) 555-0123 and 2105550123 match. */
export function phoneKey(raw: string | null | undefined): string {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Best-effort E.164 for a US 10-digit number typed by a human. */
export function toE164(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim();
  if (/^\+[1-9]\d{1,14}$/.test(s)) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}
