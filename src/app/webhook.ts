/**
 * ManyChat (and future) webhook handler. Parse body, call pipeline, return 200 JSON { reply }.
 *
 * Instagram DMs arrive via POST /webhook (ManyChat External Request) with flat JSON:
 *   { "platform": "instagram", "user_id": "...", "message": "...", "comment_or_dm": "dm" }
 * NOT via Meta Graph API entry[0].messaging (optional fallback parser included).
 *
 * Instagram comment automation (first touch, no comment text in ManyChat):
 * omit `message` from the JSON body. Send e.g.
 *   { "platform": "instagram", "user_id": "<IG username>", "username": "<full name>", "comment_or_dm": "comment" }
 */
import { run as runPipeline } from "./pipeline.js";
import type { IncomingWebhookPayload } from "../core/types.js";
import { isDuplicateHandle } from "./conversationUtils.js";
import {
  marcoCorrelationId,
  marcoLog,
  marcoLogDebug,
  newMarcoRequestId,
  previewText,
  type MarcoLogContext,
} from "./marcoLog.js";

const IG_DEBOUNCE_MS = 4000;

interface IgWaiter {
  resolve: (result: { status: number; reply?: string }) => void;
  reject: (err: unknown) => void;
}

interface IgQueueEntry {
  timer: ReturnType<typeof setTimeout> | null;
  messages: string[];
  payloadTemplate: IncomingWebhookPayload;
  log: MarcoLogContext;
  waiters: IgWaiter[];
}

/** Prevent overlapping pipeline runs for the same lead. */
const processingLeads = new Set<string>();

function leadProcessingKey(platform: string, userId: string): string {
  return `${platform}:${userId}`;
}

