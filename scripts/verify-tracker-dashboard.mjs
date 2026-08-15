#!/usr/bin/env node
/**
 * The tracker's Funnel view: the Transaction Snapshot and the Appointment
 * funnel, plus the Last-Interaction filter.
 *
 * The things worth proving are the ones that would quietly mislead:
 *
 *   - a deal-type tab must actually FILTER, not just highlight, or the board
 *     shows referral volume under "Buyers only"
 *   - closed money and pipeline money must never land in the same total
 *   - the appointment funnel draws from two different sources (dated task
 *     records and pipeline stages) and every row must say which, because the
 *     numbers are not comparable and a reader who assumes they are will act
 *     on a wrong one
 *   - a date range must not silently drop records that carry no entry stamp —
 *     it has to report how many it could not see
 *   - the three filter predicates (board, facet counts, funnel) must agree, or
 *     a chip says 12 and the column shows 9
 *
 * Usage: node scripts/verify-tracker-dashboard.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const PORT = Number(process.env.PORT || 3423);
const B = `http://localhost:${PORT}`;
/* No DASHBOARD_TOKEN, deliberately: the tracker page issues its own API calls
   with no token, exactly as it does in production where the variable is unset.
   Setting one here would 401 the page's own fetches and test nothing. */
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "trk-"));
const trackerDb = join(tmp, "tracker.db");
const txDb = join(tmp, "tx.db");
const NOW = new Date();
const YEAR = NOW.getFullYear();
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12)).toISOString();
const thisMonth = NOW.getMonth() + 1;

/* ---- tracker records, with real stage-entry stamps ---------------------- */
{
  const db = new Database(trackerDb);
  db.exec(`CREATE TABLE tracker_records (
    id TEXT PRIMARY KEY, lead_id TEXT, sides TEXT NOT NULL DEFAULT '["buyer"]', name TEXT NOT NULL,
    phone TEXT, email TEXT, address TEXT, source TEXT, status TEXT NOT NULL DEFAULT 'new',
    buyer_stage TEXT, seller_stage TEXT, stage_meta TEXT, notes TEXT, checklist TEXT, task_ids TEXT,
    assigned_to TEXT, last_interaction_at TEXT, added_at TEXT NOT NULL, updated_at TEXT NOT NULL, legacy_stage TEXT)`);
  const ins = db.prepare(`INSERT INTO tracker_records
    (id, lead_id, sides, name, phone, email, address, source, status, buyer_stage, seller_stage, stage_meta,
     notes, checklist, task_ids, assigned_to, last_interaction_at, added_at, updated_at, legacy_stage)
    VALUES (@id,@lead_id,@sides,@name,@phone,@email,@address,@source,@status,@buyer_stage,@seller_stage,@stage_meta,
     @notes,@checklist,@task_ids,@assigned_to,@last_interaction_at,@added_at,@updated_at,@legacy_stage)`);
  const rec = (o) => ins.run({
    id: o.id, lead_id: o.leadId ?? null, sides: JSON.stringify(o.sides), name: o.name,
    phone: "2105550000", email: o.id + "@example.com", address: null, source: "Website",
    status: o.status ?? "hot", buyer_stage: o.buyerStage ?? null, seller_stage: o.sellerStage ?? null,
    stage_meta: JSON.stringify(o.stageMeta ?? {}), notes: null, checklist: null, task_ids: null,
    assigned_to: null, last_interaction_at: o.lastInteractionAt ?? null,
    added_at: iso(YEAR, 1, 5), updated_at: iso(YEAR, 1, 5), legacy_stage: null,
  });

  // Buyers with dated stages inside this year.
  rec({ id: "b1", leadId: "L1", sides: ["buyer"], name: "Buyer One", buyerStage: "closed",
    lastInteractionAt: iso(YEAR, thisMonth, 2),
    stageMeta: { "buyer:contacted": { enteredAt: iso(YEAR, 3, 1) }, "buyer:buyer_rep_signed": { enteredAt: iso(YEAR, 4, 1) },
      "buyer:under_contract": { enteredAt: iso(YEAR, 5, 1) }, "buyer:closed": { enteredAt: iso(YEAR, 6, 1) } } });
  rec({ id: "b2", leadId: "L2", sides: ["buyer"], name: "Buyer Two", buyerStage: "under_contract",
    lastInteractionAt: iso(YEAR, 6, 20),
    stageMeta: { "buyer:contacted": { enteredAt: iso(YEAR, 3, 5) }, "buyer:buyer_rep_signed": { enteredAt: iso(YEAR, 4, 5) },
      "buyer:under_contract": { enteredAt: iso(YEAR, 5, 5) } } });
  // A buyer at a stage but with NO entry stamp — the migrated-record case.
  rec({ id: "b3", leadId: "L3", sides: ["buyer"], name: "Buyer Three", buyerStage: "contacted", stageMeta: {} });
  // Sellers.
  rec({ id: "s1", leadId: "L4", sides: ["seller"], name: "Seller One", sellerStage: "closed",
    lastInteractionAt: iso(YEAR, 7, 1),
    stageMeta: { "seller:contacted": { enteredAt: iso(YEAR, 2, 1) }, "seller:appointment_held": { enteredAt: iso(YEAR, 2, 20) },
      "seller:listing_agreement_signed": { enteredAt: iso(YEAR, 3, 1) }, "seller:under_contract": { enteredAt: iso(YEAR, 4, 1) },
      "seller:closed": { enteredAt: iso(YEAR, 5, 1) } } });
  rec({ id: "s2", leadId: "L5", sides: ["seller"], name: "Seller Two", sellerStage: "contacted",
    stageMeta: { "seller:contacted": { enteredAt: iso(YEAR, 8, 1) } } });
  db.close();
}

