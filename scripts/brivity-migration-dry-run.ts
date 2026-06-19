/**
 * Brivity CSV → Marco CRM gap-fill migration — Phase 0 inspect + Phase 1 dry-run ONLY.
 * Does not modify db.json. Does not create leads.
 *
 * Usage:
 *   npx ts-node scripts/brivity-migration-dry-run.ts --inspect --csv path/to/export.csv
 *   npx ts-node scripts/brivity-migration-dry-run.ts --csv path/to/export.csv [--db path/to/db.json] [--report brivity-migration-report.json]
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Column mapping — update EXACT header strings from --inspect output before dry-run.
// Keys are our Lead (or nested) field paths; values are CSV column headers as they appear in the file.
// Set to null until confirmed from the real export; dry-run also auto-suggests via aliases below.
// ---------------------------------------------------------------------------
export const CONFIRMED_COLUMN_MAP: Record<string, string | null> = {
  firstName: null,
  lastName: null,
  name: null,
  phone: null,
  email: null,
  source: null,
  brivityId: null,
  crmStatus: null,
  crmStage: null,
  crmIntent: null,
  crmNotes: null,
  propertyInquired: null,
  assignedUserName: null,
  "criteria.priceCap": null,
  "criteria.beds": null,
  "criteria.baths": null,
  "criteria.area": null,
  "criteria.timeline": null,
};

/** Header aliases — used for inspect suggestions only; not a substitute for confirming the real file. */
const HEADER_ALIASES: Record<string, string[]> = {
  firstName: ["First Name", "first_name", "First name", "firstname"],
  lastName: ["Last Name", "last_name", "Last name", "lastname", "Surname"],
  name: ["Name", "Full Name", "Contact Name", "Lead Name", "Display Name"],
  phone: [
    "Phone",
    "phone",
    "Phone Number",
    "Primary Phone",
    "Mobile",
    "Cell",
    "mobile",
    "primary_phone",
  ],
  email: ["Email", "email", "E-mail", "Email Address", "e-mail"],
  source: ["Source", "Lead Source", "source", "Lead Source Name"],
  brivityId: ["ID", "Contact ID", "Lead ID", "Brivity ID", "id", "contact_id", "person_id", "Contact Id"],
  crmStatus: ["Status", "Lead Status", "status", "Contact Status"],
  crmStage: ["Stage", "Pipeline Stage", "stage", "Pipeline"],
  crmIntent: ["Type", "Lead Type", "Intent", "lead_type", "Buyer/Seller", "Contact Type"],
  crmNotes: ["Notes", "Description", "note", "comments", "Comments", "Note"],
  propertyInquired: [
    "Property",
    "Property Address",
    "Address",
    "Street Address",
    "street_address",
    "Property Of Interest",
  ],
  assignedUserName: ["Agent", "Assigned Agent", "Primary Agent", "agent", "Assigned To"],
  "criteria.priceCap": ["Max Price", "Price Max", "Budget", "property_value", "Property Value", "Price Cap"],
  "criteria.beds": ["Beds", "Bedrooms", "beds"],
  "criteria.baths": ["Baths", "Bathrooms", "baths"],
  "criteria.area": ["Area", "City", "property_city", "Neighborhood", "Locality"],
  "criteria.timeline": ["Timeline", "Timeframe", "Buying Timeline"],
};

type LeadRecord = Record<string, unknown>;

type Bucket = "MATCHED" | "MATCHED_AMBIGUOUS" | "NO_MATCH";

interface CsvRow {
  rowIndex: number;
  raw: Record<string, string>;
}

interface MatchResult {
  bucket: Bucket;
  csvRow: CsvRow;
  matchedLeadIds: string[];
  matchKey?: "phone" | "email";
  proposedFills?: Record<string, unknown>;
}

interface Report {
  generatedAt: string;
  csvPath: string;
  dbPath: string;
  columnMapUsed: Record<string, string>;
  unmappedCsvHeaders: string[];
  summary: {
    totalCsvRows: number;
    matched: number;
    matchedAmbiguous: number;
    noMatch: number;
    fieldFillCounts: Record<string, number>;
  };
  matched: Array<{
    csvRowIndex: number;
    leadId: string;
    matchKey: string;
    proposedFills: Record<string, unknown>;
    csvSnapshot: Record<string, string>;
    leadSnapshot: { id: string; phone: string | null; email: string | null; name: string | null };
  }>;
  matchedAmbiguous: Array<{
    csvRowIndex: number;
    matchKey: string;
    candidateLeadIds: string[];
    csvSnapshot: Record<string, string>;
    candidates: Array<{ id: string; phone: string | null; email: string | null; name: string | null }>;
  }>;
  noMatch: Array<{
    csvRowIndex: number;
    csvSnapshot: Record<string, string>;
    normalizedPhone: string | null;
    normalizedEmail: string | null;
  }>;
}

