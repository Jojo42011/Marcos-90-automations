"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMlsFacets = getMlsFacets;
exports.clearFacetCache = clearFacetCache;
/**
 * The real vocabulary of the MLS mirror — every value the board actually uses,
 * counted from the 30k listings themselves.
 *
 * This exists so the alert and report builders can never offer a filter the
 * data cannot answer. Brivity's own form lists checkbox groups SABOR does not
 * publish (Financial Options is the clearest case) and fields it leaves empty;
 * hard-coding that list would produce a form where ticking "VA Loan" silently
 * matches nothing. Instead the UI renders what comes back from here, so a group
 * with no data simply does not appear, and a value that shows up on the board
 * next month appears without a code change.
 *
 * Cached for an hour: these change when a new subdivision is annexed, not
 * between two page loads, and the feature scan reads every row.
 */
const listingsStore_js_1 = require("./listingsStore.js");
let cache = null;
const TTL_MS = 60 * 60 * 1000;
const PROPERTY_TYPE_LABELS = {
    RES: "Residential",
    RNT: "Residential Lease",
    CRE: "Commercial Sale",
    LSE: "Commercial Lease",
    LND: "Vacant Land",
    MUL: "Multi-Family",
    FRM: "Farm/Ranch",
    MOB: "Manufactured Home",
    CND: "Condo/Townhome",
};
/** "SingleFamilyResidence" → "Single Family Residence". */
function spaceCamel(s) {
    return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
}
function topValues(sql, limit) {
    const rows = (0, listingsStore_js_1.getListingsDb)().prepare(sql).all({ lim: limit });
    return rows
        .filter((r) => r.v != null && String(r.v).trim() !== "")
        .map((r) => ({ value: String(r.v), label: String(r.v), count: Number(r.n) }));
}
/**
 * Split the comma-joined feature strings into individual options.
 *
 * Done in JS rather than SQL because SQLite has no split function, and the
 * whole column is only ~30k short strings — one pass is cheaper than the
 * recursive CTE that would be needed to do it in the query.
 */
