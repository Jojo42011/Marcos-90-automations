#!/usr/bin/env node
/**
 * Contact record verification — the five specs of Aug 2026:
 * profile + address management, notes & relationships, transactions &
 * documents, the 3-column layout, and the middle panel.
 *
 * Same harness as verify-crm-profile-blocks.mjs: boots dist/src/server.js
 * against a seeded temp data dir and drives a real browser.
 *
 * Usage: node scripts/verify-crm-contact-record.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3398);
const B = `http://localhost:${PORT}`;

let pass = 0; const fail = [];
const ok = (n, c, detail) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (detail ? " — " + detail : "")); console.error("FAIL " + n + (detail ? " — " + detail : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "crm-rec-"));
const mkLead = (n, over) => ({
  id: "lead_" + n, platform: "tiktok", userId: "u" + n, username: "user" + n,
  name: over.name, phone: over.phone ?? null, email: over.email ?? null, address: over.address ?? null,
  state: "new", source: "TikTok", adCampaign: null, propertyInquired: null, criteria: null, brivityId: null,
  crmStatus: "new", crmStage: "new", crmPriority: "normal", crmIntent: "buyer", crmCallQueue: "none", crmNotes: null,
  tags: [], createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
});
const leads = [
  mkLead(1, { name: "Record Lead", email: "record@example.com", phone: "8179954677", address: "900 Elm St" }),
  mkLead(2, { name: "Related Person", phone: "2105550210", email: "related@example.com" }),
  // A third row: the CRM keeps its demo set when the live feed has under three.
  mkLead(3, { name: "Third Person", phone: "2105550211", email: "third@example.com" }),
];
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
    CONTACT_RECORD_DB_PATH: join(tmp, "contact-records.db"), CONTACT_DOCS_DIR: join(tmp, "contact-docs"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = ""; srv.stdout.on("data", (d) => (srvLog += d)); srv.stderr.on("data", (d) => (srvLog += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);
const J = (r) => r.json();
const post = (u, b) => fetch(B + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const patch = (u, b) => fetch(B + u, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

try {
  /* ═══════════ API layer ═══════════ */

  // Seeding: the record backfills from the Lead's single-value fields.
  let rec = (await J(await fetch(B + "/api/crm/lead/lead_1/record"))).record;
  ok("record seeds the lead's email as primary", rec.emails.length === 1 && rec.emails[0].address === "record@example.com" && rec.emails[0].isPrimary, JSON.stringify(rec.emails));
  ok("record seeds the lead's phone, formatted", rec.phones.length === 1 && rec.phones[0].number === "(817) 995-4677", JSON.stringify(rec.phones));
  ok("record seeds the lead's address", rec.addresses.length === 1 && rec.addresses[0].street === "900 Elm St");
  ok("seeded phone is not marked DNC", rec.phones[0].dnc === false);
  // Re-opening must not duplicate the seed.
  rec = (await J(await fetch(B + "/api/crm/lead/lead_1/record"))).record;
  ok("re-opening does not duplicate the seed", rec.emails.length === 1 && rec.phones.length === 1 && rec.addresses.length === 1);

  ok("unknown lead 404s", (await fetch(B + "/api/crm/lead/nope/record")).status === 404);

  /* Seeding runs on the first route of ANY kind, not just the GET — a write
     that lands first must not lose the contact's original email and phone. */
  let seeded = await J(await post("/api/crm/lead/lead_3/phones", { number: "9725550123", kind: "work" }));
  ok("a write seeds the record before it adds its own row", seeded.record.emails.length === 1 && seeded.record.emails[0].address === "third@example.com", JSON.stringify(seeded.record.emails));
  ok("the seeded phone stayed primary, the new one did not steal it", seeded.record.phones.length === 2 && seeded.record.phones.find((p) => p.isPrimary).number === "(210) 555-0211", JSON.stringify(seeded.record.phones));

  // Emails: type + primary handoff.
  let r = await post("/api/crm/lead/lead_1/emails", { address: "work@example.com", kind: "work", isPrimary: true });
  ok("second email added as primary", r.ok);
  rec = (await J(r)).record;
  ok("only one email is primary", rec.emails.filter((e) => e.isPrimary).length === 1);
  ok("the new one took the primary", rec.emails.find((e) => e.isPrimary).address === "work@example.com");
  ok("email type stored", rec.emails.find((e) => e.address === "work@example.com").kind === "work");
  let snap = await J(await fetch(B + "/api/dashboard/data"));
  ok("primary email written back onto the Lead", snap.leads.find((l) => l.id === "lead_1").email === "work@example.com");
  ok("junk email rejected 400", (await post("/api/crm/lead/lead_1/emails", { address: "not-an-email" })).status === 400);

  // Deleting the primary promotes the next one rather than leaving none.
  const workId = rec.emails.find((e) => e.address === "work@example.com").id;
  rec = (await J(await fetch(B + "/api/crm/contact-email/" + workId, { method: "DELETE" }))).record;
  ok("deleting the primary promotes the survivor", rec.emails.length === 1 && rec.emails[0].isPrimary);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  ok("Lead follows the promotion", snap.leads.find((l) => l.id === "lead_1").email === "record@example.com");

  // Phones: type, DNC, formatting, and an international number left alone.
  r = await post("/api/crm/lead/lead_1/phones", { number: "2145550199", kind: "home", dnc: true });
  rec = (await J(r)).record;
  const home = rec.phones.find((p) => p.kind === "home");
  ok("phone formatted to (214) 555-0199", home.number === "(214) 555-0199", home.number);
  ok("DNC stored on the row", home.dnc === true);
  r = await post("/api/crm/lead/lead_1/phones", { number: "+44 20 7946 0958", kind: "other" });
  rec = (await J(r)).record;
  ok("non-US number kept verbatim", rec.phones.some((p) => p.number === "+44 20 7946 0958"), JSON.stringify(rec.phones.map((p) => p.number)));
  ok("short phone rejected 400", (await post("/api/crm/lead/lead_1/phones", { number: "123" })).status === 400);

  // Addresses: locale fields.
  r = await post("/api/crm/lead/lead_1/addresses", { kind: "work", street: "1 King St W", apt: "4500", city: "Toronto", region: "on", country: "ca", postalCode: "M5H 1A1" });
  rec = (await J(r)).record;
  const ca = rec.addresses.find((a) => a.country === "CA");
  ok("Canadian address stored with upper-cased region", ca && ca.region === "ON", JSON.stringify(ca));
  ok("address type stored", ca.kind === "work");
  ok("street-less address rejected 400", (await post("/api/crm/lead/lead_1/addresses", { city: "Nowhere" })).status === 400);

  // Social: handle → URL, full URL kept, javascript: refused, blank removes.
  r = await fetch(B + "/api/crm/lead/lead_1/social", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ links: { instagram: "@marcopuga", linkedin: "https://linkedin.com/in/marco", x: "javascript:alert(1)", facebook: "" } }) });
  let social = (await J(r)).social;
  const byP = Object.fromEntries(social.map((s) => [s.platform, s.url]));
  ok("bare handle becomes a profile URL", byP.instagram === "https://instagram.com/marcopuga", byP.instagram);
  ok("full URL kept verbatim", byP.linkedin === "https://linkedin.com/in/marco");
  ok("javascript: scheme refused", !byP.x, String(byP.x));
  ok("blank removes rather than storing an empty link", !("facebook" in byP));
  ok("social comes back in platform order", social.map((s) => s.platform).join(",") === "linkedin,instagram", social.map((s) => s.platform).join(","));

  // Notes: mentions, hidden default, activity mirror.
  r = await post("/api/crm/lead/lead_1/notes", { body: "Spoke with @Carlos about the Canyon Lake listing", important: true, author: "team", mentions: [{ memberId: "carlos", memberName: "Carlos" }] });
  ok("note created", r.ok);
  let notes = (await J(r)).notes;
  ok("note stores its mention", notes[0].mentions.length === 1 && notes[0].mentions[0].memberId === "carlos");
  ok("note is hidden from viewers by default", notes[0].hiddenFromViewers === true);
  ok("importance star stored", notes[0].important === true);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  ok("note also lands on the activity feed", (snap.leads.find((l) => l.id === "lead_1").activity || []).some((a) => a.type === "note" && /Canyon Lake/.test(a.description)));
  ok("empty note rejected 400", (await post("/api/crm/lead/lead_1/notes", { body: "   " })).status === 400);

  // UI prefs.
  r = await fetch(B + "/api/settings/ui-prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: "team", prefs: { contactAiCollapsed: true } }) });
  ok("ui prefs saved", r.ok && (await J(r)).prefs.contactAiCollapsed === true);
  r = await fetch(B + "/api/settings/ui-prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: "team", prefs: { somethingElse: "x" } }) });
  let prefs = (await J(r)).prefs;
  ok("ui prefs merge rather than replace", prefs.contactAiCollapsed === true && prefs.somethingElse === "x", JSON.stringify(prefs));
  ok("ui prefs need a user", (await fetch(B + "/api/settings/ui-prefs?user=")).status === 400);

  // Documents: multipart upload, the 15MB ceiling, and the transaction toggle.
  const upload = async (name, bytes, extra) => {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: "application/pdf" }), name);
    fd.append("docType", (extra && extra.docType) || "buyer_representation");
    if (extra) for (const k of Object.keys(extra)) if (k !== "docType") fd.append(k, extra[k]);
    return fetch(B + "/api/crm/lead/lead_1/documents", { method: "POST", body: fd });
  };
  r = await upload("agreement.pdf", new Uint8Array(2048), { signedDate: "2026-08-10", expirationDate: "2027-08-10" });
  ok("document uploaded", r.ok, String(r.status));
  let docs = (await J(r)).documents;
  ok("document metadata stored", docs[0].fileName === "agreement.pdf" && docs[0].bytes === 2048 && docs[0].docType === "buyer_representation", JSON.stringify(docs[0]));
  ok("signed + expiration dates stored", docs[0].signedDate === "2026-08-10" && docs[0].expirationDate === "2027-08-10");
  ok("no transaction opened when the toggle is off", docs[0].transactionId === null);
  const fileRes = await fetch(B + "/api/crm/contact-document/" + docs[0].id + "/file");
  ok("the stored file streams back", fileRes.ok && (await fileRes.arrayBuffer()).byteLength === 2048);

  r = await upload("with-tx.pdf", new Uint8Array(64), { docType: "listing_agreement", createTransaction: "true", transactionAddress: "55 Canyon Lake Dr" });
  const withTx = await J(r);
  ok("Create Pipeline Transaction opened a real transaction", !!withTx.transactionId, JSON.stringify(withTx).slice(0, 120));
  const txs = (await J(await fetch(B + "/api/transactions"))).transactions || [];
  ok("the transaction is in the pipeline store, linked to the contact", txs.some((t) => t.id === withTx.transactionId && t.leadId === "lead_1" && t.address === "55 Canyon Lake Dr"), JSON.stringify(txs.map((t) => t.address)));

  r = await upload("huge.pdf", new Uint8Array(15 * 1024 * 1024 + 10));
  ok("a file over 15MB is refused 413", r.status === 413, String(r.status));

  const delDoc = await fetch(B + "/api/crm/contact-document/" + docs[0].id, { method: "DELETE" });
  ok("document deleted", delDoc.ok);
  ok("its file is gone too", (await fetch(B + "/api/crm/contact-document/" + docs[0].id + "/file")).status === 404);

  /* ═══════════ browser layer ═══════════ */

  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await br.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  await page.goto(B + "/crm", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag") && /Live data/.test(document.querySelector(".demo-tag").textContent), null, { timeout: 15000 });
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Record Lead")');
  await page.waitForSelector("#crPanel .acc");

  const openAcc = async (key) => {
    await page.waitForSelector(`#crPanel .acc[data-acc="${key}"]`);
    const isOpen = await page.$eval(`#crPanel .acc[data-acc="${key}"]`, (e) => e.classList.contains("open"));
    if (!isOpen) await page.click(`#crPanel .acc[data-acc="${key}"] .acc-h`);
    await page.waitForFunction((k) => document.querySelector(`#crPanel .acc[data-acc="${k}"]`).classList.contains("open"), key);
  };

  /* ── spec 4: the layout ── */
  const cols = await page.$$eval(".ld-grid.cr3 > .cr-col", (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  ok("three columns render", cols.length === 3, JSON.stringify(cols));
  ok("column 1 within 300–360px", cols[0] >= 300 && cols[0] <= 360, String(cols[0]));
  ok("column 3 within 320–380px", cols[2] >= 320 && cols[2] <= 380, String(cols[2]));
  ok("middle column is the widest and at least 550px", cols[1] >= 550 && cols[1] > cols[0] && cols[1] > cols[2], String(cols[1]));
  const gap = await page.$eval(".ld-grid.cr3", (e) => getComputedStyle(e).columnGap);
  ok("16px gap", gap === "16px", gap);
  const canvas = await page.$eval("#leadDetail", (e) => getComputedStyle(e).backgroundColor);
  ok("canvas is #F0F2F5", canvas === "rgb(240, 242, 245)", canvas);
  const cardCss = await page.$eval(".cr3 .ld-card", (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).borderRadius]);
  ok("cards are white with a 4px radius", cardCss[0] === "rgb(255, 255, 255)" && cardCss[1] === "4px", JSON.stringify(cardCss));
  const rightOrder = await page.$$eval(".ld-grid.cr3 > .cr-col:last-child .rblock h5", (els) => els.map((e) => e.childNodes[0].textContent.trim().replace(/:$/, "")));
  ok("right stack is in the spec's order", rightOrder.join("|") === "Assigned To|Web Activity|Agreements|Appointments|Marketing|Brivity Home App|Tasks|Auto Plans|Listing Alerts|Market Reports|CMA Reports", rightOrder.join("|"));
  const offTxt = await page.$$eval(".ld-grid.cr3 > .cr-col:last-child .wdg-off", (els) => els.map((e) => e.textContent));
  ok("Home App and CMA say what is missing instead of faking a button", offTxt.length === 2 && /no client mobile app/i.test(offTxt[0]) && /No CMA generation/i.test(offTxt[1]), JSON.stringify(offTxt).slice(0, 120));

  /* ── spec 2: phone add with type, formatting, Enter to save ── */
  await openAcc("contact");
  ok("seeded email shows in the panel", /record@example\.com/.test(await page.textContent('#crPanel .acc[data-acc="contact"] .acc-b')));
  await page.click('#crPanel [data-cr="phoneNew"]');
  await page.waitForSelector("#crPhoneIn");
  await page.fill("#crPhoneIn", "5125550143");
  ok("phone auto-formats as you type", (await page.inputValue("#crPhoneIn")) === "(512) 555-0143", await page.inputValue("#crPhoneIn"));
  await page.selectOption("#crPhoneKind", "work");
  await page.check("#crPhoneDnc");
  await page.press("#crPhoneIn", "Enter");
  await page.waitForTimeout(600);
  rec = (await J(await fetch(B + "/api/crm/lead/lead_1/record"))).record;
  const added = rec.phones.find((p) => p.number === "(512) 555-0143");
  ok("Enter saved the phone with its type and DNC", !!added && added.kind === "work" && added.dnc === true, JSON.stringify(added));
  ok("DNC renders as a red pill", (await page.$$('#crPanel .cx-dnc')).length >= 1);
  // Escape cancels.
  await page.click('#crPanel [data-cr="phoneNew"]');
  await page.waitForSelector("#crPhoneIn");
  await page.fill("#crPhoneIn", "9999999999");
  await page.press("#crPhoneIn", "Escape");
  await page.waitForTimeout(300);
  ok("Escape cancelled the active input", (await page.$("#crPhoneIn")) === null);
  rec = (await J(await fetch(B + "/api/crm/lead/lead_1/record"))).record;
  ok("nothing was saved on Escape", !rec.phones.some((p) => /999/.test(p.number)));

  /* ── spec 2: Add Address modal, State type-ahead, US/CA switching ── */
  await page.click('#crPanel [data-cr="addrNew"]');
  await page.waitForSelector("#adStreet");
  ok("address modal defaults to the US locale", (await page.textContent("#adRegionLbl")) === "State" && (await page.textContent("#adPostalLbl")) === "ZIP Code");
  await page.fill("#adStreet", "1200 Summit Ave");
  await page.fill("#adCity", "Fort Worth");
  await page.click("#adRegion");
  await page.fill("#adRegion", "Tex");
  await page.waitForSelector(".ta-list button");
  const taFirst = await page.textContent(".ta-list button");
  ok("state type-ahead filters", /Texas/.test(taFirst), taFirst);
  await page.click('.ta-list button:has-text("Texas")');
  await page.fill("#adPostal", "76102");
  await page.click("#adSave");
  await page.waitForTimeout(700);
  rec = (await J(await fetch(B + "/api/crm/lead/lead_1/record"))).record;
  const tx1 = rec.addresses.find((a) => a.street === "1200 Summit Ave");
  ok("address saved with the picked state code", tx1 && tx1.region === "TX" && tx1.country === "US" && tx1.postalCode === "76102", JSON.stringify(tx1));
  await openAcc("contact");
  const addrTxt = await page.textContent('#crPanel .acc[data-acc="contact"] .acc-b');
  ok("a non-US address names its country in full", /Canada/.test(addrTxt), addrTxt.slice(0, 200));
  ok("a US address does not print a country line", !/United States/.test(addrTxt));

  await page.click('#crPanel [data-cr="addrNew"]');
  await page.waitForSelector("#adCountry");
  await page.selectOption("#adCountry", "CA");
  await page.waitForTimeout(200);
  ok("switching to Canada relabels State → Province", (await page.textContent("#adRegionLbl")) === "Province", await page.textContent("#adRegionLbl"));
  ok("switching to Canada relabels ZIP → Postal Code", (await page.textContent("#adPostalLbl")) === "Postal Code");
  await page.click("#adRegion");
  await page.fill("#adRegion", "Alb");
  await page.waitForSelector(".ta-list button");
  ok("the province list replaced the state list", /Alberta/.test(await page.textContent(".ta-list button")));
  await page.click(".oa-cancel");
  await page.waitForTimeout(200);

  /* ── spec 1: social edit modal ── */
  await openAcc("social");
  await page.click('#crPanel [data-cr="socialEdit"]');
  await page.waitForSelector("#so_facebook");
  await page.fill("#so_facebook", "@marcopugarealty");
  await page.click("#soSave");
  await page.waitForTimeout(600);
  social = (await J(await fetch(B + "/api/crm/lead/lead_1/record"))).record.social;
  ok("handle typed in the modal saved as a URL", social.some((s) => s.platform === "facebook" && s.url === "https://facebook.com/marcopugarealty"), JSON.stringify(social));
  await openAcc("social");
  ok("a linked platform renders as a live anchor", (await page.$('#crPanel a.soc.on.facebook')) !== null);
  ok("an unlinked platform is a dead chip, not a link", (await page.$('#crPanel span.soc[title*="Pinterest"]')) !== null);

  /* ── spec 1: relationships modal gates NEXT until a contact is picked ── */
  await openAcc("relationships");
  await page.click('#crPanel [data-cr="relAdd"]');
  await page.waitForSelector("#rlName");
  ok("NEXT starts disabled", await page.$eval("#rlNext", (b) => b.disabled));
  await page.fill("#rlName", "Related");
  await page.waitForSelector(".ta-list button");
  await page.click('.ta-list button:has-text("Related Person")');
  ok("NEXT enables once a contact is picked", !(await page.$eval("#rlNext", (b) => b.disabled)));
  await page.fill("#rlKind", "Co-buyer");
  await page.click("#rlNext");
  await page.waitForTimeout(700);
  snap = await J(await fetch(B + "/api/dashboard/data"));
  const rels = snap.leads.find((l) => l.id === "lead_1").relationships || [];
  ok("relationship saved with its label and link", rels.some((x) => x.relation === "Co-buyer" && x.leadId === "lead_2"), JSON.stringify(rels));

  /* ── spec 1: new note modal ── */
  await openAcc("notes");
  await page.click('#crPanel [data-cr="noteAdd"]');
  await page.waitForSelector("#ntBody");
  ok("visibility toggle starts on", await page.$eval("#ntHidden", (c) => c.checked));
  ok("AI: HELP ME WRITE is present", (await page.$("#ntAi")) !== null);
  await page.click("#ntAi");
  ok("AI draft filled the textarea", (await page.inputValue("#ntBody")).length > 20);
  await page.fill("#ntBody", "Follow up Monday about ");
  await page.click("#ntStar");
  await page.type("#ntBody", "@Ken");
  await page.waitForSelector(".ta-list button");
  await page.click(".ta-list button");
  await page.click("#ntSave");
  await page.waitForTimeout(800);
  notes = (await J(await fetch(B + "/api/crm/lead/lead_1/record"))).record.notes;
  const fresh = notes.find((n) => /Follow up Monday/.test(n.body));
  ok("note saved from the modal", !!fresh, JSON.stringify(notes.map((n) => n.body)));
  ok("the @mention was recorded as a real reference", fresh && fresh.mentions.length === 1, JSON.stringify(fresh && fresh.mentions));
  ok("the importance star was recorded", fresh && fresh.important === true);
  await openAcc("notes");
  ok("the note renders in the panel", /Follow up Monday/.test(await page.textContent('#crPanel .acc[data-acc="notes"] .acc-b')));

  /* ── spec 3: transaction type → information ── */
  await openAcc("transactions");
  await page.click('#crPanel [data-cr="txAdd"]');
  await page.waitForSelector('#oaOv .tp[data-tt="tenant"]');
  ok("all five transaction types offered", (await page.$$("#oaOv .tp")).length === 5);
  ok("NEXT starts disabled on the type picker", await page.$eval("#ttNext", (b) => b.disabled));
  await page.click('#oaOv .tp[data-tt="seller"]');
  ok("NEXT enables after a type is chosen", !(await page.$eval("#ttNext", (b) => b.disabled)));
  await page.click("#ttNext");
  await page.waitForSelector("#txAddr");
  const sections = await page.$$eval("#oaOv .ld-sec-h", (els) => els.map((e) => e.textContent.trim()));
  ok("the information modal has all three sections", sections.join("|") === "Transaction Details|Listing Details|Roles Assignment", sections.join("|"));
  await page.fill("#txAddr", "18 Sundance Sq");
  await page.fill("#txList", "525000");
  await page.click("#txSave");
  await page.waitForTimeout(900);
  const txs2 = (await J(await fetch(B + "/api/transactions"))).transactions || [];
  const made = txs2.find((t) => t.address === "18 Sundance Sq");
  ok("transaction created from the record", !!made, JSON.stringify(txs2.map((t) => t.address)));
  ok("it carries the chosen type and the contact link", made && made.dealType === "seller" && made.leadId === "lead_1", JSON.stringify(made && { d: made.dealType, l: made.leadId }));
  await openAcc("transactions");
  ok("the new transaction shows in the accordion", /18 Sundance Sq/.test(await page.textContent('#crPanel .acc[data-acc="transactions"] .acc-b')));

  /* ── spec 3: document type → upload ── */
  await openAcc("documents");
  await page.click('#crPanel [data-cr="docAdd"]');
  await page.waitForSelector("#oaOv .tp[data-dt]");
  ok("document types offered", (await page.$$("#oaOv .tp[data-dt]")).length >= 5);
  await page.click('#oaOv .tp[data-dt="disclosure"]');
  await page.click("#dtNext");
  await page.waitForSelector("#dzDrop");
  ok("the dropzone states the 15MB ceiling", /15MB/.test(await page.textContent("#dzDrop")));
  ok("UPLOAD is disabled until a file is chosen", await page.$eval("#dzGo", (b) => b.disabled));
  ok("Create Pipeline Transaction toggle present", (await page.$("#dzTx")) !== null);
  await page.setInputFiles("#dzFile", { name: "disclosure.pdf", mimeType: "application/pdf", buffer: Buffer.from("hello disclosure") });
  await page.waitForTimeout(200);
  ok("UPLOAD enables once a file is chosen", !(await page.$eval("#dzGo", (b) => b.disabled)));
  await page.fill("#dzSigned", "2026-08-12");
  await page.click("#dzGo");
  await page.waitForTimeout(1200);
  docs = (await J(await fetch(B + "/api/crm/lead/lead_1/record"))).record.documents;
  const up = docs.find((d) => d.fileName === "disclosure.pdf");
  ok("document uploaded from the browser", !!up, JSON.stringify(docs.map((d) => d.fileName)));
  ok("it carries the chosen type and signed date", up && up.docType === "disclosure" && up.signedDate === "2026-08-12", JSON.stringify(up));
  await openAcc("documents");
  ok("the document lists in the accordion", /disclosure\.pdf/.test(await page.textContent('#crPanel .acc[data-acc="documents"] .acc-b')));

  /* ── spec 5: the middle panel ── */
  ok("AI widget renders", (await page.$("#crAiPanel")) !== null);
  ok("recommendation stream is scroll-capped", (await page.$eval("#crAiPanel ul.ai-stream", (e) => getComputedStyle(e).maxHeight)) === "140px");
  /* The API section above already saved contactAiCollapsed for this user, so
     the widget must open collapsed — that IS the preference doing its job. */
  ok("saved Collapse by default is honoured on first paint", await page.$eval("#crAiPanel", (e) => e.classList.contains("folded")));
  ok("the checkbox reflects the saved preference", await page.$eval("#crAiDefault", (c) => c.checked));
  await page.click("#crAiFold");
  ok("clicking the header expands it", !(await page.$eval("#crAiPanel", (e) => e.classList.contains("folded"))));
  await page.click("#crAiFold");
  ok("clicking again collapses it", await page.$eval("#crAiPanel", (e) => e.classList.contains("folded")));
  await page.click("#crAiFold");
  await page.click('#crAiPanel button[data-ai="about"]');
  await page.waitForTimeout(200);
  ok("About This Lead tab switches", await page.$eval('#crAiPanel button[data-ai="about"]', (b) => b.classList.contains("on")));
  ok("switching tabs does not collapse the widget", !(await page.$eval("#crAiPanel", (e) => e.classList.contains("folded"))));
  await page.uncheck("#crAiDefault");
  await page.waitForTimeout(500);
  prefs = (await J(await fetch(B + "/api/settings/ui-prefs?user=team"))).prefs;
  ok("unchecking Collapse by default persists", prefs.contactAiCollapsed === false, JSON.stringify(prefs));
  await page.check("#crAiDefault");
  await page.waitForTimeout(500);
  prefs = (await J(await fetch(B + "/api/settings/ui-prefs?user=team"))).prefs;
  ok("re-checking Collapse by default persists", prefs.contactAiCollapsed === true, JSON.stringify(prefs));

  const tabs = await page.$$eval("#ldTabs button", (els) => els.map((e) => e.textContent.trim()));
  ok("composer offers all six actions", tabs.join(",") === "NOTE,EMAIL,CALL,TEXT,APPOINTMENT,OTHER", tabs.join(","));
  const activeBorder = await page.$eval("#ldTabs button.on", (e) => getComputedStyle(e).borderBottomColor);
  ok("the active composer tab carries the teal underline", activeBorder !== "rgba(0, 0, 0, 0)", activeBorder);

  /* The feed is the server-built timeline as of the composer phase — nine
     pills, not seven, and the ids moved from data-ff to data-tl. */
  await page.waitForFunction(() => document.querySelectorAll("#tlBar button").length === 9, null, { timeout: 8000 });
  const pills = await page.$$eval("#tlBar button", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  ok("filter bar shows every kind with a count", pills.length === 9 && /All \d/.test(pills[0]), JSON.stringify(pills));
  ok("the Notes pill has a non-zero count", /Notes [1-9]/.test(pills.join("|")), JSON.stringify(pills));
  await page.click('#tlBar button[data-tl="note"]');
  await page.waitForTimeout(300);
  ok("filtering to Notes keeps only notes", (await page.$$eval("#ldTimeline .ico", (els) => els.map((e) => e.className))).every((c) => /\bnote\b/.test(c)));
  const disabled = await page.$$eval("#tlBar button[disabled]", (els) => els.map((e) => e.getAttribute("data-tl")));
  ok("kinds with nothing logged are disabled, not hidden", disabled.length > 0, JSON.stringify(disabled));
  await page.click('#tlBar button[data-tl="all"]');

  /* ── reload: the record is server state, not client memory ── */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".demo-tag") && /Live data/.test(document.querySelector(".demo-tag").textContent), null, { timeout: 15000 });
  await page.click('.rail .r[data-view="leads"]');
  await page.waitForSelector("#leadRows tr");
  await page.click('#leadRows .ldlink:has-text("Record Lead")');
  await page.waitForSelector("#crPanel .acc");
  await openAcc("contact");
  const contactTxt = await page.textContent('#crPanel .acc[data-acc="contact"] .acc-b');
  ok("phones survive reload", /\(512\) 555-0143/.test(contactTxt), contactTxt.slice(0, 160));
  ok("addresses survive reload", /1200 Summit Ave/.test(contactTxt));
  ok("AI widget honours Collapse by default after reload", await page.$eval("#crAiPanel", (e) => e.classList.contains("folded")));

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("\nFAILURES:\n" + fail.map((f) => " - " + f).join("\n")); if (srvLog) console.error("\n--- server log tail ---\n" + srvLog.slice(-2500)); process.exit(1); }
