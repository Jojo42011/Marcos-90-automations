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
  /**
   * Create leads for Brivity records that are not contacts at all. Default
   * false. Brivity's `type` marks 125 `collaborator` rows (lenders, co-op
   * agents, title reps) and 3 `team` rows (Marco's own staff seats). They are
   * real people, but they are not leads, and importing them puts 128 non-leads
   * on the call list — someone eventually cold-calls their own lender.
   *
   * Like dead contacts, they are held back from CREATE only. If one already
   * matches a lead we hold, enrichment still runs: that adds no rows and only
   * fills in a name or email we were missing.
   */
  includeNonLeads?: boolean;
  dryRun?: boolean;
}

export interface PlannedCreate {
  brivityId: string;
  brivityLeadId: string | null;
  brivityUuid: string | null;
  /** Deep link back to the original record. */
  brivityUrl: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  /** null when Brivity never said — not the same as "buyer". */
  intent: CrmIntent | null;
  status: CrmStatusValue;
  /** Brivity's real stage, mapped 1:1. Was hard-coded to "new" before. */
  stage: string;
  source: string | null;
  /** Brivity's `description`, populated on 41% of contacts. Was dropped. */
  notes: string | null;
  /** A confirmed postal address. Was written to the guessed-address slot. */
  address: string | null;
  tags: string[];
  marketReports: number;
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
  skipped: { dead: number; noContactInfo: number; duplicateWithinBrivity: number; nonLead: number };
  creates: PlannedCreate[];
  merges: PlannedMerge[];
  /** Matched an existing lead but nothing would change. */
  unchanged: number;
  /** Two different existing leads share this contact's phone — needs a human. */
  ambiguous: Array<{ brivityId: string; name: string; phone: string; leadIds: string[] }>;
  counts: { create: number; merge: number; renames: number };
}

/**
 * Statuses that take a lead off the working board. Brivity may hold any of
 * these for a contact this CRM is actively talking to, and importing one would
 * hide a live conversation, so none of them is ever merged onto an existing
 * lead. They are still honoured for CREATES — a contact we have never spoken to
 * belongs in whatever bucket Brivity had it in.
 */
const BURYING_STATUSES = new Set<CrmStatusValue>(["dead", "archived", "trashed"] as CrmStatusValue[]);

/** Brivity status → the CRM's status vocabulary, already normalised upstream. */
function statusOf(p: BrivityLeadRow): CrmStatusValue {
  return (p.crmStatus || "new") as CrmStatusValue;
}

/**
 * Brivity's intention, or null when it never said.
 *
 * The previous version returned "buyer" for anything that was not "seller",
 * which invented an intention for the 1,353 contacts Brivity marks "n/a" and
 * silently downgraded the 202 marked "seller/buyer". Null is carried through so
 * the merge path can decline to overwrite what we already know.
 */
function intentOf(p: BrivityLeadRow): CrmIntent | null {
  return (p.crmIntent as CrmIntent | null) ?? null;
}

/**
 * Pick the better of two Brivity rows sharing a phone: the one with more filled
 * fields.
 *
 * There is no recency tie-break, because there is nothing to break it with —
 * Brivity's people API returns no timestamps at all, so `updatedAt` is always
 * null. A tie therefore keeps the row seen first, which at least makes the
 * outcome deterministic across runs rather than dependent on fetch order.
 */
function richer(a: BrivityLeadRow, b: BrivityLeadRow): BrivityLeadRow {
  const score = (x: BrivityLeadRow) =>
    (usableName(x.name) ? 2 : 0) + (x.email ? 1 : 0) + (x.phone ? 1 : 0) + (x.source ? 1 : 0);
  const sa = score(a), sb = score(b);
  return sb > sa ? b : a;
}

/**
 * Seams for testing. A migration plan is only trustworthy if it can be run over
 * the real export without touching the live Brivity account or the live lead
 * store, and ESM exports cannot be monkeypatched — so the two external reads
 * are injectable. Production passes nothing and gets the real ones.
 */
export interface BrivityImportDeps {
  fetchPeople?: () => Promise<BrivityLeadRow[]>;
  loadLeads?: () => Lead[];
}

