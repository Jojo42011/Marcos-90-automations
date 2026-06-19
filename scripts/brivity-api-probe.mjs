/**
 * Read-only probe: discover if Brivity IDX API can list/export contacts.
 * Writes results to brivity-migration-scratch/api-probe-results.json (no secrets).
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../brivity-migration-scratch");
mkdirSync(OUT_DIR, { recursive: true });

const BASE = (process.env.BRIVITY_BASE_URL || "https://app.brivityidx.com/api").replace(/\/$/, "");
const KEY = process.env.BRIVITY_API_KEY || "";

if (!KEY) {
  console.error("BRIVITY_API_KEY not set in .env");
  process.exit(1);
}

const headers = {
  Authorization: KEY,
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function probe(label, url, opts = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const summary = {
      label,
      url,
      status: res.status,
      ok: res.ok,
      ms: Date.now() - started,
      contentType: res.headers.get("content-type"),
      bodyPreview: text.slice(0, 2000),
      jsonType: json === null ? "non-json" : Array.isArray(json) ? `array[${json.length}]` : typeof json,
      jsonKeys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).slice(0, 20) : undefined,
      arrayLength: Array.isArray(json) ? json.length : undefined,
      firstItemKeys:
        Array.isArray(json) && json[0] && typeof json[0] === "object" ? Object.keys(json[0]) : undefined,
    };
    console.log(`${label}: ${res.status} ${summary.jsonType}${summary.arrayLength != null ? ` len=${summary.arrayLength}` : ""}`);
    return { summary, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${label}: ERROR ${msg}`);
    return { summary: { label, url, error: msg }, json: null };
  }
}

const paths = [
  "/contacts",
  "/contacts?page=1",
  "/contacts?page=1&per_page=100",
  "/contacts?limit=100",
  "/contacts?offset=0&limit=100",
  "/contacts/export",
  "/contacts/export.csv",
  "/leads",
  "/v2/leads",
];

const results = [];
for (const p of paths) {
  results.push(await probe(p, `${BASE}${p}`));
}

// Core API hosts (different product surface)
const coreBases = ["https://app.brivity.com/api", "https://api.brivity.com"];
for (const core of coreBases) {
  results.push(await probe(`core roster ${core}`, `${core}/v2/roster`));
  results.push(await probe(`core leads ${core}`, `${core}/v2/leads`));
}

const outPath = resolve(OUT_DIR, "api-probe-results.json");
writeFileSync(
  outPath,
  JSON.stringify(
    {
      probedAt: new Date().toISOString(),
      baseUrl: BASE,
      results: results.map((r) => r.summary),
    },
    null,
    2,
  ),
  "utf8",
);

// If we got a contact list, save full payload separately (redacted)
const listHit = results.find(
  (r) =>
    r.summary.ok &&
    (r.summary.arrayLength > 0 ||
      (r.json && typeof r.json === "object" && (r.json.contacts?.length || r.json.data?.length))),
);

if (listHit?.json) {
  let contacts = [];
  if (Array.isArray(listHit.json)) contacts = listHit.json;
  else if (Array.isArray(listHit.json.contacts)) contacts = listHit.json.contacts;
  else if (Array.isArray(listHit.json.data)) contacts = listHit.json.data;

  if (contacts.length > 0) {
    const exportPath = resolve(OUT_DIR, "brivity-api-contacts.json");
    writeFileSync(exportPath, JSON.stringify(contacts, null, 2), "utf8");
    console.log(`\nSaved ${contacts.length} contacts to ${exportPath}`);
  }
}

console.log(`\nProbe summary written to ${outPath}`);
