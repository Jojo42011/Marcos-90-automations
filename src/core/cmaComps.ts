/**
 * Where each of the CMA wizard's four selection steps gets its candidates, and
 * the arithmetic that turns the picks into a result.
 *
 * The four steps look identical in the spec — feed on the left, tray on top,
 * map on the right — and behind them sit three quite different sources plus one
 * that does not exist. `sourceFor` is the single place that difference is
 * decided, and every feed response carries the `source` and any `unavailable`
 * reason with it so the page can never present a hand-typed set as a board
 * search.
 *
 * SOLD IS THE INTERESTING ONE. A CMA is mostly built on solds, and the SABOR
 * mirror has none — `mlsFacets` counts the statuses on every run and finds
 * Active and Pending only. Rather than an empty step, the sold feed reads
 * Marco's own closed transactions, which carry a genuine list price and a
 * genuine sold price (that pair is exactly what step 4's dual-price display
 * wants). It is a real source and a narrow one: his book, not the board. The
 * response says so, in those words, and every row is tagged `transaction`.
 *
 * THE RESULT IS ARITHMETIC, NOT AN AVM. Same rule as the market report: the
 * estimate is the median price per square foot of the SELECTED comps times the
 * subject's own square footage, with a band from the quartiles. No square
 * footage on the subject, or no comp that has one, means NO estimate and a
 * statement of what is missing — never a number derived from a guess.
 */
import {
  buildCriteriaSql,
  type ListingCriteria,
} from "./listingCriteria.js";
import { getListingsDb, type Listing } from "./listingsStore.js";
import { getAllTransactions } from "./transactionsStore.js";
import type { CmaComparable, CmaSession, CompStatus } from "./cmaStore.js";

/* ────────────────────────── candidate feed ────────────────────────── */

/** Sort options the feed can actually honour. Distance is NOT one of them. */
export type CandidateSort = "recent" | "price_asc" | "price_desc" | "status_date" | "sqft_desc";

export const CANDIDATE_SORTS: Array<{ value: CandidateSort; label: string }> = [
  { value: "recent", label: "Most recent activity" },
  { value: "status_date", label: "Status date: Newest" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "sqft_desc", label: "Largest first" },
];

/**
 * The spec's sort list ends with `Distance`, which needs a coordinate on both
 * the subject and the comp. Neither exists — every row in the mirror has
 * `geo.lat === null`. Offered and refused, with the reason, rather than
 * silently dropped from the menu.
 */
export const UNAVAILABLE_SORT = {
  value: "distance",
  label: "Distance",
  reason:
    "Listings on this feed carry no latitude or longitude, so distance from the subject property cannot be measured. " +
    "The comp area is set by the place ladder instead — postal code, then city, then county.",
};

export interface CandidateRow {
  key: string;
  source: "mls" | "transaction";
  mlsNumber: string | null;
  address: string;
  city: string | null;
  postalCode: string | null;
  price: number | null;
  originalListPrice: number | null;
  soldPrice: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  lotSize: number | null;
  yearBuilt: number | null;
  listDate: string | null;
  statusDate: string | null;
  daysOnMarket: number | null;
  photoUrl: string | null;
}

export interface CandidateFeed {
  status: CompStatus;
  /** Where these rows came from, in one word, for the row badge. */
  source: "mls" | "transaction" | "manual";
  total: number;
  rows: CandidateRow[];
  /** Present when the step has no automatic source at all. */
  unavailable: string | null;
  /** Always present: a plain sentence naming the source and its limits. */
  sourceNote: string;
  /** The label the feed header uses ("60 Active listings sorted by"). */
  statusLabel: string;
}

const STATUS_LABEL: Record<CompStatus, string> = {
  ACTIVE: "Active",
  PENDING: "Pending",
  SOLD: "Sold",
  OFF_MKT: "Off Mkt",
};

export function statusLabel(status: CompStatus): string {
  return STATUS_LABEL[status];
}

