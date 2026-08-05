/**
 * Lead CSV import — the file-shaped way into the CRM.
 *
 * The spec asks for leads to arrive without manual entry from every source.
 * DMs and inbound texts already land themselves; Mojo, website form dumps and
 * everything else arrive as files a human retypes. This is the importer that
 * takes the file instead: Mojo's export today, any other CSV of contacts
 * tomorrow.
 *
 * Same shape as the transaction and Brivity imports, because that shape has
 * earned its keep here twice: PLAN first (nothing written, every decision
 * visible), APPLY second, and writes go through `upsertLeadQuiet` — never
 * `createLead`, which fires real texts to Marco and Carlos and enrolls emails
 * in drips. Filing 300 Mojo contacts must not text anybody 300 times.
 *
 * Matching: a row matches an existing lead on phone first, then email. A
 * match ENRICHES — it fills fields the lead is missing and never overwrites
 * what a human or the DM funnel already captured. Two existing leads sharing
 * the row's phone is reported as ambiguous and left alone.
 */

import type { CrmIntent, CrmStatusValue, Lead } from "./types.js";
import { FunnelStage } from "./state.js";
import { parseCsv } from "./transactionImport.js";
import { phoneKey } from "./brivityImport.js";
import { listAllLeads, upsertLeadQuiet } from "./db.js";

/* Column aliases. Mojo's export names first-class; generic names so a website
   form dump or a hand-made sheet works without renaming headers. Anything not
   placed is REPORTED, never silently dropped. */
const ALIASES: Record<string, string[]> = {
  name: ["name", "full name", "contact name", "contact", "owner name", "borrower"],
  firstName: ["first name", "first", "fname"],
  lastName: ["last name", "last", "lname"],
  phone: ["phone", "phone number", "mobile", "cell", "cell phone", "phone 1", "primary phone", "contact number"],
  phone2: ["phone 2", "secondary phone", "other phone", "home phone", "work phone"],
  email: ["email", "email address", "e-mail", "email 1"],
  address: ["address", "property address", "street address", "mailing address", "full address"],
  city: ["city"],
  source: ["source", "lead source", "campaign"],
  tags: ["tags", "tag", "labels", "list", "list name"],
  notes: ["notes", "note", "comments", "description", "message"],
  intent: ["intent", "type", "lead type", "buyer/seller", "buyer or seller"],
};

function indexHeaders(headers: string[]): { ix: Record<string, number>; unmapped: string[] } {
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
  const ix: Record<string, number> = {};
  const claimed = new Set<number>();
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const at = norm.indexOf(n);
      if (at >= 0 && !claimed.has(at)) { ix[field] = at; claimed.add(at); break; }
    }
  }
  const unmapped = headers.filter((h, i) => h.trim() !== "" && !claimed.has(i)).map((h) => h.trim());
  return { ix, unmapped };
}

function tidyName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return "";
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function emailKey(raw: string): string {
  const s = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : "";
}

function intentOf(raw: string): CrmIntent {
  return /sell/i.test(raw) ? "seller" : "buyer";
}

export interface LeadImportRow {
  line: number;
  action: "create" | "enrich" | "skip" | "ambiguous";
  reason?: string;
  name: string;
  phone: string | null;
  email: string | null;
  matchedLeadId?: string;
  /** For enrich: exactly which empty fields get filled. */
  fills?: Array<{ field: string; to: string }>;
}

export interface LeadImportPlan {
  rowsSeen: number;
  unmappedHeaders: string[];
  errors: string[];
  defaultSource: string;
  rows: LeadImportRow[];
  create: number;
  enrich: number;
  skip: number;
  ambiguous: number;
  /** Carried so apply() can reconstruct the writes. */
  _writes: Array<{
    row: LeadImportRow;
    create?: Omit<Lead, "id" | "createdAt" | "updatedAt">;
    enrichLeadId?: string;
    enrichPatch?: Record<string, unknown>;
  }>;
}

export interface LeadImportOptions {
  /** Source stamped on rows that don't carry their own (e.g. "Mojo"). */
  defaultSource?: string;
  /** Extra tags added to every imported lead (e.g. ["mojo-import"]). */
  tags?: string[];
}

