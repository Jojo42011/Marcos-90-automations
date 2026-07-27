import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

import type {
  BuyerStage,
  CommandTaskChecklistItem,
  SellerStage,
  TrackerRecord,
  TrackerSide,
  TrackerStageMeta,
  TrackerStatus,
} from "./types.js";
import { BUYER_STAGES, SELLER_STAGES, TRACKER_STATUSES } from "./types.js";

/**
 * Buyers & Sellers Tracker store.
 *
 * Own SQLite file, same shape as the other subsystem stores. Records are kept
 * separate from `Lead` rather than bolted onto it: a lead is an inbound contact,
 * a tracker record is a deal being worked, and the two have different lifecycles
 * (a lead can exist with no tracker row, and a tracker row can outlive the lead
 * record it was created from). `leadId` links them when there is a link.
 */

function resolveTrackerDbPath(): string {
  const explicit = process.env.TRACKER_DB_PATH?.trim();
  if (explicit) return explicit;
  const flyDir = "/data";
  if (existsSync(flyDir)) return join(flyDir, "tracker.db");
  return join(process.cwd(), "data", "tracker.db");
}

const TRACKER_DB_PATH = resolveTrackerDbPath();

let db: Database.Database | null = null;

export function getTrackerDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(TRACKER_DB_PATH), { recursive: true });
  db = new Database(TRACKER_DB_PATH);
  db.pragma("journal_mode = WAL");
  initTrackerSchema(db);
  return db;
}

