"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPENROUTER_MONTHLY_LIMIT_USD = void 0;
exports.sharedOpenRouterBudgetDb = sharedOpenRouterBudgetDb;
exports.openRouterBudgetStatus = openRouterBudgetStatus;
exports.reserveOpenRouterSpend = reserveOpenRouterSpend;
exports.settleOpenRouterSpend = settleOpenRouterSpend;
exports.refreshOpenRouterBilling = refreshOpenRouterBilling;
/** Shared spend only: no prompts, account IDs, sessions or model preferences. */
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const tenantData_js_1 = require("./tenantData.js");
exports.OPENROUTER_MONTHLY_LIMIT_USD = 150;
const month = (at = new Date()) => at.toISOString().slice(0, 7);
let db;
function sharedOpenRouterBudgetDb() {
    if (db)
        return db;
    const file = process.env.SHARED_OPENROUTER_BUDGET_DB_PATH || (0, tenantData_js_1.dataPath)("openrouter-budget.db");
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(file), { recursive: true });
    const connection = new better_sqlite3_1.default(file);
    connection.pragma("busy_timeout = 10000");
    connection.pragma("journal_mode = WAL");
    connection.exec(`CREATE TABLE IF NOT EXISTS spend (id TEXT PRIMARY KEY, month TEXT NOT NULL, cost REAL NOT NULL, pending INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS spend_month ON spend(month);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // Import existing OpenRouter costs once, before any new reservation. Never move
    // private logs into this shared store. Transaction serializes concurrent boots.
    connection.transaction(() => {
        if (connection.prepare("SELECT 1 FROM metadata WHERE key='imported'").get())
            return;
        const root = (0, node_path_1.dirname)(file), accounts = (0, node_path_1.join)(root, "accounts");
        const files = [(0, node_path_1.join)(root, "ai-usage.db"), ...((0, node_fs_1.existsSync)(accounts)
                ? (0, node_fs_1.readdirSync)(accounts, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => (0, node_path_1.join)(accounts, d.name, "ai-usage.db")) : [])];
        if (process.env.AI_USAGE_DB_PATH)
            files.push(process.env.AI_USAGE_DB_PATH);
        const insert = connection.prepare("INSERT OR IGNORE INTO spend(id,month,cost) VALUES(?,?,?)");
        for (const source of new Set(files)) {
            if (!(0, node_fs_1.existsSync)(source))
                continue;
            const old = new better_sqlite3_1.default(source, { readonly: true });
            try {
                if (!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_requests'").get())
                    continue;
                const rows = old.prepare("SELECT id,ts,cost_usd FROM ai_requests WHERE provider='openrouter' AND cost_usd>0").all();
                for (const row of rows)
                    insert.run(`legacy:${row.id}`, month(new Date(row.ts)), row.cost_usd);
            }
            finally {
                old.close();
            }
        }
        connection.prepare("INSERT INTO metadata VALUES('imported','1')").run();
    }).immediate();
    db = connection;
    return db;
}
function openRouterBudgetStatus(at = new Date()) {
    const row = sharedOpenRouterBudgetDb().prepare("SELECT COALESCE(SUM(cost),0) AS used, COALESCE(SUM(CASE WHEN pending=1 THEN cost ELSE 0 END),0) AS reserved FROM spend WHERE month=?").get(month(at));
    return { provider: "openrouter", scope: "all_accounts", month: month(at), timezone: "UTC", limitUsd: exports.OPENROUTER_MONTHLY_LIMIT_USD,
        spentUsd: row.used - row.reserved, reservedUsd: row.reserved, remainingUsd: Math.max(0, exports.OPENROUTER_MONTHLY_LIMIT_USD - row.used) };
}
/** Atomic across account worker processes; unresolved requests retain their reservation. */
function reserveOpenRouterSpend(estimate, at = new Date()) {
    if (!Number.isFinite(estimate) || estimate < 0)
        throw new Error("OpenRouter pricing is unavailable; no request was sent.");
    const database = sharedOpenRouterBudgetDb();
    return database.transaction(() => {
        const status = openRouterBudgetStatus(at);
        if (status.remainingUsd <= 0 || estimate > status.remainingUsd)
            throw new Error("The shared $150 monthly OpenRouter allowance is exhausted or cannot cover this request. It resets on the first day of the next month (UTC). Completed work is retained.");
        const id = (0, node_crypto_1.randomUUID)();
        database.prepare("INSERT INTO spend(id,month,cost,pending) VALUES(?,?,?,1)").run(id, month(at), estimate);
        return id;
    }).immediate();
}
function settleOpenRouterSpend(id, actualCost) {
    if (!Number.isFinite(actualCost) || actualCost < 0)
        throw new Error("OpenRouter returned invalid usage; its reservation was retained.");
    sharedOpenRouterBudgetDb().prepare("UPDATE spend SET cost=?,pending=0 WHERE id=? AND pending=1").run(actualCost, id);
}
/** Reconcile against the key's UTC monthly billing when no local request is in flight.
 * Local accounting remains available if this free metadata endpoint is unavailable.
 * The key itself must also have a $150/month limit for a provider-enforced ceiling.
 */
let lastRefresh = 0;
async function refreshOpenRouterBilling() {
    if (Date.now() - lastRefresh < 60_000)
        return;
    lastRefresh = Date.now();
    const at = new Date(), before = openRouterBudgetStatus(at);
    if (before.reservedUsd > 0)
        return;
    try {
        const base = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
        const response = await fetch(`${base}/key`, { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(5000), redirect: "error" });
        if (!response.ok)
            return;
        const billed = (await response.json())?.data?.usage_monthly;
        if (typeof billed !== "number" || !Number.isFinite(billed) || billed < 0 || month() !== month(at))
            return;
        const database = sharedOpenRouterBudgetDb();
        database.transaction(() => {
            const current = openRouterBudgetStatus(at);
            // Discard a stale snapshot if any paid work started/completed during the read.
            if (current.reservedUsd || current.spentUsd !== before.spentUsd || billed <= current.spentUsd)
                return;
            database.prepare("INSERT INTO spend(id,month,cost) VALUES(?,?,?)").run((0, node_crypto_1.randomUUID)(), month(at), billed - current.spentUsd);
        }).immediate();
    }
    catch { /* No paid call was made; local reservations still enforce the allowance. */ }
}