function parseArgs(argv: string[]): {
  inspect: boolean;
  csv: string | null;
  db: string;
  report: string;
} {
  const args = argv.slice(2);
  let inspect = false;
  let csv: string | null = null;
  let db = resolve("brivity-migration-scratch/db.json");
  let report = resolve("brivity-migration-report.json");

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--inspect") inspect = true;
    else if (a === "--csv" && args[i + 1]) csv = resolve(args[++i]);
    else if (a === "--db" && args[i + 1]) db = resolve(args[++i]);
    else if (a === "--report" && args[i + 1]) report = resolve(args[++i]);
  }
  return { inspect, csv, db, report };
}

/** RFC 4180-ish CSV parser (handles quoted fields with commas and newlines). */
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && next === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const dataRows = nonEmpty.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
  return { headers, rows: dataRows };
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length > 11) {
    const tail = digits.slice(-10);
    if (tail.length === 10) return tail;
  }
  return null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  return e.includes("@") ? e : null;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    return Object.values(o).every((v) => isEmptyValue(v));
  }
  return false;
}

function suggestColumnMap(headers: string[]): {
  map: Record<string, string>;
  unmapped: string[];
  ambiguous: Array<{ field: string; headers: string[] }>;
} {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  const ambiguous: Array<{ field: string; headers: string[] }> = [];

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const confirmed = CONFIRMED_COLUMN_MAP[field];
    if (confirmed && headers.includes(confirmed)) {
      map[field] = confirmed;
      used.add(confirmed);
      continue;
    }
    const matches = headers.filter((h) => aliases.some((a) => a.toLowerCase() === h.toLowerCase()));
    if (matches.length === 1) {
      map[field] = matches[0];
      used.add(matches[0]);
    } else if (matches.length > 1) {
      ambiguous.push({ field, headers: matches });
    }
  }

  const unmapped = headers.filter((h) => !used.has(h));
  return { map, unmapped, ambiguous };
}

function resolveColumnMap(headers: string[]): Record<string, string> {
  const { map, ambiguous } = suggestColumnMap(headers);
  if (ambiguous.length > 0) {
    console.warn("\nAmbiguous column suggestions (confirm manually in CONFIRMED_COLUMN_MAP):");
    for (const a of ambiguous) {
      console.warn(`  ${a.field}: could be ${a.headers.map((h) => JSON.stringify(h)).join(" OR ")}`);
    }
  }
  return map;
}

function getCsvValue(row: Record<string, string>, col: string | undefined): string {
  if (!col) return "";
  return (row[col] ?? "").trim();
}

function buildNameFromRow(row: Record<string, string>, colMap: Record<string, string>): string | null {
  const direct = getCsvValue(row, colMap.name);
  if (direct) return direct;
  const first = getCsvValue(row, colMap.firstName);
  const last = getCsvValue(row, colMap.lastName);
  const combined = [first, last].filter(Boolean).join(" ").trim();
  return combined || null;
}

function mapBrivityStatus(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const table: Record<string, string> = {
    new: "new",
    hot: "hot",
    nurture: "nurture",
    watch: "watch",
    archived: "dead",
    unqualified: "dead",
    dead: "dead",
    unresponsive: "unresponsive",
  };
  return table[s] ?? raw.trim();
}

function mapBrivityStage(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (!s) return null;
  const allowed = new Set([
    "new",
    "hot",
    "warm",
    "cold",
    "pending",
    "appointment_set",
    "showing_set",
    "under_contract",
    "closed",
  ]);
  return allowed.has(s) ? s : raw.trim();
}

function mapBrivityIntent(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("buy") && s.includes("sell")) return "buyer_seller";
  if (s.includes("sell")) return "seller";
  if (s.includes("buy")) return "buyer";
  return raw.trim();
}

