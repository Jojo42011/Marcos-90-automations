import { updateLeadCrmFields } from "../../core/db.js";
import { sendTwilioMessage } from "../../integrations/twilio/index.js";
import { logSmsMessage } from "../../core/smsStore.js";
import { isMojoLead } from "../mojoOutreach/index.js";
import type { Lead } from "../../core/types.js";

const MARCO_NUMBER = process.env.MARCO_PHONE_NUMBER?.trim();

function normalizeSource(source: string | null | undefined): string {
  return (source ?? "").trim().toLowerCase();
}

/**
 * Routes a newly-created or newly-phone-captured lead based on its source.
 */
export async function routeNewLead(lead: Lead): Promise<void> {
  const source = normalizeSource(lead.source);

  switch (source) {
    case "mojo":
      await routeMojoLead(lead);
      break;
    case "instagram":
    case "tiktok":
      await routeSocialDmLead(lead);
      break;
    case "web_form":
      await routeWebFormLead(lead);
      break;
    case "referral":
      await routeReferralLead(lead);
      break;
    default:
      console.log("[SourceRouting] No specific routing for source:", lead.source, "- lead", lead.id);
  }
}

async function routeMojoLead(lead: Lead): Promise<void> {
  if (!lead.phone?.trim()) return;

  if (isMojoLead(lead) && lead.mojoOutreach?.textsSent && lead.mojoOutreach.textsSent > 0) {
    console.log("[SourceRouting] Mojo lead", lead.id, "— outreach sequence already active, skipping instant text");
    return;
  }

  const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
  const message = `Hi ${firstName}, this is Marco — thanks for your interest! I'll have some info for you shortly. Feel free to reply with any questions in the meantime.`;

  const result = await sendTwilioMessage(lead.phone, message);
  if (result.success) {
    logSmsMessage({
      leadId: lead.id,
      messageBody: message,
      direction: "outbound",
      sentAt: new Date().toISOString(),
      threadType: "source_routing",
    });
    console.log("[SourceRouting] Mojo lead", lead.id, "instant-texted");
  }

  console.log(
    "[SourceRouting] Mojo lead",
    lead.id,
    "— email portion NOT sent (email agent gap, see Background Q6)",
  );
}

async function routeSocialDmLead(lead: Lead): Promise<void> {
  console.log(
    "[SourceRouting] Social DM lead",
    lead.id,
    "— routes through existing pipeline (no new action needed)",
  );
}

async function routeWebFormLead(lead: Lead): Promise<void> {
  if (!lead.phone?.trim()) return;

  console.log(
    "[SourceRouting] Web form lead",
    lead.id,
    "— no web form intake exists yet; 2-min auto-response scheduled when intake is built",
  );

  setTimeout(async () => {
    const refreshed = await import("../../core/db.js").then((m) => m.getLeadById(lead.id));
    if (!refreshed?.phone?.trim()) return;

    const firstName = refreshed.name?.trim().split(/\s+/)[0] || "there";
    const message = `Hi ${firstName}, thanks for reaching out through our website! This is Marco's team — happy to help with anything you need. What can I help you with?`;

    const result = await sendTwilioMessage(refreshed.phone, message);
    if (result.success) {
      logSmsMessage({
        leadId: refreshed.id,
        messageBody: message,
        direction: "outbound",
        sentAt: new Date().toISOString(),
        threadType: "source_routing",
      });
      console.log("[SourceRouting] Web form lead", refreshed.id, "auto-responded after 2min");
    }
  }, 2 * 60 * 1000);
}

async function routeReferralLead(lead: Lead): Promise<void> {
  await updateLeadCrmFields({
    leadId: lead.id,
    crmPriority: "high",
  });

  if (MARCO_NUMBER) {
    const message = `⭐ REFERRAL LEAD: ${lead.name || lead.username || "New lead"} (${lead.phone || "no phone"}). Flagged high priority — personal call recommended.`;
    await sendTwilioMessage(MARCO_NUMBER, message);
    console.log("[SourceRouting] Referral lead", lead.id, "— Marco notified, flagged high priority");
  }
}
