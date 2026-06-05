import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { Deal, DealActivityLogEntry, DealStatus, DealType, SigningDocument } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function genDealId(): string {
  return `deal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function genDocId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDealDocuments(raw: unknown): SigningDocument[] {
  if (!Array.isArray(raw)) return [];
  const out: SigningDocument[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    const id = typeof d.id === "string" && d.id ? d.id : genDocId();
    const status =
      d.status === "pending" || d.status === "sent" || d.status === "signed" || d.status === "declined"
        ? d.status
        : "pending";
    out.push({
      id,
      name: typeof d.name === "string" ? d.name : "Document",
      fileData: typeof d.fileData === "string" ? d.fileData : "",
      status,
      sentAt: typeof d.sentAt === "string" ? d.sentAt : undefined,
      signedAt: typeof d.signedAt === "string" ? d.signedAt : undefined,
      signerEmail: typeof d.signerEmail === "string" ? d.signerEmail : undefined,
      signerName: typeof d.signerName === "string" ? d.signerName : undefined,
    });
  }
  return out;
}

function resolveDealsPath(): string {
  const explicit = process.env.DEALS_JSON_PATH?.trim();
  if (explicit) return explicit;
  const flyDb = "/data/db.json";
  const localDb = join(process.cwd(), "data", "local-dashboard-db.json");
  const dbPath = process.env.DB_JSON_PATH?.trim() || (existsSync(flyDb) ? flyDb : localDb);
  return join(dirname(dbPath), "deals.json");
}

const DEALS_PATH = resolveDealsPath();

const DEAL_STATUSES = new Set<DealStatus>([
  "prospect",
  "active",
  "under_contract",
  "closed",
  "fallen_through",
]);

const DEAL_TYPES = new Set<DealType>(["buyer", "seller", "referral", "investor"]);

export function calculateGCI(salePrice: number, commissionPercent: number): number {
  if (!Number.isFinite(salePrice) || !Number.isFinite(commissionPercent)) return 0;
  return Math.round((salePrice * commissionPercent) / 100);
}

function normalizeDeal(raw: unknown): Deal | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const status = typeof d.status === "string" && DEAL_STATUSES.has(d.status as DealStatus) ? (d.status as DealStatus) : "prospect";
  const dealType =
    typeof d.dealType === "string" && DEAL_TYPES.has(d.dealType as DealType) ? (d.dealType as DealType) : "buyer";
  const leadName = typeof d.leadName === "string" ? d.leadName.trim() : "";
  const propertyAddress = typeof d.propertyAddress === "string" ? d.propertyAddress.trim() : "";
  if (!leadName || !propertyAddress) return null;
  const salePrice = typeof d.salePrice === "number" && d.salePrice >= 0 ? d.salePrice : undefined;
  const commissionPercent =
    typeof d.commissionPercent === "number" && d.commissionPercent >= 0 ? d.commissionPercent : 3;
  const estimatedGCI =
    typeof d.estimatedGCI === "number" && d.estimatedGCI >= 0
      ? d.estimatedGCI
      : salePrice !== undefined
        ? calculateGCI(salePrice, commissionPercent)
        : undefined;
  const activityLog: DealActivityLogEntry[] = [];
  if (Array.isArray(d.activityLog)) {
    for (const item of d.activityLog) {
      if (!item || typeof item !== "object") continue;
      const a = item as Record<string, unknown>;
      activityLog.push({
        type: typeof a.type === "string" ? a.type : "note",
        description: typeof a.description === "string" ? a.description : "",
        timestamp: typeof a.timestamp === "string" && a.timestamp ? a.timestamp : nowIso(),
      });
    }
  }
  return {
    id: typeof d.id === "string" && d.id ? d.id : genDealId(),
    leadId: typeof d.leadId === "string" && d.leadId.trim() ? d.leadId.trim() : undefined,
    leadName,
    phone: typeof d.phone === "string" ? d.phone : undefined,
    email: typeof d.email === "string" ? d.email : undefined,
    propertyAddress,
    dealType,
    status,
    salePrice,
    commissionPercent,
    estimatedGCI,
    closeDate: typeof d.closeDate === "string" ? d.closeDate : undefined,
    openedDate: typeof d.openedDate === "string" ? d.openedDate : nowIso(),
    closedDate: typeof d.closedDate === "string" ? d.closedDate : undefined,
    assignedTo: typeof d.assignedTo === "string" ? d.assignedTo : undefined,
    notes: typeof d.notes === "string" ? d.notes : undefined,
    documents: normalizeDealDocuments(d.documents),
    activityLog,
    createdAt: typeof d.createdAt === "string" ? d.createdAt : nowIso(),
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : nowIso(),
  };
}

function writeDealsFile(deals: Deal[]): void {
  mkdirSync(dirname(DEALS_PATH), { recursive: true });
  writeFileSync(DEALS_PATH, JSON.stringify(deals, null, 2), "utf8");
}

export function getDeals(): Deal[] {
  try {
    if (!existsSync(DEALS_PATH)) return [];
    const raw = readFileSync(DEALS_PATH, "utf8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeDeal).filter((d): d is Deal => d !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (err) {
    console.error("[deals] getDeals failed:", err);
    return [];
  }
}

export function saveDeals(deals: Deal[]): void {
  try {
    writeDealsFile(deals);
  } catch (err) {
    console.error("[deals] saveDeals failed:", err);
  }
}

export function getDealById(id: string): Deal | null {
  return getDeals().find((d) => d.id === id) ?? null;
}

export function getDealsByLeadId(leadId: string): Deal[] {
  return getDeals().filter((d) => d.leadId === leadId);
}

export function createDeal(data: Omit<Deal, "id" | "createdAt" | "updatedAt">): Deal {
  const now = nowIso();
  const commissionPercent = data.commissionPercent ?? 3;
  const salePrice = data.salePrice;
  const estimatedGCI =
    data.estimatedGCI ??
    (salePrice !== undefined ? calculateGCI(salePrice, commissionPercent) : undefined);
  const deal: Deal = {
    ...data,
    id: genDealId(),
    commissionPercent,
    estimatedGCI,
    documents: data.documents ?? [],
    activityLog: data.activityLog ?? [
      { type: "created", description: "Deal created", timestamp: now },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const deals = getDeals();
  deals.unshift(deal);
  saveDeals(deals);
  return deal;
}

export function updateDeal(id: string, updates: Partial<Deal>): Deal | null {
  const deals = getDeals();
  const idx = deals.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const prev = deals[idx];
  const commissionPercent = updates.commissionPercent ?? prev.commissionPercent ?? 3;
  const salePrice = updates.salePrice !== undefined ? updates.salePrice : prev.salePrice;
  let estimatedGCI = updates.estimatedGCI;
  if (updates.salePrice !== undefined || updates.commissionPercent !== undefined) {
    if (salePrice !== undefined) {
      estimatedGCI = calculateGCI(salePrice, commissionPercent);
    }
  } else if (estimatedGCI === undefined) {
    estimatedGCI = prev.estimatedGCI;
  }
  const next: Deal = {
    ...prev,
    ...updates,
    id: prev.id,
    commissionPercent,
    salePrice,
    estimatedGCI,
    documents: updates.documents !== undefined ? normalizeDealDocuments(updates.documents) : prev.documents,
    updatedAt: nowIso(),
  };
  deals[idx] = next;
  saveDeals(deals);
  return next;
}

export function deleteDeal(id: string): boolean {
  const deals = getDeals();
  const filtered = deals.filter((d) => d.id !== id);
  if (filtered.length === deals.length) return false;
  saveDeals(filtered);
  return true;
}

export function sumClosedDealGCI(deals: Deal[]): number {
  return deals
    .filter((d) => d.status === "closed")
    .reduce((s, d) => s + (d.estimatedGCI || 0), 0);
}
