/**
 * Brivity Core API import — pulls Marco's real Brivity people/contacts and
 * serves them to the new CRM (/crm) as raw lead rows in the same shape as
 * /api/dashboard/data leads, so the front-end can merge both sources.
 *
 * Endpoint + auth proven by scripts/brivity-api-export-csv.mjs:
 *   GET https://api.brivity.com/api/people?limit=5000
 *   Authorization: Token token=<BRIVITY_API_KEY>
 *
 * Results are cached in memory (default 10 min) — Brivity rate limits are
 * unknown, and the CRM reloads on every page open.
 */

import { mapVocabulary, recordKind } from "./brivityMapping.js";

const CORE_BASE = (process.env.BRIVITY_CORE_URL || "https://api.brivity.com").replace(/\/$/, "");
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_LIMIT = 5000;

export interface BrivityLeadRow {
  id: string;
  brivityId: string;
  /** Brivity's other identifiers, kept so history can be attached later. */
  brivityLeadId: string | null;
  brivityUuid: string | null;
  /** Deep link to the original record in Brivity. */
  brivityUrl: string | null;
  /** lead | collaborator | team — only `lead` is a contact. */
  recordKind: string;
  /** A confirmed postal address, not a guess parsed from a conversation. */
  address: string | null;
  /** Values Brivity sent that no mapping table knows. Reported, never absorbed. */
  unmapped: Array<{ field: string; value: string }>;
  platform: string;
  name: string;
  username: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  crmStatus: string;
  crmStage: string;
  crmIntent: "buyer" | "seller" | "buyer_seller" | null;
  crmPriority: string | null;
  crmCallQueue: string | null;
  crmNotes: string | null;
  propertyInquired: string | null;
  criteria: Record<string, unknown>;
  tags: string[];
  alerts: number;
  reports: number;
  activeReports: number;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  lastMessageAt: string | null;
  messages: unknown[];
  activity: unknown[];
  autoPlanEnrollments: unknown[];
}

/**
 * The 28 fields `/api/people` actually returns, confirmed against the live
 * account on 2026-08-31 across all 2,855 records.
 *
 * NOTE THE ABSENCES. There is no `created_at` and no `updated_at`. The previous
 * version read both, so every imported contact carried a null timestamp and the
 * "newest first" sort did nothing at all. Brivity's integration API simply does
 * not date these records.
 */
interface BrivityPerson {
  id?: string | number;
  /** Brivity's other two identifiers. Preserved so history can be attached later. */
  lead_id?: string | number;
  uuid?: string;
  account_id?: string | number;
  agent_id?: string | number;
  agent_uuid?: string;
  /** Deep link back to the original record — the migration's escape hatch. */
  brivity_contact_detail_url?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  email_address?: string;
  company?: string;
  job_title?: string;
  source?: string;
  status?: string;
  stage?: string;
  stage_type?: string;
  type?: string;
  lead_type?: string;
  description?: string;
  street_address?: string;
  city?: string;
  locality?: string;
  postal_code?: string;
  country?: string;
  market_report_count?: number | null;
  active_market_report_count?: number | null;
  tags?: unknown;
}

let cache: { rows: BrivityLeadRow[]; fetchedAt: number } | null = null;
let lastError: string | null = null;
let inflight: Promise<BrivityLeadRow[]> | null = null;

function apiKey(): string {
  return (process.env.BRIVITY_API_KEY || "").trim();
}

export function brivityConfigured(): boolean {
  return apiKey().length > 0;
}

/** Exported so the import suites can run the real export through the real
 *  mapper, rather than a reimplementation of it that can drift. */
