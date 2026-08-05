/**
 * Assertions for the automation-spec build (Aug 2026): honest skip-trace,
 * luxury content search, baths in the matcher, lead CSV import, client
 * shortlist + branded PDF. Run AFTER `npm run build`:
 *   node scripts/verify-spec-automations.mjs
 */
import { readFileSync } from "fs";
import assert from "assert";

let passed = 0; const failures = [];
function check(name, fn) { try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
async function checkAsync(name, fn) { try { await fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/* ── 1. Skip trace can no longer invent a person ─────────────────────────── */
await checkAsync("forewarn: unconfigured lookup finds NOTHING and says why", async () => {
  const saved = process.env.FOREWARN_API_KEY;
  delete process.env.FOREWARN_API_KEY;
  try {
    const { runSkipTrace } = await import("../dist/src/integrations/forewarn.js");
    const r = await runSkipTrace("(210) 555-0134");
    assert.equal(r.foundName, undefined, "must not fabricate a name");
    assert.equal(r.foundEmail, undefined);
    assert.equal(r.foundAddress, undefined);
    assert.equal(r.source, "not-configured");
    assert.equal(r.confidence, "low");
    assert(/No lookup ran/i.test(r.note || ""), "must say no lookup ran");
  } finally {
    if (saved !== undefined) process.env.FOREWARN_API_KEY = saved;
  }
});
check("forewarn: the mock is gone as CODE (the doc comment naming its history may stay)", () => {
  const s = read("src/integrations/forewarn.ts");
  assert(!/mockSkipTraceResult/.test(s), "the mock function must not exist");
  assert(!/foundName:\s*"/.test(s.replace(/typeof data\.name === "string" \? data\.name : undefined/, "")),
    "no literal foundName value may be returned");
  assert(/used by Subscriber[\s*\n]+only/i.test(s), "the compliance constraint must be documented at the integration");
});

/* ── 2. Matcher uses baths ───────────────────────────────────────────────── */
check("matcher: criteria.baths reaches the query", () => {
  assert(/minBaths: c\?\.baths \|\| undefined/.test(read("src/core/listingMatch.ts")));
});

/* ── 3. Luxury content search ────────────────────────────────────────────── */
check("luxury: scheduled daily alongside the other agents", () => {
  const s = read("src/app/jobs.ts");
  assert(/scheduleLuxurySweep\(\)/.test(s));
});
check("luxury: the sweep sees the WHOLE market, not the API's clamped page", () => {
  const agent = read("src/agents/luxuryContent/index.ts");
  assert(/allActiveListingsOver\(MIN_PRICE\)/.test(agent));
  assert(!/searchListings\(/.test(agent), "searchListings clamps to 200 and made 200 look like all 1,059 in production");
  assert(/No clamp here, by design and by name/.test(read("src/core/listingsStore.ts")));
});
check("luxury: heuristic is word-bounded (bare /spa/ scored 'Spacious home')", () => {
  const s = read("src/agents/luxuryContent/index.ts");
  assert(/\\bpool\\b\|\\bspa\\b/.test(s));
});
check("luxury: the fallback judge is labeled, never dressed as an opinion", () => {
  const s = read("src/agents/luxuryContent/index.ts");
  assert(/"heuristic"/.test(s) && /scoreSource/.test(s));
  assert(/never trust an invented key/.test(s), "scorer must ignore keys the model made up");
});
check("luxury: filmed/dismissed never resurface; shortlist refills, never churns", () => {
  const s = read("src/agents/luxuryContent/index.ts");
  assert(/NOT IN \('filmed','dismissed','off_market'\)/.test(read("src/core/luxuryContentStore.ts")));
  assert(/Never evicts on score/.test(s));
});
check("luxury: routes + Harvey tool exist", () => {
  const srv = read("src/server.ts");
  assert(/app\.get\("\/api\/luxury\/shortlist"/.test(srv));
  assert(/app\.post\("\/api\/luxury\/run"/.test(srv));
  assert(/app\.post\("\/api\/luxury\/:key\/status"/.test(srv));
  const tools = read("src/harvey/tools.ts");
  assert(/get_luxury_shortlist/.test(tools));
  assert(/judgedBy/.test(tools), "Harvey must name which judge scored a home");
});

/* ── 4. Lead CSV import ──────────────────────────────────────────────────── */
await checkAsync("leads: plan dedupes in-file, skips identity-less rows, normalizes phones", async () => {
  const { planLeadImport } = await import("../dist/src/core/leadCsvImport.js");
  const csv = [
    "First Name,Last Name,Phone,Email,Notes",
    "Test,Alpha,(210) 555-9901,a@example.com,note",
    "Test,Alpha,2105559901,a@example.com,dupe",
    ",,,,nothing",
  ].join("\n");
  const plan = await planLeadImport(csv, { defaultSource: "Mojo" });
  assert.equal(plan.create, 1);
  assert.equal(plan.skip, 2);
  const row = plan.rows[0];
  assert.equal(row.phone, "+12105559901");
  assert.equal(row.name, "Test Alpha");
});
check("leads: writes go through upsertLeadQuiet, never createLead", () => {
  const s = read("src/core/leadCsvImport.ts");
  assert(/upsertLeadQuiet/.test(s));
  assert(!/\bcreateLead\(/.test(s), "createLead fires texts and drips — a bulk file must never call it");
});
check("leads: route registered with dry-run default + CRM button wired", () => {
  const srv = read("src/server.ts");
  assert(/app\.post\("\/api\/leads\/import-csv"/.test(srv));
  assert(/body\.apply !== true/.test(srv));
  const crm = read("public/crm-brivity.html");
  assert(/leadImportBtn/.test(crm) && /importLeadCsv/.test(crm));
  assert(/source automations key off/.test(crm) || /what automations key off/.test(crm), "the source prompt must explain why it matters");
});

/* ── 5. Shortlist + PDF ──────────────────────────────────────────────────── */
await checkAsync("pdf: builds a real document, survives hostile MLS text, degrades photos", async () => {
  const { buildPropertyPdf } = await import("../dist/src/core/propertyPdf.js");
  const entry = (key, remarks) => ({
    listingKey: key, note: null, addedAt: new Date().toISOString(), position: 0, gone: false,
    listing: {
      listingKey: key, mlsNumber: "123", status: "Active", listPrice: 500000, closePrice: null,
      street: "1 Test → Lane", city: "San Antonio", state: "TX", postalCode: "78201",
      beds: 3, baths: 2, livingArea: 1800, lotSize: null, yearBuilt: 2020, propertyType: null,
      subdivision: "Test — Estates", listAgent: null, listOffice: null,
      photoUrl: "http://127.0.0.1:1/dead.jpg", publicRemarks: remarks,
      modificationTs: null, listedAt: null, closedAt: null, syncedAt: new Date().toISOString(),
    },
  });
  const bytes = await buildPropertyPdf({
    clientName: "Ünïcode → Client",
    entries: [entry("A", "Curly “quotes” … em—dash → arrow ☃ snowman")],
    linkOrigin: "https://example.com",
  });
  assert(bytes.length > 500, "suspiciously small");
  const head = Buffer.from(bytes.slice(0, 5)).toString();
  assert.equal(head, "%PDF-");
});
check("pdf: winAnsi sanitizer sits in front of every text draw", () => {
  const s = read("src/core/propertyPdf.ts");
  assert(/function winAnsiSafe/.test(s));
  assert(/winAnsiSafe\(text\)/.test(s), "wrapText must sanitize");
  assert(!/"View full listing →"/.test(s), "the arrow that failed the whole document must stay gone");
});
check("favorites: store joins live listing facts and flags gone homes", () => {
  const s = read("src/core/favoritesStore.ts");
  assert(/gone: !listing/.test(s));
  assert(/getListing\(r\.listing_key\)/.test(s));
});
check("favorites: routes + MLS-page UI wired", () => {
  const srv = read("src/server.ts");
  assert(/app\.get\("\/api\/leads\/:id\/favorites"/.test(srv));
  assert(/app\.post\("\/api\/leads\/:id\/favorites"/.test(srv));
  assert(/app\.delete\("\/api\/leads\/:id\/favorites\/:key"/.test(srv));
  assert(/app\.get\("\/api\/leads\/:id\/property-pdf"/.test(srv));
  assert(/no shortlisted homes yet/.test(srv), "empty shortlist must 404 with words, not a blank PDF");
  const html = read("public/listings.html");
  assert(/data-fav=/.test(html) && /toggleFavorite/.test(html) && /property-pdf/.test(html));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  ✗ " + f); process.exit(1); }
