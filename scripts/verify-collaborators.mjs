/**
 * verify-collaborators.mjs — Marco's "Collaborators Not Syncing" feedback.
 *
 * Two claims to prove, and the second is the one that could do damage:
 *
 *   1. Brivity's collaborator records reach a place where they are usable, and
 *      a re-sync updates them rather than duplicating them.
 *   2. A collaborator is NOT a team member. The Manage Team modal tells the
 *      operator that team membership grants the ability to view and edit the
 *      contact; a lender must never acquire that by being recorded on a deal.
 *      So the two live in different tables and nothing here writes to
 *      contact_assignments.
 *
 * Static half drives the real store; live half drives the real routes on a real
 * server, because the UI talks to routes and a store test cannot show a 404.
 *
 * Run:  node scripts/verify-collaborators.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(tmpdir(), "collab-"));
process.env.COLLABORATOR_DB_PATH = path.join(tmp, "collab.db");

const require_ = createRequire(import.meta.url);
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const store = require_("../dist/src/core/collaboratorStore.js");

console.log("\nDIRECTORY — manual entry, which is what the button does");
const lender = store.addCollaborator({
  name: "Dana Reyes", company: "Nu World Title", email: "dana@nuworld.example", phone: "2105551212",
});
check("a collaborator can be added by hand", Boolean(lender?.id));
check("it is marked manual", lender.source === "manual");
check("company is kept as data, not prose", lender.company === "Nu World Title");
let threw = null;
try { store.addCollaborator({ name: "   " }); } catch (e) { threw = String(e.message); }
check("a nameless collaborator is refused", threw !== null && /name/i.test(threw));

console.log("\nBRIVITY SYNC — the 125 records that 'were not syncing'");
const seeds = [
  { brivityId: "bv_1", name: "Chris Gomez", company: "Guild Mortgage", jobTitle: "Loan Officer", email: "chris@guild.example", phone: "2105550001" },
  { brivityId: "bv_2", name: "Alexis Ruiz", company: "Stewart Title", jobTitle: null, email: null, phone: "2105550002" },
  { brivityId: "bv_3", name: "   ", company: "No Name Co", jobTitle: null, email: null, phone: null },
];
let r = store.syncBrivityCollaborators(seeds);
check("brivity collaborators import", r.created === 2, JSON.stringify(r));
check("a record with no name is skipped, not invented", r.skippedNoName === 1);

/* The important one: a second sync must UPDATE, never duplicate. */
seeds[0].company = "Guild Mortgage (San Antonio)";
r = store.syncBrivityCollaborators(seeds);
check("re-syncing updates in place", r.updated === 2 && r.created === 0, JSON.stringify(r));
check("and does not duplicate", store.listCollaborators().filter((c) => c.name === "Chris Gomez").length === 1);
check("the updated field really changed",
  store.listCollaborators().find((c) => c.name === "Chris Gomez")?.company === "Guild Mortgage (San Antonio)");

/* A hand-typed row must survive a sync untouched. */
const beforeName = lender.name;
store.syncBrivityCollaborators([{ brivityId: "bv_9", name: beforeName, company: "Someone Else", jobTitle: null, email: null, phone: null }]);
const manualAfter = store.getCollaborator(lender.id);
check("a manual row is never overwritten by a same-named Brivity record",
  manualAfter.company === "Nu World Title" && manualAfter.source === "manual");

console.log("\nLINKS — who is on which contact");
const chris = store.listCollaborators().find((c) => c.name === "Chris Gomez");
store.setCollaboratorsForLead("lead_A", [
  { collaboratorId: lender.id, roleName: "Title Company" },
  { collaboratorId: chris.id, roleName: "Lender" },
]);
let onA = store.listCollaboratorsForLead("lead_A");
check("both collaborators are on the contact", onA.length === 2);
check("roles are kept", onA.find((c) => c.id === chris.id)?.roleName === "Lender");
check("the directory row is joined in (name/company come along)",
  onA.find((c) => c.id === chris.id)?.company === "Guild Mortgage (San Antonio)");

store.setCollaboratorsForLead("lead_A", [{ collaboratorId: chris.id, roleName: "Lender" }]);
onA = store.listCollaboratorsForLead("lead_A");
check("saving a shorter list removes the dropped row", onA.length === 1 && onA[0].id === chris.id);
check("removing from a deal does NOT delete the person", Boolean(store.getCollaborator(lender.id)));

