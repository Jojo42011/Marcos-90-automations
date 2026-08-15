#!/usr/bin/env node
/**
 * Listing Alerts + Market Reports.
 *
 * These two features email Marco's actual clients, so the suite is built around
 * the ways they could lie rather than around whether the buttons render:
 *
 *   - a listing already sent must never be sent twice, but a PRICE CHANGE must
 *     re-notify — that distinction is the whole feature
 *   - a FAILED delivery must not mark listings as sent, or the retry is lost
 *     and the client silently never hears about those homes
 *   - the home-value estimate must be ABSENT when the square footage is
 *     unknown, never guessed — a fabricated number in front of a homeowner is
 *     the worst thing this system could do
 *   - Smart-Area widening must report which rung it landed on
 *
 * Nothing is mocked between the client and the wire: a real SMTP server runs
 * inside the suite, with a throwaway CA so the production client's certificate
 * verification stays switched on.
 *
 * Usage: node scripts/verify-outreach.mjs
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import Database from "better-sqlite3";

const tmp = process.env.OUTREACH_VERIFY_DIR || mkdtempSync(join(tmpdir(), "outreach-"));
if (!process.env.OUTREACH_VERIFY_CHILD) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem"),
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
  ], { stdio: "ignore" });
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
    stdio: "inherit",
    env: { ...process.env, OUTREACH_VERIFY_CHILD: "1", OUTREACH_VERIFY_DIR: tmp, NODE_EXTRA_CA_CERTS: join(tmp, "cert.pem") },
  });
  rmSync(tmp, { recursive: true, force: true });
  process.exit(child.status ?? 1);
}
const key = readFileSync(join(tmp, "key.pem"));
const cert = readFileSync(join(tmp, "cert.pem"));

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

/* ---------------------------------------------------------- fake SMTP ---- */
function startSmtp({ rejectAll = false } = {}) {
  const state = { messages: [], data: "", rcpts: [] };
  const loop = (sock, greet) => {
    let buf = "", inData = false, expecting = null;
    sock.setEncoding("utf8");
    if (greet) sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk; let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; state.messages.push(state.data); state.data = ""; sock.write("250 2.0.0 OK\r\n"); }
          else state.data += line + "\r\n";
          continue;
        }
        const u = line.toUpperCase();
        if (expecting) { expecting = expecting === "user" ? "pass" : null; sock.write(expecting ? "334 UGFzc3dvcmQ6\r\n" : "235 2.7.0 Accepted\r\n"); }
        else if (u.startsWith("EHLO")) sock.write("250-fake\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n");
        else if (u === "AUTH LOGIN") { expecting = "user"; sock.write("334 VXNlcm5hbWU6\r\n"); }
        else if (u.startsWith("MAIL FROM")) sock.write(rejectAll ? "550 5.7.1 Message rejected\r\n" : "250 OK\r\n");
        else if (u.startsWith("RCPT TO")) { state.rcpts.push(line); sock.write("250 OK\r\n"); }
        else if (u === "DATA") { inData = true; sock.write("354 Go ahead\r\n"); }
        else if (u === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => {});
  };
  const server = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.write("220 fake ESMTP\r\n");
    const onData = (chunk) => {
      buf += chunk; let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const u = line.toUpperCase();
        if (u.startsWith("EHLO")) sock.write("250-fake\r\n250-STARTTLS\r\n250 8BITMIME\r\n");
        else if (u === "STARTTLS") {
          sock.write("220 Go ahead\r\n");
          sock.removeListener("data", onData);
          const sec = new tls.TLSSocket(sock, { isServer: true, key, cert });
          loop(sec, false);
          return;
        } else sock.write("250 OK\r\n");
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, state, port: server.address().port })));
}