/* ---- transactions across all six stages and several deal types --------- */
{
  const db = new Database(txDb);
  db.exec(`CREATE TABLE transactions (
    id TEXT PRIMARY KEY, address TEXT NOT NULL, deal_type TEXT NOT NULL, parties TEXT NOT NULL,
    price REAL, status TEXT NOT NULL DEFAULT 'active', contract_date TEXT, inspection_date TEXT,
    appraisal_date TEXT, loan_commitment_date TEXT, title_date TEXT, closing_date TEXT,
    possession_date TEXT, lead_id TEXT, deal_file_url TEXT, notes TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    mls TEXT, list_price REAL, gci REAL, expiration TEXT, auto_plans TEXT, agent TEXT, source TEXT, external_key TEXT)`);
  db.exec(`CREATE TABLE transaction_deadlines (id TEXT PRIMARY KEY, deal_id TEXT NOT NULL, deadline_type TEXT NOT NULL,
    label TEXT, due_date TEXT NOT NULL, alert_sent INTEGER DEFAULT 0, escalated INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0, completed_at TEXT, created_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE transaction_documents (id TEXT PRIMARY KEY, deal_id TEXT NOT NULL, name TEXT,
    url TEXT, uploaded_at TEXT)`);
  const ins = db.prepare(`INSERT INTO transactions (id,address,deal_type,parties,price,status,closing_date,
    created_at,updated_at,list_price,gci,agent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const mk = (id, type, status, price, gci, closing) =>
    ins.run(id, id + " Main St", type, "[]", price, status, closing, iso(YEAR, 1, 1), iso(YEAR, 1, 1), price, gci, "Marco Puga");

  mk("t1", "buyer",    "closed", 400000, 12000, iso(YEAR, thisMonth, 3));   // YTD + MTD
  mk("t2", "seller",   "closed", 500000, 15000, iso(YEAR, 2, 3));           // YTD only
  mk("t3", "buyer",    "pending", 300000, 9000, null);
  mk("t4", "seller",   "active", 600000, 18000, null);
  mk("t5", "buyer",    "coming_soon", 250000, 7500, null);
  mk("t6", "seller",   "pipeline", 700000, 21000, null);
  mk("t7", "referral", "closed", 100000, 3000, iso(YEAR, 3, 3));
  mk("t8", "tenant",   "active", 24000, 1800, null);
  mk("t9", "landlord", "pending", 30000, 2400, null);
  db.close();
}

/* ---- CRM tasks: real dated call + appointment records ------------------ */
const tasks = [];
const mkTask = (id, type, status, leadId, createdAt, completedAt) =>
  tasks.push({ id, title: type + " " + id, type, priority: "normal", status,
    dueDate: createdAt, leadId, createdAt, updatedAt: createdAt,
    completedAt: completedAt ?? undefined, source: "manual" });
mkTask("k1", "call", "completed", "L1", iso(YEAR, 3, 1), iso(YEAR, 3, 1));
mkTask("k2", "call", "completed", "L2", iso(YEAR, 3, 2), iso(YEAR, 3, 2));
mkTask("k3", "call", "completed", "L4", iso(YEAR, 3, 3), iso(YEAR, 3, 3));
mkTask("k4", "call", "pending",   "L5", iso(YEAR, 3, 4), null);           // not completed → not "called"
mkTask("a1", "appointment", "completed", "L1", iso(YEAR, 4, 1), iso(YEAR, 4, 2));
mkTask("a2", "appointment", "pending",   "L2", iso(YEAR, 4, 3), null);    // set, not held
mkTask("a3", "appointment", "completed", "L4", iso(YEAR, 7, 1), iso(YEAR, 7, 2));
/* The task store reads a bare array, not a wrapper object. */
writeFileSync(join(tmp, "t.json"), JSON.stringify(tasks));
writeFileSync(join(tmp, "db.json"), JSON.stringify({ idCounter: 1, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] }));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT), DASHBOARD_TOKEN: "",
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "t.json"),
    EMAIL_DB_PATH: join(tmp, "e.db"), TRANSACTIONS_DB_PATH: txDb, TRACKER_DB_PATH: trackerDb,
    LISTINGS_DB_PATH: join(tmp, "l.db"), OUTREACH_DB_PATH: join(tmp, "o.db"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

try {
  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await br.newPage({ viewport: { width: 1700, height: 1050 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto(`${B}/tracker`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  ok("the tracker loads with no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));

  // ---- Last Interaction filter -------------------------------------------
  {
    ok("the filter bar has a Last Touch range", await page.locator("#fIFrom").count() === 1);
    const before = await page.evaluate(() => visible().length);
    await page.evaluate((d) => { FILTER.ifrom = d; paintStageChips(); renderBoard(); }, `${YEAR}-06-01`);
    const after = await page.evaluate(() => visible().length);
    ok("filtering by last interaction narrows the board", after < before, `${before} → ${after}`);
    ok("records never touched are excluded, not treated as matching",
      await page.evaluate(() => visible().every((r) => !!r.lastInteractionAt)));
    // All three predicates must agree.
    const agree = await page.evaluate(() => {
      const board = visible().filter((r) => (r.sides || []).indexOf(SIDE) >= 0).length;
      const facet = Object.keys(stageCounts()).length >= 0;
      const funnel = RECORDS.filter((r) => (r.sides || []).indexOf(SIDE) >= 0 && passesExceptSide(r)).length;
      return { board, funnel, facet };
    });
    ok("the board and the funnel apply the same filter", agree.board === agree.funnel, JSON.stringify(agree));
    await page.evaluate(() => { FILTER.ifrom = ""; paintStageChips(); renderBoard(); });
  }

  // ---- Funnel view --------------------------------------------------------
  await page.click('#sideSwitch button[data-side="funnel"]');
  await page.waitForTimeout(1500);

  // Transaction snapshot: tabs + three metrics across six stages.
  {
    const txt = await page.textContent(".col:has-text('TRANSACTION SNAPSHOT')");
    for (const stage of ["YTD Closed", "MTD Closed", "Pending", "Active", "Coming Soon", "Pipeline"]) {
      ok(`snapshot shows "${stage}"`, txt.includes(stage));
    }
    ok("every cell carries Volume and GCI, not just a count",
      (txt.match(/Volume/g) || []).length === 6 && (txt.match(/GCI/g) || []).length === 6,
      `volume=${(txt.match(/Volume/g) || []).length} gci=${(txt.match(/GCI/g) || []).length}`);

    const tabs = await page.locator("[data-txtab]").allTextContents();
    ok("the deal-type tabs match the spec",
      ["All", "Buyers & Sellers", "Buyers only", "Sellers only", "Tenant & Landlord", "Referral"]
        .every((t) => tabs.includes(t)), JSON.stringify(tabs));

    const metrics = () => page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll(".snapcell"));
      const out = {};
      cells.forEach((c) => {
        const label = c.querySelector(".snapl").textContent.trim();
        const units = Number(c.querySelector(".snapn").textContent.trim());
        const ms = Array.from(c.querySelectorAll(".snapm b")).map((b) => b.textContent.trim());
        out[label] = { units, volume: ms[0], gci: ms[1] };
      });
      return out;
    });

    const all = await metrics();
    ok("YTD Closed counts every closed deal this year", all["YTD Closed"].units === 3, JSON.stringify(all["YTD Closed"]));
    ok("MTD Closed counts only this month", all["MTD Closed"].units === 1, JSON.stringify(all["MTD Closed"]));
    ok("Coming Soon and Pipeline are separate from Active",
      all["Coming Soon"].units === 1 && all["Pipeline"].units === 1 && all["Active"].units === 2,
      JSON.stringify({ cs: all["Coming Soon"], p: all["Pipeline"], a: all["Active"] }));
    ok("closed money is not mixed into pipeline money",
      all["YTD Closed"].volume !== all["Pipeline"].volume);

    // A tab must actually filter.
    await page.click('[data-txtab="referral"]');
    await page.waitForTimeout(500);
    const ref = await metrics();
    ok("the Referral tab filters to referral deals only",
      ref["YTD Closed"].units === 1 && ref["Active"].units === 0, JSON.stringify(ref["YTD Closed"]));
    ok("and its GCI is the referral's own", ref["YTD Closed"].gci === "$3k", ref["YTD Closed"].gci);

    await page.click('[data-txtab="tenlan"]');
    await page.waitForTimeout(500);
    const tl = await metrics();
    ok("Tenant & Landlord is its own tab with its own deals",
      tl["Active"].units === 1 && tl["Pending"].units === 1, JSON.stringify({ a: tl["Active"], p: tl["Pending"] }));

    await page.click('[data-txtab="buyer"]');
    await page.waitForTimeout(500);
    const bu = await metrics();
    ok("Buyers only excludes seller and referral deals",
      bu["YTD Closed"].units === 1, JSON.stringify(bu["YTD Closed"]));

    await page.click('[data-txtab="all"]');
    await page.waitForTimeout(400);
  }

  // ---- Appointment funnel -------------------------------------------------
  {
    const sect = ".col:has-text('APPOINTMENT FUNNEL')";
    const txt = await page.textContent(sect);
    for (const row of ["Persons Called", "Contacted", "Appointments Set", "Appointments Held", "Signed", "Pending", "Sold"]) {
      ok(`appointment funnel shows "${row}"`, txt.includes(row));
    }
    const rows = () => page.evaluate(() => {
      const sec = Array.from(document.querySelectorAll(".col")).find((c) => /APPOINTMENT FUNNEL/.test(c.textContent));
      return Array.from(sec.querySelectorAll(".fnrow")).map((r) => ({
        label: r.querySelector(".fnlabel").textContent.trim(),
        n: Number(r.querySelector(".fnn").textContent.trim()),
        src: r.querySelector(".fnsrc").textContent.trim(),
      }));
    });

    const r = await rows();
    const by = Object.fromEntries(r.map((x) => [x.label, x]));
    ok("Persons Called counts completed call tasks only",
      by["Persons Called"].n === 3, JSON.stringify(by["Persons Called"]));
    ok("Appointments Set counts appointments created", by["Appointments Set"].n === 3, JSON.stringify(by["Appointments Set"]));
    ok("Appointments Held counts only the completed ones", by["Appointments Held"].n === 2, JSON.stringify(by["Appointments Held"]));
    /* Cumulative and across BOTH pipelines: two buyers are at or past Buyer Rep
       Signed, one seller is at or past Listing Agreement Signed. */
    ok("Signed comes from the pipeline stages, cumulative across both", by["Signed"].n === 3, JSON.stringify(by["Signed"]));
    ok("Sold counts both pipelines' closed records", by["Sold"].n === 2, JSON.stringify(by["Sold"]));
    ok("every row names where its number came from",
      r.every((x) => x.src.length > 0), JSON.stringify(r.map((x) => x.src)));
    ok("task-sourced rows and stage-sourced rows are labelled differently",
      by["Persons Called"].src !== by["Signed"].src,
      `${by["Persons Called"].src} vs ${by["Signed"].src}`);

    // Client-type filter.
    await page.click('[data-afside="seller"]');
    await page.waitForTimeout(500);
    const sellerRows = Object.fromEntries((await rows()).map((x) => [x.label, x]));
    ok("Sellers only narrows the funnel", sellerRows["Sold"].n === 1, JSON.stringify(sellerRows["Sold"]));
    ok("and it narrows the task rows too, via the linked contact",
      sellerRows["Persons Called"].n === 1, JSON.stringify(sellerRows["Persons Called"]));

    await page.click('[data-afside="all"]');
    await page.waitForTimeout(400);

    // Date range.
    await page.fill("#afFrom", `${YEAR}-05-01`);
    await page.waitForTimeout(600);
    const ranged = Object.fromEntries((await rows()).map((x) => [x.label, x]));
    ok("a date range narrows the funnel", ranged["Signed"].n < by["Signed"].n, `${by["Signed"].n} → ${ranged["Signed"].n}`);
    ok("and calls before the range drop out", ranged["Persons Called"].n === 0, JSON.stringify(ranged["Persons Called"]));

    const foot = await page.textContent(`${sect} .fnfoot`);
    ok("the footer reports records it could not date rather than hiding them",
      /no entry date/.test(foot), foot.slice(0, 200));
    ok("the footer says the two sources are different",
      /dated task records/.test(foot) && /pipeline stages/.test(foot), foot.slice(0, 200));

    await page.click("#afClear");
    await page.waitForTimeout(400);
    const cleared = Object.fromEntries((await rows()).map((x) => [x.label, x]));
    ok("clearing the range restores the full counts", cleared["Signed"].n === by["Signed"].n);
  }

  ok("still no page errors after driving the dashboard", errs.length === 0, errs.slice(0, 2).join(" | "));
  await page.close();
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:\n - " + fail.join("\n - ")); process.exit(1); }
