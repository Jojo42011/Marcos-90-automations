/**
 * Email marketing sender — wraps integrations/gmail, which picks the
 * transport: SMTP app password (GMAIL_SMTP_USER + GMAIL_SMTP_APP_PASSWORD)
 * when set, otherwise OAuth (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN).
 */
import {
  getEmailTransport,
  getGmailSenderAddress,
  isGmailConfigured,
  sendEmail as gmailSendEmail,
} from "../gmail/index.js";
import { getSmtpStatus, verifySmtpConnection } from "../smtp/index.js";

export function isEmailConfigured(): boolean {
  return isGmailConfigured();
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendEmail(to: string, subject: string, body: string): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    console.warn("[Email] Not configured — skipping send to", to);
    return { success: false, error: "Email not configured" };
  }

  try {
    const result = await gmailSendEmail({ to, subject, body, html: true });
    console.log("[Email] Sent to", to, "- messageId:", result.messageId);
    return { success: true, messageId: result.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Email] Send error:", message);
    return { success: false, error: message };
  }
}

/** Lightweight transport check at startup. */
export async function verifyEmailConnection(): Promise<boolean> {
  if (!isEmailConfigured()) {
    console.warn(
      "[Email] No send transport configured — set GMAIL_SMTP_USER + GMAIL_SMTP_APP_PASSWORD (preferred), " +
        "or GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/GMAIL_REFRESH_TOKEN",
    );
    return false;
  }
  if (getEmailTransport() === "smtp") {
    const res = await verifySmtpConnection();
    if (!res.ok) {
      console.error("[Email] SMTP connection FAILED:", res.error);
      return false;
    }
    const st = getSmtpStatus();
    console.log(`[Email] SMTP connection verified ✓ (as ${res.user}, ${st.sentToday}/${st.dailyCap} sent today)`);
    return true;
  }
  try {
    const from = await getGmailSenderAddress();
    if (!from) {
      console.error("[Email] Gmail connection FAILED: could not resolve sender profile");
      return false;
    }
    console.log("[Email] Gmail connection verified ✓ (from:", from, ")");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Email] Gmail connection FAILED:", message);
    return false;
  }
}
