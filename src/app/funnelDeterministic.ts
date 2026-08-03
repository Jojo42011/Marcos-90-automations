/**
 * Deterministic funnel transitions and field extraction (phone, email, criteria regex).
 * Reply text is generated separately by Claude in the pipeline.
 */
import type { Conversation, Lead, Message } from "../core/types.js";
import { FunnelStage } from "../core/state.js";
import { MARCO_PHONE_CAPTURED_REPLY } from "../../config/prompts.js";
import { extractArea, extractPriceCap, isJunkPriceCap, normalizeArea } from "../core/criteriaExtract.js";

export interface FunnelDeterministicMeta {
  phoneJustCaptured?: boolean;
  /** List send promised — personalized list email next. */
  listSendPromised?: boolean;
}

function getLastUserMessage(conversation: Conversation): Message | null {
  const reversed = [...conversation.messages].reverse();
  return reversed.find((m) => m.role === "user") ?? null;
}

/** Shown when we detect a number in-thread the same turn we leave the opening funnel (or override a bad sanitizer). */
export const PHONE_JUST_CAPTURED_REPLY = MARCO_PHONE_CAPTURED_REPLY;

const MAX_USER_MESSAGES_PHONE_SCAN = 12;

/**
 * US-ish mobile: strip non-digits; accept 10 digits, or 11 starting with country code 1.
 * If one bubble contains extra digits (zip + phone, two numbers), prefer the last 10-digit run.
 */
export function extractPhone(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length > 11) {
    const tail = digits.slice(-10);
    if (tail.length === 10) return tail;
  }
  return null;
}

/**
 * Newest user messages first — catches numbers sent one bubble before "ok"/"thanks".
 */
export function extractPhoneFromConversation(
  conversation: Conversation,
  maxUserMessages: number = MAX_USER_MESSAGES_PHONE_SCAN,
): string | null {
  let seen = 0;
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const m = conversation.messages[i];
    if (m.role !== "user") continue;
    seen++;
    const p = extractPhone(m.text);
    if (p) return p;
    if (seen >= maxUserMessages) break;
  }
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

/** True when the lead mentions floor plan / layout preferences (open concept, single story, etc). */
const LAYOUT_PATTERNS = [
  /\bfloor\s?plan\b/i,
  /\blayout\b/i,
  /\bopen concept\b/i,
  /\b(single|two|one) stor(y|ey)\b/i,
  /\bsplit level\b/i,
  /\bmaster (down|downstairs)\b/i,
  /\bgame room\b/i,
  /\b(office\/study|study\/office)\b/i,
];
function mentionsLayout(text: string): boolean {
  return LAYOUT_PATTERNS.some((re) => re.test(text));
}

/** True when the lead mentions acreage / lot size (as opposed to a plain address). */
const ACREAGE_PATTERNS = [
  /\bacres?\b/i, // "an acre", "2 acres", "half acre"
  /\bacreage\b/i,
  /\b(large|big|huge) (yard|lot)\b/i,
  /\blot size\b/i,
];
function mentionsAcreage(text: string): boolean {
  return ACREAGE_PATTERNS.some((re) => re.test(text));
}

/**
 * Deterministic CRM notes derivation for stated preferences (Bucket I — general
 * case). Runs alongside criteria extraction so a note is added the SAME turn a
 * bed/bath/area/price/layout/acreage preference is first mentioned. Deduped
 * against existing notes so nothing repeats across turns; appends with the
 * same "Label: value" line style the out-of-state referral flow already uses
 * for `crmNotes` (see resolveReferralFlow in pipeline.ts).
 */
function deriveCrmNotesFromCriteria(
  existingNotes: string | null,
  lastText: string,
  newBeds: number | null,
  newBaths: number | null,
  newArea: string | null,
  newPriceCap: number | null,
): string | null {
  const lines: string[] = [];
  if (newBeds != null) lines.push(`Wants ${newBeds} bed${newBeds === 1 ? "" : "s"}`);
  if (newBaths != null) lines.push(`Wants ${newBaths} bath${newBaths === 1 ? "" : "s"}`);
  if (newArea) lines.push(`Area preference: ${newArea}`);
  if (newPriceCap != null) lines.push(`Price cap mentioned: $${newPriceCap.toLocaleString()}`);
  if (mentionsLayout(lastText)) lines.push("Mentioned floor plan / layout preference");
  if (mentionsAcreage(lastText)) lines.push("Mentioned acreage / lot size preference");

  if (!lines.length) return existingNotes;

  const existing = existingNotes?.trim() ?? "";
  const existingLower = existing.toLowerCase();
  const fresh = lines.filter((line) => !existingLower.includes(line.toLowerCase()));
  if (!fresh.length) return existingNotes;

  return existing ? `${existing}\n${fresh.join("\n")}` : fresh.join("\n");
}

/** Module 06 state + criteria/email extraction only (no reply strings). */
function applyModule06Deterministic(lead: Lead, lastText: string): Lead {
  const email = lead.email ?? extractEmail(lastText);
  const beds = lead.criteria?.beds ?? extractBeds(lastText);
  const baths = lead.criteria?.baths ?? extractBaths(lastText);
  /* Normalise what is already stored before trusting it: rows written by the
     old rule hold fragments like "San Antonio yes", which match no city at
     all in search. Self-heals a lead the next time they message. */
  const area = normalizeArea(lead.criteria?.area) ?? extractArea(lastText);
  /* Drop a stored cap that cannot be a budget before falling back to it —
     11 of 13 production caps were phone numbers. Self-heals on the next
     message, same as the area. */
  const storedCap = isJunkPriceCap(lead.criteria?.priceCap) ? null : lead.criteria?.priceCap;
  const priceCap = storedCap ?? extractPriceCap(lastText);

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

  const isAffirmative = /\b(yes|that.?s the (one|house)|correct|exactly|perfect|sounds good)\b/i.test(
    lastText,
  );

  // Bucket I (general case) — note stated preferences (beds/baths/area/price/
  // layout/acreage) the same turn they're first mentioned, deduped against
  // whatever crmNotes already holds. Only fires for values newly extracted
  // THIS turn (beds/baths/area/priceCap params below), not values already on
  // file from an earlier turn — matches the "first mentioned" framing.
  const crmNotes = deriveCrmNotesFromCriteria(
    lead.crmNotes,
    lastText,
    lead.criteria?.beds == null ? beds : null,
    lead.criteria?.baths == null ? baths : null,
    lead.criteria?.area == null ? area : null,
    lead.criteria?.priceCap == null ? priceCap : null,
  );

  if (isAffirmative) {
    if (!email) {
      return { ...lead, email: null, criteria, crmNotes, state: FunnelStage.CriteriaCollected };
    }
    return { ...lead, email, criteria, crmNotes, state: FunnelStage.EmailSent };
  }

  return {
    ...lead,
    email: email ?? lead.email,
    criteria,
    crmNotes,
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
    const phone = l.phone ?? extractPhoneFromConversation(conversation);
    if (phone) {
      const justCaptured = !l.phone;
      l = { ...l, phone, state: FunnelStage.PropertySent };
      if (justCaptured) meta.phoneJustCaptured = true;
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

