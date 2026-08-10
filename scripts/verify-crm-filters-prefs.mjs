#!/usr/bin/env node
/**
 * Phase 1 verification: the Brivity-style Filter Leads panel, per-user
 * Columns/Sort persistence, and the new persisted lead date fields.
 *
 * Drives a REAL browser against a locally running `dist/src/server.js`
 * (the established practice here — no build step, no test framework).
 *
 * Usage:
 *   node scripts/verify-crm-filters-prefs.mjs
 * It boots its own server on PORT (default 3390) against a seeded temp
 * data dir, so it does not touch real data and needs nothing running.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3390);
const B = `http://localhost:${PORT}`;

let pass = 0; const fail = [];
const ok = (n, c, detail) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (detail ? " — " + detail : "")); console.error("FAIL " + n + (detail ? " — " + detail : "")); } };

// ---- seed a temp data dir --------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "crm-verify-"));
const mkLead = (n, over) => ({
  id: "lead_" + n, platform: over.platform || "tiktok", userId: "u" + n, username: "user" + n,
  name: over.name, phone: over.phone ?? ("21055501" + String(10 + n)), email: over.email ?? null,
  state: "new", source: over.source || "TikTok", adCampaign: null,
  propertyInquired: null, criteria: over.criteria ?? null, brivityId: null,
  crmStatus: over.crmStatus || "new", crmStage: over.crmStage || "new", crmPriority: "normal",
  crmIntent: over.crmIntent || "buyer", crmCallQueue: "none", crmNotes: null,
  tags: over.tags || [], address: over.address ?? null,
  birthday: over.birthday ?? null, homeAnniversary: over.homeAnniversary ?? null,
  autoPlanEnrollments: over.autoPlanEnrollments || [],
  assignedUserId: over.assignedUserId ?? null, assignedUserName: over.assignedUserName ?? null,
  createdAt: over.createdAt || "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
});
const leads = [
  mkLead(1, { name: "Alpha Buyer", crmStatus: "hot", crmIntent: "buyer", tags: ["Investor"], email: "alpha@x.com", birthday: "1990-03-15", source: "TikTok" }),
  mkLead(2, { name: "Bravo Seller", crmStatus: "nurture", crmIntent: "seller", platform: "instagram", source: "Instagram", address: "12 Oak St, Boerne" }),
  mkLead(3, { name: "Charlie New", crmStatus: "new", crmIntent: "buyer", email: "charlie@x.com", assignedUserId: "carlos", assignedUserName: "Carlos", source: "Mojo" }),
  mkLead(4, { name: "Delta Watch", crmStatus: "watch", crmIntent: "buyer", autoPlanEnrollments: [{ planId: "p1", planName: "Nurture plan", enrolledAt: "2026-08-01T00:00:00.000Z", currentStep: 0, status: "active" }], source: "TikTok" }),
];
const db = { idCounter: 10, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] };
for (const l of leads) { db.leadsById[l.id] = l; db.leadKeyToId[l.platform + "::" + l.userId] = l.id; db.conversationsByLeadId[l.id] = { messages: [] }; }
writeFileSync(join(tmp, "db.json"), JSON.stringify(db));

// ---- boot the server -------------------------------------------------------
/* cwd must be the repo root — the server serves `public/` off process.cwd().
   All data paths are redirected into the temp dir via env instead. */
