import { sendEmail } from "../../integrations/email/index.js";
import {
  logEmail,
  markEmailSent,
  markEmailFailed,
  getSequenceForLead,
  startDripSequence,
  updateDripSequence,
} from "../../core/emailStore.js";
import { listAllLeads } from "../../core/db.js";
import type { Lead } from "../../core/types.js";

interface QuarterlyStep {
  subject: (n: string) => string;
  body: (n: string) => string;
}

const QUARTERLY_CONTENT: Record<number, QuarterlyStep> = {
  1: {
    subject: (n) => `Happy home anniversary, ${n}!`,
    body: (n) =>
      `Hi ${n},\n\nJust thinking of you as another year goes by in your home! Hope everything's going great. As always, here if you ever need anything — even just a contractor recommendation.\n\nMarco`,
  },
  2: {
    subject: () => `Quick market update for your area`,
    body: (n) =>
      `Hi ${n},\n\nWanted to share a quick update on how home values have been trending in your neighborhood — always good info to have, even if you're not planning to move anytime soon.\n\nMarco`,
  },
  3: {
    subject: () => `A small favor, if you don't mind`,
    body: (n) =>
      `Hi ${n},\n\nHope things are going well! If you know anyone thinking about buying or selling, I'd really appreciate the introduction. Always happy to take great care of anyone you send my way.\n\nMarco`,
  },
  4: {
    subject: () => `Happy holidays from our family to yours`,
    body: (n) =>
      `Hi ${n},\n\nWishing you and your family a wonderful holiday season! Thank you for being part of our story — it means a lot. Looking forward to staying in touch in the new year.\n\nMarco`,
  },
};

function getCurrentQuarter(): number {
  return Math.ceil((new Date().getMonth() + 1) / 3);
}

export async function runPastClientQuarterlyTouch(): Promise<{ sent: number }> {
  const leads = await listAllLeads();
  const pastClients = leads.filter((l: Lead) => l.isPastClient && l.email);

  const quarter = getCurrentQuarter();
  const quarterKey = `${new Date().getFullYear()}-Q${quarter}`;
  const content = QUARTERLY_CONTENT[quarter];
  let sent = 0;

  for (const lead of pastClients) {
    const seq = getSequenceForLead(lead.id, "past_client_quarterly");
    if (seq?.lastQuarterSent === quarterKey) continue;

    const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
    const subject = content.subject(firstName);
    const body = content.body(firstName);

    const emailRecord = logEmail({
      leadId: lead.id,
      subject,
      body,
      emailType: "past_client_quarterly",
      sendStatus: "pending",
    });
    const result = await sendEmail(lead.email!, subject, body);

    if (result.success) markEmailSent(emailRecord.id!, result.messageId);
    else markEmailFailed(emailRecord.id!, result.error || "unknown");

    if (seq) {
      updateDripSequence(seq.id!, { lastQuarterSent: quarterKey });
    } else {
      const newSeq = startDripSequence(lead.id, "past_client_quarterly");
      updateDripSequence(newSeq.id!, { lastQuarterSent: quarterKey });
    }

    sent++;
  }

  console.log("[PastClientQuarterly] Q" + quarter, "— sent", sent);
  return { sent };
}

export function schedulePastClientQuarterly(): void {
  let lastRunQuarter: string | null = null;

  setInterval(() => {
    const now = new Date();
    const centralHour = parseInt(
      now.toLocaleString("en-US", { timeZone: "America/Chicago", hour: "2-digit", hour12: false }),
      10,
    );
    const centralDate = parseInt(
      now.toLocaleString("en-US", { timeZone: "America/Chicago", day: "numeric" }),
      10,
    );
    const centralMonth = parseInt(
      now.toLocaleString("en-US", { timeZone: "America/Chicago", month: "numeric" }),
      10,
    );
    const quarterKey = `${now.getFullYear()}-Q${getCurrentQuarter()}`;

    const isQuarterStart = [1, 4, 7, 10].includes(centralMonth) && centralDate === 1;

    if (isQuarterStart && centralHour === 9 && lastRunQuarter !== quarterKey) {
      lastRunQuarter = quarterKey;
      runPastClientQuarterlyTouch().catch((err) => console.error("[PastClientQuarterly]", err));
    }
  }, 60 * 60 * 1000);

  console.log("[PastClientQuarterly] Scheduled — 1st of each quarter, 9am Central");
}
