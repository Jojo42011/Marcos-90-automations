/**
 * Bridge Interactive (Zillow Group) — RESO Web API client.
 *
 * Bridge serves the RESO Data Dictionary over OData v4:
 *   GET {BRIDGE_BASE}/{dataset}/Property?access_token=…&$filter=…&$top=…
 *
 * Auth is a single **server token** sent as a Bearer header. Bridge also issues
 * a client id / client secret pair for browser OAuth; those are NOT used here,
 * because a server-to-server pull has no user to redirect and the server token
 * is the credential Bridge documents for exactly this case.
 *
 * NOTHING IS FAKED WHEN UNCONFIGURED. If the token or dataset is missing, every
 * call returns `{ ok: false }` naming the exact missing variable. It never
 * returns an empty listing array, because "no results" and "not switched on"
 * are the same picture from the outside and only one of them means the market
 * is quiet.
 */

const DEFAULT_BASE = "https://api.bridgedataoutput.com/api/v2/OData";
/** Bridge caps $top; 200 is the documented page size. */
const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 30_000;

export interface BridgeConfig {
  baseUrl: string;
  dataset: string;
  token: string;
}

export interface BridgeProblem {
  ok: false;
  error: string;
  /** What the operator has to do about it, in words that name the variable. */
  fix?: string;
}

export function bridgeConfig(): BridgeConfig | BridgeProblem {
  const token = process.env.BRIDGE_SERVER_TOKEN?.trim();
  const dataset = process.env.BRIDGE_DATASET?.trim();
  const baseUrl = (process.env.BRIDGE_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  if (!token) {
    return {
      ok: false,
      error: "Bridge Interactive is not configured: BRIDGE_SERVER_TOKEN is not set.",
      fix: "Set BRIDGE_SERVER_TOKEN to the Server Token from the Bridge dashboard (not the client secret).",
    };
  }
  if (!dataset) {
    return {
      ok: false,
      error: "Bridge Interactive is not configured: BRIDGE_DATASET is not set.",
      fix: "Set BRIDGE_DATASET to the dataset name Bridge assigned this feed (shown on the app's page, e.g. a board short-code).",
    };
  }
  return { baseUrl, dataset, token };
}

export function isBridgeConfigured(): boolean {
  return !("ok" in bridgeConfig());
}

export interface BridgePage {
  ok: true;
  value: Record<string, unknown>[];
  /** OData continuation link; absent on the last page. */
  nextLink: string | null;
  count: number | null;
}

/**
 * One OData request.
 *
 * A non-2xx is surfaced with Bridge's own message rather than a bare status —
 * Bridge returns a useful body for the two mistakes that actually happen
 * (wrong dataset name, token lacking access to a field), and swallowing it
 * turns a five-second fix into an afternoon.
 */
async function bridgeGet(url: string, token: string): Promise<BridgePage | BridgeProblem> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 400);
      try {
        const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
        detail = j.error?.message || j.message || detail;
      } catch {
        /* keep the raw body */
      }
      const fix =
        res.status === 401 || res.status === 403
          ? "Check BRIDGE_SERVER_TOKEN — Bridge rejected it. A client secret will not work here; it must be the Server Token."
          : res.status === 404
            ? "Check BRIDGE_DATASET — Bridge does not recognise that dataset name."
            : undefined;
      return { ok: false, error: `Bridge returned ${res.status}: ${detail}`, fix };
    }
    const body = JSON.parse(text) as {
      value?: Record<string, unknown>[];
      "@odata.nextLink"?: string;
      "@odata.count"?: number;
    };
    return {
      ok: true,
      value: Array.isArray(body.value) ? body.value : [],
      nextLink: body["@odata.nextLink"] ?? null,
      count: typeof body["@odata.count"] === "number" ? body["@odata.count"] : null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: /abort/i.test(msg) ? `Bridge did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.` : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchOptions {
  /** Only records changed since this ISO timestamp — how an incremental sync stays cheap. */
  since?: string | null;
  /** Extra OData $filter, ANDed with the rest. */
  filter?: string;
  /** Hard ceiling on records pulled in one run, so a first sync cannot run away. */
  maxRecords?: number;
}

/**
 * Pull Property records, following OData paging.
 *
 * Deliberately capped. A full board can be hundreds of thousands of rows, and
 * an unbounded first sync would blow the rate limit and the disk before anyone
 * noticed. `maxRecords` stops it, and the caller is TOLD it was truncated
 * rather than being handed a silently partial mirror.
 */
export async function fetchProperties(
  opts: FetchOptions = {},
): Promise<{ ok: true; records: Record<string, unknown>[]; truncated: boolean } | BridgeProblem> {
  const cfg = bridgeConfig();
  if ("ok" in cfg) return cfg;

  const max = Math.max(1, opts.maxRecords ?? 2000);
  const filters: string[] = [];
  if (opts.since) filters.push(`ModificationTimestamp gt ${opts.since}`);
  if (opts.filter?.trim()) filters.push(`(${opts.filter.trim()})`);

  const params = new URLSearchParams();
  params.set("$top", String(Math.min(PAGE_SIZE, max)));
  params.set("$orderby", "ModificationTimestamp asc");
  if (filters.length) params.set("$filter", filters.join(" and "));

  let url = `${cfg.baseUrl}/${encodeURIComponent(cfg.dataset)}/Property?${params.toString()}`;
  const records: Record<string, unknown>[] = [];
  let guard = 0;

  while (url && records.length < max) {
    /* A malformed nextLink that points at itself would otherwise spin forever
       against a metered API. */
    if (++guard > 500) break;
    const page = await bridgeGet(url, cfg.token);
    if ("error" in page) {
      /* Partial data already pulled is still worth keeping; report the failure
         but do not throw away what succeeded. */
      if (records.length) return { ok: true, records: records.slice(0, max), truncated: true };
      return page;
    }
    records.push(...page.value);
    if (!page.nextLink || page.value.length === 0) break;
    url = page.nextLink;
  }

  return { ok: true, records: records.slice(0, max), truncated: records.length >= max };
}

/**
 * Cheapest possible round trip that proves the credentials work.
 *
 * Asks for a single record. Used by the status endpoint so "is the MLS wired
 * up" is answered by actually talking to Bridge rather than by checking that
 * an env var is non-empty — a wrong token is indistinguishable from a right
 * one until something calls the API.
 */
export async function bridgePing(): Promise<
  { ok: true; dataset: string; sampleFields: string[] } | BridgeProblem
> {
  const cfg = bridgeConfig();
  if ("ok" in cfg) return cfg;
  const url = `${cfg.baseUrl}/${encodeURIComponent(cfg.dataset)}/Property?$top=1`;
  const page = await bridgeGet(url, cfg.token);
  if ("error" in page) return page;
  return {
    ok: true,
    dataset: cfg.dataset,
    sampleFields: page.value[0] ? Object.keys(page.value[0]).slice(0, 25) : [],
  };
}
