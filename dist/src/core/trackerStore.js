"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTrackerDb = getTrackerDb;
exports.initTrackerSchema = initTrackerSchema;
exports.normalizeSides = normalizeSides;
exports.normalizeStatus = normalizeStatus;
exports.normalizeBuyerStage = normalizeBuyerStage;
exports.normalizeSellerStage = normalizeSellerStage;
exports.listTrackerRecords = listTrackerRecords;
exports.getTrackerRecord = getTrackerRecord;
exports.getTrackerRecordByLead = getTrackerRecordByLead;
exports.createTrackerRecord = createTrackerRecord;
exports.updateTrackerRecord = updateTrackerRecord;
exports.deleteTrackerRecord = deleteTrackerRecord;
exports.setTrackerStage = setTrackerStage;
exports.trackerCounts = trackerCounts;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = require("path");
const types_js_1 = require("./types.js");
/**
 * Buyers & Sellers Tracker store.
 *
 * Own SQLite file, same shape as the other subsystem stores. Records are kept
 * separate from `Lead` rather than bolted onto it: a lead is an inbound contact,
 * a tracker record is a deal being worked, and the two have different lifecycles
 * (a lead can exist with no tracker row, and a tracker row can outlive the lead
 * record it was created from). `leadId` links them when there is a link.
 */
