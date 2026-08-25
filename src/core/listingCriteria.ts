/**
 * One search-criteria vocabulary, shared by Listing Alerts and Market Reports.
 *
 * Both features are "a saved MLS search that runs on a schedule", so they have
 * no business owning two different ideas of what a search is — a buyer alert
 * for 3-bed pool homes in 78253 and a seller report's comp set are the same
 * query with different presentation.
 *
 * WHAT THE FEED ACTUALLY SUPPORTS, measured against the live SABOR mirror
 * (30,182 listings) rather than copied from Brivity's field list, because
 * offering a filter the data cannot answer is worse than not offering it:
 *
 *   - `listings` columns cover price, beds, baths, area, lot, year, city,
 *     postal code, property type, subdivision and status.
 *   - Everything else lives in the untouched SimplyRETS record in `raw`, and is
 *     reached with SQLite's json_extract: `$.property.pool` ("Y"/"N"),
 *     `$.property.stories`, `$.property.garageSpaces`, `$.property.subType`,
 *     `$.property.interiorFeatures` / `exteriorFeatures` (comma-joined text),
 *     `$.geo.county`, `$.school.district`.
 *   - NOT AVAILABLE AT ALL: Brivity's Financial Options group (FHA / VA / USDA
 *     / Texas Vet / assumption / seller carry). SABOR does not publish deal
 *     structure on the listing, so those checkboxes are deliberately absent
 *     rather than rendered and silently ignored.
 *   - ALSO NOT AVAILABLE: latitude/longitude. Every sampled record has
 *     `geo.lat === null`, so a map-drawn polygon cannot be evaluated against
 *     anything. Area is therefore expressed as places (city / postal / county /
 *     school district / subdivision), which the feed does populate.
 */
import { getListingsDb, type Listing } from "./listingsStore.js";

export interface ListingCriteria {
  /* Where. Any match inside a list is an OR; the lists AND together, so
     "San Antonio" + "78253" means that postal code within that city. */
  cities?: string[];
  postalCodes?: string[];
  counties?: string[];
  schoolDistricts?: string[];
  subdivisions?: string[];
  /**
   * Free-text street match, for the "search terms" box: a person typing
   * "Rolling Oaks" wants the street, not the subdivision field. Contains, not
   * equals — the feed writes full street lines ("1234 Rolling Oaks Dr").
   */
  streetContains?: string;

  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  maxBeds?: number;
  minBaths?: number;
  maxBaths?: number;
  minSqft?: number;
  maxSqft?: number;
  minLotSize?: number;
  maxLotSize?: number;
  minYearBuilt?: number;
  maxYearBuilt?: number;
  minGarage?: number;
  /** Story counts to accept, e.g. [1] for single-storey only. */
  stories?: number[];
  /** Feed's top-level type code: RES, RNT, CRE, LND, MUL… */
  propertyTypes?: string[];
  /** Finer type: SingleFamilyResidence, Condominium, ManufacturedHome… */
  subTypes?: string[];

  /** true = must have a pool, false = must not, undefined = don't care. */
  pool?: boolean;
  /** All listed features must be present (AND) — that is what a buyer means. */
  interiorFeatures?: string[];
  exteriorFeatures?: string[];

  /** Defaults to Active only. */
  statuses?: string[];
  /**
   * Brivity's "Include Properties without Photos". Off by default: a listing
   * with no photo is a bad first impression in a client email, and the point of
   * the option is catching brand-new listings the instant they hit the board.
   */
  includeWithoutPhotos?: boolean;
}

