#!/usr/bin/env node
/**
 * Brivity Auto Plan step parity: time units, Make Contingent, recurrence,
 * task notes/priority/roles, Send From, CC/BCC, email templates, merge-field
 * placeholders, and Specific Dates (birthday / home anniversary).
 *
 * Drives the REAL engine and the REAL editor — a seeded server plus a browser.
 * Usage: node scripts/verify-auto-plan-steps.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3398);
const B = `http://localhost:${PORT}`;
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "ap-steps-"));
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();

const mkLead = (n, over = {}) => ({
  id: "lead_" + n, platform: "tiktok", userId: "u" + n, username: "user" + n,
  name: over.name, phone: over.phone ?? ("21055503" + String(10 + n)), email: over.email ?? null,
  state: "new", source: "TikTok", adCampaign: null, propertyInquired: over.propertyInquired ?? null,
  criteria: null, brivityId: null, crmStatus: "new", crmStage: "new", crmPriority: "normal",
  crmIntent: "buyer", crmCallQueue: "none", crmNotes: null, tags: [],
  address: over.address ?? null, birthday: over.birthday ?? null, homeAnniversary: over.homeAnniversary ?? null,
  assignedUserId: over.assignedUserId ?? null, assignedUserName: over.assignedUserName ?? null,
  autoPlanEnrollments: over.enrollments || [],
  createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z",
});

// Birthday two days from now, so a "-1 day before birthday" step is due tomorrow (not yet),
// and a "-3 days before" step is already due.
const bday = new Date(now + 2 * DAY);
const bdayStr = `1988-${String(bday.getUTCMonth() + 1).padStart(2, "0")}-${String(bday.getUTCDate()).padStart(2, "0")}`;

const PLAN_ID = "plan_units";
const plans = [{
  id: PLAN_ID, name: "Unit + role test plan", tag: "", planType: "people", active: true,
  autoPauseOnReply: false, autoPauseOnStatus: null, completionStatus: null, archived: false,
  createdAt: iso(now - 10 * DAY), updatedAt: iso(now - 10 * DAY),
  steps: [
    // due: enrolled 2h ago + 30 minutes => already due (proves unit maths)
    { id: "s_min", type: "text", dayOffset: 30, offsetUnit: "minutes", content: "Hi {{recipient_first_name}}, quick check in.", sendFrom: "primary_agent" },
    // NOT due: 5 days after enrollment
    { id: "s_days", type: "text", dayOffset: 5, content: "Later message." },
    // task with role assignee, priority, notes, recurrence
    { id: "s_task", type: "task", dayOffset: 0, content: "Call {{recipient_first_name}}", assignedTo: "carlos", taskPriority: 2, instructions: "Ask about timeline", notes: "Logged the intro call", recurrence: "daily" },
    // email with cc/bcc + sendFrom + unresolvable placeholder (must be held back)
    { id: "s_mail", type: "email", dayOffset: 0, subject: "About {{recipient_first_name}}", content: "Your home at {{recipient_address}} is worth a look.", cc: ["tc@example.com"], bcc: ["broker@example.com"], sendFrom: "lead_agent" },
  ],
}, {
  id: "plan_bday", name: "Birthday plan", tag: "", planType: "people", active: true,
  autoPauseOnReply: false, autoPauseOnStatus: null, completionStatus: null, archived: false,
  createdAt: iso(now - 10 * DAY), updatedAt: iso(now - 10 * DAY),
  steps: [
    { id: "s_bd_soon", type: "task", dayOffset: -3, anchor: "birthday", content: "Send a birthday card", recurrence: "yearly" },
    { id: "s_bd_none", type: "task", dayOffset: 0, anchor: "home_anniversary", content: "Home anniversary touch" },
  ],
}];
writeFileSync(join(tmp, "auto-plans.json"), JSON.stringify(plans, null, 2));

const enrolledAt = iso(now - 2 * 60 * 60 * 1000); // 2 hours ago
const leads = [
  mkLead(1, {
    name: "Unit Tester", assignedUserId: "wesley", assignedUserName: "Wesley",
    enrollments: [{ planId: PLAN_ID, planName: "Unit + role test plan", enrolledAt, currentStepIndex: 0, completedSteps: [], status: "active" }],
  }),
  mkLead(2, {
    name: "Birthday Person", birthday: bdayStr,
    enrollments: [{ planId: "plan_bday", planName: "Birthday plan", enrolledAt, currentStepIndex: 0, completedSteps: [], status: "active" }],
  }),
  /* Untouched by the other checks, so the auto-pause test can move its status
     without disturbing the birthday or role assertions. */
  mkLead(3, { name: "Pause Subject" }),
];
const db = { idCounter: 10, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] };
for (const l of leads) { db.leadsById[l.id] = l; db.leadKeyToId[l.platform + "::" + l.userId] = l.id; db.conversationsByLeadId[l.id] = { messages: [] }; }
writeFileSync(join(tmp, "db.json"), JSON.stringify(db));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT),
    /* The site lock defaults to ON as of 2026-08-22. These suites exercise the
       app, not the door, so it is switched off explicitly here rather than
       every fixture growing a login step. scripts/verify-site-lock.mjs is the
       one that tests the lock, and deliberately sets nothing. */
    SITE_LOGIN_ENABLED: "0",
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    AUTO_PLANS_JSON_PATH: join(tmp, "auto-plans.json"),
    AUTO_PLAN_TRIGGERS_JSON_PATH: join(tmp, "auto-plan-triggers.json"),
    USER_PREFS_JSON_PATH: join(tmp, "user-prefs.json"),
    TRANSACTIONS_DB_PATH: join(tmp, "transactions.db"),
    TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "", // texts cannot really send here
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);
const J = (r) => r.json();

