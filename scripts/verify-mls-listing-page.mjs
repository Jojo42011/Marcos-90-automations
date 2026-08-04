/**
 * MLS click-through verification: clicking a house in the MLS tab opens its
 * listing page, and that page shows what the feed actually holds.
 *
 * Drives a REAL browser against a locally running `dist/src/server.js` — the
 * established practice in this repo, because the two pages have no build step
 * and no test framework, so the only honest check is the one that clicks.
 *
 * Usage:
 *   node dist/src/server.js &            # on PORT (default 3360 below)
 *   node scripts/verify-mls-listing-page.mjs
 *
 * Needs one listing in the store. Seed the fixture with:
 *   node scripts/seed-test-listing.mjs
 */
import { chromium } from "playwright";
const B = process.env.BASE_URL || "http://localhost:3360";
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const p = await b.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
// Filter on the RESOURCE URL, not the message text — the message never
// contains the URL, so a text filter silently matches nothing. The seeded
// photos point at a domain that does not exist, and favicon is noise.
p.on("console", m => { const u = m.location().url || ""; if (m.type() === "error" && !/example\.test|favicon/.test(u)) errs.push("console: " + u + " " + m.text()); });

let pass = 0, fail = [];
const ok = (n, c) => c ? pass++ : fail.push(n);

await p.goto(B + "/listings", { waitUntil: "networkidle" });
await p.waitForSelector(".card", { timeout: 10000 });

// 1. the card is a real link
const href = await p.getAttribute(".card .cardlink", "href");
ok("card is an <a> pointing at /listing with the key", !!href && href.includes("/listing") && href.includes("key=TEST-1001"));

// 2. clicking the card navigates to the listing
await p.click(".card .cardlink");
await p.waitForURL(/\/listing\?/, { timeout: 10000 });
ok("clicking a house navigates to its listing page", /\/listing\?.*key=TEST-1001/.test(p.url()));

// 3. the page actually rendered the listing
await p.waitForSelector(".price", { timeout: 10000 });
const body = await p.textContent("body");
ok("price shown", body.includes("$565,000"));
ok("address shown", body.includes("128 Cibolo Ridge"));
ok("city/state shown", body.includes("Boerne, TX, 78006"));
ok("remarks shown", body.includes("quiet cul-de-sac"));
const facts = await p.textContent(".facts");
ok("facts: beds/baths/sqft", /Beds\s*4/.test(facts) && /Baths\s*3/.test(facts) && facts.includes("2,840"));
ok("days on market shown", body.includes("51"));
ok("schools shown", body.includes("Boerne ISD") && body.includes("Champion"));
ok("listing agent shown", body.includes("Marco Puga") && body.includes("210-555-0142"));
ok("taxes formatted", body.includes("$9,840"));
ok("MLS number chip", body.includes("MLS 1799432"));
ok("tab title is the address", (await p.title()).includes("128 Cibolo Ridge"));

// 4. gallery: 3 photos, thumbs, counter, arrows wrap
ok("thumbnail per photo", (await p.$$(".thumbs img")).length === 3);
ok("counter starts at 1/3", (await p.textContent("#counter")).trim() === "1 / 3");
await p.click("#next");
ok("next advances", (await p.textContent("#counter")).trim() === "2 / 3");
await p.click("#prev"); await p.click("#prev");
ok("prev wraps backwards to the last photo", (await p.textContent("#counter")).trim() === "3 / 3");
await p.keyboard.press("ArrowRight");
ok("arrow key wraps forward to the first", (await p.textContent("#counter")).trim() === "1 / 3");
await p.click(".thumbs img[data-i='2']");
ok("thumbnail jumps to that photo", (await p.textContent("#counter")).trim() === "3 / 3");
ok("active thumb is marked", (await p.$$(".thumbs img.on")).length === 1);

// 5. back returns to the search
await p.click("#back");
await p.waitForURL(/\/listings/, { timeout: 10000 });
ok("back returns to the MLS list", /\/listings/.test(p.url()));

// Nothing may go wrong on the HAPPY path. The negative tests below
// deliberately request things that do not exist, so their 404s are the
// behavior under test, not a defect — snapshot the count here instead.
ok("no page errors on the happy path", errs.length === 0);

// 6. a listing that fell out of the feed says so
await p.goto(B + "/listing?key=GONE-1", { waitUntil: "networkidle" });
ok("missing listing explains itself", (await p.textContent("body")).includes("no longer in the MLS feed"));

// 7. no key at all
await p.goto(B + "/listing", { waitUntil: "networkidle" });
ok("no key given is handled", (await p.textContent("body")).includes("No listing was specified"));

// 8. lead mode: the link button must NOT navigate
await p.goto(B + "/listings?leadId=lead-xyz&leadName=Test%20Lead", { waitUntil: "networkidle" });
await p.waitForSelector(".card", { timeout: 10000 });
ok("link button renders in lead mode", (await p.$$("[data-link]")).length === 1);
ok("link button is outside the anchor", (await p.$$(".cardlink [data-link]")).length === 0);
const before = p.url();
await p.click("[data-link]");
await p.waitForTimeout(1200);
ok("clicking 'set as their property' does not navigate away", p.url() === before);

console.log(`\n${pass} passed, ${fail.length} failed`);
for (const f of fail) console.log("  ✗ " + f);
for (const e of errs.filter(x => !/GONE-1|lead-xyz/.test(x))) console.log("  ! unexpected: " + e);
await b.close();
process.exit(fail.length ? 1 : 0);
