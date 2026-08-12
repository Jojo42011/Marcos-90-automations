/**
 * Gmail — send email as Marco, over SMTP app password or OAuth.
 *
 * TRANSPORT PRECEDENCE: SMTP wins when it is configured. The OAuth refresh
 * token has died twice (invalid_grant) because the consent screen sits in
 * "Testing", where Google expires refresh tokens weekly; an app password does
 * not expire on a timer. OAuth is kept as the fallback so nothing breaks for
 * an install that has not moved over, and because the inbox-reading side
 * (gmail/inbox.ts) still needs it — SMTP can only send.
 *
 * Token precedence: a refresh token stored in the email DB (linked through the
 * in-app "Reconnect Gmail" OAuth flow) wins over GMAIL_REFRESH_TOKEN from the
 * environment. The env token went stale once already (invalid_grant, June 22)
 * and rotating a Fly secret needs CLI access — the DB path lets Marco re-link
 * from the browser and survive deploys.
 */
import { kvGet, kvSet } from "../../core/emailStore.js";
import { isSmtpConfigured, sendViaSmtp } from "../smtp/index.js";

interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fromAddress?: string;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let cachedFromAddress: string | null = null;

const KV_REFRESH_TOKEN = "gmail_refresh_token";
const KV_LINKED_EMAIL = "gmail_linked_email";
const KV_LINKED_AT = "gmail_linked_at";
const KV_AUTH_ERROR = "gmail_auth_error";
const KV_AUTH_ERROR_AT = "gmail_auth_error_at";

function storedRefreshToken(): string | null {
  try {
    return kvGet(KV_REFRESH_TOKEN);
  } catch {
    return null;
  }
}

/** Persist a freshly minted refresh token (from the in-app OAuth relink). */
export function storeGmailRefreshToken(refreshToken: string, linkedEmail?: string): void {
  kvSet(KV_REFRESH_TOKEN, refreshToken);
  kvSet(KV_LINKED_AT, new Date().toISOString());
  if (linkedEmail) kvSet(KV_LINKED_EMAIL, linkedEmail);
  kvSet(KV_AUTH_ERROR, "");
  // Invalidate caches so the next call uses the new token immediately.
  cachedAccessToken = null;
  cachedFromAddress = linkedEmail || null;
}

export function recordGmailAuthError(message: string): void {
  try {
    kvSet(KV_AUTH_ERROR, message);
    kvSet(KV_AUTH_ERROR_AT, new Date().toISOString());
  } catch {
    /* bookkeeping only */
  }
}

export function getGmailAuthInfo(): {
  configured: boolean;
  tokenSource: "db" | "env" | "none";
  linkedEmail: string | null;
  linkedAt: string | null;
  authError: string | null;
  authErrorAt: string | null;
} {
  const db = storedRefreshToken();
  const env = process.env.GMAIL_REFRESH_TOKEN?.trim();
  return {
    configured: isGmailConfigured(),
    tokenSource: db ? "db" : env ? "env" : "none",
    linkedEmail: kvGet(KV_LINKED_EMAIL),
    linkedAt: kvGet(KV_LINKED_AT),
    authError: kvGet(KV_AUTH_ERROR) || null,
    authErrorAt: kvGet(KV_AUTH_ERROR_AT),
  };
}

/** OAuth specifically — the inbox reader needs this, SMTP cannot serve it. */
export function isGmailOAuthConfigured(): boolean {
  return Boolean(
    process.env.GMAIL_CLIENT_ID?.trim() &&
      process.env.GMAIL_CLIENT_SECRET?.trim() &&
      (storedRefreshToken() || process.env.GMAIL_REFRESH_TOKEN?.trim()),
  );
}

/** Can this system SEND mail by any route? */
export function isGmailConfigured(): boolean {
  return isSmtpConfigured() || isGmailOAuthConfigured();
}

/** Which transport a send would actually take right now. */
export function getEmailTransport(): "smtp" | "oauth" | "none" {
  if (isSmtpConfigured()) return "smtp";
  if (isGmailOAuthConfigured()) return "oauth";
  return "none";
}

/** Marco's inbox — for "email me" when Harvey doesn't infer an address. */
export function getMarcoEmail(): string | null {
  return (
    process.env.MARCO_EMAIL?.trim() ||
    process.env.GMAIL_FROM?.trim() ||
    process.env.GMAIL_USER?.trim() ||
    cachedFromAddress ||
    null
  );
}

/** OAuth-linked sender address (cached after first send or profile lookup). */
export async function getGmailSenderAddress(): Promise<string | null> {
  if (!isGmailConfigured()) return null;
  try {
    const cfg = getConfig();
    if (cfg.fromAddress) return cfg.fromAddress;
    const accessToken = await fetchAccessToken(cfg);
    return await resolveFromAddress(cfg, accessToken);
  } catch {
    return getMarcoEmail();
  }
}

/**
 * Actually exercise the refresh token and say whether Gmail can send.
 *
 * Exists because `getGmailSenderAddress()` is NOT a health check: it returns
 * `GMAIL_FROM`/`GMAIL_USER` (or a cached address) without ever calling Google,
 * and swallows failures. Anything built on it reports a healthy connection
 * while every send is bouncing — which is exactly what happened on
 * 2026-07-28, where the status endpoint said "verified" for a token Google
 * had been rejecting for hours.
 */