const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
srv.stdout.on("data", (d) => (srvLog += d));
srv.stderr.on("data", (d) => (srvLog += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

const J = (r) => r.json();
try {
  // ---- API layer -----------------------------------------------------------
  const snap = await J(await fetch(B + "/api/dashboard/data"));
  const row = snap.leads.find((l) => l.id === "lead_1");
  ok("dashboard row carries birthday", row && row.birthday === "1990-03-15", JSON.stringify(row && row.birthday));
  ok("dashboard row carries address", snap.leads.find((l) => l.id === "lead_2").address === "12 Oak St, Boerne");

  let r = await fetch(B + "/api/crm/lead/lead_2", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ homeAnniversary: "2019-06-01" }) });
  ok("PATCH homeAnniversary accepted", r.ok);
  r = await fetch(B + "/api/crm/lead/lead_2", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ birthday: "junk-date" }) });
  ok("PATCH junk birthday rejected 400", r.status === 400);
  r = await fetch(B + "/api/crm/lead/lead_1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: "99 Elm Ave" }) });
  ok("PATCH address accepted", r.ok);
  const snap2 = await J(await fetch(B + "/api/dashboard/data"));
  ok("anniversary persisted", snap2.leads.find((l) => l.id === "lead_2").homeAnniversary === "2019-06-01");
  ok("address persisted", snap2.leads.find((l) => l.id === "lead_1").address === "99 Elm Ave");

  // extended /api/leads/filter
  let f = await J(await fetch(B + "/api/leads/filter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tagsExclude: ["Investor"] }) }));
  ok("filter tagsExclude drops tagged lead", (f.leads || f).length === 3 && !(f.leads || f).some((l) => l.id === "lead_1"), JSON.stringify((f.leads || f).length));
  f = await J(await fetch(B + "/api/leads/filter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hasEmail: true }) }));
  ok("filter hasEmail=true", (f.leads || f).every((l) => !!l.email) && (f.leads || f).length === 2);
  f = await J(await fetch(B + "/api/leads/filter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoPlan: "none" }) }));
  ok("filter autoPlan=none", (f.leads || f).length === 3 && !(f.leads || f).some((l) => l.id === "lead_4"));
  f = await J(await fetch(B + "/api/leads/filter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ birthdayMonth: 3 }) }));
  ok("filter birthdayMonth=3", (f.leads || f).length === 1 && (f.leads || f)[0].id === "lead_1");

  // table prefs round trip
  r = await fetch(B + "/api/settings/table-prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: "testuser", table: "leads", prefs: { hidden: ["source"], sortField: "name", sortDir: -1 } }) });
  ok("table-prefs PUT ok", r.ok);
  const tp = await J(await fetch(B + "/api/settings/table-prefs?user=testuser"));
  ok("table-prefs round trip", tp.tables && tp.tables.leads && tp.tables.leads.sortField === "name" && tp.tables.leads.sortDir === -1 && tp.tables.leads.hidden.includes("source"));

  // ---- browser layer -------------------------------------------------------
  const br = await chromium.launch();
  const page = await br.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { const u = m.location().url || ""; if (m.type() === "error" && !/favicon|photo|cdn/.test(u)) errs.push("console: " + m.text().slice(0, 120)); });
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());

  await page.goto(B + "/crm", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag") && /Live data/.test(document.querySelector(".demo-tag").textContent), null, { timeout: 15000 });

  // go to Leads view
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  const rows0 = await page.$$eval("#leadRows tr", (t) => t.length);
  ok("4 seeded leads render", rows0 === 4, String(rows0));

  // FILTER panel: Lead Type = Seller
  await page.click("#lFilterBtn");
  await page.waitForSelector("#afScrim.on");
  ok("filter drawer opens", true);
  await page.check('input[data-afk="leadType"][data-afv="seller"]');
  await page.click("#afApply");
  await page.waitForFunction(() => document.querySelectorAll("#leadRows tr").length === 1);
  const nm = await page.textContent("#leadRows tr .lead-name");
  ok("seller filter leaves Bravo only", nm.trim() === "Bravo Seller", nm);
  ok("chip bar shows the filter", (await page.textContent("#lChipBar")).includes("Type: Seller"));
  ok("FILTER button shows count", (await page.textContent("#lFilterBtn")).includes("FILTERED (1)"));

  // chip × clears it
  await page.click('#lChipBar [data-afchip="leadType"]');
  await page.waitForFunction(() => document.querySelectorAll("#leadRows tr").length === 4);
  ok("removing the chip restores all rows", true);

  // tri-state: Has Email (group starts collapsed — open it first)
  await page.click("#lFilterBtn");
  await page.waitForSelector("#afScrim.on");
  await page.click('.afg-h:has-text("Contact Info")');
  await page.click('button[data-aft="hasEmail"][data-aftv="true"]');
  ok("group stays open after a tri-state click rebuilds the panel",
    await page.$eval('.afg[data-afgk="ContactInfo"]', (g) => g.classList.contains("open")));
  await page.click("#afApply");
  await page.waitForFunction(() => document.querySelectorAll("#leadRows tr").length === 2);
  ok("Has Email filter -> 2 rows", true);

  // tags include (from seeded lead tags — no templates needed)
  await page.click("#lFilterBtn");
  await page.waitForSelector("#afScrim.on");
  await page.click('.afg-h:has-text("Tags")');
  const invSel = 'input[data-afk="tagsInc"][data-afv="Investor"]';
  const hasTagOpt = await page.$(invSel);
  ok("Investor tag offered from lead data", !!hasTagOpt);
  if (hasTagOpt) {
    await page.check(invSel);
    await page.click("#afApply");
    await page.waitForFunction(() => document.querySelectorAll("#leadRows tr").length === 1);
    const n2 = await page.textContent("#leadRows tr .lead-name");
    ok("email+tag AND logic leaves Alpha", n2.trim() === "Alpha Buyer", n2);
  }
  // clear all from the chip bar
  await page.click("#lChipBar [data-afclear]");
  await page.waitForFunction(() => document.querySelectorAll("#leadRows tr").length === 4);

  // People view shares the same panel + filter state
  await page.click('.rail .r[data-view="people"]');
  await page.waitForSelector("#peopleRows tr");
  await page.click("#pFilterBtn");
  await page.waitForSelector("#afScrim.on");
  await page.check('input[data-afk="leadType"][data-afv="seller"]');
  await page.click("#afApply");
  await page.waitForFunction(() => document.querySelectorAll("#peopleRows tr").length === 1);
  ok("People table honors the same filter", true);
  const lc = await page.evaluate(() => document.getElementById("lFilterBtn").textContent);
  ok("Leads button reflects shared state", lc.includes("FILTERED"));
  await page.click("#pChipBar [data-afclear]");
  await page.waitForFunction(() => document.querySelectorAll("#peopleRows tr").length === 4);

  // Web Activity group refuses honestly
  await page.click("#pFilterBtn");
  await page.waitForSelector("#afScrim.on");
  const nodataGroups = await page.$$eval(".afg.nodata", (g) => g.length);
  ok("Web Activity group rendered disabled", nodataGroups === 1);
  await page.click(".afg.nodata .afg-h");
  ok("clicking it does not open a filter", !(await page.$eval(".afg.nodata", (g) => g.classList.contains("open"))));
  await page.click("#afCancel");

  // COLUMNS: hide Source on Leads, survive a re-render (the old bug)
  await page.click('.rail .r[data-view="leads"]');
  const colsBtn = await page.$('#view-leads .pill-btn.ghost:has-text("COLUMNS")');
  await colsBtn.scrollIntoViewIfNeeded();
  await colsBtn.click();
  await page.waitForSelector('#ddMenu input[data-ck="source"]');
  await page.click('#ddMenu input[data-ck="source"]');
  await page.waitForTimeout(200);
  ok("columns menu stays open after a toggle", await page.$eval("#ddMenu", (m) => m.classList.contains("on")));
  await page.click("body", { position: { x: 5, y: 5 } });
  await page.waitForTimeout(100);
  const srcHidden = await page.$eval("#view-leads table.leads thead", (th) => {
    const ths = [...th.querySelectorAll("th")];
    const t = ths.find((x) => /source/i.test(x.textContent));
    return t && t.style.display === "none";
  });
  ok("Source column hides", !!srcHidden);
  // re-render via search (rebuilds tbody) — cells must STAY hidden
  await page.fill("#topSearch", "a");
  await page.waitForTimeout(200);
  await page.fill("#topSearch", "");
  await page.waitForTimeout(200);
  const bodyCellsAligned = await page.$eval("#view-leads table.leads", (tb) => {
    const ths = [...tb.querySelectorAll("thead th")];
    const idx = ths.findIndex((x) => /source/i.test(x.textContent));
    const tr = tb.querySelector("tbody tr");
    return tr && tr.children[idx] && tr.children[idx].style.display === "none";
  });
  ok("hidden column stays hidden after re-render (old bug)", !!bodyCellsAligned);

  // SORT BY: name via the pill, verify order + label
  const sortBtn = await page.$('#view-leads .pill-btn.ghost:has-text("SORT BY")');
  await sortBtn.scrollIntoViewIfNeeded();
  await sortBtn.click();
  await page.waitForSelector("#ddMenu button");
  await page.click('#ddMenu button:has-text("Name")');
  await page.waitForTimeout(200);
  const firstName = await page.textContent("#leadRows tr .lead-name");
  ok("sort by name ascending", firstName.trim() === "Alpha Buyer", firstName);
  ok("pill label updates", (await page.textContent('#view-leads .pill-btn.ghost:has-text("SORT BY")')).includes("NAME"));

  // persistence: reload — column still hidden, sort still name
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag") && /Live data/.test(document.querySelector(".demo-tag").textContent), null, { timeout: 15000 });
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  await page.waitForTimeout(500);
  const persisted = await page.$eval("#view-leads table.leads", (tb) => {
    const ths = [...tb.querySelectorAll("thead th")];
    const t = ths.find((x) => /source/i.test(x.textContent));
    return t && t.style.display === "none";
  });
  ok("hidden column persists across reload (server-saved)", !!persisted);
  const firstAfter = await page.textContent("#leadRows tr .lead-name");
  ok("sort persists across reload", firstAfter.trim() === "Alpha Buyer", firstAfter);

  // birthdate cell edit persists to the server
  const bdCell = await page.$('#leadRows .dtcell[data-kind="birthdate"][data-lid="lead_3"]');
  ok("birthdate cell present", !!bdCell);
  if (bdCell) {
    await bdCell.click();
    await page.keyboard.type("07/04/1985");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const snap3 = await J(await fetch(B + "/api/dashboard/data"));
    ok("birthdate edit persisted as ISO", snap3.leads.find((l) => l.id === "lead_3").birthday === "1985-07-04",
      JSON.stringify(snap3.leads.find((l) => l.id === "lead_3").birthday));
  }

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:", fail); process.exit(1); }