function extractProposedValues(
  row: Record<string, string>,
  colMap: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const name = buildNameFromRow(row, colMap);
  if (name) out.name = name;

  const phone = normalizePhone(getCsvValue(row, colMap.phone));
  if (phone) out.phone = phone;

  const email = normalizeEmail(getCsvValue(row, colMap.email));
  if (email) out.email = email;

  const source = getCsvValue(row, colMap.source);
  if (source) out.source = source;

  const brivityId = getCsvValue(row, colMap.brivityId);
  if (brivityId) out.brivityId = brivityId;

  const status = mapBrivityStatus(getCsvValue(row, colMap.crmStatus));
  if (status) out.crmStatus = status;

  const stage = mapBrivityStage(getCsvValue(row, colMap.crmStage));
  if (stage) out.crmStage = stage;

  const intent = mapBrivityIntent(getCsvValue(row, colMap.crmIntent));
  if (intent) out.crmIntent = intent;

  const notes = getCsvValue(row, colMap.crmNotes);
  if (notes) out.crmNotes = notes;

  const property = getCsvValue(row, colMap.propertyInquired);
  if (property) out.propertyInquired = property;

  const agent = getCsvValue(row, colMap.assignedUserName);
  if (agent) out.assignedUserName = agent;

  const criteria: Record<string, unknown> = {};
  const priceRaw = getCsvValue(row, colMap["criteria.priceCap"]);
  if (priceRaw) {
    const n = Number(priceRaw.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) criteria.priceCap = n;
  }
  const beds = getCsvValue(row, colMap["criteria.beds"]);
  if (beds) criteria.beds = beds;
  const baths = getCsvValue(row, colMap["criteria.baths"]);
  if (baths) criteria.baths = baths;
  const area = getCsvValue(row, colMap["criteria.area"]);
  if (area) criteria.area = area;
  const timeline = getCsvValue(row, colMap["criteria.timeline"]);
  if (timeline) criteria.timeline = timeline;
  if (Object.keys(criteria).length > 0) out.criteria = criteria;

  return out;
}

function computeGapFills(lead: LeadRecord, proposed: Record<string, unknown>): Record<string, unknown> {
  const fills: Record<string, unknown> = {};

  for (const [key, csvValue] of Object.entries(proposed)) {
    if (key === "criteria" && csvValue && typeof csvValue === "object") {
      const existing = lead.criteria as Record<string, unknown> | null | undefined;
      const partial: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(csvValue as Record<string, unknown>)) {
        if (isEmptyValue(cv)) continue;
        const cur = existing?.[ck];
        if (isEmptyValue(cur)) partial[ck] = cv;
      }
      if (Object.keys(partial).length > 0) {
        fills.criteria = { ...(existing ?? {}), ...partial };
      }
      continue;
    }

    if (isEmptyValue(csvValue)) continue;
    const current = lead[key];
    if (isEmptyValue(current)) fills[key] = csvValue;
  }

  return fills;
}

function buildIndexes(leadsById: Record<string, LeadRecord>): {
  byPhone: Map<string, string[]>;
  byEmail: Map<string, string[]>;
} {
  const byPhone = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();

  for (const [id, lead] of Object.entries(leadsById)) {
    const p = normalizePhone(lead.phone as string | null);
    if (p) {
      const arr = byPhone.get(p) ?? [];
      arr.push(id);
      byPhone.set(p, arr);
    }
    const e = normalizeEmail(lead.email as string | null);
    if (e) {
      const arr = byEmail.get(e) ?? [];
      arr.push(id);
      byEmail.set(e, arr);
    }
  }
  return { byPhone, byEmail };
}

function matchRow(
  csvRow: CsvRow,
  colMap: Record<string, string>,
  indexes: ReturnType<typeof buildIndexes>,
): { bucket: Bucket; leadIds: string[]; matchKey?: "phone" | "email" } {
  const phone = normalizePhone(getCsvValue(csvRow.raw, colMap.phone));
  const email = normalizeEmail(getCsvValue(csvRow.raw, colMap.email));

  if (phone) {
    const ids = indexes.byPhone.get(phone) ?? [];
    if (ids.length === 1) return { bucket: "MATCHED", leadIds: ids, matchKey: "phone" };
    if (ids.length > 1) return { bucket: "MATCHED_AMBIGUOUS", leadIds: ids, matchKey: "phone" };
  }

  if (email) {
    const ids = indexes.byEmail.get(email) ?? [];
    if (ids.length === 1) return { bucket: "MATCHED", leadIds: ids, matchKey: "email" };
    if (ids.length > 1) return { bucket: "MATCHED_AMBIGUOUS", leadIds: ids, matchKey: "email" };
  }

  return { bucket: "NO_MATCH", leadIds: [] };
}

