/**
 * Fetch all Brivity people via Core API and write CSV for migration dry-run.
 * Read-only — does not modify CRM or Brivity.
 */
import "dotenv/config";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = resolve(ROOT, "brivity-migration-scratch");
mkdirSync(SCRATCH, { recursive: true });

const KEY = process.env.BRIVITY_API_KEY || "";
if (!KEY) {
  console.error("BRIVITY_API_KEY not set");
  process.exit(1);
}

const headers = {
  Authorization: `Token token=${KEY}`,
  Accept: "application/json",
};

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvRow(obj, cols) {
  return cols.map((c) => csvEscape(obj[c] ?? "")).join(",");
}

async function fetchAllPeople() {
  const jsonPath = resolve(SCRATCH, "brivity-api-people.json");
  if (existsSync(jsonPath)) {
    const cached = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (Array.isArray(cached) && cached.length > 0) {
      console.log(`Using cached ${cached.length} people from ${jsonPath}`);
      return cached;
    }
  }

  const res = await fetch("https://api.brivity.com/api/people?limit=5000", { headers });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Expected array from /api/people");
  writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`Fetched ${data.length} people → ${jsonPath}`);
  return data;
}

function personToRow(p) {
  return {
    "Contact ID": p.id ?? "",
    "First Name": (p.first_name ?? "").trim(),
    "Last Name": (p.last_name ?? "").trim(),
    Phone: p.phone_number ?? "",
    Email: p.email_address ?? "",
    Source: p.source ?? "",
    Status: p.status ?? "",
    Stage: p.stage ?? "",
    Type: p.lead_type ?? "",
    Notes: p.description ?? "",
    "Street Address": p.street_address ?? "",
    City: p.city ?? "",
    State: p.locality ?? "",
    Tags: Array.isArray(p.tags) ? p.tags.join("; ") : "",
  };
}

const CSV_COLUMNS = [
  "Contact ID",
  "First Name",
  "Last Name",
  "Phone",
  "Email",
  "Source",
  "Status",
  "Stage",
  "Type",
  "Notes",
  "Street Address",
  "City",
  "State",
  "Tags",
];

const people = await fetchAllPeople();
const rows = people.map(personToRow);
const csvPath = resolve(SCRATCH, "brivity-export-from-api.csv");
const lines = [CSV_COLUMNS.join(","), ...rows.map((r) => toCsvRow(r, CSV_COLUMNS))];
writeFileSync(csvPath, lines.join("\n"), "utf8");
console.log(`Wrote ${rows.length} rows → ${csvPath}`);
