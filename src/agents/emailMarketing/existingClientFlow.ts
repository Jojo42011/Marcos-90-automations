import { sendEmail } from "../../integrations/email/index.js";
import { logEmail, markEmailSent, markEmailFailed, getEmailsForLead } from "../../core/emailStore.js";
import { getThreadForLead } from "../../core/smsStore.js";
import { getAllTransactions } from "../../core/transactionsStore.js";
import { findLeadById } from "../../core/db.js";

export interface ClientContext {
  leadName: string;
  activeDeal: { address: string; status: string } | null;
  lastConversationSnippet: string | null;
  lastEmailSubject: string | null;
}

export async function buildClientContext(leadId: string): Promise<ClientContext> {
  const lead = await findLeadById(leadId);

  const transactions = getAllTransactions().filter(
    (t) =>
      t.leadId === leadId && !["closed", "cancelled", "fell_through"].includes(t.status),
  );
  const activeDeal =
    transactions.length > 0
      ? { address: transactions[0].address, status: transactions[0].status }
      : null;

  const smsThread = getThreadForLead(leadId, 5);
  const lastMessage = smsThread.length > 0 ? smsThread[smsThread.length - 1] : null;

  const emails = getEmailsForLead(leadId, 1);
  const lastEmailSubject = emails.length > 0 ? emails[0].subject : null;

  return {
    leadName: lead?.name || lead?.username || "there",
    activeDeal,
    lastConversationSnippet: lastMessage ? lastMessage.messageBody.substring(0, 100) : null,
    lastEmailSubject,
  };
}

export async function sendContextAwareEmail(
  leadId: string,
  subject: string,
  bodyTemplate: (ctx: ClientContext) => string,
): Promise<{ success: boolean; error?: string }> {
  const lead = await findLeadById(leadId);
  if (!lead || !lead.email) {
    return { success: false, error: "No email on file for this lead" };
  }

  const context = await buildClientContext(leadId);
  const body = bodyTemplate(context);

  const emailRecord = logEmail({
    leadId,
    subject,
    body,
    emailType: "existing_client",
    sendStatus: "pending",
  });
  const result = await sendEmail(lead.email, subject, body);

  if (result.success) markEmailSent(emailRecord.id!, result.messageId);
  else markEmailFailed(emailRecord.id!, result.error || "unknown");

  return { success: result.success, error: result.error };
}