function leadSnapshot(lead: LeadRecord): {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
} {
  return {
    id: String(lead.id),
    phone: (lead.phone as string) ?? null,
    email: (lead.email as string) ?? null,
    name: (lead.name as string) ?? null,
  };
}

function runInspect(csvPath: string, dbPath: string): void {
  const csvText = readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
  const { headers, rows } = parseCsv(csvText);
  const { map, unmapped, ambiguous } = suggestColumnMap(headers);

  console.log("\n=== PHASE 0 — CSV INSPECTION ===\n");
  console.log(`File: ${csvPath}`);
  console.log(`Total data rows: ${rows.length}\n`);

  console.log("--- Header row (exact) ---");
  console.log(headers.join(","));

  console.log("\n--- First 5 data rows (exact) ---");
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const cells = headers.map((h) => rows[i][h] ?? "");
    console.log(`Row ${i + 1}: ${cells.map((c) => JSON.stringify(c)).join(",")}`);
  }

  console.log("\n--- Suggested column map (confirm against real headers) ---");
  for (const [field, header] of Object.entries(map)) {
    console.log(`  ${field} ← ${JSON.stringify(header)}`);
  }
  if (ambiguous.length) {
    console.log("\n--- Ambiguous (need manual pick) ---");
    for (const a of ambiguous) {
      console.log(`  ${a.field}: ${a.headers.map((h) => JSON.stringify(h)).join(" | ")}`);
    }
  }
  if (unmapped.length) {
    console.log("\n--- Unmapped CSV columns ---");
    for (const h of unmapped) console.log(`  ? ${JSON.stringify(h)}`);
  }

  if (existsSync(dbPath)) {
    const db = JSON.parse(readFileSync(dbPath, "utf8")) as { leadsById: Record<string, LeadRecord> };
    const leads = Object.values(db.leadsById).filter((l) => l.phone);
    console.log("\n--- Phone format samples (CRM vs CSV) ---");
    console.log(`CRM leads with phone: ${leads.length} (all stored as 10-digit strings in prod copy)`);
    for (const l of leads.slice(0, 5)) {
      console.log(`  CRM lead ${l.id}: phone=${JSON.stringify(l.phone)}`);
    }
    const csvPhones = rows
      .slice(0, 10)
      .map((r) => getCsvValue(r, map.phone))
      .filter(Boolean);
    console.log("\n  CSV phone samples (raw → normalized):");
    for (const raw of csvPhones.slice(0, 8)) {
      console.log(`    raw=${JSON.stringify(raw)} → normalized=${JSON.stringify(normalizePhone(raw))}`);
    }
  } else {
    console.log(`\n(DB not found at ${dbPath} — skipped phone comparison)`);
  }
}

