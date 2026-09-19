"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateAiUsageColumns = migrateAiUsageColumns;
exports.initAiUsageSchema = initAiUsageSchema;
exports.getAiUsageDb = getAiUsageDb;
exports.businessDay = businessDay;
exports.businessMonth = businessMonth;
exports.recordUsage = recordUsage;
exports.spentToday = spentToday;
exports.spentThisMonth = spentThisMonth;
exports.sessionCostUsd = sessionCostUsd;
exports.usageSummary = usageSummary;
exports.recentErrors = recentErrors;
exports.getCaps = getCaps;
exports.setCaps = setCaps;
exports.getModelOverride = getModelOverride;
exports.setModelOverride = setModelOverride;
exports.clearModelOverride = clearModelOverride;
exports.allModelOverrides = allModelOverrides;
exports.noteFailure = noteFailure;
exports.noteSuccess = noteSuccess;
exports.isModelPaused = isModelPaused;
exports.breakerStates = breakerStates;
/**
 * Every model call Harvey makes, what it cost, and the dials that stop it.
 *
 * WHY THIS EXISTS. Nothing in the system read `usage` off a model response, so
 * "what did Harvey spend today" had no answer and a runaway tool loop was a
 * surprise on a bill at the end of the month. This store makes spend a number
 * that can be read before the next request is made, which is the only point at
 * which it can still be prevented.
 *
 * FAILURES ARE RECORDED TOO. A row is written whether the call succeeded or
 * not. A failed call that leaves no trace is indistinguishable from one nobody
 * made, and "why did Harvey go quiet at 3pm" is answered by the error column.
 *
 * THE DAY BOUNDARY IS AMERICA/CHICAGO, NOT UTC. The caps are a business rule
 * ("ten dollars a day"), and the business is in San Antonio. A UTC day would
 * roll over at 6 or 7pm local and hand back a fresh allowance mid-afternoon.
 *
 * FOUR TABLES, ONE FILE: the request log, a daily rollup so the dashboard does
 * not scan the log, the settings row that holds caps and per-job model
 * overrides, and the circuit breaker that parks a model which keeps failing.
 */
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
/** Business timezone. The caps are a daily budget in Marco's day, not UTC's. */
const BUSINESS_TZ = "America/Chicago";
/** Consecutive failures before a model is parked, and for how long. */
const BREAKER_THRESHOLD = 3;
const BREAKER_PAUSE_MS = 5 * 60 * 1000;
function resolveBase() {
    const base = (0, fs_1.existsSync)("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(base, { recursive: true });
    return base;
}
function resolveDbPath() {
    return process.env.AI_USAGE_DB_PATH?.trim() || path_1.default.join(resolveBase(), "ai-usage.db");
}
let db = null;
/**
 * Columns this file declares that an OLDER database may not have.
 *
 * Same trap `cmaStore.ts` documents: `CREATE TABLE IF NOT EXISTS` is a no-op on
 * a database that already exists, so a column added here later never reaches
 * the live table and the first read of it throws `no such column`. Every add is
 * guarded by `PRAGMA table_info`, so this is safe on every boot and does
 * nothing on a current database. ALTER only — `/data/ai-usage.db` is the spend
 * record and rebuilding a table would erase it.
 */
const AI_USAGE_MIGRATABLE_COLUMNS = {
    ai_requests: [
        ["model_used", "TEXT"],
        ["cached_tokens", "INTEGER NOT NULL DEFAULT 0"],
        ["cost_estimated", "INTEGER NOT NULL DEFAULT 0"],
        ["latency_ms", "INTEGER NOT NULL DEFAULT 0"],
        ["error", "TEXT"],
        ["session_id", "TEXT"],
        ["request_id", "TEXT"],
    ],
    ai_daily: [
        ["calls", "INTEGER NOT NULL DEFAULT 0"],
        ["errors", "INTEGER NOT NULL DEFAULT 0"],
        ["prompt_tokens", "INTEGER NOT NULL DEFAULT 0"],
        ["completion_tokens", "INTEGER NOT NULL DEFAULT 0"],
        ["cost_usd", "REAL NOT NULL DEFAULT 0"],
    ],
    ai_breaker: [
        ["consecutive_failures", "INTEGER NOT NULL DEFAULT 0"],
        ["paused_until", "TEXT"],
        ["last_error", "TEXT"],
        ["updated_at", "TEXT"],
    ],
};
function migrateAiUsageColumns(database) {
    const added = [];
    for (const [table, columns] of Object.entries(AI_USAGE_MIGRATABLE_COLUMNS)) {
        const info = database.prepare(`PRAGMA table_info(${table})`).all();
        if (!info.length)
            continue;
        const have = new Set(info.map((r) => r.name));
        for (const [col, decl] of columns) {
            if (have.has(col))
                continue;
            database.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
            added.push(`${table}.${col}`);
        }
    }
    return added;
}
function initAiUsageSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS ai_requests (
      id                TEXT PRIMARY KEY,
      ts                TEXT NOT NULL,
      day               TEXT NOT NULL,
      job               TEXT NOT NULL,
      provider          TEXT NOT NULL,
      model             TEXT NOT NULL,
      model_used        TEXT,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens     INTEGER NOT NULL DEFAULT 0,
      cost_usd          REAL NOT NULL DEFAULT 0,
      cost_estimated    INTEGER NOT NULL DEFAULT 0,
      latency_ms        INTEGER NOT NULL DEFAULT 0,
      ok                INTEGER NOT NULL DEFAULT 1,
      error             TEXT,
      session_id        TEXT,
      request_id        TEXT
    )
  `);
    /* The rollup exists so the dashboard and the cap check never scan the log.
       Spend is read before every single call; that read has to stay O(1). */
    database.exec(`
    CREATE TABLE IF NOT EXISTS ai_daily (
      day               TEXT PRIMARY KEY,
      calls             INTEGER NOT NULL DEFAULT 0,
      errors            INTEGER NOT NULL DEFAULT 0,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd          REAL NOT NULL DEFAULT 0
    )
  `);
    database.exec(`
    CREATE TABLE IF NOT EXISTS ai_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
    database.exec(`
    CREATE TABLE IF NOT EXISTS ai_breaker (
      model                TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      paused_until         TEXT,
      last_error           TEXT,
      updated_at           TEXT
    )
  `);
    /* Migrate before indexing, for the reason cmaStore spells out: the indexes
       below are built on columns an older database may be missing. */
    const healed = migrateAiUsageColumns(database);
    if (healed.length) {
        console.log(`[ai-usage] schema migrated, added ${healed.length} column(s): ${healed.join(", ")}`);
    }
    database.exec(`CREATE INDEX IF NOT EXISTS idx_ai_requests_ts ON ai_requests(ts DESC)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_ai_requests_day ON ai_requests(day)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_ai_requests_model ON ai_requests(model_used)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_ai_requests_errors ON ai_requests(ok, ts DESC)`);
}
function getAiUsageDb() {
    if (db)
        return db;
    db = new better_sqlite3_1.default(resolveDbPath());
    db.pragma("journal_mode = WAL");
    initAiUsageSchema(db);
    return db;
}
/* ────────────────────────── dates ────────────────────────── */
/** `YYYY-MM-DD` in the business timezone. */
function businessDay(at = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: BUSINESS_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(at);
}
/** `YYYY-MM` in the business timezone. */
function businessMonth(at = new Date()) {
    return businessDay(at).slice(0, 7);
}
/* ────────────────────────── writes ────────────────────────── */
/**
 * Record one attempt. Called for successes and failures alike, and never
 * allowed to throw: losing the answer because the bookkeeping failed would be
 * a worse outcome than an unrecorded call.
 */
