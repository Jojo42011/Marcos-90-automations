import { listAllLeads, updateLeadCrmFields } from "../../core/db.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";
import { logSmsMessage } from "../../core/smsStore.js";
import { getLeadFirstName } from "../../app/inboundReplyHelper.js";
import { checkTextingAllowed } from "../../core/textingRules.js";
import type { Lead, ShowingAppointment } from "../../core/types.js";

const SHOWING_REMINDER_PROMPT_TEMPLATE = (firstName: string, address: string, time: string) =>
  `Hey ${firstName}! Just a reminder — we've got your showing tomorrow at ${time} for ${address}. ` +
  `Can you reply YES to confirm you'll be there? Looking forward to it!`;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * 60 * 1000;
const FOLLOW_UP_DELAY_MS = 2 * 60 * 60 * 1000;
const FOLLOW_UP_WINDOW_MS = 15 * 60 * 1000;

const FOLLOW_UP_TEMPLATE = (firstName: string, address: string) =>
  `Hey ${firstName}! Hope you enjoyed checking out ${address} earlier — what did you think? ` +
  `Any questions or thoughts on next steps?`;

export interface ConfirmationResult {
  handled: boolean;
  replyMessage: string;
}

export interface FeedbackResult {
  handled: boolean;
  replyMessage: string;
}