function extractMessageHandle(rawBody: unknown): string | null {
  if (!rawBody || typeof rawBody !== "object") return null;
  const b = normalizeWebhookRecord(rawBody as Record<string, unknown>);
  const keys = [
    "message_handle",
    "messageHandle",
    "message_id",
    "messageId",
    "mid",
    "ig_mid",
    "igMid",
    "last_message_id",
    "lastMessageId",
  ];
  for (const k of keys) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Instagram-only burst queue — module level so it persists across requests. */
const igMessageQueue: Record<string, IgQueueEntry> = {};

/** Prevent overlapping batch processing for the same sender. */
const igProcessingSenders = new Set<string>();

function isInstagramPlatform(platform: string): boolean {
  return platform.toLowerCase().includes("insta");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * TEMP DIAGNOSTIC — remove after ManyChat image-URL capture test.
 * Set DEBUG_RAW_WEBHOOK=true to log the full inbound JSON for Instagram DMs only.
 * TODO(cleanup): delete logRawWebhookPayloadForDiagnostic + call site once payload is captured.
 */
function logRawWebhookPayloadForDiagnostic(body: unknown): void {
  if (process.env.DEBUG_RAW_WEBHOOK?.trim().toLowerCase() !== "true") return;
  if (!isPlainObject(body)) return;

  const platform = String(body.platform ?? "").toLowerCase();
  const commentOrDm = body.comment_or_dm ?? body.commentOrDm;
  const isInstagramDm =
    platform.includes("insta") && commentOrDm !== "comment" && commentOrDm !== "Comment";

  if (!isInstagramDm) return;

  console.log("[DIAGNOSTIC-RAW-PAYLOAD]", JSON.stringify(body));
}

/**
 * Meta Graph API Instagram DM shape (if ever wired directly):
 * entry[0].messaging[0].sender.id / .message.text / .message.is_echo
 */
function tryParseMetaInstagramDm(
  body: Record<string, unknown>,
): { senderId: string; text: string; isEcho: boolean } | null {
  const entry = body.entry;
  if (!Array.isArray(entry) || !isPlainObject(entry[0])) return null;
  const messaging = (entry[0] as Record<string, unknown>).messaging;
  if (!Array.isArray(messaging) || !isPlainObject(messaging[0])) return null;
  const m = messaging[0] as Record<string, unknown>;
  const sender = m.sender;
  const message = m.message;
  if (!isPlainObject(sender) || !isPlainObject(message)) return null;
  const senderId = sender.id;
  if (senderId === undefined || senderId === null) return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  return {
    senderId: String(senderId),
    text,
    isEcho: message.is_echo === true,
  };
}

/**
 * Stable Instagram sender key for the queue.
 * Prefer ManyChat subscriber_id (numeric) over username so every tap hits the same queue.
 */
function extractInstagramSenderId(
  rawBody: unknown,
  parsed: IncomingWebhookPayload,
): string {
  if (rawBody && typeof rawBody === "object") {
    const meta = tryParseMetaInstagramDm(rawBody as Record<string, unknown>);
    if (meta?.senderId) return meta.senderId;
  }

  const b = normalizeWebhookRecord(
    rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {},
  );

  const stableKeys = [
    "subscriber_id",
    "subscriberId",
    "contact_id",
    "contactId",
  ];
  for (const k of stableKeys) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }

  if (isPlainObject(b.subscriber)) {
    const sid = b.subscriber.id ?? b.subscriber.subscriber_id ?? b.subscriber.subscriberId;
    if (typeof sid === "string" && sid.trim()) return sid.trim();
    if (typeof sid === "number" && Number.isFinite(sid)) return String(sid);
  }
  if (isPlainObject(b.contact)) {
    const cid = b.contact.id ?? b.contact.contact_id;
    if (typeof cid === "string" && cid.trim()) return cid.trim();
    if (typeof cid === "number" && Number.isFinite(cid)) return String(cid);
  }

  return parsed.userId;
}

function extractInstagramMessageText(
  rawBody: unknown,
  parsed: IncomingWebhookPayload,
): string {
  if (rawBody && typeof rawBody === "object") {
    const meta = tryParseMetaInstagramDm(rawBody as Record<string, unknown>);
    if (meta) return meta.text;
  }
  return parsed.message.trim();
}

function isInstagramEcho(rawBody: unknown): boolean {
  if (!rawBody || typeof rawBody !== "object") return false;
  const body = rawBody as Record<string, unknown>;
  const meta = tryParseMetaInstagramDm(body);
  if (meta?.isEcho) return true;
  if (body.is_echo === true || body.isEcho === true) return true;
  if (body.message_echo === true || body.messageEcho === true) return true;
  return false;
}

/**
 * Flush Instagram DM batch: one pipeline run; last waiter gets reply, earlier waiters get none.
 */
async function flushInstagramDm(senderId: string): Promise<void> {
  const entry = igMessageQueue[senderId];
  if (!entry) return;

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  delete igMessageQueue[senderId];

  const combinedInput = entry.messages.join(" ");
  const payloadTemplate = entry.payloadTemplate;
  const batchLog = entry.log;
  const waiters = entry.waiters;
  const lastWaiter = waiters[waiters.length - 1];

  if (waiters.length > 1) {
    console.log(`[ig] Batching ${waiters.length} webhooks for ${senderId}`);
  }

  console.log(`Processing for ${senderId}: "${combinedInput}"`);

  if (igProcessingSenders.has(senderId)) {
    console.log(`[ig] Skipping duplicate batch for ${senderId} — already processing`);
    for (const w of waiters) {
      w.resolve({ status: 200, reply: undefined });
    }
    return;
  }

  const leadLockKey = leadProcessingKey(payloadTemplate.platform, payloadTemplate.userId);
  if (processingLeads.has(leadLockKey)) {
    console.log(`[webhook] Lead ${leadLockKey} already processing — dropping duplicate IG batch`);
    for (const w of waiters) {
      w.resolve({ status: 200, reply: undefined });
    }
    return;
  }

  igProcessingSenders.add(senderId);
  processingLeads.add(leadLockKey);
  try {
    const payload: IncomingWebhookPayload = {
      ...payloadTemplate,
      message: combinedInput,
    };
    const start = Date.now();
    const { reply } = await runPipeline(payload, batchLog);
    const elapsed = Date.now() - start;
    marcoLog("request_complete", {
      requestId: batchLog.requestId,
      correlationId: batchLog.correlationId,
      pipeline_ms: elapsed,
      total_ms: elapsed,
      debounced: true,
      ig_sender_id: senderId,
      reply_chars: reply?.length ?? 0,
      reply_preview: previewText(reply),
    });
    if (reply) {
      console.log(
        `[ig] One reply for ${senderId} (${reply.length} chars): ${previewText(reply, 120)}`,
      );
    }

    const result: { status: number; reply?: string } = {
      status: 200,
      reply: reply ?? undefined,
    };
    for (const w of waiters) {
      if (w === lastWaiter) {
        w.resolve(result);
      } else {
        w.resolve({ status: 200, reply: undefined });
      }
    }
  } catch (err) {
    console.error(`[ig] Batch processing failed for ${senderId}:`, err);
    for (const w of waiters) {
      w.reject(err);
    }
  } finally {
    igProcessingSenders.delete(senderId);
    processingLeads.delete(leadLockKey);
  }
}

/**
 * Instagram DM hybrid debounce: holds HTTP open until timer + pipeline complete.
 * Only the last webhook in a burst receives `reply`; earlier ones get reply undefined.
 */
function enqueueInstagramDm(
  senderId: string,
  messageText: string,
  payload: IncomingWebhookPayload,
  log: MarcoLogContext,
): Promise<{ status: number; reply?: string }> {
  return new Promise((resolve, reject) => {
    if (!igMessageQueue[senderId]) {
      igMessageQueue[senderId] = {
        timer: null,
        messages: [],
        payloadTemplate: payload,
        log,
        waiters: [],
      };
    }

    const userQueue = igMessageQueue[senderId];
    userQueue.payloadTemplate = payload;
    userQueue.log = log;
    userQueue.waiters.push({ resolve, reject });

    if (messageText) {
      if (!userQueue.messages.includes(messageText)) {
        userQueue.messages.push(messageText);
        console.log(
          `Queued for ${senderId}: "${messageText}" - queue size: ${userQueue.messages.length}`,
        );
      } else {
        console.log(`Duplicate ignored for ${senderId}: "${messageText}"`);
      }
    }

    if (userQueue.timer) {
      clearTimeout(userQueue.timer);
      console.log(`Timer reset for ${senderId}`);
    }

    userQueue.timer = setTimeout(() => {
      void flushInstagramDm(senderId);
    }, IG_DEBOUNCE_MS);
  });
}

/**
 * ManyChat / Make / custom proxies often nest fields or use different names than our web demo.
 */
/**
 * A value ManyChat sent as a literal merge field instead of substituting it.
 *
 * When a flow references a variable the subscriber has no value for (or the
 * field name is wrong), ManyChat posts the token verbatim: `{{full_name}}`,
 * `{{ig_username}}`, `{{tt_username}}`. Nothing downstream checked, so the
 * token became the person's identity. 45 leads in production carry one, and
 * once lead scoring started working, one of them ranked FIRST on the call list
 * as a lead nobody could name or phone.
 *
 * Matches a token anywhere in the value, not just a whole-string match, since
 * "Hi {{first_name}}" is equally unusable as a name.
 */
function isUnsubstitutedMergeField(v: unknown): boolean {
  return typeof v === "string" && /\{\{[^{}]*\}\}/.test(v);
}

/**
 * Fields where a merge token makes the value worthless and it is safer to have
 * nothing. Deliberately EXCLUDES the message body: a DM that happens to contain
 * a token is still a real message from a real person, and dropping it would
 * lose the conversation to fix a cosmetic problem.
 */
const IDENTITY_KEYS = [
  "user_id", "userId", "subscriber_id", "subscriberId", "contact_id", "contactId",
  "username", "user_name", "handle", "ig_username", "tt_username", "tiktok_username",
  "instagram_username", "instagram_handle",
  "full_name", "fullName", "display_name", "displayName", "name",
  "phone", "phone_number", "phoneNumber", "email",
];

function normalizeWebhookRecord(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };

  const mergeKeys = [
    "user_id",
    "userId",
    "subscriber_id",
    "subscriberId",
    "message",
    "last_input_text",
    "last_input",
    "text",
    "body",
    "message_text",
    "input",
    "username",
    "user_name",
    "full_name",
    "fullName",
    "display_name",
    "displayName",
    "name",
    "instagram_username",
    "instagram_handle",
    "platform",
    "comment_or_dm",
    "marco_previous_outbound",
    "marcoPreviousOutbound",
    "marco_last_outbound",
    "marcoLastOutbound",
    "manual_marco_opener",
    "manualMarcoOpener",
  ];

  const mergeFrom = (inner: unknown, mapInnerIdToUserId: boolean) => {
    if (!isPlainObject(inner)) return;
    for (const k of mergeKeys) {
      const v = inner[k];
      const cur = out[k];
      const empty = cur === undefined || cur === null || cur === "";
      /* A placeholder must never win an empty slot: it would look like data and
         then be preferred over the real value on a later merge pass. */
      if (empty && v != null && v !== "" && !isUnsubstitutedMergeField(v)) {
        out[k] = v;
      }
    }
    if (mapInnerIdToUserId) {
      const curUid = out.user_id ?? out.userId;
      const emptyUid = curUid === undefined || curUid === null || curUid === "";
      if (emptyUid) {
        const sid = inner.id ?? inner.subscriber_id ?? inner.subscriberId;
        if (typeof sid === "string" && sid.trim() && !isUnsubstitutedMergeField(sid)) {
          out.user_id = sid.trim();
        } else if (typeof sid === "number" && Number.isFinite(sid)) {
          out.user_id = String(sid);
        }
      }
    }
  };

  mergeFrom(body.data, false);
  mergeFrom(body.contact, true);
  mergeFrom(body.subscriber, true);

  /* Top-level values never went through mergeFrom, so scrub here as well. This
     is the single choke point every pick* helper reads from, which is why the
     guard lives here rather than in each of them: five pickers each doing their
     own validation is five chances to add a sixth that forgets. */
  const dropped: string[] = [];
  for (const k of IDENTITY_KEYS) {
    if (isUnsubstitutedMergeField(out[k])) {
      dropped.push(`${k}=${String(out[k])}`);
      delete out[k];
    }
  }
  if (dropped.length) {
    console.warn(
      "[webhook] ManyChat sent unsubstituted merge field(s), dropped:",
      dropped.join(", "),
      "— check the flow's External Request body maps real subscriber fields.",
    );
  }
  if (isUnsubstitutedMergeField(out.message)) {
    console.warn("[webhook] message text contains a merge token; kept, but the flow is misconfigured.");
  }

  return out;
}

