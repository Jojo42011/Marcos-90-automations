import {
  getAllTransactions,
  updateTransaction,
  type Transaction,
} from "../../core/transactionsStore.js";
import { normalizeToE164 } from "../../integrations/twilio/index.js";

export interface InspectionConfirmationResult {
  handled: boolean;
  replyMessage?: string;
  transactionId?: string;
  role?: string;
}

const YES_PATTERNS = /^\s*(yes|yep|yeah|y|confirmed|✅|👍)\s*[!.]*\s*$/i;

/**
 * Checks if an inbound message is a confirmation for a pending inspection schedule,
 * matched by the sender's phone number against the transaction's party phones.
 */
export function checkInspectionConfirmation(fromPhone: string, message: string): InspectionConfirmationResult {
  const transactions = getAllTransactions().filter(
    (tx) => tx.inspectionFlow?.scheduledAt && !tx.inspectionFlow?.reportReceivedAt,
  );

  for (const tx of transactions) {
    const role = matchPhoneToRole(tx, fromPhone);
    if (!role) continue;

    if (YES_PATTERNS.test(message.trim())) {
      const confirmed = new Set(tx.inspectionFlow?.scheduleConfirmedParties || []);
      confirmed.add(role);

      updateTransaction(tx.id!, {
        inspectionFlow: { ...tx.inspectionFlow, scheduleConfirmedParties: Array.from(confirmed) },
      });

      console.log("[InspectionFlow]", role, "confirmed for", tx.address);
      return {
        handled: true,
        replyMessage: "Got it — confirmed! 👍",
        transactionId: tx.id,
        role,
      };
    }
  }

  return { handled: false };
}

export function matchPhoneToRole(tx: Transaction, phone: string): string | null {
  const normalized = normalizeToE164(phone);
  const map: Record<string, string | undefined> = {
    buyer: tx.parties.buyerPhone,
    seller: tx.parties.sellerPhone,
    buyer_agent: tx.parties.buyerAgentPhone,
    seller_agent: tx.parties.sellerAgentPhone,
    inspector: tx.inspectionFlow?.inspectorPhone,
  };

  for (const [role, p] of Object.entries(map)) {
    if (p && normalizeToE164(p) === normalized) return role;
  }
  return null;
}
