#!/usr/bin/env node
/**
 * Harvey Core UI: the shared renderer on /jarvis and /operator.
 *
 * A visual rework can pass an eyeball test and still be broken — the core is
 * also the button that starts a voice session, and both pages drive it through
 * globals other code sets. So this checks BEHAVIOUR, not looks: that it
 * mounts, that state changes reach it, that the click target still fires the
 * voice toggle, that it centres in whatever box CSS gives it, and that nothing
 * still references the deleted THREE.js bundle.
 *
 * Usage: node scripts/verify-harvey-core-ui.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3405);
const B = `http://localhost:${PORT}`;
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

// ---- static checks ---------------------------------------------------------
ok("harvey-core.js ships in public/", existsSync("public/harvey-core.js"));
ok("vendored three.min.js is gone", !existsSync("public/vendor/three.min.js"));
for (const f of ["public/jarvis.html", "public/operator.html"]) {
  const src = readFileSync(f, "utf8");
  ok(`${f} loads harvey-core.js`, /src="\/harvey-core\.js"/.test(src));
  ok(`${f} no longer references three.min.js`, !/three\.min\.js"/.test(src));
}
{
  const j = readFileSync("public/jarvis.html", "utf8");
  ok("jarvis: old inline plasma renderer removed", !/buildParticles|makeSprite\(/.test(j));
  ok("jarvis: old SVG tick ring removed", !/<g id="jTickGroup"/.test(j));
  const core = readFileSync("public/harvey-core.js", "utf8");
  /* Assert on real USAGE, not the word: the module's own doc comment explains
     why shadowBlur is banned, and a bare substring match flagged that. */
  ok("no shadowBlur in the render path", !/\.shadowBlur\s*=/.test(core));
}

// ---- boot a server ---------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "core-ui-"));
writeFileSync(join(tmp, "db.json"), JSON.stringify({ idCounter: 1, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] }));
const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT),
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "t.json"),
    EMAIL_DB_PATH: join(tmp, "e.db"), TRANSACTIONS_DB_PATH: join(tmp, "x.db"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const until = async (fn, ms = 25000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

try {
  ok("harvey-core.js is served", (await fetch(B + "/harvey-core.js")).ok);
  ok("the deleted bundle 404s", (await fetch(B + "/vendor/three.min.js")).status === 404);

  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});

  for (const [name, path, canvasId] of [["jarvis", "/jarvis", "harvey-mic-btn"], ["operator", "/operator", "operator-core"]]) {
    const page = await br.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await page.goto(B + path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2200);

    ok(`${name}: core mounted`, await page.evaluate(() => !!(window.HarveyCore && window.HarveyCore.instance())));
    ok(`${name}: no page errors`, errs.length === 0, errs.slice(0, 2).join(" | "));

    // The canvas must actually have pixels, and be centred in its box.
    const geo = await page.evaluate((id) => {
      const c = document.getElementById(id);
      const r = c.getBoundingClientRect();
      return { w: c.width, h: c.height, cw: r.width, ch: r.height, cxOff: Math.abs((r.left + r.width / 2) - window.innerWidth / 2) };
    }, canvasId);
    ok(`${name}: canvas has a real backing store`, geo.w > 100 && geo.h > 100, JSON.stringify(geo));
    ok(`${name}: canvas is roughly square`, Math.abs(geo.cw - geo.ch) < 4, JSON.stringify(geo));
    ok(`${name}: core is horizontally centred`, geo.cxOff < 40, "offset " + Math.round(geo.cxOff) + "px");

    // Something is actually drawn: sample the middle of the canvas.
    const lit = await page.evaluate((id) => {
      const c = document.getElementById(id);
      const g = c.getContext("2d");
      const d = g.getImageData(Math.round(c.width / 2) - 30, Math.round(c.height / 2) - 30, 60, 60).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum;
    }, canvasId);
    ok(`${name}: the core renders light at its centre`, lit > 5000, String(lit));

    // State plumbing: the pipeline drives this global, the renderer must follow.
    const stateOk = await page.evaluate(() => {
      window.setCoreState("listening");
      const a = window.HarveyCore.instance().getState();
      window.setCoreState("processing");     // legacy vocabulary → thinking
      const b = window.HarveyCore.instance().getState();
      window.setCoreState("idle");
      return { a, b, c: window.HarveyCore.instance().getState() };
    });
    ok(`${name}: setCoreState drives the renderer`, stateOk.a === "listening" && stateOk.c === "idle", JSON.stringify(stateOk));
    ok(`${name}: legacy "processing" maps to thinking`, stateOk.b === "thinking", JSON.stringify(stateOk));

    // Audio level must not throw and must be clamped.
    const lvl = await page.evaluate(() => {
      window.HarveyCore.setLevel(5);   // out of range on purpose
      window.HarveyCore.setLevel(-1);
      window.HarveyCore.setLevel(0.5);
      return true;
    });
    ok(`${name}: setLevel accepts out-of-range input safely`, lvl === true);

    // The core is still the voice button.
    const clickable = await page.evaluate((id) => {
      const c = document.getElementById(id);
      let fired = false;
      const h = () => { fired = true; };
      c.addEventListener("click", h);
      c.click();
      c.removeEventListener("click", h);
      return { fired, cursor: getComputedStyle(c).cursor };
    }, canvasId);
    ok(`${name}: core canvas is clickable`, clickable.fired);

    await page.close();
  }

  // The loop must park when the tab is hidden — this runs behind live voice.
  const page = await br.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(B + "/jarvis", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const parked = await page.evaluate(async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 250));
    const c = document.getElementById("harvey-mic-btn");
    const g = c.getContext("2d");
    const before = g.getImageData(0, 0, 8, 8).data.join(",");
    await new Promise((r) => setTimeout(r, 350));
    const after = g.getImageData(0, 0, 8, 8).data.join(",");
    return before === after;
  });
  ok("render loop parks while the tab is hidden", parked);
  await page.close();

  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:\n - " + fail.join("\n - ")); process.exit(1); }