function recordUsage(rec) {
    try {
        const database = getAiUsageDb();
        const id = `air_${(0, crypto_1.randomUUID)()}`;
        const ts = rec.at || new Date().toISOString();
        const day = businessDay(new Date(ts));
        const cost = Number.isFinite(rec.costUsd) ? Number(rec.costUsd) : 0;
        const prompt = Math.max(0, Math.round(Number(rec.promptTokens) || 0));
        const completion = Math.max(0, Math.round(Number(rec.completionTokens) || 0));
        const write = database.transaction(() => {
            database
                .prepare(`INSERT INTO ai_requests (
             id, ts, day, job, provider, model, model_used, prompt_tokens, completion_tokens,
             cached_tokens, cost_usd, cost_estimated, latency_ms, ok, error, session_id, request_id
           ) VALUES (
             @id, @ts, @day, @job, @provider, @model, @modelUsed, @prompt, @completion,
             @cached, @cost, @estimated, @latency, @ok, @error, @sessionId, @requestId
           )`)
                .run({
                id,
                ts,
                day,
                job: String(rec.job),
                provider: String(rec.provider),
                model: String(rec.model),
                modelUsed: String(rec.modelUsed || rec.model || ""),
                prompt,
                completion,
                cached: Math.max(0, Math.round(Number(rec.cachedTokens) || 0)),
                cost,
                estimated: rec.costEstimated ? 1 : 0,
                latency: Math.max(0, Math.round(Number(rec.latencyMs) || 0)),
                ok: rec.ok ? 1 : 0,
                error: rec.error ? String(rec.error).slice(0, 2000) : null,
                sessionId: rec.sessionId ? String(rec.sessionId) : null,
                requestId: rec.requestId ? String(rec.requestId) : null,
            });
            database
                .prepare(`INSERT INTO ai_daily (day, calls, errors, prompt_tokens, completion_tokens, cost_usd)
           VALUES (@day, 1, @errors, @prompt, @completion, @cost)
           ON CONFLICT(day) DO UPDATE SET
             calls = calls + 1,
             errors = errors + @errors,
             prompt_tokens = prompt_tokens + @prompt,
             completion_tokens = completion_tokens + @completion,
             cost_usd = cost_usd + @cost`)
                .run({ day, errors: rec.ok ? 0 : 1, prompt, completion, cost });
        });
        write();
        return id;
    }
    catch (err) {
        console.error(`[ai-usage] failed to record usage: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/* ────────────────────────── reads ────────────────────────── */
function spentToday(at = new Date()) {
    const row = getAiUsageDb()
        .prepare(`SELECT cost_usd c FROM ai_daily WHERE day = ?`)
        .get(businessDay(at));
    return Number(row?.c ?? 0);
}
function spentThisMonth(at = new Date()) {
    const row = getAiUsageDb()
        .prepare(`SELECT COALESCE(SUM(cost_usd), 0) c FROM ai_daily WHERE day LIKE ?`)
        .get(`${businessMonth(at)}%`);
    return Number(row?.c ?? 0);
}
/**
 * What one session has cost so far.
 *
 * A scheduled task is a session: the cron runner needs a per-run figure to
 * enforce its own ceiling and to write into the run history, and summing the
 * request rows is the only number that includes the tool loop's extra turns.
 */
function sessionCostUsd(sessionId) {
    if (!sessionId)
        return 0;
    try {
        const row = getAiUsageDb()
            .prepare(`SELECT COALESCE(SUM(cost_usd), 0) c FROM ai_requests WHERE session_id = ?`)
            .get(String(sessionId));
        return Number(row?.c ?? 0);
    }
    catch {
        return 0;
    }
}
function usageSummary(days = 30) {
    const database = getAiUsageDb();
    const n = Math.min(Math.max(Math.round(days) || 30, 1), 365);
    const since = businessDay(new Date(Date.now() - (n - 1) * 86400000));
    const today = businessDay();
    const todayRow = database.prepare(`SELECT * FROM ai_daily WHERE day = ?`).get(today);
    const totals = database
        .prepare(`SELECT COALESCE(SUM(calls),0) calls, COALESCE(SUM(errors),0) errors,
              COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(prompt_tokens),0) pt,
              COALESCE(SUM(completion_tokens),0) ct
         FROM ai_daily WHERE day >= ?`)
        .get(since);
    const byModel = database
        .prepare(`SELECT COALESCE(model_used, model) m, COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost,
                COALESCE(SUM(prompt_tokens + completion_tokens),0) tokens
           FROM ai_requests WHERE day >= ? GROUP BY m ORDER BY cost DESC`)
        .all(since).map((r) => ({
        model: String(r.m),
        calls: Number(r.calls),
        costUsd: Number(r.cost),
        tokens: Number(r.tokens),
    }));
    const byJob = database
        .prepare(`SELECT job, COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost
           FROM ai_requests WHERE day >= ? GROUP BY job ORDER BY cost DESC`)
        .all(since).map((r) => ({ job: String(r.job), calls: Number(r.calls), costUsd: Number(r.cost) }));
    const daily = database
        .prepare(`SELECT day, calls, cost_usd FROM ai_daily WHERE day >= ? ORDER BY day ASC`)
        .all(since).map((r) => ({ date: String(r.day), calls: Number(r.calls), costUsd: Number(r.cost_usd) }));
    return {
        days: n,
        since,
        today: {
            calls: Number(todayRow?.calls ?? 0),
            errors: Number(todayRow?.errors ?? 0),
            costUsd: Number(todayRow?.cost_usd ?? 0),
            promptTokens: Number(todayRow?.prompt_tokens ?? 0),
            completionTokens: Number(todayRow?.completion_tokens ?? 0),
        },
        month: { costUsd: spentThisMonth() },
        totals: {
            calls: Number(totals.calls),
            errors: Number(totals.errors),
            costUsd: Number(totals.cost),
            promptTokens: Number(totals.pt),
            completionTokens: Number(totals.ct),
        },
        byModel,
        byJob,
        daily,
    };
}
function recentErrors(limit = 20) {
    const n = Math.min(Math.max(Math.round(limit) || 20, 1), 200);
    return getAiUsageDb()
        .prepare(`SELECT ts, job, COALESCE(model_used, model) m, provider, error
           FROM ai_requests WHERE ok = 0 ORDER BY ts DESC LIMIT ?`)
        .all(n).map((r) => ({
        at: String(r.ts),
        job: String(r.job),
        model: String(r.m),
        provider: String(r.provider),
        error: String(r.error ?? ""),
    }));
}
function envNumber(name, fallback) {
    const raw = process.env[name]?.trim();
    if (!raw)
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function readSetting(key) {
    try {
        const row = getAiUsageDb().prepare(`SELECT value FROM ai_settings WHERE key = ?`).get(key);
        return row?.value ?? null;
    }
    catch {
        return null;
    }
}
function writeSetting(key, value) {
    const database = getAiUsageDb();
    if (value === null) {
        database.prepare(`DELETE FROM ai_settings WHERE key = ?`).run(key);
        return;
    }
    database
        .prepare(`INSERT INTO ai_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, value);
}
/**
 * Caps, with the stored value winning over the environment default.
 *
 * The env vars are the deploy-time floor; an operator raising the cap in the UI
 * should not be undone by the next restart, which is why the override lives in
 * the database rather than in memory.
 */
