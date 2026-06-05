"use strict";
/**
 * FOREWARN INTEGRATION
 *
 * Forewarn is a real estate skip tracing service used by agents to look up
 * contact and property ownership data by phone number.
 *
 * To enable real lookups:
 * 1. Sign up at https://www.forewarn.com
 * 2. Get your API key from the Forewarn dashboard
 * 3. Set FOREWARN_API_KEY in Fly secrets: fly secrets set FOREWARN_API_KEY=your-key
 * 4. Update the API call below with the correct Forewarn endpoint and auth headers
 *    once you have API documentation from Forewarn support
 *
 * Until FOREWARN_API_KEY is set, all skip traces return mock data so the UI
 * is fully functional for testing and demonstration.
 *
 * Alternative services to consider if Forewarn API is unavailable:
 * - BatchSkipTracing (batchskiptracing.com) — bulk CSV upload model
 * - Spokeo API (spokeo.com/developer)
 * - WhitePages Pro API (proapi.whitepages.com)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSkipTrace = runSkipTrace;
function nowIso() {
    return new Date().toISOString();
}
function mockSkipTraceResult() {
    return {
        runAt: nowIso(),
        source: "mock",
        foundName: "John Demo",
        foundEmail: "johndemo@example.com",
        foundAddress: "123 Demo Street, San Antonio TX 78201",
        propertyOwnership: [
            {
                address: "123 Demo Street, San Antonio TX 78201",
                owner: "John Demo",
                estimatedValue: 285000,
                lastSaleDate: "2019-03-15",
                lastSalePrice: 240000,
            },
        ],
        additionalPhones: [],
        confidence: "high",
    };
}
async function forewarnApiLookup(phone, apiKey) {
    const url = process.env.FOREWARN_API_URL?.trim() || "https://api.forewarn.com/v1/lookup";
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ phone }),
    });
    if (!res.ok) {
        throw new Error(`Forewarn HTTP ${res.status}`);
    }
    const data = (await res.json());
    return {
        runAt: nowIso(),
        source: "forewarn",
        foundName: typeof data.name === "string" ? data.name : undefined,
        foundEmail: typeof data.email === "string" ? data.email : undefined,
        foundAddress: typeof data.address === "string" ? data.address : undefined,
        confidence: "medium",
        raw: data,
    };
}
/** Run skip trace for a US phone number. */
async function runSkipTrace(phone) {
    const digits = phone.replace(/\D/g, "");
    if (!digits || digits.length < 10) {
        return { runAt: nowIso(), source: "forewarn", confidence: "low" };
    }
    const apiKey = process.env.FOREWARN_API_KEY?.trim();
    if (!apiKey) {
        return mockSkipTraceResult();
    }
    try {
        return await forewarnApiLookup(phone, apiKey);
    }
    catch (err) {
        console.error("[forewarn] lookup failed:", err);
        return { runAt: nowIso(), source: "forewarn", confidence: "low" };
    }
}
