import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

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

function resolveJobsDbPath(): string {
  const explicit = process.env.JOBS_DB_PATH?.trim();
  if (explicit) return explicit;
  const flyDir = "/data";
  if (existsSync(flyDir)) return join(flyDir, "jobs.db");
  return join(process.cwd(), "data", "jobs.db");
}

const JOBS_DB_PATH = resolveJobsDbPath();
let db: Database.Database | null = null;

export function getJobsDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(JOBS_DB_PATH), { recursive: true });
  db = new Database(JOBS_DB_PATH);
  db.pragma("journal_mode = WAL");
  initJobSchema(db);
  return db;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface JobStep {
  n: number;
  kind: "thought" | "tool" | "result" | "error";
  tool?: string;
  input?: string;
  output?: string;
  text?: string;
  /**
   * Workspace path this step wrote, recorded as a first-class field.
   *
   * `input` is truncated to 600 chars so a big write_file does not bloat the
   * job record — which meant the UI, which used to recover the path by
   * JSON.parse-ing `input`, silently found nothing whenever the file was large
   * enough to matter. A produced file that the UI cannot link to might as well
   * not exist, so the path is stored separately and never parsed out of
   * truncated text.
   */
  file?: string;
  at: string;
}

export interface Job {
  id: string;
  prompt: string;
  status: JobStatus;
  steps: JobStep[];
  result: string | null;
  error: string | null;
  toolCalls: number;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Set when the caller asks to stop; the runner checks it between steps. */
  cancelRequested: boolean;
}

export function initJobSchema(database: Database.Database = getJobsDb()): void {
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

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToJob(r: Record<string, unknown>): Job {
  return {
    id: String(r.id),
    prompt: String(r.prompt),
    status: String(r.status) as JobStatus,
    steps: parseJson<JobStep[]>(r.steps, []),
    result: (r.result as string) ?? null,
    error: (r.error as string) ?? null,
    toolCalls: Number(r.tool_calls || 0),
    createdBy: String(r.created_by || "marco"),
    createdAt: String(r.created_at),
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
    cancelRequested: Number(r.cancel_requested || 0) === 1,
  };
}

export function createJob(prompt: string, createdBy = "marco"): Job {
  const database = getJobsDb();
  const id = `job_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO jobs (id, prompt, status, steps, created_by, created_at)
       VALUES (?, ?, 'queued', '[]', ?, ?)`,
    )
    .run(id, prompt, createdBy, now);
  return getJob(id)!;
}

export function getJob(id: string): Job | null {
  const r = getJobsDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToJob(r) : null;
}

export function listJobs(limit = 30, status?: JobStatus): Job[] {
  const database = getJobsDb();
  const rows = status
    ? database
        .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(status, limit)
    : database.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
  return (rows as Record<string, unknown>[]).map(rowToJob);
}

export function markRunning(id: string): void {
  getJobsDb()
    .prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

/** Append a step. Kept as one JSON column: jobs are short and read whole. */
export function appendStep(id: string, step: Omit<JobStep, "n" | "at">): JobStep | null {
  const job = getJob(id);
  if (!job) return null;
  const full: JobStep = { ...step, n: job.steps.length + 1, at: new Date().toISOString() };
  const steps = [...job.steps, full];
  getJobsDb()
    .prepare(`UPDATE jobs SET steps = ?, tool_calls = ? WHERE id = ?`)
    .run(
      JSON.stringify(steps),
      steps.filter((s) => s.kind === "tool").length,
      id,
    );
  return full;
}

export function finishJob(
  id: string,
  status: Extract<JobStatus, "done" | "failed" | "cancelled" | "interrupted">,
  payload: { result?: string; error?: string } = {},
): Job | null {
  getJobsDb()
    .prepare(`UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?`)
    .run(status, payload.result ?? null, payload.error ?? null, new Date().toISOString(), id);
  return getJob(id);
}

export function requestCancel(id: string): boolean {
  const job = getJob(id);
  if (!job) return false;
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return false;
  getJobsDb().prepare(`UPDATE jobs SET cancel_requested = 1 WHERE id = ?`).run(id);
  return true;
}

export function isCancelRequested(id: string): boolean {
  const r = getJobsDb().prepare(`SELECT cancel_requested FROM jobs WHERE id = ?`).get(id) as
    | { cancel_requested: number }
    | undefined;
  return Boolean(r && r.cancel_requested);
}

/**
 * A job left 'running' when the process died cannot still be running — nothing
 * resumes it. Mark it interrupted at boot so the UI shows the truth instead of
 * a job that appears live forever.
 */
export function reconcileOrphanedJobs(): number {
  const database = getJobsDb();
  const orphans = database
    .prepare(`SELECT id FROM jobs WHERE status IN ('running','queued')`)
    .all() as { id: string }[];
  if (!orphans.length) return 0;
  const now = new Date().toISOString();
  const stmt = database.prepare(
    `UPDATE jobs SET status = 'interrupted', error = ?, finished_at = ? WHERE id = ?`,
  );
  for (const o of orphans) {
    stmt.run("The server restarted while this job was running.", now, o.id);
  }
  return orphans.length;
}

export function jobCounts(): Record<string, number> {
  const rows = getJobsDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`)
    .all() as { status: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}
