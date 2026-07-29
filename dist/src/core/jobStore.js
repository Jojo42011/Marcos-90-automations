"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJobsDb = getJobsDb;
exports.initJobSchema = initJobSchema;
exports.createJob = createJob;
exports.getJob = getJob;
exports.listJobs = listJobs;
exports.markRunning = markRunning;
exports.appendStep = appendStep;
exports.finishJob = finishJob;
exports.deleteJob = deleteJob;
exports.requestCancel = requestCancel;
exports.isCancelRequested = isCancelRequested;
exports.reconcileOrphanedJobs = reconcileOrphanedJobs;
exports.jobCounts = jobCounts;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
/**
 * Harvey job store.
 *
 * Harvey's agent loop ran inside the HTTP request that started it and stopped
 * after 8 tool rounds, so anything longer than a quick question could not be
 * delegated — the request would time out mid-work and nothing would be left
 * behind. A job is that work made durable: the prompt, every step taken, and the
 * outcome, all on disk.
 *
 * Persistence is the point. A job that only lived in memory would vanish on the
 * next deploy, which on a single machine is roughly once a day.
 */
function resolveJobsDbPath() {
    const explicit = process.env.JOBS_DB_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDir = "/data";
    if ((0, fs_1.existsSync)(flyDir))
        return (0, path_1.join)(flyDir, "jobs.db");
    return (0, path_1.join)(process.cwd(), "data", "jobs.db");
}
const JOBS_DB_PATH = resolveJobsDbPath();
let db = null;
function getJobsDb() {
    if (db)
        return db;
    (0, fs_1.mkdirSync)((0, path_1.dirname)(JOBS_DB_PATH), { recursive: true });
    db = new better_sqlite3_1.default(JOBS_DB_PATH);
    db.pragma("journal_mode = WAL");
    initJobSchema(db);
    return db;
}
function initJobSchema(database = getJobsDb()) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id                TEXT PRIMARY KEY,
      prompt            TEXT NOT NULL,
      status            TEXT NOT NULL,
      steps             TEXT NOT NULL DEFAULT '[]',
      result            TEXT,
      error             TEXT,
      tool_calls        INTEGER NOT NULL DEFAULT 0,
      created_by        TEXT NOT NULL DEFAULT 'marco',
      created_at        TEXT NOT NULL,
      started_at        TEXT,
      finished_at       TEXT,
      cancel_requested  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
  `);
}
function parseJson(raw, fallback) {
    if (typeof raw !== "string" || !raw)
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function rowToJob(r) {
    return {
        id: String(r.id),
        prompt: String(r.prompt),
        status: String(r.status),
        steps: parseJson(r.steps, []),
        result: r.result ?? null,
        error: r.error ?? null,
        toolCalls: Number(r.tool_calls || 0),
        createdBy: String(r.created_by || "marco"),
        createdAt: String(r.created_at),
        startedAt: r.started_at ?? null,
        finishedAt: r.finished_at ?? null,
        cancelRequested: Number(r.cancel_requested || 0) === 1,
    };
}
function createJob(prompt, createdBy = "marco") {
    const database = getJobsDb();
    const id = `job_${Date.now().toString(36)}_${(0, crypto_1.randomUUID)().slice(0, 6)}`;
    const now = new Date().toISOString();
    database
        .prepare(`INSERT INTO jobs (id, prompt, status, steps, created_by, created_at)
       VALUES (?, ?, 'queued', '[]', ?, ?)`)
        .run(id, prompt, createdBy, now);
    return getJob(id);
}
function getJob(id) {
    const r = getJobsDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
    return r ? rowToJob(r) : null;
}
function listJobs(limit = 30, status) {
    const database = getJobsDb();
    const rows = status
        ? database
            .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
            .all(status, limit)
        : database.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
    return rows.map(rowToJob);
}
function markRunning(id) {
    getJobsDb()
        .prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), id);
}
/** Append a step. Kept as one JSON column: jobs are short and read whole. */
function appendStep(id, step) {
    const job = getJob(id);
    if (!job)
        return null;
    const full = { ...step, n: job.steps.length + 1, at: new Date().toISOString() };
    const steps = [...job.steps, full];
    getJobsDb()
        .prepare(`UPDATE jobs SET steps = ?, tool_calls = ? WHERE id = ?`)
        .run(JSON.stringify(steps), steps.filter((s) => s.kind === "tool").length, id);
    return full;
}
function finishJob(id, status, payload = {}) {
    getJobsDb()
        .prepare(`UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?`)
        .run(status, payload.result ?? null, payload.error ?? null, new Date().toISOString(), id);
    return getJob(id);
}
/**
 * Remove a job and its record.
 *
 * A job that is still running is cancelled rather than deleted — deleting the row
 * out from under the runner would leave it writing steps to a job that no longer
 * exists, and `appendStep` would silently no-op while the work carried on
 * invisibly. Cancel first, then it can be deleted once it has stopped.
 *
 * The workspace files a job produced are deliberately NOT touched: they are the
 * output, they outlive the record of how they were made, and quietly deleting a
 * call list because someone tidied a job list would be the wrong surprise.
 */
function deleteJob(id) {
    const job = getJob(id);
    if (!job)
        return { deleted: false, reason: "No job with that id." };
    if (job.status === "running" || job.status === "queued") {
        return { deleted: false, reason: "That job is still running — cancel it first, then delete it." };
    }
    getJobsDb().prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
    return { deleted: true };
}
function requestCancel(id) {
    const job = getJob(id);
    if (!job)
        return false;
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled")
        return false;
    getJobsDb().prepare(`UPDATE jobs SET cancel_requested = 1 WHERE id = ?`).run(id);
    return true;
}
function isCancelRequested(id) {
    const r = getJobsDb().prepare(`SELECT cancel_requested FROM jobs WHERE id = ?`).get(id);
    return Boolean(r && r.cancel_requested);
}
/**
 * A job left 'running' when the process died cannot still be running — nothing
 * resumes it. Mark it interrupted at boot so the UI shows the truth instead of
 * a job that appears live forever.
 */
function reconcileOrphanedJobs() {
    const database = getJobsDb();
    const orphans = database
        .prepare(`SELECT id FROM jobs WHERE status IN ('running','queued')`)
        .all();
    if (!orphans.length)
        return 0;
    const now = new Date().toISOString();
    const stmt = database.prepare(`UPDATE jobs SET status = 'interrupted', error = ?, finished_at = ? WHERE id = ?`);
    for (const o of orphans) {
        stmt.run("The server restarted while this job was running.", now, o.id);
    }
    return orphans.length;
}
function jobCounts() {
    const rows = getJobsDb()
        .prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`)
        .all();
    const out = {};
    for (const r of rows)
        out[r.status] = r.n;
    return out;
}
