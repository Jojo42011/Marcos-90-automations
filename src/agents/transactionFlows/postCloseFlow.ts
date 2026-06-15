import { updateLeadCrmFields } from "../../core/db.js";
import {
  getAllTransactions,
  updateTransaction,
  type PostCloseFlow,
  type Transaction,
} from "../../core/transactionsStore.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";

export async function checkCloseDayTriggers(): Promise<{ triggered: number }> {
  const transactions = getAllTransactions("closed");
  let triggered = 0;

  for (const tx of transactions) {
    if (tx.postCloseFlow?.congratulationsSentAt) continue;

    await runCloseDayActions(tx);
    triggered++;
  }

  return { triggered };
}

async function runCloseDayActions(tx: Transaction): Promise<void> {
  const now = new Date().toISOString();
  const flow: PostCloseFlow = { ...tx.postCloseFlow };

  const buyerOrSellerName = tx.parties.buyerName || tx.parties.sellerName || "there";
  const firstName = buyerOrSellerName.split(/\s+/)[0];

  const congratsMessage =
    `Congratulations, ${firstName}! 🎉🏡 ${tx.address} is officially yours${tx.dealType === "seller" ? " — sold!" : ""}. ` +
    `It's been a pleasure working with you. Welcome home!`;

  const clientPhone = tx.dealType === "seller" ? tx.parties.sellerPhone : tx.parties.buyerPhone;
  if (clientPhone) {
    await sendTwilioMessage(clientPhone, congratsMessage);
    flow.congratulationsSentAt = now;
  }

  await triggerReviewRequest(tx);
  flow.reviewRequestTriggeredAt = now;

  if (tx.leadId) {
    await markLeadAsPastClient(tx.leadId, tx.closingDate || now);
  }
  flow.pastClientNurtureAddedAt = now;

  const closeDate = new Date(tx.closingDate || now);
  flow.checkIn30DayScheduledFor = new Date(closeDate.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  flow.checkIn1YearScheduledFor = new Date(closeDate.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

  updateTransaction(tx.id!, { postCloseFlow: flow });
  console.log("[PostCloseFlow] Close day actions complete for", tx.address);
}

/**
 * Trigger point for the Reputation Agent. Logs + reviewRequestTriggeredAt on the transaction
 * until a full review-request agent exists (Google/Zillow links need Marco's input).
 */
export async function triggerReviewRequest(tx: Transaction): Promise<void> {
  console.log(
    "[PostCloseFlow] REVIEW REQUEST TRIGGERED for",
    tx.address,
    "— lead:",
    tx.leadId ?? "none",
  );
}

export async function markLeadAsPastClient(leadId: string, closedAt: string): Promise<void> {
  const { getLeadById } = await import("../../core/db.js");
  const existing = await getLeadById(leadId);
  if (!existing) return;

  const existingTags = existing.tags ?? [];
  const tags = existingTags.includes("Past Client") ? existingTags : [...existingTags, "Past Client"];

  await updateLeadCrmFields({
    leadId,
    isPastClient: true,
    pastClientSince: closedAt,
    tags,
  });

  console.log("[PostCloseFlow] Marked lead", leadId, "as past client");
}

export async function checkScheduledClientCheckIns(): Promise<{ sent: number }> {
  const transactions = getAllTransactions("closed").filter((tx) => tx.postCloseFlow);
  let sent = 0;
  const now = Date.now();

  for (const tx of transactions) {
    const flow = tx.postCloseFlow!;
    const clientPhone = tx.dealType === "seller" ? tx.parties.sellerPhone : tx.parties.buyerPhone;
    if (!clientPhone) continue;

    const firstName = (tx.parties.buyerName || tx.parties.sellerName || "there").split(/\s+/)[0];

    if (
      flow.checkIn30DayScheduledFor &&
      !flow.checkIn30DayCompletedAt &&
      now >= new Date(flow.checkIn30DayScheduledFor).getTime()
    ) {
      await sendTwilioMessage(
        clientPhone,
        `Hey ${firstName}! Just checking in — how's everything going at ${tx.address}? Let us know if you need anything at all, even if it's just a recommendation for a local contractor or service!`,
      );
      updateTransaction(tx.id!, {
        postCloseFlow: { ...flow, checkIn30DayCompletedAt: new Date().toISOString() },
      });
      sent++;
    }

    if (
      flow.checkIn1YearScheduledFor &&
      !flow.checkIn1YearCompletedAt &&
      now >= new Date(flow.checkIn1YearScheduledFor).getTime()
    ) {
      await sendTwilioMessage(
        clientPhone,
        `Happy almost-anniversary in your home, ${firstName}! 🏡 Hope the past year has been great. If you know anyone thinking about buying or selling, I'd love an introduction — and as always, here if you ever need anything!`,
      );
      updateTransaction(tx.id!, {
        postCloseFlow: { ...tx.postCloseFlow, checkIn1YearCompletedAt: new Date().toISOString() },
      });
      sent++;
    }
  }

  return { sent };
}
