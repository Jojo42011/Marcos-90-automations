import { sendEmail } from "../../integrations/email/index.js";
import {
  logEmail,
  markEmailSent,
  markEmailFailed,
  startDripSequence,
  updateDripSequence,
  getActiveSequencesDueNow,
} from "../../core/emailStore.js";
import { findLeadById } from "../../core/db.js";
import type { Lead } from "../../core/types.js";

const BUYER_DRIP_DAYS = [0, 3, 7, 10, 14, 21];

interface DripStep {
  subject: (firstName: string) => string;
  body: (firstName: string, lead: Lead) => string;
}

const BUYER_DRIP_STEPS: DripStep[] = [
  {
    subject: (n) => `Welcome, ${n} — let's find your next home`,
    body: (n) =>
      `Hi ${n},\n\nThanks for connecting! I'm excited to help you find the right home. Over the next few weeks I'll send a few helpful resources — but if you ever want to jump straight to looking at properties, just let me know.\n\nMarco`,
  },
  {
    subject: (n) => `${n}, here's what to know about getting pre-approved`,
    body: (n) =>
      `Hi ${n},\n\nOne of the biggest advantages in today's market is having a pre-approval ready before you fall in love with a home. If you haven't started that process yet, I'm happy to point you toward a few great local lenders.\n\nMarco`,
  },
  {
    subject: () => `A few neighborhoods worth a look`,
    body: (n) =>
      `Hi ${n},\n\nDepending on what you're looking for, a few San Antonio-area neighborhoods have been getting a lot of buyer interest lately. Want me to send a curated list based on your price range and must-haves?\n\nMarco`,
  },
  {
    subject: () => `What to expect when you make an offer`,
    body: (n) =>
      `Hi ${n},\n\nWhen the right home comes along, here's a quick rundown of what the offer process looks like so there are no surprises. Happy to walk through it on a call anytime.\n\nMarco`,
  },
  {
    subject: () => `Quick market check-in`,
    body: (n) =>
      `Hi ${n},\n\nWanted to share a quick update on how the market's moving in your target area. Let me know if your timeline or criteria have changed at all!\n\nMarco`,
  },
  {
    subject: () => `Still here whenever you're ready`,
    body: (n) =>
      `Hi ${n},\n\nNo pressure at all — just wanted to check in one more time. Whenever you're ready to take the next step, or if you have any questions in the meantime, I'm just a text or email away.\n\nMarco`,
  },
];

export function startBuyerDrip(leadId: string): void {
  startDripSequence(leadId, "buyer_drip", new Date().toISOString());
  console.log("[BuyerDrip] Started for lead", leadId);
}

export async function processDueBuyerDrips(): Promise<{ sent: number }> {
  const due = getActiveSequencesDueNow("buyer_drip");
  let sent = 0;

  for (const seq of due) {
    const lead = await findLeadById(seq.leadId);
    if (!lead || !lead.email) {
      updateDripSequence(seq.id!, { status: "stopped" });
      continue;
    }

    const step = seq.currentStep;
    if (step >= BUYER_DRIP_STEPS.length) {
      updateDripSequence(seq.id!, { status: "completed" });
      continue;
    }

    const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
    const stepDef = BUYER_DRIP_STEPS[step];
    const subject = stepDef.subject(firstName);
    const body = stepDef.body(firstName, lead);

    const emailRecord = logEmail({
      leadId: lead.id,
      subject,
      body,
      emailType: "buyer_drip",
      sequenceStep: step,
      sendStatus: "pending",
    });
    const result = await sendEmail(lead.email, subject, body);

    if (result.success) markEmailSent(emailRecord.id!, result.messageId);
    else markEmailFailed(emailRecord.id!, result.error || "unknown");
    sent++;

    const nextStep = step + 1;
    if (nextStep >= BUYER_DRIP_STEPS.length) {
      updateDripSequence(seq.id!, { currentStep: nextStep, status: "completed" });
    } else {
      const daysUntilNext = BUYER_DRIP_DAYS[nextStep] - BUYER_DRIP_DAYS[step];
      const nextSendDate = new Date(Date.now() + daysUntilNext * 24 * 60 * 60 * 1000).toISOString();
      updateDripSequence(seq.id!, { currentStep: nextStep, nextSendDate });
    }
  }

  console.log("[BuyerDrip] Processed", sent, "due emails");
  return { sent };
}

export function scheduleBuyerDripProcessor(): void {
  setInterval(() => {
    processDueBuyerDrips().catch((err) => console.error("[BuyerDrip]", err));
  }, 60 * 60 * 1000);
  console.log("[BuyerDrip] Scheduled — checking hourly");
}
