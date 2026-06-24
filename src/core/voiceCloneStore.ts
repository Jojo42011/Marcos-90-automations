import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

function resolveVoiceCloneDbPath(): string {
  const base = fs.existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "voice-clone.db");
}

export function resolveVoiceCloneDataRoot(): string {
  const root = fs.existsSync("/data")
    ? "/data/voice-clone"
    : path.join(process.cwd(), "data", "voice-clone");
  for (const sub of ["reference", "generated", "exports"]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

let db: Database.Database | null = null;

export function getVoiceCloneDb(): Database.Database {
  if (!db) {
    db = new Database(resolveVoiceCloneDbPath());
    initVoiceCloneTables(db);
    resolveVoiceCloneDataRoot();
  }
  return db;
}

function initVoiceCloneTables(database: Database.Database): void {
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

export type DeliveryStyle = "energetic_hook" | "calm_explainer" | "warm_client" | "custom";
export type FormatType = "hook" | "explainer" | "client_message" | "full_video";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "blocked";
export type GenerationStatus =
  | "awaiting_approval"
  | "queued"
  | "generating"
  | "complete"
  | "failed";
export type VoxCpmMode = "controllable" | "ultimate";

export interface VoiceoverRequest {
  id?: string;
  script: string;
  deliveryStyle: DeliveryStyle;
  customStyleDescription?: string;
  formatType: FormatType;
  hookVariationCount?: number;
  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  rejectionReason?: string;
  generationStatus: GenerationStatus;
  outputFilePaths?: string[];
  exportFilePath?: string;
  referenceClipId?: string;
  voxcpmMode?: VoxCpmMode;
  requestedBy?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReferenceClip {
  id?: string;
  sourceUrl: string;
  localAudioPath?: string;
  durationSeconds?: number;
  qualityRating?: number;
  transcript?: string;
  isPrimary: boolean;
  addedAt?: string;
}

export interface SafetyLogEntry {
  id: number;
  requestId: string;
  scriptPreview: string;
  reason: string;
  requestedBy?: string;
  flaggedAt: string;
}

export function createVoiceoverRequest(
  req: Omit<
    VoiceoverRequest,
    "id" | "createdAt" | "updatedAt" | "approvalStatus" | "generationStatus"
  >,
): VoiceoverRequest {
  const database = getVoiceCloneDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  database
    .prepare(
      `
    INSERT INTO voiceover_requests
      (id, script, delivery_style, custom_style_description, format_type, hook_variation_count,
       approval_status, generation_status, reference_clip_id, voxcpm_mode, requested_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'awaiting_approval', ?, ?, ?, ?, ?)
  `,
    )
    .run(
      id,
      req.script,
      req.deliveryStyle,
      req.customStyleDescription || null,
      req.formatType,
      req.hookVariationCount || 1,
      req.referenceClipId || null,
      req.voxcpmMode || "ultimate",
      req.requestedBy || "manual",
      now,
      now,
    );

  return {
    ...req,
    id,
    approvalStatus: "pending",
    generationStatus: "awaiting_approval",
    createdAt: now,
    updatedAt: now,
  };
}

export function updateVoiceoverRequest(id: string, updates: Partial<VoiceoverRequest>): void {
  const database = getVoiceCloneDb();
  const now = new Date().toISOString();

  database
    .prepare(
      `
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
  `,
    )
    .run(
      updates.approvalStatus || null,
      updates.approvedBy || null,
      updates.approvedAt || null,
      updates.rejectionReason || null,
      updates.generationStatus || null,
      updates.outputFilePaths ? JSON.stringify(updates.outputFilePaths) : null,
      updates.exportFilePath || null,
      updates.error || null,
      now,
      id,
    );
}

export function getVoiceoverRequest(id: string): VoiceoverRequest | null {
  const row = getVoiceCloneDb()
    .prepare(`SELECT * FROM voiceover_requests WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToRequest(row) : null;
}

export function getPendingApprovalRequests(): VoiceoverRequest[] {
  const rows = getVoiceCloneDb()
    .prepare(
      `SELECT * FROM voiceover_requests WHERE approval_status = 'pending' ORDER BY created_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToRequest);
}

export function getApprovedQueuedRequests(): VoiceoverRequest[] {
  const rows = getVoiceCloneDb()
    .prepare(
      `SELECT * FROM voiceover_requests WHERE approval_status = 'approved' AND generation_status = 'queued' ORDER BY created_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToRequest);
}

export function getAllRequests(limit = 50): VoiceoverRequest[] {
  const rows = getVoiceCloneDb()
    .prepare(`SELECT * FROM voiceover_requests ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToRequest);
}

export function getPrimaryReferenceClip(): ReferenceClip | null {
  const row = getVoiceCloneDb()
    .prepare(`SELECT * FROM reference_clips WHERE is_primary = 1 LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return row ? rowToClip(row) : null;
}

export function getReferenceClipById(id: string): ReferenceClip | null {
  const row = getVoiceCloneDb()
    .prepare(`SELECT * FROM reference_clips WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToClip(row) : null;
}

export function getAllReferenceClips(): ReferenceClip[] {
  const rows = getVoiceCloneDb()
    .prepare(`SELECT * FROM reference_clips ORDER BY quality_rating DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToClip);
}

export function createReferenceClip(clip: Omit<ReferenceClip, "id" | "addedAt">): ReferenceClip {
  const database = getVoiceCloneDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `
    INSERT INTO reference_clips (id, source_url, local_audio_path, duration_seconds, quality_rating, transcript, is_primary, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      id,
      clip.sourceUrl,
      clip.localAudioPath || null,
      clip.durationSeconds || null,
      clip.qualityRating || null,
      clip.transcript || null,
      clip.isPrimary ? 1 : 0,
      now,
    );
  return { ...clip, id, addedAt: now };
}

export function setPrimaryReferenceClip(id: string): void {
  const database = getVoiceCloneDb();
  database.prepare(`UPDATE reference_clips SET is_primary = 0`).run();
  database.prepare(`UPDATE reference_clips SET is_primary = 1 WHERE id = ?`).run(id);
}

export function logSafetyBlock(
  requestId: string,
  scriptPreview: string,
  reason: string,
  requestedBy?: string,
): void {
  getVoiceCloneDb()
    .prepare(
      `
    INSERT INTO voice_clone_safety_log (request_id, script_preview, reason, requested_by, flagged_at)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(
      requestId,
      scriptPreview.substring(0, 200),
      reason,
      requestedBy || null,
      new Date().toISOString(),
    );
}

export function getSafetyLogEntries(limit = 100): SafetyLogEntry[] {
  const rows = getVoiceCloneDb()
    .prepare(`SELECT * FROM voice_clone_safety_log ORDER BY flagged_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    requestId: String(row.request_id),
    scriptPreview: String(row.script_preview),
    reason: String(row.reason),
    requestedBy: row.requested_by ? String(row.requested_by) : undefined,
    flaggedAt: String(row.flagged_at),
  }));
}

export function countPendingApprovalRequests(): number {
  const row = getVoiceCloneDb()
    .prepare(`SELECT COUNT(*) AS n FROM voiceover_requests WHERE approval_status = 'pending'`)
    .get() as { n: number };
  return row?.n ?? 0;
}

function rowToRequest(row: Record<string, unknown>): VoiceoverRequest {
  return {
    id: String(row.id),
    script: String(row.script),
    deliveryStyle: row.delivery_style as DeliveryStyle,
    customStyleDescription: row.custom_style_description
      ? String(row.custom_style_description)
      : undefined,
    formatType: row.format_type as FormatType,
    hookVariationCount: Number(row.hook_variation_count) || 1,
    approvalStatus: row.approval_status as ApprovalStatus,
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    rejectionReason: row.rejection_reason ? String(row.rejection_reason) : undefined,
    generationStatus: row.generation_status as GenerationStatus,
    outputFilePaths: row.output_file_paths
      ? (JSON.parse(String(row.output_file_paths)) as string[])
      : undefined,
    exportFilePath: row.export_file_path ? String(row.export_file_path) : undefined,
    referenceClipId: row.reference_clip_id ? String(row.reference_clip_id) : undefined,
    voxcpmMode: (row.voxcpm_mode as VoxCpmMode) || "ultimate",
    requestedBy: row.requested_by ? String(row.requested_by) : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToClip(row: Record<string, unknown>): ReferenceClip {
  return {
    id: String(row.id),
    sourceUrl: String(row.source_url),
    localAudioPath: row.local_audio_path ? String(row.local_audio_path) : undefined,
    durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : undefined,
    qualityRating: row.quality_rating != null ? Number(row.quality_rating) : undefined,
    transcript: row.transcript ? String(row.transcript) : undefined,
    isPrimary: row.is_primary === 1,
    addedAt: String(row.added_at),
  };
}
