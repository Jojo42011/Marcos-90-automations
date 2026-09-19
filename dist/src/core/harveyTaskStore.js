"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHarveyTaskDb = getHarveyTaskDb;
exports.initHarveyTaskSchema = initHarveyTaskSchema;
exports.createTask = createTask;
exports.getTask = getTask;
exports.listTasks = listTasks;
exports.updateTask = updateTask;
exports.deleteTask = deleteTask;
exports.dueTasks = dueTasks;
exports.claimTask = claimTask;
exports.startRun = startRun;
exports.finishRun = finishRun;
exports.listRuns = listRuns;
exports.reconcileNextRuns = reconcileNextRuns;
/**
 * Harvey's scheduled tasks, and the record of every time one ran.
 *
 * WHAT THIS IS FOR. The operator says "send me the pipeline report every
 * weekday at 7" in chat, and that sentence becomes a row here. The task is the
 * PROMPT, not a hardcoded agent — which is the whole point: a new recurring job
 * stops being a deploy and becomes a sentence.
 *
 * WHY A DURABLE STORE AND NOT A TIMER. Fly restarts machines for its own
 * reasons — deploys, OOM, host migration. Anything held in memory is gone on
 * the next bounce, and a schedule that silently stops is worse than one that
 * never existed, because nobody notices the report that did not arrive. The
 * scheduler therefore owns no state: it asks this table what is due.
 *
 * WHY EVERY RUN IS RECORDED WITH ITS COST. A scheduled task is a standing
 * instruction to spend money. Without run history, "why did we spend $40 on
 * Tuesday" has no answer and a task stuck in a retry loop is invisible. The
 * `consecutive_failures` column exists so a task that keeps failing gets paused
 * instead of retried forever at full price.
 */
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const cron_js_1 = require("../hull/cron.js");
let db = null;
function resolveDbPath() {
    const explicit = process.env.HARVEY_TASKS_DB_PATH?.trim();
    if (explicit)
        return explicit;
    const dataDir = (0, fs_1.existsSync)("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
    if (!(0, fs_1.existsSync)(dataDir))
        (0, fs_1.mkdirSync)(dataDir, { recursive: true });
    return path_1.default.join(dataDir, "harvey-tasks.db");
}
function getHarveyTaskDb() {
    if (db)
        return db;
    const file = resolveDbPath();
    const dir = path_1.default.dirname(file);
    if (!(0, fs_1.existsSync)(dir))
        (0, fs_1.mkdirSync)(dir, { recursive: true });
    db = new better_sqlite3_1.default(file);
    db.pragma("journal_mode = WAL");
    initHarveyTaskSchema(db);
    return db;
}
/**
 * Columns added after the table already existed on a live volume.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an existing database, so a
 * column added to this file later never reaches the deployed table and the
 * first symptom is `no such column` at runtime. This repo has already been
 * bitten by exactly that (see the CMA store), so the migration ships with the
 * table rather than after the outage.
 */
function migrateColumns(database, table, wanted) {
    const existing = new Set(database.pragma(`table_info(${table})`).map((c) => c.name));
    for (const [col, decl] of Object.entries(wanted)) {
        if (!existing.has(col))
            database.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
}
function initHarveyTaskSchema(database = getHarveyTaskDb()) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS harvey_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT '${cron_js_1.DEFAULT_TIMEZONE}',
      enabled INTEGER NOT NULL DEFAULT 1,
      deliver TEXT NOT NULL DEFAULT 'chat',
      session_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      max_cost_usd REAL NOT NULL DEFAULT 0.25
    );

    CREATE TABLE IF NOT EXISTS harvey_task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      ok INTEGER,
      cost_usd REAL NOT NULL DEFAULT 0,
      output TEXT,
      error TEXT,
      trigger TEXT NOT NULL DEFAULT 'schedule'
    );
  `);
    migrateColumns(database, "harvey_tasks", {
        consecutive_failures: "INTEGER NOT NULL DEFAULT 0",
        max_cost_usd: "REAL NOT NULL DEFAULT 0.25",
        deliver: "TEXT NOT NULL DEFAULT 'chat'",
        session_id: "TEXT",
        timezone: `TEXT NOT NULL DEFAULT '${cron_js_1.DEFAULT_TIMEZONE}'`,
    });
    migrateColumns(database, "harvey_task_runs", {
        trigger: "TEXT NOT NULL DEFAULT 'schedule'",
        cost_usd: "REAL NOT NULL DEFAULT 0",
    });
    /* Indexes come after the migration on purpose: they are built on the columns
       being healed, and indexing a column that does not exist yet throws before
       the store can open. */
    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON harvey_tasks(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_runs_task ON harvey_task_runs(task_id, started_at DESC);
  `);
}
function hydrate(row) {
    return {
        id: row.id,
        title: row.title,
        prompt: row.prompt,
        cron: row.cron,
        timezone: row.timezone,
        enabled: !!row.enabled,
        deliver: (row.deliver || "chat"),
        sessionId: row.session_id,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        lastStatus: row.last_status ?? null,
        consecutiveFailures: row.consecutive_failures || 0,
        maxCostUsd: row.max_cost_usd ?? 0.25,
        scheduleLabel: (0, cron_js_1.describeCron)(row.cron, row.timezone),
    };
}
function createTask(input) {
    const database = getHarveyTaskDb();
    const now = new Date().toISOString();
    const tz = input.timezone || cron_js_1.DEFAULT_TIMEZONE;
    const id = (0, crypto_1.randomUUID)();
    const next = (0, cron_js_1.nextRun)(input.cron, tz);
    database
        .prepare(`INSERT INTO harvey_tasks
        (id, title, prompt, cron, timezone, enabled, deliver, session_id, created_by,
         created_at, updated_at, next_run_at, consecutive_failures, max_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
        .run(id, input.title.slice(0, 200), input.prompt.slice(0, 4000), input.cron, tz, input.enabled === false ? 0 : 1, input.deliver || "chat", input.sessionId || null, input.createdBy || null, now, now, next ? new Date(next).toISOString() : null, Number.isFinite(input.maxCostUsd) ? Number(input.maxCostUsd) : 0.25);
    return getTask(id);
}
function getTask(id) {
    const row = getHarveyTaskDb().prepare("SELECT * FROM harvey_tasks WHERE id = ?").get(id);
    return row ? hydrate(row) : null;
}
function listTasks() {
    const rows = getHarveyTaskDb()
        .prepare("SELECT * FROM harvey_tasks ORDER BY enabled DESC, next_run_at IS NULL, next_run_at ASC")
        .all();
    return rows.map(hydrate);
}
function updateTask(id, patch) {
    const current = getTask(id);
    if (!current)
        return null;
    const cron = patch.cron ?? current.cron;
    const tz = patch.timezone ?? current.timezone;
    const enabled = patch.enabled ?? current.enabled;
    /* Recompute the next fire whenever the schedule or the enabled flag moves.
       A paused task keeps no next run, so re-enabling cannot fire immediately for
       every slot it slept through. */
    const next = enabled ? (0, cron_js_1.nextRun)(cron, tz) : null;
    getHarveyTaskDb()
        .prepare(`UPDATE harvey_tasks
          SET title = ?, prompt = ?, cron = ?, timezone = ?, enabled = ?, deliver = ?,
              max_cost_usd = ?, next_run_at = ?, updated_at = ?,
              consecutive_failures = CASE WHEN ? = 1 AND enabled = 0 THEN 0 ELSE consecutive_failures END
        WHERE id = ?`)
        .run((patch.title ?? current.title).slice(0, 200), (patch.prompt ?? current.prompt).slice(0, 4000), cron, tz, enabled ? 1 : 0, patch.deliver ?? current.deliver, Number.isFinite(patch.maxCostUsd) ? Number(patch.maxCostUsd) : current.maxCostUsd, next ? new Date(next).toISOString() : null, new Date().toISOString(), enabled ? 1 : 0, id);
    return getTask(id);
}
function deleteTask(id) {
    const database = getHarveyTaskDb();
    database.prepare("DELETE FROM harvey_task_runs WHERE task_id = ?").run(id);
    return database.prepare("DELETE FROM harvey_tasks WHERE id = ?").run(id).changes > 0;
}
/** Tasks whose next fire has passed. The scheduler holds no state of its own. */
function dueTasks(nowMs = Date.now()) {
    const rows = getHarveyTaskDb()
        .prepare(`SELECT * FROM harvey_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC`)
        .all(new Date(nowMs).toISOString());
    return rows.map(hydrate);
}
/**
 * Claim a task for execution and move its next fire forward.
 *
 * The advance happens BEFORE the run, not after. A task whose run crashes the
 * process would otherwise stay due forever and re-fire in a loop on every boot,
 * which is the expensive failure mode here.
 */
function claimTask(id, nowMs = Date.now()) {
    const task = getTask(id);
    if (!task)
        return null;
    const next = (0, cron_js_1.nextRun)(task.cron, task.timezone, nowMs);
    getHarveyTaskDb()
        .prepare("UPDATE harvey_tasks SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?")
        .run(next ? new Date(next).toISOString() : null, new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), id);
    return getTask(id);
}
function startRun(taskId, trigger = "schedule") {
    const id = (0, crypto_1.randomUUID)();
    const startedAt = new Date().toISOString();
    getHarveyTaskDb()
        .prepare("INSERT INTO harvey_task_runs (id, task_id, started_at, trigger) VALUES (?, ?, ?, ?)")
        .run(id, taskId, startedAt, trigger);
    return { id, taskId, startedAt, finishedAt: null, ok: null, costUsd: 0, output: null, error: null, trigger };
}
/** Consecutive failures before a task is paused rather than retried. */
const FAILURE_PAUSE_THRESHOLD = 3;
/**
 * Close out a run and update the task's health.
 *
 * Returns whether the task was auto-paused, so the caller can tell the operator
 * — a task that quietly stopped is the thing this is meant to prevent.
 */
function finishRun(runId, taskId, result) {
    const database = getHarveyTaskDb();
    database
        .prepare("UPDATE harvey_task_runs SET finished_at = ?, ok = ?, cost_usd = ?, output = ?, error = ? WHERE id = ?")
        .run(new Date().toISOString(), result.ok ? 1 : 0, Number.isFinite(result.costUsd) ? Number(result.costUsd) : 0, result.output ? String(result.output).slice(0, 20000) : null, result.error ? String(result.error).slice(0, 2000) : null, runId);
    if (result.ok) {
        database
            .prepare("UPDATE harvey_tasks SET last_status = 'ok', consecutive_failures = 0, updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), taskId);
        return { paused: false };
    }
    const row = database
        .prepare("SELECT consecutive_failures FROM harvey_tasks WHERE id = ?")
        .get(taskId);
    const failures = (row?.consecutive_failures || 0) + 1;
    const paused = failures >= FAILURE_PAUSE_THRESHOLD;
    database
        .prepare(`UPDATE harvey_tasks
          SET last_status = 'error', consecutive_failures = ?, updated_at = ?,
              enabled = CASE WHEN ? THEN 0 ELSE enabled END,
              next_run_at = CASE WHEN ? THEN NULL ELSE next_run_at END
        WHERE id = ?`)
        .run(failures, new Date().toISOString(), paused ? 1 : 0, paused ? 1 : 0, taskId);
    return { paused };
}
function listRuns(taskId, limit = 20) {
    const rows = getHarveyTaskDb()
        .prepare("SELECT * FROM harvey_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?")
        .all(taskId, Math.max(1, Math.min(200, limit)));
    return rows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        ok: r.ok === null ? null : !!r.ok,
        costUsd: r.cost_usd || 0,
        output: r.output,
        error: r.error,
        trigger: r.trigger || "schedule",
    }));
}
/** Rebuild every enabled task's next fire. Run at boot, after downtime. */
function reconcileNextRuns(nowMs = Date.now()) {
    const database = getHarveyTaskDb();
    const rows = database.prepare("SELECT id, cron, timezone FROM harvey_tasks WHERE enabled = 1").all();
    let updated = 0;
    for (const row of rows) {
        const next = (0, cron_js_1.nextRun)(row.cron, row.timezone, nowMs);
        database
            .prepare("UPDATE harvey_tasks SET next_run_at = ? WHERE id = ?")
            .run(next ? new Date(next).toISOString() : null, row.id);
        updated++;
    }
    return updated;
}
