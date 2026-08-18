#!/usr/bin/env node
/**
 * Harvey Browser Control — the real extension, in a real Chrome.
 *
 * This suite exists because the extension's README described capabilities the
 * code did not have, and nothing caught it: "sees through open shadow roots",
 * "scrolls to pull in lazy-loaded results". An audit against real pages found
 * that a plain read saw NO shadow content (and on a script-heavy body handed
 * back the SCRIPT SOURCE as page text), cross-origin frames were invisible and
 * unmentioned, and scrolling a page whose results live in an inner pane did
 * nothing at all while reporting `ok: true, "scrolled to bottom"`.
 *
 * So every check here drives the actual `background.js` inside Chromium with
 * the extension loaded — no mocks of the thing under test. A claim in the
 * README that no test here exercises is a claim to distrust.
 *
 * Usage: PW_CHROMIUM=/path/to/chrome node scripts/verify-browser-extension.mjs
 */
import { chromium } from "playwright";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const FIX = join(process.cwd(), "scripts/fixtures/extension");
const EXT = join(process.cwd(), "public/extension");
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

/* Two origins, so the cross-origin frame test is genuinely cross-origin. */
const PORT_A = 8811, PORT_B = 8812;
function serve(port) {
  return new Promise((res) => {
    const s = http.createServer((req, rq) => {
      const f = req.url.split("?")[0];
      try {
        let body = readFileSync(join(FIX, f.slice(1)), "utf8");
        body = body.replace("CROSS_ORIGIN_URL", `http://127.0.0.1:${PORT_B}/frame-inner.html`);
        rq.writeHead(200, { "content-type": "text/html" });
        rq.end(body);
      } catch { rq.writeHead(404); rq.end("not found"); }
    });
    s.listen(port, "127.0.0.1", () => res(s));
  });
}
const sA = await serve(PORT_A), sB = await serve(PORT_B);
const U = (f) => `http://127.0.0.1:${PORT_A}/${f}`;

const profile = mkdtempSync(join(tmpdir(), "harvey-ext-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.PW_CHROMIUM,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 });

/** Open a page and hand its tabId to a function evaluated in the worker. */
async function onPage(url, fn, arg) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  const out = await sw.evaluate(fn, [tabId, arg]);
  return { out, page, tabId };
}
const inject = (tabId, fnName, args) => sw.evaluate(async ([id, name, a]) => {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: id }, func: self[name], args: [a || {}], world: "MAIN",
  });
  return r?.result;
}, [tabId, fnName, args]);

