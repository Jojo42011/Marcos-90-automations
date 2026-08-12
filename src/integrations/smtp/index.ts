/**
 * Gmail sending over SMTP with an app password.
 *
 * WHY THIS EXISTS: the OAuth refresh token has died twice (invalid_grant, June
 * 22 and July 28) because the Google consent screen sits in "Testing", where
 * Google expires refresh tokens after 7 days. Relinking fixes it for a week.
 * An app password does not expire on a timer — it lives until it is revoked —
 * so it is the transport that actually stays up.
 *
 * SETUP (Marco does this once, in his own Google account):
 *   1. Turn on 2-Step Verification — app passwords do not exist without it.
 *   2. myaccount.google.com/apppasswords → generate one → a 16-character
 *      string, usually shown in four spaced groups. Spaces are cosmetic and
 *      are stripped here, so either form can be pasted.
 *   3. Set two Fly secrets:
 *        GMAIL_SMTP_USER          = the full gmail address
 *        GMAIL_SMTP_APP_PASSWORD  = that 16-character password
 *   No client id, no client secret, no refresh token, no consent screen.
 *
 * SENDING LIMITS ARE THE REAL HAZARD HERE, so this module counts. A free
 * gmail.com account is capped near 500 recipients per rolling 24h and a
 * Workspace account near 2,000; blowing past it gets the ACCOUNT suspended
 * from sending for 24 hours — not just the message rejected. This system
 * holds 1,300+ contacts and drip agents that loop over them, so an uncapped
 * campaign could take Marco's personal email offline for a day. The cap below
 * refuses the send instead, and says so.
 */
import { kvGet, kvSet } from "../../core/emailStore.js";
import { smtpSend, type SmtpMessage } from "../../core/smtpClient.js";

const KV_SENT_DATE = "smtp_sent_date";
const KV_SENT_COUNT = "smtp_sent_count";
const KV_LAST_ERROR = "smtp_last_error";
const KV_LAST_ERROR_AT = "smtp_last_error_at";
const KV_LAST_SENT_AT = "smtp_last_sent_at";

/** Conservative against Gmail's ~500/day free-tier ceiling. */
const DEFAULT_DAILY_CAP = 400;

export interface SmtpConfig {
  user: string;
  pass: string;
  host: string;
  port: number;
  secure: boolean;
  fromName?: string;
  dailyCap: number;
}

/** App passwords are displayed in spaced groups of four; the spaces are not part of it. */
function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export function getSmtpConfig(): SmtpConfig | null {
  const user = process.env.GMAIL_SMTP_USER?.trim();
  const passRaw = process.env.GMAIL_SMTP_APP_PASSWORD?.trim();
  if (!user || !passRaw) return null;
  const pass = normalizeAppPassword(passRaw);
  const port = Number(process.env.GMAIL_SMTP_PORT?.trim() || 587);
  const capRaw = Number(process.env.GMAIL_SMTP_DAILY_CAP?.trim());
  return {
    user,
    pass,
    host: process.env.GMAIL_SMTP_HOST?.trim() || "smtp.gmail.com",
    port,
    /* 465 is implicit TLS; 587 upgrades with STARTTLS. Anything else follows
       the same rule (>=465 && ===465 is implicit) rather than guessing. */
    secure: port === 465,
    fromName: process.env.GMAIL_FROM_NAME?.trim() || undefined,
    dailyCap: Number.isFinite(capRaw) && capRaw > 0 ? Math.trunc(capRaw) : DEFAULT_DAILY_CAP,
  };
}

