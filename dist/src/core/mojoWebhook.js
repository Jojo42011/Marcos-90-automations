"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mojoPhone = mojoPhone;
exports.mapMojoPayload = mapMojoPayload;
exports.mojoPayloadIsUsable = mojoPayloadIsUsable;
exports.mojoSecretConfigured = mojoSecretConfigured;
exports.mojoSecretOk = mojoSecretOk;
exports.mojoLeadPatch = mojoLeadPatch;
/**
 * Inbound Mojo Dialer contacts, delivered by Zapier.
 *
 * WHY A WEBHOOK AND NOT AN API CLIENT — this is the whole finding, so it is
 * written down here rather than left as an assumption for the next person:
 *
 *   Mojo has no public REST API. Its integrations page lists pre-established
 *   partners only (Boomtown, Real Geeks, Follow Up Boss, Mailchimp, Zillow,
 *   Google, Microsoft Exchange) plus the middleware services Zapier and API
 *   Nation. There is no developer documentation, no API key page and no
 *   partner application process published. "Pushing and/or pulling of data to
 *   and from Mojo via API" is described, but only as something those named
 *   partners do.
 *
 *   Zapier's Mojo app — which IS public and enumerable — exposes triggers
 *   (New Contact, New Contact in Group, Contact Updated, New Activity, New
 *   Note, Note Updated, Contact Number Marked as "Bad Number", Send Button
 *   Clicked) and actions that write INTO Mojo (Create Contact in Calling List,
 *   Create Contact in Group, Create Activity, Update Contact).
 *
 *   Critically there is NO bulk read. Nothing can ask Mojo for the current
 *   lead list, which is why this is a push endpoint and not a sync job: the
 *   only way data leaves Mojo automatically is one event at a time, as it
 *   happens. A "pull all Mojo leads" function cannot be written against what
 *   Mojo exposes, and pretending otherwise would be a button that cannot work.
 *
 * WHAT ALREADY WORKS WITHOUT THIS. 552 Mojo contacts are already in the CRM,
 * because they came across in the Brivity migration (source "Mojo" 445 and
 * "Mojo FL" 107). This endpoint is for what happens NEXT — new and updated
 * contacts arriving from the dialer going forward.
 *
 * SIDE EFFECTS ARE DELIBERATELY NOT FIRED HERE. Leads land through the quiet
 * path, so nobody is texted or emailed by the act of syncing. The existing
 * scheduled `mojoOutreach` sequence then treats them exactly as it treats the
 * 445 Mojo leads already on the board — no new behaviour is introduced by this
 * file, which is the point.
 */
const crypto_1 = require("crypto");
function str(v) {
    return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}
/** First non-empty of the aliases Mojo/Zapier might use for one concept. */
function pick(p, keys) {
    for (const k of keys) {
        const v = str(p[k]);
        if (v)
            return v;
    }
    return "";
}
function mojoPhone(raw) {
    let d = str(raw).replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1"))
        d = d.slice(1);
    if (d.length !== 10)
        return null;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
/**
 * Map a Zapier payload onto the CRM's shape.
 *
 * The source is always `"Mojo"` — matching what the 445 existing contacts
 * carry, so these merge into the same sidebar row and the same outreach gate
 * rather than creating a parallel "Mojo (Zapier)" bucket that splits the count.
 * The specific Mojo list becomes a TAG, which is where that detail belongs and
 * keeps it filterable without fragmenting the source.
 */
function mapMojoPayload(p) {
    const first = pick(p, ["first_name"]);
    const last = pick(p, ["last_name"]);
    const name = pick(p, ["full_name", "name"]) || [first, last].filter(Boolean).join(" ").trim();
    const phone = mojoPhone(pick(p, ["phone", "phone_number", "primary_phone", "cell_phone"]));
    const email = pick(p, ["email", "email_address"]).toLowerCase() || null;
    const street = pick(p, ["address", "street"]);
    const address = [street, pick(p, ["city"]), pick(p, ["state"]), pick(p, ["postal_code", "zip"])]
        .filter(Boolean)
        .join(", ") || null;
    const group = pick(p, ["group", "group_name", "list", "list_name"]);
    const tags = [];
    if (group)
        tags.push(`Mojo: ${group}`);
    return {
        externalId: pick(p, ["id", "contact_id"]) || null,
        /* A dialer contact with no name is normal — it is a phone number someone
           is calling. Label it by the number rather than "Unknown", which would
           make every nameless row indistinguishable. */
        name: name || phone || email || "Unnamed Mojo contact",
        phone,
        email,
        address,
        source: "Mojo",
        notes: pick(p, ["notes", "note"]) || null,
        tags,
    };
}
/** Nothing to reach them on means nothing the CRM can do with them. */
function mojoPayloadIsUsable(m) {
    return Boolean(m.phone || m.email);
}
/**
 * Shared-secret check.
 *
 * This endpoint WRITES LEADS, so it cannot be open the way a read-only ping
 * could be. Zapier can attach a static header or query parameter and nothing
 * more — it cannot compute an HMAC over the body — so a shared secret is the
 * strongest thing actually available here, and it is compared in constant time
 * against a hash so the comparison cannot leak length or content by timing.
 */
function mojoSecretConfigured() {
    return Boolean(process.env.MOJO_WEBHOOK_SECRET?.trim());
}
function mojoSecretOk(provided) {
    const expected = process.env.MOJO_WEBHOOK_SECRET?.trim();
    if (!expected)
        return false;
    const a = (0, crypto_1.createHash)("sha256").update(String(provided ?? "")).digest();
    const b = (0, crypto_1.createHash)("sha256").update(expected).digest();
    return (0, crypto_1.timingSafeEqual)(a, b);
}
/** The Lead fields a mapped Mojo contact contributes, for create or merge. */
function mojoLeadPatch(m) {
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
