import {
  getEmailsForLead,
  logEmail,
  markEmailSent,
  markEmailFailed,
} from "../../core/emailStore.js";
import { sendEmail } from "../../integrations/email/index.js";
import { listAllLeads, updateLeadCrmFields } from "../../core/db.js";
import type { Lead } from "../../core/types.js";

const STEP_3_DAYS = {
  subject: () => `Just checking in`,
  body: (n: string) =>
    `Hi ${n},\n\nWanted to make sure my last email made it through okay — no rush, just checking in!\n\nMarco`,
};
const STEP_7_DAYS = {
  subject: () => `Something that might help`,
  body: (n: string) =>
    `Hi ${n},\n\nThought this might be useful even if timing isn't right for a full conversation right now — happy to send more anytime.\n\nMarco`,
};

/**
 * INBOUND REPLY GAP: repliedAt is only set via markEmailReplied() — there is no
 * IMAP/Gmail Pub/Sub inbound parser wired. Leads who reply by email may still
 * receive follow-ups until reply detection is built.
 */
export async function checkNoReplyFollowups(): Promise<{ sent: number; movedToCold: number }> {
  const leads = await listAllLeads();
  let sent = 0;
  let movedToCold = 0;

  for (const lead of leads) {
    if (!lead.email) continue;

    const emails = getEmailsForLead(lead.id, 20);
    const sentEmails = emails.filter((e) => e.sendStatus === "sent" && !e.repliedAt);
    if (sentEmails.length === 0) continue;

    const mostRecent = sentEmails[0];
    if (!mostRecent.sentAt) continue;

    const daysSinceSent =
      (Date.now() - new Date(mostRecent.sentAt).getTime()) / (24 * 60 * 60 * 1000);
    const alreadyFollowedUp = emails.some(
      (e) =>
        e.emailType === "no_reply_followup" &&
        e.createdAt &&
        new Date(e.createdAt).getTime() > new Date(mostRecent.sentAt!).getTime(),
    );
    if (alreadyFollowedUp) continue;

    if (daysSinceSent >= 14) {
      if (!lead.movedToColdNurtureAt) {
        await updateLeadCrmFields({
          leadId: lead.id,
          movedToColdNurtureAt: new Date().toISOString(),
        });
      }
      movedToCold++;
      console.log("[NoReplyFollowup] Moved", lead.id, "to cold nurture after 14 days no reply");
    } else if (daysSinceSent >= 7) {
      await sendFollowupStep(lead, STEP_7_DAYS);
      sent++;
    } else if (daysSinceSent >= 3) {
      await sendFollowupStep(lead, STEP_3_DAYS);
      sent++;
    }
  }

  console.log("[NoReplyFollowup] Sent", sent, "— moved", movedToCold, "to cold");
  return { sent, movedToCold };
}

async function sendFollowupStep(
  lead: Lead,
  step: { subject: () => string; body: (n: string) => string },
): Promise<void> {
  const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
  const subject = step.subject();
  const body = step.body(firstName);

  const emailRecord = logEmail({
    leadId: lead.id,
    subject,
    body,
    emailType: "no_reply_followup",
    sendStatus: "pending",
  });
  const result = await sendEmail(lead.email!, subject, body);

  if (result.success) markEmailSent(emailRecord.id!, result.messageId);
  else markEmailFailed(emailRecord.id!, result.error || "unknown");
}

export function scheduleNoReplyFollowupCheck(): void {
  setInterval(() => {
    checkNoReplyFollowups().catch((err) => console.error("[NoReplyFollowup]", err));
  }, 60 * 60 * 1000);
  console.log("[NoReplyFollowup] Scheduled — checking hourly");
}
