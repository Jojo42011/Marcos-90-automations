import { getGCISummary, getExpenseSummary } from "../../core/financeStore.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";
import { getCurrentPaceStatus } from "./paceAlert.js";

export async function buildMonthlyCloseReportData() {
  const gci = getGCISummary();
  const expenses = await getExpenseSummary();
  const pace = getCurrentPaceStatus();
  const netAfterExpenses = gci.mtdNet - expenses.mtdTotal;
  const roi =
    expenses.mtdTotal > 0 ? Math.round((gci.mtdGross / expenses.mtdTotal) * 100) / 100 : null;

  return {
    gci,
    expenses,
    pace,
    netAfterExpenses: Math.round(netAfterExpenses),
    roi,
    generatedAt: new Date().toISOString(),
  };
}

function formatMonthlySms(data: Awaited<ReturnType<typeof buildMonthlyCloseReportData>>): string {
  const goalLine =
    data.pace.configured && data.pace.goal
      ? `Goal: $${data.pace.goal.toLocaleString()} · ${data.pace.pctOfGoal}% achieved`
      : "Goal: not configured (set MONTHLY_GCI_GOAL)";
  return [
    "📊 Monthly Close Report",
    "",
    `Gross GCI: $${data.gci.mtdGross.toLocaleString()}`,
    `Net GCI: $${data.gci.mtdNet.toLocaleString()}`,
    `Expenses: $${data.expenses.mtdTotal.toLocaleString()}`,
    `Net after expenses: $${data.netAfterExpenses.toLocaleString()}`,
    data.roi != null ? `Marketing ROI: ${data.roi}x` : null,
    goalLine,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runMonthlyCloseReport(): Promise<{ sent: boolean }> {
  const data = await buildMonthlyCloseReportData();
  const message = formatMonthlySms(data);
  const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
  if (!marcoNumber) {
    console.log("[MonthlyClose] No MARCO_PHONE_NUMBER — report:\n", message);
    return { sent: false };
  }
  const result = await sendTwilioMessage(marcoNumber, message);
  return { sent: result.success };
}

export function scheduleMonthlyCloseReport(): void {
  let lastRunMonth = "";
  const check = () => {
    const now = new Date();
    const cst = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const day = parseInt(cst.find((p) => p.type === "day")?.value || "0", 10);
    const hour = parseInt(cst.find((p) => p.type === "hour")?.value || "0", 10);
    const monthKey = now.toISOString().slice(0, 7);
    if (day === 1 && hour === 9 && lastRunMonth !== monthKey) {
      lastRunMonth = monthKey;
      void runMonthlyCloseReport();
    }
  };
  setInterval(check, 60 * 1000);
  check();
}
