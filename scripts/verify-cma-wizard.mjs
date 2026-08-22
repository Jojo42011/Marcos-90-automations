#!/usr/bin/env node
/**
 * CMA Creation Wizard verification — the five specs of Aug 2026 covering
 * steps 1 (Start) through 5 (Off Market), plus the Results and Publish steps
 * the wizard needs to produce anything.
 *
 * The point of most of these checks is not that a field exists. It is that the
 * wizard tells the truth about a data set that does not match the spec's
 * assumptions: no coordinates anywhere, no sold listings on the feed, and no
 * off-market listings at all. A build that quietly returned zero rows, or an
 * empty map, or a "0 sold comps" would pass a naive test and mislead an agent
 * pricing somebody's house.
 *
 * Usage: node scripts/verify-cma-wizard.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const PORT = Number(process.env.PORT || 3409);
const B = `http://localhost:${PORT}`;

let pass = 0; const fail = [];
const ok = (n, c, detail) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (detail ? " — " + detail : "")); console.error("FAIL " + n + (detail ? " — " + detail : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "cma-"));

/* ── an MLS mirror shaped like the real one ───────────────────────────────
   Active and Pending only, and geo.lat null on every row — which is what the
   live board actually publishes. The wizard's honesty depends on that being
   true in the fixture too, or the tests would prove nothing. */
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
      interiorFeatures: "Open Floor Plan", exteriorFeatures: "Covered Patio", garageSpaces: null },
    geo: { lat: null, lng: null, county: "Bexar" }, school: { district: "Northside" },
    mls: { status: "Active", daysOnMarket: 21 },
  });
  /* 20 active in 78245, plus 6 pending, plus 4 in a different ZIP so the place
     ladder has something to widen into. */
  for (let i = 0; i < 20; i++) {
    ins.run(`A${i}`, `MA${i}`, "Active", 280000 + i * 12000, null, `${1400 + i} Kedros`, "San Antonio", "TX", "78245",
      3, 2, 1900 + i * 40, 0.22, 2012, "RES", "Kedros Ridge", "Agent", "Office",
      "https://example.test/a.jpg", "Lovely.", `2026-08-${String(10 + (i % 9)).padStart(2, "0")}T00:00:00Z`,
      "2026-07-20T00:00:00Z", null, raw, "2026-08-20T00:00:00Z");
  }
  for (let i = 0; i < 6; i++) {
    ins.run(`P${i}`, `MP${i}`, "Pending", 305000 + i * 9000, null, `${6100 + i} Smiley Blvd`, "San Antonio", "TX", "78245",
      4, 2.5, 2100 + i * 30, 0.2, 2015, "RES", "Smiley", "Agent", "Office",
      "https://example.test/p.jpg", "Under contract.", `2026-08-1${i}T00:00:00Z`,
      "2026-07-01T00:00:00Z", null, raw, "2026-08-20T00:00:00Z");
  }
  /* Deliberately photo-less. `buildCriteriaSql` excludes those by default,
     which is right for a client email and wrong for a comp search — so these
     rows are the fixture for that. */
  for (let i = 0; i < 4; i++) {
    ins.run(`O${i}`, `MO${i}`, "Active", 410000 + i * 20000, null, `${900 + i} Far Away`, "San Antonio", "TX", "78258",
      4, 3, 2600, 0.3, 2019, "RES", "Elsewhere", "Agent", "Office", null, "Nice.",
      "2026-08-05T00:00:00Z", "2026-06-01T00:00:00Z", null, raw, "2026-08-20T00:00:00Z");
  }
  /* One inside the subject's own ZIP with no photo, so the active feed itself
     has to include it. */
  ins.run("A-NOPIC", "MANP", "Active", 349000, null, "1499 Kedros", "San Antonio", "TX", "78245",
    3, 2, 1950, 0.22, 2011, "RES", "Kedros Ridge", "Agent", "Office", null, "No photos yet.",
    "2026-08-19T00:00:00Z", "2026-07-20T00:00:00Z", null, raw, "2026-08-20T00:00:00Z");
  db.close();
}

