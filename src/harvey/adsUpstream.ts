/**
 * Meta ads Flask proxy — shared by Harvey perception and GET /api/ads/summary.
 */

type AdsLatestRow = {
  generated_at?: string;
  date_preset?: string;
  totals?: Record<string, unknown>;
  campaigns?: unknown[];
  adsets?: unknown[];
  error?: string;
};

export type AdsUpstreamSummary = {
  generatedAt: string | null;
  datePreset: string | null;
  totals: Record<string, number | string | null | undefined>;
  campaigns: unknown[];
  adsets: unknown[];
};

export async function fetchAdsSummaryFromUpstream(
  baseUrl: string,
  apiKey?: string,
): Promise<AdsUpstreamSummary> {
  if (!baseUrl.trim()) {
    throw new Error("AD_DASHBOARD_BASE_URL is not set");
  }
  const url = `${baseUrl.replace(/\/$/, "")}/api/latest`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  const upstream = await fetch(url, { headers });
  const raw = (await upstream.json().catch(() => ({}))) as AdsLatestRow;
  if (!upstream.ok) {
    const msg =
      typeof raw.error === "string"
        ? raw.error
        : `Upstream ${upstream.status} ${upstream.statusText}`;
    throw new Error(msg);
  }
  if (typeof raw.error === "string") {
    throw new Error(raw.error);
  }
  const totals =
    raw.totals && typeof raw.totals === "object"
      ? (raw.totals as Record<string, number | string | null | undefined>)
      : {};
  const campaigns = Array.isArray(raw.campaigns) ? raw.campaigns : [];
  const adsets = Array.isArray(raw.adsets) ? raw.adsets : [];
  return {
    generatedAt: raw.generated_at ?? null,
    datePreset: raw.date_preset ?? null,
    totals,
    campaigns: campaigns.slice(0, 80),
    adsets: adsets.slice(0, 120),
  };
}