function pickUserId(b: Record<string, unknown>): string {
  const keys = ["user_id", "userId", "subscriber_id", "subscriberId", "contact_id", "contactId"];
  for (const k of keys) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function pickMarcoPreviousOutbound(b: Record<string, unknown>): string | null {
  const keys = [
    "marco_previous_outbound",
    "marcoPreviousOutbound",
    "marco_last_outbound",
    "marcoLastOutbound",
    "manual_marco_opener",
    "manualMarcoOpener",
  ];
  for (const k of keys) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickMessage(b: Record<string, unknown>): string {
  const keys = [
    "message",
    "last_input_text",
    "last_input",
    "text",
    "body",
    "message_text",
    "input",
    "user_message",
    "content",
  ];
  for (const k of keys) {
    const v = b[k];
    if (typeof v === "string") return v.trim();
  }
  return "";
}

function pickUsername(b: Record<string, unknown>): string | null {
  const keys = ["username", "user_name", "handle", "ig_username", "instagram_username", "name"];
  for (const k of keys) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickExplicitDisplayName(b: Record<string, unknown>): string | null {
  const keys = ["full_name", "fullName", "display_name", "displayName", "name"];
  for (const k of keys) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function looksLikePersonFullName(s: string): boolean {
  const t = s.trim();
  return t.length > 1 && /\s/.test(t) && /[a-zA-Z]/.test(t);
}

function resolveHandleAndDisplayName(
  b: Record<string, unknown>,
  userId: string,
): { handle: string; displayName: string | null } {
  const explicit = pickExplicitDisplayName(b);
  if (explicit && explicit.trim() !== userId.trim()) {
    return { handle: userId, displayName: explicit };
  }
  const raw = typeof b.username === "string" ? b.username.trim() : "";
  if (raw && raw !== userId && looksLikePersonFullName(raw)) {
    return { handle: userId, displayName: raw };
  }
  const legacy = pickUsername(b);
  if (legacy && legacy === userId) {
    return { handle: userId, displayName: null };
  }
  if (legacy && legacy !== userId && !looksLikePersonFullName(legacy)) {
    return { handle: legacy, displayName: null };
  }
  return { handle: userId, displayName: null };
}

function parseBody(body: unknown): IncomingWebhookPayload | null {
  if (!body || typeof body !== "object") return null;

  const meta = tryParseMetaInstagramDm(body as Record<string, unknown>);
  if (meta && !meta.isEcho) {
    return {
      platform: "instagram",
      userId: meta.senderId,
      username: null,
      displayName: null,
      message: meta.text,
      commentOrDm: "dm",
      marcoPreviousOutbound: null,
    };
  }

  const b = normalizeWebhookRecord(body as Record<string, unknown>);
  const platform = typeof b.platform === "string" ? b.platform : "instagram";
  const userId = pickUserId(b);
  const { handle, displayName } = resolveHandleAndDisplayName(b, userId);
  const message = pickMessage(b);
  const commentOrDm: "comment" | "dm" =
    b.comment_or_dm === "comment" || b.comment_or_dm === "Comment" ? "comment" : "dm";
  if (!userId) return null;

  if (!message.trim() && commentOrDm !== "comment") {
    console.warn(
      "[webhook] inbound message text is empty after parsing; check ManyChat JSON field names. Keys present:",
      Object.keys(b).slice(0, 40).join(", "),
    );
  }

  return {
    platform,
    userId,
    username: handle,
    displayName,
    message,
    commentOrDm,
    marcoPreviousOutbound: pickMarcoPreviousOutbound(b),
  };
}

/**
 * Direct pipeline entry — used by Twilio/Sinch SMS, TikTok, and Instagram comment handshakes.
 */
export async function handleIncomingPayload(
  payload: IncomingWebhookPayload,
  log?: MarcoLogContext,
): Promise<{ status: number; reply?: string }> {
  const requestId = log?.requestId ?? newMarcoRequestId();
  const correlationId = log?.correlationId ?? marcoCorrelationId(payload.platform, payload.userId);
  const ctx: MarcoLogContext = { requestId, correlationId };
  const lockKey = leadProcessingKey(payload.platform, payload.userId);

  if (processingLeads.has(lockKey)) {
    console.log(`[webhook] Lead ${lockKey} already processing — dropping duplicate request`);
    return { status: 200, reply: undefined };
  }

  processingLeads.add(lockKey);
  const start = Date.now();
  try {
    const { reply } = await runPipeline(payload, ctx);
    const elapsed = Date.now() - start;
    marcoLog("request_complete", {
      requestId,
      correlationId,
      pipeline_ms: elapsed,
      total_ms: elapsed,
      debounced: false,
      reply_chars: reply?.length ?? 0,
      reply_preview: previewText(reply),
    });
    return { status: 200, reply: reply ?? undefined };
  } finally {
    processingLeads.delete(lockKey);
  }
}

/**
 * POST /webhook and POST /simulate entry.
 * Instagram DMs: hybrid debounce — hold HTTP until 4s silence + pipeline; last waiter gets reply.
 * TikTok / other: synchronous pipeline (unchanged).
 */
export async function handleWebhook(body: unknown): Promise<{ status: number; reply?: string }> {
  logRawWebhookPayloadForDiagnostic(body);

  if (isInstagramEcho(body)) {
    console.log("[ig] Echo message ignored");
    return { status: 200 };
  }

  const messageHandle = extractMessageHandle(body);
  if (messageHandle && isDuplicateHandle(messageHandle)) {
    marcoLog("inbound_rejected", { reason: "duplicate_message_handle", message_handle: messageHandle });
    return { status: 200 };
  }

  const payload = parseBody(body);
  if (!payload) {
    /* A user_id that was a merge token has been scrubbed by now, so this also
       catches it — and rejecting is the right outcome. Every such message would
       otherwise key to the SAME lead, silently merging different people's
       conversations into one thread. Two production leads already have a token
       as their identity. Losing one message is recoverable; a merged thread is
       not, and a 400 tells ManyChat something is wrong instead of failing
       quietly. */
    const scrubbed = isUnsubstitutedMergeField(
      (body as Record<string, unknown> | null)?.user_id ??
        (body as Record<string, unknown> | null)?.userId,
    );
    marcoLog("inbound_rejected", {
      reason: scrubbed ? "unsubstituted_merge_field_user_id" : "parse_body_failed_or_missing_user_id",
    });
    if (scrubbed) {
      console.error(
        "[webhook] REJECTED: ManyChat sent an unsubstituted user_id merge field. " +
          "Fix the flow's External Request body — every message with this payload would collapse into one lead.",
      );
    }
    return { status: 400 };
  }

  const requestId = newMarcoRequestId();
  const correlationId = marcoCorrelationId(payload.platform, payload.userId);
  const log: MarcoLogContext = { requestId, correlationId };

  marcoLog("inbound_accepted", {
    requestId,
    correlationId,
    platform: payload.platform,
    comment_or_dm: payload.commentOrDm,
    message_chars: payload.message.length,
    message_preview: previewText(payload.message),
    username_set: Boolean(payload.username),
    display_name_set: Boolean(payload.displayName),
    marco_previous_outbound_set: Boolean(payload.marcoPreviousOutbound?.trim()),
  });

  const isIg = isInstagramPlatform(payload.platform) && payload.commentOrDm === "dm";

  if (isIg) {
    if (!payload.message.trim()) {
      return handleIncomingPayload(payload, log);
    }

    const senderId = extractInstagramSenderId(body, payload);
    const messageText = extractInstagramMessageText(body, payload);

    console.log(`[ig] Inbound from sender ${senderId} (lead key ${payload.userId})`);

    return await enqueueInstagramDm(senderId, messageText, payload, log);
  }

  if (!payload.message.trim()) {
    return handleIncomingPayload(payload, log);
  }

  return handleIncomingPayload(payload, log);
}

if (process.argv[1]?.endsWith("webhook.ts")) {
  handleWebhook({
    platform: "instagram",
    user_id: "test-user",
    username: "Test User",
    comment_or_dm: "comment",
  })
    .then((r) => console.log(r))
    .catch((e) => console.error(e));
}
