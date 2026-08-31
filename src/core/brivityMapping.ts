/**
 * Brivity's vocabulary → this CRM's vocabulary, as explicit tables.
 *
 * WHY TABLES AND NOT `includes()`. The mapping this replaces guessed with
 * substring tests, and measured against the real export (2,855 contacts pulled
 * 2026-08-31) it got the biggest buckets wrong:
 *
 *   "archived" (547) and "trash" (505)  -> both collapsed to "dead", although
 *                                          this CRM has `archived` and
 *                                          `trashed` as distinct statuses
 *   "past-client" (29), "active-client" -> matched `includes("client")` and
 *   (12), "prospective-client" (1)         became "watch". A past client is the
 *                                          most valuable segment a realtor has;
 *                                          filing it as a cold lead loses it.
 *   "Attempted contact" (1,224),        -> all fell through to "new", because
 *   "Spoke with customer" (168),           the stage mapper predates
 *   "Met with customer" (2)                CRM_LEAD_STAGES and did not know
 *                                          those values existed here. 1,394
 *                                          contacts lost their real stage.
 *   "seller/buyer" (202)                -> became "seller"; `buyer_seller`
 *                                          exists and is what it means.
 *   "n/a" (1,353) and "tenant" (13)     -> became "buyer", inventing an
 *                                          intention for half the database.
 *
 * Brivity's five stages map ONE-TO-ONE onto CRM_LEAD_STAGES, so none of that
 * loss was necessary.
 *
 * UNKNOWN VALUES ARE REPORTED, NOT ABSORBED. Every table has a documented
 * fallback, and using it records a warning. If Brivity adds a status next
 * month, the import says so instead of quietly filing a thousand contacts under
 * "nurture" — which is exactly how the previous mapping's errors survived.
 */
import type { CrmIntent, CrmLeadStage, CrmStatus } from "./types.js";

/* ---- status -------------------------------------------------------------- */

export interface StatusMapping {
  status: CrmStatus;
  /**
   * Brivity says things this CRM's status vocabulary cannot. A client is not a
   * lead temperature, so the relationship is preserved as a tag rather than
   * crushed into the nearest status — the information survives and stays
   * filterable.
   */
  addTags?: string[];
  note?: string;
}

export const BRIVITY_STATUS_MAP: Record<string, StatusMapping> = {
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
export const STATUS_FALLBACK: CrmStatus = "nurture";

/* ---- stage --------------------------------------------------------------- */

/**
 * One-to-one with CRM_LEAD_STAGES. Keys are lowercased and whitespace-collapsed
 * before lookup, so "Attempted Contact", "attempted contact" and
 * "Attempted  contact" all land on the same entry.
 */
export const BRIVITY_STAGE_MAP: Record<string, CrmLeadStage> = {
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

export const STAGE_FALLBACK: CrmLeadStage = "new_lead";

/* ---- intention ----------------------------------------------------------- */

/**
 * `null` means Brivity did not say. That is not the same as "buyer", and the
 * previous mapping's habit of defaulting made 1,353 contacts look like buyers
 * who had never said so. The caller decides what to do with null; it must never
 * be invented here.
 */
export const BRIVITY_INTENT_MAP: Record<string, CrmIntent | null> = {
  "buyer": "buyer",
  "seller": "seller",
  "seller/buyer": "buyer_seller",
  "buyer/seller": "buyer_seller",
  "n/a": null,
  "tenant": null,     // this CRM has no tenant intent; see addTags below
  "landlord": null,
};

/** Intentions this CRM cannot express, preserved as a tag instead of guessed. */
export const INTENT_TAGS: Record<string, string> = {
  "tenant": "Tenant",
  "landlord": "Landlord",
};

/* ---- record type --------------------------------------------------------- */

/**
 * Brivity's `type`. Only `lead` is a contact; `collaborator` (125) and `team`
 * (3) are lenders, agents and staff. Importing them as leads puts 128 non-leads
 * on the call list, so they are identified here and handled by the caller.
 */
export type BrivityRecordKind = "lead" | "collaborator" | "team" | "unknown";

export function recordKind(rawType: unknown): BrivityRecordKind {
  const t = norm(rawType);
  if (t === "lead") return "lead";
  if (t === "collaborator") return "collaborator";
  if (t === "team") return "team";
  return "unknown";
}

/* ---- helpers ------------------------------------------------------------- */

export function norm(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface MappedVocabulary {
  status: CrmStatus;
  stage: CrmLeadStage;
  intent: CrmIntent | null;
  /** Tags this mapping adds to preserve something the vocabulary cannot hold. */
  addTags: string[];
  /** Values Brivity sent that no table knows — surfaced, never swallowed. */
  unmapped: Array<{ field: string; value: string }>;
}

export function mapVocabulary(p: {
  status?: unknown; stage?: unknown; lead_type?: unknown;
}): MappedVocabulary {
  const unmapped: Array<{ field: string; value: string }> = [];
  const addTags: string[] = [];

  const rawStatus = norm(p.status);
  const sm = BRIVITY_STATUS_MAP[rawStatus];
  if (!sm && rawStatus) unmapped.push({ field: "status", value: rawStatus });
  if (sm?.addTags) addTags.push(...sm.addTags);

  const rawStage = norm(p.stage);
  const stage = BRIVITY_STAGE_MAP[rawStage];
  /* An EMPTY stage is not an unmapped stage. 128 contacts have none, and that
     is Brivity saying nothing rather than saying something unrecognised. */
  if (!stage && rawStage) unmapped.push({ field: "stage", value: rawStage });

  const rawIntent = norm(p.lead_type);
  const hasIntentKey = Object.prototype.hasOwnProperty.call(BRIVITY_INTENT_MAP, rawIntent);
  if (!hasIntentKey && rawIntent) unmapped.push({ field: "lead_type", value: rawIntent });
  if (INTENT_TAGS[rawIntent]) addTags.push(INTENT_TAGS[rawIntent]);

  return {
    status: sm?.status ?? STATUS_FALLBACK,
    stage: stage ?? STAGE_FALLBACK,
    intent: hasIntentKey ? BRIVITY_INTENT_MAP[rawIntent] : null,
    addTags,
    unmapped,
  };
}
