#!/usr/bin/env node
/**
 * The SOP import into the Knowledge Center, and Harvey's bridge to the CRM API.
 *
 * TWO THINGS ARE BEING GUARDED HERE, and they pull in opposite directions.
 *
 * The SOPs are the team's real operating procedures, so the import has to be a
 * SEED and not a SYNC: it must put them there once, and must never afterwards
 * overwrite an edit someone made in the Knowledge Center. A test that only
 * checked "19 documents exist" would pass just as happily on a version that
 * clobbered the lot on every boot.
 *
 * The CRM bridge hands Harvey the dashboard's own API, which is exactly as
 * powerful as it sounds. So the assertions that matter most are the refusals:
 * a path outside the CRM, a path smuggled in a query string, traversal, and —
 * the one that would actually be a hole — an OUTSIDE request carrying a
 * guessed `x-internal-call` header.
 *
 * The Harvey half runs INSIDE the server process, because the bridge's
 * credential is minted per-process and never leaves it. That is the point of
 * the design, and it means a tool call from any other process cannot be made
 * to work — including from a test, which is why the driver below is loaded into
 * the server rather than talking to it.
 *
 * Usage: node scripts/verify-sops-and-harvey-crm.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3760);
const B = `http://localhost:${PORT}`;
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "sop-harvey-"));
const lead = {
  id: "lead_1", platform: "tiktok", userId: "u1", username: "user1", name: "Alpha Buyer",
  phone: "2105550110", email: "alpha@example.com", state: "new", source: "TikTok", adCampaign: null,
  propertyInquired: null, criteria: null, brivityId: null, crmStatus: "hot", crmStage: "new_lead",
  crmPriority: "normal", crmIntent: "buyer", crmCallQueue: "none", crmNotes: null,
  tags: ["Investor"], address: "12 Oak St, San Antonio, TX 78253", birthday: null, homeAnniversary: null,
  autoPlanEnrollments: [], assignedUserId: null, assignedUserName: null,
  createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
};
const leads = [lead,
  { ...lead, id: "lead_2", userId: "u2", name: "Bravo Seller", email: "bravo@example.com" },
  { ...lead, id: "lead_3", userId: "u3", name: "Charlie New", email: "charlie@example.com" },
  { ...lead, id: "lead_4", userId: "u4", name: "Delta Watch", email: "delta@example.com" }];
writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 10,
  leadsById: Object.fromEntries(leads.map((l) => [l.id, l])),
  leadKeyToId: Object.fromEntries(leads.map((l) => ["tiktok::" + l.userId, l.id])),
  conversationsByLeadId: Object.fromEntries(leads.map((l) => [l.id, { messages: [] }])),
  commandTasks: [],
}));

/* The driver: boots the real server in-process, then calls Harvey's tools the
   way the model would. Its output is one JSON line per result. */
