/**
 * Module 06: Criteria Pivot & Email Extraction — collect criteria and email when property doesn't fit.
 */
import type { Conversation, Lead, Message } from "../../core/types.js";
import { FunnelStage } from "../../core/state.js";

export interface ModuleResult {
  lead: Lead;
  reply: string | null;
}

function getLastUserMessage(conversation: Conversation): Message | null {
  const reversed = [...conversation.messages].reverse();
  return reversed.find((m) => m.role === "user") ?? null;
}

function extractEmail(text: string): string | null {
  const match = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match ? match[0] : null;
}

function extractBeds(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(bed|beds|bd)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractBaths(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(bath|baths|ba)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractArea(text: string): string | null {
  const m =
    text.match(/\b(in|area)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,3})\b/i) ??
    text.match(/\b([A-Za-z]+(?:\s+[A-Za-z]+){0,3})\s+(area)\b/i);
  if (!m) return null;
  return (m[2] ?? m[1] ?? "").trim() || null;
}

function extractPriceCap(text: string): number | null {
  // Very small heuristic: find a big number and interpret as dollars.
  const m = text.match(/\b\$?\s?(\d{3,}(?:,\d{3})*)\s?\b/);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 50000) return null;
  return n;
}

export async function process(lead: Lead, conversation: Conversation): Promise<ModuleResult> {
  const last = getLastUserMessage(conversation);
  if (!last) return { lead, reply: null };

  const email = lead.email ?? extractEmail(last.text);
  const beds = lead.criteria?.beds ?? extractBeds(last.text);
  const baths = lead.criteria?.baths ?? extractBaths(last.text);
  const area = lead.criteria?.area ?? extractArea(last.text);
  const priceCap = lead.criteria?.priceCap ?? extractPriceCap(last.text);

  const criteria = lead.criteria
    ? {
        ...lead.criteria,
        beds: beds ?? lead.criteria.beds,
        baths: baths ?? lead.criteria.baths,
        area: area ?? lead.criteria.area,
        priceCap: priceCap ?? lead.criteria.priceCap,
      }
    : { priceCap: priceCap ?? null, beds: beds ?? null, baths: baths ?? null, area: area ?? null };

  const hasCriteria = Boolean(criteria.area || criteria.priceCap || criteria.beds || criteria.baths);
  const isAffirmative = /\b(yes|that.?s the (one|house)|correct|exactly|perfect|sounds good)\b/i.test(
    last.text,
  );
  const isNegative = /\b(no|not|different|other|outside|wrong|not really|looking elsewhere)\b/i.test(
    last.text,
  );

  let reply: string;

  // If they are saying it's the right fit, we mostly want the email next.
  if (isAffirmative) {
    if (!email) {
      reply = "For sure, what’s the best email I can send everything over to?";
      return { lead: { ...lead, email: null, criteria, state: FunnelStage.CriteriaCollected }, reply };
    }
    reply =
      "Of course, I’ll send the details over to that email next. Was there anything specific about beds/baths you’re looking for?";
    return { lead: { ...lead, email, criteria, state: FunnelStage.EmailSent }, reply };
  }

  // If they say it's not the right fit (or they ask for something else), use pivot + collect criteria + email.
  if (isNegative || !isAffirmative) {
    if (!email || !hasCriteria) {
      reply =
        "No worries — would it help if I sent over similar options in your price range? " +
        "What price cap are you targeting, and what’s the best email to send them to?";
    } else {
      reply =
        "Makes sense — I’ll send similar options based on that. What’s the best email to send everything to?";
    }
    return {
      lead: {
        ...lead,
        email: email ?? lead.email,
        criteria,
        state: email ? FunnelStage.EmailSent : FunnelStage.CriteriaCollected,
      },
      reply,
    };
  }

  return { lead, reply: null };
}