function featureFacets(jsonPath, minCount) {
    const rows = (0, listingsStore_js_1.getListingsDb)()
        .prepare(`SELECT json_extract(raw, '${jsonPath}') AS v FROM listings WHERE v IS NOT NULL`)
        .all();
    const counts = new Map();
    for (const r of rows) {
        if (typeof r.v !== "string")
            continue;
        for (const part of r.v.split(",")) {
            const f = part.trim();
            if (!f)
                continue;
            counts.set(f, (counts.get(f) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .filter(([, n]) => n >= minCount)
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, label: value, count }));
}
/**
 * Brivity's feature categories, and the words that put a real feed value into
 * one.
 *
 * WHY MATCH RATHER THAN HARD-CODE. Brivity's form lists a fixed set of
 * checkboxes ("Boat Ramp", "1st Seller Carry") whether or not the board carries
 * them, so ticking one can silently match nothing. The categories below are
 * Brivity's, in Brivity's order, but what goes inside each one is whatever the
 * feed actually publishes — so the form looks like the one being migrated from
 * and still cannot offer a filter this data can't answer.
 *
 * Order matters: the first category whose pattern matches wins, which is why
 * Community sits above Pool (a "Community Pool" is an amenity of the
 * neighbourhood, and that is the drawer Brivity files it in) and Parking above
 * Exterior (a "Detached Garage" is parking, not siding).
 */
const FEATURE_CATEGORIES = [
    {
        key: "community",
        label: "Community Features",
        test: /communit|clubhouse|basketball|bbq|barbe|boat ramp|controlled access|gated|park|playground|tennis|volleyball|golf course|jogging|trail|waterfront access/i,
    },
    { key: "pool", label: "Pool", test: /\bpool\b|\bspa\b|hot tub/i },
    { key: "cooling", label: "Cooling", test: /cooling|air condition|\ba\/?c\b|evaporative/i },
    { key: "heating", label: "Heating", test: /heating|furnace|heat pump|zoned heat|radiant/i },
    { key: "parking", label: "Parking", test: /garage|carport|parking|driveway|side entry|oversized|attached|detached/i },
    {
        key: "style",
        label: "Home Style",
        test: /mediterranean|\branch\b|split level|traditional|contemporary|colonial|craftsman|victorian|tudor|farmhouse/i,
    },
    {
        key: "lot",
        label: "Lot",
        /* Deliberately narrow. A bare "level" or "corner" here swept up "Laundry
           Main Level" and filed it under Lot — the words that describe a plot of
           land are also ordinary English, so only the unambiguous ones qualify and
           everything else falls through to Interior. */
        test: /\blot\b|\bacres?\b|horses|on waterfront|cul-?de-?sac|greenbelt|\bbluff\b|wooded/i,
    },
    {
        key: "exterior",
        label: "Exterior",
        test: /patio|deck|balcony|porch|fence|shed|storage building|workshop|sprinkler|gutter|roof|siding|brick|stucco|masonry|exterior|outdoor kitchen/i,
    },
    {
        key: "property",
        label: "Property",
        test: /\bview\b|city view|county view|water view|hill country/i,
    },
];
/** Bucket the real feature vocabulary into Brivity's categories. */
function groupFeatures(interior, exterior) {
    const tagged = [
        ...interior.map((f) => ({ ...f, side: "interior" })),
        ...exterior.map((f) => ({ ...f, side: "exterior" })),
    ];
    const buckets = new Map();
    const other = [];
    for (const f of tagged) {
        const cat = FEATURE_CATEGORIES.find((c) => c.test.test(f.label));
        if (!cat) {
            other.push(f);
            continue;
        }
        const list = buckets.get(cat.key) || [];
        list.push(f);
        buckets.set(cat.key, list);
    }
    /* "Popular Features" is Brivity's shortcut row, not a category of its own —
       it repeats the handful of things buyers ask for by name. Repeated
       deliberately: ticking it here and ticking it in Pool are the same filter,
       and a buyer who wants a pool should not have to know which group it is
       filed under. */
    const popular = tagged
        .filter((f) => /\bpool\b|waterfront|\bview\b|open floor plan|walk.?in closet/i.test(f.label))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    const groups = [];
    if (popular.length)
        groups.push({ key: "popular", label: "Popular Features", options: popular });
    for (const c of FEATURE_CATEGORIES) {
        const opts = (buckets.get(c.key) || []).sort((a, b) => b.count - a.count);
        if (opts.length)
            groups.push({ key: c.key, label: c.label, options: opts });
    }
    /* Everything the board publishes that Brivity has no drawer for. Dropping it
       would hide real, searchable features purely because the form being copied
       never had a box for them. */
    const interiorOther = other.filter((f) => f.side === "interior").sort((a, b) => b.count - a.count);
    const exteriorOther = other.filter((f) => f.side === "exterior").sort((a, b) => b.count - a.count);
    if (interiorOther.length)
        groups.push({ key: "interior", label: "Interior", options: interiorOther });
    if (exteriorOther.length)
        groups.push({ key: "exteriorOther", label: "Other Exterior Features", options: exteriorOther });
    return groups;
}
function getMlsFacets(force = false) {
    if (!force && cache && Date.now() - cache.at < TTL_MS)
        return cache.facets;
    const db = (0, listingsStore_js_1.getListingsDb)();
    const total = Number(db.prepare(`SELECT COUNT(*) n FROM listings`).get()?.n || 0);
    const facets = {
        total,
        cities: topValues(`SELECT city v, COUNT(*) n FROM listings GROUP BY LOWER(city) ORDER BY n DESC LIMIT @lim`, 120),
        postalCodes: topValues(`SELECT postal_code v, COUNT(*) n FROM listings GROUP BY postal_code ORDER BY n DESC LIMIT @lim`, 200),
        counties: topValues(`SELECT json_extract(raw,'$.geo.county') v, COUNT(*) n FROM listings GROUP BY LOWER(v) ORDER BY n DESC LIMIT @lim`, 40),
        schoolDistricts: topValues(`SELECT json_extract(raw,'$.school.district') v, COUNT(*) n FROM listings GROUP BY LOWER(v) ORDER BY n DESC LIMIT @lim`, 80),
        propertyTypes: topValues(`SELECT property_type v, COUNT(*) n FROM listings GROUP BY property_type ORDER BY n DESC LIMIT @lim`, 30),
        subTypes: topValues(`SELECT json_extract(raw,'$.property.subType') v, COUNT(*) n FROM listings GROUP BY v ORDER BY n DESC LIMIT @lim`, 30),
        statuses: topValues(`SELECT status v, COUNT(*) n FROM listings GROUP BY status ORDER BY n DESC LIMIT @lim`, 20),
        stories: topValues(`SELECT json_extract(raw,'$.property.stories') v, COUNT(*) n FROM listings GROUP BY v ORDER BY n DESC LIMIT @lim`, 10),
        interiorFeatures: featureFacets("$.property.interiorFeatures", 25),
        exteriorFeatures: featureFacets("$.property.exteriorFeatures", 25),
        featureGroups: [],
        unavailable: [],
        computedAt: new Date().toISOString(),
    };
    facets.featureGroups = groupFeatures(facets.interiorFeatures, facets.exteriorFeatures);
    facets.propertyTypes = facets.propertyTypes.map((f) => ({ ...f, label: PROPERTY_TYPE_LABELS[f.value] || f.value }));
    facets.subTypes = facets.subTypes.map((f) => ({ ...f, label: spaceCamel(f.value) }));
    facets.stories = facets.stories
        .filter((f) => Number.isFinite(Number(f.value)))
        .map((f) => ({ ...f, label: Number(f.value) === 1 ? "Single storey" : `${f.value} storeys` }));
    /* Anything the schema has a place for but this board leaves empty is named
       here rather than silently dropped, so the gap is visible instead of being
       mistaken for a bug in the filter. */
    const emptyCheck = (label, expr, reason) => {
        const n = Number(db.prepare(`SELECT COUNT(*) n FROM listings WHERE ${expr} IS NOT NULL AND ${expr} <> ''`).get()?.n || 0);
        if (n === 0)
            facets.unavailable.push({ field: label, reason });
    };
    emptyCheck("Garage spaces", `json_extract(raw,'$.property.garageSpaces')`, "SABOR does not publish a garage-space count on this feed.");
    emptyCheck("Map area (draw a boundary)", `json_extract(raw,'$.geo.lat')`, "Listings carry no latitude/longitude, so a drawn map boundary cannot be evaluated. Area is set by city, postal code, county, school district or subdivision instead.");
    facets.unavailable.push({
        field: "Financial options (FHA / VA / USDA / Texas Vet / seller carry)",
        reason: "Not published on the SABOR feed — the listing carries the property, not the accepted financing.",
    });
    if (!facets.statuses.some((s) => /sold|closed/i.test(s.value))) {
        facets.unavailable.push({
            field: "Sold comparables",
            reason: "The feed mirror holds Active and Pending only, so market reports are built on what is on the market now, not on solds.",
        });
    }
    cache = { at: Date.now(), facets };
    return facets;
}
function clearFacetCache() {
    cache = null;
}
