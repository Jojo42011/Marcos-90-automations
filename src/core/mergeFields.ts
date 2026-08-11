/**
 * Merge fields for Auto Plan email/text steps — Brivity's "Insert Placeholder".
 *
 * One plan step is written once and sent to hundreds of contacts, so the body
 * carries `{{recipient_first_name}}` rather than a hardcoded name and each
 * send resolves it against that contact's record.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a placeholder that cannot be
 * resolved must never go out as literal text. A client receiving
 * "Hi {{recipient_first_name}}, about your home at {{recipient_address}}"
 * is worse than the message not sending at all — it is visibly automated and
 * it is the kind of thing that gets a number flagged. So `applyMergeFields`
 * reports what it could not fill, and the caller decides; nothing here
 * silently ships a half-filled message.
 *
 * Two tiers, because the right answer differs by field:
 *   - SOFT fields have a natural, human fallback. A missing first name
 *     becomes "there" ("Hi there,") which reads like something a person
 *     would actually write.
 *   - HARD fields do not. There is no sensible stand-in for an address or a
 *     phone number, so a missing one blocks the send and names itself.
 */
import type { Lead } from "./types.js";

export interface MergeFieldDef {
  /** Token written in the body, without braces. */
  key: string;
  /** Shown in the Insert Placeholder menu. */
  label: string;
  /** Used when the record has no value; absent = blocks the send. */
  fallback?: string;
}

/** Everything the Insert Placeholder menu offers, in menu order. */
export const MERGE_FIELDS: MergeFieldDef[] = [
  { key: "recipient_first_name", label: "Recipient first name", fallback: "there" },
  { key: "recipient_last_name", label: "Recipient last name" },
  { key: "recipient_full_name", label: "Recipient full name", fallback: "there" },
  { key: "recipient_email", label: "Recipient email" },
  { key: "recipient_phone", label: "Recipient phone" },
  { key: "recipient_address", label: "Recipient address" },
  { key: "recipient_city", label: "Recipient city" },
  { key: "property_address", label: "Property they asked about" },
  { key: "agent_name", label: "Agent name", fallback: "Marco Puga" },
  { key: "agent_phone", label: "Agent phone" },
];

const BY_KEY = new Map(MERGE_FIELDS.map((f) => [f.key, f]));

function firstNameOf(lead: Lead): string {
  const full = (lead.name || "").trim();
  if (full) return full.split(/\s+/)[0];
  return "";
}

function lastNameOf(lead: Lead): string {
  const parts = (lead.name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

/** Raw value for a field, or "" when the record does not have it. */
function rawValue(key: string, lead: Lead, agent: { name?: string; phone?: string }): string {
  switch (key) {
    case "recipient_first_name":
      return firstNameOf(lead);
    case "recipient_last_name":
      return lastNameOf(lead);
    case "recipient_full_name":
      return (lead.name || "").trim();
    case "recipient_email":
      return (lead.email || "").trim();
    case "recipient_phone":
      return (lead.phone || "").trim();
    case "recipient_address":
      return (lead.address || "").trim();
    case "recipient_city":
      return (lead.criteria?.area || "").trim();
    case "property_address":
      return (lead.propertyInquired || "").trim();
    case "agent_name":
      return (agent.name || "").trim();
    case "agent_phone":
      return (agent.phone || "").trim();
    default:
      return "";
  }
}

export interface MergeResult {
  text: string;
  /** Field keys with no value AND no safe fallback — the send must not go out. */
  missing: string[];
  /** Tokens in the text that are not merge fields at all (typo / made-up). */
  unknown: string[];
  /** Field keys that fell back rather than using real data. */
  usedFallback: string[];
}

const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/**
 * Resolve `{{tokens}}` against a lead. Also handles the legacy `[name]`
 * placeholder every seeded plan still uses, so old plans keep working.
 *
 * A blocked send is signalled through `missing` — this function does not
 * throw and does not guess.
 */
export function applyMergeFields(
  body: string,
  lead: Lead,
  agent: { name?: string; phone?: string } = {},
): MergeResult {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const usedFallback = new Set<string>();

  // Legacy token from the seeded plans: same semantics as first name.
  const legacyFirst = firstNameOf(lead) || "there";
  let text = String(body || "").replace(/\[name\]/g, legacyFirst);

  text = text.replace(TOKEN, (whole, rawKey: string) => {
    const key = String(rawKey).toLowerCase();
    const def = BY_KEY.get(key);
    if (!def) {
      unknown.add(key);
      return whole; // leave it visible: the caller blocks on it
    }
    const value = rawValue(key, lead, agent);
    if (value) return value;
    if (def.fallback !== undefined) {
      usedFallback.add(key);
      return def.fallback;
    }
    missing.add(key);
    return whole;
  });

  return {
    text,
    missing: [...missing],
    unknown: [...unknown],
    usedFallback: [...usedFallback],
  };
}

/** True when the message is safe to deliver as-is. */
export function isSendable(result: MergeResult): boolean {
  return result.missing.length === 0 && result.unknown.length === 0;
}

/** Operator-readable reason a send was held back. */
export function describeMergeProblem(result: MergeResult): string {
  const parts: string[] = [];
  if (result.missing.length) {
    parts.push(
      `this contact has no ${result.missing.map((k) => BY_KEY.get(k)?.label ?? k).join(", ").toLowerCase()}`,
    );
  }
  if (result.unknown.length) {
    parts.push(`unknown placeholder${result.unknown.length > 1 ? "s" : ""} ${result.unknown.map((k) => `{{${k}}}`).join(", ")}`);
  }
  return parts.join("; ");
}