store.setCollaboratorsForLead("lead_B", [{ collaboratorId: chris.id, roleName: "Lender" }]);
check("one collaborator can be on several contacts",
  store.listCollaboratorsForLead("lead_B").length === 1 && store.listCollaboratorsForLead("lead_A").length === 1);
check("link counts report it", store.collaboratorLinkCounts()[chris.id] === 2);

store.setCollaboratorsForLead("lead_A", [
  { collaboratorId: chris.id, roleName: "Lender" },
  { collaboratorId: "does_not_exist", roleName: "Lender" },
]);
check("an unknown collaborator id is skipped, not fatal",
  store.listCollaboratorsForLead("lead_A").length === 1);

check("deleting a collaborator removes their links too",
  store.deleteCollaborator(chris.id) && store.listCollaboratorsForLead("lead_B").length === 0);

console.log("\nSEPARATION — a collaborator is not a team member");
check("collaborator roles are the outside-party set, not the access-granting one",
  store.COLLABORATOR_ROLES.includes("Lender") &&
  store.COLLABORATOR_ROLES.includes("Title Company") &&
  !store.COLLABORATOR_ROLES.includes("Team Owner") &&
  !store.COLLABORATOR_ROLES.includes("Broker"));
const contactStore = require_("../dist/src/core/contactRecordStore.js");
check("TEAM_ROLES stayed the access-granting set and was not widened",
  contactStore.TEAM_ROLES.includes("Team Owner") && !contactStore.TEAM_ROLES.includes("Lender"));

/* ─────────────────────────── LIVE ROUTES ─────────────────────────── */
console.log("\nLIVE — the routes the CRM actually calls");
const PORT = process.env.PORT_TEST || "3997";
const BASE = `http://127.0.0.1:${PORT}`;
/* These routes carry no token check of their own — they sit behind the site
   lock like every other /api/crm route, and the browser reaches them with a
   session cookie. The suite uses the machine credential instead, which is the
   lockdown's other accepted path, so what is exercised is the real guard. */
const TOKEN = "verify-collaborators-token";
const auth = (p) => `${BASE}${p}${p.includes("?") ? "&" : "?"}token=${TOKEN}`;
const server = spawn(process.execPath, ["dist/src/server.js"], {
  env: {
    ...process.env, PORT,
    COLLABORATOR_DB_PATH: path.join(tmp, "collab-live.db"),
    DASHBOARD_TOKEN: TOKEN,
    DB_JSON_PATH: path.join(tmp, "db.json"),
    ANTHROPIC_API_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* booting */ }
  }
  check("server booted", up, up ? "" : log.slice(-500));
  if (up) {
    let res = await fetch(auth("/api/collaborators"));
    let j = await res.json();
    check("GET /api/collaborators answers", res.ok && Array.isArray(j.collaborators), `HTTP ${res.status}`);
    check("it ships the role list the modal renders", Array.isArray(j.roles) && j.roles.includes("Lender"));

    res = await fetch(auth("/api/collaborators"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Pat Nguyen", company: "Alamo Inspections" }),
    });
    j = await res.json();
    check("POST /api/collaborators creates one", res.ok && j.collaborator?.name === "Pat Nguyen", `HTTP ${res.status}`);

    res = await fetch(auth("/api/collaborators"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "" }),
    });
    check("a nameless POST is a 400, not a 500", res.status === 400, `HTTP ${res.status}`);

    res = await fetch(auth("/api/collaborators"));
    j = await res.json();
    check("the new collaborator is in the directory", (j.collaborators || []).some((c) => c.name === "Pat Nguyen"));
    check("linkedContacts is reported", (j.collaborators || []).every((c) => typeof c.linkedContacts === "number"));

    /* The sync endpoint must refuse rather than pretend when Brivity is unset. */
    const anon = await fetch(`${BASE}/api/collaborators`);
    check("without a credential the directory is refused (the site lock holds)",
      anon.status === 401 || anon.status === 302, `HTTP ${anon.status}`);

    res = await fetch(auth("/api/collaborators/sync-brivity"), { method: "POST" });
    check("sync-brivity is not open to anonymous callers, or says why it cannot run",
      res.status === 401 || res.status === 503, `HTTP ${res.status}`);
  }
} finally {
  server.kill("SIGKILL");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