/* ------------------------------------------------------ seed a mirror ---- */
const listingsDb = join(tmp, "listings.db");
function seedListings() {
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
    const city = o.city ?? "San Antonio";
    const zip = o.zip ?? "78253";
    const county = o.county ?? "Bexar";
    const raw = JSON.stringify({
      property: {
        pool: o.pool ?? "N", stories: o.stories ?? 1, subType: o.subType ?? "SingleFamilyResidence",
        interiorFeatures: o.interior ?? "Open Floor Plan,Island Kitchen,Walk in Closets",
        exteriorFeatures: o.exterior ?? "Covered Patio,Privacy Fence",
        garageSpaces: null,
      },
      geo: { lat: null, lng: null, county },
      school: { district: o.district ?? "Northside" },
      mls: { status: o.status ?? "Active", daysOnMarket: o.dom ?? 30 },
    });
    ins.run(
      o.key ?? `K${i}`, `MLS${i}`, o.status ?? "Active", o.price ?? 300000, null,
      o.street ?? `${100 + i} Test Street`, city, "TX", zip,
      o.beds ?? 3, o.baths ?? 2, o.sqft ?? 2000, o.lot ?? null, o.year ?? 2010,
      o.ptype ?? "RES", o.subdivision ?? "Alamo Ranch Unit 3", "Agent", "Office",
      o.photo === null ? null : (o.photo ?? "https://example.test/p.jpg"), "Lovely home.",
      "2026-08-10T00:00:00Z", "2026-08-01T00:00:00Z", null, raw, "2026-08-14T00:00:00Z",
    );
  };

  // 20 in 78253 San Antonio, prices 250k..440k, sqft 2000 → $/sqft 125..220
  for (let i = 0; i < 20; i++) mk(i, { price: 250000 + i * 10000, sqft: 2000, pool: i < 4 ? "Y" : "N" });
  // 3 in a thin postal code, same city → forces the smart-area ladder to widen
  for (let i = 0; i < 3; i++) mk(100 + i, { key: `T${i}`, zip: "78006", city: "Boerne", county: "Kendall", price: 700000 });
  // one with no photo
  mk(200, { key: "NOPHOTO", photo: null, price: 275000 });
  // one pending
  mk(201, { key: "PEND", status: "Pending", price: 310000 });
  db.close();
}
seedListings();

/* ------------------------------------------------ unit-level behaviour --- */
process.env.LISTINGS_DB_PATH = listingsDb;
process.env.OUTREACH_DB_PATH = join(tmp, "outreach.db");

const criteria = await import("../dist/src/core/listingCriteria.js");
const facetsMod = await import("../dist/src/core/mlsFacets.js");
const mr = await import("../dist/src/core/marketReport.js");

{
  ok("price + bed filter counts correctly",
    criteria.countMatching({ minPrice: 250000, maxPrice: 300000, minBeds: 3 }) === 6,
    String(criteria.countMatching({ minPrice: 250000, maxPrice: 300000, minBeds: 3 })));
  ok("pool filter reaches into the raw MLS record",
    criteria.countMatching({ pool: true }) === 4, String(criteria.countMatching({ pool: true })));
  ok("pool:false excludes pool homes",
    criteria.countMatching({ pool: false }) === criteria.countMatching({}) - 4);
  ok("a feature checkbox matches the comma-joined MLS string",
    criteria.countMatching({ interiorFeatures: ["Island Kitchen"] }) > 0);
  ok("two features AND together, not OR",
    criteria.countMatching({ interiorFeatures: ["Island Kitchen", "Nonexistent Feature"] }) === 0);
  ok("county comes from the raw geo block",
    criteria.countMatching({ counties: ["Kendall"] }) === 3);
  ok("school district filter works", criteria.countMatching({ schoolDistricts: ["Northside"] }) > 0);
  ok("subdivision is a contains match", criteria.countMatching({ subdivisions: ["Alamo Ranch"] }) > 0);
  // Photos: default excludes the photoless listing.
  const withPhotos = criteria.countMatching({ minPrice: 275000, maxPrice: 275000 });
  const allPrice = criteria.countMatching({ minPrice: 275000, maxPrice: 275000, includeWithoutPhotos: true });
  ok("listings with no photo are excluded by default", withPhotos < allPrice, `${withPhotos} vs ${allPrice}`);
  ok("Active-only is the default status", criteria.countMatching({}) === criteria.countMatching({ statuses: ["Active"] }));
  ok("a Pending listing is reachable when asked for", criteria.countMatching({ statuses: ["Pending"] }) === 1);
}

{
  const f = facetsMod.getMlsFacets(true);
  ok("facets list only cities that exist", f.cities.some((c) => c.value === "San Antonio") && f.cities.every((c) => c.count > 0));
  ok("facets carry real feature vocabulary", f.interiorFeatures.some((x) => /Island Kitchen/.test(x.value)));
  ok("facets name garage as unavailable on this feed",
    f.unavailable.some((u) => /garage/i.test(u.field)), JSON.stringify(f.unavailable.map((u) => u.field)));
  ok("facets name the missing coordinates, so no map-draw is offered",
    f.unavailable.some((u) => /map area/i.test(u.field)));
  ok("facets name financial options as not published",
    f.unavailable.some((u) => /financial/i.test(u.field)));
}

