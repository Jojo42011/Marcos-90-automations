#!/usr/bin/env node
/**
 * A smart filter must return what its label says.
 *
 * A filter that returns the WRONG set is worse than one that returns nothing,
 * because you act on the result believing it. Four were wrong:
 *
 *   mr_no_task   labelled "Has Market Report…" and tested `!(l.reports||0)` —
 *                the exact opposite, returning everyone WITHOUT a report.
 *   no_mr        labelled "No Market Report - Contacts w/ Email + Address" but
 *                only tested email and address, so it included the very
 *                contacts who already had one.
 *   buyers_email labelled "…and no Listing Alert" and never looked at `alerts`.
 *   past_clients labelled "Past clients" and tested for status "unqualified",
 *                which is a DEAD lead — very nearly the opposite of a past
 *                client, and the single most valuable segment to get wrong.
 *
 * And `overdue` had no data at all: a lead's `due` is synthesised from
 * `crmCallQueue` and only ever reads "Due Today" or "Upcoming", so "Overdue
 * Tasks" was matching today's calls and presenting them as late.
 *
 * Usage: PW_CHROMIUM=... node scripts/verify-smart-filters.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 4003;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "smartf-"));
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const iso = new Date().toISOString();
const leads = {};
let i = 0;
const mk = (over) => {
  const id = "L" + (i++);
  leads[id] = { id, platform: "instagram", userId: "u" + id, username: "@" + id,
    name: "Lead " + id, phone: "(210) 555-" + String(1000 + i).slice(-4),
    email: null, state: "new", source: "TikTok", tags: [], reports: 0, alerts: 0,
    crmStatus: "nurture", crmIntent: "buyer", address: null,
    createdAt: iso, updatedAt: iso, ...over };
  return leads[id];
};
/* A deliberate spread so each predicate has both matches and non-matches. */
mk({ name: "PastClientA", tags: ["Past Client"], crmStatus: "nurture" });
mk({ name: "PastClientB", tags: ["Past Client", "Other"], crmStatus: "hot" });
mk({ name: "DeadNotPastClient", crmStatus: "dead" });          // the old past_clients bug
mk({ name: "DeadTwo", crmStatus: "dead" });
mk({ name: "HasReport", reports: 3 });
mk({ name: "HasReportTwo", reports: 1 });
mk({ name: "NoReportEmailAddr", email: "a@x.com", address: "1 Oak St" });
mk({ name: "HasReportEmailAddr", email: "b@x.com", address: "2 Oak St", reports: 2 });
mk({ name: "BuyerEmailNoAlert", crmIntent: "buyer", email: "c@x.com", alerts: 0 });
mk({ name: "BuyerEmailWithAlert", crmIntent: "buyer", email: "d@x.com", alerts: 2 });

writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 200, leadsById: leads,
  leadKeyToId: Object.fromEntries(Object.values(leads).map((l) => [l.platform + "::" + l.userId, l.id])),
  conversationsByLeadId: {}, commandTasks: [] }));

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
  await page.waitForTimeout(300);
  await page.locator("#smartFiltersToggle").click();
  await page.waitForTimeout(300);

  const apply = async (key) => {
    await page.locator(`.sf[data-sf="${key}"]`).click();
    await page.waitForTimeout(350);
    return page.evaluate(() =>
      [...document.querySelectorAll("#leadRows .lead-name")].map((e) => e.textContent.trim()));
  };

  const past = await apply("past_clients");
  ok("past_clients returns the tagged past clients", past.sort().join(",") === "PastClientA,PastClientB",
    JSON.stringify(past));
  ok("and does NOT return dead leads, which is what it used to return",
    !past.includes("DeadNotPastClient") && !past.includes("DeadTwo"), JSON.stringify(past));

  const mr = await apply("mr_no_task");
  ok("'Has Market Report' returns leads that HAVE one",
    mr.sort().join(",") === "HasReport,HasReportEmailAddr,HasReportTwo", JSON.stringify(mr));
  ok("it is no longer inverted — a lead with no report is absent",
    !mr.includes("NoReportEmailAddr"), JSON.stringify(mr));

  const nomr = await apply("no_mr");
  ok("'No Market Report + email + address' excludes the one that HAS a report",
    nomr.join(",") === "NoReportEmailAddr", JSON.stringify(nomr));

  const be = await apply("buyers_email");
  ok("'Buyers with email and no Listing Alert' honours the alert clause",
    be.includes("BuyerEmailNoAlert") && !be.includes("BuyerEmailWithAlert"), JSON.stringify(be));

  /* The no-data filters must refuse rather than answer. */
  const before = await page.evaluate(() => document.querySelectorAll("#leadRows tr").length);
  await page.locator('.sf[data-sf="overdue"]').click();
  await page.waitForTimeout(350);
  const afterRows = await page.evaluate(() => document.querySelectorAll("#leadRows tr").length);
  ok("'Overdue Tasks' does not silently answer with a number",
    afterRows === before, `${before} then ${afterRows}`);
  ok("it is marked as having no data",
    await page.locator('.sf[data-sf="overdue"].sf-nodata').count() === 1);
  const why = await page.locator('.sf[data-sf="overdue"]').getAttribute("title");
  ok("and explains why, specifically — not the website-visit reason",
    /task due dates/i.test(why || ""), why);
  const visitWhy = await page.locator('.sf[data-sf="visit30"]').getAttribute("title");
  ok("the visit filters keep their own, different explanation",
    /visit tracking/i.test(visitWhy || ""), visitWhy);

  ok("no page errors", errs.length === 0, errs.join("; "));
} finally { await browser.close(); srv.kill("SIGKILL"); }

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); process.exit(1); }
