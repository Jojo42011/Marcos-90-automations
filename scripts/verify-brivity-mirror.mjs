#!/usr/bin/env node
/**
 * Brivity's contacts must survive a restart, and a cold load must not wait on
 * Brivity's 25-30 second round trip.
 *
 * WHAT WAS WRONG. The people list lived in a 10-minute in-memory cache and
 * nowhere else. Marco's requirement was "every time we reload, the leads don't
 * go away", and an in-memory Map cannot meet it: a deploy, a restart, or an
 * idle machine reclaim emptied it, and the next page load blocked on the full
 * network pull before it could show anything.
 *
 * These checks drive the REAL compiled store across SEPARATE node processes,
 * because a fresh process is the only honest way to test "survives a restart" —
 * anything in the same process could be passing on a module-level variable.
 *
 * Usage: node scripts/verify-brivity-mirror.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "brv-mirror-"));
const dbPath = join(tmp, "mirror.db");
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const STORE = pathToFileURL(join(process.cwd(), "dist/src/core/brivityMirrorStore.js")).href;

/** Run a snippet in a FRESH process — the only real test of persistence. */
function inFreshProcess(script) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, BRIVITY_MIRROR_DB_PATH: dbPath }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

const rows = (n, over = {}) => Array.from({ length: n }, (_, i) => ({
  id: "brivity-" + i, brivityId: String(1000 + i), name: "Person " + i,
  phone: "(210) 555-" + String(1000 + i).slice(-4), email: "p" + i + "@example.com",
  source: i % 3 === 0 ? "TikTok" : (i % 3 === 1 ? "Mojo" : "Instagram"),
  recordKind: i === 0 ? "collaborator" : "lead", crmStatus: "nurture", tags: ["x"],
  ...over,
}));

// ── process A: write ────────────────────────────────────────────────────────
const wrote = inFreshProcess(`
  const s = await import(${JSON.stringify(STORE)});
  const rows = ${JSON.stringify(rows(40))};
  const n = s.replaceBrivityMirror(rows, new Date().toISOString());
  console.log(JSON.stringify({ n, status: s.getBrivityMirrorStatus() }));
`);
ok("a pull is written to the mirror", wrote.n === 40, String(wrote.n));
ok("the database file is really on disk", existsSync(dbPath));
ok("status reports the row count", wrote.status.count === 40, String(wrote.status.count));
ok("and a successful sync timestamp", !!wrote.status.lastSyncedAt);
ok("with no error while healthy", wrote.status.lastError === null, String(wrote.status.lastError));

// ── process B: a brand new process reads it back ────────────────────────────
const read = inFreshProcess(`
  const s = await import(${JSON.stringify(STORE)});
  const list = s.readBrivityMirror();
  console.log(JSON.stringify({
    n: list.length,
    first: list.find((r) => r.brivityId === "1000") || null,
    kinds: [...new Set(list.map((r) => r.recordKind))].sort(),
    status: s.getBrivityMirrorStatus(),
  }));
`);
ok("A DIFFERENT PROCESS reads all 40 back — this is the restart", read.n === 40, String(read.n));
ok("the full row shape survives the round trip, not just the columns",
  read.first && read.first.name === "Person 0" && Array.isArray(read.first.tags) &&
  read.first.tags[0] === "x" && read.first.email === "p0@example.com",
  JSON.stringify(read.first));
ok("recordKind survives, so non-leads can still be held back",
  JSON.stringify(read.kinds) === JSON.stringify(["collaborator", "lead"]), JSON.stringify(read.kinds));
ok("the sync timestamp survives the restart too", !!read.status.lastSyncedAt);

// ── source counts, computed in SQL ─────────────────────────────────────────
const counts = inFreshProcess(`
  const s = await import(${JSON.stringify(STORE)});
  console.log(JSON.stringify(s.brivityMirrorSourceCounts()));
`);
const byName = Object.fromEntries(counts.map((c) => [c.source, c.n]));
ok("source counts come back from SQL", counts.length === 3, JSON.stringify(counts));
ok("and they are right", byName.TikTok === 14 && byName.Mojo === 13 && byName.Instagram === 13,
  JSON.stringify(byName));

// ── a replace is a REPLACE, so deletions in Brivity propagate ──────────────
const replaced = inFreshProcess(`
  const s = await import(${JSON.stringify(STORE)});
  s.replaceBrivityMirror(${JSON.stringify(rows(10))}, new Date().toISOString());
  console.log(JSON.stringify(s.getBrivityMirrorStatus()));
`);
ok("a smaller pull SHRINKS the mirror rather than accumulating",
  replaced.count === 10, String(replaced.count));

// ── the guard that matters: never wipe a good mirror on a bad fetch ────────
const guarded = inFreshProcess(`
  const s = await import(${JSON.stringify(STORE)});
  let threw = null;
  try { s.replaceBrivityMirror([], new Date().toISOString()); }
  catch (e) { threw = e.message; }
  console.log(JSON.stringify({ threw, status: s.getBrivityMirrorStatus() }));
`);
ok("replacing with an EMPTY result is refused", !!guarded.threw, String(guarded.threw));
ok("and the existing rows are untouched by that refusal",
  guarded.status.count === 10, String(guarded.status.count));

// ── a failed sync is recorded without destroying the rows ─────────────────
const failed = inFreshProcess(`
  const s = await import(${JSON.stringify(STORE)});
  s.recordBrivitySyncFailure(new Date().toISOString(), "Brivity API 503: upstream down");
  console.log(JSON.stringify(s.getBrivityMirrorStatus()));
`);
ok("a failed refresh keeps the last good rows", failed.count === 10, String(failed.count));
ok("the failure is surfaced", /503/.test(failed.lastError || ""), String(failed.lastError));
ok("but lastSyncedAt still points at the last SUCCESS, not the failure",
  !!failed.lastSyncedAt, String(failed.lastSyncedAt));

// ── recovery clears the error ──────────────────────────────────────────────
const recovered = inFreshProcess(`
  const s = await import(${JSON.stringify(STORE)});
  s.replaceBrivityMirror(${JSON.stringify(rows(12))}, new Date().toISOString());
  console.log(JSON.stringify(s.getBrivityMirrorStatus()));
`);
ok("a later success clears the error rather than warning forever",
  recovered.lastError === null && recovered.count === 12,
  JSON.stringify({ err: recovered.lastError, n: recovered.count }));

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); process.exit(1); }
