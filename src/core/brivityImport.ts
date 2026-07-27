import type { CrmIntent, CrmStatusValue, Lead } from "./types.js";
import { FunnelStage } from "./state.js";
import { getBrivityPeople, getBrivityImportStatus, type BrivityLeadRow } from "./brivityPeople.js";
import { listAllLeads } from "./db.js";

/**
 * Plan (and later apply) an import of Marco's real Brivity contacts into the
 * lead store, so they reach the CRM and the Buyers & Sellers Tracker.
 *
 * Brivity is already readable — `brivityPeople.ts` fetches and caches it for
 * /crm — but nothing has ever been persisted, which is why no lead carries a
 * `brivityId`. This module is the missing write half.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS DOES NOT CALL createLead()
 *
 * `db.createLead()` fires real outbound side effects: a phone on the lead sends
 * a Twilio SMS to Marco and Carlos, and an email schedules a marketing
 * auto-reply three minutes later plus a buyer/seller drip. Pushing ~2,470
 * phones and ~986 emails through it would text the two of them thousands of
 * times and email a thousand mostly-cold contacts unprompted.
 *
 * The apply step therefore writes through `importLeadQuiet()`, which inserts
 * the same record with none of that. These are existing contacts being filed,
 * not new leads arriving.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Match key: US 10-digit, so "(210) 555-0134", "+12105550134" and "2105550134" agree. */
export function phoneKey(raw: unknown): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? d : "";
}

