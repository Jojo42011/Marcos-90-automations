import { listAllLeads, updateLeadCrmFields } from "../../core/db.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";
import { logSmsMessage, getLastInboundMessage } from "../../core/smsStore.js";
import { checkTextingAllowed } from "../../core/textingRules.js";
import type { Lead, MojoOutreach } from "../../core/types.js";

const MOJO_TEXT_1 = (firstName: string) =>
  `Hey ${firstName}, this is Marco with [Brokerage] — saw you were looking into the San Antonio market a while back. ` +
  `Quick heads up: rates dipped again this week and inventory is opening up west of Stone Oak — some solid new construction options under $650k. ` +
  `No pressure, just thought you'd want to know. Let me know if you'd like me to send a few options over!`;

const MOJO_TEXT_2 = (firstName: string) =>
  `Hey ${firstName}, following up in case you missed my last text — happy to send over a few property options ` +
  `if you're still exploring, or no worries at all if the timing's not right. Just let me know either way!`;

const TWO_TEXT_GAP_MS = 4 * 24 * 60 * 60 * 1000;
const PAUSE_AFTER_TEXT_2_MS = 48 * 60 * 60 * 1000;

export function isMojoLead(lead: Lead): boolean {
  return lead.source?.trim().toLowerCase() === "mojo";
}

export async function runMojoOutreachSequence(): Promise<{ sent: number; checked: number }> {
  const leads = await listAllLeads();
  let sent = 0;
  let checked = 0;
  const now = Date.now();

  for (const lead of leads) {
    if (!isMojoLead(lead)) continue;
    if (!lead.phone?.trim()) continue;

    checked++;

    let outreach = lead.mojoOutreach;
    if (!outreach) {
      outreach = { sequenceStarted: false, textsSent: 0, status: "active" };
      await updateLeadCrmFields({ leadId: lead.id, mojoOutreach: outreach });
    }

    if (outreach.status === "replied" || outreach.status === "completed") continue;
    if (
      outreach.status === "paused" &&
      outreach.pausedUntil &&
      now < new Date(outreach.pausedUntil).getTime()
    ) {
      continue;
    }

    const lastInbound = getLastInboundMessage(lead.id);
    if (
      lastInbound &&
      outreach.lastTextSentAt &&
      new Date(lastInbound.sentAt) > new Date(outreach.lastTextSentAt)
    ) {
      await updateLeadCrmFields({
        leadId: lead.id,
        mojoOutreach: { ...outreach, status: "replied" },
      });
      continue;
    }

    const firstName = lead.name?.trim().split(/\s+/)[0] || "there";

    if (outreach.textsSent === 0) {
      const success = await sendMojoText(lead, MOJO_TEXT_1(firstName), outreach);
      if (success) sent++;
    } else if (outreach.textsSent === 1) {
      const timeSinceText1 = now - new Date(outreach.lastTextSentAt!).getTime();
      if (timeSinceText1 >= TWO_TEXT_GAP_MS) {
        const success = await sendMojoText(lead, MOJO_TEXT_2(firstName), outreach);
        if (success) sent++;
      }
    } else if (outreach.textsSent >= 2) {
      if (outreach.status !== "paused") {
        await updateLeadCrmFields({
          leadId: lead.id,
          mojoOutreach: {
            ...outreach,
            status: "paused",
            pausedUntil: new Date(now + PAUSE_AFTER_TEXT_2_MS).toISOString(),
          },
        });
      } else if (outreach.pausedUntil && now >= new Date(outreach.pausedUntil).getTime()) {
        await updateLeadCrmFields({
          leadId: lead.id,
          mojoOutreach: { ...outreach, status: "completed" },
        });
        console.log("[MojoOutreach] Sequence completed (no reply) for", lead.id);
      }
    }
  }

  console.log("[MojoOutreach] Checked", checked, "Mojo leads, sent", sent, "texts");
  return { sent, checked };
}

async function sendMojoText(
  lead: Lead,
  message: string,
  outreach: MojoOutreach,
): Promise<boolean> {
  const gate = checkTextingAllowed(lead.id);
  if (!gate.allowed) {
    console.log("[TextingRules] Blocked Mojo outreach to", lead.id, "-", gate.reason);
    return false;
  }

  try {
    const send = await sendTwilioMessage({ to: lead.phone!, content: message });
    if (!send.success) {
      console.error("[MojoOutreach] Twilio failed for", lead.id, ":", send.error);
      return false;
    }

    const lastTextSentAt = new Date().toISOString();
    await updateLeadCrmFields({
      leadId: lead.id,
      mojoOutreach: {
        ...outreach,
        sequenceStarted: true,
        textsSent: outreach.textsSent + 1,
        lastTextSentAt,
      },
    });

    logSmsMessage({
      leadId: lead.id,
      messageBody: message,
      direction: "outbound",
      sentAt: lastTextSentAt,
      threadType: "mojo_outreach",
      messageHandle: send.messageSid,
    });

    console.log("[MojoOutreach] Sent text", outreach.textsSent + 1, "to", lead.id);
    return true;
  } catch (err) {
    console.error("[MojoOutreach] Failed for", lead.id, ":", err);
    return false;
  }
}

export function scheduleMojoOutreach(): void {
  setInterval(() => {
    runMojoOutreachSequence().catch((err) => console.error("[MojoOutreach]", err));
  }, 60 * 60 * 1000);

  console.log("[MojoOutreach] Scheduled — checking hourly");
}

export async function getMojoOutreachStatus(): Promise<{
  totalMojoLeads: number;
  statusCounts: Record<string, number>;
}> {
  const leads = (await listAllLeads()).filter((l) => isMojoLead(l) && l.mojoOutreach);
  const statusCounts: Record<string, number> = {};
  for (const l of leads) {
    const s = l.mojoOutreach!.status;
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  return { totalMojoLeads: leads.length, statusCounts };
}
