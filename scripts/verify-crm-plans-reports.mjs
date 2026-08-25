#!/usr/bin/env node
/**
 * Auto Plan preview + Listing Alert / Market Report / CMA verification —
 * the five specs of Aug 2026 against the sidebar's outreach widgets.
 *
 * Usage: node scripts/verify-crm-plans-reports.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const PORT = Number(process.env.PORT || 3407);
const B = `http://localhost:${PORT}`;

let pass = 0; const fail = [];
const ok = (n, c, detail) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (detail ? " — " + detail : "")); console.error("FAIL " + n + (detail ? " — " + detail : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "crm-pr-"));

/* A small MLS mirror, so the alert builder and the report wizard have a real
   feed to count against rather than an empty one. */
const listingsDb = join(tmp, "listings.db");
{
  const db = new Database(listingsDb);
  db.exec(`CREATE TABLE listings (
    listing_key TEXT PRIMARY KEY, mls_number TEXT, status TEXT, list_price INTEGER, close_price INTEGER,
    street TEXT, city TEXT, state TEXT, postal_code TEXT, beds REAL, baths REAL, living_area REAL,
    lot_size REAL, year_built INTEGER, property_type TEXT, subdivision TEXT, list_agent TEXT,
    list_office TEXT, photo_url TEXT, public_remarks TEXT, modification_ts TEXT, listed_at TEXT,
    closed_at TEXT, raw TEXT NOT NULL, synced_at TEXT NOT NULL);
    CREATE TABLE listing_sync_state (id INTEGER PRIMARY KEY CHECK (id=1), backfill_complete INTEGER NOT NULL DEFAULT 1, backfill_offset INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO listing_sync_state (id) VALUES (1);
    CREATE TABLE listing_syncs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER NOT NULL DEFAULT 0, fetched INTEGER NOT NULL DEFAULT 0, upserted INTEGER NOT NULL DEFAULT 0, error TEXT);`);
  const ins = db.prepare(`INSERT INTO listings (listing_key,mls_number,status,list_price,close_price,street,city,state,postal_code,
    beds,baths,living_area,lot_size,year_built,property_type,subdivision,list_agent,list_office,photo_url,public_remarks,
    modification_ts,listed_at,closed_at,raw,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const raw = JSON.stringify({
    property: { pool: "N", stories: 1, subType: "SingleFamilyResidence",
      interiorFeatures: "Open Floor Plan,Island Kitchen", exteriorFeatures: "Covered Patio", garageSpaces: null },
    geo: { lat: null, lng: null, county: "Bexar" }, school: { district: "Northside" },
    mls: { status: "Active", daysOnMarket: 21 },
  });
  for (let i = 0; i < 16; i++) {
    ins.run(`K${i}`, `MLS${i}`, "Active", 250000 + i * 15000, null, `${100 + i} Kedros`, "San Antonio", "TX", "78245",
      3, 2, 2000, 0.25, 2010, "RES", "Kedros Ridge", "Agent", "Office", "https://example.test/p.jpg", "Lovely home.",
      "2026-08-10T00:00:00Z", "2026-08-01T00:00:00Z", null, raw, "2026-08-14T00:00:00Z");
  }
  db.close();
}

const mkLead = (n, over) => ({
  id: "lead_" + n, platform: "tiktok", userId: "u" + n, username: "user" + n,
  name: over.name, phone: over.phone ?? null, email: over.email ?? null, address: over.address ?? null,
  state: "new", source: "TikTok", adCampaign: null, propertyInquired: null, criteria: null, brivityId: null,
  crmStatus: "new", crmStage: "new", crmPriority: "normal", crmIntent: "buyer", crmCallQueue: "none", crmNotes: null,
  tags: [], createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
  assignedUserId: "marco", assignedUserName: "Marco", activity: [],
});
const leads = [
  mkLead(1, { name: "Plan Lead", email: "plan@example.com", phone: "8179954677", address: "1450 Kedros, San Antonio, TX 78245" }),
  mkLead(2, { name: "No Contact Person" }),
  mkLead(3, { name: "Third Person", phone: "2105550211", email: "third@example.com" }),
  /* lead_2 deliberately has neither an email nor a phone (that is the
     blocked-step case). A fourth with both keeps the live-data threshold met
     — the CRM keeps its demo set when fewer than three real leads come back. */
  mkLead(4, { name: "Fourth Person", phone: "2105550212", email: "fourth@example.com" }),
];
const db = { idCounter: 10, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] };
for (const l of leads) { db.leadsById[l.id] = l; db.leadKeyToId[l.platform + "::" + l.userId] = l.id; db.conversationsByLeadId[l.id] = { messages: [] }; }
writeFileSync(join(tmp, "db.json"), JSON.stringify(db));

/* One plan with all three step kinds and offsets that land on distinct days. */
writeFileSync(join(tmp, "auto-plans.json"), JSON.stringify([{
  id: "plan_demo", name: "New Lead Follow-Up", active: true, trigger: "manual", planType: "people",
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  steps: [
    { id: "s1", type: "email", dayOffset: 0, anchor: "enrollment", sendFrom: "primary_agent",
      subject: "Great to meet you, {{first_name}}", content: "Hi {{first_name}}, welcome aboard." },
    { id: "s2", type: "text", dayOffset: 1, anchor: "enrollment", sendFrom: "marco",
      content: "Hi {{first_name}} — any questions on those homes?" },
    { id: "s3", type: "task", dayOffset: 3, anchor: "enrollment", assignedTo: "Wesley", taskPriority: 2,
      content: "Call and qualify", instructions: "Confirm budget and timeline for {{first_name}}." },
    { id: "s4", type: "email", dayOffset: 2, anchor: "prev_step", afterStepId: "s3", sendFrom: "listing_agent",
      subject: "Homes for you", content: "A few new ones for {{first_name}}." },
  ],
}]));

const env = { ...process.env, PORT: String(PORT),
  /* These suites exercise the app, not the door. The site lock defaults to ON
     as of 2026-08-22, so it is switched off explicitly here rather than every
     fixture growing a login step. scripts/verify-site-lock.mjs is the one that
     tests the lock, and it deliberately sets nothing. */
  SITE_LOGIN_ENABLED: "0",
  DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  AUTO_PLANS_JSON_PATH: join(tmp, "auto-plans.json"), USER_PREFS_JSON_PATH: join(tmp, "user-prefs.json"),
  TRANSACTIONS_DB_PATH: join(tmp, "transactions.db"), CONTACT_RECORD_DB_PATH: join(tmp, "contact-records.db"),
  CONTACT_DOCS_DIR: join(tmp, "contact-docs"), OUTREACH_DB_PATH: join(tmp, "outreach.db"),
  SMS_DB_PATH: join(tmp, "sms.db"), LISTINGS_DB_PATH: listingsDb,
};
const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
let srvLog = ""; srv.stdout.on("data", (d) => (srvLog += d)); srv.stderr.on("data", (d) => (srvLog += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);
const J = (r) => r.json();
const post = (u, b) => fetch(B + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

try {
  /* ═══════════ spec 1: auto plan preview ═══════════ */

  let r = await fetch(B + "/api/auto-plans/plan_demo/preview?leadId=lead_1");
  ok("preview endpoint answers", r.ok, String(r.status));
  let pv = await J(r);
  ok("every step comes back", pv.steps.length === 4, String(pv.steps.length));
  const s1 = pv.steps[0], s2 = pv.steps[1], s3 = pv.steps[2], s4 = pv.steps[3];
  ok("day headers are computed from the offsets", s1.dayLabel === "Today" && s2.dayLabel === "Day 1" && s3.dayLabel === "Day 3",
    [s1.dayLabel, s2.dayLabel, s3.dayLabel].join(","));
  ok("enrollment-anchored steps carry a real send time", !!s1.sendAt && !!s2.sendAt);
  /* A step hanging off another step's completion has no knowable clock time
     before the plan runs; a fabricated timestamp would be worse than the rule. */
  ok("a prev-step-anchored step is shown by its rule, not a made-up time", s4.sendAt === null && /after/.test(s4.offsetLabel), JSON.stringify({ at: s4.sendAt, l: s4.offsetLabel }));
  ok("its day header says so", s4.dayLabel === "When its trigger fires", s4.dayLabel);
  ok("the primary-agent role resolves to the contact's agent", s1.sendFrom === "Marco", s1.sendFrom);
  ok("a role with no seat reports the fallback rather than hiding it", s4.sendFromFallback && /Listing Agent/i.test(s4.sendFromFallback), String(s4.sendFromFallback));
  ok("Send To is the real destination per step type", s1.sendTo === "plan@example.com" && s2.sendTo === "8179954677" && s3.sendTo === "Wesley",
    JSON.stringify([s1.sendTo, s2.sendTo, s3.sendTo]));
  ok("merge fields are left unresolved on purpose", /\{\{first_name\}\}/.test(s1.subject) && /\{\{first_name\}\}/.test(s1.content));
  ok("the payload says why", /filled in when the step actually sends/i.test(pv.note));
  ok("nothing is blocked for a contact with both an email and a phone", pv.steps.every((s) => !s.blocked));

  pv = await J(await fetch(B + "/api/auto-plans/plan_demo/preview?leadId=lead_2"));
  ok("a contact with no email blocks the email steps, and says so", /no email address/i.test(pv.steps[0].blocked || ""), String(pv.steps[0].blocked));
  ok("and the text step too", /no phone number/i.test(pv.steps[1].blocked || ""), String(pv.steps[1].blocked));
  ok("the task step is not blocked — it needs neither", !pv.steps[2].blocked);
  ok("preview 404s on an unknown plan", (await fetch(B + "/api/auto-plans/nope/preview?leadId=lead_1")).status === 404);
  ok("preview 404s on an unknown lead", (await fetch(B + "/api/auto-plans/plan_demo/preview?leadId=nope")).status === 404);

  /* ═══════════ spec 2/3: alert frequencies + templates ═══════════ */

  r = await post("/api/leads/lead_1/listing-alerts", {
    name: "Kedros under 400k", frequency: "twice_daily", sendNow: false,
    criteria: { cities: ["San Antonio"], maxPrice: 400000 },
  });
  ok("an alert saves on one of the new frequencies", r.ok, String(r.status));
  let alerts = (await J(await fetch(B + "/api/leads/lead_1/outreach"))).alerts || [];
  ok("twice_daily round-trips instead of collapsing to daily", alerts[0].frequency === "twice_daily", alerts[0].frequency);
  /* Twice daily has to actually schedule twice a day, not just store a word. */
  const gap = new Date(alerts[0].nextSendAt).getTime() - Date.now();
  ok("and it schedules the next send ~12 hours out", gap > 11 * 3600e3 && gap < 13 * 3600e3, String(Math.round(gap / 3600e3) + "h"));

  r = await post("/api/leads/lead_1/listing-alerts", {
    name: "Fast one", frequency: "multiple_per_day", sendNow: false, criteria: { cities: ["San Antonio"] },
  });
  const fast = ((await J(await fetch(B + "/api/leads/lead_1/outreach"))).alerts || []).find((a) => a.name === "Fast one");
  const fastGap = new Date(fast.nextSendAt).getTime() - Date.now();
  ok("multiple-times-a-day is four-hourly, the fastest the hourly sweep can keep", fastGap > 3.5 * 3600e3 && fastGap < 4.5 * 3600e3, String(Math.round(fastGap / 3600e3) + "h"));

  r = await post("/api/outreach/alert-templates", { name: "Luxury San Antonio", criteria: { cities: ["San Antonio"], minPrice: 650000 } });
  ok("a listing-alert template saves", r.ok);
  let tpls = (await J(r)).templates;
  ok("it comes back in the list", tpls.some((t) => t.name === "Luxury San Antonio"));
  ok("a template stores criteria only — no contact, no cadence",
    !("leadId" in tpls[0]) && !("frequency" in tpls[0]) && tpls[0].criteria.minPrice === 650000, JSON.stringify(tpls[0]));
  ok("an unnamed template is refused", (await post("/api/outreach/alert-templates", { criteria: {} })).status === 400);
  const tplId = tpls.find((t) => t.name === "Luxury San Antonio").id;
  r = await fetch(B + "/api/outreach/alert-templates/" + tplId, { method: "DELETE" });
  ok("a template deletes", r.ok && !(await J(r)).templates.some((t) => t.id === tplId));
  ok("the alerts made from it are untouched", ((await J(await fetch(B + "/api/leads/lead_1/outreach"))).alerts || []).length === 2);

  /* ═══════════ spec 4: report frequencies ═══════════ */

  r = await post("/api/leads/lead_1/market-reports", {
    name: "1450 Kedros", address: "1450 Kedros, San Antonio, TX 78245", frequency: "every_2_weeks",
    drip: true, sendNow: false, criteria: { cities: ["San Antonio"] }, subject: { sqft: 2000, beds: 3 },
  });
  ok("a market report saves on a two-week drip", r.ok, String(r.status));
  let reports = (await J(await fetch(B + "/api/leads/lead_1/outreach"))).reports || [];
  ok("every_2_weeks round-trips", reports[0].frequency === "every_2_weeks", reports[0].frequency);
  const rGap = new Date(reports[0].nextSendAt).getTime() - Date.now();
  ok("and schedules ~14 days out", rGap > 13 * 86400e3 && rGap < 15 * 86400e3, String(Math.round(rGap / 86400e3) + "d"));

  r = await post("/api/leads/lead_3/market-reports", {
    name: "One-off", address: "1450 Kedros, San Antonio, TX 78245", frequency: "never", drip: false, sendNow: false,
    criteria: {}, subject: {},
  });
  ok("a one-off report saves with the drip off", r.ok);
  const oneOff = ((await J(await fetch(B + "/api/leads/lead_3/outreach"))).reports || [])[0];
  ok("its frequency is never and its drip is off", oneOff.frequency === "never" && oneOff.drip === false, JSON.stringify({ f: oneOff.frequency, d: oneOff.drip }));

  /* ═══════════ spec 5: the reports dashboard ═══════════ */

  const dash = await J(await fetch(B + "/api/outreach/reports-dashboard"));
  ok("the dashboard lists every market report", dash.reports.length === 2, String(dash.reports.length));
  const row = dash.reports.find((x) => x.name === "1450 Kedros");
  ok("each row carries the spec's columns", row && row.created && row.assignedTo === "Marco" && row.location && "lastSent" in row && "lastOpened" in row && "views" in row,
    JSON.stringify(row));
  ok("reports created is a real count", dash.kpis.marketReportsCreated === 2);
  /* Nothing has been sent, so an open rate would be a division by zero — and
     "0%" would read as "nobody opens them". */
  ok("the open rate is null, not 0%, with nothing sent", dash.kpis.openRatePct === null, String(dash.kpis.openRatePct));
  ok("a percentage trend with no prior period is null, not +100%", dash.kpis.marketReportsTrendPct === null, String(dash.kpis.marketReportsTrendPct));
  /* CMAs are a live subsystem now. What the dashboard must keep saying is
     where their sold comparables can and cannot come from. */
  ok("CMA is reported as available, with a real count", dash.cma.available === true && dash.cma.created === 0,
    JSON.stringify(dash.cma));
  ok("and it still names the feed's missing solds",
    dash.cma.soldFromFeed === false && /publishes Active and Pending only/i.test(dash.cma.note), dash.cma.note);

  /* ═══════════ browser layer ═══════════ */

  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await br.newPage({ viewport: { width: 1600, height: 1150 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  await page.goto(B + "/crm", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag") && /Live data/.test(document.querySelector(".demo-tag").textContent), null, { timeout: 15000 });
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Plan Lead")');
  await page.waitForSelector("#ldPlansBlk");

  /* ── Auto Plans widget + apply/preview modals ── */
  await page.waitForFunction(() => !/Loading/.test(document.getElementById("ldPlansBlk").textContent), null, { timeout: 8000 });
  ok("the widget carries the spec's descriptive text",
    /Use Auto Plans to automate email, text, and tasks to save time/.test(await page.textContent("#ldPlansBlk")));
  await page.click("#ldPlanAdd");
  await page.waitForSelector("#apPlan");
  ok("+ ADD opens Apply an Auto Plan", /Apply an Auto Plan/.test(await page.textContent("#oaOv .oa-head")));
  ok("the dropdown placeholder is the spec's", /Select an auto plan/.test(await page.textContent("#apPlan")));
  ok("PREVIEW and APPLY are both disabled until a plan is picked",
    (await page.$eval("#apPreview", (b) => b.disabled)) && (await page.$eval("#apApply", (b) => b.disabled)));
  await page.selectOption("#apPlan", "plan_demo");
  ok("picking a plan enables both",
    !(await page.$eval("#apPreview", (b) => b.disabled)) && !(await page.$eval("#apApply", (b) => b.disabled)));

  await page.click("#apPreview");
  await page.waitForSelector("#oaOv .ap-two", { timeout: 8000 });
  ok("PREVIEW opens the named step modal", /Auto Plan: New Lead Follow-Up/.test(await page.textContent("#oaOv .oa-head")));
  const dayHeads = await page.$$eval("#oaOv .ap-day", (els) => els.map((e) => e.textContent.trim()));
  ok("the left timeline groups by day", dayHeads[0] === "Today" && dayHeads.includes("Day 1") && dayHeads.includes("Day 3"), JSON.stringify(dayHeads));
  ok("every step is listed", (await page.$$("#oaOv .ap-step")).length === 4);
  /* The title and the execution time are separate lines; a run-on reads as
     "…for a quick call5:12 pm". */
  ok("the step's time sits on its own line", await page.$eval("#oaOv .ap-step .tm", (e) => getComputedStyle(e).display === "block"));
  ok("the first step is selected", (await page.$$("#oaOv .ap-step.on")).length === 1);
  const meta = await page.textContent("#oaOv .ap-meta");
  ok("the inspector shows Send From, Send To and Send At", /Send From/.test(meta) && /Send To/.test(meta) && /Send At/.test(meta));
  ok("Send From is the resolved agent", /Marco/.test(meta), meta.replace(/\s+/g, " ").slice(0, 160));
  ok("merge fields are highlighted rather than substituted",
    (await page.$$("#oaOv .ap-mf")).length > 0 && /\{\{first_name\}\}/.test(await page.textContent("#oaOv .ap-card")));
  await page.click("#oaOv .ap-step:nth-of-type(1)").catch(() => {});
  const steps = await page.$$("#oaOv .ap-step");
  await steps[2].click();
  await page.waitForTimeout(250);
  ok("clicking a step swaps the inspector", /Wesley/.test(await page.textContent("#oaOv .ap-meta")), (await page.textContent("#oaOv .ap-meta")).replace(/\s+/g, " ").slice(0, 160));
  ok("BACK returns to the selection modal", (await page.$("#apBack")) !== null);
  await page.click("#apApply2");
  await page.waitForFunction(() => /ACTIVE/.test(document.getElementById("ldPlansBlk").textContent), null, { timeout: 8000 });
  ok("APPLY PLAN from the preview enrols the contact", true);

  /* ── Listing alert editor ── */
  await page.click("#ldAlertAdd");
  await page.waitForSelector("#oaName", { timeout: 10000 });
  const freqOpts = await page.$$eval("#oaFreq option", (els) => els.map((e) => e.textContent.trim()));
  ok("the six email frequencies are offered",
    freqOpts.join(",") === "Daily,Twice Daily,Multiple Times Per Day,Weekly,Every 2 Weeks,Monthly", freqOpts.join(","));
  ok("a template selector and MANAGE TEMPLATES are present", (await page.$("#oaTpl")) !== null && (await page.$("#oaTplManage")) !== null);
  ok("Search By offers Terms and Map", (await page.$$("#oaModes button")).length === 2);
  ok("Map is disabled because no provider is configured", await page.$eval('#oaModes button[data-lamode="map"]', (b) => b.disabled));
  ok("the Home App checkbox is replaced by the reason it cannot work",
    /no client mobile app connected/i.test(await page.textContent("#oaOv")));
  const bedOpts = await page.$$eval("#oaBMin option", (els) => els.map((e) => e.textContent.trim()));
  ok("bedrooms is a No Min ladder, not a free number", bedOpts[0] === "No Min" && bedOpts.includes("7"), JSON.stringify(bedOpts));
  const bathOpts = await page.$$eval("#oaBaMin option", (els) => els.map((e) => e.textContent.trim()));
  ok("bathrooms carries the half steps", bathOpts.includes("1.5") && bathOpts.includes("1.75"), JSON.stringify(bathOpts));
  /* MORE is offered exactly where a group has more than the two visible rows.
     It used to be on every group, including ones with a single checkbox, where
     it was a control that did nothing. */
  ok("checkbox groups are rendered", (await page.$$("#oaOv .la-grp")).length >= 3);
  ok("MORE appears on the groups that overflow, and only those",
    await page.$$eval("#oaOv .la-grp", (gs) => gs.every((g) =>
      (g.querySelectorAll(".oa-ck").length > 4) === !!g.querySelector(".more"))));
  const collapsed = await page.$("#oaOv .la-grp:not(.open) h6[data-latoggle]");
  if (collapsed) {
    const key = await collapsed.evaluate((h) => h.getAttribute("data-latoggle"));
    await collapsed.click();
    await page.waitForTimeout(200);
    ok("clicking the header expands one",
      await page.$eval(`#oaOv [data-lagrp="${key}"]`, (e) => e.classList.contains("open")));
  } else {
    ok("nothing is hidden when no group overflows",
      await page.$$eval("#oaOv .la-grp", (gs) => gs.every((g) => g.classList.contains("open"))));
  }
  ok("the footer states the immediate first email", /sends an initial email/i.test(await page.textContent("#oaOv .la-foot-note")));
  await page.waitForTimeout(1200);
  ok("the count reads as VIEW N LISTINGS", /VIEW \d+ LISTINGS?/.test(await page.textContent("#oaCount")), await page.textContent("#oaCount"));
  await page.click("#oaCount");
  await page.waitForSelector("#oaOv .wa-card", { timeout: 8000 });
  ok("clicking it shows the real matching listings", (await page.$$("#oaOv .wa-card")).length > 0);
  await page.click("#oaOv .oa-cancel");
  await page.waitForTimeout(300);

  /* ── Market report wizard ── */
  await page.click("#ldReportAdd");
  await page.waitForSelector("#mwAddr", { timeout: 10000 });
  ok("the wizard opens on Search Criteria", /Search Criteria/.test(await page.textContent("#oaOv .mw-steps")));
  ok("Smart Radius is on by default", await page.$eval("#mwSmart", (e) => e.classList.contains("on")));
  /* The switch is an .oa-f's own label, which otherwise inherits that rule's
     block display and stacks the knob on top of its own words. */
  ok("the toggle renders beside its label, not under it",
    await page.$eval("#mwSmart", (e) => getComputedStyle(e).display === "inline-flex"),
    await page.$eval("#mwSmart", (e) => getComputedStyle(e).display));
  ok("the missing map provider is stated in place", /No map provider is configured/.test(await page.textContent("#oaOv")));
  await page.fill("#mwSqft", "2000");
  await page.waitForTimeout(1800);
  ok("the automated estimate comes from the real comps", /^\$/.test((await page.textContent("#mwAuto")).trim()), await page.textContent("#mwAuto"));
  await page.click("#mwAdjToggle");
  await page.waitForSelector("#mwAdj");
  ok("SHOW ESTIMATE ADJUSTMENT reveals a $/% toggle", (await page.$$("#oaOv [data-mwunit]")).length === 2);
  await page.click("#mwNext");
  await page.waitForSelector("#mwName", { timeout: 8000 });
  ok("step 2 is Preview and Send", /Preview and Send/.test(await page.textContent("#oaOv .mw-steps")));
  ok("the drip toggle is on by default", await page.$eval("#mwDrip", (e) => e.classList.contains("on")));
  await page.fill("#mwName", "Browser report");
  await page.click("#mwSaveClose");
  await page.waitForTimeout(1200);
  reports = (await J(await fetch(B + "/api/leads/lead_1/outreach"))).reports || [];
  const made = reports.find((x) => x.name === "Browser report");
  ok("SAVE & CLOSE stored the report", !!made, JSON.stringify(reports.map((x) => x.name)));
  ok("with the drip schedule chosen in the wizard", made && made.drip === true, JSON.stringify(made && { d: made.drip, f: made.frequency }));

  /* ── Market Reports card ── */
  await page.waitForFunction(() => /MORE INFO/.test(document.getElementById("ldReportsBlk").textContent), null, { timeout: 9000 });
  ok("the card is collapsed with a MORE INFO toggle", /MORE INFO/.test(await page.textContent("#ldReportsBlk")));
  ok("it pages between the two reports", (await page.$("#ldReportsBlk [data-mrdown]")) !== null);
  await page.click("#ldReportsBlk [data-mrtoggle]");
  await page.waitForTimeout(250);
  const card = await page.textContent("#ldReportsBlk");
  ok("expanded it shows Last Viewed, Last Opened, Frequency, Created and View History",
    /Last Viewed/.test(card) && /Last Opened/.test(card) && /Frequency/.test(card) && /Created/.test(card) && /View History/.test(card),
    card.replace(/\s+/g, " ").slice(0, 220));
  ok("unmeasured dates read N/A rather than a fake date", /N\/A/.test(card));

  /* ── CMA widget + reports dashboard ── */
  await page.click("#ldCmaAdd");
  await page.waitForSelector('#ddMenu button:has-text("New CMA Report")');
  ok("+ ADD offers New CMA Report and View Report Status",
    (await page.$$eval("#ddMenu button", (els) => els.map((e) => e.textContent.trim()))).join("|").includes("View Report Status"));
  /* This used to assert the refusal. The CMA builder exists now, so + ADD
     opens it — in a new tab, because the wizard is a full-page workflow and
     losing the contact record behind it is not what the operator asked for. */
  const href = await page.$eval('#ddMenu button:has-text("New CMA Report")', () => {
    /* The menu item calls window.open; read the URL the page would use. */
    return window.cmaHref({ id: "lead_1" }, null);
  });
  ok("New CMA Report opens the real wizard, scoped to this contact",
    /^\/cma\?leadId=lead_1/.test(href), href);
  await page.keyboard.press("Escape");
  await page.click("body", { position: { x: 5, y: 5 } });
  await page.waitForTimeout(250);

  await page.click("#ldCmaAdd");
  await page.waitForSelector('#ddMenu button:has-text("View Report Status")');
  await page.click('#ddMenu button:has-text("View Report Status")');
  await page.waitForSelector("#oaOv .rd-tbl", { timeout: 9000 });
  const heads = await page.$$eval("#oaOv .rd-tbl th", (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
  ok("the dashboard table has the spec's columns",
    heads.join(",") === "Created,Assigned To,Name,Location,Contact,Last Sent,Last Opened,Views,Last Viewed", heads.join(","));
  ok("it lists the reports that exist", (await page.$$("#oaOv .rd-tbl tbody tr")).length === 3, String((await page.$$("#oaOv .rd-tbl tbody tr")).length));
  const kpiTxt = await page.textContent("#oaOv .rd-kpis");
  ok("the open rate is a dash with its reason, not 0%", /—/.test(kpiTxt) && /Nothing has been sent yet/.test(kpiTxt), kpiTxt.replace(/\s+/g, " ").slice(0, 220));
  /* The KPI has a real number behind it now. What must stay true is that the
     dashboard keeps saying solds do not come from the feed. */
  ok("the CMA KPI reports a real count", /CMA Reports Created/.test(kpiTxt) && /published/.test(kpiTxt),
    kpiTxt.replace(/\s+/g, " ").slice(0, 240));
  ok("and the CMA panel still says solds are not from the feed",
    /publishes Active and Pending only/i.test(await page.textContent("#oaOv")));

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("\nFAILURES:\n" + fail.map((f) => " - " + f).join("\n")); if (srvLog) console.error("\n--- server log tail ---\n" + srvLog.slice(-2500)); process.exit(1); }
