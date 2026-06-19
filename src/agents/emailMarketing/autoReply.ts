import { sendEmail } from "../../integrations/email/index.js";
import { logEmail, markEmailSent, markEmailFailed } from "../../core/emailStore.js";
import { getConversation, updateLeadCrmFields } from "../../core/db.js";
import type { Lead } from "../../core/types.js";

async function extractFirstInquiry(lead: Lead): Promise<string> {
  const conv = await getConversation(lead.id);
  const firstUser = conv.messages.find((m) => m.role === "user");
  if (firstUser?.text?.trim()) return firstUser.text.trim().slice(0, 200);
  if (lead.propertyInquired?.trim()) return lead.propertyInquired.trim();
  return "your interest in finding a new home";
}

export async function sendAutoReply(lead: Lead): Promise<void> {
  if (!lead.email?.trim()) {
    console.log("[AutoReply] No email for lead", lead.id, "— skipping");
    return;
  }

  const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
  const inquiry = await extractFirstInquiry(lead);

  const subject = `Great to hear from you, ${firstName}!`;
  const body = `Hi ${firstName},\n\nThanks so much for reaching out about ${inquiry}! This is Marco — I'll be in touch shortly with more details, but wanted to get this to you right away.\n\nIn the meantime, feel free to reply here or text me anytime with questions.\n\nTalk soon,\nMarco`;

  const emailRecord = logEmail({
    leadId: lead.id,
    subject,
    body,
    emailType: "auto_reply",
    sendStatus: "pending",
  });
  const result = await sendEmail(lead.email, subject, body);

  if (result.success) {
    markEmailSent(emailRecord.id!, result.messageId);
    await updateLeadCrmFields({ leadId: lead.id, autoReplyEmailSentAt: new Date().toISOString() });
    console.log("[AutoReply] Sent to", lead.email);
  } else {
    markEmailFailed(emailRecord.id!, result.error || "unknown error");
    console.log("[AutoReply] Failed for", lead.email, "-", result.error);
  }
}

const scheduledAutoReply = new Set<string>();

export function scheduleAutoReply(lead: Lead): void {
  if (!lead.email?.trim() || lead.autoReplyEmailSentAt || scheduledAutoReply.has(lead.id)) {
    return;
  }
  scheduledAutoReply.add(lead.id);
  setTimeout(() => {
    sendAutoReply(lead).catch((err) => console.error("[AutoReply]", err));
  }, 3 * 60 * 1000);
}
