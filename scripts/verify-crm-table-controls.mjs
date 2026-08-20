#!/usr/bin/env node
/**
 * The CRM lead table's three toolbar engines: Sort By, Columns, and the
 * centered Filter Leads modal.
 *
 * WHAT THIS SUITE IS GUARDING. Each of these can look right and be wrong in a
 * way that costs the team real work:
 *
 *   - A sort field with no data behind it orders every row identically, which
 *     reads exactly like a working sort. Brivity offers 26 fields; this system
 *     genuinely holds ~19 of them, and the rest MUST be refused rather than
 *     silently rank everyone equal.
 *   - Column drag-and-drop that does not actually move the table columns is a
 *     menu that lies about what it did.
 *   - Name must stay the table's anchor — hiding or reordering it away leaves a
 *     grid of values nobody can attribute to a person.
 *   - The Columns popover had a documented double-scrollbar bug; the fix is
 *     structural (one scrolling box) and easy to regress.
 *
 * Usage: PW_CHROMIUM=/path/to/chrome node scripts/verify-crm-table-controls.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "crmtbl-"));
const PORT = 42310 + Math.floor(Math.random() * 200);
const TOKEN = "crm-verify-token";
const B = `http://127.0.0.1:${PORT}`;

let pass = 0; const fail = [];
const ok = (n, c, d) => {
  if (c) { pass++; console.log("  ok " + n); }
  else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); }
};

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT), DASHBOARD_TOKEN: TOKEN,
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    USERS_JSON_PATH: join(tmp, "users.json"), TEAM_JSON_PATH: join(tmp, "team.json"),
    USER_PREFS_PATH: join(tmp, "user-prefs.json"),
    CONTENT_PLANNER_DB_PATH: join(tmp, "p.db"), EMAIL_DB_PATH: join(tmp, "e.db"),
    TRANSACTIONS_DB_PATH: join(tmp, "x.db"), LEAD_SCORES_DB_PATH: join(tmp, "s.db"),
    OUTREACH_DB_PATH: join(tmp, "o.db"), FAVORITES_DB_PATH: join(tmp, "f.db"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));

const until = async (fn, ms = 40000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
};
if (!(await until(async () => (await fetch(B + "/health")).ok))) {
  console.error("server never came up\n" + log.slice(-2000)); process.exit(1);
}

try {
  /* ═══════════ the metrics endpoint the new fields run on ═══════════ */
  {
    ok("lead metrics require the dashboard token", (await fetch(B + "/api/crm/lead-metrics")).status === 401);
    const m = await (await fetch(`${B}/api/crm/lead-metrics?token=${TOKEN}`)).json();
    ok("it returns a lead-keyed map", m && typeof m.metrics === "object");
    ok("and NAMES the fields it has no data for rather than offering them",
      Array.isArray(m.unavailable) && m.unavailable.length >= 6 &&
      m.unavailable.every((u) => u.field && u.label && u.reason),
      JSON.stringify((m.unavailable || []).map((u) => u.field)));
    const fields = (m.unavailable || []).map((u) => u.field);
    ok("the website-behaviour fields are the ones declared unavailable",
      ["lastVisit", "visits", "views", "avgViewPrice", "lastViewed", "homeApp"].every((f) => fields.includes(f)),
      JSON.stringify(fields));
    ok("each carries a reason a person could act on",
      (m.unavailable || []).every((u) => /tracking|history|app|CMA/i.test(u.reason)));
  }

  /* ═══════════ the real page in a real browser ═══════════ */
  {
    const { chromium } = await import("playwright");
    const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    const page = await br.newPage({ viewport: { width: 1680, height: 1000 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    await page.goto(`${B}/crm?token=${TOKEN}`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(1200);
    // The CRM opens on the dashboard; the lead table lives behind the Leads rail.
    await page.click('.r[data-view="leads"]');
    await page.waitForSelector("#view-leads.on", { timeout: 20000 });
    await page.waitForSelector("#leadRows tr", { state: "visible", timeout: 25000 });
    await page.waitForTimeout(900);
    ok("the CRM loads with no script errors", errs.length === 0, errs.slice(0, 3).join(" | "));

    const sortBtn = '#view-leads .leads-top .pill-btn.ghost:nth-child(3)';

    /* ── Sort By popover ── */
    {
      ok("the toolbar names the active sort field",
        /^SORT BY:/.test((await page.locator(sortBtn).innerText()).trim()),
        await page.locator(sortBtn).innerText());

      await page.click(sortBtn);
      await page.waitForTimeout(400);
      ok("clicking it opens a popover card, not a plain list",
        await page.locator("#sortPop.on").isVisible());
      ok("with a field selector, a direction selector and a SAVE button",
        (await page.locator("#sortPop #spField").count()) === 1 &&
        (await page.locator("#sortPop #spDir").count()) === 1 &&
        (await page.locator("#sortPop #spSave").count()) === 1);

      const opts = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#spField option")).map((o) => ({ v: o.value, t: o.textContent, dis: o.disabled })));
      ok("all 26 Brivity sort fields are listed", opts.length === 28, String(opts.length));
      ok("including the ones this system cannot answer", opts.some((o) => o.dis));
      ok("and those are DISABLED with 'no data' on the label, not silently broken",
        opts.filter((o) => o.dis).every((o) => /no data/.test(o.t)),
        JSON.stringify(opts.filter((o) => o.dis).map((o) => o.t)));
      ok("the website-behaviour fields are exactly the disabled ones",
        opts.filter((o) => o.dis).map((o) => o.v).sort().join(",") ===
          ["avg_view_price", "home_app", "last_viewed", "last_visit", "views", "visits"].sort().join(","),
        opts.filter((o) => o.dis).map((o) => o.v).join(","));
      ok("the field list has its own fixed viewport rather than growing the card",
        await page.evaluate(() => {
          const el = document.getElementById("spField");
          return el.getBoundingClientRect().height <= 245;
        }));

      /* Selecting re-sorts immediately. */
      const before = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#leadRows tr .lead-name")).slice(0, 6).map((n) => n.textContent));
      await page.selectOption("#spField", "last_name");
      await page.waitForTimeout(700);
      const after = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#leadRows tr .lead-name")).slice(0, 6).map((n) => n.textContent));
      ok("choosing a field re-orders the table immediately", before.join("|") !== after.join("|"),
        JSON.stringify([before[0], after[0]]));
      const lastNames = after.map((n) => (n || "").trim().split(/\s+/).slice(-1)[0].toLowerCase());
      ok("and it really is sorted by that field",
        lastNames.every((v, i) => i === 0 || lastNames[i - 1] <= v), JSON.stringify(lastNames));

      await page.selectOption("#spDir", "-1");
      await page.waitForTimeout(700);
      const desc = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#leadRows tr .lead-name")).slice(0, 6)
          .map((n) => (n.textContent || "").trim().split(/\s+/).slice(-1)[0].toLowerCase()));
      ok("switching to descending reverses it",
        desc.every((v, i) => i === 0 || desc[i - 1] >= v), JSON.stringify(desc));

      /* Immediate ≠ saved: SAVE is what makes it the default. */
      const savedBefore = await (await fetch(`${B}/api/settings/table-prefs?user=team&token=${TOKEN}`)).json();
      ok("trying an order does NOT quietly change everyone's default",
        !savedBefore.tables || !savedBefore.tables.leads || savedBefore.tables.leads.sortField !== "last_name",
        JSON.stringify(savedBefore.tables && savedBefore.tables.leads));
      await page.click("#spSave");
      await page.waitForTimeout(900);
      const savedAfter = await (await fetch(`${B}/api/settings/table-prefs?user=team&token=${TOKEN}`)).json();
      ok("SAVE persists the field and direction as the default",
        savedAfter.tables && savedAfter.tables.leads &&
        savedAfter.tables.leads.sortField === "last_name" && savedAfter.tables.leads.sortDir === -1,
        JSON.stringify(savedAfter.tables && savedAfter.tables.leads));
      ok("and the popover closes on save", !(await page.locator("#sortPop.on").isVisible()));

      /* A disabled field cannot be forced through. */
      await page.click(sortBtn);
      await page.waitForTimeout(300);
      const refused = await page.evaluate(() => {
        const sel = document.getElementById("spField");
        sel.value = "visits";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return sel.value;
      });
      await page.waitForTimeout(400);
      ok("a field with no data behind it is REFUSED, not accepted",
        refused !== "visits", refused);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      ok("Escape closes the popover", !(await page.locator("#sortPop.on").isVisible()));
    }

    /* ── Columns picker ── */
    {
      const colsBtn = '#view-leads .leads-top .pill-btn.ghost:nth-child(2)';
      await page.click(colsBtn);
      await page.waitForTimeout(500);
      ok("the Columns picker opens", await page.locator("#ddMenu.colpop").isVisible());

      /* THE DOUBLE-SCROLLBAR FIX. */
      const scroll = await page.evaluate(() => {
        const pop = document.getElementById("ddMenu");
        const list = pop.querySelector(".cp-list");
        const cs = getComputedStyle(pop), ls = getComputedStyle(list);
        return { popOverflow: cs.overflow, popY: cs.overflowY, listY: ls.overflowY,
                 popScrolls: pop.scrollHeight > pop.clientHeight + 2,
                 listScrolls: list.scrollHeight > list.clientHeight + 2 };
      });
      ok("ONLY ONE BOX SCROLLS — the popover wrapper is overflow:hidden",
        scroll.popOverflow.startsWith("hidden") && scroll.listY === "auto", JSON.stringify(scroll));
      ok("and the wrapper itself has nothing to scroll", !scroll.popScrolls, JSON.stringify(scroll));

      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".cp-row")).map((r) => ({
          key: r.getAttribute("data-key"),
          locked: r.classList.contains("locked"),
          draggable: r.getAttribute("draggable") === "true",
          grip: getComputedStyle(r.querySelector(".cp-grip")).visibility,
          disabled: r.querySelector("input").disabled,
          checked: r.querySelector("input").checked,
        })));
      ok("every column in the table is listed", rows.length >= 20, String(rows.length));
      const name = rows.find((r) => r.key === "name");
      ok("Name is locked as the anchor column",
        name && name.locked && !name.draggable && name.disabled && name.checked, JSON.stringify(name));
      ok("and carries no drag handle", name && name.grip === "hidden", name && name.grip);
      const sel = rows[0];
      ok("the row-select column is locked too — it is not a column of data",
        sel && sel.locked && !sel.draggable, JSON.stringify(sel));
      ok("and it is named rather than showing up as a column called 'col'",
        await page.evaluate(() => {
          const r = document.querySelector(".cp-row");
          return (r.querySelector(".cp-name").textContent || "").trim();
        }) === "Select rows");
      ok("every real data column has a six-dot grip and is draggable",
        rows.filter((r) => !r.locked).every((r) => r.draggable && r.grip !== "hidden"),
        JSON.stringify(rows.filter((r) => !r.locked && (!r.draggable || r.grip === "hidden")).map((r) => r.key)));

      /* Drag really reorders the table, not just the menu. */
      const headBefore = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#view-leads table.leads thead th")).map((t) => t.textContent.replace(/[⇅▲▼]/g, "").trim()));
      const moved = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll(".cp-row"));
        const src = rows.find((r) => r.getAttribute("data-key") === "source");
        const target = rows.find((r) => r.getAttribute("data-key") === "intent");
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        const box = target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: box.top + 2 }));
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: box.top + 2 }));
        src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        return true;
      });
      await page.waitForTimeout(900);
      const headAfter = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#view-leads table.leads thead th")).map((t) => t.textContent.replace(/[⇅▲▼]/g, "").trim()));
      ok("DROPPING A ROW REORDERS THE ACTUAL TABLE COLUMNS",
        headBefore.join("|") !== headAfter.join("|"), JSON.stringify([headBefore.slice(0, 5), headAfter.slice(0, 5)]));
      ok("Source moved ahead of Intent, where it was dropped",
        headAfter.indexOf("Source") < headAfter.indexOf("Intent"),
        JSON.stringify(headAfter.slice(0, 6)));
      ok("and Name is still the anchor after the move",
        headAfter[1] === "Name", JSON.stringify(headAfter.slice(0, 3)));

      const savedCols = await (await fetch(`${B}/api/settings/table-prefs?user=team&token=${TOKEN}`)).json();
      ok("the new order is auto-saved to the user's preferences",
        savedCols.tables.leads.order && savedCols.tables.leads.order.indexOf("source") < savedCols.tables.leads.order.indexOf("intent"),
        JSON.stringify(savedCols.tables.leads.order && savedCols.tables.leads.order.slice(0, 6)));

      /* Visibility toggles mount/unmount without a refresh. */
      const visBefore = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#view-leads table.leads thead th")).filter((t) => getComputedStyle(t).display !== "none").length);
      await page.evaluate(() => {
        const cb = document.querySelector('.cp-row[data-key="stage"] input');
        cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(800);
      const visAfter = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#view-leads table.leads thead th")).filter((t) => getComputedStyle(t).display !== "none").length);
      ok("unchecking a column hides it immediately", visAfter === visBefore - 1, JSON.stringify([visBefore, visAfter]));

      /* The engagement columns exist but arrive hidden. */
      const engaged = await page.evaluate(() =>
        ["hot_score", "favorites", "avg_fav_price", "listing_alerts", "market_reports", "last_sent", "tag"]
          .map((k) => !!document.querySelector(`.cp-row[data-key="${k}"]`)));
      ok("the engagement columns are offered in the picker", engaged.every(Boolean), JSON.stringify(engaged));
      await page.keyboard.press("Escape");
      await page.click("body", { position: { x: 5, y: 5 } });
      await page.waitForTimeout(400);
    }

    /* ── the centered Filter Leads modal ── */
    {
      await page.click("#lFilterBtn");
      await page.waitForTimeout(700);
      const shell = await page.evaluate(() => {
        const scrim = document.getElementById("afScrim"), modal = document.getElementById("afDrawer");
        const cs = getComputedStyle(scrim), ms = modal.getBoundingClientRect();
        return { display: cs.display, bg: cs.backgroundColor, align: cs.alignItems,
                 centeredX: Math.abs((ms.left + ms.right) / 2 - window.innerWidth / 2) < 30,
                 hasNav: !!document.querySelector("#afNav .nv-p") };
      });
      ok("the filter opens as a CENTERED modal, not a side drawer",
        shell.display === "flex" && shell.centeredX, JSON.stringify(shell));
      ok("over a semi-transparent dark backdrop",
        shell.bg === "rgba(0, 0, 0, 0.5)", shell.bg);
      ok("with a left-hand category tree", shell.hasNav);

      const nav = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#afNav .nv-p")).map((b) => b.textContent.replace("›", "").trim()));
      ok("the tree lists every filter section",
        nav.includes("General") && nav.includes("Tags") && nav.includes("Auto Plans") &&
        nav.includes("Reports") && nav.includes("Web Activity") && nav.includes("Dates"),
        JSON.stringify(nav));
      ok("and it is built FROM the sections, so the two cannot drift",
        nav.length === (await page.evaluate(() => document.querySelectorAll("#afBody .afg").length)),
        String(nav.length));
      ok("each section has sub-entries for its own fields",
        (await page.locator("#afNav .nv-s").count()) >= 6);

      /* Click left → the right pane scrolls to it. */
      const scrolled = await page.evaluate(async () => {
        const body = document.getElementById("afBody");
        body.scrollTop = 0;
        const btn = Array.from(document.querySelectorAll("#afNav .nv-p")).find((b) => /Dates/.test(b.textContent));
        btn.click();
        await new Promise((r) => setTimeout(r, 800));
        return body.scrollTop;
      });
      ok("CLICKING A CATEGORY SCROLLS THE FORM TO IT", scrolled > 50, String(scrolled));

      /* Scroll right → the left highlights. */
      const synced = await page.evaluate(async () => {
        const body = document.getElementById("afBody");
        body.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 500));
        const top = document.querySelector("#afNav .nv-p.cur");
        return top ? top.textContent.replace("›", "").trim() : null;
      });
      ok("scrolling the form highlights the matching category on the left",
        synced === "General", String(synced));

      /* The Reports group is new and runs on real subscription counts. */
      ok("a Reports section filters on listing alerts and market reports",
        (await page.locator('#afBody [data-afalerts]').count()) === 3 &&
        (await page.locator('#afBody [data-afreports]').count()) === 3);
      ok("Web Activity is still shown but disabled, with the reason",
        await page.evaluate(() => {
          const g = document.getElementById("af-sec-WebActivity");
          return !!g && g.classList.contains("nodata") && /not connected/i.test(g.textContent);
        }));
      ok("Lead Type means record completeness, and says so",
        await page.evaluate(() => /Complete = has a name and at least one of phone or email/i
          .test(document.getElementById("af-sec-General").textContent)));

      ok("the footer offers Cancel and Apply", (await page.locator("#afCancel").count()) === 1 && (await page.locator("#afApply").count()) === 1);
      await page.click("#afCancel");
      await page.waitForTimeout(400);
      ok("Cancel closes it without applying", !(await page.locator("#afScrim.on").isVisible()));
    }

    ok("no script errors across the whole run", errs.length === 0, errs.slice(0, 4).join(" | "));
    await br.close();
  }
} catch (err) {
  fail.push("suite threw: " + (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
  console.error(err);
} finally {
  srv.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.error(" ✗ " + f)); process.exit(1); }