const driver = join(tmp, "driver.mjs");
writeFileSync(driver, `
import { pathToFileURL } from "node:url";
await import(pathToFileURL(process.env.SERVER_ENTRY).href);
const { executePlatformTool } = await import(pathToFileURL(process.env.PLATFORM_TOOLS).href);
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(process.env.BASE + "/health")).ok);
const out = {};
const run = async (label, name, input) => { try { out[label] = await executePlatformTool(name, input); } catch (e) { out[label] = { threw: String(e && e.message || e) }; } };

await run("index", "crm_api_index", {});
await run("indexFiltered", "crm_api_index", { contains: "listing-alerts" });
await run("getLeads", "crm_api", { method: "POST", path: "/api/leads/filter", body: {} });
await run("vocabAll", "get_crm_vocabulary", {});
await run("vocabSourcesFiltered", "get_crm_vocabulary", { kind: "sources", contains: "zillow" });
await run("knowledgeList", "crm_api", { method: "GET", path: "/api/knowledge" });
await run("denyAuth", "crm_api", { method: "POST", path: "/api/auth/login", body: {} });
await run("denyWebhook", "crm_api", { method: "POST", path: "/webhook", body: {} });
await run("denyUsersWrite", "crm_api", { method: "POST", path: "/api/users/abc", body: {} });
await run("denyTraversal", "crm_api", { method: "GET", path: "/api/crm/../auth/team" });
await run("denySmuggle", "crm_api", { method: "GET", path: "/api/social?x=/api/crm/vocabulary" });
await run("denyUnknown", "crm_api", { method: "GET", path: "/api/finance/overview" });
await run("badMethod", "crm_api", { method: "OPTIONS", path: "/api/knowledge" });
await run("realFailure", "crm_api", { method: "GET", path: "/api/crm/lead/does_not_exist" });
await run("writeThrough", "crm_api", { method: "PATCH", path: "/api/crm/lead/lead_2", body: { crmStatus: "nurture" } });
await run("readBack", "crm_api", { method: "POST", path: "/api/leads/filter", body: { status: ["nurture"] } });
const team = await executePlatformTool("get_team_status", {});
out.someone = (team?.members || team?.team || team?.users || []).find?.((u) => u && u.id) || null;
await run("updateLeadRich", "update_lead", { leadId: "lead_1", tags: ["Investor", "VIP"], source: "Zillow", ...(out.someone ? { assignedUserId: out.someone.id } : {}) });
await run("updateLeadEmptyTags", "update_lead", { leadId: "lead_1", tags: [] });
await run("updateLeadBadUser", "update_lead", { leadId: "lead_1", assignedUserId: "nobody_here" });
await run("knowledgeSearch", "search_knowledge", { query: "mojo brivity lead entry" });
console.log("###RESULTS###" + JSON.stringify(out));
process.exit(0);
`);

const env = {
  ...process.env,
  PORT: String(PORT), BASE: B,
  SERVER_ENTRY: join(process.cwd(), "dist/src/server.js"),
  PLATFORM_TOOLS: join(process.cwd(), "dist/src/harvey/platformTools.js"),
  /* The lock stays ARMED. The whole point of the bridge is that it works from
     inside the process while the door is shut, so switching the lock off here
     would test nothing. */
  SITE_LOGIN_ENABLED: "1",
  DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db"),
  KNOWLEDGE_JSON_PATH: join(tmp, "knowledge.json"),
  CRM_VOCAB_DB_PATH: join(tmp, "crm-vocabulary.db"),
};

function boot() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [driver], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", () => resolve({ out, err }));
    setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 120000);
  });
}