try {
  // ---- meta endpoint feeds the editors ------------------------------------
  const meta = await J(await fetch(B + "/api/auto-plans/meta"));
  ok("meta serves merge fields", Array.isArray(meta.mergeFields) && meta.mergeFields.some((f) => f.key === "recipient_first_name"));
  ok("meta serves roles", meta.roles.some((r) => r.key === "primary_agent"));
  ok("meta serves the team", meta.team.some((m) => m.id === "carlos"));
  ok("meta serves offset units", JSON.stringify(meta.offsetUnits) === '["minutes","hours","days"]');

  // ---- run the engine ------------------------------------------------------
  const run = await J(await fetch(B + "/api/auto-plans/execute-due-steps", { method: "POST" }));
  ok("engine ran", run && typeof run.stepsExecuted === "number", JSON.stringify(run));

  const snap = await J(await fetch(B + "/api/dashboard/data"));
  const l1 = snap.leads.find((l) => l.id === "lead_1");
  const acts = l1.activity || [];
  const enr = (l1.autoPlanEnrollments || [])[0];
  const text = (t) => acts.some((a) => (a.description || "").includes(t));

  ok("minute-unit step fired (30 min after enrollment)", enr.completedSteps.includes("s_min"), JSON.stringify(enr.completedSteps));
  ok("day-unit step did NOT fire yet", !enr.completedSteps.includes("s_days"));
  ok("first-name placeholder resolved", text("Hi Unit,"), acts.map((a) => a.description).join(" | ").slice(0, 200));
  ok("text records the resolved sender role", text("from Wesley"), "primary_agent should resolve to the assigned user");

  ok("email with a missing placeholder was HELD BACK, not sent", text("Auto Plan email HELD BACK"));
  ok("held-back email names the reason", text("recipient address"), acts.filter((a) => /HELD BACK/.test(a.description)).map((a) => a.description).join(""));
  ok("no email claimed to be sent", !acts.some((a) => a.type === "email_sent"));

  ok("task note posted to the timeline", text("Auto Plan note"), "notes should log alongside the task");
  const tasks = await J(await fetch(B + "/api/crm-tasks?leadId=lead_1"));
  const t = (tasks.tasks || []).find((x) => /Call Unit/.test(x.title));
  ok("task created with the merge field resolved", !!t, JSON.stringify((tasks.tasks || []).map((x) => x.title)));
  if (t) {
    ok("priority 1-9 maps onto the task store (2 -> urgent)", t.priority === "urgent", t.priority);
    ok("role/teammate assignee resolved to Carlos", t.assignedUserName === "Carlos" && t.assignedUserId === "carlos", `${t.assignedUserName}/${t.assignedUserId}`);
    ok("instructions carried into the task body", /Ask about timeline/.test(t.description || ""));
  }
  // recurring task: not marked complete, has a run clock
  ok("recurring step is not marked complete", !enr.completedSteps.includes("s_task"), JSON.stringify(enr.completedSteps));
  ok("recurring step records its run clock", !!(enr.lastRunAt && enr.lastRunAt.s_task) && enr.runCount.s_task === 1, JSON.stringify({ l: enr.lastRunAt, c: enr.runCount }));

  // second run: the daily step must NOT fire again immediately
  await fetch(B + "/api/auto-plans/execute-due-steps", { method: "POST" });
  const snap2 = await J(await fetch(B + "/api/dashboard/data"));
  const enr2 = (snap2.leads.find((l) => l.id === "lead_1").autoPlanEnrollments || [])[0];
  ok("daily step does not re-fire within its interval", enr2.runCount.s_task === 1, JSON.stringify(enr2.runCount));

  // ---- Specific Dates ------------------------------------------------------
  const l2 = snap.leads.find((l) => l.id === "lead_2");
  const enrB = (l2.autoPlanEnrollments || [])[0];
  ok("birthday step fired (3 days before a birthday 2 days out)", (enrB.runCount || {}).s_bd_soon === 1 || enrB.completedSteps.includes("s_bd_soon"), JSON.stringify(enrB));
  ok("anniversary step stayed dormant — the contact has no anniversary", !enrB.completedSteps.includes("s_bd_none") && !(enrB.runCount || {}).s_bd_none);

  // ---- duplicate keeps exactly one route and remaps chains ----------------
  const dup = await fetch(B + "/api/auto-plans/" + PLAN_ID + "/duplicate", { method: "POST" });
  ok("duplicate endpoint responds", dup.ok, String(dup.status));
  const dupBody = await dup.json();
  const copy = dupBody.plan;
  ok("copy has fresh step ids", copy && copy.steps.every((st) => !["s_min", "s_days", "s_task", "s_mail"].includes(st.id)));
  ok("copy preserves units and roles", copy.steps.find((st) => st.offsetUnit === "minutes") && copy.steps.some((st) => st.sendFrom === "primary_agent"));

  // ---- browser: the editor exposes every spec field ------------------------
  /* Same override the other CRM suites use: the container pre-installs
     Chromium but a version-mismatched playwright looks for another revision. */
  /* ── auto-pause on ANY status change (spec 4.4) ──────────────────────────
     The engine already paused on ONE named status. Brivity's other shape —
     pause whenever the status moves at all — is the safety valve that matters,
     because a status that just changed is one a human just touched, and a drip
     that keeps firing over that is the complaint. Driven end to end here
     rather than asserted on the dropdown, because a plan that stores the word
     without changing behaviour would pass a UI-only check. */
  {
    const anyPlan = await J(await fetch(B + "/api/auto-plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Pause on any change", planType: "people", active: true,
        autoPauseOnStatus: "any",
        steps: [{ type: "text", dayOffset: 3, content: "still looking?" }],
      }),
    }));
    const planId = anyPlan.plan?.id || anyPlan.id;
    ok("a plan can store the 'any status change' pause rule", !!planId, JSON.stringify(anyPlan).slice(0, 120));

    await fetch(B + `/api/auto-plans/${planId}/enroll/lead_3`, { method: "POST" });
    let snap2 = await J(await fetch(B + "/api/dashboard/data"));
    let enr = (snap2.leads.find((l) => l.id === "lead_3")?.autoPlanEnrollments || [])
      .find((e) => e.planId === planId);
    ok("the contact enrols active", enr && enr.status === "active", JSON.stringify(enr));

    /* Move the status to something the plan never named. */
    await fetch(B + "/api/crm/lead/lead_3", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crmStatus: "nurture" }),
    });
    snap2 = await J(await fetch(B + "/api/dashboard/data"));
    enr = (snap2.leads.find((l) => l.id === "lead_3")?.autoPlanEnrollments || [])
      .find((e) => e.planId === planId);
    ok("and ANY status change pauses it, not just the one named status",
      enr && enr.status === "paused", JSON.stringify(enr));
  }

  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await br.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto(B + "/crm", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag"), null, { timeout: 15000 });
  await page.click('.rail .r[data-view="plansettings"]');
  await page.waitForSelector("#apPlansTable tbody tr");
  await page.waitForTimeout(600); // meta fetch
  /* ── the Auto Plans admin surface, per the 2026-08-22 spec ── */
  ok("the SMS compliance banner carries the spec's heading",
    /SMS Compliance & Sending Mass Texts/.test(await page.textContent("#apSmsBanner")));
  ok("with an I UNDERSTAND control", !!(await page.$("#apSmsOk")));
  await page.click("#apSmsOk");
  ok("which dismisses it", (await page.$eval("#apSmsBanner", (e) => e.style.display)) === "none");

  /* Sharing does not exist in a single-office system. The tab is offered and
     then explains itself rather than listing this team's own plans as shared. */
  ok("a SHARED WITH ME tab exists", !!(await page.$("#apTabShared")));
  await page.click("#apTabShared");
  ok("it says why there is nothing in it",
    /no second account to receive one from/.test(await page.textContent("#apSharedNote")),
    (await page.textContent("#apSharedNote")).slice(0, 120));
  ok("and it does NOT re-list this team's own plans as shared",
    (await page.$eval("#apPlansTable", (e) => e.style.display)) === "none");
  await page.click("#apTabPeople");
  await page.waitForSelector("#apPlansTable tbody tr");

  await page.click('[data-pedt="' + PLAN_ID + '"]');
  await page.waitForSelector(".apStep");

  /* Brivity's auto-pause has two shapes; the "any status change" one is the
     safety valve, and it was missing entirely. */
  const pauseOpts = await page.$$eval("#plPauseStatus option", (n) => n.map((o) => o.value));
  ok("auto-pause offers 'any status change', not just one named status",
    pauseOpts.includes("any"), pauseOpts.join(","));
  ok("unit dropdown present on a step", (await page.$$(".apStep .stUnit")).length > 0);
  ok("unit reflects the saved value", (await page.$eval(".apStep .stUnit", (e) => e.value)) === "minutes");
  ok("Send From offers roles", (await page.$eval(".apStep .stFrom", (e) => e.innerHTML)).includes("Primary Agent"));
  ok("Insert Placeholder menu present", (await page.$$(".apStep .stPh")).length > 0);
  ok("AI help-me-write button present", (await page.$$(".apStep .stAi")).length > 0);
  ok("SMS compliance shown on the text step", (await page.$eval(".apStep", (e) => e.textContent)).includes("SMS compliance"));
  const taskRow = await page.$(".apStep .stRecur");
  ok("task step has a Repeat control", !!taskRow);
  ok("task step has Notes", (await page.$$(".apStep .stNotes")).length > 0);
  ok("email step has CC and BCC", (await page.$$(".apStep .stCc")).length > 0 && (await page.$$(".apStep .stBcc")).length > 0);
  const anchorHtml = await page.$eval(".apStep .stAnchor", (e) => e.innerHTML);
  ok("Specific Dates offered on a people plan", /birthday/.test(anchorHtml) && /home_anniversary/.test(anchorHtml));

  // edit a step and save: units + notes round trip through the API
  await page.selectOption(".apStep .stUnit", "hours");
  await page.fill(".apStep .stOff", "6");
  await page.click("#plSave");
  await page.waitForTimeout(700);
  const after = await J(await fetch(B + "/api/auto-plans"));
  const saved = (after.plans || []).find((x) => x.id === PLAN_ID);
  const savedStep = saved.steps.find((st) => st.id === "s_min");
  ok("editor saved the unit change", savedStep.offsetUnit === "hours" && savedStep.dayOffset === 6, JSON.stringify(savedStep));
  ok("editor preserved the task notes", saved.steps.find((st) => st.id === "s_task").notes === "Logged the intro call");
  ok("editor preserved cc/bcc", JSON.stringify(saved.steps.find((st) => st.id === "s_mail").cc) === '["tc@example.com"]');
  ok("no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:\n - " + fail.join("\n - ")); process.exit(1); }