function emailKey(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** An all-caps or all-lower Brivity name reads badly on a card. */
function tidyName(raw: unknown): string {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;   // already mixed case
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Names Brivity uses as filler; not worth overwriting a real handle with. */
const JUNK_NAMES = new Set(["", "unknown", "n/a", "na", "none", "no name", "-"]);
function usableName(raw: unknown): string {
  const s = tidyName(raw);
  return JUNK_NAMES.has(s.toLowerCase()) ? "" : s;
}

export interface BrivityImportOptions {
  /** Create new leads for contacts Brivity marks dead. Default false. */
  includeDead?: boolean;
  /**
   * Still use a dead Brivity contact to enrich a lead we ALREADY have.
   * Default true, and it matters: 134 existing leads match a dead Brivity
   * contact, 114 of which are sitting on the board under a social handle
   * ("purple kitty 22") when Brivity knows the real name (Andrea Perez).
   * Enrichment adds no rows — it only fills in what we already hold.
   */
  enrichDeadMatches?: boolean;
  /** Overwrite a DM handle with Brivity's real name. Default true. */
  preferBrivityName?: boolean;
  dryRun?: boolean;
}

export interface PlannedCreate {
  brivityId: string;
  name: string;
  phone: string | null;
  email: string | null;
  intent: CrmIntent;
  status: CrmStatusValue;
  source: string | null;
}

export interface PlannedMerge {
  leadId: string;
  brivityId: string;
  matchedOn: "phone" | "email";
  /** Field-level changes, so a dry run shows exactly what would be rewritten. */
  changes: Array<{ field: string; from: string | null; to: string | null }>;
}

export interface BrivityImportPlan {
  dryRun: boolean;
  options: Required<Omit<BrivityImportOptions, "dryRun">>;
  fetched: number;
  /** Reasons a Brivity contact is not imported. */
  skipped: { dead: number; noContactInfo: number; duplicateWithinBrivity: number };
  creates: PlannedCreate[];
  merges: PlannedMerge[];
  /** Matched an existing lead but nothing would change. */
  unchanged: number;
  /** Two different existing leads share this contact's phone — needs a human. */
  ambiguous: Array<{ brivityId: string; name: string; phone: string; leadIds: string[] }>;
  counts: { create: number; merge: number; renames: number };
}

/** Brivity status → the CRM's status vocabulary, already normalised upstream. */
function statusOf(p: BrivityLeadRow): CrmStatusValue {
  return (p.crmStatus || "new") as CrmStatusValue;
}

function intentOf(p: BrivityLeadRow): CrmIntent {
  return p.crmIntent === "seller" ? "seller" : "buyer";
}

/**
 * Pick the better of two Brivity rows sharing a phone: the one with more filled
 * fields, breaking ties on the more recently updated.
 */
function richer(a: BrivityLeadRow, b: BrivityLeadRow): BrivityLeadRow {
  const score = (x: BrivityLeadRow) =>
    (usableName(x.name) ? 2 : 0) + (x.email ? 1 : 0) + (x.phone ? 1 : 0) + (x.source ? 1 : 0);
  const sa = score(a), sb = score(b);
  if (sa !== sb) return sa > sb ? a : b;
  return String(b.updatedAt || "") > String(a.updatedAt || "") ? b : a;
}

export async function planBrivityImport(
  opts: BrivityImportOptions = {},
): Promise<BrivityImportPlan> {
  const options = {
    includeDead: opts.includeDead === true,
    enrichDeadMatches: opts.enrichDeadMatches !== false,
    preferBrivityName: opts.preferBrivityName !== false,
  };

  const people = await getBrivityPeople(false);
  /*
   * getBrivityPeople swallows fetch failures and returns [] (it is built to
   * degrade for the CRM view). For an import plan that is dangerous: an empty
   * result would read as "nothing to import" when it actually means "we could
   * not reach Brivity". Refuse rather than report a false no-op.
   */
  if (!people.length) {
    const st = getBrivityImportStatus();
    throw new Error(
      st.lastError
        ? `Brivity fetch failed (${st.lastError}) — refusing to plan against an empty result`
        : "Brivity returned no contacts — refusing to plan against an empty result",
    );
  }
  const leads = await listAllLeads();

  // Existing leads indexed for matching. A phone shared by two leads is a
  // conflict we refuse to guess at rather than merging into the wrong one.
  const byPhone = new Map<string, Lead[]>();
  const byEmail = new Map<string, Lead>();
  const byBrivityId = new Map<string, Lead>();
  for (const l of leads) {
    const pk = phoneKey(l.phone);
    if (pk) { const arr = byPhone.get(pk) || []; arr.push(l); byPhone.set(pk, arr); }
    const ek = emailKey(l.email);
    if (ek && !byEmail.has(ek)) byEmail.set(ek, l);
    if (l.brivityId) byBrivityId.set(String(l.brivityId), l);
  }

  const plan: BrivityImportPlan = {
    dryRun: opts.dryRun !== false,
    options,
    fetched: people.length,
    skipped: { dead: 0, noContactInfo: 0, duplicateWithinBrivity: 0 },
    creates: [],
    merges: [],
    unchanged: 0,
    ambiguous: [],
    counts: { create: 0, merge: 0, renames: 0 },
  };

  // Collapse duplicates inside Brivity itself before matching outward.
  /*
   * Dead contacts are held back from CREATE, not from matching. Dropping them
   * outright also drops the enrichment for leads we already have: 134 of them
   * match a dead Brivity contact and 114 are on the board under a social handle
   * when Brivity knows the real name. Enrichment adds no rows.
   */
  const chosen = new Map<string, BrivityLeadRow>();
  for (const p of people) {
    const pk = phoneKey(p.phone);
    const ek = emailKey(p.email);
    if (!pk && !ek) { plan.skipped.noContactInfo++; continue; }
    const key = pk || `e:${ek}`;
    const prev = chosen.get(key);
    if (prev) { plan.skipped.duplicateWithinBrivity++; chosen.set(key, richer(prev, p)); }
    else chosen.set(key, p);
  }

  for (const p of chosen.values()) {
    const pk = phoneKey(p.phone);
    const ek = emailKey(p.email);
    const bid = String(p.brivityId || p.id || "");

    let match: Lead | undefined = bid ? byBrivityId.get(bid) : undefined;
    let matchedOn: "phone" | "email" = "phone";

    if (!match && pk) {
      const hits = byPhone.get(pk) || [];
      if (hits.length > 1) {
        plan.ambiguous.push({
          brivityId: bid,
          name: usableName(p.name) || "(no name)",
          phone: pk,
          leadIds: hits.map((h) => h.id),
        });
        continue;
      }
      match = hits[0];
    }
    if (!match && ek) { match = byEmail.get(ek); matchedOn = "email"; }

    const isDead = statusOf(p) === "dead";

    if (!match) {
      // Nothing to enrich, so a dead contact is simply not imported.
      if (isDead && !options.includeDead) { plan.skipped.dead++; continue; }
      plan.creates.push({
        brivityId: bid,
        name: usableName(p.name) || p.phone || p.email || "Unnamed",
        phone: p.phone || null,
        email: p.email || null,
        intent: intentOf(p),
        status: statusOf(p),
        source: p.source || null,
      });
      continue;
    }

    if (isDead && !options.enrichDeadMatches) { plan.skipped.dead++; continue; }

    // Merge: only record fields that would actually change.
    const changes: PlannedMerge["changes"] = [];
    const bName = usableName(p.name);
    if (options.preferBrivityName && bName && bName !== (match.name || "")) {
      changes.push({ field: "name", from: match.name, to: bName });
    }
    if (p.email && emailKey(p.email) !== emailKey(match.email)) {
      changes.push({ field: "email", from: match.email, to: p.email });
    }
    if (p.phone && !match.phone) {
      changes.push({ field: "phone", from: match.phone, to: p.phone });
    }
    if (bid && String(match.brivityId || "") !== bid) {
      changes.push({ field: "brivityId", from: match.brivityId, to: bid });
    }
    // Brivity is the system of record for whether someone is buying or selling.
    const bIntent = intentOf(p);
    if (bIntent !== match.crmIntent) {
      changes.push({ field: "crmIntent", from: match.crmIntent, to: bIntent });
    }
    /*
     * Status only fills a gap, and never imports "dead". A lead we have talked
     * to in the DMs should not be marked dead because a Brivity row nobody has
     * touched in a year says so — that would quietly bury live conversations.
     * Identity (name, email) is still enriched from those rows.
     */
    const bStatus = statusOf(p);
    if (match.crmStatus === "new" && bStatus !== "new" && bStatus !== "dead") {
      changes.push({ field: "crmStatus", from: match.crmStatus, to: bStatus });
    }
    if (p.source && !match.source) {
      changes.push({ field: "source", from: match.source, to: p.source });
    }

    if (!changes.length) { plan.unchanged++; continue; }
    plan.merges.push({ leadId: match.id, brivityId: bid, matchedOn, changes });
  }

  plan.counts = {
    create: plan.creates.length,
    merge: plan.merges.length,
    renames: plan.merges.filter((m) => m.changes.some((c) => c.field === "name")).length,
  };
  return plan;
}

/** The Lead a planned create becomes. Exported so apply and tests agree. */
export function leadFromPlannedCreate(c: PlannedCreate): Omit<Lead, "id" | "createdAt" | "updatedAt"> {
  return {
    platform: "brivity",
    userId: `brivity_${c.brivityId}`,
    username: null,
    name: c.name,
    phone: c.phone,
    email: c.email,
    state: FunnelStage.New,
    source: c.source,
    adCampaign: null,
    propertyInquired: null,
    criteria: null,
    brivityId: c.brivityId,
    crmStatus: c.status,
    crmStage: "new",
    crmPriority: "normal",
    crmIntent: c.intent,
    crmCallQueue: "none",
    crmNotes: null,
  } as Omit<Lead, "id" | "createdAt" | "updatedAt">;
}
