#!/usr/bin/env node
/**
 * "I want leads from Brivity to remain separate from leads coming from
 * Instagram and TikTok. Each source should be clearly identified and organized
 * independently." — Marco.
 *
 * THE DISTINCTION THIS SUITE PROTECTS. The sidebar already groups By source,
 * and that list deliberately FOLDS CASE: Brivity sends "TikTok" and the DM
 * pipeline writes "tiktok", they are the same source, and counting them apart
 * halves every social number. That folding is correct and `verify-lead-source-
 * nav.mjs` exists to keep it.
 *
 * But folding makes Marco's question unanswerable, because it is a different
 * question. He is not asking which source NAME a lead carries, he is asking
 * which SYSTEM holds the record — Brivity's board, or this one. A lead the
 * Brivity importer created carries Brivity's own id; a lead the DM funnel made
 * does not. So By origin is a second group beside By source, and this suite
 * asserts BOTH that origin separates correctly AND that source folding is
 * untouched. Fixing one by breaking the other is the failure to catch.
 *
 * Usage: node scripts/verify-lead-origin-nav.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 3996;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "orgnav-"));
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

/* Mirrors the real account: TikTok and Instagram leads arrive from BOTH
   systems, spelled differently, which is exactly why source and origin have to
   be separate axes. */
const MIX = [
  // [source, platform, brivityId?, count]
  ["TikTok",      "tiktok",    true,  12], // imported from Brivity
  ["tiktok",      "tiktok",    false,  5], // our own DM funnel
  ["Instagram",   "instagram", true,   4],
  ["instagram",   "instagram", false,  6],
  ["Mojo",        "phone",     true,   9],
  ["Call In",     "phone",     true,   2],
  ["Website",     "web",       false,  3], // typed here, not social, not Brivity
];
const leads = {}; const convos = {}; let i = 0;
const iso = new Date().toISOString();
for (const [src, platform, fromBrivity, n] of MIX) {
  for (let k = 0; k < n; k++) {
    const id = "L" + (i++);
    leads[id] = {
      id, platform, userId: "u" + id, username: "@" + id,
      name: "Lead " + id, phone: "(210) 555-" + String(1000 + i).slice(-4),
      email: null, state: "new", source: src,
      brivityId: fromBrivity ? "bv_" + id : null,
      createdAt: iso, updatedAt: iso,
    };
    convos[id] = { messages: [] };
  }
}
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

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(B + "/crm", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.locator('[data-view="leads"]').click();
  await page.waitForTimeout(600);

  const navRows = (sel) => page.evaluate((s) =>
    [...document.querySelectorAll(s + " a")].map((a) => ({
      label: a.childNodes[0].textContent.trim(),
      n: Number(a.querySelector(".c").textContent.replace(/,/g, "")),
      lb: a.getAttribute("data-lb"),
    })), sel);

  const org = await navRows("#lnOrigins");
  const by = (name) => org.find((x) => x.label.toLowerCase() === name.toLowerCase());
  console.log("  by origin: " + JSON.stringify(org.map((x) => x.label + "=" + x.n)));

  ok("the By origin group renders", org.length > 0, JSON.stringify(org));
  ok("Brivity is its own row with all 27 imported leads",
    by("Brivity") && by("Brivity").n === 27, JSON.stringify(by("Brivity")));
  ok("Instagram / TikTok is its own row with the 11 from the DM funnel",
    by("Instagram / TikTok") && by("Instagram / TikTok").n === 11, JSON.stringify(by("Instagram / TikTok")));
  ok("leads entered here are their own row (3)",
    by("Entered here") && by("Entered here").n === 3, JSON.stringify(by("Entered here")));
  ok("the three origins account for every lead",
    org.reduce((a, x) => a + x.n, 0) === 41, String(org.reduce((a, x) => a + x.n, 0)));

  /* The whole point: a Brivity TikTok lead and a DM TikTok lead are one SOURCE
     row and two different ORIGIN rows. */
  const src = await navRows("#lnSources");
  const s = (name) => src.find((x) => x.label.toLowerCase() === name.toLowerCase());
  console.log("  by source: " + JSON.stringify(src.map((x) => x.label + "=" + x.n)));
  ok("source folding is UNTOUCHED — TikTok is still one row of 17",
    s("TikTok") && s("TikTok").n === 17 && src.filter((x) => /^tiktok$/i.test(x.label)).length === 1,
    JSON.stringify(src.filter((x) => /tiktok/i.test(x.label))));
  ok("Instagram still merges to 10", s("Instagram") && s("Instagram").n === 10);
  ok("so the same lead is counted once by source and once by origin, on different axes",
    s("TikTok").n === 17 && by("Brivity").n === 27);

  /* Clicking must actually filter, not just highlight. */
  const rowCount = () => page.evaluate(() => document.querySelectorAll("#leadRows tr[data-lead]").length
    || document.querySelectorAll("#leadRows tr").length);
  const before = await rowCount();
  await page.locator('#lnOrigins a[data-lb="org:social"]').click();
  await page.waitForTimeout(400);
  const afterSocial = await rowCount();
  ok("clicking Instagram / TikTok filters the table", afterSocial > 0 && afterSocial < before,
    `before ${before}, after ${afterSocial}`);
  ok("the clicked origin row is marked active",
    await page.evaluate(() => !!document.querySelector('#lnOrigins a[data-lb="org:social"].on')));

  const shownSources = await page.evaluate(() =>
    [...document.querySelectorAll("#leadRows tr")].map((r) => r.textContent).join(" | "));
  ok("and the rows shown are the social ones, with no Mojo or Call In among them",
    !/Mojo|Call In/.test(shownSources), shownSources.slice(0, 160));

  await page.locator('#lnOrigins a[data-lb="org:brivity"]').click();
  await page.waitForTimeout(400);
  ok("switching to Brivity re-filters", (await rowCount()) > 0);
  ok("and the source group is still rendered beside it (both axes stay available)",
    (await navRows("#lnSources")).length > 0);

  ok("no page errors while doing any of it", errs.length === 0, errs.join(" | "));
} finally {
  await browser.close();
  try { srv.kill("SIGKILL"); } catch {}
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.log("\nFailures:"); fail.forEach((f) => console.log("  · " + f)); process.exit(1); }
