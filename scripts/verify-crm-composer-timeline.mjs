#!/usr/bin/env node
/**
 * Quick Action Composer + Activity Timeline verification.
 *
 * Three specs of Aug 2026: the six-tab composer (NOTE / EMAIL / CALL / TEXT /
 * APPOINTMENT / OTHER), the OTHER tab in detail, and the unified activity
 * timeline with its filter pill bar.
 *
 * The send paths are exercised WITHOUT sending anything: Gmail and Quo are
 * left unconfigured in the test environment, which is exactly the state the
 * composer has to be honest about — the buttons must be disabled and say why,
 * never enabled-and-failing.
 *
 * Usage: node scripts/verify-crm-composer-timeline.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3399);
const B = `http://localhost:${PORT}`;

let pass = 0; const fail = [];
const ok = (n, c, detail) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (detail ? " — " + detail : "")); console.error("FAIL " + n + (detail ? " — " + detail : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "crm-comp-"));
const mkLead = (n, over) => ({
  id: "lead_" + n, platform: "tiktok", userId: "u" + n, username: "user" + n,
  name: over.name, phone: over.phone ?? null, email: over.email ?? null, address: over.address ?? null,
  state: "new", source: "TikTok", adCampaign: null, propertyInquired: null, criteria: null, brivityId: null,
  crmStatus: "new", crmStage: "new", crmPriority: "normal", crmIntent: "buyer", crmCallQueue: "none", crmNotes: null,
  tags: [], createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
  activity: over.activity || [],
});
const leads = [
  mkLead(1, {
    name: "Composer Lead", email: "composer@example.com", phone: "8179954677", address: "900 Elm St",
    activity: [{ type: "call", description: "Talked: wants Saturday showings", timestamp: "2026-08-18T15:00:00.000Z" }],
  }),
  mkLead(2, { name: "Second Person", phone: "2105550210", email: "second@example.com" }),
  mkLead(3, { name: "Third Person", phone: "2105550211", email: "third@example.com" }),
];
const db = { idCounter: 10, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] };
for (const l of leads) { db.leadsById[l.id] = l; db.leadKeyToId[l.platform + "::" + l.userId] = l.id; db.conversationsByLeadId[l.id] = { messages: [] }; }
writeFileSync(join(tmp, "db.json"), JSON.stringify(db));

/* Deliberately no GMAIL_* / QUO_* / TWILIO_* in the child env: the composer's
   behaviour when a channel cannot send is half of what this suite checks. */
