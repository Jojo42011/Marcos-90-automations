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
const post = (u, b) => fetch(B + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

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
  /* The container pre-installs Chromium at PLAYWRIGHT_BROWSERS_PATH but a
     version-mismatched playwright package looks for a different revision —
     PW_CHROMIUM points launch at the real binary in that case. */
  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
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
  await page.waitForFunction(() => /Saturday/.test(document.getElementById("ldTimeline").textContent), null, { timeout: 8000 }).catch(() => {});
  const tl = await page.textContent("#ldTimeline");
  ok("timeline renders server activity with text and time", /Saturday/.test(tl));

  /* Details, Relationships and Notes now live in the left accordion stack
     (contact-record phase). openAcc opens one by its key. */
  const openAcc = async (key) => {
    await page.waitForSelector(`#crPanel .acc[data-acc="${key}"]`);
    const isOpen = await page.$eval(`#crPanel .acc[data-acc="${key}"]`, (e) => e.classList.contains("open"));
    if (!isOpen) await page.click(`#crPanel .acc[data-acc="${key}"] .acc-h`);
    await page.waitForFunction((k) => document.querySelector(`#crPanel .acc[data-acc="${k}"]`).classList.contains("open"), key);
  };

  // details block round trip through the UI — one row at a time, inline
  await openAcc("details");
  await page.click('#crPanel [data-dtedit][data-key="description"]');
  await page.fill('#crPanel [data-dtrow="description"] textarea', "Updated background note");
  await page.click('#crPanel [data-dtrow="description"] .cx-sv');
  await page.waitForTimeout(500);
  await openAcc("details");
  await page.click('#crPanel [data-dtedit][data-key="preferredLanguage"]');
  await page.fill('#crPanel [data-dtrow="preferredLanguage"] input', "Spanish");
  await page.click('#crPanel [data-dtrow="preferredLanguage"] .cx-sv');
  await page.waitForTimeout(500);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  row = snap.leads.find((l) => l.id === "lead_1");
  ok("details saved from the UI", row.description === "Updated background note" && row.preferredLanguage === "Spanish", JSON.stringify({ d: row.description, l: row.preferredLanguage }));

  // tags: add + persists
  await openAcc("details");
  await page.fill("#crTagIn", "Investor");
  await page.press("#crTagIn", "Enter");
  await page.waitForTimeout(500);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  ok("tag added persists", snap.leads.find((l) => l.id === "lead_1").tags.includes("Investor"));

  // relationships rendered, linked name navigates
  await openAcc("relationships");
  const relLink = await page.$('#crPanel .acc[data-acc="relationships"] .ldlink:has-text("Spouse Person")');
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

  /* Assigned To gained a Manage Team modal (widgets phase). MANAGE opens the
     modal; the caret beside the primary agent is the quick reassign. */
  await page.waitForSelector("#ldAssignCaret");
  await page.click("#ldAssignCaret");
  await page.waitForSelector('#ddMenu button:has-text("Carlos")');
  await page.click('#ddMenu button:has-text("Carlos")');
  await page.waitForTimeout(700);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  ok("assignment persisted", snap.leads.find((l) => l.id === "lead_1").assignedUserId === "carlos");
  ok("assigned name shown on the card", /Carlos/.test(await page.textContent("#ldAssignRow")));

  // transactions block lists the linked deal and opens the detail view
  await openAcc("transactions");
  const txBlk = await page.textContent('#crPanel .acc[data-acc="transactions"] .acc-b');
  ok("transactions block lists the linked deal", /77 Cibolo Ridge/.test(txBlk), txBlk.slice(0, 80));
  await page.click('#crPanel [data-cr="txOpen"]');
  await page.waitForTimeout(400);
  const detVisible = await page.$eval("#txDetailOv", (o) => o.style.display !== "none");
  ok("clicking it opens the transaction detail", detVisible);
  await page.evaluate(() => { document.getElementById("txDetailOv").style.display = "none"; });

  // appointment tab creates a REAL task with the picked fields
  // (composer phase: the tab is now the spec's Appointment/Task form)
  await page.click('#ldTabs button[data-t="appointment"]');
  await page.waitForSelector("#qaApTitle");
  await page.fill("#qaApTitle", "Showing at 77 Cibolo Ridge");
  await page.selectOption("#qaApType", "Showing Appointment");
  await page.selectOption("#qaApWho", "carlos");
  await page.click('#qaApDate button[data-custom]');
  await page.waitForSelector("#qaApDateIn");
  await page.fill("#qaApDateIn", "2026-08-20");
  await page.fill("#qaApTimeIn", "14:00");
  await page.click('#qaApPrio button[data-p="2"]');
  await page.click("#qaApCreate");
  await page.waitForTimeout(700);
  const tasks = await J(await fetch(B + "/api/crm-tasks?leadId=lead_1"));
  const t0 = (tasks.tasks || [])[0];
  ok("appointment created a real task", !!t0, JSON.stringify(tasks).slice(0, 120));
  if (t0) {
    ok("task carries the picked fields", t0.type === "appointment" && t0.priority === "urgent" && t0.dueDate === "2026-08-20" && t0.dueTime === "14:00" && t0.assignedUserId === "carlos" && /Showing/.test(t0.description || ""), JSON.stringify(t0));
  }
  /* Appointments and Tasks are two widgets now (widgets phase): an
     appointment lands in Appointments, and Tasks holds everything else. */
  await page.waitForFunction(() => /Cibolo|Appointment/.test(document.getElementById("ldApptBlk").textContent), null, { timeout: 8000 });
  ok("appointments widget lists the new appointment", /Showing Appointment|Appointment/.test(await page.textContent("#ldApptBlk")));
  ok("tasks widget does not double-list it", !/Cibolo/.test(await page.textContent("#ldTasksBlk")), await page.textContent("#ldTasksBlk"));
  // a plain task, so the Tasks widget and its checkbox are exercised too
  await post("/api/crm-tasks", { title: "Send the Cibolo comps", type: "to_do", priority: "normal", dueDate: "2026-08-21", leadId: "lead_1", leadName: "Prime Lead" });
  await page.click("#ldBack");
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Prime Lead")');
  await page.waitForFunction(() => /Cibolo comps/.test(document.getElementById("ldTasksBlk").textContent), null, { timeout: 8000 });
  ok("tasks widget lists a plain task with its type and date", /To-Do — 08\/21\/26/.test(await page.textContent("#ldTasksBlk")), await page.textContent("#ldTasksBlk"));
  await page.click('#ldTasksBlk [data-tkdone]');
  await page.waitForFunction(() => /No open tasks/.test(document.getElementById("ldTasksBlk").textContent), null, { timeout: 8000 });
  ok("completing from the widget works", true);

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
  await page.waitForFunction(() => /Saturday/.test(document.getElementById("ldTimeline").textContent), null, { timeout: 8000 }).catch(() => {});
  const tl2 = await page.textContent("#ldTimeline");
  ok("logged call survives reload", /Saturday/.test(tl2));
  ok("the appointment task shows on the timeline", /Cibolo Ridge/.test(tl2), tl2.slice(0, 200));
  await openAcc("details");
  ok("details survive reload", /Updated background note/.test(await page.textContent('#crPanel [data-dtrow="description"]')));
  ok("tag survives reload", /Investor/.test(await page.textContent("#crTagRow")));
  await openAcc("relationships");
  ok("relationship survives reload", /Spouse Person/.test(await page.textContent('#crPanel .acc[data-acc="relationships"] .acc-b')));

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:", fail); process.exit(1); }
