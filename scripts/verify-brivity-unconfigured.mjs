#!/usr/bin/env node
/**
 * What the migration console does when Brivity is NOT connected to the server.
 *
 * WHY THIS MATTERS MORE THAN THE HAPPY PATH. With no BRIVITY_API_KEY set, two
 * things break at once and look unrelated: the CRM's live Brivity merge quietly
 * pulls nothing (so the board looks empty of Brivity contacts), and the
 * migration cannot even build a plan. Both have one cause and one fix, on the
 * server, not in this codebase. A bare "BRIVITY_API_KEY not set" string sends
 * someone hunting for a bug that does not exist.
 *
 * Usage: PW_CHROMIUM=... node scripts/verify-brivity-unconfigured.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 3994;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "brv-unconf-"));
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const env = { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
  DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db") };
delete env.BRIVITY_API_KEY;   // the state production appears to be in

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch {} });
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

try {
  // ---- the API is explicit about the cause AND the remedy ------------------
  const plan = await fetch(B + "/api/brivity/import/plan", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const pj = await plan.json();
  ok("planning refuses rather than returning an empty plan", pj.ok !== true, JSON.stringify(pj).slice(0, 120));
  ok("the error names the missing key", /BRIVITY_API_KEY/.test(pj.error || ""), pj.error);
  ok("and it names the fix, not just the fault",
    /flyctl secrets set|set it as a secret/i.test(pj.error || ""), pj.error);
  /* The dangerous failure would be reporting "0 contacts to import" — that reads
     as "Brivity is empty" and would be acted on as if the migration were done. */
  ok("it never reports this as 'nothing to import'",
    !/nothing to import|0 contacts/i.test(pj.error || ""), pj.error);

  // ---- applying must be impossible, not merely discouraged -----------------
  const apply = await fetch(B + "/api/brivity/import/apply", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apply: true }) });
  const aj = await apply.json();
  ok("applying fails too, and writes nothing", aj.ok !== true && !aj.created, JSON.stringify(aj).slice(0, 120));

  // ---- the console says something a person can act on ----------------------
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  const page = await browser.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(B + "/brivity-import", { waitUntil: "domcontentloaded" });
  await page.locator("#btnPlan").click();
  await page.locator(".note.bad").waitFor({ timeout: 60000 });
  const msg = await page.locator(".note.bad").innerText();
  ok("the console explains it is a connection problem, not a broken migration",
    /not connected to this server/i.test(msg), msg.slice(0, 140));
  ok("it tells the reader the migration itself is fine",
    /nothing is wrong with the migration itself/i.test(msg), msg.slice(0, 200));
  ok("it links the same cause to the empty CRM board",
    /no Brivity contacts appear/i.test(msg), msg.slice(0, 260));
  ok("Apply stays disabled throughout", await page.locator("#btnApply").isDisabled());
  ok("no page errors", errs.length === 0, errs.join("; "));
  await browser.close();
} finally { srv.kill("SIGKILL"); }

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); process.exit(1); }
