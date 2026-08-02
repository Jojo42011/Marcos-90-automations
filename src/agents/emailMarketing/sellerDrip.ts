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
import { isMlsFeedConfigured } from "../../integrations/simplyrets/index.js";
import {
  liveListingForLead,
  marketForLead,
  marketSentence,
  money,
  specLine,
} from "../../core/listingMatch.js";
import type { MarketStats } from "../../core/listingsStore.js";
import type { Lead } from "../../core/types.js";

/**
 * WHAT THIS DRIP CAN AND CANNOT SAY.
 *
 * The SABOR feed Marco is entitled to returns Active and Pending listings. It
 * does NOT carry sold prices. So this drip talks about what a seller is
 * COMPETING WITH — how many homes are on the market in their city, what those
 * homes are asking, how many are already under contract — and never about what
 * anything sold for. A seller who prices against a "sold" figure that was
 * really someone's asking price sits on the market for months.
 *
 * The CMA Marco produces by hand does use sold comps; he pulls those from his
 * agent MLS access. The email says he will pull them, which is true, rather
 * than pretending this feed already did.
 */

const SELLER_DRIP_DAYS = [0, 2, 5, 9, 14];

interface DripStep {
  subject: (firstName: string, lead: Lead) => string;
  body: (firstName: string, lead: Lead) => string;
}

/** Market context for this seller's city, or null when we cannot name one. */
function market(lead: Lead): MarketStats | null {
  if (!isMlsFeedConfigured()) return null;
  try {
    return marketForLead(lead);
  } catch (err) {
    /* A drip must never fail to send because a lookup broke. */
    console.error("[SellerDrip] market lookup failed:", err);
    return null;
  }
}

/**
 * The seller's own home as it reads in the MLS today.
 *
 * Only present once their property is actually listed and we matched it with
 * certainty. Live rather than cached, so a price change or a move to Pending
 * shows up instead of whatever was true the day they were added.
 */
function theirHome(lead: Lead): string | null {
  if (!isMlsFeedConfigured()) return null;
  try {
    const { listing } = liveListingForLead(lead);
    if (!listing) return null;
    const where = [listing.street, listing.city].filter(Boolean).join(", ");
    const spec = specLine(listing);
    const status = listing.status ? ` — currently ${listing.status}` : "";
    return `${where} at ${money(listing.listPrice)}${spec ? ` (${spec})` : ""}${status}`;
  } catch {
    return null;
  }
}

const SELLER_DRIP_STEPS: DripStep[] = [
  {
    subject: (n) => `Welcome, ${n} — let's get your home sold`,
    body: (n, lead) => {
      const line = marketSentence(market(lead));
      const context = line ? `\n\nFor context on where things stand: ${line}` : "";
      return `Hi ${n},\n\nThanks for reaching out about selling! Over the next couple weeks I'll send a few things that'll help as we get your home ready to list. Let me know if you'd like to set up a time to talk pricing and strategy sooner.${context}\n\nMarco`;
    },
  },
  {
    subject: () => `What buyers notice first`,
    body: (n) =>
      `Hi ${n},\n\nA few small things make a big difference in how buyers perceive a home in the first 10 seconds. Happy to do a quick walkthrough and point out anything worth addressing before we list.\n\nMarco`,
  },
  {
    /* Was a promise of "real numbers, not guesses" containing no numbers. Now
       it carries the inventory a seller is genuinely competing against, and
       labels every figure as an asking price, because that is what it is. */
    subject: () => `How we'll price your home to sell`,
    body: (n, lead) => {
      const m = market(lead);
      if (!m) {
        return `Hi ${n},\n\nPricing strategy can make or break how fast a home sells and for how much. I'll pull together a comparative market analysis so we go in with real numbers, not guesses.\n\nMarco`;
      }
      const lines = [
        `Hi ${n},`,
        "",
        `Pricing comes down to what a buyer sees next to your home. Here is what they are looking at in ${m.city} today:`,
        "",
        `• ${m.active.toLocaleString("en-US")} homes actively for sale`,
      ];
      if (m.medianActivePrice) lines.push(`• Median asking price: ${money(m.medianActivePrice)}`);
      if (m.medianSqft) {
        lines.push(`• Typical size on the market: ${Math.round(m.medianSqft).toLocaleString("en-US")} sqft`);
      }
      if (m.newLast30) lines.push(`• ${m.newLast30.toLocaleString("en-US")} of those came on in the last 30 days`);
      if (m.pending) lines.push(`• ${m.pending.toLocaleString("en-US")} homes are already under contract`);
      lines.push(
        "",
        /* The distinction that keeps this email honest. */
        "Those are asking prices, not sale prices. I'll pull the actual solds and put together a full comparative market analysis for your street — that's the number we price against.",
        "",
        "Marco",
      );
      return lines.join("\n");
    },
  },
  {
    subject: () => `What happens once we list`,
    body: (n, lead) => {
      const m = market(lead);
      /* Pending against active is the one real absorption signal this feed
         supports. Skipped entirely when there is nothing under contract. */
      const pace =
        m && m.pending && m.active
          ? `\n\nRight now ${m.pending.toLocaleString("en-US")} homes in ${m.city} are under contract against ${m.active.toLocaleString("en-US")} still available, which is a decent read on how quickly buyers are moving.`
          : "";
      return `Hi ${n},\n\nOnce we're live, here's what the next few weeks typically look like — showings, feedback, and how we'll adjust if needed. Want to set a target list date?${pace}\n\nMarco`;
    },
  },
  {
    subject: () => `Ready when you are`,
    body: (n, lead) => {
      const home = theirHome(lead);
      const status = home ? `\n\nYour listing as it reads today: ${home}` : "";
      return `Hi ${n},\n\nJust checking in — happy to answer any questions or get things moving whenever you're ready. No pressure, just here when you need me.${status}\n\nMarco`;
    },
  },
];