export function initTrackerSchema(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS tracker_records (
      id                 TEXT PRIMARY KEY,
      lead_id            TEXT,
      sides              TEXT NOT NULL DEFAULT '["buyer"]',
      name               TEXT NOT NULL,
      phone              TEXT,
      email              TEXT,
      address            TEXT,
      source             TEXT,
      status             TEXT NOT NULL DEFAULT 'new',
      buyer_stage        TEXT,
      seller_stage       TEXT,
      stage_meta         TEXT,
      notes              TEXT,
      checklist          TEXT,
      task_ids           TEXT,
      assigned_to        TEXT,
      last_interaction_at TEXT,
      added_at           TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      legacy_stage       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_lead   ON tracker_records(lead_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_status ON tracker_records(status);
    CREATE INDEX IF NOT EXISTS idx_tracker_added  ON tracker_records(added_at);
    CREATE INDEX IF NOT EXISTS idx_tracker_buyer  ON tracker_records(buyer_stage);
    CREATE INDEX IF NOT EXISTS idx_tracker_seller ON tracker_records(seller_stage);
  `);
}

const BUYER_KEYS = new Set<string>(BUYER_STAGES.map((s) => s.key));
const SELLER_KEYS = new Set<string>(SELLER_STAGES.map((s) => s.key));
const STATUS_KEYS = new Set<string>(TRACKER_STATUSES);

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(r: Record<string, unknown>): TrackerRecord {
  return {
    id: String(r.id),
    leadId: (r.lead_id as string) || undefined,
    sides: parseJson<TrackerSide[]>(r.sides, ["buyer"]),
    name: String(r.name || ""),
    phone: (r.phone as string) || undefined,
    email: (r.email as string) || undefined,
    address: (r.address as string) || undefined,
    source: (r.source as string) || undefined,
    status: (r.status as TrackerStatus) || "new",
    buyerStage: (r.buyer_stage as BuyerStage) || undefined,
    sellerStage: (r.seller_stage as SellerStage) || undefined,
    stageMeta: parseJson<Record<string, TrackerStageMeta>>(r.stage_meta, {}),
    notes: (r.notes as string) || undefined,
    checklist: parseJson<CommandTaskChecklistItem[]>(r.checklist, []),
    taskIds: parseJson<string[]>(r.task_ids, []),
    assignedTo: (r.assigned_to as string) || undefined,
    lastInteractionAt: (r.last_interaction_at as string) || undefined,
    addedAt: String(r.added_at),
    updatedAt: String(r.updated_at),
    legacyStage: (r.legacy_stage as string) || undefined,
  };
}

function genId(): string {
  return `trk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Coerce anything inbound into a valid side list; never empty. */
export function normalizeSides(raw: unknown): TrackerSide[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = list.filter((s): s is TrackerSide => s === "buyer" || s === "seller");
  return out.length ? Array.from(new Set(out)) : ["buyer"];
}

export function normalizeStatus(raw: unknown): TrackerStatus {
  return STATUS_KEYS.has(String(raw)) ? (String(raw) as TrackerStatus) : "new";
}

export function normalizeBuyerStage(raw: unknown): BuyerStage | undefined {
  const v = String(raw ?? "");
  return BUYER_KEYS.has(v) ? (v as BuyerStage) : undefined;
}

export function normalizeSellerStage(raw: unknown): SellerStage | undefined {
  const v = String(raw ?? "");
  return SELLER_KEYS.has(v) ? (v as SellerStage) : undefined;
}

export interface TrackerFilter {
  side?: TrackerSide;
  status?: TrackerStatus[];
  buyerStage?: BuyerStage[];
  sellerStage?: SellerStage[];
  source?: string[];
  assignedTo?: string;
  /** Free text across name / phone / email / address. */
  q?: string;
  addedFrom?: string;
  addedTo?: string;
  interactionFrom?: string;
  interactionTo?: string;
}

export function listTrackerRecords(filter: TrackerFilter = {}): TrackerRecord[] {
  const conn = getTrackerDb();
  const rows = conn.prepare("SELECT * FROM tracker_records ORDER BY updated_at DESC").all() as Array<
    Record<string, unknown>
  >;
  let out = rows.map(rowToRecord);

  if (filter.side) out = out.filter((r) => r.sides.includes(filter.side!));
  if (filter.status?.length) out = out.filter((r) => filter.status!.includes(r.status));
  if (filter.buyerStage?.length) {
    out = out.filter((r) => r.buyerStage && filter.buyerStage!.includes(r.buyerStage));
  }
  if (filter.sellerStage?.length) {
    out = out.filter((r) => r.sellerStage && filter.sellerStage!.includes(r.sellerStage));
  }
  if (filter.source?.length) {
    const want = filter.source.map((s) => s.toLowerCase());
    out = out.filter((r) => want.includes(String(r.source || "").toLowerCase()));
  }
  if (filter.assignedTo) {
    out = out.filter((r) => (r.assignedTo || "").toLowerCase() === filter.assignedTo!.toLowerCase());
  }
  if (filter.q) {
    const q = filter.q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    out = out.filter((r) => {
      const hay = `${r.name} ${r.email || ""} ${r.address || ""}`.toLowerCase();
      if (hay.includes(q)) return true;
      if (digits.length >= 4) {
        return String(r.phone || "").replace(/\D/g, "").includes(digits);
      }
      return false;
    });
  }
  const inRange = (v: string | undefined, from?: string, to?: string) => {
    const d = String(v || "").slice(0, 10);
    if (!d) return !from && !to;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };
  if (filter.addedFrom || filter.addedTo) {
    out = out.filter((r) => inRange(r.addedAt, filter.addedFrom, filter.addedTo));
  }
  if (filter.interactionFrom || filter.interactionTo) {
    out = out.filter((r) => inRange(r.lastInteractionAt, filter.interactionFrom, filter.interactionTo));
  }
  return out;
}

export function getTrackerRecord(id: string): TrackerRecord | null {
  const row = getTrackerDb()
    .prepare("SELECT * FROM tracker_records WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

export function getTrackerRecordByLead(leadId: string): TrackerRecord | null {
  const row = getTrackerDb()
    .prepare("SELECT * FROM tracker_records WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1")
    .get(leadId) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

export interface TrackerInput {
  leadId?: string;
  sides?: unknown;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  source?: string;
  status?: unknown;
  buyerStage?: unknown;
  sellerStage?: unknown;
  stageMeta?: Record<string, TrackerStageMeta>;
  notes?: string;
  checklist?: CommandTaskChecklistItem[];
  taskIds?: string[];
  assignedTo?: string;
  lastInteractionAt?: string;
  legacyStage?: string;
  addedAt?: string;
}

export function createTrackerRecord(input: TrackerInput): TrackerRecord {
  const conn = getTrackerDb();
  const now = new Date().toISOString();
  const rec: TrackerRecord = {
    id: genId(),
    leadId: input.leadId,
    sides: normalizeSides(input.sides),
    name: String(input.name || "").trim() || "Unnamed",
    phone: input.phone,
    email: input.email,
    address: input.address,
    source: input.source,
    status: normalizeStatus(input.status),
    buyerStage: normalizeBuyerStage(input.buyerStage),
    sellerStage: normalizeSellerStage(input.sellerStage),
    stageMeta: input.stageMeta || {},
    notes: input.notes,
    checklist: input.checklist || [],
    taskIds: input.taskIds || [],
    assignedTo: input.assignedTo,
    lastInteractionAt: input.lastInteractionAt,
    addedAt: input.addedAt || now,
    updatedAt: now,
    legacyStage: input.legacyStage,
  };
  conn
    .prepare(
      `INSERT INTO tracker_records
       (id, lead_id, sides, name, phone, email, address, source, status, buyer_stage, seller_stage,
        stage_meta, notes, checklist, task_ids, assigned_to, last_interaction_at, added_at, updated_at, legacy_stage)
       VALUES (@id,@lead_id,@sides,@name,@phone,@email,@address,@source,@status,@buyer_stage,@seller_stage,
               @stage_meta,@notes,@checklist,@task_ids,@assigned_to,@last_interaction_at,@added_at,@updated_at,@legacy_stage)`,
    )
    .run({
      id: rec.id,
      lead_id: rec.leadId ?? null,
      sides: JSON.stringify(rec.sides),
      name: rec.name,
      phone: rec.phone ?? null,
      email: rec.email ?? null,
      address: rec.address ?? null,
      source: rec.source ?? null,
      status: rec.status,
      buyer_stage: rec.buyerStage ?? null,
      seller_stage: rec.sellerStage ?? null,
      stage_meta: JSON.stringify(rec.stageMeta ?? {}),
      notes: rec.notes ?? null,
      checklist: JSON.stringify(rec.checklist ?? []),
      task_ids: JSON.stringify(rec.taskIds ?? []),
      assigned_to: rec.assignedTo ?? null,
      last_interaction_at: rec.lastInteractionAt ?? null,
      added_at: rec.addedAt,
      updated_at: rec.updatedAt,
      legacy_stage: rec.legacyStage ?? null,
    });
  return rec;
}

const FIELD_TO_COLUMN: Record<string, string> = {
  leadId: "lead_id",
  name: "name",
  phone: "phone",
  email: "email",
  address: "address",
  source: "source",
  notes: "notes",
  assignedTo: "assigned_to",
  lastInteractionAt: "last_interaction_at",
  legacyStage: "legacy_stage",
};

export function updateTrackerRecord(id: string, patch: Partial<TrackerInput>): TrackerRecord | null {
  const existing = getTrackerRecord(id);
  if (!existing) return null;
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (field in patch) {
      sets.push(`${column} = @${column}`);
      params[column] = (patch as Record<string, unknown>)[field] ?? null;
    }
  }
  if ("sides" in patch) {
    sets.push("sides = @sides");
    params.sides = JSON.stringify(normalizeSides(patch.sides));
  }
  if ("status" in patch) {
    sets.push("status = @status");
    params.status = normalizeStatus(patch.status);
  }
  // Stages accept null to clear a side, so `in patch` rather than truthiness.
  if ("buyerStage" in patch) {
    sets.push("buyer_stage = @buyer_stage");
    params.buyer_stage = normalizeBuyerStage(patch.buyerStage) ?? null;
  }
  if ("sellerStage" in patch) {
    sets.push("seller_stage = @seller_stage");
    params.seller_stage = normalizeSellerStage(patch.sellerStage) ?? null;
  }
  if ("stageMeta" in patch) {
    sets.push("stage_meta = @stage_meta");
    params.stage_meta = JSON.stringify(patch.stageMeta ?? {});
  }
  if ("checklist" in patch) {
    sets.push("checklist = @checklist");
    params.checklist = JSON.stringify(patch.checklist ?? []);
  }
  if ("taskIds" in patch) {
    sets.push("task_ids = @task_ids");
    params.task_ids = JSON.stringify(patch.taskIds ?? []);
  }
  if (!sets.length) return existing;

  sets.push("updated_at = @updated_at");
  params.updated_at = new Date().toISOString();
  getTrackerDb()
    .prepare(`UPDATE tracker_records SET ${sets.join(", ")} WHERE id = @id`)
    .run(params);
  return getTrackerRecord(id);
}

export function deleteTrackerRecord(id: string): boolean {
  const info = getTrackerDb().prepare("DELETE FROM tracker_records WHERE id = ?").run(id);
  return info.changes > 0;
}

/**
 * Move a record to a stage, stamping when it got there. Buyer > Qualified also
 * carries the buyer's timeline date, which is why this takes meta.
 */
export function setTrackerStage(
  id: string,
  side: TrackerSide,
  stage: string | null,
  meta?: TrackerStageMeta,
): TrackerRecord | null {
  const rec = getTrackerRecord(id);
  if (!rec) return null;
  const stageMeta = { ...(rec.stageMeta || {}) };
  const patch: Partial<TrackerInput> = {};

  if (side === "buyer") {
    const s = stage === null ? undefined : normalizeBuyerStage(stage);
    if (stage !== null && !s) return rec;
    patch.buyerStage = s ?? null;
    if (s) stageMeta[`buyer:${s}`] = { enteredAt: new Date().toISOString(), ...(meta || {}) };
  } else {
    const s = stage === null ? undefined : normalizeSellerStage(stage);
    if (stage !== null && !s) return rec;
    patch.sellerStage = s ?? null;
    if (s) stageMeta[`seller:${s}`] = { enteredAt: new Date().toISOString(), ...(meta || {}) };
  }
  patch.stageMeta = stageMeta;
  return updateTrackerRecord(id, patch);
}

export function trackerCounts(): {
  total: number;
  buyers: number;
  sellers: number;
  byStatus: Record<string, number>;
  byBuyerStage: Record<string, number>;
  bySellerStage: Record<string, number>;
} {
  const all = listTrackerRecords();
  const byStatus: Record<string, number> = {};
  const byBuyerStage: Record<string, number> = {};
  const bySellerStage: Record<string, number> = {};
  for (const r of all) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.buyerStage) byBuyerStage[r.buyerStage] = (byBuyerStage[r.buyerStage] || 0) + 1;
    if (r.sellerStage) bySellerStage[r.sellerStage] = (bySellerStage[r.sellerStage] || 0) + 1;
  }
  return {
    total: all.length,
    buyers: all.filter((r) => r.sides.includes("buyer")).length,
    sellers: all.filter((r) => r.sides.includes("seller")).length,
    byStatus,
    byBuyerStage,
    bySellerStage,
  };
}