/** The MLS status string in the mirror for a wizard step, when there is one. */
function mirrorStatus(status: CompStatus): string | null {
  if (status === "ACTIVE") return "Active";
  if (status === "PENDING") return "Pending";
  return null;
}

const ORDER_BY: Record<CandidateSort, string> = {
  recent: "COALESCE(modification_ts, listed_at) DESC",
  status_date: "COALESCE(modification_ts, listed_at) DESC",
  price_asc: "list_price ASC",
  price_desc: "list_price DESC",
  sqft_desc: "living_area DESC",
};

function listingToCandidate(l: Listing, status: CompStatus): CandidateRow {
  /* Days on market lives in the raw payload, not a column; the mirror keeps
     the untouched record precisely so a field nobody mapped is still there. */
  return {
    key: l.listingKey,
    source: "mls",
    mlsNumber: l.mlsNumber,
    address: [l.street, l.city, l.state].filter(Boolean).join(", "),
    city: l.city,
    postalCode: l.postalCode,
    price: l.listPrice,
    originalListPrice: l.listPrice,
    soldPrice: status === "SOLD" ? l.closePrice : null,
    beds: l.beds,
    baths: l.baths,
    sqft: l.livingArea,
    lotSize: l.lotSize,
    yearBuilt: l.yearBuilt,
    listDate: l.listedAt,
    /* For a Pending row this is the moment the board last touched the record,
       which is when it flipped to Pending in all but pathological cases. The
       feed publishes no dedicated pending date, so the UI labels it "Status
       updated" rather than claiming a contract date it does not have. */
    statusDate: status === "PENDING" ? l.modificationTs : status === "SOLD" ? l.closedAt : l.listedAt,
    daysOnMarket: null,
    photoUrl: l.photoUrl,
  };
}

