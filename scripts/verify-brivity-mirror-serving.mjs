#!/usr/bin/env node
/**
 * A cold page load must be served from the mirror, NOT from Brivity's 25-30
 * second round trip — and the data must still be there after a restart.
 *
 * The store suite proves SQLite keeps the rows. This proves the SERVER uses
 * them: it points BRIVITY_CORE_URL at a deliberately slow stub, so if anything
 * still awaits the network the request visibly takes as long as the stub does.
 *
 * Usage: node scripts/verify-brivity-mirror-serving.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = 3999, STUB = 4001;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "brv-serve-"));
const dbPath = join(tmp, "mirror.db");
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

/* Stands in for Brivity: correct shape, deliberately slow. */
const SLOW_MS = 6000;
let stubHits = 0;
const stub = createServer((req, res) => {
  stubHits++;
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({
      id: 9000 + i, lead_id: 9000 + i, uuid: "u" + i, type: "lead",
      first_name: "Fresh", last_name: "Person " + i,
      phone_number: "210-555-" + String(2000 + i).slice(-4),
      email_address: "fresh" + i + "@example.com",
      status: "nurture", stage: "New lead", lead_type: "buyer", source: "TikTok",
      brivity_contact_detail_url: "https://app.brivity.com/x",
    }))));
  }, SLOW_MS);
});
await new Promise((r) => stub.listen(STUB, r));

/* Seed the mirror in a separate process, exactly as a previous run would. */
const STORE = pathToFileURL(join(process.cwd(), "dist/src/core/brivityMirrorStore.js")).href;
execFileSync(process.execPath, ["--input-type=module", "-e", `
  const s = await import(${JSON.stringify(STORE)});
  s.replaceBrivityMirror(${JSON.stringify(Array.from({ length: 25 }, (_, i) => ({
    id: "brivity-" + i, brivityId: String(500 + i), name: "Mirrored " + i,
    phone: "(210) 555-" + String(3000 + i).slice(-4), email: "m" + i + "@example.com",
    source: "Mojo", recordKind: "lead", crmStatus: "nurture", tags: [],
  })))}, new Date().toISOString());
  /* Age the sync so the server treats the mirror as stale and refreshes behind
     the request. A freshly-synced mirror is correctly left alone, so without
     this the background-refresh checks below would be testing nothing. */
  s.getBrivityMirrorDb().prepare(
    "UPDATE brivity_sync_log SET finished_at = ?"
  ).run(new Date(Date.now() - 20 * 60 * 1000).toISOString());
`], { env: { ...process.env, BRIVITY_MIRROR_DB_PATH: dbPath }, encoding: "utf8" });

const env = { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
  BRIVITY_API_KEY: "test-key-not-real", BRIVITY_CORE_URL: `http://127.0.0.1:${STUB}`,
  BRIVITY_MIRROR_DB_PATH: dbPath,
  DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db") };
const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
process.on("exit", () => { try { srv.kill("SIGKILL"); stub.close(); } catch {} });
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

try {
  /* THE ASSERTION. A 6s stub stands in for the real 26s call. If the response
     takes anywhere near that long, something is still awaiting the network. */
  const t0 = Date.now();
  const r = await (await fetch(B + "/api/brivity/people")).json();
  const elapsed = Date.now() - t0;
  console.log(`  first request: ${elapsed}ms against a ${SLOW_MS}ms Brivity stub\n`);
  ok("a cold request is answered from the mirror, not the network",
    elapsed < SLOW_MS - 1500, elapsed + "ms");
  ok("and it returns the mirrored rows", r.count === 25, String(r.count));
  ok("the rows are the real mirrored contacts",
    (r.people || []).some((p) => /^Mirrored /.test(p.name)),
    JSON.stringify((r.people || [])[0] || null).slice(0, 120));
  ok("status reports what the mirror holds", r.mirroredCount === 25, String(r.mirroredCount));
  ok("and when it last synced", !!r.mirrorSyncedAt, String(r.mirrorSyncedAt));

  /* The background refresh must actually happen — a mirror that never updates
     is just a stale file. */
  await new Promise((res) => setTimeout(res, SLOW_MS + 3000));
  ok("a background refresh was triggered without blocking the request",
    stubHits > 0, "the stub was never called");
  const after = await (await fetch(B + "/api/brivity/people")).json();
  ok("and the refreshed rows replaced the mirrored ones",
    after.count === 30 && (after.people || []).some((p) => /^Fresh /.test(p.name)),
    `${after.count} rows; first=${JSON.stringify((after.people || [])[0] || {}).slice(0, 90)}`);

  /* Restart: the whole point of the store. */
  srv.kill("SIGKILL");
  await new Promise((res) => setTimeout(res, 800));
  const srv2 = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  process.on("exit", () => { try { srv2.kill("SIGKILL"); } catch {} });
  await until(async () => (await fetch(B + "/health")).ok);
  const t1 = Date.now();
  const restarted = await (await fetch(B + "/api/brivity/people")).json();
  const elapsed2 = Date.now() - t1;
  ok("AFTER A RESTART the contacts are still there", restarted.count === 30, String(restarted.count));
  ok("and still served without waiting on Brivity", elapsed2 < SLOW_MS - 1500, elapsed2 + "ms");
  console.log(`  after restart: ${restarted.count} contacts in ${elapsed2}ms`);
  srv2.kill("SIGKILL");
} finally { srv.kill("SIGKILL"); stub.close(); }

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); process.exit(1); }
