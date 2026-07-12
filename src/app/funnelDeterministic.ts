/**
 * Deterministic funnel transitions and field extraction (phone, email, criteria regex).
 * Reply text is generated separately by Claude in the pipeline.
 */
import type { Conversation, Lead, Message } from "../core/types.js";
import { FunnelStage } from "../core/state.js";

export interface FunnelDeterministicMeta {
  phoneJustCaptured?: boolean;
  /** Advanced to Closed this turn (module 07 equivalent — personalized list email next). */
  listSendPromised?: boolean;
}

function getLastUserMessage(conversation: Conversation): Message | null {
  const reversed = [...conversation.messages].reverse();
  return reversed.find((m) => m.role === "user") ?? null;
}

export function extractPhone(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
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
  const m = text.match(/\b\$?\s?(\d{3,}(?:,\d{3})*)\s?\b/);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 50000) return null;
  return n;
}

/** Bucket I: short structured CRM notes so Carlos knows what was stated without re-reading the thread. */
export function appendCrmNotes(lead: Lead, notes: string[]): Lead {
  if (notes.length === 0) return lead;
  const existing = lead.crmNotes ?? [];
  const merged = [...existing];
  for (const note of notes) {
    if (!merged.includes(note)) merged.push(note);
  }
  return merged.length === existing.length ? lead : { ...lead, crmNotes: merged };
}

/** Freeform stated-preference notes not already covered by structured criteria fields. */
export function deriveFreeTextCrmNotes(text: string): string[] {
  const notes: string[] = [];
  const t = text.toLowerCase();
  if (/\b(layout|floor plan|floorplan)\b/.test(t)) {
    notes.push("Lead requested: layout/floor plan");
  }
  if (/\bacreage\b/.test(t)) {
    notes.push("Lead wants: acreage");
  }
  return notes;
}

/** Notes for newly-extracted structured criteria (beds/baths/area/price) this turn only. */
function criteriaChangeNotes(before: Lead["criteria"], after: Lead["criteria"]): string[] {
  const notes: string[] = [];
  if (!after) return notes;
  const bedsNew = after.beds !== null && before?.beds !== after.beds;
  const bathsNew = after.baths !== null && before?.baths !== after.baths;
  if (bedsNew || bathsNew) {
    notes.push(`Lead wants: ${after.beds ?? "?"}bd/${after.baths ?? "?"}ba`);
  }
  if (after.area !== null && before?.area !== after.area) {
    notes.push(`Lead wants: ${after.area} area`);
  }
  if (after.priceCap !== null && before?.priceCap !== after.priceCap) {
    notes.push(`Lead wants: budget around $${after.priceCap.toLocaleString()}`);
  }
  return notes;
}

/** Module 06 state + criteria/email extraction only (no reply strings). */
function applyModule06Deterministic(lead: Lead, lastText: string): Lead {
  const email = lead.email ?? extractEmail(lastText);
  const beds = lead.criteria?.beds ?? extractBeds(lastText);
  const baths = lead.criteria?.baths ?? extractBaths(lastText);
  const area = lead.criteria?.area ?? extractArea(lastText);
  const priceCap = lead.criteria?.priceCap ?? extractPriceCap(lastText);

  const criteria = lead.criteria
    ? {
        ...lead.criteria,
        beds: beds ?? lead.criteria.beds,
        baths: baths ?? lead.criteria.baths,
        area: area ?? lead.criteria.area,
        priceCap: priceCap ?? lead.criteria.priceCap,
      }
    : {
        priceCap: priceCap ?? null,
        beds: beds ?? null,
        baths: baths ?? null,
        area: area ?? null,
      };

  const crmNotes = [...criteriaChangeNotes(lead.criteria, criteria), ...deriveFreeTextCrmNotes(lastText)];
  lead = appendCrmNotes(lead, crmNotes);

  const isAffirmative = /\b(yes|that.?s the (one|house)|correct|exactly|perfect|sounds good)\b/i.test(
    lastText,
  );

  if (isAffirmative) {
    if (!email) {
      return { ...lead, email: null, criteria, state: FunnelStage.CriteriaCollected };
    }
    return { ...lead, email, criteria, state: FunnelStage.EmailSent };
  }

  return {
    ...lead,
    email: email ?? lead.email,
    criteria,
    state: email ? FunnelStage.EmailSent : FunnelStage.CriteriaCollected,
  };
}

function chainEmailSentToClosed(lead: Lead, meta: FunnelDeterministicMeta): Lead {
  if (lead.state === FunnelStage.EmailSent && lead.email) {
    meta.listSendPromised = true;
    return { ...lead, state: FunnelStage.Closed };
  }
  return lead;
}

/**
 * Apply regex extractions and stage transitions for one inbound turn (after user message is appended).
 */
export function advanceFunnelDeterministic(
  lead: Lead,
  conversation: Conversation,
): { lead: Lead; meta: FunnelDeterministicMeta } {
  const meta: FunnelDeterministicMeta = {};
  let l = lead;

  if (l.state === FunnelStage.PhoneRequested) {
    const last = getLastUserMessage(conversation);
    if (!last) return { lead: l, meta };
    const phone = extractPhone(last.text);
    if (phone) {
      l = { ...l, phone, state: FunnelStage.PropertySent };
      meta.phoneJustCaptured = true;
    }
    return { lead: l, meta };
  }

  if (l.state === FunnelStage.PropertySent || l.state === FunnelStage.CriteriaCollected) {
    const last = getLastUserMessage(conversation);
    if (!last) return { lead: l, meta };
    l = applyModule06Deterministic(l, last.text);
    l = chainEmailSentToClosed(l, meta);
    return { lead: l, meta };
  }

  if (l.state === FunnelStage.EmailSent) {
    l = chainEmailSentToClosed(l, meta);
    return { lead: l, meta };
  }

  return { lead: l, meta };
}

