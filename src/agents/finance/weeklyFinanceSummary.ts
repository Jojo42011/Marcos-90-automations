import {
  getGCISummary,
  getExpenseSummary,
  generatePipelineProjection,
} from "../../core/financeStore.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";

export async function buildWeeklyFinanceSummaryData() {
  const [gci, expenses, projection] = await Promise.all([
    Promise.resolve(getGCISummary()),
    getExpenseSummary(),
    Promise.resolve(generatePipelineProjection()),
  ]);
  return { gci, expenses, projection, generatedAt: new Date().toISOString() };
}

function formatWeeklySms(data: Awaited<ReturnType<typeof buildWeeklyFinanceSummaryData>>): string {
  return [
    "💰 Weekly Finance Summary",
    "",
    `MTD GCI: $${data.gci.mtdGross.toLocaleString()} gross · $${data.gci.mtdNet.toLocaleString()} net`,
    `YTD GCI: $${data.gci.ytdGross.toLocaleString()} gross`,
    `MTD expenses: $${data.expenses.mtdTotal.toLocaleString()}`,
    `Pipeline projection: $${data.projection.totalWeightedGCI.toLocaleString()} weighted (${data.projection.dealCount} deals)`,
  ].join("\n");
}

export async function runWeeklyFinanceSummary(): Promise<{ sent: boolean }> {
  const data = await buildWeeklyFinanceSummaryData();
  const message = formatWeeklySms(data);
  const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
  if (!marcoNumber) {
    console.log("[WeeklyFinance] No MARCO_PHONE_NUMBER — summary:\n", message);
    return { sent: false };
  }
  const result = await sendTwilioMessage(marcoNumber, message);
  return { sent: result.success };
}

export function scheduleWeeklyFinanceSummary(): void {
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