function getCaps() {
    const stored = (key, fallback) => {
        const raw = readSetting(key);
        if (raw === null)
            return fallback;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
        dailyCapUsd: stored("cap_daily_usd", envNumber("HARVEY_DAILY_CAP_USD", 10)),
        monthlyCapUsd: stored("cap_monthly_usd", envNumber("HARVEY_MONTHLY_CAP_USD", 150)),
        maxCostPerCallUsd: stored("cap_per_call_usd", envNumber("HARVEY_MAX_COST_PER_CALL_USD", 0.5)),
    };
}
function setCaps(patch) {
    const keys = [
        ["dailyCapUsd", "cap_daily_usd"],
        ["monthlyCapUsd", "cap_monthly_usd"],
        ["maxCostPerCallUsd", "cap_per_call_usd"],
    ];
    for (const [field, key] of keys) {
        if (!(field in patch))
            continue;
        const raw = patch[field];
        if (raw === null || raw === undefined) {
            writeSetting(key, null);
            continue;
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0)
            continue;
        writeSetting(key, String(n));
    }
    return getCaps();
}
/* ────────────────────────── settings: model overrides ────────────────────────── */
const overrideKey = (job) => `model_override:${String(job)}`;
/** The operator's stored pick for one job, or null to use routing's default. */
function getModelOverride(job) {
    const raw = readSetting(overrideKey(job));
    return raw && raw.trim() ? raw.trim() : null;
}
function setModelOverride(job, model) {
    const m = String(model || "").trim();
    if (!m) {
        clearModelOverride(job);
        return;
    }
    writeSetting(overrideKey(job), m);
}
function clearModelOverride(job) {
    writeSetting(overrideKey(job), null);
}
/** Every stored override, for the routing view in the UI. */
function allModelOverrides() {
    try {
        const rows = getAiUsageDb()
            .prepare(`SELECT key, value FROM ai_settings WHERE key LIKE 'model_override:%'`)
            .all();
        const out = {};
        for (const r of rows)
            out[r.key.slice("model_override:".length)] = r.value;
        return out;
    }
    catch {
        return {};
    }
}
/* ────────────────────────── circuit breaker ────────────────────────── */
/**
 * A model that has failed three times in a row is parked for five minutes.
 *
 * Retrying into the same wall costs latency on every turn and, on a provider
 * that bills failed generations, money as well. Parking sends traffic to the
 * fallback instead — degraded, but answering.
 */