let log = "";
try {
  // ---- pass 1: a cold system -----------------------------------------------
  const first = await boot();
  log = first.out + first.err;
  const marker = first.out.indexOf("###RESULTS###");
  if (marker < 0) throw new Error("driver produced no results");
  const R = JSON.parse(first.out.slice(marker + 13).split("\n")[0]);

  // ---- the SOP import -------------------------------------------------------
  ok("the boot step reports importing the SOPs", /SOP import: \d+ added/.test(log), (log.match(/SOP import:[^\n]*/) || [""])[0]);
  const kb = JSON.parse(readFileSync(join(tmp, "knowledge.json"), "utf8"));
  const sops = kb.docs.filter((d) => d.updatedBy === "SOP import");
  ok("all 19 SOPs are in the Knowledge Center", sops.length === 19, String(sops.length));
  ok("the starter software docs were not replaced", kb.docs.some((d) => d.builtIn));
  ok("SOPs are filed under real categories, not Uncategorised",
    sops.every((d) => d.category && d.category !== "Uncategorised"),
    [...new Set(sops.map((d) => d.category))].join(", "));
  ok("every SOP carries tags for search", sops.every((d) => d.tags.length >= 2));
  const mojo = sops.find((d) => d.title === "Adding Leads from Mojo to Brivity CRM");
  ok("an SOP is present under its own title", !!mojo);
  /* Verbatim: a line only present if the body was not summarised or truncated. */
  ok("the SOP body is the document's own text, in full",
    mojo && /No lead sits in Mojo only\./.test(mojo.body) && /## \*\*Part 3 — Set the Follow-Up Task\*\*/.test(mojo.body));
  ok("its real tables survived the import", mojo && /\| First Name \| From Mojo \|/.test(mojo.body));
  ok("screenshots are named rather than left as blank tables",
    mojo && /\*\(screenshot — see the source document\)\*/.test(mojo.body) && !/^\|\s*\|\s*$/m.test(mojo.body));
  /* Drive escapes markdown punctuation on export. Left in, "\\~2 min" renders
     with the backslash and reads as a typo, and "\\*\\*Field\\*\\*" never goes bold. */
  ok("the export's backslash escapes were undone",
    mojo && /\*\*Time per lead:\*\* ~2 min/.test(mojo.body) && !/\\[~*]/.test(mojo.body),
    (mojo.body.match(/.{0,20}Time per lead.{0,20}/) || [""])[0]);
  ok("the byte-identical duplicate SOP was not imported twice",
    sops.filter((d) => d.body === (sops.find((x) => x.title === "Building and Sending Property Options from MLS") || {}).body).length === 1);
  ok("the near-duplicate with different text WAS kept",
    sops.some((d) => d.title === "Sending Options from MLS"));
  ok("Harvey's knowledge search finds an imported SOP",
    JSON.stringify(R.knowledgeSearch || {}).includes("Mojo"), JSON.stringify(R.knowledgeSearch).slice(0, 160));

  // ---- pass 2: the same system, booted again --------------------------------
  /* An operator edit, then a reboot. This is the assertion the whole "seed not
     sync" design exists for. */
  const before = JSON.parse(readFileSync(join(tmp, "knowledge.json"), "utf8"));
  const target = before.docs.find((d) => d.title === "Adding Leads from Mojo to Brivity CRM");
  target.body = "# Edited by the team\n\nThis replaced the imported text.";
  const deletedTitle = "Buyer Representation Agreement SOP";
  before.docs = before.docs.filter((d) => d.title !== deletedTitle);
  writeFileSync(join(tmp, "knowledge.json"), JSON.stringify(before));

  const second = await boot();
  ok("a second boot does not re-run the import", !/SOP import: \d+ added/.test(second.out + second.err));
  const after = JSON.parse(readFileSync(join(tmp, "knowledge.json"), "utf8"));
  ok("an edited SOP keeps the team's text",
    after.docs.find((d) => d.title === "Adding Leads from Mojo to Brivity CRM").body.startsWith("# Edited by the team"));
  ok("a deleted SOP stays deleted", !after.docs.some((d) => d.title === deletedTitle));
  ok("nothing was duplicated", after.docs.length === before.docs.length, `${after.docs.length} vs ${before.docs.length}`);

  // ---- the CRM bridge: what it can do ---------------------------------------
  ok("crm_api_index lists real routes", (R.index?.routes || []).length > 20, String(R.index?.total));
  ok("the index is filterable", (R.indexFiltered?.routes || []).every((r) => r.path.includes("listing-alerts")) &&
    (R.indexFiltered?.routes || []).length > 0, JSON.stringify(R.indexFiltered?.routes || []).slice(0, 120));
  ok("no denied path leaks into the index",
    !(R.index?.routes || []).some((r) => r.path.startsWith("/api/auth/") || r.path.startsWith("/webhook")));
  ok("a CRM read works through the bridge while the lock is armed",
    R.getLeads?.ok === true && R.getLeads.status === 200, JSON.stringify(R.getLeads).slice(0, 160));
  ok("the Knowledge Center is reachable through the bridge", R.knowledgeList?.ok === true);
  ok("a write goes through and is marked as a change",
    R.writeThrough?.ok === true && R.writeThrough.changed === true, JSON.stringify(R.writeThrough).slice(0, 160));
  ok("and the change actually landed",
    JSON.stringify(R.readBack?.response || {}).includes("lead_2"), JSON.stringify(R.readBack).slice(0, 200));

  // ---- the CRM bridge: what it refuses --------------------------------------
  const refused = (r) => typeof r?.error === "string" && r.error.length > 10;
  ok("auth endpoints are refused", refused(R.denyAuth), JSON.stringify(R.denyAuth));
  ok("webhook intake is refused", refused(R.denyWebhook), JSON.stringify(R.denyWebhook));
  ok("user administration is refused", refused(R.denyUsersWrite), JSON.stringify(R.denyUsersWrite));
  ok("path traversal is refused", refused(R.denyTraversal), JSON.stringify(R.denyTraversal));
  ok("a path smuggled in the query string is refused", refused(R.denySmuggle), JSON.stringify(R.denySmuggle));
  ok("anything outside the CRM surface is refused", refused(R.denyUnknown), JSON.stringify(R.denyUnknown));
  ok("an unsupported method is refused", refused(R.badMethod), JSON.stringify(R.badMethod));
  /* A refusal is not the same as a failure, and neither may be narrated as
     success — the failure carries the words that stop that. */
  ok("a genuine 404 comes back as not-done, with the words to say so",
    R.realFailure?.ok === false && /did NOT happen/i.test(R.realFailure.hint || ""), JSON.stringify(R.realFailure).slice(0, 200));

  // ---- vocabulary + the richer update_lead ----------------------------------
  ok("get_crm_vocabulary returns the real stage groups",
    JSON.stringify(R.vocabAll?.stageGroups || []).includes("Candidate Recruit Stages"));
  ok("it returns the managed tag list", (R.vocabAll?.tags || []).length > 50, String((R.vocabAll?.tags || []).length));
  ok("the 357-source list is capped rather than dumped whole",
    (R.vocabAll?.sources || []).length === 60 && /357|showing the first 60/.test(R.vocabAll?.sourcesNote || ""),
    R.vocabAll?.sourcesNote);
  ok("and it can be narrowed to what was asked for",
    (R.vocabSourcesFiltered?.sources || []).every((s) => /zillow/i.test(s.name)) &&
    (R.vocabSourcesFiltered?.sources || []).length > 0);
  ok("update_lead sets tags and source",
    R.updateLeadRich?.updated === true &&
    JSON.stringify(R.updateLeadRich.changed).includes("VIP") &&
    JSON.stringify(R.updateLeadRich.changed).includes("Zillow"), JSON.stringify(R.updateLeadRich).slice(0, 200));
  ok("and assignment, when there is a roster to assign to",
    !R.someone || JSON.stringify(R.updateLeadRich.changed).includes("assignedTo"),
    JSON.stringify({ someone: R.someone, changed: R.updateLeadRich?.changed }).slice(0, 200));
  ok("an empty tag list is refused rather than wiping every tag",
    refused(R.updateLeadEmptyTags), JSON.stringify(R.updateLeadEmptyTags));
  ok("an unknown assignee is refused", refused(R.updateLeadBadUser), JSON.stringify(R.updateLeadBadUser));

  // ---- the hole this would be if the header were enough ---------------------
  /* Booted once more, this time only to answer one question from OUTSIDE the
     process: can a caller who knows the header's name get in? */
  const outsideProc = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
    cwd: process.cwd(), env: { ...env, PORT: String(PORT + 1) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let boot3 = "";
  outsideProc.stdout.on("data", (d) => (boot3 += d));
  outsideProc.stderr.on("data", (d) => (boot3 += d));
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
  await until(async () => (await fetch(`http://localhost:${PORT + 1}/health`)).ok);
  try {
    const forged = await fetch(`http://localhost:${PORT + 1}/api/crm/vocabulary`, {
      headers: { "x-internal-call": "a".repeat(64) },
    });
    ok("a forged internal-call header from outside gets nothing", forged.status === 401, String(forged.status));
    const empty = await fetch(`http://localhost:${PORT + 1}/api/crm/vocabulary`, { headers: { "x-internal-call": "" } });
    ok("an empty internal-call header gets nothing", empty.status === 401, String(empty.status));
    const none = await fetch(`http://localhost:${PORT + 1}/api/crm/vocabulary`);
    ok("and the door is still shut without one", none.status === 401, String(none.status));
  } finally {
    outsideProc.kill("SIGKILL");
  }
} catch (e) {
  fail.push("EXCEPTION " + (e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) {
  console.error(fail.map((f) => " - " + f).join("\n"));
  console.error("\n--- driver log ---\n" + log.slice(-2500));
  process.exit(1);
}