function runDryRun(csvPath: string, dbPath: string, reportPath: string): Report {
  if (!existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  if (!existsSync(dbPath)) throw new Error(`db.json not found: ${dbPath}`);

  const csvText = readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
  const { headers, rows } = parseCsv(csvText);
  const colMap = resolveColumnMap(headers);
  const mappedHeaders = new Set(Object.values(colMap));
  const unmappedCsvHeaders = headers.filter((h) => !mappedHeaders.has(h));

  const db = JSON.parse(readFileSync(dbPath, "utf8")) as { leadsById: Record<string, LeadRecord> };
  const indexes = buildIndexes(db.leadsById);

  const report: Report = {
    generatedAt: new Date().toISOString(),
    csvPath,
    dbPath,
    columnMapUsed: colMap,
    unmappedCsvHeaders,
    summary: {
      totalCsvRows: rows.length,
      matched: 0,
      matchedAmbiguous: 0,
      noMatch: 0,
      fieldFillCounts: {},
    },
    matched: [],
    matchedAmbiguous: [],
    noMatch: [],
  };

  rows.forEach((raw, idx) => {
    const csvRow: CsvRow = { rowIndex: idx + 1, raw };
    const { bucket, leadIds, matchKey } = matchRow(csvRow, colMap, indexes);
    const proposed = extractProposedValues(raw, colMap);

    if (bucket === "MATCHED" && leadIds[0]) {
      const lead = db.leadsById[leadIds[0]];
      const proposedFills = computeGapFills(lead, proposed);
      report.summary.matched++;
      report.matched.push({
        csvRowIndex: csvRow.rowIndex,
        leadId: leadIds[0],
        matchKey: matchKey ?? "phone",
        proposedFills,
        csvSnapshot: raw,
        leadSnapshot: leadSnapshot(lead),
      });
      for (const key of Object.keys(proposedFills)) {
        report.summary.fieldFillCounts[key] = (report.summary.fieldFillCounts[key] ?? 0) + 1;
      }
    } else if (bucket === "MATCHED_AMBIGUOUS") {
      report.summary.matchedAmbiguous++;
      report.matchedAmbiguous.push({
        csvRowIndex: csvRow.rowIndex,
        matchKey: matchKey ?? "phone",
        candidateLeadIds: leadIds,
        csvSnapshot: raw,
        candidates: leadIds.map((id) => leadSnapshot(db.leadsById[id])),
      });
    } else {
      report.summary.noMatch++;
      report.noMatch.push({
        csvRowIndex: csvRow.rowIndex,
        csvSnapshot: raw,
        normalizedPhone: normalizePhone(getCsvValue(raw, colMap.phone)),
        normalizedEmail: normalizeEmail(getCsvValue(raw, colMap.email)),
      });
    }
  });

  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}

function printSummary(report: Report, reportPath: string): void {
  const s = report.summary;
  console.log("\n=== PHASE 1 — DRY RUN SUMMARY ===\n");
  console.log(`CSV rows processed: ${s.totalCsvRows}`);
  console.log(`MATCHED:            ${s.matched}`);
  console.log(`MATCHED_AMBIGUOUS:  ${s.matchedAmbiguous}`);
  console.log(`NO_MATCH:           ${s.noMatch}`);

  console.log("\n--- Gap fills on MATCHED rows (fields currently empty on lead) ---");
  const sorted = Object.entries(s.fieldFillCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) console.log("  (none — CRM already has values or CSV has no mapped data)");
  for (const [field, count] of sorted) {
    console.log(`  ${count} lead(s) would get ${field} filled in`);
  }

  if (report.matchedAmbiguous.length > 0) {
    console.log(`\n--- MATCHED_AMBIGUOUS (${report.matchedAmbiguous.length}) — manual review ---`);
    for (const row of report.matchedAmbiguous.slice(0, 20)) {
      console.log(
        `  CSV row ${row.csvRowIndex} via ${row.matchKey}: candidates=${row.candidateLeadIds.join(", ")} phone=${JSON.stringify(row.csvSnapshot[report.columnMapUsed.phone ?? ""] ?? "")}`,
      );
    }
    if (report.matchedAmbiguous.length > 20) {
      console.log(`  ... and ${report.matchedAmbiguous.length - 20} more in report file`);
    }
  }

  if (report.noMatch.length > 0) {
    console.log(`\n--- NO_MATCH preview (first 10 of ${report.noMatch.length}) ---`);
    for (const row of report.noMatch.slice(0, 10)) {
      const name =
        row.csvSnapshot[report.columnMapUsed.name ?? ""] ||
        [row.csvSnapshot[report.columnMapUsed.firstName ?? ""], row.csvSnapshot[report.columnMapUsed.lastName ?? ""]]
          .filter(Boolean)
          .join(" ");
      console.log(
        `  CSV row ${row.csvRowIndex}: ${name || "(no name)"} phone=${row.normalizedPhone ?? "—"} email=${row.normalizedEmail ?? "—"}`,
      );
    }
  }

  if (report.unmappedCsvHeaders.length > 0) {
    console.log("\n--- Unmapped CSV columns (not used for gap fill) ---");
    console.log(`  ${report.unmappedCsvHeaders.map((h) => JSON.stringify(h)).join(", ")}`);
  }

  console.log(`\nFull report file: ${reportPath}`);
}

function main(): void {
  const { inspect, csv, db, report } = parseArgs(process.argv);

  if (!csv) {
    console.error(
      "Usage:\n  npx ts-node scripts/brivity-migration-dry-run.ts --inspect --csv <path>\n  npx ts-node scripts/brivity-migration-dry-run.ts --csv <path> [--db <path>] [--report <path>]",
    );
    process.exit(1);
  }

  if (inspect) {
    runInspect(csv, db);
    return;
  }

  const result = runDryRun(csv, db, report);
  printSummary(result, report);
  console.log(`Report file: ${resolve(report)}`);
}

main();