function noteFailure(model, error) {
    try {
        const database = getAiUsageDb();
        const now = new Date();
        const row = database
            .prepare(`SELECT consecutive_failures f FROM ai_breaker WHERE model = ?`)
            .get(String(model));
        const failures = Number(row?.f ?? 0) + 1;
        const pausedUntil = failures >= BREAKER_THRESHOLD ? new Date(now.getTime() + BREAKER_PAUSE_MS).toISOString() : null;
        database
            .prepare(`INSERT INTO ai_breaker (model, consecutive_failures, paused_until, last_error, updated_at)
         VALUES (@model, @failures, @pausedUntil, @error, @now)
         ON CONFLICT(model) DO UPDATE SET
           consecutive_failures = @failures,
           paused_until = @pausedUntil,
           last_error = @error,
           updated_at = @now`)
            .run({
            model: String(model),
            failures,
            pausedUntil,
            error: error ? String(error).slice(0, 500) : null,
            now: now.toISOString(),
        });
    }
    catch {
        /* The breaker is a safety net, not a source of truth. If it cannot be
           written the call still happened and was still recorded above. */
    }
}
function noteSuccess(model) {
    try {
        getAiUsageDb()
            .prepare(`INSERT INTO ai_breaker (model, consecutive_failures, paused_until, last_error, updated_at)
         VALUES (@model, 0, NULL, NULL, @now)
         ON CONFLICT(model) DO UPDATE SET
           consecutive_failures = 0, paused_until = NULL, last_error = NULL, updated_at = @now`)
            .run({ model: String(model), now: new Date().toISOString() });
    }
    catch {
        /* Same reasoning as noteFailure. */
    }
}
function isModelPaused(model, at = new Date()) {
    try {
        const row = getAiUsageDb()
            .prepare(`SELECT paused_until FROM ai_breaker WHERE model = ?`)
            .get(String(model));
        if (!row?.paused_until)
            return false;
        return new Date(row.paused_until).getTime() > at.getTime();
    }
    catch {
        return false;
    }
}
function breakerStates() {
    try {
        return getAiUsageDb()
            .prepare(`SELECT * FROM ai_breaker ORDER BY updated_at DESC`)
            .all().map((r) => ({
            model: String(r.model),
            consecutiveFailures: Number(r.consecutive_failures ?? 0),
            pausedUntil: r.paused_until ?? null,
            lastError: r.last_error ?? null,
        }));
    }
    catch {
        return [];
    }
}
