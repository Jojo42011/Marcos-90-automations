/**
 * Gmail — send email via OAuth refresh token (Marco's linked account).
 */

interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fromAddress?: string;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let cachedFromAddress: string | null = null;

export function isGmailConfigured(): boolean {
  return Boolean(
    process.env.GMAIL_CLIENT_ID?.trim() &&
      process.env.GMAIL_CLIENT_SECRET?.trim() &&
      process.env.GMAIL_REFRESH_TOKEN?.trim(),
  );
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

function getConfig(): GmailConfig {
  const clientId = process.env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN?.trim();
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
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
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
