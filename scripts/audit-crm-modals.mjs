#!/usr/bin/env node
/**
 * Forensic audit of every popup in the CRM.
 *
 * WHAT IT IS LOOKING FOR. The reported symptom is a popup that opens "on the
 * backend" — it exists in the DOM, it is display:block, every test that asks
 * "did the modal open?" says yes, and the operator cannot see or click it
 * because something else is painted on top. A visibility assertion cannot catch
 * that. Only a hit test can.
 *
 * So for every overlay this finds, it asks the question the operator is really
 * asking: IF I CLICK THE MIDDLE OF THIS THING, DO I HIT IT? That is
 * `document.elementFromPoint` at the overlay's centre, checked against the
 * overlay's own subtree. An overlay that is visible but not hittable is the bug.
 *
 * It also walks modal-from-modal chains, because that is where stacking goes
 * wrong: a modal at z-index 80 opened from one at 9000 is invisible, and both
 * are "open".
 *
 * Diagnostic, not pass/fail — it prints what it found so a human decides. The
 * findings that matter get promoted into verify-crm-modals.mjs as assertions.
 *
 * Usage: node scripts/audit-crm-modals.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3995);
const B = `http://localhost:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "modal-audit-"));

const mkLead = (n, over = {}) => ({
  id: "lead_" + n, platform: "tiktok", userId: "u" + n, username: "user" + n,
  name: over.name || "Lead " + n, phone: "210555010" + n, email: `lead${n}@example.com`,
  state: "new", source: "TikTok", adCampaign: null, propertyInquired: null, criteria: null,
  brivityId: null, crmStatus: over.crmStatus || "hot", crmStage: "new_lead", crmPriority: "normal",
  crmIntent: "buyer", crmCallQueue: "none", crmNotes: null, tags: ["Investor"],
  address: "12 Oak St, San Antonio, TX 78253", birthday: "1990-03-15", homeAnniversary: null,
  autoPlanEnrollments: [], assignedUserId: null, assignedUserName: null,
  createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
});
const leads = [mkLead(1, { name: "Audit Alpha" }), mkLead(2, { name: "Audit Bravo" }),
  mkLead(3, { name: "Audit Charlie" }), mkLead(4, { name: "Audit Delta" })];
writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 20, leadsById: Object.fromEntries(leads.map((l) => [l.id, l])),
  leadKeyToId: Object.fromEntries(leads.map((l) => ["tiktok::" + l.userId, l.id])),
  conversationsByLeadId: Object.fromEntries(leads.map((l) => [l.id, { messages: [
    { role: "user", text: "hi is this available", at: "2026-08-20T10:00:00.000Z" },
    { role: "assistant", text: "yes it is", at: "2026-08-20T10:01:00.000Z" }] }])),
  commandTasks: [],
}));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db"), KNOWLEDGE_JSON_PATH: join(tmp, "k.json"),
    CRM_VOCAB_DB_PATH: join(tmp, "v.db") },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
srv.stdout.on("data", (d) => (srvLog += d));
srv.stderr.on("data", (d) => (srvLog += d));
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch {} });
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

/**
 * Every overlay currently on screen, and whether it can actually be clicked.
 *
 * "Visible" is not the question. A fixed overlay with a lower z-index than one
 * already open renders underneath it: display is block, the rect is right, and
 * the operator's click lands on the thing in front.
 */
const OVERLAY_PROBE = () => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed") continue;
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
    const r = el.getBoundingClientRect();
    /* Full-screen-ish only: this is about modal overlays, not chips. */
    if (r.width < 250 || r.height < 150) continue;
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + Math.min(r.height / 2, 300));
    const hit = document.elementFromPoint(cx, cy);
    const coveredBy = hit && !el.contains(hit) && hit !== el
      ? (hit.closest("[id]") ? "#" + hit.closest("[id]").id : hit.tagName.toLowerCase())
      : null;
    out.push({
      id: el.id || null,
      cls: (el.className || "").toString().split(" ")[0] || null,
      z: cs.zIndex,
      clickable: !coveredBy,
      coveredBy,
    });
  }
  return out;
};

