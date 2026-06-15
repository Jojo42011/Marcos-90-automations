import {
  getAllTransactions,
  updateTransaction,
  type FinalWeekFlow,
  type Transaction,
} from "../../core/transactionsStore.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";

export async function checkFinalWeekTriggers(): Promise<{ triggered: number }> {
  const transactions = getAllTransactions("under_contract");
  let triggered = 0;
  const now = Date.now();

  for (const tx of transactions) {
    if (!tx.closingDate) continue;

    const closingTime = new Date(tx.closingDate).getTime();
    const daysUntilClosing = (closingTime - now) / (24 * 60 * 60 * 1000);

    if (
      daysUntilClosing <= 7 &&
      daysUntilClosing > 0 &&
      !tx.finalWeekFlow?.closingDisclosureReminderSentAt
    ) {
      await runFinalWeekActions(tx);
      triggered++;
    }
  }

  return { triggered };
}

async function runFinalWeekActions(tx: Transaction): Promise<void> {
  const now = new Date().toISOString();
  const flow: FinalWeekFlow = { ...tx.finalWeekFlow };

  if (tx.parties.buyerPhone) {
    await sendTwilioMessage(
      tx.parties.buyerPhone,
      `Your Closing Disclosure for ${tx.address} should be in your inbox/email — please review it as soon as possible. Let us know if you have questions!`,
    );
  }
  flow.closingDisclosureReminderSentAt = now;

  if (tx.parties.titleContactPhone) {
    await sendTwilioMessage(
      tx.parties.titleContactPhone,
      `Confirming wire instructions for closing on ${tx.address} (closing ${new Date(tx.closingDate!).toLocaleDateString()}). Please confirm instructions are finalized and verified.`,
    );
  }

  const guideMessage = buildWhatToExpectGuide(tx);
  if (tx.parties.buyerPhone) {
    await sendTwilioMessage(tx.parties.buyerPhone, guideMessage);
    flow.whatToExpectGuideSentAt = now;
  }

  updateTransaction(tx.id!, { finalWeekFlow: flow });
  console.log("[FinalWeekFlow] Triggered for", tx.address);
}

export function buildWhatToExpectGuide(tx: Transaction): string {
  const closingDateStr = new Date(tx.closingDate!).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return (
    `Closing week is here! 🎉 Quick rundown for ${tx.address}:\n` +
    `• Final walkthrough happens before closing — we'll confirm timing soon\n` +
    `• Bring a valid photo ID to closing on ${closingDateStr}\n` +
    `• Funds for closing must be wired or in certified form — NEVER send money based on emailed instructions without verbally confirming with your title company\n` +
    `• Questions? Just reply here anytime.`
  );
}
