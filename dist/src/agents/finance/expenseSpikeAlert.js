"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runExpenseSpikeCheck = runExpenseSpikeCheck;
exports.scheduleExpenseSpikeCheckWeekly = scheduleExpenseSpikeCheckWeekly;
const financeStore_js_1 = require("../../core/financeStore.js");
const index_js_1 = require("../../integrations/twilio/index.js");
function weekStartIso(d = new Date()) {
    const copy = new Date(d);
    copy.setDate(copy.getDate() - 7);
    return copy.toISOString().split("T")[0];
}
function fourWeekAvgWeeklySpend() {
    const since = new Date();
    since.setDate(since.getDate() - 28);
    const expenses = (0, financeStore_js_1.getAllExpenses)(since.toISOString().split("T")[0]);
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    return total / 4;
}
async function runExpenseSpikeCheck() {
    const weekStart = weekStartIso();
    const weekExpenses = (0, financeStore_js_1.getAllExpenses)(weekStart);
    const weekTotal = weekExpenses.reduce((s, e) => s + e.amount, 0);
    const avgWeekly = fourWeekAvgWeeklySpend();
    if (avgWeekly <= 0 || weekTotal <= avgWeekly * 1.5) {
        return { alerted: false };
    }
    const spikePct = Math.round(((weekTotal - avgWeekly) / avgWeekly) * 100);
    const byCat = {};
    for (const e of weekExpenses) {
        byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    }
    const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
    const message = [
        "📈 Expense Spike Alert",
        "",
        `This week: $${Math.round(weekTotal).toLocaleString()} (+${spikePct}% vs 4-wk avg)`,
        topCat ? `Largest category: ${topCat[0]} ($${Math.round(topCat[1]).toLocaleString()})` : null,
    ]
        .filter(Boolean)
        .join("\n");
    (0, financeStore_js_1.logFinanceAlert)("expense_spike", message, { weekTotal, avgWeekly, spikePct, byCat });
    const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
    if (marcoNumber) {
        await (0, index_js_1.sendTwilioMessage)(marcoNumber, message);
    }
    return { alerted: true, spikePct };
}
function scheduleExpenseSpikeCheckWeekly() {
    const check = () => {
        const now = new Date();
        const cst = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            weekday: "short",
            hour: "numeric",
            hour12: false,
        }).formatToParts(now);
        const weekday = cst.find((p) => p.type === "weekday")?.value;
        const hour = parseInt(cst.find((p) => p.type === "hour")?.value || "0", 10);
        if (weekday === "Mon" && hour === 8) {
            void runExpenseSpikeCheck();
        }
    };
    setInterval(check, 60 * 60 * 1000);
    check();
}
