#!/usr/bin/env node
/**
 * The Mojo Dialer connection.
 *
 * WHY IT IS A WEBHOOK. Mojo has no public REST API. Its integrations page lists
 * pre-established partners only (Boomtown, Real Geeks, Follow Up Boss,
 * Mailchimp, Zillow, Google, Exchange) plus Zapier and API Nation, with no
 * developer docs, no API key page and no partner application process. Zapier's
 * Mojo app — which is public and enumerable — offers triggers (New Contact,
 * Contact Updated, New Activity, New Note, Bad Number, Send Button Clicked) and
 * actions that write INTO Mojo, and critically NO bulk read. Nothing can ask
 * Mojo for its lead list, so a push endpoint is the only automatic way contacts
 * leave the dialer, and a "sync all Mojo leads" button could not work.
 *
 * What is tested here is therefore the receiving half, and mostly its refusals:
 * this endpoint CREATES LEADS, so being wrong about auth is worse than being
 * closed.
 *
 * Usage: node scripts/verify-mojo-webhook.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 4002;
const B = `http://127.0.0.1:${PORT}`;
const SECRET = "test-secret-value-1234567890";
const tmp = mkdtempSync(join(tmpdir(), "mojo-wh-"));
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const iso = new Date().toISOString();
/* One existing lead that a Mojo contact will match on phone, deliberately
   missing a name and email so the gap-fill can be observed, plus one whose
   name was typed here and must NOT be overwritten. */
const leads = {
  L1: { id: "L1", platform: "instagram", userId: "u1", username: "@handle1", name: null,
        phone: "(210) 555-0111", email: null, state: "new", source: "", tags: [],
        createdAt: iso, updatedAt: iso },
  L2: { id: "L2", platform: "instagram", userId: "u2", username: "@handle2",
        name: "Typed By A Human", phone: "(210) 555-0222", email: "typed@example.com",
        state: "new", source: "Instagram", tags: ["Keep Me"], createdAt: iso, updatedAt: iso },
};
writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 10, leadsById: leads,
  leadKeyToId: Object.fromEntries(Object.values(leads).map((l) => [l.platform + "::" + l.userId, l.id])),
  conversationsByLeadId: {}, commandTasks: [] }));

function boot(extraEnv) {
  const env = { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db"), ...extraEnv };
  delete env.BRIVITY_API_KEY;
  const p = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  process.on("exit", () => { try { p.kill("SIGKILL"); } catch {} });
  return p;
}
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
const post = (body, opts = {}) => fetch(B + "/api/mojo/webhook" + (opts.token ? "?token=" + opts.token : ""),
  { method: "POST", headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: JSON.stringify(body) });

// ── with NO secret configured the endpoint must be closed ──────────────────
let srv = boot({});
await until(async () => (await fetch(B + "/health")).ok);
try {
  const r = await post({ first_name: "A", phone: "2105551234" });
  const j = await r.json();
  ok("with no secret configured the webhook refuses outright", r.status === 503, String(r.status));
  ok("and says what to set rather than failing silently",
    /MOJO_WEBHOOK_SECRET/.test(j.error || ""), j.error);
  ok("it did NOT create a lead while unconfigured",
    (await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json()).totals.leads === 2);
} finally { srv.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 600)); }

