#!/usr/bin/env node
/**
 * The Leads sidebar must show how many leads came from each source.
 *
 * WHAT WAS THERE. Five hardcoded rows: Valuations, Brivity Leads, Brivity IDX,
 * Kwkly, Zillow. Three of them (`valuations`, `brivity`, `kwkly`) were wired to
 * `return false` — they could never match a lead, so they sat at 0 forever
 * while looking like working filters. `idx` tested `source === "Website IDX"`
 * when Brivity's real value is "Brivity IDX", so its 67 leads also showed 0.
 *
 * And the numbers Marco actually asked for — TikTok, Instagram, Mojo — had no
 * row at all, despite being the three biggest real sources in the account
 * (TikTok 368 in Brivity plus the whole DM funnel; Mojo 445 + 107 "Mojo FL").
 *
 * THE TRAP THIS SUITE EXISTS FOR: the two ingest paths spell sources
 * differently. The DM pipeline writes `source: payload.platform` — "tiktok",
 * "instagram", lowercase — while Brivity sends "TikTok" and "Instagram". Those
 * are one source and must be one row with one total. Counting by exact string
 * silently splits every social source in half, and half a number looks just as
 * plausible as the whole one.
 *
 * Usage: PW_CHROMIUM=... node scripts/verify-lead-source-nav.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 3998;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "srcnav-"));
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

/* Mirrors the real account's shape, including the casing split. */
const MIX = [
  ["TikTok", 12],    // Brivity spelling
  ["tiktok", 5],     // DM pipeline spelling — same source, must merge to 17
  ["Instagram", 4],
  ["instagram", 6],  // merges to 10
  ["Mojo", 9],
  ["Mojo FL", 3],    // a DIFFERENT list; must NOT merge into Mojo
  ["Brivity IDX", 7],
  ["Call In", 2],
  ["Zillow", 1],
];
const leads = {}; const convos = {}; let i = 0;
const iso = new Date().toISOString();
for (const [src, n] of MIX) {
  for (let k = 0; k < n; k++) {
    const id = "L" + (i++);
    leads[id] = { id, platform: "instagram", userId: "u" + id, username: "@" + id,
      name: "Lead " + id, phone: "(210) 555-" + String(1000 + i).slice(-4),
      email: null, state: "new", source: src, createdAt: iso, updatedAt: iso };
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
  await page.waitForTimeout(500);

  const rows = () => page.evaluate(() =>
    [...document.querySelectorAll("#lnSources a")].map((a) => ({
      label: a.childNodes[0].textContent.trim(),
      n: Number(a.querySelector(".c").textContent.replace(/,/g, "")),
      lb: a.getAttribute("data-lb"),
    })));

  const r = await rows();
  const by = (name) => r.find((x) => x.label.toLowerCase() === name.toLowerCase());
  console.log("  sidebar shows: " + JSON.stringify(r.map((x) => x.label + "=" + x.n)) + "\n");

  ok("a source row is rendered at all", r.length > 0, JSON.stringify(r));
  ok("TikTok appears — the number that was never displayed anywhere", !!by("TikTok"));
  ok("Instagram appears", !!by("Instagram"));
  ok("Mojo appears", !!by("Mojo"));

  /* The casing trap. */
  ok("TikTok and tiktok are ONE row totalling 17, not two rows of 12 and 5",
    by("TikTok") && by("TikTok").n === 17 && r.filter((x) => /^tiktok$/i.test(x.label)).length === 1,
    JSON.stringify(r.filter((x) => /tiktok/i.test(x.label))));
  ok("Instagram merges the same way to 10",
    by("Instagram") && by("Instagram").n === 10,
    JSON.stringify(r.filter((x) => /instagram/i.test(x.label))));
  ok("the merged row keeps the capitalised spelling, not 'tiktok'",
    by("TikTok").label === "TikTok", by("TikTok").label);

  /* But prefix-merging would be wrong. */
  ok("'Mojo' and 'Mojo FL' stay separate — they are two different lists",
    by("Mojo") && by("Mojo").n === 9 && by("Mojo FL") && by("Mojo FL").n === 3,
    JSON.stringify(r.filter((x) => /mojo/i.test(x.label))));

  /* The row that used to read 0 because it tested the wrong string. */
  ok("Brivity IDX shows its real count instead of 0", by("Brivity IDX") && by("Brivity IDX").n === 7,
    JSON.stringify(by("Brivity IDX")));

  /* The dead rows must be gone, not merely empty. */
  const navText = await page.locator("#view-leads .leads-nav").innerText();
  ok("the three rows that could never match anything are gone",
    !/Valuations/i.test(navText) && !/Kwkly/i.test(navText) && !/Brivity Leads/i.test(navText),
    navText.replace(/\n/g, " | ").slice(0, 200));
  ok("no source row is showing zero", r.every((x) => x.n > 0), JSON.stringify(r.filter((x) => !x.n)));

  /* Counts must agree with the board. */
  const total = r.reduce((a, x) => a + x.n, 0);
  const all = Number((await page.locator("#lnAll").innerText()).replace(/,/g, ""));
  ok("the source counts add up to the All Leads total", total === all, `${total} vs ${all}`);

  /* Clicking must actually filter. */
  await page.locator('#lnSources a[data-lb="src:tiktok"]').click();
  await page.waitForTimeout(400);
  const shown = await page.locator("#leadRows tr").count();
  ok("clicking TikTok filters the table to exactly those 17", shown === 17, String(shown));
  const heading = await page.locator("#ltCount").innerText();
  ok("and the header count agrees", /17/.test(heading), heading);
  const srcCells = await page.evaluate(() =>
    [...document.querySelectorAll("#leadRows tr")].map((tr) => tr.textContent.toLowerCase()));
  ok("every visible row really is a TikTok lead",
    srcCells.every((t) => t.includes("tiktok")), "a non-TikTok row is showing");

  await page.locator('#view-leads .leads-nav a[data-lb="all"]').click();
  await page.waitForTimeout(400);
  ok("All Leads restores the full board",
    (await page.locator("#leadRows tr").count()) > 17);

  ok("no page errors", errs.length === 0, errs.join("; "));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
} finally { await browser.close(); srv.kill("SIGKILL"); }

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); process.exit(1); }