export async function checkGmailAuth(): Promise<{ ok: boolean; error?: string }> {
  if (!isGmailConfigured()) return { ok: false, error: "Gmail OAuth not configured" };
  try {
    await fetchAccessToken(getConfig());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function getConfig(): GmailConfig {
  const clientId = process.env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
  const refreshToken = storedRefreshToken() || process.env.GMAIL_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Gmail OAuth not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN",
    );
  }
  return {
    clientId,
    clientSecret,
    refreshToken,
    fromAddress: process.env.GMAIL_FROM?.trim() || process.env.GMAIL_USER?.trim(),
  };
}

async function fetchAccessToken(cfg: GmailConfig): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    // Report Google's error CODE alongside its description. The description
    // alone is often just "Bad Request", which says nothing about the cause —
    // the code is what distinguishes a dead refresh token (invalid_grant)
    // from bad app credentials (invalid_client). Relinking fixes the first
    // and cannot fix the second, so the difference matters.
    const detail =
      [data.error, data.error_description].filter(Boolean).join(": ") ||
      `HTTP ${res.status}`;
    // "invalid_grant"/"Bad Request" = the refresh token itself is dead
    // (revoked or expired). Record it so the dashboard can show a
    // "Reconnect Gmail" prompt instead of failing silently for weeks.
    recordGmailAuthError(`token refresh failed: ${detail}`);
    throw new Error(`Gmail token refresh failed: ${detail}`);
  }

  const expiresIn =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? data.expires_in
      : 3600;
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return data.access_token;
}

/** Shared access token for other Gmail modules (inbox reads). */
export async function getGmailAccessToken(): Promise<string> {
  return fetchAccessToken(getConfig());
}

async function resolveFromAddress(cfg: GmailConfig, accessToken: string): Promise<string> {
  if (cfg.fromAddress) return cfg.fromAddress;
  if (cachedFromAddress) return cachedFromAddress;

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json().catch(() => ({}))) as { emailAddress?: string };
  if (!res.ok || !data.emailAddress?.trim()) {
    throw new Error("Gmail profile lookup failed — set GMAIL_FROM in env");
  }
  cachedFromAddress = data.emailAddress.trim();
  return cachedFromAddress;
}

function encodeRawMessage(lines: string[]): string {
  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function isValidEmail(addr: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
  /* Honoured on the SMTP path (Auto Plan email steps carry these). The OAuth
     path ignores them today rather than pretending: its raw-message builder
     writes no Cc/Bcc headers, and silently dropping them there would be the
     kind of quiet lie this codebase does not ship. */
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
}

const MARCO_RECIPIENT_ALIASES = new Set([
  "marco",
  "me",
  "myself",
  "my email",
  "my inbox",
  "marco puga",
]);

/** Resolve "email me" / "marco" shorthands to Marco's real address. */
export async function resolveEmailRecipient(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (!MARCO_RECIPIENT_ALIASES.has(trimmed.toLowerCase())) return trimmed;
  const marco =
    getMarcoEmail() || (await getGmailSenderAddress());
  if (!marco) {
    throw new Error(
      "Marco email not configured — set MARCO_EMAIL (or GMAIL_FROM) so Harvey can send to you",
    );
  }
  return marco;
}

export async function sendEmail(
  opts: SendEmailOptions,
): Promise<{ ok: true; messageId: string; to: string; from: string }> {
  const to = await resolveEmailRecipient(opts.to);
  const subject = opts.subject.trim();
  const body = opts.body.trim();
  if (!to || !subject || !body) {
    throw new Error("to, subject, and body are required");
  }
  if (!isValidEmail(to)) {
    throw new Error(`Invalid recipient email: ${to}`);
  }

  /* SMTP first: it is the transport that stays up. Falls through to OAuth
     only when no app password is set. */
  if (isSmtpConfigured()) {
    const sent = await sendViaSmtp({
      to,
      subject,
      body,
      html: opts.html !== false,
      cc: opts.cc,
      bcc: opts.bcc,
      replyTo: opts.replyTo,
    });
    console.log(`[gmail:smtp] Sent to ${to} subject="${subject.slice(0, 60)}" id=${sent.messageId}`);
    return { ok: true, messageId: sent.messageId, to, from: sent.from };
  }

  const cfg = getConfig();
  const accessToken = await fetchAccessToken(cfg);
  const from = await resolveFromAddress(cfg, accessToken);
  const contentType = opts.html
    ? "text/html; charset=utf-8"
    : "text/plain; charset=utf-8";

  const raw = encodeRawMessage([
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: ${contentType}`,
    "",
    body,
  ]);

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
  };

  if (!res.ok || !data.id) {
    const detail = data.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gmail send failed: ${detail}`);
  }

  console.log(`[gmail] Sent to ${to} subject="${subject.slice(0, 60)}" id=${data.id}`);
  return { ok: true, messageId: data.id, to, from };
}

/** Module 07 + Harvey tool alias — curated property email body. */
export async function sendPropertyEmail(
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  await sendEmail({ to, subject, body, html: true });
}
