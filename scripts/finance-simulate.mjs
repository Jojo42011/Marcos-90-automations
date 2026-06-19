/**
 * Seed finance.db with realistic sample data and print what each dashboard tab would show.
 * Usage: npm run build && node scripts/finance-simulate.mjs
 *
 * Optional: MONTHLY_GCI_GOAL=50000 node scripts/finance-simulate.mjs
 * (Restart server with same env for live pace ring on /finance)
 */
import {
  createCommission,
  createExpense,
  logFinanceAlert,
  getGCISummary,
  getExpenseSummary,
  generatePipelineProjection,
  getFinanceAlerts,
} from "../dist/src/core/financeStore.js";
import { getCurrentPaceStatus } from "../dist/src/agents/finance/paceAlert.js";
import { buildWeeklyFinanceSummaryData } from "../dist/src/agents/finance/weeklyFinanceSummary.js";

const BASE = process.env.FINANCE_SIM_BASE || "http://localhost:3000";
const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function monthIso(y, m, day) {
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

console.log("=== Finance dashboard simulation ===\n");

// Sample commissions — mix of sources and months for sparkline / MTD / YTD
const commissions = [
  { address: "1842 Stone Oak Pkwy", salePrice: 545000, source: "instagram", daysAgo: 1, type: "buyer" },
  { address: "902 Bulverde Rd", salePrice: 425000, source: "tiktok", daysAgo: 12, type: "buyer" },
  { address: "12015 Huebner Rd", salePrice: 620000, source: "referral", daysAgo: 45, type: "seller" },
  { address: "5510 Babcock Rd #12", salePrice: 310000, source: "mojo", daysAgo: 70, type: "buyer" },
  { address: "7810 Broadway St", salePrice: 480000, source: "instagram", daysAgo: 95, type: "buyer" },
];

for (const c of commissions) {
  createCommission({
    address: c.address,
    salePrice: c.salePrice,
    grossCommissionPct: 0.03,
    dealType: c.type,
    leadSource: c.source,
    closedAt: isoDaysAgo(c.daysAgo),
  });
}

// Expenses — marketing + tools for CPL / spike context
const expenses = [
  { category: "marketing", vendor: "Meta Ads", amount: 850, source: "instagram", daysAgo: 2 },
  { category: "marketing", vendor: "TikTok Promote", amount: 320, source: "tiktok", daysAgo: 4 },
  { category: "lead_gen", vendor: "Mojo Dialer", amount: 199, source: "mojo", daysAgo: 6 },
  { category: "tools_subscriptions", vendor: "Follow Up Boss", amount: 89, daysAgo: 8 },
  { category: "transaction_costs", vendor: "Title Co", amount: 450, daysAgo: 14 },
  { category: "marketing", vendor: "Meta Ads", amount: 1200, source: "instagram", daysAgo: 20 },
];

for (const e of expenses) {
  createExpense({
    category: e.category,
    vendor: e.vendor,
    amount: e.amount,
    leadSource: e.source,
    expenseDate: isoDaysAgo(e.daysAgo),
    description: "Simulated expense",
  });
}

logFinanceAlert(
  "pace_behind",
  "MTD gross GCI is 18% below expected pace for day 19 of the month.",
  { mtdGross: 16350, expectedPace: 19900, paceVariance: -18 },
);
logFinanceAlert(
  "expense_spike",
  "This week: $1,369 (+62% vs 4-wk avg)\nLargest category: marketing ($1,170)",
  { weekTotal: 1369, spikePct: 62 },
);

const gci = getGCISummary();
const expensesSummary = await getExpenseSummary();
const projection = generatePipelineProjection();
const pace = getCurrentPaceStatus();
const weekly = await buildWeeklyFinanceSummaryData();
const alerts = getFinanceAlerts(5);

console.log("── OVERVIEW TAB ──");
if (!pace.configured) {
  console.log("  Pace ring: gray — set MONTHLY_GCI_GOAL in .env (e.g. 50000) and restart server");
} else {
  console.log(`  Pace ring: ${pace.pctOfGoal}% of $${pace.goal.toLocaleString()} goal (${pace.onTrack ? "on track" : "behind"})`);
}
console.log(`  MTD GCI gross: ${fmt(gci.mtdGross)} · net: ${fmt(gci.mtdNet)}`);
console.log(`  YTD GCI gross: ${fmt(gci.ytdGross)}`);
console.log(`  Pipeline weighted: ${fmt(projection.totalWeightedGCI)} (${projection.dealCount} deals)`);
console.log(`  Recent commission: ${commissions[0].address} → ${fmt(545000 * 0.03 * 0.5)} net (fresh glow if closed <24h)`);
console.log(`  Biggest expense this week: ${expensesSummary.biggestThisWeek ? fmt(expensesSummary.biggestThisWeek.amount) + " " + (expensesSummary.biggestThisWeek.vendor || "") : "—"}`);
console.log(`  MTD expenses: ${fmt(expensesSummary.mtdTotal)}`);

console.log("\n── GCI TRACKER TAB ──");
console.log(`  YTD gross: ${fmt(gci.ytdGross)} · trend points: ${gci.monthlyTrend.map((m) => m.month + ":" + fmt(m.gross)).join(", ")}`);
console.log(`  By source: ${Object.entries(gci.bySource).map(([s, v]) => s + " " + fmt(v.gross)).join(" · ")}`);

console.log("\n── EXPENSES TAB ──");
console.log(`  Categories: ${Object.entries(expensesSummary.byCategory).map(([k, v]) => k + " " + fmt(v)).join(" · ")}`);

console.log("\n── PIPELINE PROJECTION TAB ──");
console.log(`  Weighted GCI: ${fmt(projection.totalWeightedGCI)} · confidence: ${projection.confidence}`);
if (projection.deals.length) {
  projection.deals.slice(0, 3).forEach((d) =>
    console.log(`    · ${d.address} (${d.status} ${d.stageWeightPct}%) → ${fmt(d.weightedGCI)}`),
  );
} else {
  console.log("    (no active transactions in DB — add under_contract deals in CRM Transactions)");
}

console.log("\n── REPORTS TAB (preview only, no SMS) ──");
console.log(`  Weekly: MTD ${fmt(weekly.gci.mtdGross)} · expenses ${fmt(weekly.expenses.mtdTotal)}`);
console.log(`  Monthly: net after expenses ${fmt(weekly.gci.mtdNet - weekly.expenses.mtdTotal)}`);

console.log("\n── ALERTS TAB ──");
alerts.forEach((a) => console.log(`  [${a.alertType}] ${a.acknowledged ? "✓" : "●"} ${a.message.split("\n")[0]}`));

// Live API check if server running
try {
  const paceRes = await fetch(`${BASE}/api/finance/pace-status`);
  if (paceRes.ok) {
    const live = await paceRes.json();
    console.log("\n── LIVE API (server) ──");
    console.log(`  GET /api/finance/pace-status → configured=${live.configured}${live.configured ? `, ${live.pctOfGoal}%` : ""}`);
    console.log(`  Open dashboard: ${BASE}/finance`);
  }
} catch {
  console.log("\n(Server not running — seed data is in finance.db; start server and open /finance)");
}

console.log("\n✓ Simulation complete. Refresh http://localhost:3000/finance to see populated tabs.\n");
