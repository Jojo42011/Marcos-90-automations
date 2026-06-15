"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDealsJsonPath = resolveDealsJsonPath;
exports.calculateGCI = calculateGCI;
exports.transactionToDeal = transactionToDeal;
exports.getDeals = getDeals;
exports.getDealById = getDealById;
exports.getDealsByLeadId = getDealsByLeadId;
exports.createDeal = createDeal;
exports.updateDeal = updateDeal;
exports.deleteDeal = deleteDeal;
exports.sumClosedDealGCI = sumClosedDealGCI;
exports.readLegacyDealsJson = readLegacyDealsJson;
const fs_1 = require("fs");
const path_1 = require("path");
const transactionsStore_js_1 = require("./transactionsStore.js");
function nowIso() {
    return new Date().toISOString();
}
function resolveDealsJsonPath() {
    const explicit = process.env.DEALS_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDb = "/data/db.json";
    const localDb = (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
    const dbPath = process.env.DB_JSON_PATH?.trim() || ((0, fs_1.existsSync)(flyDb) ? flyDb : localDb);
    return (0, path_1.join)((0, path_1.dirname)(dbPath), "deals.json");
}
function calculateGCI(salePrice, commissionPercent) {
    if (!Number.isFinite(salePrice) || !Number.isFinite(commissionPercent))
        return 0;
    return Math.round((salePrice * commissionPercent) / 100);
}
function signingDocToDealDocument(doc) {
    const status = doc.status === "pending" || doc.status === "sent" || doc.status === "signed" || doc.status === "declined"
        ? doc.status
        : "pending";
    return {
        id: doc.id || `doc_${Date.now()}`,
        name: doc.notes || doc.documentType || "Document",
        fileData: doc.documentUrl || "",
        status,
        sentAt: doc.sentAt,
        signedAt: doc.signedAt,
    };
}
function dealStatusToTransaction(status) {
    if (status === "under_contract")
        return "under_contract";
    if (status === "closed")
        return "closed";
    if (status === "fallen_through")
        return "fell_through";
    return "active";
}
function transactionStatusToDeal(tx) {
    const legacy = tx.parties?.legacyStatus;
    if (tx.status === "under_contract")
        return "under_contract";
    if (tx.status === "closed")
        return "closed";
    if (tx.status === "fell_through")
        return "fallen_through";
    if (tx.status === "active" && legacy === "prospect")
        return "prospect";
    return "active";
}
function dealTypeToTransaction(dealType) {
    return dealType === "seller" ? "seller" : "buyer";
}
function transactionToDealType(tx) {
    const subtype = tx.parties?.dealSubtype;
    if (subtype === "referral" || subtype === "investor")
        return subtype;
    return tx.dealType === "seller" ? "seller" : "buyer";
}
function dealToParties(deal, base) {
    const parties = { ...(base || {}) };
    if (deal.leadName)
        parties.leadName = deal.leadName;
    if (deal.phone !== undefined)
        parties.phone = deal.phone;
    if (deal.email !== undefined)
        parties.email = deal.email;
    if (deal.assignedTo !== undefined)
        parties.assignedTo = deal.assignedTo;
    if (deal.commissionPercent !== undefined)
        parties.commissionPercent = deal.commissionPercent;
    if (deal.estimatedGCI !== undefined)
        parties.estimatedGCI = deal.estimatedGCI;
    if (deal.openedDate)
        parties.openedDate = deal.openedDate;
    if (deal.closedDate !== undefined)
        parties.closedDate = deal.closedDate;
    if (deal.activityLog)
        parties.activityLog = deal.activityLog;
    if (deal.status === "prospect")
        parties.legacyStatus = "prospect";
    else if (deal.status)
        delete parties.legacyStatus;
    if (deal.dealType === "referral" || deal.dealType === "investor") {
        parties.dealSubtype = deal.dealType;
    }
    else if (deal.dealType) {
        parties.dealSubtype = undefined;
    }
    return parties;
}
function transactionToDeal(tx) {
    const parties = tx.parties || {};
    const commissionPercent = parties.commissionPercent ?? 3;
    const salePrice = tx.price;
    const estimatedGCI = parties.estimatedGCI ??
        (salePrice !== undefined ? calculateGCI(salePrice, commissionPercent) : undefined);
    const docs = (0, transactionsStore_js_1.getDocumentsForDeal)(tx.id).map(signingDocToDealDocument);
    return {
        id: tx.id,
        leadId: tx.leadId,
        leadName: parties.leadName || parties.buyerName || "Unknown",
        phone: parties.phone,
        email: parties.email,
        propertyAddress: tx.address,
        dealType: transactionToDealType(tx),
        status: transactionStatusToDeal(tx),
        salePrice,
        commissionPercent,
        estimatedGCI,
        closeDate: tx.closingDate,
        openedDate: parties.openedDate || tx.createdAt,
        closedDate: parties.closedDate,
        assignedTo: parties.assignedTo,
        notes: tx.notes,
        documents: docs,
        activityLog: parties.activityLog || [],
        createdAt: tx.createdAt,
        updatedAt: tx.updatedAt,
    };
}
function partialDealToTransactionUpdates(updates, existing) {
    const out = {};
    if (updates.propertyAddress)
        out.address = updates.propertyAddress;
    if (updates.dealType)
        out.dealType = dealTypeToTransaction(updates.dealType);
    if (updates.status)
        out.status = dealStatusToTransaction(updates.status);
    if (updates.salePrice !== undefined)
        out.price = updates.salePrice;
    if (updates.closeDate !== undefined)
        out.closingDate = updates.closeDate;
    if (updates.leadId !== undefined)
        out.leadId = updates.leadId;
    if (updates.notes !== undefined)
        out.notes = updates.notes;
    const partyFields = {
        leadName: updates.leadName,
        phone: updates.phone,
        email: updates.email,
        assignedTo: updates.assignedTo,
        commissionPercent: updates.commissionPercent,
        estimatedGCI: updates.estimatedGCI,
        openedDate: updates.openedDate,
        closedDate: updates.closedDate,
        activityLog: updates.activityLog,
        status: updates.status,
        dealType: updates.dealType,
    };
    const hasPartyUpdate = Object.values(partyFields).some((v) => v !== undefined);
    if (hasPartyUpdate) {
        out.parties = dealToParties({ ...transactionToDeal(existing), ...updates }, existing.parties);
    }
    return out;
}
function getDeals() {
    try {
        return (0, transactionsStore_js_1.getAllTransactions)()
            .map(transactionToDeal)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    catch (err) {
        console.error("[deals] getDeals failed:", err);
        return [];
    }
}
function getDealById(id) {
    const tx = (0, transactionsStore_js_1.getTransaction)(id);
    return tx ? transactionToDeal(tx) : null;
}
function getDealsByLeadId(leadId) {
    return getDeals().filter((d) => d.leadId === leadId);
}
function createDeal(data) {
    const now = nowIso();
    const commissionPercent = data.commissionPercent ?? 3;
    const salePrice = data.salePrice;
    const estimatedGCI = data.estimatedGCI ?? (salePrice !== undefined ? calculateGCI(salePrice, commissionPercent) : undefined);
    const parties = dealToParties({
        ...data,
        commissionPercent,
        estimatedGCI,
        openedDate: data.openedDate || now,
        activityLog: data.activityLog ??
            [{ type: "created", description: "Deal created", timestamp: now }],
    });
    const tx = (0, transactionsStore_js_1.createTransaction)({
        address: data.propertyAddress,
        dealType: dealTypeToTransaction(data.dealType),
        parties,
        price: salePrice,
        status: dealStatusToTransaction(data.status),
        closingDate: data.closeDate,
        leadId: data.leadId,
        notes: data.notes,
    });
    return transactionToDeal(tx);
}
function updateDeal(id, updates) {
    const existing = (0, transactionsStore_js_1.getTransaction)(id);
    if (!existing)
        return null;
    const prev = transactionToDeal(existing);
    const commissionPercent = updates.commissionPercent ?? prev.commissionPercent ?? 3;
    const salePrice = updates.salePrice !== undefined ? updates.salePrice : prev.salePrice;
    let estimatedGCI = updates.estimatedGCI;
    if (updates.salePrice !== undefined || updates.commissionPercent !== undefined) {
        if (salePrice !== undefined)
            estimatedGCI = calculateGCI(salePrice, commissionPercent);
    }
    else if (estimatedGCI === undefined) {
        estimatedGCI = prev.estimatedGCI;
    }
    const mergedUpdates = {
        ...updates,
        commissionPercent,
        salePrice,
        estimatedGCI,
    };
    const txUpdates = partialDealToTransactionUpdates(mergedUpdates, existing);
    const updated = (0, transactionsStore_js_1.updateTransaction)(id, txUpdates);
    return updated ? transactionToDeal(updated) : null;
}
function deleteDeal(id) {
    return (0, transactionsStore_js_1.deleteTransaction)(id);
}
function sumClosedDealGCI(deals) {
    return deals.filter((d) => d.status === "closed").reduce((s, d) => s + (d.estimatedGCI || 0), 0);
}
/** Read legacy deals.json for one-time migration. */
function readLegacyDealsJson() {
    const path = resolveDealsJsonPath();
    if (!(0, fs_1.existsSync)(path))
        return [];
    try {
        const raw = (0, fs_1.readFileSync)(path, "utf8");
        if (!raw.trim())
            return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (err) {
        console.error("[deals] readLegacyDealsJson failed:", err);
        return [];
    }
}
