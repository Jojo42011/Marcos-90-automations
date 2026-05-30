/**
 * Sendblue — outbound iMessage/SMS and inbound webhook helpers.
 * @see https://docs.sendblue.com/api-v2
 *
 * Env:
 * - SENDBLUE_API_KEY_ID
 * - SENDBLUE_API_SECRET_KEY
 * - SENDBLUE_FROM_NUMBER (E.164, e.g. +18184588632)
 * - SENDBLUE_WEBHOOK_SECRET (optional; must match Sendblue dashboard Global Secret / per-webhook secret, header sb-signing-secret)
 */
import axios from "axios";

const SENDBLUE_BASE = "https://api.sendblue.com";

const processedInboundHandles = new Map<string, number>();
const MAX_HANDLE_CACHE = 4000;

function rememberHandle(handle: string): boolean {
  if (!handle) return true;
  if (processedInboundHandles.has(handle)) return false;
  processedInboundHandles.set(handle, Date.now());
  if (processedInboundHandles.size > MAX_HANDLE_CACHE) {
    const cutoff = Date.now() - 48 * 3600000;
    for (const [h, t] of processedInboundHandles) {
      if (t < cutoff) processedInboundHandles.delete(h);
    }
  }
  return true;
}

export function isSendblueConfigured(): boolean {
  return Boolean(
    process.env.SENDBLUE_API_KEY_ID?.trim() &&
      process.env.SENDBLUE_API_SECRET_KEY?.trim() &&
      process.env.SENDBLUE_FROM_NUMBER?.trim(),
  );
}

/** US E.164 for Sendblue `number` / `from_number`. */
export function normalizeToUsE164(input: string): string {
  const t = input.trim();
  if (t.startsWith("+")) {
    const d = t.replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    if (d.length === 10) return `+1${d}`;
    return t;
  }
  const d = t.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return t.startsWith("+") ? t : `+${d}`;
}

function sendblueHeaders(): Record<string, string> {
  const id = process.env.SENDBLUE_API_KEY_ID?.trim() ?? "";
  const secret = process.env.SENDBLUE_API_SECRET_KEY?.trim() ?? "";
  return {
    "sb-api-key-id": id,
    "sb-api-secret-key": secret,
    "Content-Type": "application/json",
  };
}

export type SendblueSendResult = { ok: boolean; error?: string; data?: unknown };

export async function sendSendblueMessage(params: { to: string; content: string }): Promise<SendblueSendResult> {
  if (!isSendblueConfigured()) {
    return { ok: false, error: "Sendblue is not configured (missing SENDBLUE_* env vars)." };
  }
  const number = normalizeToUsE164(params.to);
  const from_number = normalizeToUsE164(process.env.SENDBLUE_FROM_NUMBER!.trim());
  const content = params.content.trim();
  if (!content) {
    return { ok: false, error: "Message content is empty." };
  }
  try {
    const res = await axios.post(
      `${SENDBLUE_BASE}/api/send-message`,
      { number, from_number, content },
      { headers: sendblueHeaders(), timeout: 45000, validateStatus: () => true },
    );
    if (res.status >= 200 && res.status < 300 && res.data?.status !== "ERROR") {
      return { ok: true, data: res.data };
    }
    const msg =
      typeof res.data?.message === "string"
        ? res.data.message
        : `HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`;
    return { ok: false, error: msg };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, error: err };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** True if this POST should drive the Marco pipeline (inbound user text). */
export function shouldProcessSendblueInbound(body: Record<string, unknown>): boolean {
  if (body.is_outbound === true) return false;
  const status = typeof body.status === "string" ? body.status.toUpperCase() : "";
  if (status && status !== "RECEIVED") return false;
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return false;
  const mt = typeof body.message_type === "string" ? body.message_type : "message";
  if (mt && mt !== "message") return false;
  return true;
}

export function getSendblueInboundFromNumber(body: Record<string, unknown>): string | null {
  const raw =
    (typeof body.from_number === "string" && body.from_number.trim()) ||
    (typeof body.number === "string" && body.number.trim()) ||
    "";
  return raw || null;
}

export function getSendblueMessageHandle(body: Record<string, unknown>): string | null {
  const h = body.message_handle ?? body.messageHandle;
  return typeof h === "string" && h.trim() ? h.trim() : null;
}

export function sendblueWebhookSecretMatches(presented: string | undefined | null): boolean {
  const expected = process.env.SENDBLUE_WEBHOOK_SECRET?.trim();
  if (!expected) return true;
  return Boolean(presented && presented.trim() === expected);
}

export function parseSendblueWebhookBody(body: unknown): Record<string, unknown> | null {
  if (!isPlainObject(body)) return null;
  return body;
}

/** Idempotent: returns false if this message_handle was already processed. */
export function claimSendblueInboundHandle(handle: string | null): boolean {
  if (!handle) return true;
  return rememberHandle(handle);
}
