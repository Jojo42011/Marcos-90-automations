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

const CORE_BASE = (process.env.BRIVITY_CORE_URL || "https://api.brivity.com").replace(/\/$/, "");
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_LIMIT = 5000;

export interface BrivityLeadRow {
  id: string;
  brivityId: string;
  platform: string;
  name: string;
  username: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  crmStatus: string;
  crmStage: string;
  crmIntent: "buyer" | "seller";
  crmPriority: string | null;
  crmCallQueue: string | null;
  crmNotes: string | null;
  propertyInquired: string | null;
  criteria: Record<string, unknown>;
  tags: string[];
  alerts: number;
  reports: number;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  lastMessageAt: string | null;
  messages: unknown[];
  activity: unknown[];
  autoPlanEnrollments: unknown[];
}

interface BrivityPerson {
  id?: string | number;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  email_address?: string;
  source?: string;
  status?: string;
  stage?: string;
  lead_type?: string;
  description?: string;
  street_address?: string;
  city?: string;
  locality?: string;
  tags?: unknown;
  created_at?: string;
  updated_at?: string;
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

/** Brivity status strings → the CRM's crmStatus vocabulary. */
function mapStatus(raw: unknown): string {
  const s = String(raw || "").toLowerCase();
  if (!s) return "nurture";
  if (s.includes("new")) return "new";
  if (s.includes("hot")) return "hot";
  if (s.includes("nurture") || s.includes("warm")) return "nurture";
  if (s.includes("watch") || s.includes("cold") || s.includes("inactive")) return "watch";
  if (s.includes("past") || s.includes("client") || s.includes("closed")) return "watch";
  if (s.includes("trash") || s.includes("archiv") || s.includes("unqualified") || s.includes("dead")) return "dead";
  return "nurture";
}

/** Brivity stage strings → the CRM's crmStage vocabulary. */
function mapStage(raw: unknown): string {
  const s = String(raw || "").toLowerCase().replace(/[\s-]+/g, "_");
  const known = ["new", "hot", "warm", "cold", "pending", "appointment_set", "showing_set", "under_contract", "closed"];
  if (known.includes(s)) return s;
  if (s.includes("appointment")) return "appointment_set";
  if (s.includes("showing")) return "showing_set";
  if (s.includes("contract")) return "under_contract";
  if (s.includes("close")) return "closed";
  if (s.includes("pend")) return "pending";
  if (s.includes("hot")) return "hot";
  return "new";
}

function personToRow(p: BrivityPerson): BrivityLeadRow | null {
  const name = `${(p.first_name || "").trim()} ${(p.last_name || "").trim()}`.trim();
  const phone = (p.phone_number || "").trim() || null;
  const email = (p.email_address || "").trim() || null;
  if (!name && !phone && !email) return null;
  const address = [p.street_address, p.city, p.locality].map((x) => (x || "").trim()).filter(Boolean).join(", ");
  return {
    id: `brivity-${p.id ?? `${name}-${phone || email || ""}`}`,
    brivityId: String(p.id ?? ""),
    platform: "brivity",
    name: name || "Unknown",
    username: null,
    phone,
    email,
    source: (p.source || "").trim() || "Brivity CRM",
    crmStatus: mapStatus(p.status),
    crmStage: mapStage(p.stage),
    crmIntent: String(p.lead_type || "").toLowerCase().includes("sell") ? "seller" : "buyer",
    crmPriority: null,
    crmCallQueue: null,
    crmNotes: (p.description || "").trim() || null,
    propertyInquired: null,
    criteria: address ? { location: address } : {},
    tags: Array.isArray(p.tags) ? (p.tags as unknown[]).map(String) : [],
    alerts: 0,
    reports: 0,
    createdAt: p.created_at || null,
    updatedAt: p.updated_at || null,
    lastActivity: p.updated_at || p.created_at || null,
    lastMessageAt: null,
    messages: [],
    activity: [],
    autoPlanEnrollments: [],
  };
}

async function fetchFromBrivity(): Promise<BrivityLeadRow[]> {
  const key = apiKey();
  if (!key) throw new Error("BRIVITY_API_KEY not set");
  const res = await fetch(`${CORE_BASE}/api/people?limit=${FETCH_LIMIT}`, {
    headers: { Authorization: `Token token=${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
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
  // Newest activity first so the CRM's default sort reads naturally.
  rows.sort((a, b) => String(b.lastActivity || "").localeCompare(String(a.lastActivity || "")));
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
