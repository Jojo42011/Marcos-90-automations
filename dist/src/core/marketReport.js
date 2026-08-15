"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMP_FLOOR = void 0;
exports.placeForPostal = placeForPostal;
exports.placeForCity = placeForCity;
exports.resolveArea = resolveArea;
exports.pricePerSqftSeries = pricePerSqftSeries;
exports.estimateValue = estimateValue;
exports.buildMarketReport = buildMarketReport;
exports.postalFromAddress = postalFromAddress;
exports.cityFromAddress = cityFromAddress;
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
const listingsStore_js_1 = require("./listingsStore.js");
const listingCriteria_js_1 = require("./listingCriteria.js");
/** Brivity's floor, kept deliberately: below this the numbers are anecdote. */
exports.COMP_FLOOR = 15;
/** City and county for a postal code, learned from the listings themselves. */
function placeForPostal(postalCode) {
    const row = (0, listingsStore_js_1.getListingsDb)()
        .prepare(`SELECT city, json_extract(raw,'$.geo.county') county FROM listings
       WHERE postal_code = ? AND city IS NOT NULL
       GROUP BY city ORDER BY COUNT(*) DESC LIMIT 1`)
        .get(String(postalCode).trim());
    return { city: row?.city ?? null, county: row?.county ?? null };
}
function placeForCity(city) {
    const row = (0, listingsStore_js_1.getListingsDb)()
        .prepare(`SELECT json_extract(raw,'$.geo.county') county FROM listings
       WHERE LOWER(city) = LOWER(?) AND county IS NOT NULL
       GROUP BY county ORDER BY COUNT(*) DESC LIMIT 1`)
        .get(String(city).trim());
    return { county: row?.county ?? null };
}
function countWith(base, area) {
    const merged = {
        ...base,
        cities: undefined, postalCodes: undefined, counties: undefined,
        schoolDistricts: undefined, subdivisions: undefined,
        ...area,
    };
    const { where, params } = (0, listingCriteria_js_1.buildCriteriaSql)(merged);
    const row = (0, listingsStore_js_1.getListingsDb)().prepare(`SELECT COUNT(*) n FROM listings ${where}`).get(params);
    return Number(row?.n || 0);
}
/**
 * Widen the area until the comp floor clears.
 *
 * `anchor` is whatever the agent typed: a postal code, or a city name. The
 * ladder starts at the tightest rung that anchor supports and stops at the
 * first one that reaches COMP_FLOOR.
 */
function resolveArea(anchor, base) {
    const ladder = [];
    const postal = anchor.postalCode?.trim() || null;
    let city = anchor.city?.trim() || null;
    let county = anchor.county?.trim() || null;
    if (postal && (!city || !county)) {
        const p = placeForPostal(postal);
        city = city || p.city;
        county = county || p.county;
    }
    if (city && !county)
        county = placeForCity(city).county;
    if (postal)
        ladder.push({ rung: "postal", label: postal, count: 0, criteria: { postalCodes: [postal] } });
    if (city)
        ladder.push({ rung: "city", label: city, count: 0, criteria: { cities: [city] } });
    if (county)
        ladder.push({ rung: "county", label: `${county} County`, count: 0, criteria: { counties: [county] } });
    ladder.push({ rung: "board", label: "the whole board", count: 0, criteria: {} });
    for (const step of ladder)
        step.count = countWith(base, step.criteria);
    const chosen = ladder.find((s) => s.count >= exports.COMP_FLOOR) ?? ladder[ladder.length - 1];
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
        belowFloor: chosen.count < exports.COMP_FLOOR,
        ladder: ladder.map((s) => ({ rung: s.rung, label: s.label, count: s.count })),
    };
}
function percentile(sorted, p) {
    if (!sorted.length)
        return null;
    const i = (sorted.length - 1) * p;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
/** Price-per-square-foot distribution of the comp set. */
function pricePerSqftSeries(criteria) {
    const { where, params } = (0, listingCriteria_js_1.buildCriteriaSql)(criteria);
    const clause = where ? `${where} AND living_area > 0 AND list_price > 0` : `WHERE living_area > 0 AND list_price > 0`;
    const rows = (0, listingsStore_js_1.getListingsDb)()
        .prepare(`SELECT list_price * 1.0 / living_area ppsf FROM listings ${clause}`)
        .all(params);
    return rows.map((r) => Number(r.ppsf)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
}
function estimateValue(criteria, subject, areaLabel) {
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
            basis: `Comparable listings in ${areaLabel} are running about $${Math.round(median || 0)}/sqft, ` +
                `but this home's square footage is not on file — add it to calculate an estimated value.`,
        };
    }
    const q1 = percentile(series, 0.25) ?? median;
    const q3 = percentile(series, 0.75) ?? median;
    return {
        estimate: Math.round((median || 0) * sqft),
        low: Math.round(q1 * sqft),
        high: Math.round(q3 * sqft),
        medianPricePerSqft: Math.round(median || 0),
        compCount: series.length,
        basis: `${series.length} comparable listing${series.length === 1 ? "" : "s"} in ${areaLabel} at a median of ` +
            `$${Math.round(median || 0)}/sqft × ${sqft.toLocaleString()} sqft. ` +
            `The range is the middle half of those comparables. This is arithmetic from live listings, not an appraisal.`,
    };
}
/**
 * Assemble everything a Market Report shows. Pure read — sends nothing.
 */
