/**
 * Expiration tracking + automated sheet sync — source assertions and
 * functional checks. Run AFTER `npm run build`:
 *   node scripts/verify-transactions-sync.mjs
 *
 * The full live pass (server + real browser driving the CRM's Transactions
 * tab) was run at build time; this suite is the fast regression net that
 * keeps the wiring from being silently deleted, plus functional checks on
 * everything that runs without a server.
 */
import { readFileSync } from "fs";
import assert from "assert";

let passed = 0; const failures = [];
function check(name, fn) { try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
async function checkAsync(name, fn) { try { await fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/* ── Expiration: store ───────────────────────────────────────────────────── */
const storeSrc = read("src/core/transactionsStore.ts");
check("store: expiration is a real column, read and written everywhere", () => {
  assert(/\["expiration", "TEXT"\]/.test(storeSrc), "migration missing");
  assert(/expiration: row\.expiration \? String\(row\.expiration\) : undefined/.test(storeSrc), "rowToTransaction missing");
  assert(/expiration\?: string/.test(storeSrc), "interface missing");
  // Both INSERT and UPDATE must carry it — one without the other silently
  // drops the value on whichever path runs.
  assert(/gci, expiration, /.test(storeSrc), "INSERT column list missing expiration");
  assert(/gci = \?, expiration = \?, /.test(storeSrc), "UPDATE set list missing expiration");
  const args = storeSrc.match(/\.expiration \?\? null/g) || [];
  assert.equal(args.length, 2, `expected expiration bound in both statements, found ${args.length}`);
});

/* ── Expiration: importer (functional) ───────────────────────────────────── */
await checkAsync("importer: the Expiration column lands as an ISO date", async () => {
  const { planTransactionImport } = await import("../dist/src/core/transactionImport.js");
  const csv = [
    "Address / Title,Type,Status,MLS#,Listing Price,Expiration,Close Price,GCI,Close Date,Source",
    '"1 Test St, San Antonio, TX",S,Active,111,"$300,000",07-25-2026,$0,$0,,Mojo',
    '"2 Test St, San Antonio, TX",S,Active,222,"$300,000",,$0,$0,,Mojo',
  ].join("\n");
  const plan = planTransactionImport(csv);
  assert.equal(plan.rows[0].transaction.expiration, "2026-07-25");
  assert.equal(plan.rows[1].transaction.expiration, undefined, "empty must stay empty, not be guessed");
});

/* ── Expiration: API + UI wiring ─────────────────────────────────────────── */
check("server: PATCH accepts a valid expiration, clears on null, rejects junk", () => {
  const s = read("src/server.ts");
  assert(/body\.expiration === "string" && \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(body\.expiration\)/.test(s));
  assert(/body\.expiration === null\) out\.expiration = undefined/.test(s));
});
check("crm: expiration renders from the store instead of hardcoded empty", () => {
  const h = read("public/crm-brivity.html");
  assert(/expiration:txMDY\(t\.expiration\)/.test(h));
  assert(!/expiration:"",/.test(h), 'the old expiration:"" mapping must be gone');
});
check("crm: inline edits mirror to /api/transactions (they used to 404 into /api/deals and vanish)", () => {
  const h = read("public/crm-brivity.html");
  assert(/\/api\/transactions\/"\+encodeURIComponent\(t\.id\)/.test(h));
  assert(/expiration:toIso\(t\.expiration\)/.test(h));
});
check("crm: the calendar derives events from expirations", () => {
  const h = read("public/crm-brivity.html");
  assert(/TX\.filter\(t=>t\.expiration\)/.test(h));
});

/* ── Sheet sync (functional where possible) ──────────────────────────────── */
await checkAsync("sync: pasted edit-URLs become CSV export URLs; published/plain pass through", async () => {
  const { normalizeSheetUrl } = await import("../dist/src/core/transactionSheetSync.js");
  assert.equal(
    normalizeSheetUrl("https://docs.google.com/spreadsheets/d/1AbC_dEf-123/edit?gid=456#gid=456"),
    "https://docs.google.com/spreadsheets/d/1AbC_dEf-123/export?format=csv&gid=456",
  );
  assert.equal(
    normalizeSheetUrl("https://docs.google.com/spreadsheets/d/1AbC/edit"),
    "https://docs.google.com/spreadsheets/d/1AbC/export?format=csv&gid=0",
  );
  const pub = "https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?output=csv";
  assert.equal(normalizeSheetUrl(pub), pub);
  assert.equal(normalizeSheetUrl("http://x.test/a.csv"), "http://x.test/a.csv");
});

await checkAsync("sync: unconfigured fails closed with a named reason", async () => {
  const saved = process.env.TRANSACTIONS_SHEET_URL;
  delete process.env.TRANSACTIONS_SHEET_URL;
  try {
    const { runSheetSync } = await import("../dist/src/core/transactionSheetSync.js");
    const r = await runSheetSync();
    assert.equal(r.ok, false);
    assert(/TRANSACTIONS_SHEET_URL is not set/.test(r.error));
  } finally {
    if (saved !== undefined) process.env.TRANSACTIONS_SHEET_URL = saved;
  }
});

check("sync: an HTML answer is reported as a sharing problem, never as 'no transactions'", () => {
  const s = read("src/core/transactionSheetSync.ts");
  assert(/returned a web page, not CSV/.test(s));
  assert(/Anyone with the link/.test(s));
});
check("sync: scheduled + boot run, gated on configuration, importer shared with manual upload", () => {
  const s = read("src/server.ts");
  assert(/isSheetSyncConfigured\(\)/.test(s));
  assert(/TRANSACTIONS_SHEET_SYNC_HOURS/.test(s));
  assert(/setTimeout\(\(\) => \{\s*\n\s*void runSheetSync/.test(s), "boot run missing");
  const sync = read("src/core/transactionSheetSync.ts");
  assert(/applyTransactionImport\(plan, \{ filename: "google-sheet", source: "google-sheet" \}\)/.test(sync));
});
check("sync: endpoints exist — GET status, POST run with dry-run", () => {
  const s = read("src/server.ts");
  assert(/app\.get\("\/api\/transactions\/sheet-sync"/.test(s));
  assert(/app\.post\("\/api\/transactions\/sheet-sync"/.test(s));
  assert(/body\.dryRun === true \? false : true/.test(s));
  // Express matches in registration order: the literal path must be
  // registered before GET /api/transactions/:id, or ":id" swallows
  // "sheet-sync" and the status endpoint 404s. This shipped broken once.
  assert(
    s.indexOf('app.get("/api/transactions/sheet-sync"') < s.indexOf('app.get("/api/transactions/:id"'),
    "sheet-sync GET is registered after the :id route and will be shadowed",
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  ✗ " + f); process.exit(1); }
