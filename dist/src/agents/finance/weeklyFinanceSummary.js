"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildWeeklyFinanceSummaryData = buildWeeklyFinanceSummaryData;
exports.runWeeklyFinanceSummary = runWeeklyFinanceSummary;
exports.scheduleWeeklyFinanceSummary = scheduleWeeklyFinanceSummary;
const financeStore_js_1 = require("../../core/financeStore.js");
const index_js_1 = require("../../integrations/twilio/index.js");
async function buildWeeklyFinanceSummaryData() {
    const [gci, expenses, projection] = await Promise.all([
        Promise.resolve((0, financeStore_js_1.getGCISummary)()),
        (0, financeStore_js_1.getExpenseSummary)(),
        Promise.resolve((0, financeStore_js_1.generatePipelineProjection)()),
    ]);
    return { gci, expenses, projection, generatedAt: new Date().toISOString() };
}
function formatWeeklySms(data) {
    return [
        "💰 Weekly Finance Summary",
        "",
        `MTD GCI: $${data.gci.mtdGross.toLocaleString()} gross · $${data.gci.mtdNet.toLocaleString()} net`,
        `YTD GCI: $${data.gci.ytdGross.toLocaleString()} gross`,
        `MTD expenses: $${data.expenses.mtdTotal.toLocaleString()}`,
        `Pipeline projection: $${data.projection.totalWeightedGCI.toLocaleString()} weighted (${data.projection.dealCount} deals)`,
    ].join("\n");
}
async function runWeeklyFinanceSummary() {
    const data = await buildWeeklyFinanceSummaryData();
    const message = formatWeeklySms(data);
    const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
    if (!marcoNumber) {
        console.log("[WeeklyFinance] No MARCO_PHONE_NUMBER — summary:\n", message);
        return { sent: false };
    }
    const result = await (0, index_js_1.sendTwilioMessage)(marcoNumber, message);
    return { sent: result.success };
}
function scheduleWeeklyFinanceSummary() {
    let lastRunWeek = "";
    const check = () => {
        const now = new Date();
        const cst = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            weekday: "short",
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        }).formatToParts(now);
        const weekday = cst.find((p) => p.type === "weekday")?.value;
        const hour = parseInt(cst.find((p) => p.type === "hour")?.value || "0", 10);
        const minute = parseInt(cst.find((p) => p.type === "minute")?.value || "0", 10);
        const weekKey = now.toISOString().slice(0, 10);
        if (weekday === "Fri" && hour === 17 && minute < 5 && lastRunWeek !== weekKey) {
            lastRunWeek = weekKey;
            void runWeeklyFinanceSummary();
        }
    };
    setInterval(check, 60 * 1000);
    check();
}