const mkLead = (n, over) => ({
  id: "lead_" + n, platform: "tiktok", userId: "u" + n, username: "user" + n,
  name: over.name, phone: over.phone ?? null, email: over.email ?? null, address: over.address ?? null,
  state: "new", source: "TikTok", adCampaign: null, propertyInquired: null, criteria: null, brivityId: null,
  crmStatus: "new", crmStage: "new", crmPriority: "normal", crmIntent: "seller", crmCallQueue: "none", crmNotes: null,
  tags: [], createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
  assignedUserId: "marco", assignedUserName: "Marco", activity: [],
});
const leads = [
  mkLead(1, { name: "Seller One", email: "s1@example.com", phone: "2105550101", address: "1450 Kedros, San Antonio, TX 78245" }),
  mkLead(2, { name: "Seller Two", email: "s2@example.com", phone: "2105550102" }),
  mkLead(3, { name: "Seller Three", email: "s3@example.com", phone: "2105550103" }),
  mkLead(4, { name: "Seller Four", email: "s4@example.com", phone: "2105550104" }),
];
const jdb = { idCounter: 10, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] };
for (const l of leads) { jdb.leadsById[l.id] = l; jdb.leadKeyToId[l.platform + "::" + l.userId] = l.id; jdb.conversationsByLeadId[l.id] = { messages: [] }; }
writeFileSync(join(tmp, "db.json"), JSON.stringify(jdb));

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
  SMS_DB_PATH: join(tmp, "sms.db"), LISTINGS_DB_PATH: listingsDb, CMA_DB_PATH: join(tmp, "cma.db"),
};
const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
let srvLog = ""; srv.stdout.on("data", (d) => (srvLog += d)); srv.stderr.on("data", (d) => (srvLog += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);
const J = (r) => r.json();
const post = (u, b) => fetch(B + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const patch = (u, b) => fetch(B + u, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

let browser;
try {
  /* Three closed deals with real list-and-sold pairs — the only sold source. */
  for (const t of [
    { address: "1510 Snowy Owl Dr, San Antonio, TX 78245", listPrice: 445000, price: 435000, closingDate: "2026-08-01", status: "closed", dealType: "seller", mls: "MS1" },
    { address: "9905 Paladin Ridge, San Antonio, TX 78245", listPrice: 384990, price: 374990, closingDate: "2026-07-15", status: "closed", dealType: "seller", mls: "MS2" },
    { address: "13611 Patronus Way, San Antonio, TX 78245", listPrice: 419900, price: 380000, closingDate: "2024-01-10", status: "closed", dealType: "buyer", mls: "MS3" },
    { address: "77 Still Active Ln, San Antonio, TX 78245", listPrice: 300000, price: 300000, closingDate: "2026-08-01", status: "active", dealType: "seller" },
  ]) {
    const r = await post("/api/transactions", t);
    if (!r.ok) throw new Error("seed transaction failed: " + (await r.text()));
  }

  /* ═══════════ spec 1: step 1, Start ═══════════ */

  let meta = await J(await fetch(B + "/api/cma/meta"));
  ok("meta answers", meta.ok === true);
  ok("the MLS select names the real board", /SABOR/.test(meta.mlsOptions[0].label), meta.mlsOptions[0].label);
  /* The spec's ladders, exactly. A typed 3.5 bathrooms matches nothing, which
     is why these are option lists rather than free text. */
  ok("price ladder starts at $50,000 and runs to $700,000",
    meta.ladders.price[0] === 50000 && meta.ladders.price[meta.ladders.price.length - 1] === 700000,
    JSON.stringify([meta.ladders.price[0], meta.ladders.price.at(-1)]));
  ok("price ladder steps in $25,000", meta.ladders.price[1] - meta.ladders.price[0] === 25000);
  ok("beds run 1 to 10", meta.ladders.beds[0] === 1 && meta.ladders.beds.at(-1) === 10);
  ok("baths carry the half steps the spec lists", meta.ladders.baths.includes(1.5) && meta.ladders.baths.includes(2.5) && meta.ladders.baths.at(-1) === 10);
  ok("sqft runs 500 to 9500 in 500s",
    meta.ladders.sqft[0] === 500 && meta.ladders.sqft.at(-1) === 9500 && meta.ladders.sqft[1] === 1000);
  /* The spec's lot ladder mixes sqft with acres. The feed publishes acres, so
     a raw 2000 compared against an acres column would match every lot. */
  const lot2000 = meta.ladders.lotSize.find((l) => /2,000 sqft/.test(l.label));
  ok("the square-foot lot rungs are converted to the acres the feed publishes",
    lot2000 && lot2000.value > 0.045 && lot2000.value < 0.047, JSON.stringify(lot2000));
  ok("the acreage rungs go to 25 acres", meta.ladders.lotSize.at(-1).value === 25);
  ok("year built offers Any plus the look-back windows",
    meta.ladders.yearBuilt[0].value === null && meta.ladders.yearBuilt.some((y) => y.value === 100));
  ok("sold/off-market date offers Any plus the six windows",
    meta.ladders.statusDate[0].value === null && meta.ladders.statusDate.length === 7, String(meta.ladders.statusDate.length));

  /* The four things the spec asks for that this data cannot answer. Each is
     named with its reason rather than dropped from the form. */
  const un = meta.unavailable.map((u) => u.field + " :: " + u.reason).join(" | ");
  ok("search radius is refused with the coordinate reason", /Search radius/.test(un) && /no latitude or longitude/i.test(un));
  ok("it names the place ladder as what replaces it", /postal code, then city, then county/i.test(un));
  ok("the map, pins and redo-search are refused together", /Map view, price pins/.test(un));
  ok("Street View is refused for the missing key, not silently omitted", /Street View/.test(un) && /no Google Maps Platform key/i.test(un.toLowerCase().replace(/no google maps platform key/i, "no Google Maps Platform key")));
  ok("address autocomplete is refused too", /autocomplete/i.test(un));
  ok("and the feed's own gaps ride along", /Sold comparables/.test(un));
  /* Distance is a sort option in the spec and cannot be computed here. */
  ok("distance sort is offered and refused", meta.unavailableSort.value === "distance" && /no latitude or longitude/i.test(meta.unavailableSort.reason));
  ok("the sorts that ARE offered do not include distance", !meta.sorts.some((s) => s.value === "distance"));

  /* Creating a session. */
  let r = await post("/api/cma/sessions", { clientName: "", subjectAddress: "1450 Kedros, San Antonio, TX 78245" });
  ok("a CMA with no client name is refused — it is prepared FOR someone", r.status === 400, String(r.status));
  r = await post("/api/cma/sessions", { clientName: "test", subjectAddress: "Nowhere At All" });
  ok("an address with no city or ZIP the board covers is refused", r.status === 400, String(r.status));
  ok("and the refusal says why, naming the missing geocoder",
    /no geocoder/i.test((await J(r)).error || ""), "");

  r = await post("/api/cma/sessions", {
    clientName: "Seller One", leadId: "lead_1",
    subjectAddress: "1450 Kedros, San Antonio, TX 78245",
    subjectPropertyType: "RES", subjectBeds: 3, subjectBaths: 2, subjectSqft: 2000, subjectLotSize: 0.22,
    criteria: { minBeds: 2, maxBeds: 5, statusDateDays: 730 },
  });
  ok("a complete Start step creates the CMA", r.ok, String(r.status));
  const created = await J(r);
  const SID = created.session.id;
  ok("the city is read out of the typed address without a geocoder", created.session.subjectCity === "San Antonio", String(created.session.subjectCity));
  ok("so is the postal code", created.session.subjectPostalCode === "78245", String(created.session.subjectPostalCode));
  ok("the wizard opens on step 2, not step 1", created.session.currentStep === 2, String(created.session.currentStep));
  /* The place ladder is the honest answer to "search radius". */
  ok("an area rung is resolved at create time", !!created.session.areaRung, String(created.session.areaRung));
  ok("it settled on the tightest rung that clears the comp floor", created.session.areaRung === "postal" && created.session.areaLabel === "78245",
    JSON.stringify([created.session.areaRung, created.session.areaLabel]));
  ok("and the whole ladder comes back so the widening is visible",
    created.area.ladder.length >= 3 && created.area.ladder.every((l) => typeof l.count === "number"),
    JSON.stringify(created.area.ladder));
  /* The ladder picks its rung by counting, so a photo filter there would widen
     the area past a postal code that has enough comparables in it. */
  const rungCount = (r) => created.area.ladder.find((l) => l.rung === r).count;
  ok("the ladder counts photo-less listings too, so the rung is chosen honestly",
    rungCount("postal") === 21 && rungCount("city") === 25,
    JSON.stringify(created.area.ladder.map((l) => l.rung + ":" + l.count)));

  /* ═══════════ spec 2: step 2, Active ═══════════ */

  let feed = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=ACTIVE`));
  ok("the active feed is the live mirror", feed.source === "mls" && feed.total === 21, JSON.stringify([feed.source, feed.total]));
  /* The comp search must NOT inherit the alert builder's "skip listings with
     no photo" default: a photo-less comparable is still a comparable, and
     dropping it silently narrows the set the valuation rests on. */
  ok("a listing with no photo is still a comparable", feed.rows.some((x) => /1499 Kedros/.test(x.address)));
  ok("it is scoped to the resolved area, not the whole board", feed.rows.every((x) => x.postalCode === "78245"));
  ok("rows carry the spec's card fields", feed.rows[0].address && feed.rows[0].price && feed.rows[0].beds != null && feed.rows[0].sqft != null);
  ok("the source note says where these came from", /SABOR MLS mirror/i.test(feed.sourceNote), feed.sourceNote);

  /* The tray: five slots, first open slot wins, duplicates and overflow refused. */
  const addActive = (i) => post(`/api/cma/sessions/${SID}/comparables`, {
    listingStatus: "ACTIVE", source: "mls", sourceKey: feed.rows[i].key, address: feed.rows[i].address,
    price: feed.rows[i].price, beds: feed.rows[i].beds, baths: feed.rows[i].baths, sqft: feed.rows[i].sqft,
    photoUrl: feed.rows[i].photoUrl, listDate: feed.rows[i].listDate, statusDate: feed.rows[i].statusDate,
  });
  let c1 = await J(await addActive(0));
  ok("selecting lands in slot 1", c1.comparable.traySlotIndex === 1, String(c1.comparable.traySlotIndex));
  let c2 = await J(await addActive(1));
  ok("the next selection lands in slot 2", c2.comparable.traySlotIndex === 2);
  r = await addActive(0);
  ok("the same property cannot be selected twice into one step", r.status === 409, String(r.status));
  ok("and the refusal is a sentence, not a stack trace", /already selected/i.test((await J(r)).error || ""));
  for (const i of [2, 3, 4]) await addActive(i);
  r = await addActive(5);
  ok("a sixth selection is refused — the tray is five slots", r.status === 409, String(r.status));
  ok("and it says to remove one first", /Remove one/i.test((await J(r)).error || ""));

  /* Deselect frees the slot it held, not the last one. */
  let sess = await J(await fetch(B + `/api/cma/sessions/${SID}`));
  const slot2 = sess.trays.ACTIVE.find((c) => c.traySlotIndex === 2);
  await fetch(B + `/api/cma/comparables/${slot2.id}`, { method: "DELETE" });
  let re = await J(await addActive(5));
  ok("the freed slot is reused rather than appended", re.comparable.traySlotIndex === 2, String(re.comparable.traySlotIndex));

  feed = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=ACTIVE`));
  ok("the feed marks what is already in the tray", feed.rows.filter((x) => x.selected).length === 5,
    String(feed.rows.filter((x) => x.selected).length));

  /* Sorting is real, not decorative. */
  const asc = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=ACTIVE&sort=price_asc`));
  const desc = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=ACTIVE&sort=price_desc`));
  ok("price sorts actually reorder the feed", asc.rows[0].price < asc.rows[1].price && desc.rows[0].price > desc.rows[1].price,
    JSON.stringify([asc.rows[0].price, desc.rows[0].price]));
  const pg = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=ACTIVE&limit=5&offset=5`));
  ok("paging works so the whole feed is reachable", pg.rows.length === 5 && pg.total === 21, String(pg.total));

  /* ═══════════ spec 3: step 3, Pending ═══════════ */

  feed = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=PENDING`));
  ok("the pending feed is the live mirror too", feed.source === "mls" && feed.total === 6, JSON.stringify([feed.source, feed.total]));
  ok("pendings are pendings, not actives leaking through", feed.rows.every((x) => /Smiley/.test(x.address)));
  /* The feed has no pending-date field. Claiming a contract date it does not
     publish would be a fabrication on a document about market velocity. */
  ok("the pending date is named as the board's last update, not a contract date",
    /no dedicated pending date/i.test(feed.sourceNote), feed.sourceNote);
  ok("and a status date is still supplied for the card", !!feed.rows[0].statusDate);
  await post(`/api/cma/sessions/${SID}/comparables`, {
    listingStatus: "PENDING", source: "mls", sourceKey: feed.rows[0].key, address: feed.rows[0].address,
    price: feed.rows[0].price, beds: feed.rows[0].beds, baths: feed.rows[0].baths, sqft: feed.rows[0].sqft,
    statusDate: feed.rows[0].statusDate,
  });
  sess = await J(await fetch(B + `/api/cma/sessions/${SID}`));
  ok("the pending tray is separate from the active one — five slots each",
    sess.trays.PENDING.length === 1 && sess.trays.PENDING[0].traySlotIndex === 1 && sess.trays.ACTIVE.length === 5,
    JSON.stringify([sess.trays.PENDING.length, sess.trays.ACTIVE.length]));

  /* ═══════════ spec 4: step 4, Sold ═══════════ */

  feed = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=SOLD`));
  /* This is the load-bearing one. The board publishes no solds at all, so if
     this step silently returned nothing an agent would read "no comparable
     sales nearby" — a market claim — instead of "this feed has none". */
  ok("the sold feed does NOT come from the MLS", feed.source === "transaction", feed.source);
  ok("it comes from real closed transactions", feed.total === 3, String(feed.total));
  ok("the still-open deal is not offered as a sold comp", !feed.rows.some((x) => /Still Active/.test(x.address)));
  ok("the note says the feed has no solds at all", /publishes Active and Pending only/i.test(feed.sourceNote), feed.sourceNote);
  ok("and that this is Marco's book rather than the board", /his book, not the whole board/i.test(feed.sourceNote));
  /* Step 4's dual price is the whole point of the step. */
  const sold0 = feed.rows.find((x) => /Snowy Owl/.test(x.address));
  ok("a sold row carries BOTH the list price and the sold price",
    sold0.originalListPrice === 445000 && sold0.soldPrice === 435000, JSON.stringify(sold0));
  ok("a transaction-sourced sold has no beds/baths/sqft — and says null, not zero",
    sold0.beds === null && sold0.sqft === null, JSON.stringify([sold0.beds, sold0.sqft]));

  /* The step-1 Sold/Off Market date window is honoured. */
  const win = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=SOLD&days=90`));
  ok("a 90-day window drops the 2024 closing", win.total === 2, String(win.total));
  const wide = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=SOLD&days=3650`));
  ok("a wide window keeps it", wide.total === 3, String(wide.total));

  const cs = await J(await post(`/api/cma/sessions/${SID}/comparables`, {
    listingStatus: "SOLD", source: "transaction", sourceKey: sold0.key, address: sold0.address,
    price: sold0.soldPrice, originalListPrice: sold0.originalListPrice, soldPrice: sold0.soldPrice,
    statusDate: sold0.statusDate,
  }));
  ok("a sold comp selects into its own tray", cs.comparable.listingStatus === "SOLD" && cs.comparable.traySlotIndex === 1);
  /* Editing is how a transaction-sourced row gets the size the estimate needs. */
  const ed = await J(await patch(`/api/cma/comparables/${cs.comparable.id}`, { sqft: 2320, beds: 4, baths: 2.5 }));
  ok("editing fills in what the transaction record could not supply",
    ed.comparable.sqft === 2320 && ed.comparable.beds === 4, JSON.stringify([ed.comparable.sqft, ed.comparable.beds]));
  ok("and the edit does not wipe the fields it was not sent",
    ed.comparable.soldPrice === 435000 && ed.comparable.originalListPrice === 445000,
    JSON.stringify([ed.comparable.soldPrice, ed.comparable.originalListPrice]));

  /* ═══════════ spec 5: step 5, Off Market ═══════════ */

  feed = await J(await fetch(B + `/api/cma/sessions/${SID}/candidates?status=OFF_MKT`));
  ok("the off-market feed is empty because there IS no source", feed.total === 0 && feed.rows.length === 0);
  ok("and it says so rather than reading as 'none nearby'",
    /not published on this feed/i.test(feed.unavailable || ""), String(feed.unavailable));
  ok("it names manual entry as the only way in", /entered by hand/i.test(feed.unavailable || ""));
  ok("the source is marked manual, so the UI cannot badge it as MLS", feed.source === "manual");

  const om = await J(await post(`/api/cma/sessions/${SID}/comparables`, {
    listingStatus: "OFF_MKT", source: "manual", address: "14002 Bella Donna, San Antonio, TX 78245",
    price: 380000, beds: 4, baths: 2.5, sqft: 2712, offMarketType: "EXPIRED", statusDate: "2026-08-03",
  }));
  ok("a hand-typed off-market comp saves", om.comparable.address.startsWith("14002 Bella Donna"));
  ok("it is flagged as manual entry, not passed off as feed data", om.comparable.isManualEntry === true && om.comparable.source === "manual");
  ok("the off-market reason round-trips", om.comparable.offMarketType === "EXPIRED", String(om.comparable.offMarketType));
  /* Two hand-typed rows have no source key; a naive UNIQUE would collide. */
  const om2 = await J(await post(`/api/cma/sessions/${SID}/comparables`, {
    listingStatus: "OFF_MKT", source: "manual", address: "13915 Silas, San Antonio, TX 78245",
    price: 409999, beds: 4, baths: 3, sqft: 2811, offMarketType: "WITHDRAWN",
  }));
  ok("a second hand-typed row does not collide with the first", om2.comparable.traySlotIndex === 2, String(om2.comparable.traySlotIndex));

  /* ═══════════ results ═══════════ */

  let res = await J(await fetch(B + `/api/cma/sessions/${SID}/results`));
  ok("results answer", res.ok === true);
  ok("every step has its own bucket", res.results.buckets.length === 4);
  const bSold = res.results.buckets.find((b) => b.status === "SOLD");
  ok("the sold bucket reports a list-to-sale ratio from real pairs",
    bSold.listToSalePct !== null && Math.round(bSold.listToSalePct) === 98, String(bSold.listToSalePct));
  const bOff = res.results.buckets.find((b) => b.status === "OFF_MKT");
  ok("the off-market bucket counts the hand-typed rows", bOff.count === 2, String(bOff.count));
  ok("the estimate is price per sqft times the subject's own size", res.results.estimate > 0 && res.results.pricePerSqft > 0,
    JSON.stringify([res.results.estimate, res.results.pricePerSqft]));
  const expected = Math.round(res.results.pricePerSqft * 2000);
  ok("and the arithmetic is exactly that, not a black box",
    Math.abs(res.results.estimate - expected) <= 2000, JSON.stringify([res.results.estimate, expected]));
  ok("it comes with a band from the quartiles", res.results.estimateLow < res.results.estimate && res.results.estimateHigh > res.results.estimate);
  /* The basis must count the comps that actually carried a size, not every
     comp selected — "5 comparables at $181/sqft" when one had a size is a
     claim about evidence that does not exist. */
  ok("with every comp sized, the basis count equals the selection count",
    res.results.sizedCount === 9 && res.results.totalSelected === 9,
    JSON.stringify([res.results.sizedCount, res.results.totalSelected]));
  /* Add one with no size. The basis must then count 9, not 10 — "10
     comparables at $X/sqft" would claim evidence from a home with no size. */
  await post(`/api/cma/sessions/${SID}/comparables`, {
    listingStatus: "SOLD", source: "manual", address: "88 No Size Ln", price: 400000, soldPrice: 400000,
  });
  const res1b = await J(await fetch(B + `/api/cma/sessions/${SID}/results`));
  ok("a comp with no square footage is counted in the selection but not the basis",
    res1b.results.totalSelected === 10 && res1b.results.sizedCount === 9,
    JSON.stringify([res1b.results.totalSelected, res1b.results.sizedCount]));
  ok("and it still counts toward the price ranges",
    res1b.results.buckets.find((b) => b.status === "SOLD").count === 2);
  ok("with the shortfall named in the notes",
    res1b.results.notes.some((n) => /1 of 10 selected comparables has no square footage/.test(n)),
    JSON.stringify(res1b.results.notes));
  ok("and states that it is arithmetic, not an AVM", res.results.notes.some((n) => /not an automated valuation/i.test(n)));

  /* The two refusals that matter on a pricing document. */
  const noSqftId = (await J(await post("/api/cma/sessions", {
    clientName: "No Size", subjectAddress: "2 Kedros, San Antonio, TX 78245",
  }))).session.id;
  await post(`/api/cma/sessions/${noSqftId}/comparables`, {
    listingStatus: "ACTIVE", source: "manual", address: "9 Somewhere", price: 300000, sqft: 2000,
  });
  let res2 = await J(await fetch(B + `/api/cma/sessions/${noSqftId}/results`));
  ok("no subject square footage means NO estimate, not a guessed one", res2.results.estimate === null);
  ok("and it names the missing field", /no square footage on file/i.test(res2.results.estimateBlockedReason || ""),
    String(res2.results.estimateBlockedReason));

  const noSoldId = (await J(await post("/api/cma/sessions", {
    clientName: "No Solds", subjectAddress: "3 Kedros, San Antonio, TX 78245", subjectSqft: 2000,
  }))).session.id;
  await post(`/api/cma/sessions/${noSoldId}/comparables`, {
    listingStatus: "ACTIVE", source: "manual", address: "9 Somewhere", price: 300000, sqft: 2000,
  });
  let res3 = await J(await fetch(B + `/api/cma/sessions/${noSoldId}/results`));
  /* A CMA with no solds prices off asking prices. That is a materially weaker
     document and the agent is told, not left to notice. */
  ok("a CMA with no sold comps is called out as asking-price-only",
    res3.results.notes.some((n) => /what sellers are ASKING/.test(n)), JSON.stringify(res3.results.notes));
  /* One sized comp makes every quartile the same number. A "range" of X to X
     was not computed from anything and must not be printed as though it was. */
  ok("a single sized comparable produces no range rather than X to X",
    res3.results.estimate > 0 && res3.results.estimateLow === null && res3.results.estimateHigh === null,
    JSON.stringify([res3.results.estimate, res3.results.estimateLow, res3.results.estimateHigh]));
  ok("and it says the estimate rests on that one home",
    res3.results.notes.some((n) => /Only one comparable has a square footage/.test(n)));
  ok("the sized count reflects that", res3.results.sizedCount === 1, String(res3.results.sizedCount));

  /* ═══════════ publish ═══════════ */

  const emptyId = (await J(await post("/api/cma/sessions", {
    clientName: "Empty", subjectAddress: "4 Kedros, San Antonio, TX 78245",
  }))).session.id;
  r = await post(`/api/cma/sessions/${emptyId}/publish`, {});
  ok("a CMA with nothing selected cannot be published", r.status === 400, String(r.status));

  ok("an unpublished CMA's client page is not readable", (await fetch(B + `/c/${SID}`)).status === 404);
  const pub = await J(await post(`/api/cma/sessions/${SID}/publish`, {}));
  ok("publishing succeeds once there are comparables", pub.ok === true && pub.url === `/c/${SID}`, String(pub.url));
  /* "Published" must never quietly also mean "emailed to your seller". */
  ok("and it says plainly that nothing was emailed", /Nothing was emailed/i.test(pub.note), pub.note);
  let page = await (await fetch(B + `/c/${SID}`)).text();
  ok("the client page renders", /Comparative market analysis/i.test(page));
  ok("it shows the subject and the client it was prepared for", /1450 Kedros/.test(page) && /Seller One/.test(page));
  ok("it shows the sold comp's asked-and-sold pair", /Asked \$445,000/.test(page) && /sold \$435,000/.test(page), "");
  ok("it states it is a pricing opinion, not an appraisal", /not an appraisal/i.test(page));
  ok("and carries no CRM data", !/lead_1/.test(page));
  await post(`/api/cma/sessions/${SID}/publish`, { unpublish: true });
  ok("unpublishing takes the client page down again", (await fetch(B + `/c/${SID}`)).status === 404);
  await post(`/api/cma/sessions/${SID}/publish`, {});

  /* The CRM widget's dashboard now has a live subsystem behind it. */
  const dash = await J(await fetch(B + "/api/outreach/reports-dashboard"));
  ok("the reports dashboard reports CMAs as available now", dash.cma.available === true);
  ok("it counts them", dash.cma.created >= 4, String(dash.cma.created));
  ok("and separates the ones built on a sold comparable", dash.cma.withSoldComps === 1, String(dash.cma.withSoldComps));
  ok("it still says solds do not come from the feed", dash.cma.soldFromFeed === false && /publishes Active and Pending only/i.test(dash.cma.note));

  /* ═══════════ the page itself, in a real browser ═══════════ */

  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const page2 = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  const errs = [];
  page2.on("pageerror", (e) => errs.push(String(e)));
  await page2.goto(`${B}/cma?leadId=lead_1`, { waitUntil: "networkidle" });

  ok("the stepper shows all seven steps", (await page2.$$(".wz-step")).length === 7);
  const labels = await page2.$$eval(".wz-step span", (n) => n.map((x) => x.textContent.trim()));
  ok("named as the spec names them",
    labels.join(",") === "Start,Active,Pending,Sold,Off Mkt,Results,Publish", labels.join(","));
  ok("steps 2-7 are disabled until Start is saved",
    (await page2.$$eval(".wz-step[disabled]", (n) => n.length)) === 6,
    String(await page2.$$eval(".wz-step[disabled]", (n) => n.length)));
  ok("the Exit control is there", !!(await page2.$("#wzExit")));
  ok("so are the history arrows", !!(await page2.$("#wzPrev")) && !!(await page2.$("#wzNext")));
  ok("the title is the spec's", /Start Comparative Market Analysis/.test(await page2.textContent(".s1 h1")));

  /* The green tick the spec calls for. */
  ok("client name shows no tick before it is valid", !(await page2.$eval("#cnCtl", (e) => e.classList.contains("good"))));
  await page2.fill("#cnName", "Seller One");
  ok("and a green tick once it is", await page2.$eval("#cnCtl", (e) => e.classList.contains("good")));
  await page2.fill("#sAddr", "1450 Kedros, San Antonio, TX 78245");
  await page2.dispatchEvent("#sAddr", "input");
  ok("the address validates against cities the board covers",
    await page2.$eval("#adCtl", (e) => e.classList.contains("good")));

  /* Street View is offered and disabled, never drawn as an empty box. */
  ok("the Street View radio is present and disabled", await page2.$eval('input[disabled]', (e) => !!e));
  const imgBox = await page2.textContent("#subjImg");
  ok("the image box says why there is no Street View", /Google Maps Platform key/i.test(imgBox), imgBox.slice(0, 90));

  const s1txt = await page2.textContent(".s1");
  ok("Search Radius is replaced in place by the reason", /no mile radius on this board/i.test(s1txt));
  ok("and the reason names the ladder that replaces it", /postal code, then city, then county/i.test(s1txt));
  ok("lot size is labelled acres, the unit the feed publishes", /acres/.test(await page2.textContent(".s1")));

  /* Defaults, per the spec: Residential, 3 Beds, 2 Baths. */
  ok("property type defaults to Residential", (await page2.inputValue("#sType")) === "RES");
  ok("beds default to 3", (await page2.inputValue("#sBeds")) === "3");
  ok("baths default to 2", (await page2.inputValue("#sBaths")) === "2");
  ok("the price min/max default to No min / No max",
    (await page2.inputValue("#cMinPrice")) === "" && (await page2.inputValue("#cMaxPrice")) === "");

  await page2.fill("#sSqft", "2000");
  await page2.click("#s1Next");
  await page2.waitForSelector(".tray", { timeout: 15000 });

  ok("Next lands on step 2, Active", /Select Active Listings/.test(await page2.textContent(".sel-top h2")));
  ok("the tray has exactly five slots", (await page2.$$(".slot")).length === 5);
  ok("all five start empty and numbered", (await page2.$$(".slot.empty")).length === 5);
  const houseNums = await page2.$$eval(".slot.empty text", (n) => n.map((x) => x.textContent));
  ok("numbered 1 through 5", houseNums.join("") === "12345", houseNums.join(""));
  ok("the subject property bar carries the spec's metadata",
    /1450 Kedros/.test(await page2.textContent(".subj-bar")) && /Residential/.test(await page2.textContent(".subj-bar")));
  ok("the filter and add-custom buttons are both there", !!(await page2.$("#btnFilter")) && !!(await page2.$("#btnManual")));
  ok("the feed header shows a real count", /\d+ Active listings/.test(await page2.textContent("#feedCnt")));
  ok("the Manually Add Listing CTA is full width in the rail", !!(await page2.$("#btnManual2")));

  /* No map. The right rail explains rather than showing a grey rectangle. */
  const rail = await page2.textContent("#rail2");
  ok("the right rail says why there is no map", /Why there is no map/.test(rail));
  ok("with the coordinate reason", /no latitude or longitude/i.test(rail) || /coordinate/i.test(rail));
  ok("it shows the place ladder the search climbed", /Comp area/.test(rail));
  ok("and marks the rung actually in use", (await page2.$$(".lr.on")).length === 1);
  ok("it draws a price distribution from real rows", (await page2.$$(".hb")).length > 4);
  ok("and compares selected comps on price per sqft", /price per sqft/i.test(rail) || /vs price per sqft/i.test(rail));

  /* Selecting from the feed. */
  await page2.click(".feed .fi:first-child .tog");
  await page2.waitForFunction(() => document.querySelectorAll(".slot.empty").length === 4, null, { timeout: 8000 });
  ok("selecting from the feed fills a tray slot", (await page2.$$(".slot.empty")).length === 4);
  ok("the filled slot shows price and address", /\$/.test(await page2.textContent(".slot:not(.empty) .cap")));
  ok("and a beds/baths/sqft footer", (await page2.$$(".slot:not(.empty) .spec div")).length === 3);
  ok("the feed row flips to a minus", (await page2.textContent(".feed .fi:first-child .tog")).trim() === "−");
  ok("the slot carries a remove control", !!(await page2.$(".slot:not(.empty) [data-drop]")));
  await page2.click(".slot:not(.empty) [data-drop]");
  await page2.waitForFunction(() => document.querySelectorAll(".slot.empty").length === 5, null, { timeout: 8000 });
  ok("removing returns the slot to empty", (await page2.$$(".slot.empty")).length === 5);

  /* Distance offered and disabled in the sort menu. */
  const sortOpts = await page2.$$eval("#feedSort option", (n) => n.map((o) => o.textContent + (o.disabled ? " [disabled]" : "")));
  ok("Distance appears in the sort menu and is disabled",
    sortOpts.some((o) => /Distance/.test(o) && /disabled/.test(o)), sortOpts.join(" | "));

  /* Step 4 in the browser — the sold step's honesty is the whole point. */
  await page2.click('.wz-step[data-step="4"]');
  await page2.waitForSelector(".tray", { timeout: 15000 });
  await page2.waitForFunction(() => /Sold/.test(document.querySelector("#feedCnt")?.textContent || ""), null, { timeout: 8000 });
  ok("step 4 is titled Select Sold Listings", /Select Sold Listings/.test(await page2.textContent(".sel-top h2")));
  ok("its stepper chip uses the spec's red-coral, not the cyan of the others",
    await page2.$eval('.wz-step[data-step="4"]', (e) => e.classList.contains("sold")));
  const soldNote = await page2.textContent("#feedNote");
  ok("the sold rail states the feed has no solds", /publishes Active and Pending only/i.test(soldNote), soldNote.slice(0, 90));
  ok("and that these are Marco's own closings", /closed transactions/i.test(soldNote));
  const soldFeedTxt = await page2.textContent(".feed");
  ok("sold rows show the dual list-and-sold price", /list: \$/.test(soldFeedTxt) && /sold: \$/.test(soldFeedTxt));
  ok("a row with no specs says so instead of showing zeros",
    /no beds\/baths\/sqft on this record/.test(soldFeedTxt));
  ok("and offers the edit that fills them in", !!(await page2.$(".feed [data-editkey]")));
  ok("the empty sold slots use the coral border, per the spec",
    await page2.$eval(".slot.empty", (e) => /c-sold/.test(e.getAttribute("style") || "")));

  /* Select one, so Results downstream has a transaction-sourced sold in it. */
  await page2.click(".feed .fi:first-child .tog");
  await page2.waitForFunction(() => document.querySelectorAll(".slot.empty").length === 4, null, { timeout: 8000 });
  ok("a sold comp selects into the sold tray", (await page2.$$(".slot.empty")).length === 4);
  ok("and its slot banner carries the sold date", /Sold:/.test(await page2.textContent(".slot:not(.empty) .banner")));

  /* Step 5 — no source at all. */
  await page2.click('.wz-step[data-step="5"]');
  await page2.waitForSelector(".tray", { timeout: 15000 });
  await page2.waitForFunction(() => /Off Mkt/.test(document.querySelector("#feedCnt")?.textContent || ""), null, { timeout: 8000 });
  const offTxt = await page2.textContent(".feed");
  ok("the off-market step shows the reason, not an empty list",
    /not published on this feed/i.test(offTxt), offTxt.slice(0, 100));
  ok("and points at manual entry", /Manually Add Listing/i.test(offTxt));
  /* The reason belongs in one place on the screen, not two. */
  ok("the reason is not also repeated in the header band",
    (await page2.$eval("#feedNote", (e) => e.textContent.trim())) === "");

  /* The manual entry modal. */
  await page2.click("#btnManual2");
  await page2.waitForSelector(".ov", { timeout: 8000 });
  ok("the manual modal opens for off market", /Manually Add Off Mkt Listing/.test(await page2.textContent(".ovh")));
  ok("it says why typing is the only way in, without repeating the whole paragraph",
    /only way one gets into the CMA/.test(await page2.textContent(".ovb")));
  ok("it offers the three off-market reasons the spec lists",
    (await page2.$$eval("#mOff option", (n) => n.map((o) => o.value))).join(",") === "EXPIRED,WITHDRAWN,CANCELED");
  ok("and warns that a row with no sqft cannot reach the estimate",
    /cannot contribute a price per square foot/i.test(await page2.textContent(".ovb")));
  await page2.fill("#mAddr", "1936 Cronus Bnd, San Antonio, TX 78245");
  await page2.fill("#mPrice", "390000");
  await page2.fill("#mSqft", "2158");
  await page2.click("#mSave");
  await page2.waitForFunction(() => document.querySelectorAll(".slot.empty").length === 4, null, { timeout: 8000 });
  ok("a hand-typed off-market comp lands in the tray", (await page2.$$(".slot.empty")).length === 4);
  ok("and its slot banner names the off-market reason", /EXPIRED/.test(await page2.textContent(".slot:not(.empty) .banner")));

  /* Results and publish in the browser. */
  await page2.click('.wz-step[data-step="6"]');
  await page2.waitForSelector(".rtbl", { timeout: 15000 });
  const resTxt = await page2.textContent(".res");
  ok("results shows an indicated value", /Indicated value/.test(resTxt));
  ok("with its basis spelled out", /per square foot/.test(resTxt));
  ok("a bucket card per step", (await page2.$$(".kpi")).length === 4);
  ok("and a row per selected comparable", (await page2.$$(".rtbl tbody tr")).length === 2,
    String((await page2.$$(".rtbl tbody tr")).length));
  ok("each row is badged with the step it came from", (await page2.$$(".rtbl .pill")).length === 2);
  ok("and with where the data came from", /transaction/.test(await page2.textContent(".rtbl")));

  await page2.click('.wz-step[data-step="7"]');
  await page2.waitForSelector(".pubrow", { timeout: 15000 });
  const pubTxt = await page2.textContent(".res");
  ok("publish explains what publishing does", /client-facing page/i.test(pubTxt));
  ok("and states plainly that it does not email anyone", /does not email anybody/i.test(pubTxt));

  /* ── screenshots, so the layout gets looked at and not only asserted ── */
  if (process.env.SHOT_DIR) {
    const D = process.env.SHOT_DIR;
    await page2.click('.wz-step[data-step="1"]');
    await page2.waitForSelector(".s1", { timeout: 10000 });
    await page2.screenshot({ path: D + "/01-start.png", fullPage: true });
    for (const [n, name] of [[2, "02-active"], [3, "03-pending"], [4, "04-sold"], [5, "05-offmkt"]]) {
      await page2.click('.wz-step[data-step="' + n + '"]');
      await page2.waitForSelector(".tray", { timeout: 15000 });
      await page2.waitForTimeout(1400);
      await page2.screenshot({ path: D + "/" + name + ".png" });
    }
    await page2.click('.wz-step[data-step="6"]');
    await page2.waitForSelector(".rtbl", { timeout: 15000 });
    await page2.screenshot({ path: D + "/06-results.png", fullPage: true });
    await page2.click('.wz-step[data-step="7"]');
    await page2.waitForSelector(".pubrow", { timeout: 15000 });
    await page2.screenshot({ path: D + "/07-publish.png", fullPage: true });
    await page2.click('.wz-step[data-step="5"]');
    await page2.waitForSelector(".tray", { timeout: 15000 });
    await page2.click("#btnManual2");
    await page2.waitForSelector(".ov", { timeout: 8000 });
    await page2.screenshot({ path: D + "/08-manual-modal.png" });
    await page2.keyboard.press("Escape");
    const pg3 = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await pg3.goto(B + "/c/" + SID, { waitUntil: "networkidle" });
    await pg3.screenshot({ path: D + "/09-client-page.png", fullPage: true });
    await pg3.close();
  }

  ok("no page errors anywhere in the wizard", errs.length === 0, errs.join(" | "));
} catch (err) {
  fail.push("threw: " + (err && err.stack ? err.stack : String(err)));
  console.error(err);
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("\nFAILURES:\n" + fail.map((f) => " - " + f).join("\n")); if (process.env.DUMP_LOG) console.error(srvLog.slice(-4000)); process.exit(1); }
