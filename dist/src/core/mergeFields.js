"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MERGE_FIELDS = void 0;
exports.applyMergeFields = applyMergeFields;
exports.isSendable = isSendable;
exports.describeMergeProblem = describeMergeProblem;
/** Everything the Insert Placeholder menu offers, in menu order. */
exports.MERGE_FIELDS = [
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
const BY_KEY = new Map(exports.MERGE_FIELDS.map((f) => [f.key, f]));
function firstNameOf(lead) {
    const full = (lead.name || "").trim();
    if (full)
        return full.split(/\s+/)[0];
    return "";
}
function lastNameOf(lead) {
    const parts = (lead.name || "").trim().split(/\s+/).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : "";
}
/** Raw value for a field, or "" when the record does not have it. */
function rawValue(key, lead, agent) {
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
const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
/**
 * Resolve `{{tokens}}` against a lead. Also handles the legacy `[name]`
 * placeholder every seeded plan still uses, so old plans keep working.
 *
 * A blocked send is signalled through `missing` — this function does not
 * throw and does not guess.
 */
function applyMergeFields(body, lead, agent = {}) {
    const missing = new Set();
    const unknown = new Set();
    const usedFallback = new Set();
    // Legacy token from the seeded plans: same semantics as first name.
    const legacyFirst = firstNameOf(lead) || "there";
    let text = String(body || "").replace(/\[name\]/g, legacyFirst);
    text = text.replace(TOKEN, (whole, rawKey) => {
        const key = String(rawKey).toLowerCase();
        const def = BY_KEY.get(key);
        if (!def) {
            unknown.add(key);
            return whole; // leave it visible: the caller blocks on it
        }
        const value = rawValue(key, lead, agent);
        if (value)
            return value;
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
function isSendable(result) {
    return result.missing.length === 0 && result.unknown.length === 0;
}
/** Operator-readable reason a send was held back. */
function describeMergeProblem(result) {
    const parts = [];
    if (result.missing.length) {
        parts.push(`this contact has no ${result.missing.map((k) => BY_KEY.get(k)?.label ?? k).join(", ").toLowerCase()}`);
    }
    if (result.unknown.length) {
        parts.push(`unknown placeholder${result.unknown.length > 1 ? "s" : ""} ${result.unknown.map((k) => `{{${k}}}`).join(", ")}`);
    }
    return parts.join("; ");
}
