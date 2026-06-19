/**
 * Extended read-only Brivity API probe — auth variants and Core API paths.
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../brivity-migration-scratch/api-probe-extended.json");
mkdirSync(resolve(dirname(OUT)), { recursive: true });

const KEY = process.env.BRIVITY_API_KEY || "";
const authVariants = [
  { name: "raw", value: KEY },
  { name: "Token token", value: `Token token=${KEY}` },
  { name: "Bearer", value: `Bearer ${KEY}` },
];

const urls = [
  "https://api.brivity.com/api/v2/roster",
  "https://api.brivity.com/api/v2/leads",
  "https://api.brivity.com/api/people",
  "https://api.brivity.com/api/v2/people",
  "https://api.brivity.com/api/contacts",
  "https://app.brivity.com/api/v2/roster",
  "https://app.brivity.com/api/v2/leads",
  "https://app.brivityidx.com/api/contacts",
];

const results = [];
for (const url of urls) {
  for (const auth of authVariants) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: auth.value, Accept: "application/json" },
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* */
      }
      const entry = {
        url,
        auth: auth.name,
        status: res.status,
        preview: text.slice(0, 500),
        arrayLen: Array.isArray(json) ? json.length : undefined,
        keys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json) : undefined,
      };
      results.push(entry);
      if (res.status !== 406 && res.status !== 401 && res.status !== 410) {
        console.log(`HIT ${auth.name} ${url} -> ${res.status} ${entry.arrayLen ?? entry.keys?.join(",")}`);
      }
    } catch (e) {
      results.push({ url, auth: auth.name, error: String(e) });
    }
  }
}

writeFileSync(OUT, JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
console.log(`Wrote ${results.length} probes to ${OUT}`);

// Summarize non-error responses
const interesting = results.filter((r) => r.status && r.status < 400 && r.status !== 406);
console.log(`Interesting (${interesting.length}):`);
for (const r of interesting.slice(0, 15)) {
  console.log(`  ${r.status} ${r.auth} ${r.url} len=${r.arrayLen ?? "—"}`);
}