export async function planLeadImport(csvText: string, opts: LeadImportOptions = {}): Promise<LeadImportPlan> {
  const defaultSource = (opts.defaultSource || "CSV Import").trim();
  const extraTags = (opts.tags || []).map((t) => t.trim()).filter(Boolean);
  const rows = parseCsv(csvText);
  const plan: LeadImportPlan = {
    rowsSeen: Math.max(0, rows.length - 1),
    unmappedHeaders: [], errors: [], defaultSource,
    rows: [], create: 0, enrich: 0, skip: 0, ambiguous: 0, _writes: [],
  };
  if (rows.length < 2) {
    plan.errors.push("No data rows found — the file has a header or nothing at all.");
    return plan;
  }
  const { ix, unmapped } = indexHeaders(rows[0]);
  plan.unmappedHeaders = unmapped;
  if (ix.name == null && ix.firstName == null && ix.phone == null && ix.email == null) {
    plan.errors.push(
      `No name, phone, or email column found — nothing to identify a person by. Headers seen: ${rows[0].map((h) => h.trim()).filter(Boolean).join(", ")}`,
    );
    return plan;
  }
  const get = (r: string[], k: string): string => (ix[k] != null ? String(r[ix[k]] ?? "").trim() : "");

  /* Index existing leads once. A phone held by two different leads is a real
     state of this CRM (couples share numbers) — those rows go to `ambiguous`
     rather than picking one silently. */
  const existing = await listAllLeads();
  const byPhone = new Map<string, Lead[]>();
  const byEmail = new Map<string, Lead[]>();
  for (const l of existing) {
    const pk = phoneKey(l.phone);
    if (pk) byPhone.set(pk, [...(byPhone.get(pk) || []), l]);
    const ek = emailKey(l.email || "");
    if (ek) byEmail.set(ek, [...(byEmail.get(ek) || []), l]);
  }
  const seenInFile = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = tidyName(get(r, "name") || [get(r, "firstName"), get(r, "lastName")].filter(Boolean).join(" "));
    const pk = phoneKey(get(r, "phone")) || phoneKey(get(r, "phone2"));
    const ek = emailKey(get(r, "email"));
    const phone = pk ? `+1${pk}` : null;
    const email = ek || null;

    const push = (row: LeadImportRow) => { plan.rows.push(row); };

    if (!name && !pk && !ek) {
      plan.skip++;
      push({ line: i + 1, action: "skip", reason: "no name, phone, or email", name: "", phone: null, email: null });
      continue;
    }
    const fileKey = pk || ek || `name:${name.toLowerCase()}`;
    if (seenInFile.has(fileKey)) {
      plan.skip++;
      push({ line: i + 1, action: "skip", reason: "duplicate row in this file", name, phone, email });
      continue;
    }
    seenInFile.add(fileKey);

    const phoneMatches = pk ? byPhone.get(pk) || [] : [];
    const emailMatches = !phoneMatches.length && ek ? byEmail.get(ek) || [] : [];
    const matches = phoneMatches.length ? phoneMatches : emailMatches;

    if (matches.length > 1) {
      plan.ambiguous++;
      push({
        line: i + 1, action: "ambiguous", name, phone, email,
        reason: `${matches.length} existing leads share this ${phoneMatches.length ? "phone" : "email"} (${matches.map((l) => l.id).join(", ")}) — left alone`,
      });
      continue;
    }

    const source = get(r, "source") || defaultSource;
    const tags = [
      ...get(r, "tags").split(/[;,|]/).map((t) => t.trim()).filter(Boolean),
      ...extraTags,
    ];
    const notes = get(r, "notes");
    const addr = [get(r, "address"), get(r, "city")].filter(Boolean).join(", ");

    if (matches.length === 1) {
      const lead = matches[0];
      /* Fill only what is EMPTY. The DM funnel's captured name, a typed note,
         a linked listing — none of that is this file's to overwrite. */
      const fills: Array<{ field: string; to: string }> = [];
      const junkName = !lead.name || /^(unknown|n\/a|-|none)$/i.test(lead.name);
      if (name && junkName) fills.push({ field: "name", to: name });
      if (email && !lead.email) fills.push({ field: "email", to: email });
      if (phone && !lead.phone) fills.push({ field: "phone", to: phone });
      if (!lead.source && source) fills.push({ field: "source", to: source });
      if (!fills.length) {
        plan.skip++;
        push({ line: i + 1, action: "skip", reason: "already in the CRM, nothing new to add", name, phone, email, matchedLeadId: lead.id });
        continue;
      }
      plan.enrich++;
      const patch: Record<string, unknown> = {};
      for (const f of fills) patch[f.field] = f.to;
      const row: LeadImportRow = { line: i + 1, action: "enrich", name, phone, email, matchedLeadId: lead.id, fills };
      push(row);
      plan._writes.push({ row, enrichLeadId: lead.id, enrichPatch: patch });
      continue;
    }

    plan.create++;
    const create: Omit<Lead, "id" | "createdAt" | "updatedAt"> = {
      platform: "import",
      userId: `import_${pk || ek || `${Date.now()}_${i}`}`,
      username: null,
      name: name || null,
      phone,
      email,
      state: FunnelStage.New,
      source,
      adCampaign: null,
      propertyInquired: addr || null,
      criteria: null,
      brivityId: null,
      crmStatus: "new" as CrmStatusValue,
      crmStage: "new",
      crmPriority: "normal",
      crmIntent: intentOf(get(r, "intent")),
      crmCallQueue: "none",
      crmNotes: notes || null,
      tags: tags.length ? tags : undefined,
    };
    const row: LeadImportRow = { line: i + 1, action: "create", name, phone, email };
    push(row);
    plan._writes.push({ row, create });
  }
  return plan;
}

export interface LeadImportResult {
  created: number;
  enriched: number;
  skipped: number;
  ambiguous: number;
  rowsSeen: number;
  unmappedHeaders: string[];
  errors: string[];
  totalLeads: number;
}

export async function applyLeadImport(plan: LeadImportPlan): Promise<LeadImportResult> {
  let created = 0;
  let enriched = 0;
  const errors = [...plan.errors];
  const existing = await listAllLeads();
  const byId = new Map(existing.map((l) => [l.id, l]));

  for (const w of plan._writes) {
    try {
      if (w.create) {
        upsertLeadQuiet(w.create);
        created++;
      } else if (w.enrichLeadId && w.enrichPatch) {
        const lead = byId.get(w.enrichLeadId);
        if (!lead) { errors.push(`line ${w.row.line}: lead ${w.enrichLeadId} no longer exists`); continue; }
        upsertLeadQuiet({ ...lead, ...w.enrichPatch } as never);
        enriched++;
      }
    } catch (err) {
      errors.push(`line ${w.row.line}: ${(err as Error).message}`);
    }
  }
  const after = await listAllLeads();
  return {
    created, enriched, skipped: plan.skip, ambiguous: plan.ambiguous,
    rowsSeen: plan.rowsSeen, unmappedHeaders: plan.unmappedHeaders, errors,
    totalLeads: after.length,
  };
}
