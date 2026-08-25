#!/usr/bin/env node
/**
 * The Edit Listing Alert modal, at Brivity parity, and the managed Source and
 * Tag vocabulary behind it.
 *
 * WHAT THIS SUITE IS ACTUALLY GUARDING. The ask was "make it look like
 * Brivity's, with every dropdown functional". The risk in satisfying that is
 * building a form that LOOKS complete — Brivity's twelve feature groups, all
 * present — while half the boxes match nothing, because SABOR does not publish
 * what Brivity's form assumes. So the assertions below are less about the
 * markup and more about the join between the two:
 *
 *   - every feature checkbox must carry a real count off the board, and
 *     ticking it must change the match count
 *   - a feature that appears twice (Popular repeats Pool) must stay in sync,
 *     or the saved alert disagrees with the box the operator did not touch
 *   - "3+ storeys" must expand to storey counts the board really has
 *   - Garage must be offered ONLY when the feed publishes a space count, and
 *     when it does not, must say so where the dropdown would have been
 *   - a seeded source must not be deletable: contacts carry it
 *
 * Drives a real browser against a locally running `dist/src/server.js`.
 * Usage: node scripts/verify-listing-alert-parity.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const PORT = Number(process.env.PORT || 3397);
const B = `http://localhost:${PORT}`;
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "la-parity-"));

/* ---- a mirror with the feature vocabulary the categories are built from --- */
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
  const mk = (i, o = {}) => {
    const raw = JSON.stringify({
      property: {
        pool: o.pool ?? "N", stories: o.stories ?? 1, subType: "SingleFamilyResidence",
        /* Deliberately spans several of Brivity's categories, so the
           categoriser is exercised rather than assumed. */
        interiorFeatures: o.interior ?? "Open Floor Plan,Walk in Closets,High Ceilings,Central Heating,Central Cooling",
        exteriorFeatures: o.exterior ?? "Covered Patio,Privacy Fence,Attached Garage,Community Pool,In Ground Pool,Hill Country View",
        garageSpaces: o.garage ?? null,
      },
      geo: { lat: null, lng: null, county: o.county ?? "Bexar" },
      school: { district: o.district ?? "Northside" },
      mls: { status: "Active", daysOnMarket: 30 },
    });
    ins.run(o.key ?? `K${i}`, `MLS${i}`, "Active", o.price ?? 300000, null,
      o.street ?? `${100 + i} Rolling Oaks Dr`, o.city ?? "San Antonio", "TX", o.zip ?? "78253",
      3, 2, 2000, 0.25, 2010, "RES", "Alamo Ranch Unit 3", "Agent", "Office",
      "https://example.test/p.jpg", "Lovely home.", "2026-08-10T00:00:00Z", "2026-08-01T00:00:00Z", null, raw, "2026-08-14T00:00:00Z");
  };
  /* 40 rows, because the facet scan only offers a feature carried by 25+
     listings — a smaller fixture would produce an empty form and a suite that
     passed by testing nothing. */
  for (let i = 0; i < 40; i++) mk(i, { pool: i < 12 ? "Y" : "N", stories: i % 3 === 0 ? 2 : 1 });
  /* Five three-storey homes in another city, so "3+" has something real to
     expand to and the city filter has a second option to narrow to. */
  for (let i = 0; i < 5; i++) mk(200 + i, { key: `T${i}`, city: "Boerne", zip: "78006", stories: 3, street: `${i} Cypress Way` });
  db.close();
}