/** Days on market, in order of what the row can actually support. */
function domFor(opts: {
  raw?: unknown;
  listDate?: string | null;
  statusDate?: string | null;
  status: CompStatus;
}): number | null {
  /* The feed publishes it directly for active and pending rows. */
  const raw = opts.raw && typeof opts.raw === "object" ? (opts.raw as Record<string, unknown>) : null;
  const mls = raw && typeof raw.mls === "object" ? (raw.mls as Record<string, unknown>) : null;
  const published = Number(mls?.daysOnMarket);
  if (Number.isFinite(published) && published >= 0) return Math.round(published);

  /* Otherwise derive it, but ONLY from two real dates. A sold comp typed in
     without a list date has no days on market, and 0 would read as "sold the
     day it listed" — a claim about the market, not a missing field. */
  if (!opts.listDate || !opts.statusDate) return null;
  const a = Date.parse(opts.listDate);
  const b = Date.parse(opts.statusDate);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Comparable criteria plus the step's status, run against the mirror.
 *
 * The session's saved criteria decide beds/baths/price/sqft/lot/year; the step
 * decides the status. A status saved into the criteria by an earlier screen is
 * deliberately overridden — step 3 shows pendings whatever step 1 asked for.
 */
function mlsCandidates(
  session: CmaSession,
  status: CompStatus,
  sort: CandidateSort,
  limit: number,
  offset: number,
): { total: number; rows: CandidateRow[] } {
  const feedStatus = mirrorStatus(status);
  if (!feedStatus) return { total: 0, rows: [] };
  const criteria: ListingCriteria = {
    ...(session.criteria as ListingCriteria),
    statuses: [feedStatus],
    /* `buildCriteriaSql` defaults to excluding listings with no photo, which is
       right for an alert email and wrong here. A comparable with no photo is
       still a comparable, and dropping it silently narrows the comp set and
       moves the valuation. The card says "no photo on file" instead. */
    includeWithoutPhotos: true,
  };
  const { where, params } = buildCriteriaSql(criteria);
  const database = getListingsDb();
  const total = Number(
    (database.prepare(`SELECT COUNT(*) n FROM listings ${where}`).get(params) as { n: number })?.n || 0,
  );
  const rows = database
    .prepare(`SELECT * FROM listings ${where} ORDER BY ${ORDER_BY[sort]} LIMIT @lim OFFSET @off`)
    .all({ ...params, lim: limit, off: offset }) as Record<string, unknown>[];
  const withDom = (row: Record<string, unknown>, c: CandidateRow): CandidateRow => {
    let raw: unknown = null;
    try { raw = JSON.parse(String(row.raw || "{}")); } catch { raw = null; }
    return { ...c, daysOnMarket: domFor({ raw, listDate: c.listDate, statusDate: c.statusDate, status }) };
  };
  return {
    total,
    rows: rows.map((r) =>
      withDom(r, listingToCandidate(
        {
          listingKey: String(r.listing_key),
          mlsNumber: (r.mls_number as string) ?? null,
          status: (r.status as string) ?? null,
          listPrice: (r.list_price as number) ?? null,
          closePrice: (r.close_price as number) ?? null,
          street: (r.street as string) ?? null,
          city: (r.city as string) ?? null,
          state: (r.state as string) ?? null,
          postalCode: (r.postal_code as string) ?? null,
          beds: (r.beds as number) ?? null,
          baths: (r.baths as number) ?? null,
          livingArea: (r.living_area as number) ?? null,
          lotSize: (r.lot_size as number) ?? null,
          yearBuilt: (r.year_built as number) ?? null,
          propertyType: (r.property_type as string) ?? null,
          subdivision: (r.subdivision as string) ?? null,
          listAgent: (r.list_agent as string) ?? null,
          listOffice: (r.list_office as string) ?? null,
          photoUrl: (r.photo_url as string) ?? null,
          publicRemarks: (r.public_remarks as string) ?? null,
          modificationTs: (r.modification_ts as string) ?? null,
          listedAt: (r.listed_at as string) ?? null,
          closedAt: (r.closed_at as string) ?? null,
          syncedAt: String(r.synced_at),
        },
        status,
      )),
    ),
  };
}

/** Postal code out of a free-typed address, if there is one. */
function postalOf(address: string | null): string | null {
  const m = /\b(\d{5})(?:-\d{4})?\b/.exec(String(address || ""));
  return m ? m[1] : null;
}

/**
 * Sold comps from Marco's own closed transactions.
 *
 * Only rows that carry BOTH a sold price and an address are offered: a closing
 * with no price is not a comparable, and putting it in the feed with a blank
 * where the number goes invites someone to select it. Beds, baths and square
 * footage are usually absent on these rows — the transaction record is a deal,
 * not a listing — so they come back null and step 4's manual edit is how they
 * get filled in.
 */
function transactionCandidates(
  session: CmaSession,
  sort: CandidateSort,
  limit: number,
  offset: number,
  days: number | null,
): { total: number; rows: CandidateRow[] } {
  /* Read defensively: a CMA must still open if the transactions database is
     unreadable, with an empty sold feed and step 4's manual entry, rather than
     a 500 that loses the rest of the session. */
  let all: Array<Record<string, unknown>> = [];
  try {
    all = (getAllTransactions("closed") as unknown as Array<Record<string, unknown>>) || [];
  } catch {
    return { total: 0, rows: [] };
  }

  const city = (session.subjectCity || "").trim().toLowerCase();
  const rows: CandidateRow[] = [];
  for (const t of all) {
    const address = String(t.address || "").trim();
    const sold = Number(t.price);
    if (!address || !Number.isFinite(sold) || sold <= 0) continue;
    const list = Number(t.listPrice);
    rows.push({
      key: String(t.id || t.externalKey || address),
      source: "transaction",
      mlsNumber: (t.mls as string) || null,
      address,
      city: city && address.toLowerCase().includes(city) ? session.subjectCity : null,
      postalCode: postalOf(address),
      price: sold,
      originalListPrice: Number.isFinite(list) && list > 0 ? list : null,
      soldPrice: sold,
      beds: null,
      baths: null,
      sqft: null,
      lotSize: null,
      yearBuilt: null,
      listDate: (t.dateListed as string) || null,
      statusDate: (t.closingDate as string) || (t.statusChangedAt as string) || null,
      daysOnMarket: domFor({
        listDate: (t.dateListed as string) || null,
        statusDate: (t.closingDate as string) || (t.statusChangedAt as string) || null,
        status: "SOLD",
      }),
      photoUrl: null,
    });
  }

  /* Step 1's Sold / Off Market Date window. A row with NO date is kept rather
     than filtered out: "closed at some point" is not the same claim as "closed
     outside your window", and dropping it would silently shrink the comp set
     over a field the transaction import often leaves blank. */
  const filtered = days
    ? rows.filter((r) => {
        if (!r.statusDate) return true;
        const t = Date.parse(r.statusDate);
        return !Number.isFinite(t) || Date.now() - t <= days * 86400000;
      })
    : rows;

  /* Same city first when the subject has one — the closest thing to proximity
     available without coordinates — then by the chosen sort. */
  const inCity = (r: CandidateRow) =>
    city ? (r.address.toLowerCase().includes(city) ? 0 : 1) : 0;
  const byDate = (r: CandidateRow) => (r.statusDate ? Date.parse(r.statusDate) || 0 : 0);
  filtered.sort((a, b) => {
    const c = inCity(a) - inCity(b);
    if (c !== 0) return c;
    if (sort === "price_asc") return (a.price ?? 0) - (b.price ?? 0);
    if (sort === "price_desc") return (b.price ?? 0) - (a.price ?? 0);
    if (sort === "sqft_desc") return (b.sqft ?? 0) - (a.sqft ?? 0);
    return byDate(b) - byDate(a);
  });

  return { total: filtered.length, rows: filtered.slice(offset, offset + limit) };
}

const SOLD_NOTE =
  "The SABOR feed this system mirrors publishes Active and Pending only — it carries no sold prices at all. " +
  "These rows are Marco's own closed transactions, which do record a real list price and a real sold price. " +
  "That is his book, not the whole board, so treat it as a floor and add any other solds by hand.";

const OFF_MKT_NOTE =
  "Expired, withdrawn and cancelled listings are not published on this feed, and nothing else in this system " +
  "records them. Every off-market comp here has to be entered by hand — there is no search to run.";

export function candidateFeed(
  session: CmaSession,
  status: CompStatus,
  opts: { sort?: CandidateSort; limit?: number; offset?: number; days?: number | null } = {},
): CandidateFeed {
  const sort: CandidateSort = CANDIDATE_SORTS.some((s) => s.value === opts.sort)
    ? (opts.sort as CandidateSort)
    : "recent";
  const limit = Math.min(Math.max(Number(opts.limit ?? 40), 1), 200);
  const offset = Math.max(Number(opts.offset ?? 0), 0);

  if (status === "ACTIVE" || status === "PENDING") {
    const { total, rows } = mlsCandidates(session, status, sort, limit, offset);
    return {
      status,
      source: "mls",
      total,
      rows,
      unavailable: null,
      sourceNote:
        status === "ACTIVE"
          ? "Live from the SABOR MLS mirror — what is on the market right now and competing with the subject."
          : "Live from the SABOR MLS mirror. The feed publishes no dedicated pending date, so the date shown is " +
            "when the board last updated the record, which is when it went under contract in all but odd cases.",
      statusLabel: STATUS_LABEL[status],
    };
  }

  if (status === "SOLD") {
    const { total, rows } = transactionCandidates(session, sort, limit, offset, opts.days ?? null);
    return {
      status,
      source: "transaction",
      total,
      rows,
      unavailable: null,
      sourceNote: SOLD_NOTE,
      statusLabel: STATUS_LABEL[status],
    };
  }

  return {
    status,
    source: "manual",
    total: 0,
    rows: [],
    unavailable: OFF_MKT_NOTE,
    sourceNote: OFF_MKT_NOTE,
    statusLabel: STATUS_LABEL[status],
  };
}

/* ────────────────────────── results ────────────────────────── */

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Square feet in an acre. The feed publishes acres; the spec's table is sqft. */
const SQFT_PER_ACRE = 43560;

/** One row of a step-6 summary table, with every derived column resolved. */
export interface SummaryRow {
  id: string;
  photoUrl: string | null;
  address: string;
  beds: number | null;
  baths: number | null;
  listPrice: number | null;
  soldPrice: number | null;
  /** Sold ÷ list, as a percentage. Needs BOTH numbers or it is null. */
  pricePct: number | null;
  sqft: number | null;
  pricePerSqft: number | null;
  lotSqft: number | null;
  pricePerLotSqft: number | null;
  dom: number | null;
  source: string;
  isManualEntry: boolean;
}

/**
 * The averages row under each table.
 *
 * Every field is a mean over the rows that HAVE that value, and `n` records how
 * many that was. Averaging a missing square footage as zero would drag the mean
 * toward nothing and quietly understate every price per foot in the report.
 */
export interface SummaryAverages {
  listPrice: number | null;
  soldPrice: number | null;
  pricePct: number | null;
  sqft: number | null;
  pricePerSqft: number | null;
  lotSqft: number | null;
  pricePerLotSqft: number | null;
  dom: number | null;
  /** How many rows each average was computed from, per column. */
  n: Record<string, number>;
}

export interface BucketSummary {
  status: CompStatus;
  label: string;
  count: number;
  minPrice: number | null;
  maxPrice: number | null;
  medianPrice: number | null;
  medianPricePerSqft: number | null;
  /** Sold only: median sold ÷ list, as a percentage. Null without both. */
  listToSalePct: number | null;
  /** How many rows in this bucket have no square footage on file. */
  missingSqft: number;
  /** The spec's data table for this category. */
  rows: SummaryRow[];
  /** The soft grey footer under it. */
  averages: SummaryAverages;
}

export interface CmaResults {
  buckets: BucketSummary[];
  totalSelected: number;
  /** Median $/sqft across every selected comp that has a size. */
  pricePerSqft: number | null;
  /**
   * How many comparables actually contributed to that median.
   *
   * NOT the same as `totalSelected`, and the difference is the whole reason
   * this field exists: "5 comparables at a median of $181/sqft" when only one
   * of the five had a square footage overstates what the number rests on.
   */
  sizedCount: number;
  /** subject sqft × median $/sqft, or null with a stated reason. */
  estimate: number | null;
  estimateLow: number | null;
  estimateHigh: number | null;
  /** Why there is no estimate. Null when there is one. */
  estimateBlockedReason: string | null;
  /** The Total Listings Summary card — averages across every selected comp. */
  totals: SummaryAverages;
  /** What the Suggested Min List Price field is seeded with, and from what. */
  suggested: {
    minListPrice: number | null;
    maxListPrice: number | null;
    domMin: number | null;
    domMax: number | null;
    /** True once the agent has saved their own numbers over the seeds. */
    fromAgent: boolean;
    basis: string;
  };
  /** Sentences about what the numbers rest on. Always rendered. */
  notes: string[];
}

/** Mean over the values that exist. Returns null when none do. */
function mean(values: Array<number | null>): { v: number | null; n: number } {
  const nums = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!nums.length) return { v: null, n: 0 };
  return { v: nums.reduce((a, b) => a + b, 0) / nums.length, n: nums.length };
}