try {
  ok("the extension's service worker is running", Boolean(sw && sw.url().endsWith("background.js")));

  // ── READ: shadow DOM ─────────────────────────────────────────────────────
  {
    const { out, page } = await onPage(U("shadow.html"), async ([tabId]) => {
      const r = await readWholeTab(tabId, {});
      return { data: r.data, ok: r.ok };
    });
    ok("read sees inside an open shadow root", out.data.includes("$427,500") && out.data.includes("Gunsight Pass"), out.data.slice(0, 120));
    /* The old version returned the page's <script> source as if it were copy.
       That is worse than missing the content: it is fabricated page text. */
    ok("read does NOT hand back <script> source as page text", !out.data.includes("attachShadow"), out.data.slice(0, 120));
    await page.close();
  }

  // ── READ: cross-origin iframe ────────────────────────────────────────────
  {
    const { out, page } = await onPage(U("crossframe.html"), async ([tabId]) => {
      const r = await readWholeTab(tabId, {});
      return { data: r.data, frames: r.frames, embedded: r.embeddedFrames };
    });
    ok("read reaches into a CROSS-ORIGIN iframe", out.data.includes("$512,000") && out.data.includes("HOA dues"), out.data.slice(0, 160));
    ok("and labels which frame the text came from", (out.embedded || []).length === 1 && /frame-inner/.test(out.embedded[0]), JSON.stringify(out.embedded));
    ok("the frame count is reported", out.frames >= 2, String(out.frames));
    await page.close();
  }

  // ── READ: paging a long page ─────────────────────────────────────────────
  {
    const { out, page } = await onPage(U("longpage.html"), async ([tabId]) => {
      let r = await readWholeTab(tabId, {});
      const first = { len: r.data.length, total: r.totalLength, next: r.nextOffset, truncated: r.truncated };
      let guard = 0, found = r.data.includes("THE-END-MARKER");
      while (r.nextOffset && guard++ < 20 && !found) {
        r = await readWholeTab(tabId, { offset: r.nextOffset });
        found = r.data.includes("THE-END-MARKER");
      }
      return { ...first, pages: guard, found, lastNext: r.nextOffset };
    });
    ok("a long page reports it was truncated", out.truncated === true);
    ok("and hands back a usable nextOffset", typeof out.next === "number" && out.next > 0, String(out.next));
    ok("paging with offset REACHES the end of the page", out.found === true, JSON.stringify(out));
    ok("the final page has no nextOffset", out.lastNext === null, String(out.lastNext));
    await page.close();
  }

  // ── SCROLL: the bug that was reported ────────────────────────────────────
  {
    const page = await ctx.newPage();
    await page.goto(U("inner-scroll.html"), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
    const before = await page.evaluate(() => document.querySelectorAll(".row").length);
    const r = await inject(tabId, "pageScroll", {});
    const after = await page.evaluate(() => document.querySelectorAll(".row").length);
    ok("scrolling an INNER pane actually loads more rows", after > before, `${before} → ${after}`);
    ok("it names the container it scrolled", r.container === "inner pane", JSON.stringify(r.container));
    ok("it reports that content grew, so a re-read is warranted", r.grewBy > 0 && /grew/.test(r.data), JSON.stringify(r).slice(0, 160));
    await page.close();
  }
  {
    /* The other half of honesty: a page that cannot scroll must SAY so rather
       than claim success, or Harvey reads page one and calls it the full set. */
    const { out, page } = await onPage(U("shadow.html"), async ([tabId]) => {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageScroll, args: [{}], world: "MAIN" });
      return r.result;
    });
    ok("a page with nothing to scroll says so instead of faking success",
      out.scrolled === false && /Nothing on this page scrolls/.test(out.data), JSON.stringify(out));
    await page.close();
  }

  // ── SAFETY: sensitive fields ─────────────────────────────────────────────
  {
    const page = await ctx.newPage();
    await page.goto(U("sensitive.html"), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
    const r = await inject(tabId, "pageFill", { fields: {
      "#name": "Marco Puga", "#email": "m@example.com",
      "#card": "4111111111111111", "#cvv": "123", "#ssn": "123-45-6789", "#pw": "hunter2",
    } });
    /* pageFill nests its report under `data` — filled/refused/missing. */
    const rep = (r && r.data) || {};
    const refusedText = (rep.refused || []).join(" | ");
    ok("an ordinary field is filled", (rep.filled || []).some((f) => String(f).includes("#name")), JSON.stringify(rep.filled));
    ok("a credit-card number is REFUSED", /#card/.test(refusedText), refusedText);
    ok("a CVV is REFUSED", /#cvv/.test(refusedText), refusedText);
    ok("an SSN is REFUSED", /#ssn/.test(refusedText), refusedText);
    ok("a password is REFUSED", /#pw/.test(refusedText), refusedText);
    ok("the refusal says it is Harvey's rule, not a browser limit", /safety rule/.test(refusedText), refusedText.slice(0, 160));
    const onPageValues = await page.evaluate(() => ({
      card: document.querySelector("#card").value,
      cvv: document.querySelector("#cvv").value,
      ssn: document.querySelector("#ssn").value,
      pw: document.querySelector("#pw").value,
      name: document.querySelector("#name").value,
    }));
    ok("and NOTHING was actually typed into those fields",
      !onPageValues.card && !onPageValues.cvv && !onPageValues.ssn && !onPageValues.pw,
      JSON.stringify(onPageValues));
    ok("while the ordinary field really did get its value", onPageValues.name === "Marco Puga", onPageValues.name);
    await page.close();
  }

  // ── SAFETY: site gate ────────────────────────────────────────────────────
  {
    const g = await sw.evaluate(async () => ({
      adult: await guard("navigate", "https://www.pornhub.com/x"),
      piracy: await guard("navigate", "https://thepiratebay.org/"),
      bankRead: await guard("read", "https://www.chase.com/accounts"),
      bankClick: await guard("click", "https://www.chase.com/accounts"),
      normal: await guard("click", "https://www.har.com/listing/1"),
    }));
    ok("adult sites are blocked outright", g.adult.blocked === true, JSON.stringify(g.adult).slice(0, 120));
    ok("piracy sites are blocked outright", g.piracy.blocked === true);
    ok("a financial site can still be READ", g.bankRead.blocked === false, JSON.stringify(g.bankRead));
    ok("but acting on one needs explicit permission first", g.bankClick.blocked === true && g.bankClick.needsGrant === "www.chase.com", JSON.stringify(g.bankClick).slice(0, 160));
    ok("an ordinary site is unaffected", g.normal.blocked === false);

    const after = await sw.evaluate(async () => {
      await grantSite("https://www.chase.com/accounts");
      return await guard("click", "https://www.chase.com/accounts");
    });
    ok("once granted, that host is allowed", after.blocked === false, JSON.stringify(after));
    const other = await sw.evaluate(async () => await guard("click", "https://www.wellsfargo.com/x"));
    ok("and the grant does NOT leak to another bank", other.blocked === true, JSON.stringify(other).slice(0, 120));
  }

  // ── SAFETY: CAPTCHA is reported, never solved ────────────────────────────
  {
    const { out, page } = await onPage(U("captcha.html"), async ([tabId]) => {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageCaptcha, args: [], world: "MAIN" });
      return r.result;
    });
    ok("a CAPTCHA page is detected", out === true, String(out));
    await page.close();
  }
  {
    const { out, page } = await onPage(U("shadow.html"), async ([tabId]) => {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageCaptcha, args: [], world: "MAIN" });
      return r.result;
    });
    ok("an ordinary page is not mistaken for one", out === false, String(out));
    await page.close();
  }

  // ── MULTI-TAB ────────────────────────────────────────────────────────────
  {
    const res = await sw.evaluate(async ([_, urls]) => {
      await chrome.storage.local.set({ harveyTabIds: [] });
      const a = await openAdditionalTab(urls[0], false);
      const b = await openAdditionalTab(urls[1], false);
      const list = await listWorkTabs();
      return { opened: [a.id, b.id], count: list.length, urls: list.map((t) => t.url) };
    }, [null, [U("shadow.html"), U("longpage.html")]]);
    ok("Harvey can hold SEVERAL tabs at once", res.count === 2, JSON.stringify(res));
    ok("and both are the ones he opened", res.urls.filter(Boolean).length === 2, JSON.stringify(res.urls));

    const grouped = await sw.evaluate(async () => {
      const tabs = await listWorkTabs();
      if (!chrome.tabGroups) return { supported: false };
      const t = await chrome.tabs.get(tabs[0].id);
      if (t.groupId == null || t.groupId < 0) return { supported: true, grouped: false };
      const g = await chrome.tabGroups.get(t.groupId);
      return { supported: true, grouped: true, title: g.title, color: g.color };
    });
    if (grouped.supported && grouped.grouped) {
      ok("his tabs are collected into a named group", grouped.title === "Harvey", JSON.stringify(grouped));
      ok("and it is colour-coded so they are visibly his", grouped.color === "cyan", JSON.stringify(grouped));
    } else {
      /* Grouping is cosmetic and must never be load-bearing. */
      ok("tab grouping is best-effort and did not break the tabs", res.count === 2, JSON.stringify(grouped));
    }

    const closed = await sw.evaluate(async () => {
      const r = await closeWorkTabs();
      return { r, left: (await listWorkTabs()).length };
    });
    ok("closing tidies up every tab he opened", closed.left === 0, JSON.stringify(closed));
  }

  // ── CONSOLE / page errors ────────────────────────────────────────────────
  {
    const page = await ctx.newPage();
    const tabId = await (async () => {
      await page.goto(U("errors.html"), { waitUntil: "domcontentloaded" });
      return sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
    })();
    await sw.evaluate(async ([id]) => await installErrorRecorder(id), [tabId]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await sw.evaluate(async ([id]) => await installErrorRecorder(id), [tabId]);
    await page.waitForTimeout(900);
    const errs = await inject(tabId, "harveyReadErrors", {});
    ok("page errors are captured for diagnosis",
      Array.isArray(errs) && errs.some((e) => /checkout service unavailable/.test(e)),
      JSON.stringify(errs).slice(0, 200));
    await page.close();
  }

  ok("the extension version was bumped for this change",
    JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).version !== "1.6.2");
} finally {
  await ctx.close();
  sA.close(); sB.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:\n - " + fail.join("\n - ")); process.exit(1); }
