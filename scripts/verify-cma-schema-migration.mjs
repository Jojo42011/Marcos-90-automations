/**
 * verify-cma-schema-migration.mjs — the CMA publish failure Marco reported.
 *
 * "I receive an error message whenever I try to publish a CMA", and the
 * screenshot carried the cause verbatim: `no such column:
 * suggested_min_list_price`.
 *
 * The root cause is not in the SQL this file tests, it is in how the SQL was
 * applied: every cma table is created with CREATE TABLE IF NOT EXISTS, which on
 * an existing database is a no-op, so a column added to cmaStore.ts later never
 * reached the live table. So this suite does the only thing that can prove the
 * fix — it builds a database in the OLD shape, reproduces the failure on it,
 * runs the migration, and shows the same write succeeding.
 *
 * The data check matters as much as the column check: a "migration" that healed
 * the schema by dropping and recreating the table would pass a column test while
 * destroying Marco's real CMA sessions.
 *
 * Run:  node scripts/verify-cma-schema-migration.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3");
const store = require_("../dist/src/core/cmaStore.js");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const tmp = mkdtempSync(path.join(tmpdir(), "cma-migration-"));
const dbPath = path.join(tmp, "cma.db");

/* The shape cma_sessions had BEFORE the estimate fields were added. This is the
   database Marco's machine has been running on. */
function buildOldDatabase() {
  const d = new Database(dbPath);
  d.exec(`
    CREATE TABLE cma_sessions (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      subject_address TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE TABLE cma_comparables (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      listing_status TEXT NOT NULL,
      tray_slot_index INTEGER NOT NULL,
      source TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE TABLE cma_deliveries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      sent_at TEXT NOT NULL
    )
  `);
  /* A real session already on the volume, so the migration has something to
     destroy if it is the destructive kind. */
  d.prepare(
    `INSERT INTO cma_sessions (id, client_name, subject_address, created_at, updated_at)
     VALUES (?,?,?,?,?)`,
  ).run("sess_real_1", "Jason Alvarez", "123 Rockcress Rd", "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z");
  d.prepare(
    `INSERT INTO cma_comparables (id, session_id, listing_status, tray_slot_index, source, address, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run("cmp_1", "sess_real_1", "SOLD", 1, "mls", "456 Oak Bend", "2026-09-01T10:05:00Z");
  return d;
}

console.log("\nREPRODUCE — the failure exactly as Marco saw it");
let d = buildOldDatabase();
let reproduced = null;
try {
  d.prepare(`UPDATE cma_sessions SET suggested_min_list_price = ? WHERE id = ?`).run(382607, "sess_real_1");
} catch (e) {
  reproduced = String(e.message || e);
}
check(
  "publishing against the old schema fails with the reported error",
  reproduced !== null && /no such column: suggested_min_list_price/.test(reproduced),
  reproduced ?? "the write unexpectedly succeeded",
);
d.close();

console.log("\nMIGRATE — initCmaSchema heals the live table in place");
d = new Database(dbPath);
store.initCmaSchema(d);

const cols = (t) =>
  new Set(d.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
const sess = cols("cma_sessions");

check("suggested_min_list_price now exists", sess.has("suggested_min_list_price"));
check("suggested_max_list_price now exists", sess.has("suggested_max_list_price"));
check("estimated_dom_min now exists", sess.has("estimated_dom_min"));
check("estimated_dom_max now exists", sess.has("estimated_dom_max"));
check("the other drifted session columns came too (area_rung, status, criteria)",
  sess.has("area_rung") && sess.has("status") && sess.has("criteria"));
check("comparables healed as well (source_key, sold_price, off_market_type)",
  ["source_key", "sold_price", "off_market_type"].every((c) => cols("cma_comparables").has(c)));
check("deliveries healed as well (ok, error, report_id)",
  ["ok", "error", "report_id"].every((c) => cols("cma_deliveries").has(c)));

console.log("\nNON-DESTRUCTIVE — the real rows are still there");
const row = d.prepare(`SELECT * FROM cma_sessions WHERE id = ?`).get("sess_real_1");
check("the existing CMA session survived the migration", Boolean(row), "the session was destroyed");
check("its data is intact", row?.client_name === "Jason Alvarez" && row?.subject_address === "123 Rockcress Rd");
check("its comparable survived too",
  Boolean(d.prepare(`SELECT 1 FROM cma_comparables WHERE id = ?`).get("cmp_1")));
check("defaults applied to the healed NOT NULL columns",
  row?.status === "draft" && row?.current_step === 1 && row?.criteria === "{}",
  `status=${row?.status} step=${row?.current_step} criteria=${row?.criteria}`);

console.log("\nTHE ACTUAL PUBLISH WRITE");
let publishErr = null;
try {
  d.prepare(
    `UPDATE cma_sessions SET suggested_min_list_price = ?, suggested_max_list_price = ?,
       estimated_dom_min = ?, status = ?, published_at = ? WHERE id = ?`,
  ).run(382607, 440614, 28, "published", new Date().toISOString(), "sess_real_1");
} catch (e) {
  publishErr = String(e.message || e);
}
check("publishing a CMA now succeeds", publishErr === null, publishErr ?? "");
const after = d.prepare(`SELECT * FROM cma_sessions WHERE id = ?`).get("sess_real_1");
check("the published values round-trip",
  after?.suggested_min_list_price === 382607 && after?.status === "published");

console.log("\nIDEMPOTENT — safe on every boot");
const addedSecondRun = store.migrateCmaColumns(d);
check("a second migration adds nothing", addedSecondRun.length === 0, `added ${addedSecondRun.join(", ")}`);
let reinitErr = null;
try { store.initCmaSchema(d); store.initCmaSchema(d); } catch (e) { reinitErr = String(e.message || e); }
check("initCmaSchema can run repeatedly without error", reinitErr === null, reinitErr ?? "");
check("data still intact after repeated init",
  d.prepare(`SELECT client_name FROM cma_sessions WHERE id = ?`).get("sess_real_1")?.client_name === "Jason Alvarez");
d.close();

console.log("\nFRESH DATABASE — the normal path is unaffected");
const fresh = new Database(path.join(tmp, "fresh.db"));
let freshErr = null;
try { store.initCmaSchema(fresh); } catch (e) { freshErr = String(e.message || e); }
check("a brand new database initialises cleanly", freshErr === null, freshErr ?? "");
const freshCols = new Set(fresh.prepare(`PRAGMA table_info(cma_sessions)`).all().map((r) => r.name));
check("and has every column without needing a migration", freshCols.has("suggested_min_list_price"));
check("the partial unique index built (it depends on a migrated column)",
  fresh.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get("idx_cma_comps_unique_source") != null);
fresh.close();

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
