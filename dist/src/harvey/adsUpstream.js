"use strict";
/**
 * Meta ads Flask proxy — shared by Harvey perception and GET /api/ads/summary.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAdsSummaryFromUpstream = fetchAdsSummaryFromUpstream;
async function fetchAdsSummaryFromUpstream(baseUrl, apiKey) {
    if (!baseUrl.trim()) {
        throw new Error("AD_DASHBOARD_BASE_URL is not set");
    }
    const url = `${baseUrl.replace(/\/$/, "")}/api/latest`;
    const headers = { Accept: "application/json" };
    if (apiKey?.trim()) {
        headers.Authorization = `Bearer ${apiKey.trim()}`;
    }
    const upstream = await fetch(url, { headers });
    const raw = (await upstream.json().catch(() => ({})));
    if (!upstream.ok) {
        const msg = typeof raw.error === "string"
            ? raw.error
            : `Upstream ${upstream.status} ${upstream.statusText}`;
        throw new Error(msg);
    }
    if (typeof raw.error === "string") {
        throw new Error(raw.error);
    }
    const totals = raw.totals && typeof raw.totals === "object"
        ? raw.totals
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
