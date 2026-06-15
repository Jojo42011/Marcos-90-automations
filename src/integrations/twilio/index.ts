/**
 * Twilio — outbound SMS and inbound webhook helpers.
 *
 * Env:
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 * - TWILIO_FROM_NUMBER (E.164)
 * - TWILIO_WEBHOOK_AUTH_TOKEN (optional; defaults to TWILIO_AUTH_TOKEN for signature validation)
 */
import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
const fromNumber = process.env.TWILIO_FROM_NUMBER?.trim();

let client: twilio.Twilio | null = null;

const processedInboundSids = new Map<string, number>();
const MAX_SID_CACHE = 4000;

function rememberSid(sid: string): boolean {
  if (!sid) return true;
  if (processedInboundSids.has(sid)) return false;
  processedInboundSids.set(sid, Date.now());
  if (processedInboundSids.size > MAX_SID_CACHE) {
    const cutoff = Date.now() - 48 * 3600000;
    for (const [h, t] of processedInboundSids) {
      if (t < cutoff) processedInboundSids.delete(h);
    }
  }
  return true;
}

function getClient(): twilio.Twilio {
  if (!client) {
    if (!accountSid || !authToken) {
      throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured");
    }
    client = twilio(accountSid, authToken);
  }
  return client;
}

export function isTwilioConfigured(): boolean {
  return Boolean(accountSid && authToken && fromNumber);
}

/** US E.164 for Twilio `to` / `from`. */
export function normalizeToE164(phone: string): string {
  const t = phone.trim();
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

/** Alias matching legacy Sendblue helper name used across server routes. */
export function normalizeToUsE164(input: string): string {
  return normalizeToE164(input);
}

export interface SendSmsResult {
  success: boolean;
  messageSid?: string;
  error?: string;
}

type SendParams = { to: string; content: string };

function resolveSendArgs(
  toOrParams: string | SendParams,
  content?: string,
): { to: string; body: string } {
  if (typeof toOrParams === "string") {
    return { to: toOrParams, body: content ?? "" };
  }
  return { to: toOrParams.to, body: toOrParams.content };
}

/**
 * Send an SMS via Twilio REST API.
 * Accepts `(to, content)` or `{ to, content }` for drop-in compatibility.
 */
export async function sendTwilioMessage(
  toOrParams: string | SendParams,
  content?: string,
): Promise<SendSmsResult> {
  const { to, body } = resolveSendArgs(toOrParams, content);
  if (!isTwilioConfigured()) {
    console.warn("[Twilio] Not configured — skipping send to", to);
    return { success: false, error: "Twilio not configured" };
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return { success: false, error: "Message content is empty." };
  }

  try {
    const toE164 = normalizeToE164(to);
    const message = await getClient().messages.create({
      body: trimmed,
      from: fromNumber!,
      to: toE164,
    });

    console.log("[Twilio] Sent message", message.sid, "to", toE164);
    return { success: true, messageSid: message.sid };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Twilio] Send error:", msg);
    return { success: false, error: msg };
  }
}

/**
 * Validate an inbound Twilio webhook request signature.
 */
export function validateTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, unknown>,
): boolean {
  const token = process.env.TWILIO_WEBHOOK_AUTH_TOKEN?.trim() || authToken;
  if (!token) {
    console.warn("[Twilio] No webhook auth token configured — skipping signature validation (INSECURE)");
    return true;
  }
  return twilio.validateRequest(token, signature, url, params as Record<string, string>);
}

/** Idempotent: returns false if this MessageSid was already processed in-process. */
export function claimTwilioInboundSid(messageSid: string | null | undefined): boolean {
  if (!messageSid?.trim()) return true;
  return rememberSid(messageSid.trim());
}
