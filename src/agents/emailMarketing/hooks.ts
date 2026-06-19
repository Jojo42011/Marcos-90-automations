import { startBuyerDrip } from "./buyerDrip.js";
import { startSellerDrip } from "./sellerDrip.js";
import { scheduleAutoReply } from "./autoReply.js";
import type { Lead } from "../../core/types.js";

/** Fire email marketing automations when a lead gains an email address. */
export function onLeadEmailCaptured(lead: Lead): void {
  if (!lead.email?.trim()) return;

  scheduleAutoReply(lead);

  if (lead.crmIntent === "seller") {
    startSellerDrip(lead.id);
  } else if (lead.crmIntent === "buyer" || lead.crmIntent === "buyer_seller") {
    startBuyerDrip(lead.id);
  } else {
    console.log("[EmailMarketing] Lead", lead.id, "— crmIntent unknown, drip not auto-started");
  }
}