function toSummaryRow(c: CmaComparable): SummaryRow {
  const price = effectivePrice(c);
  const listPrice = c.originalListPrice ?? (c.listingStatus === "SOLD" ? null : c.price);
  const lotSqft = c.lotSize && c.lotSize > 0 ? Math.round(c.lotSize * SQFT_PER_ACRE) : null;
  return {
    id: c.id,
    photoUrl: c.photoUrl,
    address: c.address,
    beds: c.beds,
    baths: c.baths,
    listPrice,
    soldPrice: c.soldPrice,
    pricePct:
      c.soldPrice && c.originalListPrice && c.originalListPrice > 0
        ? (c.soldPrice / c.originalListPrice) * 100
        : null,
    sqft: c.sqft,
    pricePerSqft: price && c.sqft && c.sqft > 0 ? price / c.sqft : null,
    lotSqft,
    pricePerLotSqft: price && lotSqft ? price / lotSqft : null,
    dom: c.daysOnMarket,
    source: c.source,
    isManualEntry: c.isManualEntry,
  };
}

function averagesOf(rows: SummaryRow[]): SummaryAverages {
  const col = (k: keyof SummaryRow) => mean(rows.map((r) => r[k] as number | null));
  const lp = col("listPrice"), sp = col("soldPrice"), pc = col("pricePct");
  const sf = col("sqft"), pps = col("pricePerSqft");
  const ls = col("lotSqft"), ppl = col("pricePerLotSqft"), dm = col("dom");
  return {
    listPrice: lp.v, soldPrice: sp.v, pricePct: pc.v, sqft: sf.v,
    pricePerSqft: pps.v, lotSqft: ls.v, pricePerLotSqft: ppl.v, dom: dm.v,
    n: {
      listPrice: lp.n, soldPrice: sp.n, pricePct: pc.n, sqft: sf.n,
      pricePerSqft: pps.n, lotSqft: ls.n, pricePerLotSqft: ppl.n, dom: dm.n,
    },
  };
}

