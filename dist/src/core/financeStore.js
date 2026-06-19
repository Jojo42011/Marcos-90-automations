"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFinanceDb = getFinanceDb;
exports.defaultBrokerageSplitPct = defaultBrokerageSplitPct;
exports.defaultGrossCommissionPct = defaultGrossCommissionPct;
exports.computeCommissionAmounts = computeCommissionAmounts;
exports.createCommission = createCommission;
exports.getCommissionByDealId = getCommissionByDealId;
exports.getAllCommissions = getAllCommissions;
exports.getRecentCommissions = getRecentCommissions;
exports.createExpense = createExpense;
exports.getAllExpenses = getAllExpenses;
exports.getRecentExpenses = getRecentExpenses;
exports.getGCISummary = getGCISummary;
exports.getExpenseSummary = getExpenseSummary;
exports.generatePipelineProjection = generatePipelineProjection;
exports.logFinanceAlert = logFinanceAlert;
exports.getFinanceAlerts = getFinanceAlerts;
exports.acknowledgeFinanceAlert = acknowledgeFinanceAlert;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const transactionsStore_js_1 = require("./transactionsStore.js");
const db_js_1 = require("./db.js");
function resolveFinanceDbPath() {
    const env = process.env.FINANCE_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/finance.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "finance.db");
}
let db = null;
function initFinanceSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS commissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id TEXT,
      address TEXT NOT NULL,
      sale_price REAL NOT NULL,
      gross_commission_pct REAL NOT NULL,
      gross_commission_amount REAL NOT NULL,
      brokerage_split_pct REAL NOT NULL,
      brokerage_split_amount REAL NOT NULL,
      net_commission REAL NOT NULL,
      deal_type TEXT NOT NULL,
      lead_source TEXT,
      lead_id TEXT,
      closed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_commissions_closed ON commissions(closed_at)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_commissions_deal ON commissions(deal_id)`);
    database.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      subcategory TEXT,
      vendor TEXT,
      description TEXT,
      amount REAL NOT NULL,
      deal_id TEXT,
      lead_source TEXT,
      expense_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date)`);
    database.exec(`
    CREATE TABLE IF NOT EXISTS finance_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      sent_at TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0
    )
  `);
}
function getFinanceDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveFinanceDbPath());
        initFinanceSchema(db);
    }
    return db;
}
function defaultBrokerageSplitPct() {
    const raw = parseFloat(process.env.BROKERAGE_SPLIT_PCT || "0.5");
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.5;
}
function defaultGrossCommissionPct() {
    return 0.03;
}
function computeCommissionAmounts(input) {
    const grossCommissionPct = input.grossCommissionPct ?? defaultGrossCommissionPct();
    const grossCommissionAmount = input.grossCommissionAmount ?? Math.round(input.salePrice * grossCommissionPct * 100) / 100;
    const brokerageSplitPct = input.brokerageSplitPct ?? defaultBrokerageSplitPct();
    const brokerageSplitAmount = input.brokerageSplitAmount ??
        Math.round(grossCommissionAmount * brokerageSplitPct * 100) / 100;
    const netCommission = Math.round((grossCommissionAmount - brokerageSplitAmount) * 100) / 100;
    return {
        grossCommissionPct,
        grossCommissionAmount,
        brokerageSplitPct,
        brokerageSplitAmount,
        netCommission,
    };
}
function rowToCommission(row) {
    return {
        id: Number(row.id),
        dealId: row.deal_id ? String(row.deal_id) : undefined,
        address: String(row.address),
        salePrice: Number(row.sale_price),
        grossCommissionPct: Number(row.gross_commission_pct),
        grossCommissionAmount: Number(row.gross_commission_amount),
        brokerageSplitPct: Number(row.brokerage_split_pct),
        brokerageSplitAmount: Number(row.brokerage_split_amount),
        netCommission: Number(row.net_commission),
        dealType: row.deal_type,
        leadSource: row.lead_source ? String(row.lead_source) : undefined,
        leadId: row.lead_id ? String(row.lead_id) : undefined,
        closedAt: String(row.closed_at),
        createdAt: String(row.created_at),
    };
}
function rowToExpense(row) {
    return {
        id: Number(row.id),
        category: row.category,
        subcategory: row.subcategory ? String(row.subcategory) : undefined,
        vendor: row.vendor ? String(row.vendor) : undefined,
        description: row.description ? String(row.description) : undefined,
        amount: Number(row.amount),
        dealId: row.deal_id ? String(row.deal_id) : undefined,
        leadSource: row.lead_source ? String(row.lead_source) : undefined,
        expenseDate: String(row.expense_date),
        createdAt: String(row.created_at),
    };
}
function createCommission(input) {
    const amounts = computeCommissionAmounts({
        salePrice: input.salePrice,
        grossCommissionPct: input.grossCommissionPct,
        grossCommissionAmount: input.grossCommissionAmount,
        brokerageSplitPct: input.brokerageSplitPct,
        brokerageSplitAmount: input.brokerageSplitAmount,
    });
    const now = new Date().toISOString();
    const database = getFinanceDb();
    const result = database
        .prepare(`INSERT INTO commissions (
        deal_id, address, sale_price, gross_commission_pct, gross_commission_amount,
        brokerage_split_pct, brokerage_split_amount, net_commission, deal_type,
        lead_source, lead_id, closed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.dealId || null, input.address, input.salePrice, amounts.grossCommissionPct, amounts.grossCommissionAmount, amounts.brokerageSplitPct, amounts.brokerageSplitAmount, amounts.netCommission, input.dealType, input.leadSource || null, input.leadId || null, input.closedAt, now);
    return {
        ...input,
        ...amounts,
        id: Number(result.lastInsertRowid),
        createdAt: now,
    };
}
function getCommissionByDealId(dealId) {
    const database = getFinanceDb();
    const row = database
        .prepare(`SELECT * FROM commissions WHERE deal_id = ? ORDER BY closed_at DESC LIMIT 1`)
        .get(dealId);
    return row ? rowToCommission(row) : null;
}
function getAllCommissions(since) {
    const database = getFinanceDb();
    const rows = since
        ? database
            .prepare(`SELECT * FROM commissions WHERE closed_at >= ? ORDER BY closed_at DESC`)
            .all(since)
        : database
            .prepare(`SELECT * FROM commissions ORDER BY closed_at DESC`)
            .all();
    return rows.map(rowToCommission);
}
function getRecentCommissions(limit = 5) {
    const database = getFinanceDb();
    const rows = database
        .prepare(`SELECT * FROM commissions ORDER BY closed_at DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToCommission);
}
function createExpense(input) {
    const now = new Date().toISOString();
    const database = getFinanceDb();
    const result = database
        .prepare(`INSERT INTO expenses (category, subcategory, vendor, description, amount, deal_id, lead_source, expense_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.category, input.subcategory || null, input.vendor || null, input.description || null, input.amount, input.dealId || null, input.leadSource || null, input.expenseDate, now);
    return { ...input, id: Number(result.lastInsertRowid), createdAt: now };
}
function getAllExpenses(since) {
    const database = getFinanceDb();
    const rows = since
        ? database
            .prepare(`SELECT * FROM expenses WHERE expense_date >= ? ORDER BY expense_date DESC`)
            .all(since)
        : database
            .prepare(`SELECT * FROM expenses ORDER BY expense_date DESC`)
            .all();
    return rows.map(rowToExpense);
}
function getRecentExpenses(limit = 50) {
    const database = getFinanceDb();
    const rows = database
        .prepare(`SELECT * FROM expenses ORDER BY expense_date DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToExpense);
}
function monthStartIso(d = new Date()) {
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split("T")[0];
}
function yearStartIso(d = new Date()) {
    return new Date(d.getFullYear(), 0, 1).toISOString().split("T")[0];
}
function weekStartIso(d = new Date()) {
    const copy = new Date(d);
    copy.setDate(copy.getDate() - 7);
    return copy.toISOString().split("T")[0];
}
function normalizeSource(source) {
    if (!source)
        return "manual";
    const s = source.toLowerCase();
    if (s.includes("instagram") || s.includes("ig"))
        return "instagram";
    if (s.includes("tiktok") || s.includes("tt"))
        return "tiktok";
    if (s.includes("mojo"))
        return "mojo";
    if (s.includes("referral"))
        return "referral";
    return s.slice(0, 32);
}
function getGCISummary() {
    const mtdStart = monthStartIso();
    const ytdStart = yearStartIso();
    const all = getAllCommissions();
    const mtdDeals = all.filter((c) => c.closedAt >= mtdStart);
    const ytdDeals = all.filter((c) => c.closedAt >= ytdStart);
    const bySource = {};
    for (const c of ytdDeals) {
        const src = normalizeSource(c.leadSource);
        if (!bySource[src])
            bySource[src] = { gross: 0, net: 0, count: 0 };
        bySource[src].gross += c.grossCommissionAmount;
        bySource[src].net += c.netCommission;
        bySource[src].count += 1;
    }
    const monthlyMap = new Map();
    for (const c of all) {
        const month = c.closedAt.slice(0, 7);
        const cur = monthlyMap.get(month) || { gross: 0, net: 0 };
        cur.gross += c.grossCommissionAmount;
        cur.net += c.netCommission;
        monthlyMap.set(month, cur);
    }
    const monthlyTrend = Array.from(monthlyMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => ({ month, gross: Math.round(v.gross), net: Math.round(v.net) }));
    const now = new Date();
    const priorYearStart = new Date(now.getFullYear() - 1, 0, 1).toISOString().split("T")[0];
    const priorYearEnd = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
        .toISOString()
        .split("T")[0];
    const priorYearDeals = all.filter((c) => c.closedAt >= priorYearStart && c.closedAt <= priorYearEnd);
    const priorYearYtdGross = priorYearDeals.length
        ? Math.round(priorYearDeals.reduce((s, c) => s + c.grossCommissionAmount, 0))
        : null;
    return {
        mtdGross: Math.round(mtdDeals.reduce((s, c) => s + c.grossCommissionAmount, 0)),
        mtdNet: Math.round(mtdDeals.reduce((s, c) => s + c.netCommission, 0)),
        ytdGross: Math.round(ytdDeals.reduce((s, c) => s + c.grossCommissionAmount, 0)),
        ytdNet: Math.round(ytdDeals.reduce((s, c) => s + c.netCommission, 0)),
        byDeal: all,
        bySource,
        monthlyTrend,
        priorYearYtdGross,
    };
}
async function getExpenseSummary() {
    const mtdStart = monthStartIso();
    const weekStart = weekStartIso();
    const ytdStart = yearStartIso();
    const all = getAllExpenses();
    const mtd = all.filter((e) => e.expenseDate >= mtdStart);
    const week = all.filter((e) => e.expenseDate >= weekStart);
    const byCategory = {};
    for (const e of mtd) {
        byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
    }
    const biggestThisWeek = week.length > 0
        ? week.reduce((max, e) => (e.amount > max.amount ? e : max), week[0])
        : null;
    const commissions = getAllCommissions(ytdStart);
    const leads = await (0, db_js_1.listAllLeads)();
    const costPerLeadBySource = {};
    const costPerClosedBySource = {};
    const sources = new Set();
    for (const e of all)
        if (e.leadSource)
            sources.add(normalizeSource(e.leadSource));
    for (const c of commissions)
        if (c.leadSource)
            sources.add(normalizeSource(c.leadSource));
    for (const l of leads)
        if (l.source)
            sources.add(normalizeSource(l.source));
    for (const src of sources) {
        const spend = all
            .filter((e) => normalizeSource(e.leadSource) === src)
            .reduce((s, e) => s + e.amount, 0);
        const leadCount = leads.filter((l) => normalizeSource(l.source) === src).length;
        const closings = commissions.filter((c) => normalizeSource(c.leadSource) === src).length;
        costPerLeadBySource[src] = {
            spend: Math.round(spend * 100) / 100,
            leads: leadCount,
            costPerLead: leadCount > 0 ? Math.round((spend / leadCount) * 100) / 100 : null,
        };
        costPerClosedBySource[src] = {
            spend: Math.round(spend * 100) / 100,
            closings,
            costPerClose: closings > 0 ? Math.round((spend / closings) * 100) / 100 : null,
        };
    }
    return {
        mtdTotal: Math.round(mtd.reduce((s, e) => s + e.amount, 0) * 100) / 100,
        weekTotal: Math.round(week.reduce((s, e) => s + e.amount, 0) * 100) / 100,
        biggestThisWeek: biggestThisWeek
            ? {
                amount: biggestThisWeek.amount,
                vendor: biggestThisWeek.vendor,
                category: biggestThisWeek.category,
                description: biggestThisWeek.description,
            }
            : null,
        byCategory,
        costPerLeadBySource,
        costPerClosedBySource,
        recent: getRecentExpenses(50),
    };
}
const STAGE_WEIGHTS = {
    active: 0.2,
    under_contract: 0.75,
    pending: 0.9,
    closed: 1,
};
function stageConfidence(weight) {
    if (weight >= 0.75)
        return "high";
    if (weight >= 0.5)
        return "medium";
    return "low";
}
function generatePipelineProjection() {
    const grossPct = defaultGrossCommissionPct();
    const txs = (0, transactionsStore_js_1.getAllTransactions)().filter((t) => t.status !== "closed" && t.status !== "fell_through");
    const deals = txs.map((tx) => {
        const price = tx.price || 0;
        const weight = STAGE_WEIGHTS[tx.status] ?? 0.2;
        const gross = Math.round(price * grossPct * 100) / 100;
        const weighted = Math.round(gross * weight * 100) / 100;
        return {
            dealId: tx.id || "",
            address: tx.address,
            status: tx.status,
            stageWeightPct: Math.round(weight * 100),
            price,
            grossCommissionAmount: gross,
            weightedGCI: weighted,
            projectedCloseDate: tx.closingDate,
            confidence: stageConfidence(weight),
        };
    });
    deals.sort((a, b) => b.weightedGCI - a.weightedGCI);
    const totalWeightedGCI = Math.round(deals.reduce((s, d) => s + d.weightedGCI, 0));
    const avgWeight = deals.length > 0 ? deals.reduce((s, d) => s + d.stageWeightPct, 0) / deals.length / 100 : 0;
    return {
        totalWeightedGCI,
        dealCount: deals.length,
        confidence: stageConfidence(avgWeight),
        deals,
    };
}
function logFinanceAlert(alertType, message, data) {
    const database = getFinanceDb();
    const now = new Date().toISOString();
    const result = database
        .prepare(`INSERT INTO finance_alerts (alert_type, message, data, sent_at, acknowledged) VALUES (?, ?, ?, ?, 0)`)
        .run(alertType, message, data ? JSON.stringify(data) : null, now);
    return Number(result.lastInsertRowid);
}
function getFinanceAlerts(limit = 30) {
    const database = getFinanceDb();
    const rows = database
        .prepare(`SELECT * FROM finance_alerts ORDER BY sent_at DESC LIMIT ?`)
        .all(limit);
    return rows.map((r) => ({
        id: Number(r.id),
        alertType: r.alert_type,
        message: String(r.message),
        data: r.data ? JSON.parse(String(r.data)) : null,
        sentAt: String(r.sent_at),
        acknowledged: Number(r.acknowledged) === 1,
    }));
}
function acknowledgeFinanceAlert(id) {
    const database = getFinanceDb();
    const result = database.prepare(`UPDATE finance_alerts SET acknowledged = 1 WHERE id = ?`).run(id);
    return result.changes > 0;
}
