#!/usr/bin/env node
/**
 * Where the calendar lives.
 *
 * The Content Calendar moved into the app shell's main sidebar and the
 * Content Manager's own Calendar tab was removed with it — one calendar, one
 * place. Deleting a tab from a 8,000-line single-file page is the kind of
 * change that looks fine and quietly breaks something two tabs over, so this
 * suite drives the real pages in a real browser and checks the three things
 * that could actually have gone wrong:
 *
 *   - the new tab is in the sidebar AND actually loads the planner in it
 *   - every REMAINING Content Manager tab still opens, with no script errors
 *     (the removal took ~200 lines of JS out of a shared scope)
 *   - the 861-video sprint pace, which lived only in the deleted view, is
 *     still on screen — removing a tab must not silently remove a number the
 *     whole content operation is run against
 *
 * Usage: PW_CHROMIUM=/path/to/chrome node scripts/verify-content-nav.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "nav-"));
const PORT = 42310 + Math.floor(Math.random() * 200);
const B = `http://127.0.0.1:${PORT}`;
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT),
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "t.json"),
    USERS_JSON_PATH: join(tmp, "u.json"), TEAM_JSON_PATH: join(tmp, "team.json"),
    CONTENT_PLANNER_DB_PATH: join(tmp, "p.db"), EMAIL_DB_PATH: join(tmp, "e.db"),
    TRANSACTIONS_DB_PATH: join(tmp, "x.db") },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 250)); } };
if (!(await until(async () => (await fetch(B + "/health")).ok))) { console.error("no server\n" + log.slice(-2000)); process.exit(1); }

try {
  const { chromium } = await import("playwright");
  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});

  /* ── the app shell ── */
  {
    const page = await br.newPage({ viewport: { width: 1500, height: 1000 } });
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    // The shell bounces to the team picker until somebody is chosen, so the
    // suite signs in the way a person does rather than faking the storage key.
    await page.goto(B + "/who?next=%2Fshell", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".who", { timeout: 15000 });
    await page.locator(".who").first().click();
    await page.waitForSelector("#nav .nav-item", { timeout: 15000 });
    await page.waitForTimeout(900);

    const labels = await page.locator("#nav .nav-item .tx .l").allInnerTexts();
    ok("Content Calendar is in the main sidebar", labels.includes("Content Calendar"), JSON.stringify(labels));
    ok("it sits right after Content Manager",
      labels.indexOf("Content Calendar") === labels.indexOf("Content Manager") + 1, JSON.stringify(labels));
    ok("the Content Manager tab is untouched", labels.includes("Content Manager"));
    ok("no sidebar page errors", errs.length === 0, errs.slice(0, 2).join(" | "));

    await page.click('#nav .nav-item[data-key="calendar"]');
    await page.waitForTimeout(2500);
    const frameSrc = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe")).map((f) => f.getAttribute("src")));
    ok("clicking it loads /content-planner in the shell",
      frameSrc.some((s) => s && s.startsWith("/content-planner")), JSON.stringify(frameSrc));
    const planner = page.frames().find((f) => f.url().includes("/content-planner"));
    ok("the planner actually renders inside the shell frame",
      planner ? (await planner.locator(".date-cell").count()) === 42 : false);
    ok("still no page errors after opening it", errs.length === 0, errs.slice(0, 2).join(" | "));
    await page.close();
  }

  /* ── the Content Manager, after the removal ── */
  {
    const page = await br.newPage({ viewport: { width: 1500, height: 1000 } });
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    await page.goto(B + "/social", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".crm-side-btn[data-cm-section]", { timeout: 15000 });
    await page.waitForTimeout(2500);

    const sections = await page.locator(".crm-side-btn[data-cm-section]").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-cm-section")));
    ok("the Content Manager no longer has a Calendar tab", !sections.includes("calendar"), JSON.stringify(sections));
    ok("its other tabs are all still there",
      ["overview", "brain", "recording", "strategy", "upload", "review", "publishing", "analytics", "activity"]
        .every((s) => sections.includes(s)), JSON.stringify(sections));
    ok("the calendar section markup is gone",
      (await page.locator("#cm-section-calendar").count()) === 0);

    ok("the 861-video sprint pace survived the removal, on Overview",
      /\/ 861 videos/.test(await page.locator("#calendar-sprint-label").innerText()),
      await page.locator("#calendar-sprint-label").innerText());
    ok("the sprint bar renders a real width",
      /%$/.test(await page.locator("#calendar-sprint-fill").evaluate((e) => e.style.width || "")),
      await page.locator("#calendar-sprint-fill").evaluate((e) => e.style.width));
    ok("Overview points at where the calendar went",
      (await page.locator('a[href="/content-planner"]').count()) >= 1);

    /* every remaining tab must still open — the JS removal could have thrown */
    for (const s of ["publishing", "review", "strategy", "recording", "analytics", "activity", "overview"]) {
      await page.click(`.crm-side-btn[data-cm-section="${s}"]`);
      await page.waitForTimeout(500);
      const active = await page.locator(`#cm-section-${s}.active`).count();
      ok(`the ${s} tab still opens`, active === 1);
    }
    ok("no script errors anywhere in the Content Manager", errs.length === 0, errs.slice(0, 3).join(" | "));
    await page.close();
  }

  /* ── the dashboard card ── */
  {
    const page = await br.newPage({ viewport: { width: 1500, height: 1000 } });
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    // /dashboard redirects into the shell unless it is being embedded.
    await page.goto(B + "/dashboard?embed=1", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    ok("the main dashboard has a Content Calendar card",
      (await page.locator("#open-content-planner").count()) === 1);
    ok("and it links to the planner",
      (await page.locator("#open-content-planner").getAttribute("href")) === "/content-planner");
    ok("no dashboard page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
    await page.close();
  }

  await br.close();
} catch (e) {
  fail.push("suite threw: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
  console.error(e);
} finally {
  srv.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.error(" ✗ " + f)); process.exit(1); }
