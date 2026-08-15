/**
 * Building a Market Report: the comp set, the neighbourhood numbers, and the
 * home-value estimate.
 *
 * SMART RADIUS, HONESTLY. Brivity's key mechanic widens a geographic radius
 * until the comp set clears 15 listings, so a rural or thin address never
 * produces a report showing "2 nearby listings" and looking broken. That exact
 * mechanic cannot be built here: every record in the SABOR mirror has
 * `geo.lat === null`, so there is no coordinate to measure a radius from.
 *
 * What IS available is the place hierarchy the feed populates on every listing:
 * postal code → city → county → the whole board. So the same idea is
 * implemented as a widening ladder over places rather than distance, with the
 * identical stopping rule (a floor of 15) and — importantly — the report says
 * which rung it ended on. An agent reading "widened to Bexar County to reach 18
 * comparables" knows exactly how local the number is; a silent radius does not
 * tell them that.
 *
 * THE VALUE ESTIMATE IS NOT AN AVM. There is no automated valuation model here
 * and pretending otherwise would put a fabricated number in front of a
 * homeowner. It is a comparable-based arithmetic estimate: the median price per
 * square foot of the comp set multiplied by the home's own square footage, with
 * a low/high band from the quartiles. That requires knowing the home's size —
 * so with no square footage on file there is NO estimate, and the report says
 * what is missing instead of guessing. The agent can override the arithmetic
 * with their own number, which is what the Adjusted Est. field is for.
 */
import { getListingsDb } from "./listingsStore.js";
import {
  buildCriteriaSql,
  findMatching,
  statsFor,
  type CriteriaStats,
  type ListingCriteria,
} from "./listingCriteria.js";
import type { Listing } from "./listingsStore.js";

/** Brivity's floor, kept deliberately: below this the numbers are anecdote. */
export const COMP_FLOOR = 15;

export type AreaRung = "postal" | "city" | "county" | "board";

export interface AreaResolution {
  rung: AreaRung;
  label: string;
  criteria: ListingCriteria;
  count: number;
  /** True when even the widest rung could not reach the floor. */
  belowFloor: boolean;
  /** Every rung tried, for the "why is this so wide?" question. */
  ladder: Array<{ rung: AreaRung; label: string; count: number }>;
}

