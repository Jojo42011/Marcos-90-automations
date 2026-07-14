"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveVoiceCloneDataRoot = resolveVoiceCloneDataRoot;
exports.getVoiceCloneDb = getVoiceCloneDb;
exports.createVoiceoverRequest = createVoiceoverRequest;
exports.updateVoiceoverRequest = updateVoiceoverRequest;
exports.getVoiceoverRequest = getVoiceoverRequest;
exports.getPendingApprovalRequests = getPendingApprovalRequests;
exports.getApprovedQueuedRequests = getApprovedQueuedRequests;
exports.getAllRequests = getAllRequests;
exports.getPrimaryReferenceClip = getPrimaryReferenceClip;
exports.getReferenceClipById = getReferenceClipById;
exports.getAllReferenceClips = getAllReferenceClips;
exports.createReferenceClip = createReferenceClip;
exports.setPrimaryReferenceClip = setPrimaryReferenceClip;
exports.setReferenceClipVoiceId = setReferenceClipVoiceId;
exports.logSafetyBlock = logSafetyBlock;
exports.getSafetyLogEntries = getSafetyLogEntries;
exports.countPendingApprovalRequests = countPendingApprovalRequests;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
function resolveVoiceCloneDbPath() {
    const base = fs_1.default.existsSync("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
    fs_1.default.mkdirSync(base, { recursive: true });
    return path_1.default.join(base, "voice-clone.db");
}
function resolveVoiceCloneDataRoot() {
    const root = fs_1.default.existsSync("/data")
        ? "/data/voice-clone"
        : path_1.default.join(process.cwd(), "data", "voice-clone");
    for (const sub of ["reference", "generated", "exports"]) {
        fs_1.default.mkdirSync(path_1.default.join(root, sub), { recursive: true });
    }
    return root;
}
let db = null;
function getVoiceCloneDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveVoiceCloneDbPath());
        initVoiceCloneTables(db);
        resolveVoiceCloneDataRoot();
    }
    return db;
}
function initVoiceCloneTables(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS reference_clips (
      id TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      local_audio_path TEXT,
      duration_seconds REAL,
      quality_rating INTEGER,
      transcript TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL
    )
  `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_refclip_primary ON reference_clips(is_primary)`);
    // Persist the ElevenLabs cloned voice_id created from this reference clip so
    // generation reuses one clone instead of re-uploading every time. Guarded
    // ADD COLUMN — older DBs created before the ElevenLabs backend won't have it.
    const refCols = database.prepare(`PRAGMA table_info(reference_clips)`).all();
    if (!refCols.some((c) => c.name === "eleven_voice_id")) {
        database.exec(`ALTER TABLE reference_clips ADD COLUMN eleven_voice_id TEXT`);
    }
    database.exec(`
    CREATE TABLE IF NOT EXISTS voiceover_requests (
      id TEXT PRIMARY KEY,
      script TEXT NOT NULL,
      delivery_style TEXT NOT NULL,
      custom_style_description TEXT,
      format_type TEXT NOT NULL,
      hook_variation_count INTEGER DEFAULT 1,
      approval_status TEXT NOT NULL DEFAULT 'pending',
      approved_by TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      generation_status TEXT NOT NULL DEFAULT 'awaiting_approval',
      output_file_paths TEXT,
      export_file_path TEXT,
      reference_clip_id TEXT,
      voxcpm_mode TEXT DEFAULT 'ultimate',
      requested_by TEXT DEFAULT 'manual',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_voicereq_status ON voiceover_requests(generation_status)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_voicereq_approval ON voiceover_requests(approval_status)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_voicereq_created ON voiceover_requests(created_at)`);
    database.exec(`
    CREATE TABLE IF NOT EXISTS voice_clone_safety_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      script_preview TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_by TEXT,
      flagged_at TEXT NOT NULL
    )
  `);
}
function createVoiceoverRequest(req) {
    const database = getVoiceCloneDb();
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    database
        .prepare(`
    INSERT INTO voiceover_requests
      (id, script, delivery_style, custom_style_description, format_type, hook_variation_count,
       approval_status, generation_status, reference_clip_id, voxcpm_mode, requested_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'awaiting_approval', ?, ?, ?, ?, ?)
  `)
        .run(id, req.script, req.deliveryStyle, req.customStyleDescription || null, req.formatType, req.hookVariationCount || 1, req.referenceClipId || null, req.voxcpmMode || "ultimate", req.requestedBy || "manual", now, now);
    return {
        ...req,
        id,
        approvalStatus: "pending",
        generationStatus: "awaiting_approval",
        createdAt: now,
        updatedAt: now,
    };
}
function updateVoiceoverRequest(id, updates) {
    const database = getVoiceCloneDb();
    const now = new Date().toISOString();
    database
        .prepare(`
    UPDATE voiceover_requests SET
      approval_status = COALESCE(?, approval_status),
      approved_by = COALESCE(?, approved_by),
      approved_at = COALESCE(?, approved_at),
      rejection_reason = COALESCE(?, rejection_reason),
      generation_status = COALESCE(?, generation_status),
      output_file_paths = COALESCE(?, output_file_paths),
      export_file_path = COALESCE(?, export_file_path),
      error = COALESCE(?, error),
      updated_at = ?
    WHERE id = ?
  `)
        .run(updates.approvalStatus || null, updates.approvedBy || null, updates.approvedAt || null, updates.rejectionReason || null, updates.generationStatus || null, updates.outputFilePaths ? JSON.stringify(updates.outputFilePaths) : null, updates.exportFilePath || null, updates.error || null, now, id);
}
function getVoiceoverRequest(id) {
    const row = getVoiceCloneDb()
        .prepare(`SELECT * FROM voiceover_requests WHERE id = ?`)
        .get(id);
    return row ? rowToRequest(row) : null;
}
function getPendingApprovalRequests() {
    const rows = getVoiceCloneDb()
        .prepare(`SELECT * FROM voiceover_requests WHERE approval_status = 'pending' ORDER BY created_at DESC`)
        .all();
    return rows.map(rowToRequest);
}
function getApprovedQueuedRequests() {
    const rows = getVoiceCloneDb()
        .prepare(`SELECT * FROM voiceover_requests WHERE approval_status = 'approved' AND generation_status = 'queued' ORDER BY created_at ASC`)
        .all();
    return rows.map(rowToRequest);
}
function getAllRequests(limit = 50) {
    const rows = getVoiceCloneDb()
        .prepare(`SELECT * FROM voiceover_requests ORDER BY created_at DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToRequest);
}
function getPrimaryReferenceClip() {
    const row = getVoiceCloneDb()
        .prepare(`SELECT * FROM reference_clips WHERE is_primary = 1 LIMIT 1`)
        .get();
    return row ? rowToClip(row) : null;
}
function getReferenceClipById(id) {
    const row = getVoiceCloneDb()
        .prepare(`SELECT * FROM reference_clips WHERE id = ?`)
        .get(id);
    return row ? rowToClip(row) : null;
}
function getAllReferenceClips() {
    const rows = getVoiceCloneDb()
        .prepare(`SELECT * FROM reference_clips ORDER BY quality_rating DESC`)
        .all();
    return rows.map(rowToClip);
}
function createReferenceClip(clip) {
    const database = getVoiceCloneDb();
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    database
        .prepare(`
    INSERT INTO reference_clips (id, source_url, local_audio_path, duration_seconds, quality_rating, transcript, is_primary, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
        .run(id, clip.sourceUrl, clip.localAudioPath || null, clip.durationSeconds || null, clip.qualityRating || null, clip.transcript || null, clip.isPrimary ? 1 : 0, now);
    return { ...clip, id, addedAt: now };
}
function setPrimaryReferenceClip(id) {
    const database = getVoiceCloneDb();
    database.prepare(`UPDATE reference_clips SET is_primary = 0`).run();
    database.prepare(`UPDATE reference_clips SET is_primary = 1 WHERE id = ?`).run(id);
}
function setReferenceClipVoiceId(id, elevenVoiceId) {
    getVoiceCloneDb()
        .prepare(`UPDATE reference_clips SET eleven_voice_id = ? WHERE id = ?`)
        .run(elevenVoiceId, id);
}
function logSafetyBlock(requestId, scriptPreview, reason, requestedBy) {
    getVoiceCloneDb()
        .prepare(`
    INSERT INTO voice_clone_safety_log (request_id, script_preview, reason, requested_by, flagged_at)
    VALUES (?, ?, ?, ?, ?)
  `)
        .run(requestId, scriptPreview.substring(0, 200), reason, requestedBy || null, new Date().toISOString());
}
function getSafetyLogEntries(limit = 100) {
    const rows = getVoiceCloneDb()
        .prepare(`SELECT * FROM voice_clone_safety_log ORDER BY flagged_at DESC LIMIT ?`)
        .all(limit);
    return rows.map((row) => ({
        id: Number(row.id),
        requestId: String(row.request_id),
        scriptPreview: String(row.script_preview),
        reason: String(row.reason),
        requestedBy: row.requested_by ? String(row.requested_by) : undefined,
        flaggedAt: String(row.flagged_at),
    }));
}
function countPendingApprovalRequests() {
    const row = getVoiceCloneDb()
        .prepare(`SELECT COUNT(*) AS n FROM voiceover_requests WHERE approval_status = 'pending'`)
        .get();
    return row?.n ?? 0;
}
function rowToRequest(row) {
    return {
        id: String(row.id),
        script: String(row.script),
        deliveryStyle: row.delivery_style,
        customStyleDescription: row.custom_style_description
            ? String(row.custom_style_description)
            : undefined,
        formatType: row.format_type,
        hookVariationCount: Number(row.hook_variation_count) || 1,
        approvalStatus: row.approval_status,
        approvedBy: row.approved_by ? String(row.approved_by) : undefined,
        approvedAt: row.approved_at ? String(row.approved_at) : undefined,
        rejectionReason: row.rejection_reason ? String(row.rejection_reason) : undefined,
        generationStatus: row.generation_status,
        outputFilePaths: row.output_file_paths
            ? JSON.parse(String(row.output_file_paths))
            : undefined,
        exportFilePath: row.export_file_path ? String(row.export_file_path) : undefined,
        referenceClipId: row.reference_clip_id ? String(row.reference_clip_id) : undefined,
        voxcpmMode: row.voxcpm_mode || "ultimate",
        requestedBy: row.requested_by ? String(row.requested_by) : undefined,
        error: row.error ? String(row.error) : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}
function rowToClip(row) {
    return {
        id: String(row.id),
        sourceUrl: String(row.source_url),
        localAudioPath: row.local_audio_path ? String(row.local_audio_path) : undefined,
        durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : undefined,
        qualityRating: row.quality_rating != null ? Number(row.quality_rating) : undefined,
        transcript: row.transcript ? String(row.transcript) : undefined,
        isPrimary: row.is_primary === 1,
        elevenVoiceId: row.eleven_voice_id ? String(row.eleven_voice_id) : undefined,
        addedAt: String(row.added_at),
    };
}