function buildMarketReport(input) {
    const area = resolveArea(input.anchor, input.criteria);
    const stats = (0, listingCriteria_js_1.statsFor)(area.criteria);
    const { where, params } = (0, listingCriteria_js_1.buildCriteriaSql)({ ...area.criteria, statuses: ["Active", "Pending"] });
    const byStatus = (0, listingsStore_js_1.getListingsDb)().prepare(`SELECT status, COUNT(*) n FROM listings ${where} GROUP BY status ORDER BY n DESC`).all(params).map((r) => ({ status: String(r.status ?? "Unknown"), count: Number(r.n) }));
    const value = estimateValue(area.criteria, input.subject ?? {}, area.label);
    const adjusted = typeof input.adjustedValue === "number" && Number.isFinite(input.adjustedValue);
    const notes = [];
    if (area.rung !== "postal" && area.ladder[0]?.rung === "postal") {
        notes.push(`Widened from ${area.ladder[0].label} (${area.ladder[0].count} listing${area.ladder[0].count === 1 ? "" : "s"}) ` +
            `to ${area.label} to reach at least ${exports.COMP_FLOOR} comparables.`);
    }
    if (area.belowFloor) {
        notes.push(`Only ${area.count} listing${area.count === 1 ? "" : "s"} match even at the widest area — ` +
            `below the ${exports.COMP_FLOOR}-comparable floor, so treat these numbers as indicative rather than firm.`);
    }
    if (!byStatus.some((s) => /sold|closed/i.test(s.status))) {
        notes.push("Built from listings on the market now. The feed mirror does not carry sold records, so no closed comparables are included.");
    }
    return {
        area, stats, byStatus, value,
        displayValue: adjusted ? Number(input.adjustedValue) : value.estimate,
        adjusted,
        comps: (0, listingCriteria_js_1.findMatching)(area.criteria, Math.min(Math.max(1, input.compLimit ?? 12), 60)),
        builtAt: new Date().toISOString(),
        notes,
    };
}
/** Pull a postal code out of a free-typed address, if there is one. */
function postalFromAddress(address) {
    const m = /\b(\d{5})(?:-\d{4})?\b/.exec(String(address || ""));
    return m ? m[1] : null;
}
/**
 * City from a free-typed address, matched against cities the board actually
 * covers so "San Antonio, TX 78245" resolves and "Somewhere, TX" does not.
 * Longest name first: "New Braunfels" must beat "Braunfels".
 */
function cityFromAddress(address) {
    const hay = String(address || "").toLowerCase();
    const rows = (0, listingsStore_js_1.getListingsDb)()
        .prepare(`SELECT city, COUNT(*) n FROM listings WHERE city IS NOT NULL GROUP BY LOWER(city) ORDER BY LENGTH(city) DESC`)
        .all();
    for (const r of rows) {
        if (hay.includes(String(r.city).toLowerCase()))
            return r.city;
    }
    return null;
}
