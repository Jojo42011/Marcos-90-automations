/**
 * Email marketing sender — Gmail OAuth2 (wraps integrations/gmail).
 * Auth: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (not SMTP app password).
 */
import {
  getGmailSenderAddress,
  isGmailConfigured,
  sendEmail as gmailSendEmail,
} from "../gmail/index.js";

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

/** Lightweight OAuth + profile check at startup. */
export async function verifyEmailConnection(): Promise<boolean> {
  if (!isEmailConfigured()) {
    console.warn("[Email] Gmail OAuth not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN");
    return false;
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