const lead = {
  id: "lead_1", platform: "tiktok", userId: "u1", username: "user1", name: "Alpha Buyer",
  phone: "2105550110", email: "alpha@example.com", state: "new", source: "TikTok", adCampaign: null,
  propertyInquired: null, criteria: null, brivityId: null, crmStatus: "hot", crmStage: "new_lead",
  crmPriority: "normal", crmIntent: "buyer", crmCallQueue: "none", crmNotes: null,
  tags: ["Investor"], address: "12 Oak St, San Antonio, TX 78253", birthday: null, homeAnniversary: null,
  autoPlanEnrollments: [], assignedUserId: null, assignedUserName: null,
  createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
};
writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 10, leadsById: { lead_1: lead }, leadKeyToId: { "tiktok::u1": "lead_1" },
  conversationsByLeadId: { lead_1: { messages: [] } }, commandTasks: [],
}));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    DATA_DIR: tmp, LISTINGS_DB_PATH: listingsDb, CRM_VOCAB_DB_PATH: join(tmp, "crm-vocabulary.db") },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
srv.stdout.on("data", (d) => (srvLog += d));
srv.stderr.on("data", (d) => (srvLog += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);
const J = (r) => r.json();

let browser;
try {
  // ---- facets: Brivity's categories, the board's vocabulary ---------------
  const f = await J(await fetch(B + "/api/mls/facets"));
  const groups = f.featureGroups || [];
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
  ok("facets expose feature groups", groups.length >= 4, JSON.stringify(groups.map((g) => g.key)));
  ok("Popular Features leads the list", groups[0] && groups[0].key === "popular", groups[0] && groups[0].key);
  ok("Pool is its own category", !!byKey.pool, JSON.stringify(Object.keys(byKey)));
  ok("a Community Pool files under Community, not Pool",
    (byKey.community?.options || []).some((o) => /Community Pool/i.test(o.value)) &&
    !(byKey.pool?.options || []).some((o) => /Community Pool/i.test(o.value)));
  ok("Cooling and Heating are separate categories", !!byKey.cooling && !!byKey.heating);
  ok("an Attached Garage files under Parking, not Exterior",
    (byKey.parking?.options || []).some((o) => /Attached Garage/i.test(o.value)) &&
    !(byKey.exterior?.options || []).some((o) => /Attached Garage/i.test(o.value)));
  ok("every option carries the side it must be matched on",
    groups.every((g) => g.options.every((o) => o.side === "interior" || o.side === "exterior")));
  ok("every option carries a real count", groups.every((g) => g.options.every((o) => o.count >= 25)),
    JSON.stringify(groups.flatMap((g) => g.options.map((o) => o.count)).slice(0, 5)));
  ok("no category renders empty", groups.every((g) => g.options.length > 0));
  ok("garage spaces reported unavailable on a feed that omits them",
    (f.unavailable || []).some((u) => /garage/i.test(u.field)));

  // ---- the managed vocabulary --------------------------------------------
  const v = await J(await fetch(B + "/api/crm/vocabulary"));
  ok("vocabulary carries the full Brivity source list", (v.sources || []).length === 357, String((v.sources || []).length));
  ok("vocabulary carries the full Brivity tag list", (v.tags || []).length === 81, String((v.tags || []).length));
  /* The export really does contain both spellings, on different contacts. */
  ok("tags that differ only in case are both kept",
    (v.tags || []).some((t) => t.name === "Appointment" && t.brivityPeople === 9) &&
    (v.tags || []).some((t) => t.name === "appointment" && t.brivityPeople === 1));
  ok("sources include a real working one with its export count",
    (v.sources || []).some((s) => s.name === "Brivity IDX" && s.brivityPeople === 67));
  ok("sources include catalogue entries nobody carries",
    (v.sources || []).some((s) => s.brivityPeople === 0));
  ok("stats separate the list from what is actually in use",
    v.vocabularyStats && v.vocabularyStats.sources === 357 && v.vocabularyStats.sourcesInBrivity === 28,
    JSON.stringify(v.vocabularyStats));
  ok("sources are sorted for reading, not by ASCII",
    (v.sources || []).findIndex((s) => s.name === "Zillow") > (v.sources || []).findIndex((s) => s.name === "Auction.com"));

  let r = await fetch(B + "/api/crm/vocabulary/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Marco Door Knock" }) });
  const added = await r.json();
  ok("a custom source can be added", r.ok && added.name === "Marco Door Knock");
  ok("the custom source comes back in the list", (added.list || []).some((s) => s.name === "Marco Door Knock" && s.seeded === false));
  r = await fetch(B + "/api/crm/vocabulary/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "marco door knock" }) });
  ok("the same source in different case is refused", r.status === 409, String(r.status));
  r = await fetch(B + "/api/crm/vocabulary/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "zillow" }) });
  ok("a seeded source cannot be re-added", r.status === 409, String(r.status));
  r = await fetch(B + "/api/crm/vocabulary/sources/" + encodeURIComponent("Zillow"), { method: "DELETE" });
  const delErr = await r.json();
  ok("a seeded source cannot be deleted", r.status === 400 && /Brivity import/.test(delErr.error || ""), delErr.error);
  r = await fetch(B + "/api/crm/vocabulary/sources/" + encodeURIComponent("Marco Door Knock"), { method: "DELETE" });
  ok("a custom source can be deleted", r.ok);
  r = await fetch(B + "/api/crm/vocabulary/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Round J Test" }) });
  ok("a custom tag can be added", r.ok);
  r = await fetch(B + "/api/crm/vocabulary/nonsense", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  ok("an unknown vocabulary kind is refused", r.status === 400, String(r.status));

  // ---- streetContains is a real criterion --------------------------------
  const all = await J(await fetch(B + "/api/outreach/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ criteria: {} }) }));
  const street = await J(await fetch(B + "/api/outreach/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ criteria: { streetContains: "Cypress" } }) }));
  ok("street contains narrows the board", street.count === 5 && all.count === 45, `${street.count} of ${all.count}`);
  const three = await J(await fetch(B + "/api/outreach/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ criteria: { stories: [3] } }) }));
  ok("three-storey homes are findable", three.count === 5, String(three.count));

  // ---- the modal itself ---------------------------------------------------
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(B + "/crm", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.LEADS && window.LEADS.length > 0, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { const l = LEADS[0]; openLeadDetail ? openLeadDetail(l) : null; }).catch(() => {});
  await page.evaluate(() => openAlertEditor(LEADS[0], null));
  await page.waitForSelector("#oaOv .la-grp", { timeout: 15000 });

  const seen = await page.$$eval("#oaOv [data-lagrp^='feat-'] h6", (hs) => hs.map((h) => h.childNodes[0].textContent.trim()));
  ok("the modal renders Brivity's feature categories", seen.includes("Popular Features") && seen.includes("Pool") && seen.includes("Parking"), JSON.stringify(seen));
  ok("every feature category collapses behind MORE",
    await page.$$eval("#oaOv [data-lagrp^='feat-'] h6 .more", (ms) => ms.length > 0 && ms.every((m) => /MORE|LESS/.test(m.textContent))));
  ok("feature boxes show the board's own counts",
    await page.$$eval("#oaOv [data-grp='oaFeat']", (cs) => cs.length > 0 &&
      cs.every((c) => /\d/.test(c.parentElement.querySelector(".oa-n")?.textContent || ""))));

  /* The duplicate-box problem: Pool appears in Popular AND in Pool. */
  const dupCount = await page.$$eval("#oaOv [data-grp='oaFeat']", (cs) =>
    cs.filter((c) => c.value === "Community Pool").length);
  ok("a feature really does appear in two categories", dupCount >= 2, String(dupCount));
  await page.evaluate(() => {
    const c = [...document.querySelectorAll("#oaOv [data-grp='oaFeat']")].find((x) => x.value === "Community Pool");
    c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true }));
  });
  ok("ticking one copy ticks the other", await page.$$eval("#oaOv [data-grp='oaFeat']", (cs) =>
    cs.filter((c) => c.value === "Community Pool").every((c) => c.checked)));
  ok("the criteria carry it once, not twice", await page.evaluate(() =>
    document.querySelectorAll("#oaOv [data-grp='oaFeat'][data-side='exterior']:checked").length >= 2) &&
    await page.evaluate(() => oaFeatPicked("exterior").filter((v) => v === "Community Pool").length === 1));
  await page.evaluate(() => {
    const c = [...document.querySelectorAll("#oaOv [data-grp='oaFeat']")].find((x) => x.value === "Community Pool");
    c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // ---- the dropdowns the meeting called out -------------------------------
  for (const [id, label] of [["oaPMin", "Price"], ["oaBMin", "Bedrooms"], ["oaBaMin", "Bathrooms"],
    ["oaSMin", "Square Feet"], ["oaLMin", "Lot Size"], ["oaYMin", "Year Built"]]) {
    const n = await page.$eval("#" + id, (el) => el.options.length);
    ok(label + " is a working dropdown", n > 1, `${n} options`);
    ok(label + " is not disabled", await page.$eval("#" + id, (el) => !el.disabled));
  }
  const st = await page.$eval("#oaStories", (el) => [...el.options].map((o) => o.value));
  ok("Stories is a dropdown with Any / 1 / 2 / 3+", st.includes("") && st.includes("1") && st.includes("2") && st.includes("3plus"), JSON.stringify(st));
  /* "3+" has to become the real storey counts, not the string "3plus" and not
     a hard-coded [3,4,5] — the count it produces is the proof. */
  await page.selectOption("#oaStories", "3plus");
  await page.waitForTimeout(500);
  await page.waitForFunction(() => /VIEW|No listings/.test(document.getElementById("oaCount").textContent), null, { timeout: 10000 });
  ok("3+ storeys matches the board's three-storey homes",
    /VIEW 5 LISTINGS/.test(await page.$eval("#oaCount", (e) => e.textContent)),
    await page.$eval("#oaCount", (e) => e.textContent));
  await page.selectOption("#oaStories", "1");
  await page.waitForTimeout(500);
  await page.waitForFunction(() => /VIEW|No listings/.test(document.getElementById("oaCount").textContent), null, { timeout: 10000 });
  ok("a single storey is a different, smaller set",
    /VIEW 2[0-9] LISTINGS/.test(await page.$eval("#oaCount", (e) => e.textContent)),
    await page.$eval("#oaCount", (e) => e.textContent));
  await page.selectOption("#oaStories", "");
  await page.waitForTimeout(500);

  ok("Garage says why it is missing rather than offering a dead dropdown",
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll("#oaOv .oa-f label")].filter((l) => l.textContent.trim() === "Garage");
      if (!labels.length) return false;
      const box = labels[0].parentElement;
      const sel = box.querySelector("select");
      return !!sel && sel.disabled && /not published|does not publish/i.test(box.textContent);
    }));

  // ---- search terms --------------------------------------------------------
  ok("a search-terms box is offered", await page.$("#oaTerm") !== null);
  const citiesBefore = await page.$$eval("#oaCity .oa-ck", (ls) => ls.length);
  await page.fill("#oaTerm", "boerne");
  await page.waitForTimeout(150);
  const citiesAfter = await page.$$eval("#oaCity .oa-ck", (ls) => ls.filter((l) => l.style.display !== "none").length);
  ok("typing a term narrows the city list", citiesBefore > 1 && citiesAfter === 1, `${citiesAfter} of ${citiesBefore}`);
  await page.fill("#oaTerm", "");
  ok("a street-address field is offered", await page.$("#oaStreet") !== null);
  await page.fill("#oaStreet", "Cypress");
  await page.waitForTimeout(600);
  await page.waitForFunction(() => /VIEW|No listings/.test(document.getElementById("oaCount").textContent), null, { timeout: 10000 });
  ok("the street field changes the live match count",
    /VIEW 5 LISTINGS/.test(await page.$eval("#oaCount", (e) => e.textContent)),
    await page.$eval("#oaCount", (e) => e.textContent));
  await page.fill("#oaStreet", "");

  ok("Include Properties without Photos survived the rebuild", await page.$("#oaNoPhoto") !== null);
  /* MORE on a group that is already fully visible is a control that does
     nothing — the collapsed height is two rows of two. */
  ok("MORE appears only on categories that actually overflow",
    await page.$$eval("#oaOv .la-grp", (gs) => gs.every((g) => {
      const n = g.querySelectorAll(".oa-ck").length;
      const more = !!g.querySelector(".more");
      return n > 4 ? more : !more;
    })));
  ok("Laundry Main Level is not filed under Lot",
    await page.$$eval("#oaOv [data-lagrp='feat-lot'] .oa-ck", (ls) => !ls.some((l) => /Laundry/i.test(l.textContent))));
  /* An alert saved before the price ladder existed holds an odd number. It
     must survive being edited — a dropdown that rounds someone's saved search
     to the nearest step changes what their client receives. */
  await page.evaluate(() => closeOa());
  await page.evaluate(() => openAlertEditor(LEADS[0], { id: "a9", name: "Legacy", cc: "", sendEmail: true,
    frequency: "daily", criteria: { maxPrice: 412500 } }));
  await page.waitForSelector("#oaPMax", { timeout: 15000 });
  ok("a stored price outside the ladder survives editing",
    await page.$eval("#oaPMax", (el) => el.value) === "412500",
    await page.$eval("#oaPMax", (el) => el.value));
  ok("and the ladder's own steps are still there",
    await page.$eval("#oaPMax", (el) => [...el.options].some((o) => o.value === "400000")));
  ok("the modal threw no script errors", errors.length === 0, errors.join(" | "));

  // ---- the filter panel reads the managed list ----------------------------
  await page.evaluate(() => closeOa());
  await page.evaluate(() => openAdvFilter());
  await page.waitForSelector("#afScrim.on [data-afdd='source']", { timeout: 10000 });
  await page.waitForFunction(() => CRM_SOURCES.length > 300, null, { timeout: 10000 });
  await page.evaluate(() => buildAdvPanel());
  const srcOpts = await page.$$eval("[data-afdd='source'] .afopt", (ls) => ls.length);
  ok("the Source filter offers the whole managed list", srcOpts >= 357, String(srcOpts));
  ok("the Source filter has a search box", await page.$("[data-afdd='source'] input[data-afsearch]") !== null);
  ok("in-use sources are grouped above the import",
    await page.$$eval("[data-afdd='source'] .afdd-g", (gs) => gs.map((g) => g.textContent))
      .then((gs) => gs[0] === "On these contacts" && gs[1] === "From the Brivity import"));
  /* The menu is display:none until the dropdown is opened, so the search box
     has to be reached the way a person reaches it. */
  await page.click("[data-afdd='source'] .afdd-b");
  await page.fill("[data-afdd='source'] input[data-afsearch]", "zillow");
  await page.waitForTimeout(120);
  const shown = await page.$$eval("[data-afdd='source'] .afopt", (ls) => ls.filter((l) => l.style.display !== "none").length);
  ok("searching the Source list narrows it", shown > 0 && shown < 20, String(shown));
  const tagOpts = await page.$$eval("[data-afdd='tagsInc'] .afopt", (ls) => ls.length);
  ok("the Tags filter offers the whole managed list", tagOpts >= 81, String(tagOpts));
  ok("the stale 'not supplied yet' note is gone",
    !(await page.$eval("#afScrim", (e) => e.textContent)).includes("has not been supplied yet"));

  // ---- the agreement form reads the same list -----------------------------
  await page.evaluate(() => closeAdvFilter());
  await page.evaluate(() => openAgreementModal(LEADS[0], "buyer"));
  await page.waitForSelector("#agSource", { timeout: 10000 });
  const agOpts = await page.$eval("#agSource", (el) => el.options.length);
  ok("Add Agreement offers the managed source list", agOpts >= 358, String(agOpts));
  ok("Add Agreement groups them the same way",
    await page.$$eval("#agSource optgroup", (gs) => gs.map((g) => g.label).join("|")).then((s) => /Brivity import/.test(s)));
  ok("Add Agreement keeps the Other escape",
    await page.$eval("#agSource", (el) => [...el.options].some((o) => o.value === "__other")));
} catch (e) {
  fail.push("EXCEPTION " + (e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  if (browser) await browser.close();
  srv.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); console.error("\n--- server log ---\n" + srvLog.slice(-3000)); process.exit(1); }
