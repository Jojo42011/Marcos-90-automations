#!/usr/bin/env node
/**
 * "When entering an address on a contact profile, I want the system to
 * automatically suggest matching addresses as I type." — Marco.
 *
 * THE PROPERTY THAT MATTERS MOST HERE IS THE DORMANT ONE. This ships with no
 * maps key, and the way it behaves unconfigured is what protects the data: it
 * must return nothing and say nothing, so the address box stays the plain text
 * box it is today. An autocomplete that offers a plausible-looking address
 * because it could not reach a provider gets that address SAVED onto a real
 * contact, and a wrong address is worse than an empty one.
 *
 * So: unconfigured behaviour first, then the wiring with a stubbed provider,
 * then the page itself in a browser to prove the field still works untouched.
 *
 * Usage: node scripts/verify-address-autocomplete.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright";

const PORT = 3994;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "addr-"));
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const iso = new Date().toISOString();
const leads = { L1: { id: "L1", platform: "instagram", userId: "u1", username: "@u1", name: "Jason Alvarez",
  phone: "(210) 555-0100", email: null, state: "new", source: "TikTok", createdAt: iso, updatedAt: iso } };
writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 9, leadsById: leads, leadKeyToId: { "instagram::u1": "L1" },
  conversationsByLeadId: { L1: { messages: [] } }, commandTasks: [] }));

const baseEnv = { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
  DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db") };
delete baseEnv.BRIVITY_API_KEY;
delete baseEnv.MAPS_API_KEY;
delete baseEnv.GOOGLE_MAPS_API_KEY;

const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
const boot = async (env) => {
  const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  await until(async () => (await fetch(B + "/health")).ok);
  return srv;
};

/* ───────────── 1. UNCONFIGURED: the shipping default ───────────── */
console.log("\nDORMANT — no key set, which is how this ships");
let srv = await boot(baseEnv);
try {
  let r = await fetch(`${B}/api/geo/status`);
  let j = await r.json();
  ok("status reports it is not configured", r.ok && j.configured === false, JSON.stringify(j));
  ok("and says what to set, plus that a map needs more than the key",
    /MAPS_API_KEY/.test(j.note) && /coordinates|geocoding/i.test(j.note));

  r = await fetch(`${B}/api/geo/autocomplete?q=123%20Rockcress`);
  j = await r.json();
  ok("autocomplete answers without erroring", r.ok, `HTTP ${r.status}`);
  ok("it returns NO suggestions rather than inventing one",
    Array.isArray(j.suggestions) && j.suggestions.length === 0, JSON.stringify(j.suggestions));
  ok("and reports configured:false so the UI can stay quiet", j.configured === false);
} finally { srv.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 400)); }

/* ───────────── 2. CONFIGURED: against a stubbed provider ───────────── */
console.log("\nCONFIGURED — with a stand-in provider");
/* The module talks to Google's host directly, so the stub cannot intercept it
   without a proxy. What CAN be proven here is the contract the module presents
   to its caller: keyed requests are attempted, failures degrade to an empty
   list with an error rather than to fabricated rows, and nothing throws. */
const { autocompleteAddress, geocodeAddress, isGeoConfigured } =
  await import("../dist/src/integrations/geo/index.js");

process.env.MAPS_API_KEY = "test-key-not-real";
ok("a key flips isGeoConfigured", isGeoConfigured() === true);
const withKey = await autocompleteAddress("123 Rockcress Rd");
ok("a keyed call reports configured:true even when the provider rejects it", withKey.configured === true);
ok("a rejected provider call yields NO suggestions, never placeholders",
  Array.isArray(withKey.suggestions) && withKey.suggestions.length === 0);
ok("and carries the reason rather than failing silently",
  withKey.ok === false ? Boolean(withKey.error) : true, JSON.stringify(withKey).slice(0, 160));

const short = await autocompleteAddress("12");
ok("a query under 3 characters is not a provider call and not an error",
  short.ok === true && short.suggestions.length === 0);

const geo = await geocodeAddress("");
ok("geocoding an empty string is refused rather than guessed", geo.lat === null && geo.lng === null);
delete process.env.MAPS_API_KEY;
ok("removing the key makes it dormant again", isGeoConfigured() === false);

/* No (0,0) fallback anywhere — that is a real place in the Atlantic. */
const src = readFileSync(join(process.cwd(), "src/integrations/geo/index.ts"), "utf8");
ok("there is no 0,0 coordinate fallback in the source", !/lat:\s*0\b/.test(src) && !/lng:\s*0\b/.test(src));

/* ───────────── 3. THE PAGE: the field still works ───────────── */
console.log("\nTHE CONTACT PROFILE — the box still behaves with no key");
srv = await boot(baseEnv);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(B + "/crm", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.locator('[data-view="leads"]').click();
  await page.waitForTimeout(500);
  await page.locator("#leadRows tr").first().click();
  await page.waitForTimeout(900);

  /* The Add Address control sits behind a kebab menu on the Addresses block.
     Click it when it is on screen; otherwise open the same modal the menu item
     opens, which is the thing under test either way. */
  const opened = await page.evaluate(() => {
    const direct = document.querySelector('[data-act="addrNew"]');
    if (direct) { direct.click(); return "control"; }
    /* `let LEADS` is not a window property, so only the function is reachable
       from here. A minimal lead is enough — the modal under test is the form. */
    if (typeof openAddressModal === "function") {
      openAddressModal({ id: "L1", name: "Jason Alvarez" }, null); return "direct";
    }
    return "";
  });
  ok("the Add Address modal opened (" + (opened || "not") + ")", Boolean(opened));
  if (opened) {
    await page.waitForTimeout(600);
    const hasInput = await page.locator("#adStreet").count() > 0;
    ok("the street field is present", hasInput);
    if (hasInput) {
      ok("a suggestion list element exists under it", await page.locator("#adSuggest").count() > 0);
      ok("the list starts hidden", !(await page.locator("#adSuggest").isVisible()));
      await page.locator("#adStreet").fill("123 Rockcress Rd");
      await page.waitForTimeout(900);
      ok("with no key configured the list never opens",
        !(await page.locator("#adSuggest").isVisible()));
      ok("and the typed value is untouched",
        (await page.locator("#adStreet").inputValue()) === "123 Rockcress Rd");
    }
  } else {
    ok("the Add Address modal could be opened", false, "no addrNew control and openAddressModal unavailable");
  }
  ok("no page errors", errs.length === 0, errs.join(" | "));
} finally {
  await browser.close();
  srv.kill("SIGKILL");
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.log("\nFailures:"); fail.forEach((f) => console.log("  · " + f)); process.exit(1); }
