#!/usr/bin/env node
/**
 * The Brivity migration console, driven in a real browser.
 *
 * WHY A BROWSER PASS. This page's entire job is to let a person decide whether
 * to write thousands of records into a live CRM. A screen that misreports what
 * an import would do is worse than no screen — it manufactures confidence. So
 * these checks are about the page telling the TRUTH and about the door being
 * shut: preview never writes; Apply is unreachable until a plan is on screen;
 * changing an option invalidates the plan rather than leaving stale numbers
 * above a live button.
 *
 * Usage: PW_CHROMIUM=... BRIVITY_API_KEY=... node scripts/verify-brivity-console.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 3987;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "brivity-console-"));

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const key = (process.env.BRIVITY_API_KEY || "").trim();
if (!key) { console.error("BRIVITY_API_KEY is required"); process.exit(2); }

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
    BRIVITY_API_KEY: key,
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = ""; srv.stdout.on("data", (d) => (srvLog += d)); srv.stderr.on("data", (d) => (srvLog += d));
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch {} });
const until = async (fn, ms = 25000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));

/* Every write the page causes, recorded. Preview must produce none. */
const writes = [];
page.on("request", (r) => { if (r.method() === "POST") writes.push(r.url()); });

try {
  await page.goto(B + "/brivity-import", { waitUntil: "domcontentloaded" });
  ok("the console loads", await page.locator("h1").innerText() === "Brivity migration");
  ok("Apply is disabled before any plan exists", await page.locator("#btnApply").isDisabled());

  /* Defaults must match the safe server-side defaults, or the screen lies about
     what pressing Apply would do. */
  ok("'prefer Brivity name' defaults on", await page.locator("#optName").isChecked());
  ok("unqualified contacts default OFF", !(await page.locator("#optDead").isChecked()));
  ok("lenders & staff default OFF", !(await page.locator("#optNonLeads").isChecked()));

  console.log("\n  pulling the real Brivity account (~30s)...");
  await page.locator("#btnPlan").click();
  await page.locator(".stat .n.big").first().waitFor({ timeout: 120000 });

  const applyWrites = writes.filter((u) => u.includes("/import/apply"));
  ok("previewing never calls the apply endpoint", applyWrites.length === 0, JSON.stringify(applyWrites));

  const nums = await page.locator(".stat .n").allInnerTexts();
  const [created, merged, unchanged, fetched] = nums.map((t) => Number(t.replace(/,/g, "")));
  console.log(`  create ${created}, fill-in ${merged}, unchanged ${unchanged}, fetched ${fetched}\n`);
  ok("it read the whole Brivity account", fetched > 2000, String(fetched));
  ok("it plans real work", created + merged > 0, `${created}/${merged}`);

  const body = await page.locator("body").innerText();
  ok("every contact is reconciled, and the page says so",
    /accounted for/.test(body) && !/do not add up/.test(body),
    body.slice(0, 200));
  ok("the held-back reasons are all shown",
    ["Unqualified", "Lenders", "No phone or email", "Duplicates inside Brivity", "Need a decision"]
      .every((t) => body.includes(t)));
  ok("it states plainly that nothing is written yet", /read-only/i.test(body));

  ok("Apply becomes available once a plan is on screen", !(await page.locator("#btnApply").isDisabled()));

  /* A sample must be shown: numbers alone don't let anyone judge correctness. */
  ok("a sample of what gets added is shown", await page.locator("text=Sample of what gets added").count() > 0);

  /* The stale-plan trap: change an option and the old numbers must not remain
     above a live Apply button. */
  await page.locator("#optDead").check();
  ok("changing an option disables Apply again", await page.locator("#btnApply").isDisabled());
  ok("and it says why, rather than showing stale numbers",
    /Preview the plan again/i.test(await page.locator("body").innerText()));
  await page.locator("#optDead").uncheck();

  /* The confirmation gate. */
  await page.locator("#btnPlan").click();
  await page.locator(".stat .n.big").first().waitFor({ timeout: 120000 });
  await page.locator("#btnApply").click();
  ok("Apply opens a confirmation rather than writing immediately",
    await page.locator("#confirmScrim.on").count() > 0);
  ok("the confirm button starts disabled", await page.locator("#confirmGo").isDisabled());
  await page.locator("#confirmInput").fill("yes");
  ok("a wrong confirmation word does not unlock it", await page.locator("#confirmGo").isDisabled());
  await page.locator("#confirmInput").fill("IMPORT");
  ok("typing IMPORT unlocks it", !(await page.locator("#confirmGo").isDisabled()));
  ok("the confirmation names the real numbers",
    /adds/.test(await page.locator("#confirmText").innerText()));
  await page.locator("#confirmCancel").click();
  ok("cancelling closes it", await page.locator("#confirmScrim.on").count() === 0);

  ok("cancelling wrote nothing",
    writes.filter((u) => u.includes("/import/apply")).length === 0);

  /* The server must refuse a write that did not say so explicitly, whatever the
     page does — the page is not the only thing that can call this. */
  const bare = await fetch(B + "/api/brivity/import/apply", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  ok("the apply endpoint refuses without an explicit apply:true", bare.status === 400, String(bare.status));

  await page.screenshot({ path: join(tmp, "console.png"), fullPage: true });
  console.log(`\n  screenshot: ${join(tmp, "console.png")}`);
  ok("no page errors", errs.length === 0, errs.join("; "));
} finally {
  await browser.close(); srv.kill("SIGKILL");
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); if (srvLog) console.error(srvLog.slice(-1500)); process.exit(1); }
