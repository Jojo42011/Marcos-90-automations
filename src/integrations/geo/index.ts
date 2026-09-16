/**
 * Address autocomplete and geocoding.
 *
 * SHIPS DORMANT. With no key set, every function here reports
 * `configured: false` and returns NOTHING. It never guesses an address and
 * never returns a placeholder suggestion: a CRM that offers "123 Main Street"
 * because it could not reach a provider would have someone save it, and a
 * wrong address on a contact is worse than an empty one. The UI reads
 * `configured` and simply stays a plain text box.
 *
 * PROXIED THROUGH THIS SERVER, deliberately, rather than calling the provider
 * from the browser. Two reasons and both matter: the key stays server-side
 * instead of being readable in page source by anyone who opens the CRM, and
 * the CRM page is served under a strict origin where an extra third-party
 * script is a liability rather than a convenience.
 *
 * WHAT THIS DOES AND DOES NOT UNLOCK. Setting the key turns on address
 * autocomplete everywhere an address is typed — which is Marco's actual ask.
 * It does NOT by itself put a map on the CMA or the market report. Those need
 * coordinates on the LISTINGS, and `geo.lat` is null on all ~32k rows of the
 * SABOR mirror; that is a geocoding backfill with real per-row cost, and a
 * separate decision. `geocodeAddress` is here so that backfill has something to
 * call when it is decided on, not because it is wired to anything yet.
 */

const PLACES_AUTOCOMPLETE = "https://places.googleapis.com/v1/places:autocomplete";
const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const TIMEOUT_MS = 6000;

/** The one key. Named for the job, not the vendor, so a swap is a code change here only. */
function apiKey(): string {
  return (process.env.MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "").trim();
}

export function isGeoConfigured(): boolean {
  return Boolean(apiKey());
}

/** Bias suggestions to Marco's market without excluding anywhere else. */
function regionBias(): { includedRegionCodes: string[] } {
  return { includedRegionCodes: ["us"] };
}

export interface AddressSuggestion {
  /** What to show in the dropdown, e.g. "123 Rockcress Rd, San Antonio, TX, USA". */
  description: string;
  /** Provider id, kept so a later step can fetch full details or coordinates. */
  placeId: string | null;
  /** The street line alone, when the provider separates it. */
  mainText: string | null;
  /** City / state / country tail, when the provider separates it. */
  secondaryText: string | null;
}

export interface AutocompleteResult {
  ok: boolean;
  configured: boolean;
  suggestions: AddressSuggestion[];
  error?: string;
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Suggest addresses for a partial string, as the operator types.
 *
 * Returns an empty list rather than an error for a query too short to be worth
 * a call — typing one character is not a failure, and a red state under an
 * input someone is still filling in is noise.
 */
export async function autocompleteAddress(query: string): Promise<AutocompleteResult> {
  const key = apiKey();
  if (!key) {
    return { ok: false, configured: false, suggestions: [], error: "No maps key is configured" };
  }
  const q = (query || "").trim();
  if (q.length < 3) return { ok: true, configured: true, suggestions: [] };

  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(PLACES_AUTOCOMPLETE, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
        body: JSON.stringify({
          input: q,
          /* Addresses, not businesses or landmarks. Someone typing into a
             contact's address field wants a place to send mail. */
          includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
          ...regionBias(),
        }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          ok: false,
          configured: true,
          suggestions: [],
          error: `Maps provider returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        };
      }
      const data = (await res.json()) as {
        suggestions?: Array<{
          placePrediction?: {
            placeId?: string;
            text?: { text?: string };
            structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
          };
        }>;
      };
      const rows = Array.isArray(data.suggestions) ? data.suggestions : [];
      const suggestions: AddressSuggestion[] = [];
      for (const r of rows) {
        const p = r.placePrediction;
        const description = p?.text?.text?.trim();
        if (!description) continue;
        suggestions.push({
          description,
          placeId: p?.placeId?.trim() || null,
          mainText: p?.structuredFormat?.mainText?.text?.trim() || null,
          secondaryText: p?.structuredFormat?.secondaryText?.text?.trim() || null,
        });
      }
      return { ok: true, configured: true, suggestions };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      configured: true,
      suggestions: [],
      error: /abort/i.test(msg) ? `Maps provider timed out after ${TIMEOUT_MS / 1000}s` : msg,
    };
  }
}

export interface GeocodeResult {
  ok: boolean;
  configured: boolean;
  lat: number | null;
  lng: number | null;
  formatted: string | null;
  error?: string;
}

/**
 * One address to coordinates.
 *
 * Nothing calls this yet, and that is stated rather than implied: it exists so
 * the MLS geocoding backfill has something to call if that is decided on. A map
 * on the CMA or the market report needs coordinates on the listings, and every
 * row of the mirror has `geo.lat === null`.
 */
export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const key = apiKey();
  if (!key) {
    return { ok: false, configured: false, lat: null, lng: null, formatted: null, error: "No maps key is configured" };
  }
  const q = (address || "").trim();
  if (!q) return { ok: false, configured: true, lat: null, lng: null, formatted: null, error: "No address given" };

  try {
    return await withTimeout(async (signal) => {
      const url = `${GEOCODE}?address=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
      const res = await fetch(url, { signal });
      if (!res.ok) {
        return { ok: false, configured: true, lat: null, lng: null, formatted: null, error: `Geocoder returned ${res.status}` };
      }
      const data = (await res.json()) as {
        status?: string;
        results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }>;
      };
      const hit = data.results?.[0];
      const lat = hit?.geometry?.location?.lat;
      const lng = hit?.geometry?.location?.lng;
      if (data.status !== "OK" || typeof lat !== "number" || typeof lng !== "number") {
        /* No match is not an error, and must not become a (0,0) coordinate —
           which is a real place in the Atlantic. */
        return { ok: true, configured: true, lat: null, lng: null, formatted: null, error: data.status || "No match" };
      }
      return { ok: true, configured: true, lat, lng, formatted: hit?.formatted_address?.trim() || null };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      configured: true,
      lat: null,
      lng: null,
      formatted: null,
      error: /abort/i.test(msg) ? `Geocoder timed out after ${TIMEOUT_MS / 1000}s` : msg,
    };
  }
}
