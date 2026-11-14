import { getListing } from "../core/listingsStore.js";

export type PropertyFacts = Partial<Record<PropertyFieldKey, string>>;

/**
 * Listing details a caller can show on the session card. Header aliases are
 * matched case-insensitively against Mojo, MLS and generic CSV exports; a
 * column that is not present simply leaves the field empty.
 */
export const PROPERTY_FIELDS = [
  { key: "status", label: "Listing status", headers: ["status", "listing status", "mls status"] },
  {
    key: "expireDate",
    label: "Expired / canceled on",
    headers: ["expired date", "expiration date", "expire date", "expiration", "expired", "cancel date", "canceled date", "cancelled date", "off market date", "withdrawn date"],
  },
  { key: "listPrice", label: "List price", headers: ["list price", "listing price", "price", "original list price", "last list price"] },
  { key: "daysOnMarket", label: "Days on market", headers: ["dom", "days on market", "cdom", "cumulative dom"] },
  { key: "mlsId", label: "MLS #", headers: ["mls #", "mls", "mls number", "mls id", "mls#", "listing id", "ml#", "ml #"] },
  { key: "propertyType", label: "Property type", headers: ["property type", "type", "prop type", "property subtype"] },
  { key: "beds", label: "Beds", headers: ["beds", "bedrooms", "br", "bd"] },
  { key: "baths", label: "Baths", headers: ["baths", "bathrooms", "ba", "total baths"] },
  { key: "sqft", label: "Sq ft", headers: ["sqft", "sq ft", "square feet", "living area", "sqft living", "building sqft"] },
  { key: "yearBuilt", label: "Year built", headers: ["year built", "yr built", "built"] },
  { key: "subdivision", label: "Subdivision", headers: ["subdivision", "subdivision name", "neighborhood", "community"] },
  { key: "mlsArea", label: "MLS area", headers: ["mls area", "area", "market area"] },
  { key: "listAgent", label: "Listing agent", headers: ["listing agent", "list agent", "list agent name", "agent name", "agent"] },
  { key: "listOffice", label: "Brokerage", headers: ["listing office", "list office", "list office name", "brokerage", "office", "office name"] },
  { key: "ownerName", label: "Owner name", headers: ["owner name", "owner", "owner 1", "owner full name"] },
  { key: "taxId", label: "Tax ID", headers: ["tax id", "parcel", "parcel id", "parcel number", "apn", "tax id number", "property id"] },
] as const;

export type PropertyFieldKey = (typeof PROPERTY_FIELDS)[number]["key"];

export const PROPERTY_CATALOG = PROPERTY_FIELDS.map(({ key, label }) => ({ key, label }));
export const DEFAULT_PROPERTY_FIELDS: PropertyFieldKey[] = [
  "status",
  "expireDate",
  "listPrice",
  "daysOnMarket",
  "mlsId",
  "propertyType",
  "subdivision",
  "listAgent",
  "listOffice",
  "ownerName",
];
const KEYS = new Set<string>(PROPERTY_FIELDS.map((f) => f.key));

export function isPropertyField(key: unknown): key is PropertyFieldKey {
  return typeof key === "string" && KEYS.has(key);
}

const clean = (v: unknown) => String(v ?? "").trim().slice(0, 200);

/** Map lower-cased CSV headers to column indexes once per import. */
export function propertyColumns(headers: string[]): Array<[PropertyFieldKey, number]> {
  const out: Array<[PropertyFieldKey, number]> = [];
  for (const f of PROPERTY_FIELDS) {
    const i = headers.findIndex((h) => (f.headers as readonly string[]).includes(h));
    if (i >= 0) out.push([f.key, i]);
  }
  return out;
}

export function propertyFromRow(row: string[], columns: Array<[PropertyFieldKey, number]>): PropertyFacts | undefined {
  const facts: PropertyFacts = {};
  for (const [key, i] of columns) {
    const v = clean(row[i]);
    if (v) facts[key] = v;
  }
  return Object.keys(facts).length ? facts : undefined;
}

const fmtStatus = (s: string | null) =>
  s ? s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "";

/**
 * Facts from the connected MLS for a lead the CRM has matched to exactly one
 * listing. Nothing is inferred for leads without that match.
 */
export function propertyFromMls(mlsListingKey: string | null | undefined): PropertyFacts | undefined {
  if (!mlsListingKey) return undefined;
  let l: ReturnType<typeof getListing>;
  try {
    l = getListing(mlsListingKey);
  } catch {
    return undefined;
  }
  if (!l) return undefined;
  const facts: PropertyFacts = {};
  const set = (k: PropertyFieldKey, v: unknown) => {
    const s = clean(v);
    if (s) facts[k] = s;
  };
  set("status", fmtStatus(l.status));
  set("listPrice", l.listPrice);
  set("mlsId", l.mlsNumber);
  set("propertyType", l.propertyType);
  set("beds", l.beds);
  set("baths", l.baths);
  set("sqft", l.livingArea);
  set("yearBuilt", l.yearBuilt);
  set("subdivision", l.subdivision);
  set("listAgent", l.listAgent);
  set("listOffice", l.listOffice);
  return Object.keys(facts).length ? facts : undefined;
}
