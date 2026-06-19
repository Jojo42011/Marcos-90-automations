import { getAllCommissions, logFinanceAlert } from "../../core/financeStore.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";

export function getCurrentPaceStatus() {
  const goal = parseFloat(process.env.MONTHLY_GCI_GOAL || "0");
  if (!goal || goal <= 0) {
    return { configured: false as const, goal: 0 };
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();

  const commissions = getAllCommissions(monthStart);
  const mtdGross = commissions.reduce((s, c) => s + c.grossCommissionAmount, 0);
  const expectedPace = goal * (dayOfMonth / daysInMonth);
  const paceVariance =
    expectedPace > 0 ? Math.round(((mtdGross - expectedPace) / expectedPace) * 100) : 0;

  return {
    configured: true as const,
    goal,
    mtdGross: Math.round(mtdGross),
    expectedPace: Math.round(expectedPace),
    paceVariance,
    onTrack: paceVariance >= -20,
    dayOfMonth,
    daysInMonth,
    pctOfGoal: goal > 0 ? Math.round((mtdGross / goal) * 100) : 0,
  };
}

export async function runPaceCheck(): Promise<{ alerted: boolean; pace: ReturnType<typeof getCurrentPaceStatus> }> {
  const pace = getCurrentPaceStatus();
  if (!pace.configured) {
    return { alerted: false, pace };
  }
  if (pace.onTrack) {
    return { alerted: false, pace };
  }

  const message = [
    "⚠️ Pace Alert — behind monthly GCI goal",
    "",
    `MTD gross: $${pace.mtdGross.toLocaleString()}`,
    `Expected pace: $${pace.expectedPace.toLocaleString()} (${pace.paceVariance}% behind)`,
    `Goal: $${pace.goal.toLocaleString()} · Day ${pace.dayOfMonth}/${pace.daysInMonth}`,
  ].join("\n");

  logFinanceAlert("pace_behind", message, {
    mtdGross: pace.mtdGross,
    expectedPace: pace.expectedPace,
    paceVariance: pace.paceVariance,
    goal: pace.goal,
  });

  const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
  if (marcoNumber) {
    await sendTwilioMessage(marcoNumber, message);
  }

  return { alerted: true, pace };
}

export function schedulePaceCheckDaily(): void {
  const check = () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    if (hour === 9) {
      void runPaceCheck();
    }
  };
  setInterval(check, 60 * 60 * 1000);
  check();
}