/** The price that represents a comp for valuation: sold if sold, else list. */
function effectivePrice(c: CmaComparable): number | null {
  if (c.listingStatus === "SOLD") return c.soldPrice ?? c.price;
  return c.price;
}

export function cmaResults(session: CmaSession, comps: CmaComparable[]): CmaResults {
  const buckets: BucketSummary[] = [];
  const notes: string[] = [];

  const allRows: SummaryRow[] = [];

  for (const status of ["ACTIVE", "PENDING", "SOLD", "OFF_MKT"] as CompStatus[]) {
    const rows = comps.filter((c) => c.listingStatus === status);
    const summaryRows = rows.map(toSummaryRow);
    allRows.push(...summaryRows);
    const prices = rows.map(effectivePrice).filter((n): n is number => typeof n === "number" && n > 0);
    const sortedPrices = [...prices].sort((a, b) => a - b);
    const ppsf = rows
      .map((c) => {
        const p = effectivePrice(c);
        return p && c.sqft && c.sqft > 0 ? p / c.sqft : null;
      })
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);

    /* List-to-sale only when a row has BOTH numbers. A sold comp whose list
       price was never recorded would otherwise read as a 100% ratio. */
    const ratios = rows
      .map((c) =>
        c.soldPrice && c.originalListPrice && c.originalListPrice > 0
          ? (c.soldPrice / c.originalListPrice) * 100
          : null,
      )
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);

    buckets.push({
      status,
      label: STATUS_LABEL[status],
      count: rows.length,
      minPrice: sortedPrices.length ? sortedPrices[0] : null,
      maxPrice: sortedPrices.length ? sortedPrices[sortedPrices.length - 1] : null,
      medianPrice: percentile(sortedPrices, 0.5),
      medianPricePerSqft: percentile(ppsf, 0.5),
      listToSalePct: status === "SOLD" ? percentile(ratios, 0.5) : null,
      missingSqft: rows.filter((c) => !c.sqft).length,
      rows: summaryRows,
      averages: averagesOf(summaryRows),
    });
  }

  const allPpsf = comps
    .map((c) => {
      const p = effectivePrice(c);
      return p && c.sqft && c.sqft > 0 ? p / c.sqft : null;
    })
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);

  const medianPpsf = percentile(allPpsf, 0.5);
  const lowPpsf = percentile(allPpsf, 0.25);
  const highPpsf = percentile(allPpsf, 0.75);

  let estimate: number | null = null;
  let estimateLow: number | null = null;
  let estimateHigh: number | null = null;
  let blocked: string | null = null;

  if (!comps.length) {
    blocked = "Nothing is selected yet. Pick comparables in steps 2 to 5 and the estimate appears here.";
  } else if (!session.subjectSqft || session.subjectSqft <= 0) {
    blocked =
      "The subject property has no square footage on file, and this estimate is price per square foot times " +
      "the home's own size. Add the square footage in step 1 and it computes.";
  } else if (medianPpsf === null) {
    blocked =
      "None of the selected comparables has a square footage on file, so there is no price per square foot to " +
      "apply. Sold comps taken from closed transactions carry a price but not a size — edit one to add it.";
  } else {
    estimate = Math.round(medianPpsf * session.subjectSqft);
    const lo = lowPpsf === null ? null : Math.round(lowPpsf * session.subjectSqft);
    const hi = highPpsf === null ? null : Math.round(highPpsf * session.subjectSqft);
    /* With a single sized comparable every quartile is that one number, and
       "$361,446 – $361,446" reads as a range that was computed when it was
       not. No band at all is the honest output; the note below says why. */
    if (lo !== null && hi !== null && hi > lo) {
      estimateLow = lo;
      estimateHigh = hi;
    }
  }

  const soldBucket = buckets.find((b) => b.status === "SOLD");
  if (!soldBucket || soldBucket.count === 0) {
    notes.push(
      "No sold comparables are selected. A CMA without solds shows what sellers are ASKING, not what buyers " +
        "have paid — the two diverge in a moving market.",
    );
  }
  const missing = comps.filter((c) => !c.sqft).length;
  if (missing > 0) {
    notes.push(
      `${missing} of ${comps.length} selected comparable${comps.length === 1 ? "" : "s"} ` +
        `ha${missing === 1 ? "s" : "ve"} no square footage, so ` +
        `${missing === 1 ? "it counts" : "they count"} toward the price ranges but not toward the estimate.`,
    );
  }
  if (estimate !== null && allPpsf.length === 1) {
    notes.push(
      "Only one comparable has a square footage, so the estimate rests on that single home and there is no " +
        "range around it. Add a size to the others and the band appears.",
    );
  }
  notes.push(
    "This is comparable arithmetic, not an automated valuation. It is the median price per square foot of the " +
      "comps chosen above, applied to the subject's size, with the band from the quartiles.",
  );

  const totals = averagesOf(allRows);

  /* Step 6's pricing fields are SEEDED from the comps and then owned by the
     agent. Once they have saved their own numbers the seeds stop being used —
     recomputing over a saved opinion would silently replace it the next time a
     comp changed. */
  const fromAgent =
    session.suggestedMinListPrice != null ||
    session.suggestedMaxListPrice != null ||
    session.estimatedDomMin != null ||
    session.estimatedDomMax != null;
  const seedMin = totals.listPrice != null ? Math.round(totals.listPrice) : null;
  const seedDom = totals.dom != null ? Math.round(totals.dom) : null;

  return {
    buckets,
    totals,
    suggested: {
      minListPrice: fromAgent ? session.suggestedMinListPrice : seedMin,
      maxListPrice: fromAgent ? session.suggestedMaxListPrice : null,
      domMin: fromAgent ? session.estimatedDomMin : seedDom,
      domMax: fromAgent ? session.estimatedDomMax : null,
      fromAgent,
      basis: fromAgent
        ? "Your own numbers, saved on this CMA."
        : seedMin != null
          ? `Seeded from the average list price of the ${totals.n.listPrice} selected comparable` +
            `${totals.n.listPrice === 1 ? "" : "s"} that carry one. Edit before publishing.`
          : "No comparable carries a list price yet, so there is nothing to seed this from.",
    },
    totalSelected: comps.length,
    pricePerSqft: medianPpsf === null ? null : Math.round(medianPpsf * 100) / 100,
    sizedCount: allPpsf.length,
    estimate,
    estimateLow,
    estimateHigh,
    estimateBlockedReason: blocked,
    notes,
  };
}
