import { getThreadForLead } from "./smsStore.js";

const QUIET_HOURS_START = 21;
const QUIET_HOURS_END = 8;
const TIMEZONE = "America/Chicago";

function centralHour(now = new Date()): number {
  return Number(
    now.toLocaleString("en-US", {
      timeZone: TIMEZONE,
      hour: "2-digit",
      hour12: false,
    }),
  );
}

/**
 * Returns true if it's currently within allowed texting hours (8am-9pm Central).
 */
export function isWithinTextingHours(now = new Date()): boolean {
  const hour = centralHour(now);
  return hour >= QUIET_HOURS_END && hour < QUIET_HOURS_START;
}

/**
 * Returns the number of consecutive outbound messages sent to this lead
 * since their last inbound reply (i.e. unanswered follow-ups).
 */
export function getUnansweredFollowUpCount(leadId: string): number {
  const thread = getThreadForLead(leadId, 100);
  let count = 0;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].direction === "inbound") break;
    if (thread[i].direction === "outbound") count++;
  }
  return count;
}

export interface TextingGateResult {
  allowed: boolean;
  reason?: string;
  retryAfter?: string;
}

/**
 * Master gate for automated proactive outbound texts (not inbound replies).
 */
export function checkTextingAllowed(leadId: string, now = new Date()): TextingGateResult {
  if (!isWithinTextingHours(now)) {
    const hour = centralHour(now);
    const nextAllowed = new Date(now);
    if (hour >= QUIET_HOURS_START) {
      nextAllowed.setDate(nextAllowed.getDate() + 1);
    }
    nextAllowed.setUTCHours(13, 0, 0, 0);

    return {
      allowed: false,
      reason: `Outside texting hours (8am-9pm Central). Current hour: ${hour}.`,
      retryAfter: nextAllowed.toISOString(),
    };
  }

  const unanswered = getUnansweredFollowUpCount(leadId);
  if (unanswered >= 2) {
    return {
      allowed: false,
      reason: `Lead has ${unanswered} unanswered outbound messages — max 2 reached without reply.`,
    };
  }

  return { allowed: true };
}