/** City and county for a postal code, learned from the listings themselves. */
export function placeForPostal(postalCode: string): { city: string | null; county: string | null } {
  const row = getListingsDb()
    .prepare(
      `SELECT city, json_extract(raw,'$.geo.county') county FROM listings
       WHERE postal_code = ? AND city IS NOT NULL
       GROUP BY city ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get(String(postalCode).trim()) as { city: string | null; county: string | null } | undefined;
  return { city: row?.city ?? null, county: row?.county ?? null };
}

export function placeForCity(city: string): { county: string | null } {
  const row = getListingsDb()
    .prepare(
      `SELECT json_extract(raw,'$.geo.county') county FROM listings
       WHERE LOWER(city) = LOWER(?) AND county IS NOT NULL
       GROUP BY county ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get(String(city).trim()) as { county: string | null } | undefined;
  return { county: row?.county ?? null };
}

function countWith(base: ListingCriteria, area: Partial<ListingCriteria>): number {
  const merged: ListingCriteria = {
    ...base,
    cities: undefined, postalCodes: undefined, counties: undefined,
    schoolDistricts: undefined, subdivisions: undefined,
    ...area,
  };
  const { where, params } = buildCriteriaSql(merged);
  const row = getListingsDb().prepare(`SELECT COUNT(*) n FROM listings ${where}`).get(params) as { n: number };
  return Number(row?.n || 0);
}

/**
 * Widen the area until the comp floor clears.
 *
 * `anchor` is whatever the agent typed: a postal code, or a city name. The
 * ladder starts at the tightest rung that anchor supports and stops at the
 * first one that reaches COMP_FLOOR.
 */
export function resolveArea(
  anchor: { postalCode?: string | null; city?: string | null; county?: string | null },
  base: ListingCriteria,
): AreaResolution {
  const ladder: Array<{ rung: AreaRung; label: string; count: number; criteria: Partial<ListingCriteria> }> = [];

  const postal = anchor.postalCode?.trim() || null;
  let city = anchor.city?.trim() || null;
  let county = anchor.county?.trim() || null;
  if (postal && (!city || !county)) {
    const p = placeForPostal(postal);
    city = city || p.city;
    county = county || p.county;
  }
  if (city && !county) county = placeForCity(city).county;

  if (postal) ladder.push({ rung: "postal", label: postal, count: 0, criteria: { postalCodes: [postal] } });
  if (city) ladder.push({ rung: "city", label: city, count: 0, criteria: { cities: [city] } });
  if (county) ladder.push({ rung: "county", label: `${county} County`, count: 0, criteria: { counties: [county] } });
  ladder.push({ rung: "board", label: "the whole board", count: 0, criteria: {} });

  for (const step of ladder) step.count = countWith(base, step.criteria);

  const chosen = ladder.find((s) => s.count >= COMP_FLOOR) ?? ladder[ladder.length - 1];
  return {
    rung: chosen.rung,
    label: chosen.label,
    criteria: {
      ...base,
      cities: undefined, postalCodes: undefined, counties: undefined,
      schoolDistricts: undefined, subdivisions: undefined,
      ...chosen.criteria,
    },
    count: chosen.count,
    belowFloor: chosen.count < COMP_FLOOR,
    ladder: ladder.map((s) => ({ rung: s.rung, label: s.label, count: s.count })),
  };
}

export interface ValueEstimate {
  /** Null when the home's square footage is unknown — never a guessed number. */
  estimate: number | null;
  low: number | null;
  high: number | null;
  medianPricePerSqft: number | null;
  compCount: number;
  /** Plain-English account of how the number was reached, or why there isn't one. */
  basis: string;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Price-per-square-foot distribution of the comp set. */
export function pricePerSqftSeries(criteria: ListingCriteria): number[] {
  const { where, params } = buildCriteriaSql(criteria);
  const clause = where ? `${where} AND living_area > 0 AND list_price > 0` : `WHERE living_area > 0 AND list_price > 0`;
  const rows = getListingsDb()
    .prepare(`SELECT list_price * 1.0 / living_area ppsf FROM listings ${clause}`)
    .all(params) as { ppsf: number }[];
  return rows.map((r) => Number(r.ppsf)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
}

export function estimateValue(
  criteria: ListingCriteria,
  subject: { sqft?: number; beds?: number; baths?: number },
  areaLabel: string,
): ValueEstimate {
  const series = pricePerSqftSeries(criteria);
  const median = percentile(series, 0.5);
  const sqft = Number(subject?.sqft);

  if (!series.length) {
    return {
      estimate: null, low: null, high: null, medianPricePerSqft: null, compCount: 0,
      basis: `No comparable listings with both a price and a square footage in ${areaLabel}, so no estimate can be calculated.`,
    };
  }
  if (!Number.isFinite(sqft) || sqft <= 0) {
    return {
      estimate: null, low: null, high: null,
      medianPricePerSqft: median ? Math.round(median) : null,
      compCount: series.length,
      basis:
        `Comparable listings in ${areaLabel} are running about $${Math.round(median || 0)}/sqft, ` +
        `but this home's square footage is not on file — add it to calculate an estimated value.`,
    };
  }
  const q1 = percentile(series, 0.25) ?? median!;
  const q3 = percentile(series, 0.75) ?? median!;
  return {
    estimate: Math.round((median || 0) * sqft),
    low: Math.round(q1 * sqft),
    high: Math.round(q3 * sqft),
    medianPricePerSqft: Math.round(median || 0),
    compCount: series.length,
    basis:
      `${series.length} comparable listing${series.length === 1 ? "" : "s"} in ${areaLabel} at a median of ` +
      `$${Math.round(median || 0)}/sqft × ${sqft.toLocaleString()} sqft. ` +
      `The range is the middle half of those comparables. This is arithmetic from live listings, not an appraisal.`,
  };
}

export interface BuiltReport {
  area: AreaResolution;
  stats: CriteriaStats;
  /** Counts by status inside the resolved area — the map-overlay numbers. */
  byStatus: Array<{ status: string; count: number }>;
  value: ValueEstimate;
  /** The agent's override, when set — this is what the client sees. */
  displayValue: number | null;
  adjusted: boolean;
  comps: Listing[];
  builtAt: string;
  notes: string[];
}

/**
 * Assemble everything a Market Report shows. Pure read — sends nothing.
 */
export function buildMarketReport(input: {
  criteria: ListingCriteria;
  anchor: { postalCode?: string | null; city?: string | null; county?: string | null };
  subject?: { sqft?: number; beds?: number; baths?: number };
  adjustedValue?: number | null;
  compLimit?: number;
}): BuiltReport {
  const area = resolveArea(input.anchor, input.criteria);
  const stats = statsFor(area.criteria);
  const { where, params } = buildCriteriaSql({ ...area.criteria, statuses: ["Active", "Pending"] });
  const byStatus = (
    getListingsDb().prepare(`SELECT status, COUNT(*) n FROM listings ${where} GROUP BY status ORDER BY n DESC`).all(params) as
      Record<string, unknown>[]
  ).map((r) => ({ status: String(r.status ?? "Unknown"), count: Number(r.n) }));

  const value = estimateValue(area.criteria, input.subject ?? {}, area.label);
  const adjusted = typeof input.adjustedValue === "number" && Number.isFinite(input.adjustedValue);

  const notes: string[] = [];
  if (area.rung !== "postal" && area.ladder[0]?.rung === "postal") {
    notes.push(
      `Widened from ${area.ladder[0].label} (${area.ladder[0].count} listing${area.ladder[0].count === 1 ? "" : "s"}) ` +
      `to ${area.label} to reach at least ${COMP_FLOOR} comparables.`,
    );
  }
  if (area.belowFloor) {
    notes.push(
      `Only ${area.count} listing${area.count === 1 ? "" : "s"} match even at the widest area — ` +
      `below the ${COMP_FLOOR}-comparable floor, so treat these numbers as indicative rather than firm.`,
    );
  }
  if (!byStatus.some((s) => /sold|closed/i.test(s.status))) {
    notes.push("Built from listings on the market now. The feed mirror does not carry sold records, so no closed comparables are included.");
  }

  return {
    area, stats, byStatus, value,
    displayValue: adjusted ? Number(input.adjustedValue) : value.estimate,
    adjusted,
    comps: findMatching(area.criteria, Math.min(Math.max(1, input.compLimit ?? 12), 60)),
    builtAt: new Date().toISOString(),
    notes,
  };
}

/** Pull a postal code out of a free-typed address, if there is one. */
export function postalFromAddress(address: string): string | null {
  const m = /\b(\d{5})(?:-\d{4})?\b/.exec(String(address || ""));
  return m ? m[1] : null;
}

/**
 * City from a free-typed address, matched against cities the board actually
 * covers so "San Antonio, TX 78245" resolves and "Somewhere, TX" does not.
 * Longest name first: "New Braunfels" must beat "Braunfels".
 */
export function cityFromAddress(address: string): string | null {
  const hay = String(address || "").toLowerCase();
  const rows = getListingsDb()
    .prepare(`SELECT city, COUNT(*) n FROM listings WHERE city IS NOT NULL GROUP BY LOWER(city) ORDER BY LENGTH(city) DESC`)
    .all() as { city: string }[];
  for (const r of rows) {
    if (hay.includes(String(r.city).toLowerCase())) return r.city;
  }
  return null;
}
