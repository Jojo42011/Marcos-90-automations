#!/usr/bin/env node
/**
 * Phase 2 verification: the contact profile's real blocks — persisted
 * activity logging, Details (description/salutations/language/tags),
 * Relationships, Assigned To, Tasks, Auto Plans, Transactions.
 *
 * Same harness as verify-crm-filters-prefs.mjs: boots dist/src/server.js
 * from the repo root against a seeded temp data dir, drives a real browser.
 *
 * Usage: node scripts/verify-crm-profile-blocks.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3397);
const B = `http://localhost:${PORT}`;

let pass = 0; const fail = [];
const ok = (n, c, detail) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (detail ? " — " + detail : "")); console.error("FAIL " + n + (detail ? " — " + detail : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "crm-prof-"));
const mkLead = (n, over) => ({
  id: "lead_" + n, platform: "tiktok", userId: "u" + n, username: "user" + n,
  name: over.name, phone: "21055502" + String(10 + n), email: over.email ?? null,
  state: "new", source: "TikTok", adCampaign: null, propertyInquired: null, criteria: null, brivityId: null,
  crmStatus: "new", crmStage: "new", crmPriority: "normal", crmIntent: "buyer", crmCallQueue: "none", crmNotes: null,
  tags: over.tags || [], createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
});
const leads = [mkLead(1, { name: "Prime Lead" }), mkLead(2, { name: "Spouse Person" }), mkLead(3, { name: "Third Person" })];
const db = { idCounter: 10, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] };
for (const l of leads) { db.leadsById[l.id] = l; db.leadKeyToId[l.platform + "::" + l.userId] = l.id; db.conversationsByLeadId[l.id] = { messages: [] }; }
writeFileSync(join(tmp, "db.json"), JSON.stringify(db));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT),
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    AUTO_PLANS_JSON_PATH: join(tmp, "auto-plans.json"), USER_PREFS_JSON_PATH: join(tmp, "user-prefs.json"),
    TRANSACTIONS_DB_PATH: join(tmp, "transactions.db"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = ""; srv.stdout.on("data", (d) => (srvLog += d)); srv.stderr.on("data", (d) => (srvLog += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);
const J = (r) => r.json();

try {
  // ---- API layer -----------------------------------------------------------
  let r = await fetch(B + "/api/crm/lead/lead_1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: "Came in from a TikTok about Canyon Lake", letterSalutation: "Dear Prime", envelopeSalutation: "Prime Lead", preferredLanguage: "English", relationships: [{ name: "Spouse Person", relation: "Spouse", leadId: "lead_2" }, { name: "", relation: "junk" }, { notAThing: true }] }) });
  ok("PATCH details+relationships accepted", r.ok);
  let snap = await J(await fetch(B + "/api/dashboard/data"));
  let row = snap.leads.find((l) => l.id === "lead_1");
  ok("description persisted", row.description === "Came in from a TikTok about Canyon Lake");
  ok("salutations persisted", row.letterSalutation === "Dear Prime" && row.envelopeSalutation === "Prime Lead");
  ok("junk relationships dropped, real one kept", row.relationships.length === 1 && row.relationships[0].leadId === "lead_2" && row.relationships[0].relation === "Spouse", JSON.stringify(row.relationships));

  r = await fetch(B + "/api/crm/lead/lead_1/activity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "call", description: "Talked: wants to see homes Saturday" }) });
  ok("activity POST accepted", r.ok);
  r = await fetch(B + "/api/crm/lead/lead_1/activity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "sent_rocket", description: "x" }) });
  ok("unknown activity type rejected 400", r.status === 400);
  r = await fetch(B + "/api/crm/lead/nope/activity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "note", description: "x" }) });
  ok("missing lead 404s", r.status === 404);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  row = snap.leads.find((l) => l.id === "lead_1");
  ok("activity persisted server-side", row.activity.some((a) => a.type === "call" && /Saturday/.test(a.description)), JSON.stringify(row.activity));

  // a transaction linked to the lead, for the Transactions block
  r = await fetch(B + "/api/transactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: "77 Cibolo Ridge", dealType: "buyer", status: "active", leadId: "lead_1", listPrice: 450000, parties: { buyerName: "Prime Lead" } }) });
  ok("transaction created", r.ok, String(r.status));

  // ---- browser layer -------------------------------------------------------
  const br = await chromium.launch();
  const page = await br.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  await page.goto(B + "/crm", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag") && /Live data/.test(document.querySelector(".demo-tag").textContent), null, { timeout: 15000 });
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Prime Lead")');
  await page.waitForSelector("#ldTimeline");

  // timeline shows the server-side activity (the reload-persistence fix)
  const tl = await page.textContent("#ldTimeline");
  ok("timeline renders server activity with text and time", /Saturday/.test(tl));

  // details block round trip through the UI
  await page.fill("#ldDescIn", "Updated background note");
  await page.fill("#ldLang", "Spanish");
  await page.click("#ldDetSave");
  await page.waitForTimeout(400);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  row = snap.leads.find((l) => l.id === "lead_1");
  ok("details saved from the UI", row.description === "Updated background note" && row.preferredLanguage === "Spanish");

  // tags: add + persists
  await page.fill("#ldTagIn", "Investor");
  await page.click("#ldTagAdd");
  await page.waitForTimeout(400);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  ok("tag added persists", snap.leads.find((l) => l.id === "lead_1").tags.includes("Investor"));

  // relationships rendered, linked name navigates
  const relLink = await page.$('#ldRelRows .ldlink:has-text("Spouse Person")');
  ok("linked relationship renders as a link", !!relLink);
  if (relLink) {
    await relLink.click();
    await page.waitForFunction(() => document.querySelector(".ld-name") && /Spouse Person/.test(document.querySelector(".ld-name").textContent));
    ok("clicking the relationship opens that contact", true);
    // back to the prime lead
    await page.click("#ldBack");
    await page.waitForSelector("#leadRows tr");
    await page.click('#leadRows .ldlink:has-text("Prime Lead")');
    await page.waitForSelector("#ldTimeline");
  }

  // assigned-to via the MANAGE menu
  await page.click("#ldAssignBtn");
  await page.waitForSelector('#ddMenu button:has-text("Carlos")');
  await page.click('#ddMenu button:has-text("Carlos")');
  await page.waitForTimeout(500);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  ok("assignment persisted", snap.leads.find((l) => l.id === "lead_1").assignedUserId === "carlos");
  ok("assigned name shown on the card", /Carlos/.test(await page.textContent("#ldAssignRow")));

  // transactions block lists the linked deal and opens the detail view
  const txBlk = await page.textContent("#ldTxBlk");
  ok("transactions block lists the linked deal", /77 Cibolo Ridge/.test(txBlk), txBlk.slice(0, 80));
  await page.click('#ldTxBlk [data-txopen]');
  await page.waitForTimeout(400);
  const detVisible = await page.$eval("#txDetailOv", (o) => o.style.display !== "none");
  ok("clicking it opens the transaction detail", detVisible);
  await page.evaluate(() => { document.getElementById("txDetailOv").style.display = "none"; });

  // appointment tab creates a REAL task with the picked fields
  await page.click('#ldTabs button[data-t="appointment"]');
  await page.fill("#ldApptTask", "Showing at 77 Cibolo Ridge");
  await page.selectOption("#ldApptType", "Showing");
  await page.selectOption("#ldApptWho", "carlos");
  await page.fill("#ldDate", "2026-08-20");
  await page.fill("#ldTime", "14:00");
  await page.check('#ldPrio input[value="2"]');
  await page.click("#ldSched");
  await page.waitForTimeout(500);
  const tasks = await J(await fetch(B + "/api/crm-tasks?leadId=lead_1"));
  const t0 = (tasks.tasks || [])[0];
  ok("appointment created a real task", !!t0, JSON.stringify(tasks).slice(0, 120));
  if (t0) {
    ok("task carries the picked fields", t0.type === "appointment" && t0.priority === "urgent" && t0.dueDate === "2026-08-20" && t0.dueTime === "14:00" && t0.assignedUserId === "carlos" && /Showing/.test(t0.description || ""), JSON.stringify(t0));
  }
  // tasks block shows it; completing it works
  await page.waitForFunction(() => /Cibolo/.test(document.getElementById("ldTasksBlk").textContent), null, { timeout: 5000 });
  ok("tasks block lists the new task", true);
  await page.click('#ldTasksBlk [data-tdone]');
  await page.waitForFunction(() => /No open tasks/.test(document.getElementById("ldTasksBlk").textContent), null, { timeout: 5000 });
  ok("completing from the block works", true);

  // auto plans: apply, pause, remove
  await page.click("#ldPlanAdd");
  await page.waitForSelector("#ddMenu button");
  const planName = (await page.textContent("#ddMenu button")).trim();
  await page.click("#ddMenu button");
  await page.waitForFunction(() => /ACTIVE/.test(document.getElementById("ldPlansBlk").textContent), null, { timeout: 6000 });
  ok("plan applied and shown active", true, planName);
  await page.click('#ldPlansBlk [data-ptoggle]');
  await page.waitForFunction(() => /PAUSED/.test(document.getElementById("ldPlansBlk").textContent), null, { timeout: 6000 });
  ok("pause works", true);
  await page.click('#ldPlansBlk [data-premove]');
  await page.waitForFunction(() => /Not on any plan/.test(document.getElementById("ldPlansBlk").textContent), null, { timeout: 6000 });
  ok("remove works", true);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  const enr = snap.leads.find((l) => l.id === "lead_1").autoPlanEnrollments || [];
  ok("server agrees the plan is gone", !enr.some((e) => e.status === "active" || e.status === "paused"), JSON.stringify(enr));

  // reload: everything still there (server persistence, not client memory)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag") && /Live data/.test(document.querySelector(".demo-tag").textContent), null, { timeout: 15000 });
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Prime Lead")');
  await page.waitForSelector("#ldTimeline");
  const tl2 = await page.textContent("#ldTimeline");
  ok("logged call survives reload", /Saturday/.test(tl2));
  ok("appointment log survives reload", /Cibolo Ridge/.test(tl2));
  ok("details survive reload", (await page.inputValue("#ldDescIn")) === "Updated background note");
  ok("tag survives reload", /Investor/.test(await page.textContent("#ldTagRow")));
  ok("relationship survives reload", /Spouse Person/.test(await page.textContent("#ldRelRows")));

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:", fail); process.exit(1); }