export function personToRow(p: BrivityPerson): BrivityLeadRow | null {
  const name = `${(p.first_name || "").trim()} ${(p.last_name || "").trim()}`.trim();
  const phone = (p.phone_number || "").trim() || null;
  const email = (p.email_address || "").trim() || null;
  if (!name && !phone && !email) return null;

  /* A CONFIRMED postal address. It used to be written to `criteria.location`,
     which is the slot for an address GUESSED out of a DM conversation — so the
     CRM deliberately never promoted it to the contact's address book, and
     Brivity's real address never appeared on the profile. It goes to `address`
     now, which is what that field is for. Postal code and country were dropped
     entirely before. */
  const address = [p.street_address, p.city, p.locality, p.postal_code, p.country]
    .map((x) => String(x ?? "").trim()).filter(Boolean).join(", ") || null;

  const v = mapVocabulary(p);
  const tags = Array.isArray(p.tags) ? (p.tags as unknown[]).map(String).filter(Boolean) : [];
  for (const t of v.addTags) if (!tags.includes(t)) tags.push(t);

  return {
    id: `brivity-${p.id ?? `${name}-${phone || email || ""}`}`,
    brivityId: String(p.id ?? ""),
    brivityLeadId: p.lead_id != null ? String(p.lead_id) : null,
    brivityUuid: p.uuid ? String(p.uuid) : null,
    brivityUrl: p.brivity_contact_detail_url ? String(p.brivity_contact_detail_url) : null,
    recordKind: recordKind(p.type),
    platform: "brivity",
    name: name || "Unknown",
    username: null,
    phone,
    email,
    source: (p.source || "").trim() || "Brivity CRM",
    crmStatus: v.status,
    crmStage: v.stage,
    /* Brivity said nothing for 1,353 of these. Defaulting to "buyer" invented an
       intention for half the database, so the null is carried and the caller
       decides. */
    crmIntent: v.intent,
    crmPriority: null,
    crmCallQueue: null,
    crmNotes: (p.description || "").trim() || null,
    propertyInquired: null,
    criteria: {},
    address,
    tags,
    /* The real counts, which were hard-coded to zero before even though both
       numbers are on every record. */
    alerts: 0,
    reports: Number(p.market_report_count ?? 0) || 0,
    activeReports: Number(p.active_market_report_count ?? 0) || 0,
    unmapped: v.unmapped,
    /* Brivity's integration API returns no timestamps at all — see the
       BrivityPerson note. Nulls here are honest, not missing data. */
    createdAt: null,
    updatedAt: null,
    lastActivity: null,
    lastMessageAt: null,
    messages: [],
    activity: [],
    autoPlanEnrollments: [],
  };
}

/**
 * Pulling all ~2,600 people takes 27-30s, so the original 30s timeout sat right
 * on the edge and failed intermittently — which mattered once an import started
 * depending on it. Generous ceiling plus one retry.
 */
const FETCH_TIMEOUT_MS = 90_000;

async function fetchOnce(key: string): Promise<Response> {
  return fetch(`${CORE_BASE}/api/people?limit=${FETCH_LIMIT}`, {
    headers: { Authorization: `Token token=${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

async function fetchFromBrivity(): Promise<BrivityLeadRow[]> {
  const key = apiKey();
  if (!key) throw new Error("BRIVITY_API_KEY not set");
  let res: Response;
  try {
    res = await fetchOnce(key);
  } catch (err) {
    console.warn("[Brivity] people fetch failed, retrying once:", (err as Error).message);
    res = await fetchOnce(key);
  }
  if (!res.ok) {
    throw new Error(`Brivity API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as unknown;
  const list: BrivityPerson[] = Array.isArray(data)
    ? (data as BrivityPerson[])
    : Array.isArray((data as { people?: unknown }).people)
      ? ((data as { people: BrivityPerson[] }).people)
      : [];
  const rows = list.map(personToRow).filter((r): r is BrivityLeadRow => r !== null);
  /* Brivity returns no timestamps, so there is nothing to sort by. The old
     sort compared two nulls on every pair and did nothing; leaving the API's
     own order is at least honest about that. */
  return rows;
}

export async function getBrivityPeople(forceRefresh = false): Promise<BrivityLeadRow[]> {
  if (!brivityConfigured()) return [];
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rows;
  if (inflight) return inflight;
  inflight = fetchFromBrivity()
    .then((rows) => {
      cache = { rows, fetchedAt: Date.now() };
      lastError = null;
      console.log(`[Brivity] imported ${rows.length} people from Core API`);
      return rows;
    })
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      console.error("[Brivity] people import failed:", lastError);
      // Serve the stale cache (if any) rather than dropping live data.
      return cache?.rows ?? [];
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function getBrivityImportStatus(): {
  configured: boolean;
  cachedCount: number;
  fetchedAt: string | null;
  lastError: string | null;
} {
  return {
    configured: brivityConfigured(),
    cachedCount: cache?.rows.length ?? 0,
    fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    lastError,
  };
}
