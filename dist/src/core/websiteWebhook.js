"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.websitePhone = websitePhone;
exports.mapWebsitePayload = mapWebsitePayload;
exports.websitePayloadIsUsable = websitePayloadIsUsable;
exports.websiteSecretConfigured = websiteSecretConfigured;
exports.websiteSecretOk = websiteSecretOk;
exports.websiteLeadPatch = websiteLeadPatch;
/**
 * Inbound website lead form posts.
 *
 * Mirrors the Mojo webhook pattern: a push endpoint that creates or enriches a
 * lead through the quiet path. There is no bulk pull from the public site —
 * the form posts one contact at a time.
 *
 * Closed unless WEBSITE_WEBHOOK_SECRET is set. Compared in constant time against
 * a SHA-256 digest (query `token` or `x-website-secret` header).
 */
const crypto_1 = require("crypto");
function str(v) {
    return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}
function pick(p, keys) {
    for (const k of keys) {
        const v = str(p[k]);
        if (v)
            return v;
    }
    return "";
}
function websitePhone(raw) {
    let d = str(raw).replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1"))
        d = d.slice(1);
    if (d.length !== 10)
        return null;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
/** Source is always `"Website"` so sidebar counts stay one bucket. */
function mapWebsitePayload(p) {
    const first = pick(p, ["first_name"]);
    const last = pick(p, ["last_name"]);
    const name = pick(p, ["full_name", "name"]) || [first, last].filter(Boolean).join(" ").trim();
    const phone = websitePhone(pick(p, ["phone", "phone_number"]));
    const email = pick(p, ["email", "email_address"]).toLowerCase() || null;
    const street = pick(p, ["address", "street"]);
    const address = [street, pick(p, ["city"]), pick(p, ["state"]), pick(p, ["postal_code", "zip"])]
        .filter(Boolean)
        .join(", ") || null;
    return {
        externalId: pick(p, ["id"]) || null,
        name: name || phone || email || "Unnamed Website lead",
        phone,
        email,
        address,
        source: "Website",
        notes: pick(p, ["notes", "note", "message"]) || null,
        tags: ["Website"],
    };
}
function websitePayloadIsUsable(m) {
    return Boolean(m.phone || m.email);
}
function websiteSecretConfigured() {
    return Boolean(process.env.WEBSITE_WEBHOOK_SECRET?.trim());
}
function websiteSecretOk(provided) {
    const expected = process.env.WEBSITE_WEBHOOK_SECRET?.trim();
    if (!expected)
        return false;
    const a = (0, crypto_1.createHash)("sha256").update(String(provided ?? "")).digest();
    const b = (0, crypto_1.createHash)("sha256").update(expected).digest();
    return (0, crypto_1.timingSafeEqual)(a, b);
}
function websiteLeadPatch(m) {
    const patch = {
        name: m.name,
        phone: m.phone,
        email: m.email,
        source: m.source,
    };
    if (m.address)
        patch.address = m.address;
    if (m.notes)
        patch.crmNotes = m.notes;
    if (m.tags.length)
        patch.tags = m.tags;
    return patch;
}