const report = [];
async function probe(label, open, expectTop) {
  pageErrors.length = 0;
  try { await open(); } catch (e) { report.push({ label, result: "TRIGGER FAILED", detail: String(e.message).slice(0, 90) }); return; }
  await page.waitForTimeout(650);
  const overlays = await page.evaluate(OVERLAY_PROBE);
  /* Only the TOPMOST overlay has to be reachable. One sitting underneath a
     newer modal is covered on purpose — that is what stacking means — and
     flagging it would make correct behaviour look like the bug. */
  const byZ = overlays.slice().sort((a, b) => Number(b.z || 0) - Number(a.z || 0));
  const top = byZ[0];
  /* THE REAL QUESTION is not "is something on top" — it is "is the thing the
     operator just opened on top". Checking only the topmost passes happily on
     the broken code, because the OLD modal is topmost and perfectly clickable
     while the newly-opened one sits behind it, which is the reported bug. */
  const target = expectTop ? overlays.find((o) => o.id === expectTop) : top;
  let result;
  if (!overlays.length) result = "NO OVERLAY";
  else if (expectTop && !target) result = "DID NOT OPEN";
  else if (!target.clickable) result = "BLOCKED";
  else if (expectTop && top.id !== expectTop) result = "BEHIND " + (top.id || top.cls);
  else result = "ok";
  report.push({
    label, result,
    overlays: byZ.map((o, i) => `${o.id || o.cls}(z${o.z})${i === 0 ? " ←top" : ""}${o.clickable ? "" : " covered-by:" + o.coveredBy}`).join(", "),
    errors: pageErrors.slice(0, 2),
  });
}

const closeAll = () => page.evaluate(() => {
  try { if (typeof closeOa === "function") closeOa(); } catch {}
  for (const id of ["apEditorOv", "txOv", "txDetailOv"]) {
    const e = document.getElementById(id); if (e) e.style.display = "none";
  }
  document.querySelectorAll(".scrim.on, .afd-scrim.on").forEach((s) => s.classList.remove("on"));
});

