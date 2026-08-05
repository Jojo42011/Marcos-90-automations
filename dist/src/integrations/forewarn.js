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
/**
 * There used to be a mock here that returned "John Demo, 123 Demo Street,
 * San Antonio" with confidence "high" whenever no provider was configured —
 * live, in production, indistinguishable from a real lookup. A CRM that
 * invents a contact's identity is worse than one that says it doesn't know,
 * so the unconfigured case now says exactly that and finds nothing.
 *
 * Note before wiring a real provider: Forewarn's subscriber terms prohibit
 * filing its Information into third-party systems ("used by Subscriber
 * only"), so automated lookups feeding this CRM need an idiCORE (Red Violet)
 * contract, not a Forewarn key. The honest in-terms flow is a one-click
 * manual lookup in Forewarn's own app.
 */
function notConfiguredResult() {
    return {
        runAt: nowIso(),
        source: "not-configured",
        confidence: "low",
        note: "No lookup ran — no skip-trace provider is configured. Look the number up in Forewarn directly; results cannot be fabricated here.",
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
        return notConfiguredResult();
    }
    try {
        return await forewarnApiLookup(phone, apiKey);
    }
    catch (err) {
        console.error("[forewarn] lookup failed:", err);
        return { runAt: nowIso(), source: "forewarn", confidence: "low" };
    }
}