export async function planBrivityImport(
  opts: BrivityImportOptions = {},
  deps: BrivityImportDeps = {},
): Promise<BrivityImportPlan> {
  const options = {
    includeDead: opts.includeDead === true,
    enrichDeadMatches: opts.enrichDeadMatches !== false,
    preferBrivityName: opts.preferBrivityName !== false,
    includeNonLeads: opts.includeNonLeads === true,
  };

  const people = deps.fetchPeople ? await deps.fetchPeople() : await getBrivityPeople(false);
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
  const leads = deps.loadLeads ? deps.loadLeads() : await listAllLeads();

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
    skipped: { dead: 0, noContactInfo: 0, duplicateWithinBrivity: 0, nonLead: 0 },
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
    /* `lead` is the only Brivity type that is a contact. `collaborator` and
       `team` are lenders, co-op agents and Marco's own staff seats; `unknown`
       is a type Brivity added that we have not mapped, which is not something
       to guess about when the guess lands on the call list. */
    const isNonLead = p.recordKind !== "lead";

    if (!match) {
      // Nothing to enrich, so a dead contact is simply not imported.
      if (isDead && !options.includeDead) { plan.skipped.dead++; continue; }
      // Same for a record that was never a lead in the first place.
      if (isNonLead && !options.includeNonLeads) { plan.skipped.nonLead++; continue; }
      plan.creates.push({
        brivityId: bid,
        brivityLeadId: p.brivityLeadId ?? null,
        brivityUuid: p.brivityUuid ?? null,
        brivityUrl: p.brivityUrl ?? null,
        name: usableName(p.name) || p.phone || p.email || "Unnamed",
        phone: p.phone || null,
        email: p.email || null,
        intent: intentOf(p),
        status: statusOf(p),
        stage: p.crmStage || "new_lead",
        source: p.source || null,
        notes: p.crmNotes || null,
        address: p.address ?? null,
        tags: Array.isArray(p.tags) ? p.tags : [],
        marketReports: Number(p.reports || 0),
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
    /* Email FILLS A GAP; it does not overwrite. A lead carries one email field,
       so replacing a different address destroys the only copy — and Brivity
       returns no timestamps, so there is no basis for calling its address the
       fresher one. The CRM's value typically came from an actual conversation.
       (Phone already worked this way; email did not, which was inconsistent.) */
    if (p.email && !match.email) {
      changes.push({ field: "email", from: match.email, to: p.email });
    }
    if (p.phone && !match.phone) {
      changes.push({ field: "phone", from: match.phone, to: p.phone });
    }
    if (bid && String(match.brivityId || "") !== bid) {
      changes.push({ field: "brivityId", from: match.brivityId, to: bid });
    }
    /* Brivity is the system of record for buying vs selling — but only when it
       actually says. A null means "not stated", and overwriting a known intent
       with it would erase what this CRM already learned in conversation. */
    const bIntent = intentOf(p);
    if (bIntent && bIntent !== match.crmIntent) {
      changes.push({ field: "crmIntent", from: match.crmIntent, to: bIntent });
    }
    /*
     * Status only fills a gap, and never imports one that BURIES the lead. A
     * lead we have talked to in the DMs should not be filed away because a
     * Brivity row nobody has touched in a year says so — that would quietly
     * hide live conversations. Identity (name, email) is still enriched from
     * those rows.
     *
     * This guard used to read `!== "dead"` and that was sufficient only because
     * the old mapping collapsed archived and trash INTO dead. Now that they map
     * to their own statuses (which is correct), a Brivity "trash" row would
     * otherwise sail past a one-value check and bury 431 live leads. The guard
     * is a set, so splitting a status out of `dead` again cannot silently
     * reopen this.
     */
    const bStatus = statusOf(p);
    if (match.crmStatus === "new" && bStatus !== "new" && !BURYING_STATUSES.has(bStatus)) {
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

export interface BrivityImportResult {
  applied: true;
  created: number;
  merged: number;
  fieldsWritten: Record<string, number>;
  failures: Array<{ ref: string; error: string }>;
}

/**
 * Write a plan.
 *
 * Everything goes through `upsertLeadQuiet`, never `createLead` — see the note
 * at the top of this file. Filing existing contacts must not text Marco and
 * Carlos hundreds of times or email hundreds of cold contacts.
 */
export async function applyBrivityImport(plan: BrivityImportPlan): Promise<BrivityImportResult> {
  const { upsertLeadQuiet } = await import("./db.js");
  const leads = await listAllLeads();
  const byId = new Map(leads.map((l) => [l.id, l]));

  const out: BrivityImportResult = {
    applied: true,
    created: 0,
    merged: 0,
    fieldsWritten: {},
    failures: [],
  };

  for (const c of plan.creates) {
    try {
      upsertLeadQuiet(leadFromPlannedCreate(c));
      out.created++;
    } catch (err) {
      out.failures.push({ ref: `create:${c.brivityId}`, error: (err as Error).message });
    }
  }

  for (const m of plan.merges) {
    const lead = byId.get(m.leadId);
    if (!lead) {
      out.failures.push({ ref: `merge:${m.leadId}`, error: "lead no longer exists" });
      continue;
    }
    try {
      const patch: Record<string, unknown> = {};
      for (const ch of m.changes) {
        patch[ch.field] = ch.to;
        out.fieldsWritten[ch.field] = (out.fieldsWritten[ch.field] || 0) + 1;
      }
      upsertLeadQuiet({ ...lead, ...patch } as never);
      out.merged++;
    } catch (err) {
      out.failures.push({ ref: `merge:${m.leadId}`, error: (err as Error).message });
    }
  }
  return out;
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
    /* Brivity's real stage. This was hard-coded to "new", which threw away the
       stage on 1,394 contacts at the write layer even when the read layer had
       it right. */
    crmStage: c.stage as Lead["crmStage"],
    crmPriority: "normal",
    /* The schema requires a value; "buyer" is the storage default for a contact
       whose intention Brivity never stated. It is NOT evidence they are a
       buyer, which is why the merge path refuses to write it over a known one. */
    crmIntent: c.intent ?? "buyer",
    crmCallQueue: "none",
    crmNotes: c.notes,
    address: c.address,
    tags: c.tags,
  } as Omit<Lead, "id" | "createdAt" | "updatedAt">;
}
