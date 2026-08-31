"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTENT_TAGS = exports.BRIVITY_INTENT_MAP = exports.STAGE_FALLBACK = exports.BRIVITY_STAGE_MAP = exports.STATUS_FALLBACK = exports.BRIVITY_STATUS_MAP = void 0;
exports.recordKind = recordKind;
exports.norm = norm;
exports.mapVocabulary = mapVocabulary;
exports.BRIVITY_STATUS_MAP = {
    "new": { status: "new" },
    "hot": { status: "hot" },
    "nurture": { status: "nurture" },
    "watch": { status: "watch" },
    "inactive": { status: "unresponsive", note: "Brivity 'inactive' is a contact who stopped responding." },
    "archived": { status: "archived" },
    "trash": { status: "trashed" },
    "unqualified": { status: "dead" },
    /* Clients, not lead temperatures. Kept warm and tagged so the segment is not
       lost — these are the referral and repeat-business list. */
    "past-client": { status: "nurture", addTags: ["Past Client"], note: "Client relationship, preserved as a tag." },
    "active-client": { status: "hot", addTags: ["Active Client"], note: "Under active representation." },
    "prospective-client": { status: "nurture", addTags: ["Prospective Client"] },
    /* Marco's own staff seats inside Brivity. Not contacts at all. */
    "brivity-user": { status: "archived", addTags: ["Brivity Staff Account"], note: "A Brivity seat, not a lead." },
};
/** Used when Brivity sends a status this table does not know. */
exports.STATUS_FALLBACK = "nurture";
/* ---- stage --------------------------------------------------------------- */
/**
 * One-to-one with CRM_LEAD_STAGES. Keys are lowercased and whitespace-collapsed
 * before lookup, so "Attempted Contact", "attempted contact" and
 * "Attempted  contact" all land on the same entry.
 */
exports.BRIVITY_STAGE_MAP = {
    "new lead": "new_lead",
    "attempted contact": "attempted_contact",
    "spoke with customer": "spoke_with_customer",
    "appointment set": "appointment_set",
    "met with customer": "met_with_customer",
    /* Present in Brivity's own stage list even where Marco's export has none
       today, so a contact that moves tomorrow still lands correctly. */
    "showing homes": "showing_homes",
    "listing agreement": "listing_agreement",
    "active listing": "active_listing",
    "submitting offers": "submitting_offers",
    "under contract": "under_contract",
    "sale closed": "sale_closed",
    "nurture": "nurture",
    "rejected": "rejected",
};
exports.STAGE_FALLBACK = "new_lead";
/* ---- intention ----------------------------------------------------------- */
/**
 * `null` means Brivity did not say. That is not the same as "buyer", and the
 * previous mapping's habit of defaulting made 1,353 contacts look like buyers
 * who had never said so. The caller decides what to do with null; it must never
 * be invented here.
 */
exports.BRIVITY_INTENT_MAP = {
    "buyer": "buyer",
    "seller": "seller",
    "seller/buyer": "buyer_seller",
    "buyer/seller": "buyer_seller",
    "n/a": null,
    "tenant": null, // this CRM has no tenant intent; see addTags below
    "landlord": null,
};
/** Intentions this CRM cannot express, preserved as a tag instead of guessed. */
exports.INTENT_TAGS = {
    "tenant": "Tenant",
    "landlord": "Landlord",
};
function recordKind(rawType) {
    const t = norm(rawType);
    if (t === "lead")
        return "lead";
    if (t === "collaborator")
        return "collaborator";
    if (t === "team")
        return "team";
    return "unknown";
}
/* ---- helpers ------------------------------------------------------------- */
function norm(raw) {
    return String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
function mapVocabulary(p) {
    const unmapped = [];
    const addTags = [];
    const rawStatus = norm(p.status);
    const sm = exports.BRIVITY_STATUS_MAP[rawStatus];
    if (!sm && rawStatus)
        unmapped.push({ field: "status", value: rawStatus });
    if (sm?.addTags)
        addTags.push(...sm.addTags);
    const rawStage = norm(p.stage);
    const stage = exports.BRIVITY_STAGE_MAP[rawStage];
    /* An EMPTY stage is not an unmapped stage. 128 contacts have none, and that
       is Brivity saying nothing rather than saying something unrecognised. */
    if (!stage && rawStage)
        unmapped.push({ field: "stage", value: rawStage });
    const rawIntent = norm(p.lead_type);
    const hasIntentKey = Object.prototype.hasOwnProperty.call(exports.BRIVITY_INTENT_MAP, rawIntent);
    if (!hasIntentKey && rawIntent)
        unmapped.push({ field: "lead_type", value: rawIntent });
    if (exports.INTENT_TAGS[rawIntent])
        addTags.push(exports.INTENT_TAGS[rawIntent]);
    return {
        status: sm?.status ?? exports.STATUS_FALLBACK,
        stage: stage ?? exports.STAGE_FALLBACK,
        intent: hasIntentKey ? exports.BRIVITY_INTENT_MAP[rawIntent] : null,
        addTags,
        unmapped,
    };
}
