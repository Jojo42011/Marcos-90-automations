import { getAllExpenses, logFinanceAlert } from "../../core/financeStore.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";

function weekStartIso(d = new Date()): string {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - 7);
  return copy.toISOString().split("T")[0];
}

function fourWeekAvgWeeklySpend(): number {
  const since = new Date();
  since.setDate(since.getDate() - 28);
  const expenses = getAllExpenses(since.toISOString().split("T")[0]);
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  return total / 4;
}

export async function runExpenseSpikeCheck(): Promise<{ alerted: boolean; spikePct?: number }> {
  const weekStart = weekStartIso();
  const weekExpenses = getAllExpenses(weekStart);
  const weekTotal = weekExpenses.reduce((s, e) => s + e.amount, 0);
  const avgWeekly = fourWeekAvgWeeklySpend();

  if (avgWeekly <= 0 || weekTotal <= avgWeekly * 1.5) {
    return { alerted: false };
  }

  const spikePct = Math.round(((weekTotal - avgWeekly) / avgWeekly) * 100);
  const byCat: Record<string, number> = {};
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

  logFinanceAlert("expense_spike", message, { weekTotal, avgWeekly, spikePct, byCat });

  const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
  if (marcoNumber) {
    await sendTwilioMessage(marcoNumber, message);
  }

  return { alerted: true, spikePct };
}

export function scheduleExpenseSpikeCheckWeekly(): void {
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