// ── with a secret ─────────────────────────────────────────────────────────
srv = boot({ MOJO_WEBHOOK_SECRET: SECRET });
await until(async () => (await fetch(B + "/health")).ok);
try {
  ok("a request with no secret is rejected", (await post({ phone: "2105559999" })).status === 401);
  ok("a wrong secret is rejected", (await post({ phone: "2105559999" }, { token: "nope" })).status === 401);
  ok("still nothing created by the rejected calls",
    (await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json()).totals.leads === 2);

  // a brand new contact
  const r1 = await post({
    id: "MJ-1", first_name: "Seller", last_name: "Prospect", phone: "210-555-0777",
    email: "Seller@Example.COM", address: "12 Oak St", city: "San Antonio", state: "TX",
    postal_code: "78201", group: "FSBO Q3", notes: "Wants a valuation",
  }, { token: SECRET });
  const j1 = await r1.json();
  ok("a valid contact is accepted", r1.status === 200 && j1.ok, JSON.stringify(j1));
  ok("and created as a new lead", j1.created === 1 && j1.merged === 0, JSON.stringify(j1));

  const snap = await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json();
  const made = snap.leads.find((l) => l.name === "Seller Prospect");
  ok("the lead is really on the board", !!made, JSON.stringify(snap.leads.map((l) => l.name)));
  ok("its phone is formatted, not raw digits", made.phone === "(210) 555-0777", made.phone);
  ok("its email is lowercased", made.email === "seller@example.com", made.email);
  ok("the address is assembled from the parts",
    /12 Oak St, San Antonio, TX, 78201/.test(made.address || ""), made.address);
  ok("the source is 'Mojo', so it joins the existing Mojo count rather than splitting it",
    made.source === "Mojo", made.source);
  ok("the Mojo list is kept as a tag, not folded into the source",
    (made.tags || []).includes("Mojo: FSBO Q3"), JSON.stringify(made.tags));

  // header auth works too
  const r2 = await post({ id: "MJ-2", first_name: "Header", phone: "2105550888" },
    { headers: { "x-mojo-secret": SECRET } });
  ok("the secret can travel in a header instead of the query", (await r2.json()).created === 1);

  // matching an existing lead enriches rather than duplicating
  const before = (await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json()).totals.leads;
  const r3 = await post({ id: "MJ-3", first_name: "Real", last_name: "Name",
    phone: "2105550111", email: "found@example.com" }, { token: SECRET });
  const j3 = await r3.json();
  ok("a contact matching an existing phone MERGES instead of duplicating",
    j3.merged === 1 && j3.created === 0, JSON.stringify(j3));
  const after = await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json();
  ok("no new row was added by the merge", after.totals.leads === before, `${after.totals.leads} vs ${before}`);
  const l1 = after.leads.find((l) => l.id === "L1");
  ok("the gap was filled — a nameless lead gained the real name", l1.name === "Real Name", l1.name);
  ok("and the missing email too", l1.email === "found@example.com", l1.email);

  // must NOT clobber
  const r4 = await post({ id: "MJ-4", first_name: "Should", last_name: "Not Win",
    phone: "2105550222", email: "should-not-win@example.com" }, { token: SECRET });
  ok("a merge onto a lead with data is still counted", (await r4.json()).merged === 1);
  const after2 = await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json();
  const l2 = after2.leads.find((l) => l.id === "L2");
  ok("a name typed here is NOT overwritten by Mojo", l2.name === "Typed By A Human", l2.name);
  ok("nor is an email we already hold", l2.email === "typed@example.com", l2.email);
  ok("nor the source", l2.source === "Instagram", l2.source);
  ok("existing tags survive the merge", (l2.tags || []).includes("Keep Me"), JSON.stringify(l2.tags));

  // junk and batches
  const r5 = await post({ id: "MJ-5", first_name: "No Contact Info" }, { token: SECRET });
  const j5 = await r5.json();
  ok("a contact with no phone and no email is skipped, not created",
    j5.skipped === 1 && j5.created === 0, JSON.stringify(j5));
  const r6 = await post({ contacts: [
    { id: "B1", first_name: "Batch One", phone: "2105551001" },
    { id: "B2", first_name: "Batch Two", phone: "2105551002" },
  ] }, { token: SECRET });
  ok("a batch of contacts is accepted in one call", (await r6.json()).created === 2);

  // idempotency: the same contact twice must not duplicate
  const n1 = (await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json()).totals.leads;
  await post({ id: "B1", first_name: "Batch One", phone: "2105551001" }, { token: SECRET });
  const n2 = (await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json()).totals.leads;
  ok("re-sending the same contact does not duplicate it", n1 === n2, `${n1} then ${n2}`);

  // the sidebar count this feeds
  const finalSnap = await (await fetch(B + "/api/dashboard/data?includePhoneless=1")).json();
  const mojoN = finalSnap.leads.filter((l) => (l.source || "").toLowerCase() === "mojo").length;
  ok("the Mojo leads all carry one source, so the sidebar counts them together",
    mojoN >= 4, String(mojoN));
} finally { srv.kill("SIGKILL"); }

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); process.exit(1); }
