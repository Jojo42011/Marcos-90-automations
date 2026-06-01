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

export function adsTotalsToHarveySnapshot(
  raw: AdsUpstreamSummary | null,
  configured: boolean,
): import("./types.js").HarveyAdsSnapshot {
  if (!raw || !configured) {
    return {
      configured: false,
      generatedAt: null,
      datePreset: null,
      spend: null,
      impressions: null,
      clicks: null,
      adLeads: null,
      ctr: null,
      cpl: null,
      campaignCount: 0,
      adsetCount: 0,
    };
  }
  const t = raw.totals;
  const num = (k: string) => {
    const v = t[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  return {
    configured: true,
    generatedAt: raw.generatedAt,
    datePreset: raw.datePreset,
    spend: num("spend"),
    impressions: num("impressions"),
    clicks: num("clicks"),
    adLeads: num("leads"),
    ctr: num("ctr"),
    cpl: num("cpl"),
    campaignCount: raw.campaigns.length,
    adsetCount: raw.adsets.length,
  };
}