{
  // Smart-Area: 78006 has 3 listings, below the floor of 15 → must widen.
  const res = mr.resolveArea({ postalCode: "78006" }, {});
  ok("smart area widens past a thin postal code", res.rung !== "postal", JSON.stringify(res.ladder));
  ok("smart area reports the ladder it climbed", res.ladder.length >= 2 && res.ladder[0].rung === "postal");
  const tight = mr.resolveArea({ postalCode: "78253" }, {});
  ok("a postal code with enough comparables is NOT widened", tight.rung === "postal", JSON.stringify(tight.ladder));

  // Value estimate: no sqft → NO number, ever.
  const noSqft = mr.estimateValue({ postalCodes: ["78253"] }, {}, "78253");
  ok("no square footage means NO value estimate is invented", noSqft.estimate === null, String(noSqft.estimate));
  ok("and it says what is missing", /square footage is not on file/i.test(noSqft.basis), noSqft.basis);

  const withSqft = mr.estimateValue({ postalCodes: ["78253"] }, { sqft: 2000 }, "78253");
  ok("with square footage the estimate is comp arithmetic", withSqft.estimate > 0 && withSqft.low < withSqft.estimate && withSqft.high > withSqft.estimate,
    JSON.stringify({ e: withSqft.estimate, l: withSqft.low, h: withSqft.high }));
  ok("the estimate says it is not an appraisal", /not an appraisal/i.test(withSqft.basis));

  const built = mr.buildMarketReport({ criteria: {}, anchor: { postalCode: "78006" }, subject: { sqft: 2500 }, adjustedValue: 812000 });
  ok("an agent's adjusted value overrides the arithmetic", built.displayValue === 812000 && built.adjusted === true);
  ok("a widened report says so in its notes", built.notes.some((n) => /widened/i.test(n)), JSON.stringify(built.notes));
  ok("a report with no sold data says so", built.notes.some((n) => /sold/i.test(n)), JSON.stringify(built.notes));
}

/* ---------------------------------------------------------- the server --- */
const PORT = Number(process.env.PORT || 3419);
const B = `http://localhost:${PORT}`;
const TOKEN = "verify-outreach";
const smtp = await startSmtp();
writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 3, leadKeyToId: { "buyer@example.com": "L1", "owner@example.com": "L2" },
  conversationsByLeadId: {}, commandTasks: [],
  leadsById: {
    L1: { id: "L1", name: "Dana Buyer", email: "buyer@example.com", phone: "2105551234", crmIntent: "buyer", crmStatus: "hot", createdAt: "2026-08-01T00:00:00Z", activity: [] },
    L2: { id: "L2", name: "Sam Owner", email: "owner@example.com", phone: "2105559999", crmIntent: "seller", crmStatus: "nurture", address: "123 Test Street, San Antonio, TX 78253", createdAt: "2026-08-01T00:00:00Z", activity: [] },
    L3: { id: "L3", name: "No Email Buyer", phone: "2105550000", crmIntent: "buyer", crmStatus: "new", createdAt: "2026-08-01T00:00:00Z", activity: [] },
  },
}));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT), DASHBOARD_TOKEN: TOKEN,
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "t.json"),
    EMAIL_DB_PATH: join(tmp, "e.db"), TRANSACTIONS_DB_PATH: join(tmp, "x.db"),
    LISTINGS_DB_PATH: listingsDb, OUTREACH_DB_PATH: join(tmp, "outreach.db"),
    GMAIL_SMTP_HOST: "localhost", GMAIL_SMTP_PORT: String(smtp.port),
    GMAIL_SMTP_USER: "marco@example.com", GMAIL_SMTP_APP_PASSWORD: "abcdefghijklmnop",
    GMAIL_FROM_NAME: "Marco Puga", PUBLIC_BASE_URL: B,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

const api = (p, init) => fetch(B + p + (p.includes("?") ? "&" : "?") + "token=" + TOKEN, init);
const post = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