const env = { ...process.env, PORT: String(PORT),
  /* These suites exercise the app, not the door. The site lock defaults to ON
     as of 2026-08-22, so it is switched off explicitly here rather than every
     fixture growing a login step. scripts/verify-site-lock.mjs is the one that
     tests the lock, and it deliberately sets nothing. */
  SITE_LOGIN_ENABLED: "0",
  DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  AUTO_PLANS_JSON_PATH: join(tmp, "auto-plans.json"), USER_PREFS_JSON_PATH: join(tmp, "user-prefs.json"),
  TRANSACTIONS_DB_PATH: join(tmp, "transactions.db"), CONTACT_RECORD_DB_PATH: join(tmp, "contact-records.db"),
  CONTACT_DOCS_DIR: join(tmp, "contact-docs"), OUTREACH_DB_PATH: join(tmp, "outreach.db"), SMS_DB_PATH: join(tmp, "sms.db"),
};
for (const k of Object.keys(env)) if (/^(GMAIL|QUO|TWILIO|SMTP)_/.test(k)) delete env[k];

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
let srvLog = ""; srv.stdout.on("data", (d) => (srvLog += d)); srv.stderr.on("data", (d) => (srvLog += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);
const J = (r) => r.json();
const post = (u, b) => fetch(B + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

try {
  /* ═══════════ API layer ═══════════ */

  // -- the extended activity route --
  let r = await post("/api/crm/lead/lead_1/activity", {
    type: "other", description: "Dropped off a closing gift", subType: "Pop By",
    activityDate: "2026-08-05", author: "team", meta: { Type: "Pop By", Date: "08/05/2026" },
  });
  ok("OTHER activity with a sub-type and a back-date accepted", r.ok, String(r.status));
  let snap = await J(await fetch(B + "/api/dashboard/data"));
  let row = snap.leads.find((l) => l.id === "lead_1");
  let popBy = (row.activity || []).find((a) => /closing gift/.test(a.description));
  ok("sub-type round-trips through the normalizer", popBy && popBy.subType === "Pop By", JSON.stringify(popBy));
  ok("author round-trips", popBy && popBy.author === "team");
  ok("meta round-trips (the field the normalizer would otherwise destroy)", popBy && popBy.meta && popBy.meta.Type === "Pop By", JSON.stringify(popBy && popBy.meta));
  ok("the entry is dated the day it happened, not today", popBy && popBy.timestamp.slice(0, 10) === "2026-08-05", popBy && popBy.timestamp);
  ok("a back-dated log does NOT move last-touched forward", !String(row.lastActivity || "").startsWith(new Date().toISOString().slice(0, 10)), String(row.lastActivity));
  ok("last-touched falls back to the newest real touch on the record", String(row.lastActivity || "").slice(0, 10) === "2026-08-18", String(row.lastActivity));

  ok("a future activity date is refused", (await post("/api/crm/lead/lead_1/activity", { type: "other", description: "x", activityDate: "2099-01-01" })).status === 400);
  ok("a malformed activity date is refused", (await post("/api/crm/lead/lead_1/activity", { type: "other", description: "x", activityDate: "08/05/2026" })).status === 400);

  r = await post("/api/crm/lead/lead_1/activity", { type: "call", description: "No Answer", subType: "No Answer", meta: { Outcome: "No Answer", Number: "(817) 995-4677" } });
  ok("CALL logged with its outcome", r.ok);

  // -- messaging status --
  const status = (await J(await fetch(B + "/api/crm/messaging-status"))).channels;
  ok("email channel reports it cannot send here", status.email && status.email.ok === false && /Gmail/.test(status.email.reason), JSON.stringify(status.email));
  ok("text channel reports it cannot send here", status.text && status.text.ok === false && /Quo/.test(status.text.reason), JSON.stringify(status.text));
  ok("call is never claimed as dialable", status.call && status.call.ok === false && /softphone|click-to-dial/i.test(status.call.reason), JSON.stringify(status.call));
  ok("calendar sync is never claimed", status.calendar && status.calendar.ok === false && /Google Calendar/.test(status.calendar.reason));

  // -- send-email refuses cleanly with Gmail absent --
  r = await post("/api/crm/lead/lead_1/send-email", { to: "composer@example.com", subject: "Hi", html: "<p>Hi</p>" });
  ok("send-email fails loudly rather than silently logging a send", r.status === 502, String(r.status));
  snap = await J(await fetch(B + "/api/dashboard/data"));
  row = snap.leads.find((l) => l.id === "lead_1");
  ok("no email_sent entry was written for a send that failed", !(row.activity || []).some((a) => a.type === "email_sent"), JSON.stringify((row.activity || []).map((a) => a.type)));
  ok("send-email validates the recipient", (await post("/api/crm/lead/lead_1/send-email", { to: "nope", subject: "x", html: "y" })).status === 400);
  ok("send-email 404s on an unknown lead", (await post("/api/crm/lead/nope/send-email", { to: "a@b.co", subject: "x", html: "y" })).status === 404);

  // -- a real task, so the timeline has a TASK entry --
  r = await post("/api/crm-tasks", { title: "Call about Canyon Lake", type: "appointment", priority: "high", dueDate: "2026-08-25", leadId: "lead_1", leadName: "Composer Lead", assignedUserName: "Marco Puga" });
  ok("task created for the timeline", r.ok);

  // -- the unified timeline --
  let tl = await J(await fetch(B + "/api/crm/lead/lead_1/timeline"));
  ok("timeline returns items", Array.isArray(tl.items) && tl.items.length >= 4, String(tl.items && tl.items.length));
  const cats = new Set(tl.items.map((i) => i.category));
  ok("it merges more than one source", cats.has("call") && cats.has("other") && cats.has("task"), [...cats].join(","));
  ok("counts are per category and total", tl.counts.all === tl.items.length && tl.counts.call >= 2 && tl.counts.other >= 1, JSON.stringify(tl.counts));
  ok("newest first", tl.items.every((it, i) => i === 0 || String(tl.items[i - 1].at) >= String(it.at)));
  const popCard = tl.items.find((i) => /closing gift/.test(i.body || ""));
  ok("the OTHER card carries its sub-type", popCard && popCard.subType === "Pop By", JSON.stringify(popCard));
  const taskCard = tl.items.find((i) => i.category === "task");
  ok("the task card carries its due date and assignee", taskCard && taskCard.detail && /2026-08-25/.test(String(taskCard.detail.Due)) && taskCard.detail["Assigned To"] === "Marco Puga", JSON.stringify(taskCard && taskCard.detail));
  ok("timeline 404s on an unknown lead", (await fetch(B + "/api/crm/lead/nope/timeline")).status === 404);

  // -- the honesty payload --
  const scopes = (tl.unavailable || []).map((u) => u.scope);
  ok("the endpoint names what it cannot cover", scopes.includes("email") && scopes.includes("web") && scopes.includes("profile"), JSON.stringify(scopes));
  ok("the email limit says no tracking, not zero", (tl.unavailable.find((u) => u.scope === "email") || {}).reason.match(/no opens or clicks/i) !== null);

  /* ═══════════ browser layer ═══════════ */

  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await br.newPage({ viewport: { width: 1600, height: 1100 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  await page.goto(B + "/crm", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag") && /Live data/.test(document.querySelector(".demo-tag").textContent), null, { timeout: 15000 });
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Composer Lead")');
  await page.waitForSelector("#ldTabBody");
  const tab = async (t) => { await page.click(`#ldTabs button[data-t="${t}"]`); await page.waitForTimeout(350); };

  /* ── spec 1A: NOTE tab ── */
  ok("NOTE is the default tab", await page.$eval('#ldTabs button[data-t="note"]', (b) => b.classList.contains("on")));
  await page.waitForSelector("#qaNote");
  ok("visibility indicator states notes are hidden from viewers", /hidden from viewers/i.test(await page.textContent("#qaVis")));
  ok("AI: HELP ME WRITE present", (await page.$("#qaAi")) !== null);
  ok("importance star present and off", (await page.$("#qaStar")) !== null && !(await page.$eval("#qaStar", (e) => e.classList.contains("on"))));
  ok("SAVE is disabled while the note is empty", await page.$eval("#qaSave", (b) => b.disabled));
  await page.fill("#qaNote", "Wants a waterfront under 600k");
  ok("SAVE enables once there is text", !(await page.$eval("#qaSave", (b) => b.disabled)));
  await page.click("#qaStar");
  ok("the star toggles on", await page.$eval("#qaStar", (e) => e.classList.contains("on")));
  // @mention typeahead on the composer's own textarea
  await page.click("#qaNote");
  await page.type("#qaNote", " @Ken");
  // Scoped to the composer: the left panel has its own .ta-list (tags).
  const mention = page.locator("#ldTabBody .ta-list button").first();
  await mention.waitFor({ timeout: 5000 });
  await page.waitForTimeout(250);
  ok("@mention typeahead opens on the composer", /Kendrick/.test(await mention.textContent()));
  await mention.dispatchEvent("mousedown");
  await page.waitForTimeout(250);
  await page.click("#qaSave");
  await page.waitForTimeout(900);
  let notes = (await J(await fetch(B + "/api/crm/lead/lead_1/record"))).record.notes;
  const saved = notes.find((n) => /waterfront under 600k/.test(n.body));
  ok("the note saved from the composer", !!saved, JSON.stringify(notes.map((n) => n.body)));
  ok("it carries the importance star and the mention", saved && saved.important === true && saved.mentions.length === 1, JSON.stringify(saved && { i: saved.important, m: saved.mentions }));

  /* ── spec 1B: EMAIL tab ── */
  await tab("email");
  await page.waitForSelector("#qaBody");
  ok("recipient defaults to the contact's primary email", /composer@example\.com/.test(await page.$eval("#qaTo", (e) => e.value || e.textContent)));
  ok("CC and BCC are add-pills, not always-on fields", (await page.$("#qaCcBtn")) !== null && (await page.$("#qaCc")) === null);
  await page.click("#qaCcBtn");
  await page.waitForSelector("#qaCc");
  ok("+ CC reveals the CC field", true);
  ok("subject field present", (await page.$("#qaSubj")) !== null);
  ok("template search present", (await page.$("#qaTpl")) !== null);
  const tbBtns = await page.$$eval("#qaTb button", (els) => els.length);
  ok("the rich-text toolbar has the spec's controls", tbBtns >= 12, String(tbBtns));
  ok("the body is a contenteditable editor", await page.$eval("#qaBody", (e) => e.getAttribute("contenteditable") === "true"));
  ok("a signature is pre-loaded", /Marco Puga/.test(await page.textContent("#qaBody")));
  ok("ADD ATTACHMENT present", (await page.$("#qaAttBtn")) !== null);
  ok("'Send me a copy' present", (await page.$("#qaCopy")) !== null);
  // Gmail is not connected here, so SEND must be disabled with the reason shown.
  ok("SEND is disabled because Gmail is not connected", await page.$eval("#qaSend", (b) => b.disabled));
  ok("the reason is shown next to it", /Gmail is not connected/.test(await page.textContent("#ldTabBody")));
  // Formatting actually applies
  await page.click("#qaBody");
  await page.evaluate(() => { const e = document.getElementById("qaBody"); e.innerHTML = "<p>plain</p>"; const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.click('#qaTb button[data-cmd="bold"]');
  ok("the Bold control actually formats the body", /<b>|<strong>/i.test(await page.$eval("#qaBody", (e) => e.innerHTML)), await page.$eval("#qaBody", (e) => e.innerHTML));

  /* ── spec 1C: CALL tab ── */
  await tab("call");
  await page.waitForSelector("#qaOut");
  const outs = await page.$$eval("#qaOut button", (els) => els.map((e) => e.textContent.trim()));
  ok("all six call outcomes offered", outs.join(",") === "Talked,Left Message,Busy,Failed,No Answer,Wrong Number", outs.join(","));
  ok("the phone selector lists the contact's numbers", (await page.$("#qaCallNum")) !== null);
  ok("no dial button is drawn, and the tab says why", (await page.$("#qaCallBtn")) === null && /nothing here dials/i.test(await page.textContent("#ldTabBody")));
  ok("SAVE & LOG CALL is disabled until an outcome is picked", await page.$eval("#qaLogCall", (b) => b.disabled));
  await page.click('#qaOut button[data-o="Left Message"]');
  ok("picking an outcome enables it", !(await page.$eval("#qaLogCall", (b) => b.disabled)));
  await page.fill("#qaCallNote", "Left a voicemail about the price cut");
  await page.click("#qaLogCall");
  await page.waitForTimeout(900);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  row = snap.leads.find((l) => l.id === "lead_1");
  const callEntry = (row.activity || []).find((a) => /price cut/.test(a.description || "") || /price cut/.test(a.notes || ""));
  ok("the call logged with its outcome as the sub-type", callEntry && callEntry.subType === "Left Message", JSON.stringify(callEntry));

  /* ── DNC surfaces on the call tab ── */
  await post("/api/crm/lead/lead_1/phones", { number: "2145550199", kind: "home", dnc: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag") && /Live data/.test(document.querySelector(".demo-tag").textContent), null, { timeout: 15000 });
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Composer Lead")');
  await page.waitForSelector("#ldTabBody");
  await tab("call");
  await page.selectOption("#qaCallNum", { index: 1 });
  await page.waitForTimeout(400);
  ok("selecting a DNC number shows the red pill", (await page.$("#qaCallNum ~ .cx-dnc, #ldTabBody .cx-dnc")) !== null);
  ok("and a compliance warning", /Do Not Call/.test(await page.textContent("#ldTabBody")));

  /* ── spec 1D: TEXT tab ── */
  await tab("text");
  await page.waitForSelector("#qaTextMsg");
  ok("the To: phone selector is present", (await page.$("#qaTextNum")) !== null);
  ok("an engagement/last-seen indicator is shown", (await page.$("#ldTabBody .qa-seen")) !== null);
  ok("the 2-way chat container renders", (await page.$("#qaChat")) !== null);
  ok("SEND MESSAGE is disabled because Quo is not configured", await page.$eval("#qaSendText", (b) => b.disabled));
  ok("the reason is shown", /Quo is not configured/.test(await page.textContent("#ldTabBody")));
  await page.fill("#qaTextMsg", "Hi Maria, quick question about Saturday");
  ok("the segment counter reflects what was typed", /characters/.test(await page.textContent("#qaLen")), await page.textContent("#qaLen"));

  /* ── spec 1E: APPOINTMENT tab ── */
  await tab("appointment");
  await page.waitForSelector("#qaApTitle");
  const groups = await page.$$eval("#qaApType optgroup", (els) => els.map((e) => e.label));
  ok("appointment types are grouped as the spec lists them", groups.join("|") === "Real Estate Consultation|Recruiting / Administrative", groups.join("|"));
  const datePills = await page.$$eval("#qaApDate button", (els) => els.map((e) => e.textContent.trim()));
  ok("the date quick-pills are the spec's", datePills.join(",").startsWith("Today,Tomorrow,7 Days,30 Days,90 Days"), datePills.join(","));
  const timePills = await page.$$eval("#qaApTime button", (els) => els.map((e) => e.textContent.trim()));
  ok("the time quick-pills are the spec's", timePills.join(",").startsWith("Morning 8 am,Afternoon 12 pm,Evening 5 pm,11:00 PM"), timePills.join(","));
  ok("priority runs 1 to 9 and defaults to 9", (await page.$$eval("#qaApPrio button", (e) => e.length)) === 9 && (await page.$eval('#qaApPrio button[data-p="9"]', (b) => b.classList.contains("on"))));
  ok("CREATE is disabled until there are task details", await page.$eval("#qaApCreate", (b) => b.disabled));
  ok("Google Calendar sync is stated as absent, not toggled", /No Google Calendar account is connected/.test(await page.textContent("#ldTabBody")));
  // the two expanders
  ok("+ ADD INSTRUCTIONS and + ADD NOTES are collapsed", (await page.$("#qaApInstr")) === null && (await page.$("#qaApNotes")) === null);
  await page.click("#qaApAddInstr");
  await page.waitForSelector("#qaApInstr");
  ok("+ ADD INSTRUCTIONS expands a dismissable box", (await page.$("#qaApRmInstr")) !== null);
  await page.fill("#qaApInstr", "Bring the comps printout");
  await page.fill("#qaApTitle", "Showing at 55 Canyon Lake Dr");
  await page.selectOption("#qaApType", "Showing Appointment");
  await page.click('#qaApTime button[data-t="17:00"]');
  await page.click('#qaApPrio button[data-p="1"]');
  await page.click('#qaApDate button[data-days="1"]');
  await page.waitForTimeout(200);
  await page.click("#qaApCreate");
  await page.waitForTimeout(1000);
  const tasks = (await J(await fetch(B + "/api/crm-tasks?leadId=lead_1"))).tasks || [];
  const made = tasks.find((t) => /55 Canyon Lake/.test(t.title));
  ok("CREATE made a real task", !!made, JSON.stringify(tasks.map((t) => t.title)));
  ok("it carries priority, time and the instructions", made && made.priority === "urgent" && made.dueTime === "17:00" && /comps printout/.test(made.description || ""), JSON.stringify(made));

  /* ── spec 2: OTHER tab ── */
  await tab("other");
  await page.waitForSelector("#qaOtNotes");
  ok("DATE defaults to today", (await page.inputValue("#qaOtDate")) === new Date().toISOString().slice(0, 10));
  ok("the MM/DD/YYYY form is shown alongside it", /^\d{2}\/\d{2}\/\d{4}$/.test((await page.textContent("#qaOtMdy")).trim()), await page.textContent("#qaOtMdy"));
  const otTypes = await page.$$eval("#qaOtType option", (els) => els.map((e) => e.value));
  ok("TYPE offers exactly Other / Pop By / Mail / Social Media", otTypes.join(",") === "Other,Pop By,Mail,Social Media", otTypes.join(","));
  ok("TYPE defaults to Other", (await page.inputValue("#qaOtType")) === "Other");
  ok("SAVE is disabled while NOTES is empty", await page.$eval("#qaOtSave", (b) => b.disabled));
  await page.selectOption("#qaOtType", "Mail");
  ok("choosing a type explains what it means", /postcard/i.test(await page.textContent("#qaOtHint")), await page.textContent("#qaOtHint"));
  await page.fill("#qaOtNotes", "Mailed the quarterly market postcard");
  await page.fill("#qaOtDate", "2026-08-11");
  await page.waitForTimeout(200);
  ok("SAVE enables once there are notes", !(await page.$eval("#qaOtSave", (b) => b.disabled)));
  await page.click("#qaOtSave");
  await page.waitForTimeout(900);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  row = snap.leads.find((l) => l.id === "lead_1");
  const mailEntry = (row.activity || []).find((a) => /quarterly market postcard/.test(a.description));
  ok("the OTHER entry saved with its type", mailEntry && mailEntry.subType === "Mail", JSON.stringify(mailEntry));
  ok("and with the date the operator picked", mailEntry && mailEntry.timestamp.slice(0, 10) === "2026-08-11", mailEntry && mailEntry.timestamp);
  // CLEAR resets all three fields per the spec
  await page.fill("#qaOtNotes", "scratch");
  await page.selectOption("#qaOtType", "Pop By");
  await page.click("#qaClear");
  await page.waitForTimeout(300);
  ok("CLEAR resets NOTES, DATE and TYPE", (await page.inputValue("#qaOtNotes")) === "" && (await page.inputValue("#qaOtType")) === "Other" && (await page.inputValue("#qaOtDate")) === new Date().toISOString().slice(0, 10));

  /* ── drafts survive a tab switch but not a contact switch ── */
  await page.fill("#qaOtNotes", "half written");
  await tab("note");
  await tab("other");
  ok("a draft survives switching tabs and back", (await page.inputValue("#qaOtNotes")) === "half written");
  await page.click("#ldBack");
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Second Person")');
  await page.waitForSelector("#ldTabBody");
  await tab("other");
  ok("a draft does NOT follow to the next contact", (await page.inputValue("#qaOtNotes")) === "", await page.inputValue("#qaOtNotes"));
  await page.click("#ldBack");
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Composer Lead")');
  await page.waitForSelector("#ldTabBody");

  /* ── spec 3: the activity timeline ── */
  await page.waitForFunction(() => document.querySelectorAll("#tlBar button").length === 9, null, { timeout: 8000 });
  const bar = await page.$$eval("#tlBar button", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  ok("the filter bar has all nine pills", bar.length === 9, JSON.stringify(bar));
  ok("each pill carries an icon, a label and a count", bar.every((t) => /\S+ \w[\w ]* \d+$/.test(t)), JSON.stringify(bar.slice(0, 3)));
  ok("ALL is first and totals the feed", /^◍ All \d+/.test(bar[0]), bar[0]);
  const disabledPills = await page.$$eval("#tlBar button[disabled]", (els) => els.map((e) => e.getAttribute("data-tl")));
  ok("a kind with nothing logged is disabled and still shows its zero", disabledPills.length > 0 && bar.some((t) => / 0$/.test(t)), JSON.stringify(disabledPills));

  // typed cards
  const cardTxt = await page.textContent("#ldTimeline");
  ok("the feed shows the call", /called this contact/.test(cardTxt) && /Left Message/.test(cardTxt), cardTxt.slice(0, 200));
  ok("card titles read as actions, not type names", /logged by|called this contact|added a note/.test(cardTxt));
  ok("the feed shows the OTHER entry with its type", /quarterly market postcard/.test(cardTxt) && /Mail logged by/.test(cardTxt));
  // the sub-type is a pill; repeating it as a "Type:" line said the same word twice
  ok("the sub-type is not repeated as a detail line", !/Type:\s*Mail/.test(cardTxt), cardTxt.slice(0, 240));
  ok("the feed shows the task", /Task (created|completed)/.test(cardTxt));
  ok("timestamps are exact, not relative", /\d{2}\/\d{2}\/\d{2} at \d{1,2}:\d{2} (am|pm)/.test(cardTxt), cardTxt.slice(0, 120));
  ok("icon circles are colour-coded per category", (await page.$$eval("#ldTimeline .ico", (els) => new Set(els.map((e) => e.className)).size)) > 1);

  // filtering
  await page.click('#tlBar button[data-tl="call"]');
  await page.waitForTimeout(300);
  const callOnly = await page.$$eval("#ldTimeline .ico", (els) => els.map((e) => e.className));
  ok("filtering to Calls shows only call cards", callOnly.length > 0 && callOnly.every((c) => /\bcall\b/.test(c)), JSON.stringify(callOnly));
  await page.click('#tlBar button[data-tl="all"]');
  await page.waitForTimeout(300);
  ok("ALL restores the full feed", (await page.$$eval("#ldTimeline .tlc", (e) => e.length)) > callOnly.length);

  // the honesty note
  const tlNote = await page.textContent("#crFeed");
  ok("the feed names what it cannot show", /no opens or clicks/i.test(tlNote) && /no website visit tracking/i.test(tlNote), tlNote.slice(-260));
  ok("no email card claims a zero-open count", !/0 OPENS/.test(await page.textContent("#ldTimeline")));

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("\nFAILURES:\n" + fail.map((f) => " - " + f).join("\n")); if (srvLog) console.error("\n--- server log tail ---\n" + srvLog.slice(-2500)); process.exit(1); }