export interface CriteriaSql {
  where: string;
  params: Record<string, unknown>;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clean = (list: unknown): string[] =>
  Array.isArray(list)
    ? Array.from(new Set(list.map((x) => String(x ?? "").trim()).filter(Boolean)))
    : [];

/**
 * An OR over one column for a list of values, parameterised.
 *
 * `json_extract` results are compared case-insensitively because the feed is
 * not consistent about capitalisation ("Bandera Isd" alongside "Medina Valley
 * I.S.D."), and an alert that misses on a capital letter is indistinguishable
 * from a quiet market.
 */
function orEquals(expr: string, values: string[], key: string, params: Record<string, unknown>): string | null {
  if (!values.length) return null;
  const parts = values.map((v, i) => {
    const p = `${key}${i}`;
    params[p] = v.toLowerCase();
    return `LOWER(${expr}) = @${p}`;
  });
  return `(${parts.join(" OR ")})`;
}

/** Substring OR — for the comma-joined feature strings and subdivisions. */
function orContains(expr: string, values: string[], key: string, params: Record<string, unknown>, mode: "and" | "or"): string | null {
  if (!values.length) return null;
  const parts = values.map((v, i) => {
    const p = `${key}${i}`;
    params[p] = `%${v.toLowerCase()}%`;
    return `LOWER(COALESCE(${expr},'')) LIKE @${p}`;
  });
  return `(${parts.join(mode === "and" ? " AND " : " OR ")})`;
}

export function buildCriteriaSql(c: ListingCriteria): CriteriaSql {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  const push = (clause: string | null) => { if (clause) where.push(clause); };

  const statuses = clean(c.statuses).length ? clean(c.statuses) : ["Active"];
  push(orEquals("status", statuses, "st", params));

  push(orEquals("city", clean(c.cities), "cty", params));
  push(orEquals("postal_code", clean(c.postalCodes), "zip", params));
  push(orEquals("json_extract(raw,'$.geo.county')", clean(c.counties), "cnty", params));
  push(orEquals("json_extract(raw,'$.school.district')", clean(c.schoolDistricts), "sd", params));
  /* Subdivision is a contains-OR: the feed writes "Alamo Ranch Unit 12" where a
     person types "Alamo Ranch". */
  push(orContains("subdivision", clean(c.subdivisions), "sub", params, "or"));
  const street = String(c.streetContains ?? "").trim();
  if (street) {
    params.street0 = `%${street.toLowerCase()}%`;
    where.push(`LOWER(COALESCE(street,'')) LIKE @street0`);
  }

  const range = (col: string, min: unknown, max: unknown, key: string) => {
    if (isNum(min)) { params[key + "Min"] = min; where.push(`${col} >= @${key}Min`); }
    if (isNum(max)) { params[key + "Max"] = max; where.push(`${col} <= @${key}Max`); }
  };
  range("list_price", c.minPrice, c.maxPrice, "price");
  range("beds", c.minBeds, c.maxBeds, "beds");
  range("baths", c.minBaths, c.maxBaths, "baths");
  range("living_area", c.minSqft, c.maxSqft, "sqft");
  range("lot_size", c.minLotSize, c.maxLotSize, "lot");
  range("year_built", c.minYearBuilt, c.maxYearBuilt, "yr");
  if (isNum(c.minGarage)) {
    params.garageMin = c.minGarage;
    where.push(`CAST(json_extract(raw,'$.property.garageSpaces') AS REAL) >= @garageMin`);
  }

  const stories = Array.isArray(c.stories) ? c.stories.filter(isNum) : [];
  if (stories.length) {
    const parts = stories.map((s, i) => { params["sty" + i] = s; return `CAST(json_extract(raw,'$.property.stories') AS REAL) = @sty${i}`; });
    where.push(`(${parts.join(" OR ")})`);
  }

  push(orEquals("property_type", clean(c.propertyTypes), "pt", params));
  push(orEquals("json_extract(raw,'$.property.subType')", clean(c.subTypes), "sbt", params));

  if (c.pool === true) where.push(`UPPER(COALESCE(json_extract(raw,'$.property.pool'),'')) = 'Y'`);
  if (c.pool === false) where.push(`UPPER(COALESCE(json_extract(raw,'$.property.pool'),'')) <> 'Y'`);

  push(orContains("json_extract(raw,'$.property.interiorFeatures')", clean(c.interiorFeatures), "intf", params, "and"));
  push(orContains("json_extract(raw,'$.property.exteriorFeatures')", clean(c.exteriorFeatures), "extf", params, "and"));

  if (!c.includeWithoutPhotos) where.push(`photo_url IS NOT NULL AND photo_url <> ''`);

  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

function rowToListing(r: Record<string, unknown>): Listing {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    listingKey: String(r.listing_key),
    mlsNumber: s(r.mls_number),
    status: s(r.status),
    listPrice: n(r.list_price),
    closePrice: n(r.close_price),
    street: s(r.street),
    city: s(r.city),
    state: s(r.state),
    postalCode: s(r.postal_code),
    beds: n(r.beds),
    baths: n(r.baths),
    livingArea: n(r.living_area),
    lotSize: n(r.lot_size),
    yearBuilt: n(r.year_built),
    propertyType: s(r.property_type),
    subdivision: s(r.subdivision),
    listAgent: s(r.list_agent),
    listOffice: s(r.list_office),
    photoUrl: s(r.photo_url),
    publicRemarks: s(r.public_remarks),
    modificationTs: s(r.modification_ts),
    listedAt: s(r.listed_at),
    closedAt: s(r.closed_at),
    syncedAt: String(r.synced_at ?? ""),
  };
}

/** How many listings match, with no row limit — the number shown before saving. */
export function countMatching(c: ListingCriteria): number {
  const { where, params } = buildCriteriaSql(c);
  const row = getListingsDb().prepare(`SELECT COUNT(*) AS n FROM listings ${where}`).get(params) as { n: number };
  return Number(row?.n || 0);
}

export function findMatching(c: ListingCriteria, limit = 50): Listing[] {
  const { where, params } = buildCriteriaSql(c);
  const rows = getListingsDb()
    .prepare(
      `SELECT * FROM listings ${where}
       ORDER BY COALESCE(listed_at, modification_ts, synced_at) DESC
       LIMIT @lim`,
    )
    .all({ ...params, lim: Math.min(Math.max(1, limit), 500) }) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

/** Aggregate stats over the matching set — the numbers a Market Report is made of. */
export interface CriteriaStats {
  count: number;
  minPrice: number | null;
  maxPrice: number | null;
  medianPrice: number | null;
  avgPrice: number | null;
  avgPricePerSqft: number | null;
  avgDaysOnMarket: number | null;
  avgSqft: number | null;
  avgBeds: number | null;
}

export function statsFor(c: ListingCriteria): CriteriaStats {
  const { where, params } = buildCriteriaSql(c);
  const db = getListingsDb();
  const agg = db
    .prepare(
      `SELECT COUNT(*) n, MIN(list_price) lo, MAX(list_price) hi, AVG(list_price) avg,
              AVG(living_area) sqft, AVG(beds) beds,
              AVG(CAST(json_extract(raw,'$.mls.daysOnMarket') AS REAL)) dom,
              AVG(CASE WHEN living_area > 0 THEN list_price * 1.0 / living_area END) ppsf
       FROM listings ${where}`,
    )
    .get(params) as Record<string, number | null>;
  const n = Number(agg?.n || 0);
  /* Median from the real distribution rather than the mean: one $6M ranch in a
     starter-home postal code moves an average and tells the homeowner nothing. */
  let median: number | null = null;
  if (n > 0) {
    /* Priced rows only, counted separately — a listing with a null price must
       not shift the middle of the distribution by occupying a slot. */
    const priced = where ? `${where} AND list_price IS NOT NULL` : `WHERE list_price IS NOT NULL`;
    const pn = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM listings ${priced}`).get(params) as { n: number })?.n || 0,
    );
    if (pn > 0) {
      const take = pn % 2 === 0 ? 2 : 1;
      const off = Math.floor((pn - 1) / 2);
      const mid = db
        .prepare(`SELECT list_price p FROM listings ${priced} ORDER BY list_price LIMIT @take OFFSET @off`)
        .all({ ...params, take, off }) as { p: number }[];
      if (mid.length) median = mid.reduce((t, r) => t + Number(r.p), 0) / mid.length;
    }
  }
  const r1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v));
  return {
    count: n,
    minPrice: r1(agg?.lo),
    maxPrice: r1(agg?.hi),
    medianPrice: r1(median),
    avgPrice: r1(agg?.avg),
    avgPricePerSqft: agg?.ppsf != null && Number.isFinite(agg.ppsf) ? Math.round(agg.ppsf) : null,
    avgDaysOnMarket: r1(agg?.dom),
    avgSqft: r1(agg?.sqft),
    avgBeds: agg?.beds != null && Number.isFinite(agg.beds) ? Math.round(agg.beds * 10) / 10 : null,
  };
}

/** Human sentence for one criteria set — used in emails and the alert card. */
export function describeCriteria(c: ListingCriteria): string {
  const bits: string[] = [];
  const money = (n: number) => "$" + Math.round(n).toLocaleString();
  if (isNum(c.minPrice) && isNum(c.maxPrice)) bits.push(`${money(c.minPrice)}–${money(c.maxPrice)}`);
  else if (isNum(c.maxPrice)) bits.push(`under ${money(c.maxPrice)}`);
  else if (isNum(c.minPrice)) bits.push(`over ${money(c.minPrice)}`);
  if (isNum(c.minBeds)) bits.push(`${c.minBeds}+ bed`);
  if (isNum(c.minBaths)) bits.push(`${c.minBaths}+ bath`);
  if (isNum(c.minSqft)) bits.push(`${c.minSqft.toLocaleString()}+ sqft`);
  if (c.pool === true) bits.push("pool");
  const places = [...clean(c.cities), ...clean(c.postalCodes), ...clean(c.subdivisions), ...clean(c.schoolDistricts)];
  if (places.length) bits.push(`in ${places.slice(0, 3).join(", ")}${places.length > 3 ? ` +${places.length - 3}` : ""}`);
  return bits.join(" · ") || "Any listing on the board";
}