const YES_PATTERNS =
  /^\s*(yes|yep|yeah|y|confirmed|i'?ll be there|sounds good|✅|👍)\s*[!.]*\s*$/i;
const NO_PATTERNS = /^\s*(no|nope|can'?t make it|cancel|reschedule)\s*[!.]*\s*$/i;

function showingTimeLabel(scheduledAt: string): string {
  return new Date(scheduledAt).toLocaleString("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });
}

function appointmentInReminderWindow(scheduledAt: string, nowMs: number): boolean {
  const scheduledTime = new Date(scheduledAt).getTime();
  const timeUntilShowing = scheduledTime - nowMs;
  return (
    timeUntilShowing > 0 &&
    timeUntilShowing <= TWENTY_FOUR_HOURS_MS &&
    timeUntilShowing > TWENTY_FOUR_HOURS_MS - WINDOW_MS
  );
}

/**
 * Checks all leads with upcoming showings and sends a 24h reminder
 * if one hasn't been sent yet for that appointment.
 */
export async function checkAndSendShowingReminders(): Promise<{ sent: number; checked: number }> {
  const leads = await listAllLeads();
  let sent = 0;
  let checked = 0;
  const now = Date.now();

  for (const lead of leads) {
    const appt = lead.showingAppointment;
    if (!appt || appt.reminderSentAt) continue;
    if (appt.confirmationStatus === "cancelled") continue;

    checked++;

    if (appointmentInReminderWindow(appt.scheduledAt, now)) {
      const success = await sendShowingReminder(lead, appt);
      if (success) sent++;
    }
  }

  console.log("[ShowingReminders] Checked", checked, "appointments, sent", sent, "reminders");
  return { sent, checked };
}

async function sendShowingReminder(
  lead: Lead,
  appt: ShowingAppointment,
): Promise<boolean> {
  const firstName = getLeadFirstName(lead) || "there";
  const showingTime = showingTimeLabel(appt.scheduledAt);
  const message = SHOWING_REMINDER_PROMPT_TEMPLATE(firstName, appt.address, showingTime);

  if (!lead.phone?.trim()) {
    console.warn("[ShowingReminders] Lead", lead.id, "has no phone — cannot send reminder");
    return false;
  }

  const gate = checkTextingAllowed(lead.id);
  if (!gate.allowed) {
    console.log("[TextingRules] Blocked showing reminder to", lead.id, "-", gate.reason);
    return false;
  }

  try {
    const send = await sendTwilioMessage({ to: lead.phone, content: message });
    if (!send.success) {
      console.error("[ShowingReminders] Twilio failed for", lead.id, ":", send.error);
      return false;
    }

    const reminderSentAt = new Date().toISOString();
    await updateLeadCrmFields({
      leadId: lead.id,
      showingAppointment: {
        ...appt,
        reminderSentAt,
        confirmationStatus: "pending",
      },
    });

    logSmsMessage({
      leadId: lead.id,
      messageBody: message,
      direction: "outbound",
      sentAt: reminderSentAt,
      threadType: "showing_reminder",
      messageHandle: send.messageSid,
    });

    console.log("[ShowingReminders] Sent reminder to", lead.id, "for showing at", appt.scheduledAt);
    return true;
  } catch (err) {
    console.error("[ShowingReminders] Failed to send to", lead.id, ":", err);
    return false;
  }
}

export async function checkShowingConfirmation(
  lead: Lead,
  incomingMessage: string,
): Promise<ConfirmationResult> {
  const appt = lead.showingAppointment;

  if (!appt || appt.confirmationStatus !== "pending" || !appt.reminderSentAt) {
    return { handled: false, replyMessage: "" };
  }

  const text = incomingMessage.trim();

  if (YES_PATTERNS.test(text)) {
    const confirmationReceivedAt = new Date().toISOString();
    await updateLeadCrmFields({
      leadId: lead.id,
      showingAppointment: {
        ...appt,
        confirmationStatus: "confirmed",
        confirmationReceivedAt,
      },
    });

    const firstName = getLeadFirstName(lead);
    return {
      handled: true,
      replyMessage: `Perfect${firstName ? ", " + firstName : ""}! See you then. Looking forward to it! 🏡`,
    };
  }

  if (NO_PATTERNS.test(text)) {
    await updateLeadCrmFields({
      leadId: lead.id,
      showingAppointment: {
        ...appt,
        confirmationStatus: "no_response",
      },
    });

    return {
      handled: true,
      replyMessage: "No problem — I'll have someone reach out to find a time that works better for you.",
    };
  }

  return { handled: false, replyMessage: "" };
}

export async function checkAndSendPostShowingFollowUps(): Promise<{ sent: number; checked: number }> {
  const leads = await listAllLeads();
  let sent = 0;
  let checked = 0;
  const now = Date.now();

  for (const lead of leads) {
    const appt = lead.showingAppointment;
    if (!appt) continue;
    if (appt.confirmationStatus !== "confirmed" || appt.followUpSentAt) continue;

    checked++;

    const showingTime = new Date(appt.scheduledAt).getTime();
    const timeSinceShowing = now - showingTime;

    if (
      timeSinceShowing >= FOLLOW_UP_DELAY_MS &&
      timeSinceShowing <= FOLLOW_UP_DELAY_MS + FOLLOW_UP_WINDOW_MS
    ) {
      const success = await sendPostShowingFollowUp(lead, appt);
      if (success) sent++;
    }
  }

  console.log("[ShowingFollowUp] Checked", checked, "confirmed showings, sent", sent, "follow-ups");
  return { sent, checked };
}

async function sendPostShowingFollowUp(
  lead: Lead,
  appt: ShowingAppointment,
): Promise<boolean> {
  if (!lead.phone?.trim()) return false;

  const gate = checkTextingAllowed(lead.id);
  if (!gate.allowed) {
    console.log("[TextingRules] Blocked post-showing follow-up to", lead.id, "-", gate.reason);
    return false;
  }

  const firstName = getLeadFirstName(lead) || "there";
  const message = FOLLOW_UP_TEMPLATE(firstName, appt.address);

  try {
    const send = await sendTwilioMessage({ to: lead.phone, content: message });
    if (!send.success) {
      console.error("[ShowingFollowUp] Twilio failed for", lead.id, ":", send.error);
      return false;
    }

    const followUpSentAt = new Date().toISOString();
    await updateLeadCrmFields({
      leadId: lead.id,
      showingAppointment: {
        ...appt,
        followUpSentAt,
      },
    });

    logSmsMessage({
      leadId: lead.id,
      messageBody: message,
      direction: "outbound",
      sentAt: followUpSentAt,
      threadType: "post_showing_followup",
      messageHandle: send.messageSid,
    });

    console.log("[ShowingFollowUp] Sent to", lead.id, "for showing at", appt.scheduledAt);
    return true;
  } catch (err) {
    console.error("[ShowingFollowUp] Failed for", lead.id, ":", err);
    return false;
  }
}

export async function checkPostShowingFeedback(
  lead: Lead,
  incomingMessage: string,
): Promise<FeedbackResult> {
  const appt = lead.showingAppointment;

  if (!appt || !appt.followUpSentAt || appt.followUpResponse) {
    return { handled: false, replyMessage: "" };
  }

  const text = incomingMessage.toLowerCase();
  let sentiment: "positive" | "negative" | "neutral" = "neutral";

  if (/love|great|perfect|interested|amazing|yes|want|offer/.test(text)) sentiment = "positive";
  if (/no|not for us|pass|too small|too expensive|didn'?t like|not interested/.test(text)) {
    sentiment = "negative";
  }

  await updateLeadCrmFields({
    leadId: lead.id,
    showingAppointment: {
      ...appt,
      followUpResponse: incomingMessage,
      followUpSentiment: sentiment,
    },
  });

  return { handled: false, replyMessage: "" };
}

export function scheduleShowingReminders(): void {
  setInterval(() => {
    checkAndSendShowingReminders().catch((err) =>
      console.error("[ShowingReminders] Check error:", err),
    );
    checkAndSendPostShowingFollowUps().catch((err) =>
      console.error("[ShowingFollowUp] Check error:", err),
    );
  }, 15 * 60 * 1000);

  console.log("[ShowingReminders] Scheduled — checking every 15 minutes");
}

export async function getUpcomingShowings(): Promise<
  Array<{
    leadId: string;
    name: string | null;
    phone: string | null;
    address: string;
    scheduledAt: string;
    reminderSentAt?: string;
    confirmationStatus: ShowingAppointment["confirmationStatus"];
    confirmationReceivedAt?: string;
  }>
> {
  const leads = await listAllLeads();
  const now = Date.now();
  return leads
    .filter((l) => l.showingAppointment && new Date(l.showingAppointment!.scheduledAt).getTime() > now)
    .map((l) => ({
      leadId: l.id,
      name: l.name || l.username,
      phone: l.phone,
      address: l.showingAppointment!.address,
      scheduledAt: l.showingAppointment!.scheduledAt,
      reminderSentAt: l.showingAppointment!.reminderSentAt,
      confirmationStatus: l.showingAppointment!.confirmationStatus,
      confirmationReceivedAt: l.showingAppointment!.confirmationReceivedAt,
    }))
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
}