export function isSmtpConfigured(): boolean {
  return getSmtpConfig() !== null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sends used today, resetting when the date rolls over. */
export function smtpSentToday(): number {
  try {
    if (kvGet(KV_SENT_DATE) !== today()) return 0;
    return Number(kvGet(KV_SENT_COUNT) || 0) || 0;
  } catch {
    return 0;
  }
}

function recordSend(recipients: number): void {
  try {
    const count = smtpSentToday() + recipients;
    kvSet(KV_SENT_DATE, today());
    kvSet(KV_SENT_COUNT, String(count));
    kvSet(KV_LAST_SENT_AT, new Date().toISOString());
    kvSet(KV_LAST_ERROR, "");
  } catch {
    /* bookkeeping only — never fail a delivered message on a counter write */
  }
}

function recordError(message: string): void {
  try {
    kvSet(KV_LAST_ERROR, message.slice(0, 500));
    kvSet(KV_LAST_ERROR_AT, new Date().toISOString());
  } catch {
    /* bookkeeping only */
  }
}

export interface SmtpStatus {
  configured: boolean;
  user: string | null;
  host: string | null;
  port: number | null;
  sentToday: number;
  dailyCap: number | null;
  remainingToday: number | null;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export function getSmtpStatus(): SmtpStatus {
  const cfg = getSmtpConfig();
  const sentToday = smtpSentToday();
  return {
    configured: cfg !== null,
    user: cfg?.user ?? null,
    host: cfg?.host ?? null,
    port: cfg?.port ?? null,
    sentToday,
    dailyCap: cfg?.dailyCap ?? null,
    remainingToday: cfg ? Math.max(0, cfg.dailyCap - sentToday) : null,
    lastSentAt: kvGet(KV_LAST_SENT_AT) || null,
    lastError: kvGet(KV_LAST_ERROR) || null,
    lastErrorAt: kvGet(KV_LAST_ERROR_AT) || null,
  };
}

export interface SendViaSmtpOptions {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  /** Skip the daily-cap check — only for a single operator-triggered test. */
  bypassCap?: boolean;
}

/**
 * Send one message. Throws with the server's own words on failure; a resolved
 * promise means the SMTP server accepted the message, nothing weaker.
 */
export async function sendViaSmtp(
  opts: SendViaSmtpOptions,
): Promise<{ messageId: string; from: string; accepted: string[]; response: string }> {
  const cfg = getSmtpConfig();
  if (!cfg) throw new Error("SMTP is not configured — set GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD");

  const recipientCount = 1 + (opts.cc?.length || 0) + (opts.bcc?.length || 0);
  if (!opts.bypassCap) {
    const used = smtpSentToday();
    if (used + recipientCount > cfg.dailyCap) {
      /* Refusing here is the point. Gmail's own response to going over is to
         suspend the ACCOUNT from sending for 24 hours, which would take down
         every drip, digest and assignment email at once. */
      throw new Error(
        `Daily email cap reached (${used}/${cfg.dailyCap} recipients today). ` +
          `Gmail suspends an account that exceeds its limit for 24h, so this send was refused rather than risking it. ` +
          `Raise GMAIL_SMTP_DAILY_CAP only if the account is Workspace (≈2000/day) rather than free gmail.com (≈500/day).`,
      );
    }
  }

  const msg: SmtpMessage = {
    from: cfg.user,
    fromName: cfg.fromName,
    to: [opts.to],
    cc: opts.cc,
    bcc: opts.bcc,
    replyTo: opts.replyTo,
    subject: opts.subject,
    body: opts.body,
    html: opts.html !== false,
  };

  try {
    const result = await smtpSend(
      { host: cfg.host, port: cfg.port, secure: cfg.secure },
      { user: cfg.user, pass: cfg.pass },
      msg,
    );
    recordSend(recipientCount);
    /* Gmail returns "250 2.0.0 OK  <id> - gsmtp"; the id is the useful half. */
    const idMatch = /OK\s+(\S+)/i.exec(result.response);
    return {
      messageId: idMatch ? idMatch[1] : result.response.slice(0, 80),
      from: cfg.user,
      accepted: result.accepted,
      response: result.response,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordError(message);
    throw new Error(explainSmtpError(message));
  }
}

/**
 * Turn an SMTP failure into something the operator can act on. A raw
 * "535-5.7.8 Username and Password not accepted" sends people to reset the
 * wrong thing.
 */
export function explainSmtpError(message: string): string {
  if (/535|Username and Password not accepted|BadCredentials/i.test(message)) {
    return `${message} — the app password was rejected. Check that 2-Step Verification is still on for this account and that the app password has not been revoked; regenerate at myaccount.google.com/apppasswords and update GMAIL_SMTP_APP_PASSWORD.`;
  }
  if (/534|application-specific password required/i.test(message)) {
    return `${message} — this account requires an app password (a normal account password will never work over SMTP). Generate one at myaccount.google.com/apppasswords.`;
  }
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timed out/i.test(message)) {
    return `${message} — could not reach the SMTP server. Fly allows outbound 587/465; if this persists try GMAIL_SMTP_PORT=465.`;
  }
  if (/550|554|quota|rate/i.test(message)) {
    return `${message} — Gmail rejected the message, commonly a sending-limit or reputation block. Sends are capped locally, but the account's own 24h limit is the ceiling.`;
  }
  return message;
}

/** Prove the credentials work by talking to Gmail, without sending mail. */
export async function verifySmtpConnection(): Promise<{ ok: boolean; error?: string; user?: string }> {
  const cfg = getSmtpConfig();
  if (!cfg) return { ok: false, error: "SMTP not configured" };
  try {
    const { smtpLoginCheck } = await import("../../core/smtpClient.js");
    await smtpLoginCheck(
      { host: cfg.host, port: cfg.port, secure: cfg.secure },
      { user: cfg.user, pass: cfg.pass },
    );
    return { ok: true, user: cfg.user };
  } catch (err) {
    const message = explainSmtpError(err instanceof Error ? err.message : String(err));
    recordError(message);
    return { ok: false, error: message };
  }
}