function resolveTrackerDbPath() {
    const explicit = process.env.TRACKER_DB_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDir = "/data";
    if ((0, fs_1.existsSync)(flyDir))
        return (0, path_1.join)(flyDir, "tracker.db");
    return (0, path_1.join)(process.cwd(), "data", "tracker.db");
}
const TRACKER_DB_PATH = resolveTrackerDbPath();
let db = null;
function getTrackerDb() {
    if (db)
        return db;
    (0, fs_1.mkdirSync)((0, path_1.dirname)(TRACKER_DB_PATH), { recursive: true });
    db = new better_sqlite3_1.default(TRACKER_DB_PATH);
    db.pragma("journal_mode = WAL");
    initTrackerSchema(db);
    return db;
}
function initTrackerSchema(conn) {
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
const BUYER_KEYS = new Set(types_js_1.BUYER_STAGES.map((s) => s.key));
const SELLER_KEYS = new Set(types_js_1.SELLER_STAGES.map((s) => s.key));
const STATUS_KEYS = new Set(types_js_1.TRACKER_STATUSES);
function parseJson(raw, fallback) {
    if (typeof raw !== "string" || !raw.trim())
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function rowToRecord(r) {
    return {
        id: String(r.id),
        leadId: r.lead_id || undefined,
        sides: parseJson(r.sides, ["buyer"]),
        name: String(r.name || ""),
        phone: r.phone || undefined,
        email: r.email || undefined,
        address: r.address || undefined,
        source: r.source || undefined,
        status: r.status || "new",
        buyerStage: r.buyer_stage || undefined,
        sellerStage: r.seller_stage || undefined,
        stageMeta: parseJson(r.stage_meta, {}),
        notes: r.notes || undefined,
        checklist: parseJson(r.checklist, []),
        taskIds: parseJson(r.task_ids, []),
        assignedTo: r.assigned_to || undefined,
        lastInteractionAt: r.last_interaction_at || undefined,
        addedAt: String(r.added_at),
        updatedAt: String(r.updated_at),
        legacyStage: r.legacy_stage || undefined,
    };
}
function genId() {
    return `trk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
/** Coerce anything inbound into a valid side list; never empty. */
function normalizeSides(raw) {
    const list = Array.isArray(raw) ? raw : [raw];
    const out = list.filter((s) => s === "buyer" || s === "seller");
    return out.length ? Array.from(new Set(out)) : ["buyer"];
}
function normalizeStatus(raw) {
    return STATUS_KEYS.has(String(raw)) ? String(raw) : "new";
}
function normalizeBuyerStage(raw) {
    const v = String(raw ?? "");
    return BUYER_KEYS.has(v) ? v : undefined;
}
function normalizeSellerStage(raw) {
    const v = String(raw ?? "");
    return SELLER_KEYS.has(v) ? v : undefined;
}
function listTrackerRecords(filter = {}) {
    const conn = getTrackerDb();
    const rows = conn.prepare("SELECT * FROM tracker_records ORDER BY updated_at DESC").all();
    let out = rows.map(rowToRecord);
    if (filter.side)
        out = out.filter((r) => r.sides.includes(filter.side));
    if (filter.status?.length)
        out = out.filter((r) => filter.status.includes(r.status));
    if (filter.buyerStage?.length) {
        out = out.filter((r) => r.buyerStage && filter.buyerStage.includes(r.buyerStage));
    }
    if (filter.sellerStage?.length) {
        out = out.filter((r) => r.sellerStage && filter.sellerStage.includes(r.sellerStage));
    }
    if (filter.source?.length) {
        const want = filter.source.map((s) => s.toLowerCase());
        out = out.filter((r) => want.includes(String(r.source || "").toLowerCase()));
    }
    if (filter.assignedTo) {
        out = out.filter((r) => (r.assignedTo || "").toLowerCase() === filter.assignedTo.toLowerCase());
    }
    if (filter.q) {
        const q = filter.q.toLowerCase();
        const digits = q.replace(/\D/g, "");
        out = out.filter((r) => {
            const hay = `${r.name} ${r.email || ""} ${r.address || ""}`.toLowerCase();
            if (hay.includes(q))
                return true;
            if (digits.length >= 4) {
                return String(r.phone || "").replace(/\D/g, "").includes(digits);
            }
            return false;
        });
    }
    const inRange = (v, from, to) => {
        const d = String(v || "").slice(0, 10);
        if (!d)
            return !from && !to;
        if (from && d < from)
            return false;
        if (to && d > to)
            return false;
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
function getTrackerRecord(id) {
    const row = getTrackerDb()
        .prepare("SELECT * FROM tracker_records WHERE id = ?")
        .get(id);
    return row ? rowToRecord(row) : null;
}
function getTrackerRecordByLead(leadId) {
    const row = getTrackerDb()
        .prepare("SELECT * FROM tracker_records WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1")
        .get(leadId);
    return row ? rowToRecord(row) : null;
}
function createTrackerRecord(input) {
    const conn = getTrackerDb();
    const now = new Date().toISOString();
    const rec = {
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
        .prepare(`INSERT INTO tracker_records
       (id, lead_id, sides, name, phone, email, address, source, status, buyer_stage, seller_stage,
        stage_meta, notes, checklist, task_ids, assigned_to, last_interaction_at, added_at, updated_at, legacy_stage)
       VALUES (@id,@lead_id,@sides,@name,@phone,@email,@address,@source,@status,@buyer_stage,@seller_stage,
               @stage_meta,@notes,@checklist,@task_ids,@assigned_to,@last_interaction_at,@added_at,@updated_at,@legacy_stage)`)
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
const FIELD_TO_COLUMN = {
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
function updateTrackerRecord(id, patch) {
    const existing = getTrackerRecord(id);
    if (!existing)
        return null;
    const sets = [];
    const params = { id };
    for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
        if (field in patch) {
            sets.push(`${column} = @${column}`);
            params[column] = patch[field] ?? null;
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
    if (!sets.length)
        return existing;
    sets.push("updated_at = @updated_at");
    params.updated_at = new Date().toISOString();
    getTrackerDb()
        .prepare(`UPDATE tracker_records SET ${sets.join(", ")} WHERE id = @id`)
        .run(params);
    return getTrackerRecord(id);
}
function deleteTrackerRecord(id) {
    const info = getTrackerDb().prepare("DELETE FROM tracker_records WHERE id = ?").run(id);
    return info.changes > 0;
}
/**
 * Move a record to a stage, stamping when it got there. Buyer > Qualified also
 * carries the buyer's timeline date, which is why this takes meta.
 */
function setTrackerStage(id, side, stage, meta) {
    const rec = getTrackerRecord(id);
    if (!rec)
        return null;
    const stageMeta = { ...(rec.stageMeta || {}) };
    const patch = {};
    if (side === "buyer") {
        const s = stage === null ? undefined : normalizeBuyerStage(stage);
        if (stage !== null && !s)
            return rec;
        patch.buyerStage = s ?? null;
        if (s)
            stageMeta[`buyer:${s}`] = { enteredAt: new Date().toISOString(), ...(meta || {}) };
    }
    else {
        const s = stage === null ? undefined : normalizeSellerStage(stage);
        if (stage !== null && !s)
            return rec;
        patch.sellerStage = s ?? null;
        if (s)
            stageMeta[`seller:${s}`] = { enteredAt: new Date().toISOString(), ...(meta || {}) };
    }
    patch.stageMeta = stageMeta;
    return updateTrackerRecord(id, patch);
}
function trackerCounts() {
    const all = listTrackerRecords();
    const byStatus = {};
    const byBuyerStage = {};
    const bySellerStage = {};
    for (const r of all) {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        if (r.buyerStage)
            byBuyerStage[r.buyerStage] = (byBuyerStage[r.buyerStage] || 0) + 1;
        if (r.sellerStage)
            bySellerStage[r.sellerStage] = (bySellerStage[r.sellerStage] || 0) + 1;
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