/**
 * Exported so the copy can be exercised directly against the listings mirror.
 * There is no test runner in this repo, so the alternative is asserting on a
 * regex over the source, which does not catch an email that renders "$NaN".
 */
export const __testSellerSteps = SELLER_DRIP_STEPS;

export function startSellerDrip(leadId: string): void {
  startDripSequence(leadId, "seller_drip", new Date().toISOString());
  console.log("[SellerDrip] Started for lead", leadId);
}

export async function processDueSellerDrips(): Promise<{ sent: number }> {
  const due = getActiveSequencesDueNow("seller_drip");
  let sent = 0;

  for (const seq of due) {
    const lead = await findLeadById(seq.leadId);
    if (!lead || !lead.email) {
      updateDripSequence(seq.id!, { status: "stopped" });
      continue;
    }

    const step = seq.currentStep;
    if (step >= SELLER_DRIP_STEPS.length) {
      updateDripSequence(seq.id!, { status: "completed" });
      continue;
    }

    const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
    const stepDef = SELLER_DRIP_STEPS[step];
    const subject = stepDef.subject(firstName, lead);
    const body = stepDef.body(firstName, lead);

    const emailRecord = logEmail({
      leadId: lead.id,
      subject,
      body,
      emailType: "seller_drip",
      sequenceStep: step,
      sendStatus: "pending",
    });
    const result = await sendEmail(lead.email, subject, body);

    if (result.success) markEmailSent(emailRecord.id!, result.messageId);
    else markEmailFailed(emailRecord.id!, result.error || "unknown");
    sent++;

    const nextStep = step + 1;
    if (nextStep >= SELLER_DRIP_STEPS.length) {
      updateDripSequence(seq.id!, { currentStep: nextStep, status: "completed" });
    } else {
      const daysUntilNext = SELLER_DRIP_DAYS[nextStep] - SELLER_DRIP_DAYS[step];
      const nextSendDate = new Date(Date.now() + daysUntilNext * 24 * 60 * 60 * 1000).toISOString();
      updateDripSequence(seq.id!, { currentStep: nextStep, nextSendDate });
    }
  }

  console.log("[SellerDrip] Processed", sent, "due emails");
  return { sent };
}

export function scheduleSellerDripProcessor(): void {
  setInterval(() => {
    processDueSellerDrips().catch((err) => console.error("[SellerDrip]", err));
  }, 60 * 60 * 1000);
  console.log("[SellerDrip] Scheduled — checking hourly");
}
