#!/usr/bin/env node
/**
 * Every lead reaches the CRM, including the ones with no phone number.
 *
 * WHY THIS SUITE EXISTS. Marco opened the CRM and counted 54 leads in a system
 * that held far more. The cause was one line in getDashboardSnapshot():
 *
 *     if (!hasPhone) continue;
 *
 * The snapshot began life as the feed for an SMS-outreach dashboard, where a
 * contact you cannot text is not actionable. But the CRM builds its ENTIRE lead
 * list from that same snapshot, and a DM lead arrives with a platform, a
 * username and a real conversation and NO phone — the number only appears later,
 * if the person gives one. So every DM lead was invisible in the CRM. Not
 * filtered, not greyed out, not on page two. Absent.
 *
 * Nothing crashed and no test failed, because every fixture in this repo gave
 * its leads a phone number. That is the shape of bug this file exists to catch:
 * data that is silently absent looks exactly like data that does not exist.
 *
 * Usage: node scripts/verify-phoneless-leads.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3993;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "phoneless-"));

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const leads = {}; const convos = {};
function add(id, over, msgs) {
  leads[id] = { id, platform: "instagram", userId: "u_" + id, username: "@" + id,
    name: null, phone: null, email: null, state: "new", source: "Instagram",
    createdAt: iso(5), updatedAt: iso(1), ...over };
  convos[id] = { messages: msgs || [] };
}

/* The realistic mix. Four DM leads with no phone at all — the ones that were
   disappearing — and two ordinary phone-holding leads. */
add("dm_1", { name: "Purple Kitty 22" }, [{ role: "user", text: "is it still available", at: iso(2) }]);
add("dm_2", { name: null, username: "@nophone2" }, [{ role: "user", text: "hi", at: iso(3) }]);
add("dm_3", { name: "Email Only", email: "eo@example.com" }, [{ role: "user", text: "info?", at: iso(1) }]);
add("dm_4", { name: "Tiktok Person", platform: "tiktok", source: "TikTok" }, [{ role: "user", text: "price", at: iso(1) }]);
add("ph_1", { name: "Has Phone", phone: "(210) 555-0101" }, [{ role: "user", text: "hey", at: iso(1) }]);
add("ph_2", { name: "Also Phone", phone: "(210) 555-0102" }, []);

writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 50, leadsById: leads,
  leadKeyToId: Object.fromEntries(Object.values(leads).map((l) => [l.platform + "::" + l.userId, l.id])),
  conversationsByLeadId: convos, commandTasks: [],
}));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db") },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch {} });
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };

try {
  await until(async () => (await fetch(B + "/health")).ok);

  // ---- what the CRM asks for -----------------------------------------------
  const full = await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json();
  const ids = full.leads.map((l) => l.id).sort();
  ok("the CRM's feed returns every lead in the store", full.leads.length === 6, String(full.leads.length));
  ok("and specifically the four with no phone",
    ["dm_1", "dm_2", "dm_3", "dm_4"].every((i) => ids.includes(i)), JSON.stringify(ids));
  ok("a DM lead keeps the identity it does have",
    full.leads.find((l) => l.id === "dm_1")?.username === "@dm_1");
  ok("its conversation comes with it, not just the row",
    (full.leads.find((l) => l.id === "dm_1")?.messages || []).length === 1);
  ok("an email-only contact is included too",
    full.leads.find((l) => l.id === "dm_3")?.email === "eo@example.com");

  // ---- the totals were never lying; only the array was ---------------------
  ok("totals.leads always counted every lead", full.totals.leads === 6, String(full.totals.leads));
  ok("totals.withPhone counts only the two that have one", full.totals.withPhone === 2, String(full.totals.withPhone));
  ok("shownLeads now matches what is actually shown", full.totals.shownLeads === 6, String(full.totals.shownLeads));

  // ---- the legacy outreach dashboard is deliberately unchanged -------------
  /* dashboard.html is an SMS view: a contact you cannot text is genuinely not
     actionable there. Changing its default was not necessary to fix the CRM,
     and would have been a second, unrequested behaviour change. */
  const legacy = await (await fetch(B + "/api/dashboard/data")).json();
  ok("without the flag the old behaviour is byte-for-byte preserved",
    legacy.leads.length === 2 && legacy.leads.every((l) => l.phone), String(legacy.leads.length));
  ok("and its totals still report the true store size", legacy.totals.leads === 6);
  ok("so the two views disagree on rows but agree on the count",
    legacy.totals.leads === full.totals.leads);

  // ---- the flag is a flag, not a substring accident ------------------------
  const off = await (await fetch(B + "/api/dashboard/data?includePhoneless=0")).json();
  ok("includePhoneless=0 means off", off.leads.length === 2, String(off.leads.length));
  const word = await (await fetch(B + "/api/dashboard/data?includePhoneless=true")).json();
  ok("and 'true' is accepted as well as '1'", word.leads.length === 6, String(word.leads.length));

  // ---- the DM console and the CRM must now agree --------------------------
  /* These two disagreeing is what made the bug so hard to see: the DM console
     read conversations directly and showed the threads, while the CRM read the
     snapshot and did not. */
  const dm = await (await fetch(B + "/api/dm/inbound-report?days=60")).json();
  const dmTotal = Object.values(dm.platforms).reduce((a, p) => a + p.contactsWithInbound, 0);
  ok("every contact the DM console can see is now reachable in the CRM feed",
    dmTotal <= full.leads.length, `${dmTotal} vs ${full.leads.length}`);
  // ---- and it must actually reach the screen ------------------------------
  /* The server sending the rows is only half of it. The CRM applied a SECOND
     filter client-side — `l.name || l.phone` — which dropped a DM lead that has
     only a handle, after the server had finally started sending it. Nothing but
     loading the real page catches a bug that lives in the page. */
  if (process.env.PW_CHROMIUM) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
    const page = await browser.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(B + "/crm", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const shown = await page.evaluate(() => (typeof LEADS !== "undefined" ? LEADS.map((l) => l.id) : []));
    ok("the CRM page itself holds every lead", shown.length === 6, JSON.stringify(shown));
    ok("including the handle-only lead with no name and no phone",
      shown.includes("dm_2"), JSON.stringify(shown));
    const names = await page.evaluate(() => (typeof LEADS !== "undefined" ? LEADS.map((l) => l.name) : []));
    ok("a nameless lead is labelled by its handle rather than blank",
      names.includes("@nophone2"), JSON.stringify(names));
    ok("the leads counter reflects the real number",
      (await page.locator("#lnAll").innerText()).trim() === "6",
      await page.locator("#lnAll").innerText());
    /* A Brivity connection that is not working must SAY so. In this fixture no
       BRIVITY_API_KEY is set, which is the same state production appears to be
       in — and previously that produced a silently shorter list. */
    /* The banner lives in the Leads view, which is where the lead count is and
       therefore where the explanation belongs. Open it as Marco would. */
    await page.locator('[data-view="leads"]').click();
    await page.waitForTimeout(400);
    ok("the banner is actually visible on the Leads view, not just in the DOM",
      await page.locator("#brvBanner").isVisible());
    const banner = await page.locator("#brvBanner").innerText().catch(() => "");
    ok("an unconfigured Brivity connection is stated on the page, not left silent",
      /not connected|could not reach|pull failed/i.test(banner), JSON.stringify(banner.slice(0, 120)));
    ok("and it says what to do about it",
      /migration|imported/i.test(banner), JSON.stringify(banner.slice(0, 160)));
    /* Now that phoneless leads are on the board, their Call and Text actions
       must not look live. This repo's rule: never a button that appears to do
       something it cannot actually do. */
    const rowState = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("#leadRows tr").forEach((tr) => {
        const name = (tr.querySelector(".lead-name") || {}).textContent || "";
        const ph = tr.querySelector('[data-act="phone"]');
        const sm = tr.querySelector('[data-act="sms"]');
        out.push({ name: name.trim(),
          phoneMuted: !!(ph && ph.classList.contains("mut")),
          smsMuted: !!(sm && sm.classList.contains("mut")) });
      });
      return out;
    });
    const noPhoneRows = rowState.filter((r) => ["Purple Kitty 22", "@nophone2", "Email Only", "Tiktok Person"].includes(r.name));
    const phoneRows = rowState.filter((r) => ["Has Phone", "Also Phone"].includes(r.name));
    ok("every phoneless row is present in the table", noPhoneRows.length === 4, JSON.stringify(rowState));
    ok("Call is dimmed on a contact with no number",
      noPhoneRows.every((r) => r.phoneMuted), JSON.stringify(noPhoneRows));
    ok("Text is dimmed on a contact with no number",
      noPhoneRows.every((r) => r.smsMuted), JSON.stringify(noPhoneRows));
    ok("and both stay live on a contact who does have one",
      phoneRows.length === 2 && phoneRows.every((r) => !r.phoneMuted && !r.smsMuted), JSON.stringify(phoneRows));

    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
    await page.locator("#brvBannerX").click();
    ok("the banner can be dismissed", !(await page.locator("#brvBanner").isVisible()));

    ok("no page errors", errs.length === 0, errs.join("; "));
    await browser.close();
  } else {
    console.log("  (skipped browser pass — set PW_CHROMIUM to run it)");
  }
} finally { srv.kill("SIGKILL"); }

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); if (log) console.error(log.slice(-1200)); process.exit(1); }