try {
  await page.goto(B + "/crm", { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof LEADS !== "undefined" && LEADS.length > 0, null, { timeout: 20000 });
  await page.evaluate(() => openLead("lead_1"));
  await page.waitForTimeout(1200);

  /* ---- modals opened from the lead profile (no modal already open) ------- */
  const direct = [
    ["Add Agreement (buyer)", () => page.evaluate(() => openAgreementModal(LEADS[0], "buyer"))],
    ["Add Agreement (referral)", () => page.evaluate(() => openAgreementModal(LEADS[0], "referral"))],
    ["Listing Alert editor", () => page.evaluate(() => openAlertEditor(LEADS[0], null))],
    ["Address modal", () => page.evaluate(() => openAddressModal(LEADS[0], null))],
    ["Manage Team modal", () => page.evaluate(() => openManageTeamModal(LEADS[0]))],
    ["Advanced filter panel", () => page.evaluate(() => openAdvFilter())],
  ];
  for (const [label, open] of direct) { await closeAll(); await probe(label, open); }

  /* ---- the reported class: a modal opened FROM a modal ------------------- */
  await closeAll();
  await probe("Auto Plan editor, opened alone", () => page.evaluate(() => {
    const e = document.getElementById("apEditorOv"); e.style.display = "block";
  }), "apEditorOv");
  await closeAll();
  await probe("Auto Plan editor, opened WHILE Add Agreement is open", async () => {
    await page.evaluate(() => openAgreementModal(LEADS[0], "buyer"));
    await page.waitForTimeout(500);
    await page.evaluate(() => { document.getElementById("apEditorOv").style.display = "block"; });
  }, "apEditorOv");
  await closeAll();
  await probe("Transaction detail, opened WHILE Add Agreement is open", async () => {
    await page.evaluate(() => openAgreementModal(LEADS[0], "buyer"));
    await page.waitForTimeout(500);
    await page.evaluate(() => { document.getElementById("txDetailOv").style.display = "block"; });
  }, "txDetailOv");
  await closeAll();
  await probe("Transaction modal, opened WHILE Add Agreement is open", async () => {
    await page.evaluate(() => openAgreementModal(LEADS[0], "buyer"));
    await page.waitForTimeout(500);
    await page.evaluate(() => { document.getElementById("txOv").style.display = "block"; });
  }, "txOv");

  /* ---- small overlays fired from INSIDE a modal --------------------------
     A toast that says "Give the alert a name" is worthless if it paints behind
     the modal that produced it, and the same stacking rule applies to the
     anchored dropdown menus. Checked with a smaller size threshold. */
  const SMALL_PROBE = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === "none" || r.width === 0) return { found: true, shown: false };
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return { found: true, shown: true, z: cs.zIndex,
      clickable: !!(hit && (el.contains(hit) || hit === el)),
      coveredBy: hit && !el.contains(hit) && hit !== el ? (hit.closest("[id]") ? "#" + hit.closest("[id]").id : hit.tagName.toLowerCase()) : null };
  };

  await closeAll();
  await page.evaluate(() => openAgreementModal(LEADS[0], "buyer"));
  await page.waitForTimeout(600);
  await page.evaluate(() => crmToast("audit probe toast"));
  await page.waitForTimeout(250);
  /* A toast is deliberately pointer-events:none — you should not be able to
     click it — so elementFromPoint passes straight through and reports the
     modal behind it. That is the instrument being wrong, not the toast. What
     actually matters for a toast is PAINT order, so pointer-events is lifted
     for the length of the measurement. */
  const toast = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const prev = el.style.pointerEvents;
    el.style.pointerEvents = "auto";
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    el.style.pointerEvents = prev;
    return { found: true, shown: getComputedStyle(el).display !== "none", z: getComputedStyle(el).zIndex,
      clickable: !!(hit && (el.contains(hit) || hit === el)),
      coveredBy: hit && !el.contains(hit) && hit !== el ? (hit.closest("[id]") ? "#" + hit.closest("[id]").id : hit.tagName.toLowerCase()) : null };
  }, ".crm-toast");
  report.push({ label: "toast fired from inside a modal", result: toast.clickable ? "ok" : "BLOCKED",
    detail: JSON.stringify(toast) });

  await closeAll();
  await page.evaluate(() => openAgreementModal(LEADS[0], "buyer"));
  await page.waitForTimeout(600);
  const ddm = await page.evaluate(() => {
    const m = document.querySelector(".dd-menu");
    if (!m) return { found: false };
    m.style.display = "block"; m.style.left = "300px"; m.style.top = "300px";
    m.style.width = "200px"; m.style.height = "120px";
    return { found: true };
  });
  await page.waitForTimeout(200);
  if (ddm.found) {
    const dd = await page.evaluate(SMALL_PROBE, ".dd-menu");
    report.push({ label: "anchored dropdown menu inside a modal", result: dd.clickable ? "ok" : "BLOCKED",
      detail: JSON.stringify(dd) });
  } else {
    report.push({ label: "anchored dropdown menu inside a modal", result: "ok", detail: "no .dd-menu in the DOM to test" });
  }
  await closeAll();

  /* ---- every lead-profile tab renders without throwing -------------------- */
  await closeAll();
  const tabs = ["note", "email", "call", "text", "appointment", "other"];
  for (const t of tabs) {
    pageErrors.length = 0;
    const r = await page.evaluate((tab) => {
      try { ldTab = tab; renderLeadTab(); return "ok"; } catch (e) { return "THREW: " + e.message; }
    }, t);
    await page.waitForTimeout(250);
    report.push({ label: `lead tab: ${t}`, result: r === "ok" && !pageErrors.length ? "ok" : "PROBLEM",
      detail: r, errors: pageErrors.slice(0, 2) });
  }
  /* ---- every rail view renders without throwing --------------------------
     A view that throws mid-render leaves a half-drawn screen and every control
     below the throw dead — which looks like "that button does nothing". */
  await closeAll();
  const VIEWS = ["dashboard", "messages", "leads", "people", "opps", "tracker", "tx",
                 "calendar", "email", "nurture", "mls", "reporting", "finance", "plansettings"];
  for (const v of VIEWS) {
    pageErrors.length = 0;
    let shown = false;
    try {
      await page.click(`.rail .r[data-view="${v}"]`, { timeout: 4000 });
      await page.waitForTimeout(700);
      shown = await page.evaluate((view) => {
        const el = document.getElementById("view-" + view);
        return !!el && el.classList.contains("on") && el.getBoundingClientRect().height > 40;
      }, v);
    } catch (e) {
      report.push({ label: `view: ${v}`, result: "UNREACHABLE", detail: String(e.message).slice(0, 80) });
      continue;
    }
    report.push({
      label: `view: ${v}`,
      result: !shown ? "DID NOT RENDER" : pageErrors.length ? "JS ERROR" : "ok",
      errors: pageErrors.slice(0, 2),
    });
  }
} catch (e) {
  report.push({ label: "AUDIT ABORTED", result: "EXCEPTION", detail: String(e.stack || e).slice(0, 300) });
} finally {
  await browser.close();
  srv.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n================ CRM MODAL AUDIT ================\n");
let bad = 0;
for (const r of report) {
  const flag = r.result === "ok" ? "  ok  " : (bad++, " ⚠ " + r.result.padEnd(4));
  console.log(`${flag} ${r.label}`);
  if (r.overlays) console.log(`        overlays: ${r.overlays}`);
  if (r.detail) console.log(`        ${r.detail}`);
  if (r.errors && r.errors.length) console.log(`        pageerror: ${r.errors.join(" | ")}`);
}
console.log(`\n${report.length - bad} clean, ${bad} needing attention\n`);
if (bad && process.env.SHOW_LOG) console.error(srvLog.slice(-1500));
/* Exit non-zero so this can sit in the battery alongside the verify suites —
   a diagnostic nobody notices failing is not a diagnostic. */
process.exitCode = bad ? 1 : 0;
