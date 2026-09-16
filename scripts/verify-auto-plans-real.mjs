#!/usr/bin/env node
/**
 * "I want the ability to create and customize my own Auto Plans, rather than
 * being limited to preset options." — Marco.
 *
 * NOTHING WAS LIMITING HIM, and that is the finding. Settings · Auto Plans
 * already builds a plan with any name, any number of task/email/text steps,
 * its own day offsets, auto-pause rules and completion status.
 *
 * What the DASHBOARD did was rotate four hardcoded strings over whoever
 * happened to be enrolled:
 *
 *   const PLANS = ["New Lead Follow-Up","Past Client Nurture",
 *                  "Open House Follow-Up","Sphere Quarterly Touch"];
 *   … 'Plan: ' + PLANS[i % PLANS.length] + ' · Step: ' + (1+i%5) + ' of 8 · RUNNING'
 *
 * Four invented plan names, a made-up step out of a made-up total, and a status
 * that was always RUNNING. On the dashboard, four names you never created read
 * exactly like the four plans you are allowed to have — which is the complaint.
 *
 * So this suite asserts the fabrication is gone and the REAL enrollment fields
 * are shown, including a paused plan still reading as paused. It also asserts
 * the plan builder is reachable from where the plans are listed, since it lives
 * behind a gear in the icon rail and that is not where anyone looks for it.
 *
 * Usage: node scripts/verify-auto-plans-real.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 3995;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "apreal-"));
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const iso = new Date().toISOString();
const leads = {}; const convos = {};
/* Real plan names Marco would have typed himself, deliberately NOT any of the
   four hardcoded ones, so a surviving fabrication is unmistakable. */
const seed = [
  ["A", "Marco VIP Sphere Touch", 2, "active", ["s1", "s2"]],
  ["B", "Expired Listing Winback", 0, "paused", []],
  ["C", "Luxury Buyer 30-Day", 5, "completed", ["s1", "s2", "s3"]],
  ["D", "", 1, "active", []], // an enrollment with no stored name
];
seed.forEach(([k, planName, step, status, done], i) => {
  const id = "L" + k;
  leads[id] = {
    id, platform: "instagram", userId: "u" + id, username: "@" + id,
    name: "Lead " + k, phone: "(210) 555-100" + i, email: null, state: "new",
    source: "TikTok", createdAt: iso, updatedAt: iso, lastActivity: iso,
    autoPlanEnrollments: [{
      planId: "plan_" + k, planName, enrolledAt: iso,
      currentStepIndex: step, completedSteps: done, status,
    }],
  };
  convos[id] = { messages: [] };
});
/* Someone on no plan at all must not appear on this tab. */
leads.LZ = { id: "LZ", platform: "instagram", userId: "uZ", username: "@Z", name: "Not Enrolled",
  phone: "(210) 555-9999", email: null, state: "new", source: "TikTok",
  createdAt: iso, updatedAt: iso, lastActivity: iso, autoPlanEnrollments: [] };
convos.LZ = { messages: [] };

writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 500, leadsById: leads,
  leadKeyToId: Object.fromEntries(Object.values(leads).map((l) => [l.platform + "::" + l.userId, l.id])),
  conversationsByLeadId: convos, commandTasks: [] }));

const env = { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
  DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db") };
delete env.BRIVITY_API_KEY;
const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch {} });
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

/* The four invented names must not survive anywhere in the source either. */
const src = readFileSync(join(process.cwd(), "public/crm-brivity.html"), "utf8");
const GHOSTS = ["New Lead Follow-Up", "Past Client Nurture", "Open House Follow-Up", "Sphere Quarterly Touch"];
/* Scanned with comments STRIPPED. The rotation is what fabricated data — a
   `const PLANS = [...]` indexed by the row number — and the comment above the
   new code quotes that removed line verbatim so the next reader knows what was
   wrong. Scanning raw source would flag the explanation as the defect. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
ok("the hardcoded plan-name rotation array is gone from the code",
  !/const\s+PLANS\s*=\s*\[/.test(code) && !/PLANS\[i\s*%\s*PLANS\.length\]/.test(code));
ok("the invented step arithmetic is gone from the code", !/\(1\s*\+\s*i\s*%\s*5\)/.test(code));
ok("no rotation over the four names survives in the code",
  GHOSTS.filter((g) => new RegExp('"' + g + '"').test(code)).length <= 1,
  GHOSTS.filter((g) => new RegExp('"' + g + '"').test(code)).join(", "));

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(B + "/crm", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.locator('#dashTabs button[data-dt="plans"]').click();
  await page.waitForTimeout(600);

  const feed = await page.evaluate(() => document.getElementById("feed").innerText);
  console.log("  feed:\n" + feed.split("\n").filter(Boolean).map((l) => "    " + l).join("\n"));

  ok("no invented plan name is rendered", !GHOSTS.some((g) => feed.includes(g)),
    GHOSTS.filter((g) => feed.includes(g)).join(", "));
  ok("the real plan names are shown",
    feed.includes("Marco VIP Sphere Touch") && feed.includes("Expired Listing Winback") &&
    feed.includes("Luxury Buyer 30-Day"));
  ok("the real step number is shown, not 1+i%5",
    feed.includes("Step 3") && feed.includes("Step 1") && feed.includes("Step 6"), "expected steps 3, 1 and 6");
  ok("the made-up 'of 8' total is gone", !/of 8/.test(feed));
  ok("a paused plan reads PAUSED, not RUNNING", /PAUSED/.test(feed));
  ok("a completed plan reads COMPLETED", /COMPLETED/.test(feed));
  ok("an active plan still reads RUNNING", /RUNNING/.test(feed));
  ok("an enrollment with no stored name says so instead of borrowing one",
    feed.includes("Unnamed plan"));
  ok("completed-step counts come from the data", /2 step\(s\) done/.test(feed));
  ok("a lead on no plan is not listed", !feed.includes("Not Enrolled"));

  /* Discoverability: the builder must be reachable from here. */
  ok("a MANAGE AUTO PLANS button is visible on this tab",
    await page.locator("#apGoSettings").isVisible());
  await page.locator("#apGoSettings").click();
  await page.waitForTimeout(600);
  ok("it opens Settings · Auto Plans",
    await page.evaluate(() => {
      const v = document.getElementById("view-plansettings");
      return !!v && v.classList.contains("on") || (v && getComputedStyle(v).display !== "none");
    }));
  ok("and the ADD PLAN button is there, so custom plans were always possible",
    await page.locator("#apAddPlan").count() > 0);

  /* The footer must not leak onto the other dashboard tab. */
  await page.locator('.rail .r[data-view="dash"], [data-view="dash"]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await page.locator('#dashTabs button[data-dt="recent"]').click().catch(() => {});
  await page.waitForTimeout(400);
  ok("the button is hidden again on RECENT ACTIVITY",
    !(await page.locator("#apPlansFoot").isVisible()));

  ok("no page errors", errs.length === 0, errs.join(" | "));
} finally {
  await browser.close();
  try { srv.kill("SIGKILL"); } catch {}
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.log("\nFailures:"); fail.forEach((f) => console.log("  · " + f)); process.exit(1); }
