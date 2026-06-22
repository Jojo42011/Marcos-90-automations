import { randomUUID } from "crypto";

import { appendLeadActivity, getLeadById, updateLeadCrmFields } from "../../core/db.js";
import { createNotification, getCrmAutomationDb } from "../../core/crmNotificationStore.js";
import { logSmsMessage } from "../../core/smsStore.js";
import { checkTextingAllowed } from "../../core/textingRules.js";
import type { Lead, ListingStatus } from "../../core/types.js";
import { sendEmail } from "../../integrations/email/index.js";
import { normalizeToE164, sendTwilioMessage } from "../../integrations/twilio/index.js";

export type ListingStatusValue = "active" | "pending" | "off_market" | "expired" | "sold";

function listingStatusForLead(status: ListingStatusValue): ListingStatus | null {
  if (status === "active") return "active";
  if (status === "off_market" || status === "expired") return "off_market";
  return null;
}

/**
 * Listing status intake — manual entry today; future MLS feed calls this same handler.
 * Fires only on status TRANSITIONS (not repeated polls of the same status).
 */
export async function handleListingStatusUpdate(
  leadId: string,
  address: string,
  newStatus: ListingStatusValue,
  source: "manual" | "mls_feed" = "manual",
): Promise<{ triggered: boolean; action?: string }> {
  const lead = await getLeadById(leadId);
  if (!lead) return { triggered: false, action: "lead_not_found" };

  const db = getCrmAutomationDb();
  const previous = db
    .prepare(`SELECT * FROM listing_status_events WHERE lead_id = ? ORDER BY detected_at DESC LIMIT 1`)
    .get(leadId) as { status?: string } | undefined;

  const previousStatus = previous?.status as ListingStatusValue | undefined;

  if (previousStatus === newStatus) {
    return { triggered: false, action: "no_change" };
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO listing_status_events (id, lead_id, address, status, source, previous_status, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, leadId, address, newStatus, source, previousStatus ?? null, now);

  const mappedListing = listingStatusForLead(newStatus);
  if (mappedListing) {
    const patch: Parameters<typeof updateLeadCrmFields>[0] = {
      leadId,
      listingStatus: mappedListing,
    };
    if (!lead.propertyInquired?.trim() && address.trim()) {
      patch.propertyInquired = address.trim();
    }
    await updateLeadCrmFields(patch);
  }

  if (
    (newStatus === "off_market" || newStatus === "expired") &&
    previousStatus !== "off_market" &&
    previousStatus !== "expired"
  ) {
    await runOffMarketOutreach(lead, address, id);
    return { triggered: true, action: "off_market_outreach" };
  }

  if (newStatus === "active" && previousStatus !== "active") {
    await runActiveNotification(lead, address, id);
    return { triggered: true, action: "active_notification" };
  }

  return { triggered: false, action: "no_action_for_status" };
}

async function runOffMarketOutreach(lead: Lead, address: string, eventId: string): Promise<void> {
  const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
  const stamp = new Date().toISOString();

  if (lead.phone) {
    const gate = checkTextingAllowed(lead.id);
    if (gate.allowed) {
      const smsBody = `Hi ${firstName}, noticed your home at ${address} recently came off the market. If you're still thinking about selling, I'd love the opportunity to talk through a fresh strategy — would you be open to interviewing a qualified realtor in your area?`;
      const send = await sendTwilioMessage(lead.phone, smsBody);
      if (send.success) {
        logSmsMessage({
          leadId: lead.id,
          messageBody: smsBody,
          direction: "outbound",
          sentAt: stamp,
          threadType: "listing_off_market",
          messageHandle: send.messageSid,
        });
      }
    } else {
      console.log("[ListingStatus] Texting gate blocked off-market SMS for", lead.id, "-", gate.reason);
    }
  }

  if (lead.email) {
    const subject = `Still thinking about selling ${address}?`;
    const body = `Hi ${firstName},\n\nI noticed ${address} recently came off the market. If selling is still something you're considering, I'd welcome the chance to share a fresh approach — would you be open to interviewing a qualified realtor in your area?\n\nNo pressure either way, just wanted to reach out.\n\nMarco`;
    await sendEmail(lead.email, subject, body);
  }

  const message = `${lead.name || lead.username || "A seller lead"}'s home at ${address} went off-market — outreach sent asking if they're open to interviewing a realtor.`;
  createNotification({ leadId: lead.id, notificationType: "listing_off_market", message });

  await appendLeadActivity(
    lead.id,
    [{ type: "listing_off_market", description: message, timestamp: stamp }],
    { lastActivity: stamp },
  );

  getCrmAutomationDb()
    .prepare(`UPDATE listing_status_events SET off_market_outreach_sent_at = ? WHERE id = ?`)
    .run(stamp, eventId);

  console.log("[ListingStatus] Off-market outreach sent for", lead.id, "-", address);
}

async function runActiveNotification(lead: Lead, address: string, eventId: string): Promise<void> {
  const message = `${lead.name || lead.username || "A seller lead"}'s home at ${address} just went active on the market.`;
  const stamp = new Date().toISOString();

  createNotification({ leadId: lead.id, notificationType: "listing_active", message });

  await appendLeadActivity(
    lead.id,
    [{ type: "listing_active", description: message, timestamp: stamp }],
    { lastActivity: stamp },
  );

  const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
  if (marcoNumber) {
    await sendTwilioMessage(normalizeToE164(marcoNumber), `🏡 ${message}`);
  }

  getCrmAutomationDb()
    .prepare(`UPDATE listing_status_events SET active_notification_sent_at = ? WHERE id = ?`)
    .run(stamp, eventId);

  console.log("[ListingStatus] Active notification sent for", lead.id, "-", address);
}
