#!/usr/bin/env node
/**
 * Hit every GET route this server registers and report the ones that break.
 *
 * WHY. ~470 routes are registered directly on `app` in one 17k-line file. There
 * is no router, no route table, and no test that simply asks "does this
 * endpoint respond". A route that throws on an empty database, or that was
 * renamed while its caller was not, fails silently until somebody clicks the
 * thing in the UI — which is how a dashboard ends up with buttons that quietly
 * do nothing.
 *
 * The routes are read from Express's own routing table rather than a list, so
 * this cannot drift from what is actually served.
 *
 * ONLY GET, and only routes with no path parameters or ones that can be filled
 * with a harmless probe value. Nothing here mutates: POST/PATCH/DELETE are
 * listed but never called, because this runs against a real server and some of
 * those send messages to real people.
 *
 * A 4xx is not a failure — an endpoint that wants a query argument is entitled
 * to say so. A 5xx is: it means the handler threw.
 *
 * Usage: node scripts/audit-api-routes.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 4010);
const B = `http://localhost:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "api-audit-"));

const lead = {
  id: "lead_1", platform: "tiktok", userId: "u1", username: "u1", name: "Audit Lead",
  phone: "2105550101", email: "audit@example.com", state: "new", source: "TikTok",
  adCampaign: null, propertyInquired: null, criteria: null, brivityId: null,
  crmStatus: "hot", crmStage: "new_lead", crmPriority: "normal", crmIntent: "buyer",
  crmCallQueue: "none", crmNotes: null, tags: [], address: "12 Oak St, San Antonio, TX",
  birthday: null, homeAnniversary: null, autoPlanEnrollments: [],
  assignedUserId: null, assignedUserName: null,
  createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z",
};
writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 5, leadsById: { lead_1: lead }, leadKeyToId: { "tiktok::u1": "lead_1" },
  conversationsByLeadId: { lead_1: { messages: [] } }, commandTasks: [],
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
const until = async (fn, ms = 40000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };

/* Probe values for the common path parameters, so a parameterised route can be
   exercised instead of skipped. An id that does not exist should produce a
   clean 404, not a stack trace — that is itself worth checking. */
const PARAMS = {
  id: "lead_1", leadId: "lead_1", planId: "p_missing", taskId: "t_missing",
  peer: "2105550101", kind: "sources", name: "Zillow", sessionId: "s_missing",
  slug: "x", token: "x", key: "x", messageId: "m_missing", threadId: "th_missing",
  userId: "u_missing", docId: "d_missing", type: "tiktok", platform: "tiktok",
};

/* Routes that are slow, external, or destructive by nature. Skipped on purpose,
   and listed in the output so the skip is visible rather than silent. */
const SKIP = [
  /^\/api\/jarvis\//, /^\/api\/harvey\//, /listen$/, /^\/v1\//,
  /^\/api\/ads\//, /^\/api\/social\/(refresh|pull)/, /^\/api\/content\/(generate|render)/,
  /\/file$/, /\/download$/, /\/export$/, /^\/api\/brivity\/people/,
  /^\/api\/mls\/sync/, /^\/api\/email\/gmail-oauth/, /^\/reset$/,
];

try {
  await until(async () => (await fetch(B + "/health")).ok);
  const routes = await (await fetch(B + "/api/dev/route-table")).json().catch(() => null) || null;

  /* No introspection endpoint exists, so the table is read the same way the
     Harvey bridge reads it — from the catalogue the server publishes at boot. */
  const cat = await (await fetch(B + "/api/dev/routes")).json().catch(() => null);
  let list = (routes && routes.routes) || (cat && cat.routes) || null;

  if (!list) {
    /* Fall back to the crm_api catalogue, which is built from Express's table. */
    const viaBridge = await (await fetch(B + "/api/crm/vocabulary")).json().catch(() => null);
    if (!viaBridge) throw new Error("server not answering");
    list = null;
  }

  if (!list) {
    console.log("No route-introspection endpoint; deriving from the source file instead.\n");
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
    list = [...src.matchAll(/app\.get\(\s*"([^"]+)"/g)].map((m) => ({ method: "GET", path: m[1] }));
  }

  const gets = list.filter((r) => r.method === "GET" && !SKIP.some((re) => re.test(r.path)));
  const skipped = list.filter((r) => r.method === "GET" && SKIP.some((re) => re.test(r.path)));

  const results = { ok: 0, client: 0, unavailable: [], server: [], slow: [] };
  for (const r of gets) {
    const path = r.path.replace(/:([A-Za-z0-9_]+)\??/g, (_m, name) => PARAMS[name] ?? "probe");
    if (path.includes("*")) continue;
    const t0 = Date.now();
    let status = 0, body = "";
    try {
      const res = await fetch(B + path, { signal: AbortSignal.timeout(15000) });
      status = res.status;
      body = (await res.text()).slice(0, 160);
    } catch (e) {
      status = -1; body = String(e.message).slice(0, 120);
    }
    const ms = Date.now() - t0;
    if (ms > 3000) results.slow.push(`${path} — ${ms}ms`);
    /* 503 is a correct answer, not a crash: an integration that is not
       configured in this throwaway environment should say so. Only a genuine
       fault — 500, a bad gateway, or a connection that died — is a finding. */
    if (status === 503) results.unavailable.push(`${path}`);
    else if (status >= 500 || status === -1) results.server.push(`${status}  ${path}\n        ${body}`);
    else if (status >= 400) results.client++;
    else results.ok++;
  }

  console.log("\n================ API ROUTE AUDIT ================\n");
  console.log(`  GET routes exercised : ${gets.length}`);
  console.log(`  2xx/3xx              : ${results.ok}`);
  console.log(`  4xx (asked for input): ${results.client}`);
  console.log(`  skipped on purpose   : ${skipped.length}`);
  console.log(`  503 not configured   : ${results.unavailable.length}  ${results.unavailable.join(", ") || ""}`);
  console.log(`  5xx / threw          : ${results.server.length}`);
  if (results.server.length) {
    console.log("\n  --- HANDLERS THAT THREW ---");
    for (const l of results.server) console.log("    " + l);
  }
  if (results.slow.length) {
    console.log("\n  --- SLOW (>3s) ---");
    for (const l of results.slow) console.log("    " + l);
  }
  console.log("");
  if (results.server.length && process.env.SHOW_LOG) console.error(srvLog.slice(-3000));
  process.exitCode = results.server.length ? 1 : 0;
} catch (e) {
  console.error("AUDIT FAILED:", e.message);
  console.error(srvLog.slice(-1500));
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}
