#!/usr/bin/env node
/**
 * Right-stack widget verification — the five specs of Aug 2026:
 * Assigned To + Manage Team, Web Activity, Agreements (referral/buyer/seller),
 * Appointments, and Tasks with contingent dating.
 *
 * Usage: node scripts/verify-crm-widgets.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3405);
const B = `http://localhost:${PORT}`;

let pass = 0; const fail = [];
const ok = (n, c, detail) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (detail ? " — " + detail : "")); console.error("FAIL " + n + (detail ? " — " + detail : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "crm-wdg-"));
const mkLead = (n, over) => ({
  id: "lead_" + n, platform: "tiktok", userId: "u" + n, username: "user" + n,
  name: over.name, phone: over.phone ?? null, email: over.email ?? null, address: over.address ?? null,
  state: "new", source: "TikTok", adCampaign: null, propertyInquired: null, criteria: null, brivityId: null,
  crmStatus: "new", crmStage: "new", crmPriority: "normal", crmIntent: "buyer", crmCallQueue: "none", crmNotes: null,
  tags: [], createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
  birthday: over.birthday ?? null, homeAnniversary: over.homeAnniversary ?? null,
  assignedUserId: over.assignedUserId ?? null, assignedUserName: over.assignedUserName ?? null,
  activity: [],
});
const leads = [
  mkLead(1, { name: "Widget Lead", email: "widget@example.com", phone: "8179954677", address: "900 Elm St",
    birthday: "1985-12-24", assignedUserId: "marco", assignedUserName: "Marco" }),
  mkLead(2, { name: "Partner Person", phone: "2105550210", email: "partner@example.com" }),
  mkLead(3, { name: "No Dates Person", phone: "2105550211", email: "nodates@example.com" }),
];
const db = { idCounter: 10, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] };
for (const l of leads) { db.leadsById[l.id] = l; db.leadKeyToId[l.platform + "::" + l.userId] = l.id; db.conversationsByLeadId[l.id] = { messages: [] }; }
writeFileSync(join(tmp, "db.json"), JSON.stringify(db));

const env = { ...process.env, PORT: String(PORT),
  /* These suites exercise the app, not the door. The site lock defaults to ON
     as of 2026-08-22, so it is switched off explicitly here rather than every
     fixture growing a login step. scripts/verify-site-lock.mjs is the one that
     tests the lock, and it deliberately sets nothing. */
  SITE_LOGIN_ENABLED: "0",
  DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  AUTO_PLANS_JSON_PATH: join(tmp, "auto-plans.json"), USER_PREFS_JSON_PATH: join(tmp, "user-prefs.json"),
  TRANSACTIONS_DB_PATH: join(tmp, "transactions.db"), CONTACT_RECORD_DB_PATH: join(tmp, "contact-records.db"),
  CONTACT_DOCS_DIR: join(tmp, "contact-docs"), OUTREACH_DB_PATH: join(tmp, "outreach.db"),
  SMS_DB_PATH: join(tmp, "sms.db"), FAVORITES_DB_PATH: join(tmp, "favorites.db"),
};
const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
let srvLog = ""; srv.stdout.on("data", (d) => (srvLog += d)); srv.stderr.on("data", (d) => (srvLog += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);
const J = (r) => r.json();
const post = (u, b) => fetch(B + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const put = (u, b) => fetch(B + u, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

try {
  /* ═══════════ API layer ═══════════ */

  /* ── spec 1: team ── */
  let team = await J(await fetch(B + "/api/crm/lead/lead_1/team"));
  ok("team endpoint returns the primary from the Lead", team.primary && team.primary.userId === "marco", JSON.stringify(team.primary));
  ok("it offers the nine functional roles", Array.isArray(team.roles) && team.roles.length === 9 && team.roles.includes("Transaction Coordinator"), JSON.stringify(team.roles));
  ok("it returns the real roster", Array.isArray(team.roster) && team.roster.some((m) => m.id === "wesley" && m.role), JSON.stringify(team.roster && team.roster[0]));

  let r = await put("/api/crm/lead/lead_1/team", {
    primary: { userId: "wesley" },
    members: [{ userId: "carlos", roleName: "Transaction Coordinator" }, { userId: "kendrick", roleName: "" }],
  });
  ok("saving the team succeeds", r.ok);
  let saved = await J(r);
  ok("the primary moved onto the Lead itself", saved.primary.userId === "wesley");
  let snap = await J(await fetch(B + "/api/dashboard/data"));
  ok("and the lead row agrees", snap.leads.find((l) => l.id === "lead_1").assignedUserId === "wesley");
  ok("the roster's own name wins over whatever was posted", saved.primary.userName === "Wesley", saved.primary.userName);
  ok("members saved with and without a role", saved.members.length === 2 && saved.members.find((m) => m.userId === "carlos").roleName === "Transaction Coordinator" && saved.members.find((m) => m.userId === "kendrick").roleName === "", JSON.stringify(saved.members));

  saved = await J(await put("/api/crm/lead/lead_1/team", { members: [{ userId: "carlos", roleName: "Broker" }, { userId: "carlos", roleName: "Listing Agent" }] }));
  ok("the same person twice collapses to one row", saved.members.length === 1, JSON.stringify(saved.members));
  ok("omitting `primary` leaves ownership alone", saved.primary.userId === "wesley");
  saved = await J(await put("/api/crm/lead/lead_1/team", { members: [] }));
  ok("saving an empty list clears the members", saved.members.length === 0);

  /* ── spec 2: web activity ── */
  let wa = await J(await fetch(B + "/api/crm/lead/lead_1/web-activity"));
  ok("visits is null, never zero", wa.summary.visits === null, JSON.stringify(wa.summary));
  ok("it says why there is no visit count", (wa.unavailable || []).some((u) => u.scope === "visits" && /no IDX website/i.test(u.reason)), JSON.stringify(wa.unavailable));
  ok("views and favorites start at a real zero", wa.summary.views === 0 && wa.summary.favorites === 0);
  ok("avgPrice is null with nothing viewed", wa.summary.avgPrice === null);

  /* Real engagement, written straight into the same outreach DB the server
     reads. The env var has to be set in THIS process too — the spawn env only
     covers the child, and without it the import would open the default file. */
  process.env.OUTREACH_DB_PATH = join(tmp, "outreach.db");
  const eng = await import(join(process.cwd(), "dist/src/core/outreachStore.js"));
  eng.recordEngagement({ kind: "alert", subscriptionId: "sub1", leadId: "lead_1", event: "listing_clicked", listingKey: "MLS-A", at: "2026-08-10T10:00:00.000Z" });
  eng.recordEngagement({ kind: "alert", subscriptionId: "sub1", leadId: "lead_1", event: "listing_clicked", listingKey: "MLS-A", at: "2026-08-12T10:00:00.000Z" });
  eng.recordEngagement({ kind: "alert", subscriptionId: "sub1", leadId: "lead_1", event: "listing_clicked", listingKey: "MLS-B", at: "2026-08-11T10:00:00.000Z" });
  eng.recordEngagement({ kind: "report", subscriptionId: "sub2", leadId: "lead_1", event: "email_opened", at: "2026-08-13T10:00:00.000Z" });
  wa = await J(await fetch(B + "/api/crm/lead/lead_1/web-activity"));
  ok("views counts every click, not every property", wa.summary.views === 3, String(wa.summary.views));
  ok("properties are deduped with their own view counts", wa.properties.length === 2 && wa.properties.find((p) => p.listingKey === "MLS-A").views === 2, JSON.stringify(wa.properties.map((p) => [p.listingKey, p.views])));
  ok("email opens are counted separately from listing clicks", wa.summary.emailOpens === 1);
  ok("last activity is the newest event", String(wa.summary.lastActivityAt).startsWith("2026-08-13"), String(wa.summary.lastActivityAt));
  ok("visits is still null with real engagement present", wa.summary.visits === null);

  /* ── spec 3: agreements ── */
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(1024)], { type: "application/pdf" }), "referral.pdf");
  fd.append("kind", "referral");
  fd.append("title", "Widget Lead Referral");
  fd.append("createTransaction", "true");
  fd.append("feeValue", "25");
  fd.append("feeType", "percentage");
  fd.append("referringAgent", "Marco");
  fd.append("partnerName", "Partner Person");
  fd.append("partnerLeadId", "lead_2");
  fd.append("clientIntent", "Seller");
  fd.append("propertyType", "Multi-Family");
  fd.append("signedDate", "2026-08-01");
  fd.append("expirationDate", "2027-08-01");
  r = await fetch(B + "/api/crm/lead/lead_1/agreements", { method: "POST", body: fd });
  ok("referral agreement accepted", r.ok, String(r.status));
  let ag = await J(r);
  ok("it opened a real transaction", !!ag.transactionId);
  ok("it stored the uploaded file", !!ag.documentId && ag.documents.some((d) => d.fileName === "referral.pdf"));
  ok("the agreement carries fee, partner, intent and property type",
    ag.agreement.feeValue === 25 && ag.agreement.feeType === "percentage" && ag.agreement.partnerLeadId === "lead_2" &&
    ag.agreement.clientIntent === "Seller" && ag.agreement.propertyType === "Multi-Family", JSON.stringify(ag.agreement));
  let txs = (await J(await fetch(B + "/api/transactions"))).transactions || [];
  let tx = txs.find((t) => t.id === ag.transactionId);
  ok("the transaction is a referral linked to the contact", tx && tx.dealType === "referral" && tx.leadId === "lead_1", JSON.stringify(tx && { d: tx.dealType, l: tx.leadId }));
  ok("a percentage fee rides along as the commission", tx && tx.parties.commissionPercent === 25, JSON.stringify(tx && tx.parties));

  // a FLAT fee must not be written into commissionPercent
  const fd2 = new FormData();
  fd2.append("kind", "referral"); fd2.append("title", "Flat fee referral");
  fd2.append("createTransaction", "true"); fd2.append("feeValue", "2500"); fd2.append("feeType", "flat");
  r = await fetch(B + "/api/crm/lead/lead_1/agreements", { method: "POST", body: fd2 });
  const flat = await J(r);
  txs = (await J(await fetch(B + "/api/transactions"))).transactions || [];
  tx = txs.find((t) => t.id === flat.transactionId);
  ok("a flat fee is NOT stored as a 2500% commission", tx && tx.parties.commissionPercent === undefined, JSON.stringify(tx && tx.parties));
  ok("the flat fee is kept on the agreement", flat.agreement.feeValue === 2500 && flat.agreement.feeType === "flat");

  /* ── the 25 Aug additions to Add Agreement ── */
  const fd3 = new FormData();
  fd3.append("kind", "buyer"); fd3.append("title", "Buyer with money");
  fd3.append("createTransaction", "true");
  fd3.append("primaryAgent", "Wesley");
  fd3.append("source", "Open House");
  fd3.append("estClosePrice", "425000");
  fd3.append("commissionValue", "3");
  fd3.append("commissionType", "percentage");
  fd3.append("clientIntent", "Buyer");
  fd3.append("propertyType", "Residential");
  r = await fetch(B + "/api/crm/lead/lead_1/agreements", { method: "POST", body: fd3 });
  ok("an agreement accepts primary agent, source, close price and commission", r.ok, String(r.status));
  const money = await J(r);
  ok("all four round-trip onto the agreement",
    money.agreement.primaryAgent === "Wesley" && money.agreement.source === "Open House" &&
    money.agreement.estClosePrice === 425000 && money.agreement.commissionValue === 3,
    JSON.stringify(money.agreement));
  txs = (await J(await fetch(B + "/api/transactions"))).transactions || [];
  tx = txs.find((t) => t.id === money.transactionId);
  /* Primary Agent owns the deal; on a referral that is a different person from
     the referring agent, so the transaction must take THIS one. */
  ok("the transaction is assigned to the primary agent", tx && tx.parties.assignedTo === "Wesley",
    JSON.stringify(tx && tx.parties));
  ok("and carries the estimated close price", tx && tx.price === 425000, JSON.stringify(tx && tx.price));
  ok("a percentage commission rides along", tx && tx.parties.commissionPercent === 3);

  /* A FLAT commission must be refused the same way a flat referral fee is. */
  const fd4 = new FormData();
  fd4.append("kind", "buyer"); fd4.append("title", "Flat commission");
  fd4.append("createTransaction", "true");
  fd4.append("commissionValue", "9000"); fd4.append("commissionType", "flat");
  r = await fetch(B + "/api/crm/lead/lead_1/agreements", { method: "POST", body: fd4 });
  const flatComm = await J(r);
  txs = (await J(await fetch(B + "/api/transactions"))).transactions || [];
  tx = txs.find((t) => t.id === flatComm.transactionId);
  ok("a flat commission is NOT written as a 9000% rate",
    tx && tx.parties.commissionPercent === undefined, JSON.stringify(tx && tx.parties));
  ok("but is kept on the agreement",
    flatComm.agreement.commissionValue === 9000 && flatComm.agreement.commissionType === "flat");

  /* The referral migration list: client alongside the partner. */
  const fd5 = new FormData();
  fd5.append("kind", "referral"); fd5.append("title", "Referral with client");
  fd5.append("createTransaction", "true");
  fd5.append("referringAgent", "Marco");
  fd5.append("partnerName", "Partner Person"); fd5.append("partnerLeadId", "lead_2");
  fd5.append("clientName", "Widget Lead"); fd5.append("clientLeadId", "lead_1");
  r = await fetch(B + "/api/crm/lead/lead_1/agreements", { method: "POST", body: fd5 });
  const withClient = await J(r);
  ok("a referral records the client separately from the partner",
    withClient.agreement.clientLeadId === "lead_1" && withClient.agreement.partnerLeadId === "lead_2",
    JSON.stringify(withClient.agreement));

  /* Rows written before these columns existed must still read back. */
  const older = (await J(await fetch(B + "/api/crm/lead/lead_1/agreements"))).agreements
    .find((x) => x.title === "Widget Lead Referral");
  ok("an agreement saved before the new columns still reads back",
    older && older.primaryAgent === "" && older.estClosePrice === null && older.commissionType === "percentage",
    JSON.stringify(older && { p: older.primaryAgent, e: older.estClosePrice, c: older.commissionType }));

  const before = (await J(await fetch(B + "/api/crm/lead/lead_1/agreements"))).agreements.length;
  r = await fetch(B + "/api/crm/agreement/" + ag.agreement.id, { method: "DELETE" });
  const del = await J(r);
  ok("deleting an agreement removes only the agreement row", del.agreements.length === before - 1);
  ok("it keeps the document and the transaction", del.keptDocumentId === ag.documentId && del.keptTransactionId === ag.transactionId);
  ok("the transaction really is still there", ((await J(await fetch(B + "/api/transactions"))).transactions || []).some((t) => t.id === ag.transactionId));

  /* ── specs 4 & 5: appointments and tasks ── */
  r = await post("/api/crm-tasks", {
    title: "Listing consultation", type: "appointment", dueDate: "2026-09-01", dueTime: "17:00",
    priority: "urgent", leadId: "lead_1", leadName: "Widget Lead", assignedUserName: "Wesley",
    appointmentType: "Listing Consultation", appointmentStatus: "scheduled", outcome: "none",
    location: "511 Red Bird St", instructions: "Bring the comps", taskNotes: "They asked about staging",
  });
  ok("appointment created with its own fields", r.ok);
  let made = (await J(r)).task;
  ok("appointmentType round-trips", made.appointmentType === "Listing Consultation", JSON.stringify(made));
  ok("location, instructions and notes round-trip", made.location === "511 Red Bird St" && /comps/.test(made.instructions) && /staging/.test(made.taskNotes));
  // the normalizer rebuilds tasks from a fixed field list; prove nothing is stripped
  let back = ((await J(await fetch(B + "/api/crm-tasks?leadId=lead_1"))).tasks || []).find((t) => t.id === made.id);
  ok("nothing is stripped on the way back out", back.appointmentType === "Listing Consultation" && back.location === "511 Red Bird St" && back.instructions === "Bring the comps", JSON.stringify(back));

  r = await fetch(B + "/api/crm-tasks/" + made.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outcome: "no_show", appointmentStatus: "completed" }) });
  let patched = await J(r);
  ok("outcome can be set from the widget menu", r.ok && patched.task.outcome === "no_show");
  /* A patch of two fields must not erase the ones it never mentioned. */
  ok("patching the outcome keeps the appointment type and location",
    patched.task.appointmentType === "Listing Consultation" && patched.task.location === "511 Red Bird St",
    JSON.stringify(patched.task));

  r = await post("/api/crm-tasks", {
    title: "Door knock the block", type: "door_knock", dueDate: "2026-09-02",
    priority: "normal", leadId: "lead_1", recurring: true, recurringInterval: "weekly",
  });
  ok("the four new task types are accepted", r.ok && (await J(r)).task.type === "door_knock");
  back = ((await J(await fetch(B + "/api/crm-tasks?leadId=lead_1"))).tasks || []).find((t) => /Door knock/.test(t.title));
  ok("recurring round-trips", back.recurring === true && back.recurringInterval === "weekly", JSON.stringify(back));

  // contingent dating: birthday is 1985-12-24, so "3 days before" resolves
  r = await post("/api/crm-tasks", {
    title: "Birthday card", type: "mail", leadId: "lead_1",
    contingent: { days: 3, direction: "before", event: "birthday" },
  });
  ok("a contingent task is accepted without a date", r.ok, String(r.status));
  made = (await J(r)).task;
  ok("the due date was computed from the contact's birthday", /-12-21$/.test(made.dueDate), made.dueDate);
  ok("and it resolved to a FUTURE occurrence, not 1985", made.dueDate > new Date().toISOString().slice(0, 10), made.dueDate);
  ok("the rule itself is kept, not just the date", made.contingent && made.contingent.days === 3 && made.contingent.direction === "before" && made.contingent.event === "birthday", JSON.stringify(made.contingent));

  r = await post("/api/crm-tasks", { title: "Anniversary note", type: "mail", leadId: "lead_3", contingent: { days: 1, direction: "after", event: "anniversary" } });
  ok("a rule the contact has no date for is refused, not defaulted to today", r.status === 400, String(r.status));
  let err = await J(r);
  ok("and it says which date is missing", /home anniversary/i.test(err.error), err.error);

  r = await post("/api/crm-tasks", { title: "Licence check", type: "to_do", leadId: "lead_1", contingent: { days: 1, direction: "after", event: "licensed_since" } });
  ok("a rule nothing in this system records is refused with its own reason", r.status === 400 && /records a licensed-since date/i.test((await J(r)).error));

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
  await page.click('#leadRows .ldlink:has-text("Widget Lead")');
  await page.waitForSelector("#ldAssignRow");

  /* ── Assigned To ── */
  await page.waitForFunction(() => /Wesley/.test(document.getElementById("ldAssignRow").textContent), null, { timeout: 8000 });
  ok("the card shows the primary agent and the label", /Wesley/.test(await page.textContent("#ldAssignRow")) && /Primary Agent/.test(await page.textContent("#ldAssignRow")));
  ok("it has a quick-view caret and a MANAGE pill", (await page.$("#ldAssignCaret")) !== null && (await page.$("#ldAssignBtn")) !== null);

  await page.click("#ldAssignBtn");
  await page.waitForSelector("#mtPrimary");
  ok("MANAGE opens the Manage Team modal", /Manage Team/.test(await page.textContent("#oaOv .oa-head")));
  ok("the helper text is the spec's", /Team members do not need a role to gain access/.test(await page.textContent("#oaOv .mt-help")));
  ok("the primary dropdown is pre-filled", (await page.inputValue("#mtPrimary")) === "wesley");
  ok("no member rows yet", (await page.$$("#mtRows .mt-row")).length === 0);
  await page.click("#mtAdd");
  await page.waitForSelector("#mtRows .mt-row");
  /* Labels, not just behaviour: a rename once mangled these into "SAVE LDTEAM". */
  ok("the modal's buttons read as the spec writes them",
    /\+ ADD TEAM MEMBER/.test(await page.textContent("#mtAdd")) && /^SAVE TEAM$/.test((await page.textContent("#mtSave")).trim()),
    (await page.textContent("#mtAdd")) + " | " + (await page.textContent("#mtSave")));
  ok("+ ADD TEAM MEMBER creates a member and a role dropdown and a trash icon",
    (await page.$('#mtRows [data-mtuser="0"]')) !== null && (await page.$('#mtRows [data-mtrole="0"]')) !== null && (await page.$('#mtRows [data-mtdel="0"]')) !== null);
  const roleOpts = await page.$$eval('#mtRows [data-mtrole="0"] option', (els) => els.map((e) => e.value).filter(Boolean));
  ok("the role list is the spec's nine", roleOpts.length === 9 && roleOpts[0] === "Broker" && roleOpts[8] === "Transaction Coordinator", JSON.stringify(roleOpts));
  await page.selectOption('#mtRows [data-mtuser="0"]', "carlos");
  await page.selectOption('#mtRows [data-mtrole="0"]', "Buyer's Agent");
  await page.click("#mtAdd");
  await page.selectOption('#mtRows [data-mtuser="1"]', "kendrick");
  await page.click('#mtRows [data-mtdel="1"]');
  await page.waitForTimeout(200);
  ok("the trash icon removes a row before saving", (await page.$$("#mtRows .mt-row")).length === 1);
  await page.selectOption("#mtPrimary", "marco");
  await page.click("#mtSave");
  await page.waitForTimeout(900);
  team = await J(await fetch(B + "/api/crm/lead/lead_1/team"));
  ok("SAVE TEAM reassigned the primary", team.primary.userId === "marco", JSON.stringify(team.primary));
  ok("and saved the member with their role", team.members.length === 1 && team.members[0].userId === "carlos" && team.members[0].roleName === "Buyer's Agent", JSON.stringify(team.members));
  ok("the card lists the team member under the primary", /Carlos/.test(await page.textContent("#ldAssignRow")) && /Buyer's Agent/i.test(await page.textContent("#ldAssignRow")));

  /* ── Web Activity ── */
  await page.waitForFunction(() => !/Loading/.test(document.getElementById("ldWebActBlk").textContent), null, { timeout: 8000 });
  const waTxt = await page.textContent("#ldWebActBlk");
  ok("the summary card shows VISITS, VIEWS, FAVORITES and AVG. PRICE", /VISITS/.test(waTxt) && /Views/i.test(waTxt) && /Favorites/i.test(waTxt) && /Avg\. Price/i.test(waTxt), waTxt.slice(0, 160));
  ok("VISITS renders as a dash, not a zero", /VISITS:\s*—/.test(waTxt.replace(/\s+/g, " ")), waTxt.slice(0, 80));
  const waBox = await page.textContent("#ldWebActBlk .wa-box");
  ok("VIEWS shows the measured click count", /Views\s*3/.test(waBox), waBox.replace(/\s+/g, " "));
  await page.click("#ldWebActView");
  await page.waitForSelector("#waGroup");
  ok("VIEW opens the Web Activity modal", /Web Activity/.test(await page.textContent("#oaOv .oa-head")));
  const groupOpts = await page.$$eval("#waGroup option", (els) => els.map((e) => e.textContent.trim()));
  ok("distribution can be grouped the five ways", groupOpts.join(",") === "Price,Beds,Baths,City,Zip Code", groupOpts.join(","));
  ok("a segmented distribution bar renders", (await page.$$("#oaOv .wa-bar span")).length >= 1);
  const sortOpts = await page.$$eval("#waSort option", (els) => els.map((e) => e.textContent.trim()));
  ok("sort offers Most Recent / Most Views / Oldest", sortOpts.join(",") === "Most Recent,Most Views,Oldest", sortOpts.join(","));
  ok("the property/saved toggle shows both counts", /Unique Properties Viewed \(2\)/.test(await page.textContent("#oaOv")), (await page.textContent("#oaOv")).slice(0, 200));
  ok("property cards render with a view count", (await page.$$("#oaOv .wa-card")).length === 2 && /VIEWS: 2/.test(await page.textContent("#oaOv")));
  await page.selectOption("#waSort", "views");
  await page.waitForTimeout(300);
  ok("sorting by Most Views puts the twice-viewed listing first", /VIEWS: 2/.test(await page.textContent("#oaOv .wa-card")));
  ok("the modal states what it cannot measure", /no IDX website/i.test(await page.textContent("#oaOv .oa-unav")));
  await page.click("#oaOv .oa-cancel");
  await page.waitForTimeout(200);

  /* ── Agreements ── */
  await page.click('#leadDetail [data-agree="referral"]');
  await page.waitForSelector("#agTitle");
  ok("+ REFERRAL opens the Add Agreement modal", /Add Agreement/.test(await page.textContent("#oaOv .oa-head")));
  /* The page has a catch-all that toasts "will create records once live data
     is finalized" at any + button it does not recognise. These three do real
     work, so that placeholder must not fire underneath the modal. */
  ok("no placeholder toast contradicts the modal", !/will create records once live data/.test(await page.textContent("#crmToast")), await page.textContent("#crmToast"));
  ok("the dropzone states the 15MB limit", /File Size Limit 15MB/.test(await page.textContent("#agDrop")));
  ok("the transaction toggle starts ON for a referral", await page.$eval("#agTxSw", (e) => e.classList.contains("on")));
  ok("the fee unit toggle defaults to %", await page.$eval('#oaOv [data-fee="percentage"]', (b) => b.classList.contains("on")));
  const intents = await page.$$eval("#agIntent button", (els) => els.map((e) => e.textContent.trim()));
  ok("client intent is the spec's four-way group", intents.join(",") === "Buyer,Seller,Tenant,Landlord", intents.join(","));
  const propOpts = await page.$$eval("#agProp option", (els) => els.map((e) => e.value));
  ok("property type lists the spec's classifications, Residential default", propOpts.length === 8 && propOpts.includes("Manufactured Home") && (await page.inputValue("#agProp")) === "Residential", JSON.stringify(propOpts));
  ok("the referral partner helper link is present", (await page.$("#agQuickAdd")) !== null);
  await page.click('#oaOv [data-fee="flat"]');
  ok("switching to $ highlights the flat unit", await page.$eval('#oaOv [data-fee="flat"]', (b) => b.classList.contains("on")));
  await page.fill("#agFee", "1500");
  await page.click('#agIntent button[data-int="Tenant"]');
  await page.fill("#agPartner", "Partner");
  await page.waitForSelector("#oaOv .ta-list button");
  await page.click('#oaOv .ta-list button:has-text("Partner Person")');
  await page.fill("#agTitle", "Browser referral");
  await page.click("#agSave");
  await page.waitForTimeout(1000);
  const agrees = (await J(await fetch(B + "/api/crm/lead/lead_1/agreements"))).agreements;
  const browserAg = agrees.find((a) => a.title === "Browser referral");
  ok("the agreement saved from the browser", !!browserAg, JSON.stringify(agrees.map((a) => a.title)));
  ok("with the flat fee, the picked intent and the linked partner",
    browserAg && browserAg.feeType === "flat" && browserAg.feeValue === 1500 && browserAg.clientIntent === "Tenant" && browserAg.partnerLeadId === "lead_2",
    JSON.stringify(browserAg));
  ok("the widget lists it", /Browser referral/.test(await page.textContent("#ldAgreeBlk")));

  /* ── Appointments ── */
  await page.waitForFunction(() => !/Loading/.test(document.getElementById("ldApptBlk").textContent), null, { timeout: 8000 });
  const apTxt = await page.textContent("#ldApptBlk");
  ok("the appointment card shows its date/time badge", /09\/01\/26 @ 5:00 PM/.test(apTxt), apTxt.slice(0, 200));
  ok("and Type, Status and Outcome", /Listing Consultation/.test(apTxt) && /Status/.test(apTxt) && /No Show/.test(apTxt), apTxt.slice(0, 260));
  ok("it has a context menu", (await page.$("#ldApptBlk [data-apmenu]")) !== null);

  await page.click("#ldApptAdd");
  await page.waitForSelector("#apTitle");
  ok("+ ADD opens Add Appointment named for the contact", /Add Appointment for Widget/.test(await page.textContent("#oaOv .oa-head")));
  const apGroups = await page.$$eval("#apType optgroup", (els) => els.map((e) => e.label));
  ok("types are grouped", apGroups.length === 2, JSON.stringify(apGroups));
  ok("Google Calendar sync is stated as absent", /No Google Calendar account is connected/.test(await page.textContent("#oaOv")));
  ok("the date presets include Custom and Contingent", (await page.$$eval("#schDate button", (els) => els.map((e) => e.textContent.trim()))).join(",").endsWith("Custom 📅,Contingent"));
  await page.fill("#apTitle", "Second showing");
  await page.click('#schTime button[data-t="12:00"]');
  await page.waitForTimeout(200);
  await page.click('#schDate button[data-days="1"]');
  await page.waitForTimeout(200);
  await page.click("#apCreate");
  await page.waitForTimeout(1000);
  let tasks = (await J(await fetch(B + "/api/crm-tasks?leadId=lead_1"))).tasks || [];
  const second = tasks.find((t) => t.title === "Second showing");
  ok("CREATE made a real appointment", !!second && second.type === "appointment", JSON.stringify(tasks.map((t) => t.title)));
  ok("with the picked time", second && second.dueTime === "12:00", second && second.dueTime);

  /* ── Tasks ── */
  await page.waitForFunction(() => !/Loading/.test(document.getElementById("ldTasksBlk").textContent), null, { timeout: 8000 });
  const tkTxt = await page.textContent("#ldTasksBlk");
  ok("task cards show {Type} — {date}", /Door Knock — 09\/02\/26/.test(tkTxt), tkTxt.slice(0, 220));
  ok("a recurring task says so", /repeats/.test(tkTxt));
  ok("there is a VIEW ALL link", (await page.$("#ldTasksBlk [data-tkall]")) !== null);
  ok("appointments are not duplicated into Tasks", !/Listing consultation/.test(tkTxt));

  await page.click("#ldTaskAdd");
  await page.waitForSelector("#tkTitle");
  ok("+ ADD opens Add Task named for the contact", /Add Task for Widget/.test(await page.textContent("#oaOv .oa-head")));
  const tkTypes = await page.$$eval("#tkType option", (els) => els.map((e) => e.textContent.trim()));
  ok("the seven task types are the spec's", tkTypes.join(",") === "To-Do,Call,Text,Email,Mail,Social Media,Door Knock", tkTypes.join(","));
  ok("CREATE is disabled until there are details", await page.$eval("#tkCreate", (b) => b.disabled));
  ok("a Recurring switch is present and off", (await page.$("#tkRec")) !== null && !(await page.$eval("#tkRec", (e) => e.classList.contains("on"))));
  const timePills = await page.$$eval("#schTime button", (els) => els.map((e) => e.textContent.trim()));
  ok("time presets start with Any Time", timePills[0] === "Any Time", JSON.stringify(timePills));
  await page.click("#schTime button[data-tcustom]");
  await page.waitForSelector("#schTimeIn");
  const quarter = await page.$$eval("#schTimeIn option", (els) => els.length);
  ok("Custom time is a 15-minute dropdown", quarter === 96, String(quarter));

  // contingent mode
  await page.click('#schDate button[data-mode="contingent"]');
  await page.waitForSelector("#ctDays");
  ok("Contingent reveals days, direction and event", (await page.$("#ctDays")) !== null && (await page.$("#ctDir")) !== null && (await page.$("#ctEvent")) !== null);
  const evOpts = await page.$$eval("#ctEvent option", (els) => els.map((e) => e.textContent.trim()));
  ok("the five contingent events are offered", evOpts.join(",") === "Birthdate,Anniversary,Organization End Date,Licensed Since,Organization Start Date", evOpts.join(","));
  await page.selectOption("#ctEvent", "licensed_since");
  await page.waitForTimeout(250);
  ok("an event nothing records says so instead of pretending", /Nothing on a contact records that date/.test(await page.textContent("#oaOv")));
  await page.selectOption("#ctEvent", "birthday");
  await page.waitForTimeout(250);
  await page.fill("#ctDays", "5");
  await page.click('#ctDir button[data-dir="before"]');
  await page.fill("#tkTitle", "Post the birthday card");
  await page.click("#tkCreate");
  await page.waitForTimeout(1000);
  tasks = (await J(await fetch(B + "/api/crm-tasks?leadId=lead_1"))).tasks || [];
  const contingent = tasks.find((t) => t.title === "Post the birthday card");
  ok("a contingent task created from the browser", !!contingent, JSON.stringify(tasks.map((t) => t.title)));
  ok("its date came off the contact's birthday", contingent && /-12-19$/.test(contingent.dueDate), contingent && contingent.dueDate);
  ok("and the rule is stored with it", contingent && contingent.contingent && contingent.contingent.days === 5 && contingent.contingent.direction === "before", JSON.stringify(contingent && contingent.contingent));

  // VIEW ALL
  await page.waitForFunction(() => /birthday card/i.test(document.getElementById("ldTasksBlk").textContent), null, { timeout: 8000 }).catch(() => {});
  await page.click("#ldTasksBlk [data-tkall]");
  await page.waitForSelector("#oaOv .tkc");
  ok("VIEW ALL opens the full task log", (await page.$$("#oaOv .tkc")).length >= 3);
  ok("and shows the contingent rule in words", /days before birthday/.test(await page.textContent("#oaOv")), (await page.textContent("#oaOv")).slice(0, 300));

  /* ── Add Agreement and Add Task in the browser (25 Aug) ── */
  {
    /* An earlier block may have left an overlay up; it swallows clicks. */
    await page.evaluate(() => { if (typeof closeOa === "function") closeOa(); });
    await page.waitForTimeout(250);
    await page.click('#leadDetail [data-agree="buyer"]');
    await page.waitForSelector("#agProp", { timeout: 8000, state: "attached" });
    /* Property Type used to live INSIDE the "Create Active Transaction" block,
       so on a buyer agreement — where that toggle starts off — it was never
       rendered. Reported as the dropdown "opening behind the popup". */
    ok("Property Type is on screen without toggling anything",
      await page.isVisible("#agProp"));
    ok("with the full property-type list",
      (await page.$$eval("#agProp option", (n) => n.length)) === 8);
    ok("Source is a dropdown", !!(await page.$("#agSource")));
    /* Live data spells the same source two ways (source column vs platform). */
    const srcs = await page.$$eval("#agSource option", (n) => n.map((o) => o.value).filter(Boolean));
    const lowered = srcs.filter((x) => x !== "__other").map((x) => x.toLowerCase());
    ok("and its options are de-duplicated case-insensitively",
      lowered.length === new Set(lowered).size, srcs.join(","));
    ok("Other lets a new source be typed", srcs.includes("__other"));

    await page.click("#agTxSw");
    await page.waitForTimeout(200);
    ok("Primary Agent lists the roster", !!(await page.$("#agPrimary")));
    const agents = await page.$$eval("#agPrimary option", (n) => n.map((o) => o.textContent.trim()));
    ok("including Wesley", agents.includes("Wesley"), agents.join(","));
    ok("Est. Close Price is there", !!(await page.$("#agClose")));
    ok("Commission has a $ / % switch", (await page.$$("[data-comm]")).length === 2);
    await page.evaluate(() => closeOa());
    await page.waitForTimeout(200);

    /* The referral form must carry every field on the migration list. */
    await page.click('#leadDetail [data-agree="referral"]');
    await page.waitForSelector("#agClient", { timeout: 8000 });
    for (const [id, label] of [["agTitle", "transaction title"], ["agFee", "referral fee"],
      ["agAgent", "referring agent"], ["agClient", "client"], ["agPartner", "referral partner"]]) {
      ok(`referral carries ${label}`, !!(await page.$("#" + id)));
    }
    ok("client intent is on the referral too", !!(await page.$("#agIntent")));
    /* The client field suggests contacts already in the CRM. */
    await page.fill("#agClient", "Widget");
    await page.waitForTimeout(350);
    const sugg = await page.$$eval(".ta-list button", (n) => n.map((e) => e.textContent.trim()));
    ok("and suggests leads from the CRM", sugg.length > 0, sugg.slice(0, 3).join(" | "));
    await page.evaluate(() => closeOa());
    await page.waitForTimeout(200);

    /* Add Task: Type, Assigned To and the contingent Event are all live. */
    await page.click("#ldTaskAdd");
    await page.waitForSelector("#tkType", { timeout: 8000 });
    const tkTypes = await page.$$eval("#tkType option", (n) => n.map((o) => o.textContent.trim()));
    ok("the task Type dropdown carries every type",
      tkTypes.join(",") === "To-Do,Call,Text,Email,Mail,Social Media,Door Knock", tkTypes.join(","));
    await page.selectOption("#tkType", "door_knock");
    ok("and is actually selectable", (await page.inputValue("#tkType")) === "door_knock");
    const tkWho = await page.$$eval("#tkWho option", (n) => n.map((o) => o.textContent.trim()));
    ok("Assigned To lists the roster including Wesley", tkWho.includes("Wesley"), tkWho.join(","));
    await page.selectOption("#tkWho", { label: "Wesley" });
    ok("and is selectable too", !!(await page.inputValue("#tkWho")));
    await page.click('#schDate button[data-mode="contingent"]');
    await page.waitForSelector("#ctEvent", { timeout: 6000 });
    const evs = await page.$$eval("#ctEvent option", (n) => n.map((o) => o.textContent.trim()));
    ok("the contingent Event dropdown carries all five events",
      evs.join(",") === "Birthdate,Anniversary,Organization End Date,Licensed Since,Organization Start Date",
      evs.join(","));
    await page.evaluate(() => closeOa());
    await page.waitForTimeout(200);
  }

  if (process.env.SHOT_DIR) {
    const D = process.env.SHOT_DIR;
    await page.setViewportSize({ width: 1400, height: 1050 });
    await page.evaluate(() => { if (typeof closeOa === "function") closeOa(); });
    await page.waitForTimeout(200);
    await page.click('#leadDetail [data-agree="buyer"]');
    await page.waitForSelector("#agProp", { timeout: 8000 });
    await page.click("#agTxSw");
    await page.waitForTimeout(300);
    await page.screenshot({ path: D + "/ag-01-buyer.png" });
    await page.evaluate(() => closeOa());
    await page.waitForTimeout(200);
    await page.click('#leadDetail [data-agree="referral"]');
    await page.waitForSelector("#agClient", { timeout: 8000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: D + "/ag-02-referral.png" });
    await page.evaluate(() => closeOa());
    await page.waitForTimeout(200);
  }

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("\nFAILURES:\n" + fail.map((f) => " - " + f).join("\n")); if (srvLog) console.error("\n--- server log tail ---\n" + srvLog.slice(-2500)); process.exit(1); }
