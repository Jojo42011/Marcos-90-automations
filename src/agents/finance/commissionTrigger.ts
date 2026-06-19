import { getLeadById } from "../../core/db.js";
import {
  createCommission,
  getCommissionByDealId,
  defaultGrossCommissionPct,
  type FinanceDealType,
} from "../../core/financeStore.js";
import type { Transaction } from "../../core/transactionsStore.js";

export async function tryRecordCommissionForClosedDeal(
  tx: Transaction,
): Promise<{ created: boolean; commissionId?: number }> {
  if (tx.status !== "closed" || !tx.id) return { created: false };
  if (getCommissionByDealId(tx.id)) return { created: false };

  const lead = tx.leadId ? await getLeadById(tx.leadId) : null;
  const salePrice = tx.price || 0;
  if (salePrice <= 0) return { created: false };

  const commission = createCommission({
    dealId: tx.id,
    address: tx.address,
    salePrice,
    grossCommissionPct: defaultGrossCommissionPct(),
    dealType: (tx.dealType === "seller" ? "seller" : "buyer") as FinanceDealType,
    leadSource: lead?.source || undefined,
    leadId: tx.leadId,
    closedAt: tx.closingDate || new Date().toISOString().split("T")[0],
  });

  console.log("[Finance] Auto-recorded commission for closed deal", tx.id, "→", commission.netCommission);
  return { created: true, commissionId: commission.id };
}

/** Backfill commissions from all closed transactions + CRM lead sources. */
export async function syncCommissionsFromClosedTransactions(): Promise<{
  created: number;
  skipped: number;
  totalClosed: number;
}> {
  const { getAllTransactions } = await import("../../core/transactionsStore.js");
  const closed = getAllTransactions("closed");
  let created = 0;
  let skipped = 0;
  for (const tx of closed) {
    const result = await tryRecordCommissionForClosedDeal(tx);
    if (result.created) created++;
    else skipped++;
  }
  if (created > 0) {
    console.log(`[Finance] Synced ${created} commission(s) from ${closed.length} closed transaction(s)`);
  }
  return { created, skipped, totalClosed: closed.length };
}
