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
  env: { ...process.env, PORT: String(PORT),
    /* The site lock defaults to ON as of 2026-08-22. These suites exercise the
       app, not the door, so it is switched off explicitly here rather than
       every fixture growing a login step. scripts/verify-site-lock.mjs is the
       one that tests the lock, and deliberately sets nothing. */
    SITE_LOGIN_ENABLED: "0", DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json") },
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
  /* The container pre-installs Chromium at PLAYWRIGHT_BROWSERS_PATH but a
     version-mismatched playwright package looks for a different revision —
     PW_CHROMIUM points launch at the real binary in that case. */
  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
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
  /* Intention became a BUTTON row (the meeting's ask), not a checkbox list. */
  await page.click('button[data-afb="leadType"][data-afbv="seller"]');
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
  /* Include Tags is a dropdown now; open it before ticking. */
  await page.click('.afdd[data-afdd="tagsInc"] .afdd-b');
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
  await page.click('button[data-afb="leadType"][data-afbv="seller"]');
  await page.click("#afApply");
  await page.waitForFunction(() => document.querySelectorAll("#peopleRows tr").length === 1);
  ok("People table honors the same filter", true);
  const lc = await page.evaluate(() => document.getElementById("lFilterBtn").textContent);
  ok("Leads button reflects shared state", lc.includes("FILTERED"));
  await page.click("#pChipBar [data-afclear]");
  await page.waitForFunction(() => document.querySelectorAll("#peopleRows tr").length === 4);

  // Web Activity still refuses honestly — but the filter is a centered modal
  // now, where every section is expanded and the left tree does the navigating.
  // So the reason is shown INLINE rather than behind a click that declines.
  await page.click("#pFilterBtn");
  await page.waitForSelector("#afScrim.on");
  const nodataGroups = await page.$$eval(".afg.nodata", (g) => g.length);
  ok("Web Activity group rendered disabled", nodataGroups === 1);
  ok("its heading is still styled as unavailable",
    await page.$eval(".afg.nodata .afg-h", (h) => getComputedStyle(h).cursor === "not-allowed" || getComputedStyle(h).color === "rgb(170, 178, 186)"));
  ok("and it states why, without needing a click that refuses",
    await page.$eval(".afg.nodata", (g) => /not connected/i.test(g.textContent)));
  ok("it offers no filter controls at all",
    (await page.$$eval(".afg.nodata input, .afg.nodata select, .afg.nodata .aftri button", (n) => n.length)) === 0);
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

  // SORT BY is a popover now (field + direction + SAVE), not a list menu.
  // The saved default is what must survive the reload below, so this SAVES.
  const sortBtn = await page.$('#view-leads .pill-btn.ghost:has-text("SORT BY")');
  await sortBtn.scrollIntoViewIfNeeded();
  await sortBtn.click();
  await page.waitForSelector("#sortPop.on #spField");
  await page.selectOption("#spField", "first_name");
  await page.waitForTimeout(400);
  const firstName = await page.textContent("#leadRows tr .lead-name");
  ok("sort by first name ascending", firstName.trim() === "Alpha Buyer", firstName);
  ok("pill label updates", (await page.textContent('#view-leads .pill-btn.ghost:has-text("SORT BY")')).includes("FIRST NAME"));
  await page.click("#sortPop #spSave");
  await page.waitForTimeout(500);

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

  /* ═══════════ the 24 August meeting's changes ═══════════ */

  /* Rows per page. Was a hard-coded 10 — 1,300 live leads across 130 pages. */
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  ok("a rows-per-page control exists on the pager", !!(await page.$("#perPageSel")));
  ok("and it defaults to 50, not 10", (await page.inputValue("#perPageSel")) === "50",
    await page.inputValue("#perPageSel"));
  const perOpts = await page.$$eval("#perPageSel option", (n) => n.map((o) => o.value));
  ok("offering 25 / 50 / 100", perOpts.join(",") === "25,50,100", perOpts.join(","));

  /* The filter panel: checkboxes became dropdowns and buttons. */
  await page.click("#lFilterBtn");
  await page.waitForSelector("#afScrim.on");
  for (const k of ["status", "stage", "assigned", "source", "tagsInc", "tagsExc"]) {
    ok(`${k} is a dropdown now, not a checkbox wall`, !!(await page.$(`.afdd[data-afdd="${k}"]`)));
  }
  for (const k of ["record", "leadType", "collaborators", "apptStatus", "agreementType", "agreementStatus"]) {
    ok(`${k} is a button row`, !!(await page.$(`button[data-afb="${k}"]`)));
  }

  /* Intention: the four options this CRM has no field for are refused with a
     reason rather than offered as filters that would match nothing. */
  const intentBtns = await page.$$eval('button[data-afb="leadType"]', (n) => n.map((b) => b.textContent.trim()));
  ok("Intention offers Seller, Buyer and Not Applicable",
    intentBtns.join(",") === "Seller,Buyer,Not Applicable", intentBtns.join(","));
  const genTxt = await page.textContent('.afg[data-afgk="General"]');
  ok("and says why Tenant / Landlord / Recruit / Candidate are not there",
    /not fields on a contact in this CRM/.test(genTxt));

  /* Tags gained Any/All on both include and exclude. */
  ok("Include Tags has an Any/All switch", !!(await page.$('button[data-afaa="tagsIncMode"]')));
  ok("Exclude Tags has one too", !!(await page.$('button[data-afaa="tagsExcMode"]')));
  ok("Any is the default", await page.$eval('button[data-afaa="tagsIncMode"][data-afaav="any"]',
    (b) => b.classList.contains("on")));

  /* Auto Plans: "Specific Plan" became "Auto Plan Name" plus status buttons. */
  const apTxt = await page.textContent('.afg[data-afgk="AutoPlans"]');
  ok("Auto Plans names the plan field per the meeting", /Auto Plan Name/.test(apTxt), apTxt.slice(0, 120));
  const apStat = await page.$$eval('button[data-afo="autoPlanStatus"]', (n) => n.map((b) => b.textContent.trim()));
  ok("with the meeting's status buttons",
    apStat.join(",") === "Any,Applied,Running,Paused,Completed", apStat.join(","));
  /* Deleted was on the list and has no state to filter on here. */
  ok("and Deleted is refused with its reason, not silently dropped",
    /removing a contact from a plan drops the enrollment/.test(apTxt));

  /* Reports: Last Market Report View. */
  const rvBtns = await page.$$eval('button[data-afo="reportView"]', (n) => n.map((b) => b.textContent.trim()));
  ok("Last Market Report View offers the date windows and Never",
    rvBtns.includes("Today") && rvBtns.includes("Last 30 days") && rvBtns.includes("Never"), rvBtns.join(","));
  ok("and says a view is a page open, not an email open",
    /not an email open/i.test(await page.textContent('.afg[data-afgk="Reports"]')));

  /* Contact Info gained Communication, Text Status, Phone Status, Address. */
  ok("Communication filter exists", !!(await page.$('button[data-afo="comms"]')));
  ok("Text Status filter exists", !!(await page.$('button[data-afo="textStatus"]')));
  ok("Phone Status filter exists", !!(await page.$('button[data-afo="phoneStatus"]')));
  ok("Home Address Location search exists", !!(await page.$("input[data-afaddr]")));
  const ciTxt = await page.textContent('.afg[data-afgk="ContactInfo"]');
  /* The meeting asked for landline/VoIP/DNC detection. That needs a paid
     carrier lookup that is not enabled, and guessing from an area code would
     be worse than not offering it. */
  ok("landline / VoIP detection is refused with its reason",
    /does not detect landline or VoIP/.test(ciTxt), ciTxt.slice(0, 200));
  ok("and the DNC flag is described as human-set, not registry-checked",
    /flag a human set/.test(ciTxt));
  ok("the address search says it does not call the MLS", /No MLS call is involved/.test(ciTxt));

  /* Appointments and Agreements are new groups. */
  const apptTxt = await page.textContent('.afg[data-afgk="AppointmentsTasks"]');
  ok("Appointments has status buttons and a date range",
    /Set \/ Scheduled/.test(apptTxt) && !!(await page.$('input[data-afd="apptFrom"]')), apptTxt.slice(0, 120));
  ok("Tasks offers Non-created / Overdue / Upcoming",
    /Non-created/.test(apptTxt) && /Overdue/.test(apptTxt) && /Upcoming/.test(apptTxt));
  ok("an Agreements group exists", !!(await page.$('.afg[data-afgk="Agreements"]')));
  ok("with Buyer / Seller / Referral types",
    (await page.$$eval('button[data-afb="agreementType"]', (n) => n.map((b) => b.textContent.trim()))).join(",")
      === "Buyer,Seller,Referral");

  /* Web Activity stays disabled — pointing it at the IDX needs a feed that
     does not exist, and the panel must say that rather than run on nothing. */
  ok("Web Activity says what connecting the IDX would take",
    /no such feed exists yet/.test(await page.textContent('.afg[data-afgk="WebActivity"]')));

  /* Archive / Trash. */
  const statusOpts = await page.$$eval('.afdd[data-afdd="status"] .afopt', (n) => n.map((e) => e.textContent.trim()));
  ok("Lead Status offers Archive and Trash",
    statusOpts.includes("Archive") && statusOpts.includes("Trash"), statusOpts.join(","));
  await page.click("#afClose");
  await page.waitForTimeout(200);

  /* Archiving a lead removes it from the default view WITHOUT deleting it. */
  await fetch(B + "/api/crm/lead/lead_4", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ crmStatus: "archived" }),
  });
  const arch = await J(await fetch(B + "/api/dashboard/data"));
  ok("the API accepts 'archived' as a status",
    arch.leads.find((l) => l.id === "lead_4").crmStatus === "archived",
    arch.leads.find((l) => l.id === "lead_4").crmStatus);
  /* The record is still there — that was the explicit requirement. */
  ok("and the lead still exists in full", !!arch.leads.find((l) => l.id === "lead_4").name);

  /* The sort fix. A column whose values mix numbers and strings used to
     compare as equal in both directions, so those rows never moved. */
  const sorted = await page.evaluate(() => {
    const rows = [
      { id: "a", name: "Zed" }, { id: "b", name: "" }, { id: "c", name: "alpha" }, { id: "d", name: "Mid" },
    ];
    window.TABLE_PREFS = window.TABLE_PREFS || {};
    window.TABLE_PREFS.t = { hidden: [], order: [], sortField: "name", sortDir: 1 };
    const asc = sortRows(rows, "t").map((r) => r.id).join("");
    window.TABLE_PREFS.t.sortDir = -1;
    const desc = sortRows(rows, "t").map((r) => r.id).join("");
    return { asc, desc };
  });
  ok("ascending sorts case-insensitively", sorted.asc.startsWith("cd"), JSON.stringify(sorted));
  ok("descending actually reverses it", sorted.desc.startsWith("ad"), JSON.stringify(sorted));
  /* Blanks sank in BOTH directions — the old sentinel floated them to the top
     on reverse and buried whatever was being looked for. */
  ok("and blanks stay last whichever way it points",
    sorted.asc.endsWith("b") && sorted.desc.endsWith("b"), JSON.stringify(sorted));

  /* The CMA column. */
  const cmaTh = await page.$('#view-leads th[data-sortk="cma"]');
  ok("CMA is a selectable, sortable column", !!cmaTh);

  /* ═══════════ the stage + appointment-type lists (25 Aug) ═══════════ */
  {
    const v = await J(await fetch(B + "/api/crm/vocabulary"));
    ok("the CRM serves one shared vocabulary", v.ok === true && Array.isArray(v.stageGroups));
    const groups = Object.fromEntries(v.stageGroups.map((g) => [g.group, g.stages.map((x) => x.label)]));
    ok("the two pipelines are named as the operator sees them",
      Object.keys(groups).join("|") === "Lead Stages|Candidate Recruit Stages", Object.keys(groups).join("|"));
    ok("Lead Stages is the full thirteen, in order",
      groups["Lead Stages"].join(",") ===
      "New Lead,Attempted Contact,Spoke With Customer,Appointment Set,Met With Customer,Showing Homes," +
      "Listing Agreement,Active Listing,Submitting Offers,Under Contract,Sale Closed,Nurture,Rejected",
      groups["Lead Stages"].join(","));
    ok("Candidate Recruit Stages is the full eleven, in order",
      groups["Candidate Recruit Stages"].join(",") ===
      "New Candidate,Attempted Contact,Spoke With Candidate,Appointment Set,Met With Candidate,Screening," +
      "Signing Appt Set,Signed,Nurture Candidate,Rejected Candidate,Declined Offer",
      groups["Candidate Recruit Stages"].join(","));
    /* The two pipelines share three step NAMES. Distinct VALUES are what stop
       a candidate at "Attempted Contact" being counted as a lead at it. */
    const leadVals = v.stageGroups[0].stages.map((x) => x.value);
    const candVals = v.stageGroups[1].stages.map((x) => x.value);
    ok("shared step names still carry distinct values per pipeline",
      leadVals.includes("attempted_contact") && candVals.includes("attempted_contact_candidate") &&
      !leadVals.some((x) => candVals.includes(x)),
      JSON.stringify([leadVals.filter((x) => candVals.includes(x))]));
    /* Old stored values must stay readable — nothing rewrites a row. */
    ok("legacy stage values still map to a label",
      v.stageLegacy && v.stageLegacy.new === "new_lead" && v.stageLegacy.closed === "sale_closed",
      JSON.stringify(v.stageLegacy));

    const types = v.appointmentTypeGroups.flatMap((g) => g.types);
    ok("appointment types are the twelve supplied",
      types.join(",") ===
      "Buyer Consultation,Listing Consultation,Buyer/Listing Consultation,Showing Appointment,Client Meeting," +
      "General,Follow Up,Meet & Greet,Screening,Recruiting Appointment,Signing Appointment,Recruiting Follow Up",
      types.join(","));
    /* This page had invented a thirteenth. */
    ok("and the invented 'Recruiting' entry is gone", !types.includes("Recruiting"));

    /* The write path must accept every stage it offers. A hard-coded list on
       the server silently downgraded anything new to "new" — the exact
       TASK_TYPES drift this repo has already been bitten by. */
    let r2 = await fetch(B + "/api/crm/lead/lead_1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crmStage: "listing_agreement" }),
    });
    ok("a new stage is accepted on write", r2.ok, String(r2.status));
    const back = await J(await fetch(B + "/api/dashboard/data"));
    ok("and round-trips instead of being downgraded",
      back.leads.find((l) => l.id === "lead_1").crmStage === "listing_agreement",
      back.leads.find((l) => l.id === "lead_1").crmStage);

    /* In the panel: grouped, with headers. */
    await page.click("#lFilterBtn");
    await page.waitForSelector("#afScrim.on");
    await page.waitForFunction(() =>
      document.querySelectorAll('.afdd[data-afdd="stage"] .afdd-g').length === 2, null, { timeout: 8000 });
    const hdrs = await page.$$eval('.afdd[data-afdd="stage"] .afdd-g', (n) => n.map((e) => e.textContent.trim()));
    ok("the Stage dropdown carries both group headers",
      hdrs.join("|") === "Lead Stages|Candidate Recruit Stages", hdrs.join("|"));
    const stOpts = await page.$$eval('.afdd[data-afdd="stage"] .afopt', (n) => n.length);
    ok("with all twenty-four stages under them", stOpts === 24, String(stOpts));

    ok("Appointments gained a Type dropdown", !!(await page.$('.afdd[data-afdd="apptType"]')));
    ok("and an Outcome dropdown", !!(await page.$('.afdd[data-afdd="apptOutcome"]')));
    const apptTypeOpts = await page.$$eval('.afdd[data-afdd="apptType"] .afopt', (n) => n.length);
    ok("the Type dropdown lists the twelve", apptTypeOpts === 12, String(apptTypeOpts));
    await page.click("#afClose");
    await page.waitForTimeout(200);
  }

  if (process.env.SHOT_DIR) {
    const D = process.env.SHOT_DIR;
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.click("#lFilterBtn");
    await page.waitForSelector("#afScrim.on");
    await page.waitForTimeout(400);
    await page.screenshot({ path: D + "/flt-01-panel.png" });
    await page.click('.afdd[data-afdd="status"] .afdd-b');
    await page.waitForTimeout(200);
    await page.screenshot({ path: D + "/flt-02-dropdown.png" });
    await page.click("#afClose");
    await page.waitForTimeout(300);
    await page.screenshot({ path: D + "/flt-03-leads.png" });
  }

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:", fail); process.exit(1); }
