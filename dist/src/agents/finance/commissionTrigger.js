"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.tryRecordCommissionForClosedDeal = tryRecordCommissionForClosedDeal;
exports.syncCommissionsFromClosedTransactions = syncCommissionsFromClosedTransactions;
const db_js_1 = require("../../core/db.js");
const financeStore_js_1 = require("../../core/financeStore.js");
async function tryRecordCommissionForClosedDeal(tx) {
    if (tx.status !== "closed" || !tx.id)
        return { created: false };
    if ((0, financeStore_js_1.getCommissionByDealId)(tx.id))
        return { created: false };
    const lead = tx.leadId ? await (0, db_js_1.getLeadById)(tx.leadId) : null;
    const salePrice = tx.price || 0;
    if (salePrice <= 0)
        return { created: false };
    const commission = (0, financeStore_js_1.createCommission)({
        dealId: tx.id,
        address: tx.address,
        salePrice,
        grossCommissionPct: (0, financeStore_js_1.defaultGrossCommissionPct)(),
        dealType: (tx.dealType === "seller" ? "seller" : "buyer"),
        leadSource: lead?.source || undefined,
        leadId: tx.leadId,
        closedAt: tx.closingDate || new Date().toISOString().split("T")[0],
    });
    console.log("[Finance] Auto-recorded commission for closed deal", tx.id, "→", commission.netCommission);
    return { created: true, commissionId: commission.id };
}
/** Backfill commissions from all closed transactions + CRM lead sources. */
async function syncCommissionsFromClosedTransactions() {
    const { getAllTransactions } = await Promise.resolve().then(() => __importStar(require("../../core/transactionsStore.js")));
    const closed = getAllTransactions("closed");
    let created = 0;
    let skipped = 0;
    for (const tx of closed) {
        const result = await tryRecordCommissionForClosedDeal(tx);
        if (result.created)
            created++;
        else
            skipped++;
    }
    if (created > 0) {
        console.log(`[Finance] Synced ${created} commission(s) from ${closed.length} closed transaction(s)`);
    }
    return { created, skipped, totalClosed: closed.length };
}
