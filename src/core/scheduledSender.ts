/** Durable scheduled delivery. Ambiguous outcomes require review instead of an unsafe retry. */
import {
  dueMessages,
  claimScheduled,
  markUncertain,
  markAttemptFailed,
  markSent,
  type ScheduledChannel,
  type ScheduledMessage,
} from "./scheduledMessages.js";
import { isTwilioConfigured, sendTwilioMessage } from "../integrations/twilio/index.js";
import { isEmailConfigured, sendEmail } from "../integrations/email/index.js";
import { checkGmailAuth } from "../integrations/gmail/index.js";

/**
 * Can this channel actually deliver right now?
 *
 * For email this **exercises the refresh token**, it does not just check that
 * credentials are present. `isEmailConfigured()` only asks whether the env
 * vars exist, which reported "email is fine" against a token Google had been
 * rejecting for hours — the same false green that hid a total email outage
 * behind `/api/email/connection-status`. A capability check that can't fail
 * is worse than no check, because everything downstream repeats its answer.
 *
 * The access token is cached after a successful handshake, so repeat calls
 * are cheap.
 */
export async function canSendOn(
  channel: ScheduledChannel,
): Promise<{ ok: boolean; reason?: string }> {
  if (channel === "sms") {
    // Twilio has no equivalent handshake; presence of credentials is all we
    // can know without sending something real.
    return isTwilioConfigured()
      ? { ok: true }
      : { ok: false, reason: "Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER." };
  }
  if (!isEmailConfigured()) {
    return { ok: false, reason: "Gmail is not connected — relink at /api/email/gmail-oauth/start." };
  }
  const auth = await checkGmailAuth();
  return auth.ok
    ? { ok: true }
    : { ok: false, reason: `Gmail rejected its token (${auth.error}) — relink at /api/email/gmail-oauth/start.` };
}

class NotConfigured extends Error {}
async function deliver(msg: ScheduledMessage): Promise<void> {
  if (msg.channel === "sms") {
    if (!isTwilioConfigured()) throw new NotConfigured("SMS is not configured");
    const res = await sendTwilioMessage(msg.to, msg.body);
    if (!res.success) throw new Error(res.error || "Twilio send failed");
    return;
  }
  if (!isEmailConfigured()) throw new NotConfigured("Email is not configured");
  const res = await sendEmail(msg.to, msg.subject || "Message from Marco Puga Realty", msg.body);
  if (!res.success) throw new Error(res.error || "Email send failed");
}

/** Process everything due. Returns what happened, for logs and tests. */
export async function processDueMessages(
  at: Date = new Date(),
): Promise<{ attempted: number; sent: number; failed: number }> {
  const due = dueMessages(at);
  let sent = 0;
  let failed = 0;

  for (const candidate of due) {
    const msg = claimScheduled(candidate.id);
    if (!msg) continue;
    try {
      await deliver(msg);
      markSent(msg.id);
      sent++;
      console.log(`[scheduled] sent ${msg.channel} to ${msg.to} (${msg.id})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof NotConfigured) markAttemptFailed(msg.id,reason);
      else markUncertain(msg.id, "Delivery outcome requires review: " + reason);
      failed++;
      console.error(`[scheduled] ${msg.channel} to ${msg.to} failed: ${reason}`);
    }
  }

  return { attempted: due.length, sent, failed };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the loop. 60s is deliberate: a minute of slack on "send Tuesday
 * morning" is invisible, and it keeps an idle queue nearly free.
 */
export function startScheduledSender(intervalMs = 60_000): void {
  if (timer) return;
  const tick = () => {
    void processDueMessages().catch((err) => console.error("[scheduled] tick failed:", err));
  };
  timer = setInterval(tick, intervalMs);
  // Don't hold the process open just for this.
  if (typeof timer.unref === "function") timer.unref();

  void Promise.all([canSendOn("sms"), canSendOn("email")]).then(([sms, email]) => {
    console.log(
      `[scheduled] sender started — checking every ${Math.round(intervalMs / 1000)}s ` +
        `(sms: ${sms.ok ? "ready" : "UNAVAILABLE"}, email: ${email.ok ? "ready" : "UNAVAILABLE"})`,
    );
  });
  tick();
}

export function stopScheduledSender(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