let alertId = null, sendId = null, reportId = null;
try {
  // ---- preview -----------------------------------------------------------
  {
    const r = await (await post("/api/outreach/preview", { criteria: { minPrice: 250000, maxPrice: 300000 } })).json();
    ok("preview returns a real count and a sample", r.count === 6 && r.sample.length > 0, JSON.stringify({ c: r.count, s: r.sample.length }));
    ok("preview describes the criteria in words", /\$250,000/.test(r.summary), r.summary);
  }
  ok("facets endpoint requires a token", (await fetch(B + "/api/mls/facets")).status === 401);

  // ---- create an alert; it must send an initial email ---------------------
  {
    const res = await post("/api/leads/L1/listing-alerts", {
      name: "Alamo Ranch 3-bed", frequency: "daily",
      cc: "spouse@example.com",
      criteria: { minPrice: 250000, maxPrice: 320000, minBeds: 3, cities: ["San Antonio"] },
    });
    const j = await res.json();
    alertId = j.alert?.id;
    ok("creating an alert returns it", res.status === 201 && !!alertId, JSON.stringify(j).slice(0, 200));
    ok("saving an alert sends the promised first email", j.firstSend?.ok === true && j.firstSend.listingCount > 0, JSON.stringify(j.firstSend));
    sendId = j.firstSend?.sendId;
    ok("the email actually reached the SMTP server", smtp.state.messages.length === 1, String(smtp.state.messages.length));
    const msg = smtp.state.messages[0] || "";
    ok("the CC recipient got a RCPT TO", smtp.state.rcpts.some((r) => r.includes("spouse@example.com")), JSON.stringify(smtp.state.rcpts));
    const decoded = Buffer.from(msg.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8");
    ok("the email carries an open-tracking pixel", /\/r\/open\?s=/.test(decoded));
    ok("listing links are click-tracked", /\/r\/click\?s=[^"]+&l=/.test(decoded));
    ok("the email carries an unsubscribe link", /\/r\/stop\?k=alert/.test(decoded));
    ok("the email shows real listing prices", /\$2\d\d,\d\d\d/.test(decoded), decoded.slice(0, 200));
  }

  // ---- nothing new: must NOT re-send -------------------------------------
  {
    const before = smtp.state.messages.length;
    const r = await (await post(`/api/listing-alerts/${alertId}/send`, { force: false })).json();
    ok("an alert with nothing new sends no email", r.skipped === "no_new_matches" && smtp.state.messages.length === before, JSON.stringify(r));
  }

  // ---- a price change must re-notify -------------------------------------
  {
    const db = new Database(listingsDb);
    db.prepare(`UPDATE listings SET list_price = 261000 WHERE listing_key = 'K1'`).run();
    db.close();
    const before = smtp.state.messages.length;
    const r = await (await post(`/api/listing-alerts/${alertId}/send`, { force: false })).json();
    ok("a price change re-notifies the buyer", r.ok && r.listingCount === 1 && smtp.state.messages.length === before + 1, JSON.stringify(r));
    const decoded = Buffer.from((smtp.state.messages.at(-1) || "").split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8");
    ok("and the email says WHY it is in there", /Price change/i.test(decoded));
  }

  // ---- a failed delivery must not consume the listings -------------------
  {
    const db = new Database(listingsDb);
    db.prepare(`UPDATE listings SET list_price = 262500 WHERE listing_key = 'K1'`).run();
    db.close();
    smtp.server.close();
    const failed = await (await post(`/api/listing-alerts/${alertId}/send`, { force: false })).json();
    ok("a delivery failure is reported, not swallowed", failed.ok === false && !!failed.error, JSON.stringify(failed).slice(0, 160));

    /* The listing is still OWED: sent_listings must still carry the price from
       the last SUCCESSFUL send, so the next run sees the change again. */
    const { getOutreachDb } = await import("../dist/src/core/outreachStore.js");
    const row = getOutreachDb().prepare(`SELECT last_price FROM sent_listings WHERE alert_id = ? AND listing_key = 'K1'`).get(alertId);
    ok("sent_listings still holds the OLD price after a failed send",
      Number(row?.last_price) === 261000, JSON.stringify(row));
  }

  // ---- coverage: the hygiene report --------------------------------------
  {
    const c = await (await api("/api/outreach/coverage")).json();
    ok("coverage counts buyers without an alert", Array.isArray(c.buyersWithoutAlert), JSON.stringify(c).slice(0, 160));
    ok("a buyer WITH an alert is not listed as a gap", !c.buyersWithoutAlert.some((l) => l.id === "L1"));
    ok("a contact with no email is excluded from the gap list", !c.buyersWithoutAlert.some((l) => l.id === "L3"));
    ok("sellers without a market report are listed", c.sellersWithoutReport.some((l) => l.id === "L2"));
  }

  // ---- market report ------------------------------------------------------
  {
    const res = await post("/api/leads/L2/market-reports", {
      name: "123 Test Street", address: "123 Test Street, San Antonio, TX 78253",
      frequency: "quarterly", drip: true,
      subject: { sqft: 2200 },
      emailMessage: "Thought you'd want to see this.",
      criteria: { minBeds: 3 },
    });
    const j = await res.json();
    reportId = j.report?.id;
    ok("creating a market report returns it", res.status === 201 && !!reportId);
    ok("Save & Close does NOT send immediately", j.firstSend === null, JSON.stringify(j.firstSend));
    ok("a drip report is scheduled forward", !!j.report.nextSendAt);

    const p = await (await api(`/api/market-reports/${reportId}/preview`)).json();
    ok("the report preview builds from live listings", p.built?.stats?.count > 0, JSON.stringify(p.built?.stats));
    ok("the preview resolves an area and names it", !!p.built.area.label);
    ok("the value estimate is present because sqft was given", p.built.value.estimate > 0, JSON.stringify(p.built.value));
  }

  // ---- public tracking routes --------------------------------------------
  {
    const pix = await fetch(`${B}/r/open?s=${encodeURIComponent(sendId)}`);
    ok("the open pixel returns a GIF", pix.ok && (pix.headers.get("content-type") || "").includes("image/gif"));

    const click = await fetch(`${B}/r/click?s=${encodeURIComponent(sendId)}&l=K1`, { redirect: "manual" });
    ok("a click redirects to the public listing page", click.status === 302 && (click.headers.get("location") || "").includes("/l/K1"), String(click.status));

    const { engagementForLead } = await import("../dist/src/core/outreachStore.js");
    const ev = engagementForLead("L1", 20);
    ok("the click was logged as engagement", ev.some((e) => e.event === "listing_clicked" && e.listingKey === "K1"), JSON.stringify(ev.slice(0, 3)));
    ok("the open was logged too", ev.some((e) => e.event === "email_opened"));

    const page = await (await fetch(`${B}/l/K1`)).text();
    ok("the public listing page renders the home", /Test Street/.test(page) && /\$/.test(page));
    ok("the public listing page needs no login", !/password|sign in/i.test(page));
    ok("the public page cites its source and refresh date", /San Antonio Board of REALTORS/i.test(page));

    const gone = await fetch(`${B}/l/NOSUCHKEY`);
    ok("a listing that left the feed says so honestly", gone.status === 404);

    const rep = await (await fetch(`${B}/r/report?id=${encodeURIComponent(reportId)}`)).text();
    ok("the public market report renders", /Test Street/.test(rep) && /Estimated value|square footage/i.test(rep));
    ok("the report page states figures are asking prices, not an appraisal", /not an appraisal/i.test(rep));

    const after = await (await api(`/api/leads/L2/outreach`)).json();
    ok("viewing the report is counted", after.reports[0].viewCount === 1 && !!after.reports[0].lastViewedAt, JSON.stringify(after.reports[0]).slice(0, 160));
  }

  // ---- unsubscribe --------------------------------------------------------
  {
    const stop = await (await fetch(`${B}/r/stop?k=alert&id=${encodeURIComponent(alertId)}`)).text();
    ok("the unsubscribe page confirms", /unsubscribed/i.test(stop));
    const list = await (await api("/api/leads/L1/outreach")).json();
    ok("unsubscribing pauses the alert rather than deleting it",
      list.alerts[0].paused === true && list.alerts[0].sendEmail === false, JSON.stringify(list.alerts[0]).slice(0, 160));
    const { dueAlerts } = await import("../dist/src/core/outreachStore.js");
    ok("a paused alert is never due again", !dueAlerts().some((a) => a.id === alertId));
  }

  // ---- edit + delete ------------------------------------------------------
  {
    const patched = await (await api(`/api/listing-alerts/${alertId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frequency: "weekly", paused: false, sendEmail: true }),
    })).json();
    ok("changing the cadence moves the next send", patched.alert.frequency === "weekly" && !!patched.alert.nextSendAt);
    const del = await (await api(`/api/listing-alerts/${alertId}`, { method: "DELETE" })).json();
    ok("an alert can be deleted", del.ok === true);
    const gone = await (await api("/api/leads/L1/outreach")).json();
    ok("and it is gone", gone.alerts.length === 0);
  }


  // ---- the CRM profile, in a real browser --------------------------------
  {
    const { chromium } = await import("playwright");
    const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    const page = await br.newPage({ viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await page.goto(B + "/crm?token=" + TOKEN, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2600);

    // Open the seller contact's profile.
    const opened = await page.evaluate(() => { if (typeof openLead !== "function") return false; openLead("L2"); return true; });
    ok("the profile opens", opened);
    await page.waitForTimeout(1400);

    ok("no page errors on the profile", errs.length === 0, errs.slice(0, 2).join(" | "));
    ok("the Listing Alerts block is on the rail", await page.locator("#ldAlertsBlk").count() === 1);
    ok("the Market Reports block is on the rail", await page.locator("#ldReportsBlk").count() === 1);
    ok("the market report card shows real engagement counts",
      /Last viewed|Views/i.test(await page.textContent("#ldReportsBlk")), (await page.textContent("#ldReportsBlk")).slice(0, 120));

    const web = await page.textContent("#ldWebActBlk");
    ok("Web Activity is a real feed now, not a promise",
      !/See when this contact visits/i.test(web), web.slice(0, 120));

    // The alert builder.
    await page.evaluate(() => openLead("L1"));
    await page.waitForTimeout(1200);
    await page.click("#ldAlertAdd");
    await page.waitForTimeout(1200);
    ok("the alert builder opens", await page.locator("#oaOv .oa-modal").isVisible());
    ok("filters are built from the real MLS vocabulary",
      (await page.locator('#oaCity .oa-ck').count()) > 0 && /San Antonio/.test(await page.textContent("#oaCity")));
    ok("feature checkboxes come from the feed",
      /Island Kitchen/.test(await page.textContent("#oaIf")));
    ok("fields this feed cannot answer are named, not rendered as dead controls",
      /Financial options/i.test(await page.textContent(".oa-unav")));
    ok("there is no map-draw control offered",
      (await page.locator("#oaOv canvas, #oaOv .map, #oaOv [data-draw]").count()) === 0);

    // Live match count reacts to criteria.
    await page.fill("#oaPMin", "250000");
    await page.fill("#oaPMax", "300000");
    await page.waitForTimeout(900);
    const cnt = await page.textContent("#oaCount");
    ok("the builder shows a live match count", /\d+ listings? match/.test(cnt), cnt);

    // A criteria set that matches nothing must say so, in red.
    await page.fill("#oaPMin", "99000000");
    await page.waitForTimeout(900);
    const zero = await page.textContent("#oaCount");
    ok("impossible criteria report zero rather than looking fine", /^0 listings match/.test(zero), zero);
    ok("and the zero state is flagged", (await page.getAttribute("#oaCount", "class") || "").includes("zero"));

    await page.evaluate(() => closeOa());

    // The report builder's live preview.
    await page.evaluate(() => openLead("L2"));
    await page.waitForTimeout(1200);
    await page.click("#ldReportAdd");
    await page.waitForTimeout(1600);
    ok("the report builder opens with the contact's address prefilled",
      (await page.inputValue("#orAddr")).includes("Test Street"), await page.inputValue("#orAddr"));
    const live = await page.textContent("#orLive");
    ok("the report preview builds from live listings", /listing/.test(live), live.slice(0, 120));

    // Clear the square footage: the estimate must disappear, not be guessed.
    await page.fill("#orSqft", "");
    await page.waitForTimeout(1200);
    const noEst = await page.textContent("#orLive");
    ok("with no square footage the builder refuses to show a value",
      /square footage is not on file/i.test(noEst), noEst.slice(0, 160));
    ok("and the automated-estimate field shows a dash, not a number",
      (await page.textContent("#orAuto")).trim() === "—", await page.textContent("#orAuto"));

    await page.fill("#orSqft", "2200");
    await page.waitForTimeout(1200);
    ok("adding the square footage produces an estimate",
      /^\$/.test((await page.textContent("#orAuto")).trim()), await page.textContent("#orAuto"));

    await page.close();
    await br.close();
  }

  ok("no unhandled server errors", !/UnhandledPromiseRejection|TypeError:/.test(log), log.slice(-300));
} finally {
  srv.kill();
  try { smtp.server.close(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:\n - " + fail.join("\n - ")); process.exit(1); }
