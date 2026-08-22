#!/usr/bin/env node
/**
 * Site lock verification.
 *
 * The lock replaced two half-gates that each had a hole under them, so these
 * checks are written against the holes specifically:
 *
 *   · every page was ALSO served as a plain file by express.static, so /crm
 *     was gated and /crm-brivity.html was not;
 *   · 88 API routes never called the token check at all, and the token check
 *     returned TRUE whenever no token was configured.
 *
 * A test that only proved "/crm redirects to /login" would have passed against
 * the broken build. These assert the static path, the un-gated routes, and the
 * no-token default too.
 *
 * Usage: ADMIN_PASSWORD=... node scripts/verify-site-lock.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3411);
const B = `http://localhost:${PORT}`;
const PW = process.env.ADMIN_PASSWORD || "";
if (!PW) { console.error("ADMIN_PASSWORD is required"); process.exit(2); }

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "lock-"));
writeFileSync(join(tmp, "db.json"), JSON.stringify({ idCounter: 1, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] }));
/* Two seeded accounts with real hashes, exactly like production before the
   rotation — so the boot step has something to rotate and something to leave
   alone. */
writeFileSync(join(tmp, "users.json"), JSON.stringify([
  { id: "u_admin", name: "Marco Puga", email: "marco@example.com", role: "admin",
    permissions: {}, active: true, createdAt: "2026-06-05T00:00:00.000Z",
    avatarInitials: "MP", avatarColor: "#0ea5e9",
    passwordHash: "aaaa:bbbb", mustChangePassword: false },
  { id: "u_agent", name: "Carlos", email: "carlos@example.com", role: "agent",
    permissions: {}, active: true, createdAt: "2026-06-05T00:00:00.000Z",
    avatarInitials: "C", avatarColor: "#10b981",
    passwordHash: "cccc:dddd", mustChangePassword: false },
]));

const env = { ...process.env, PORT: String(PORT),
  DB_JSON_PATH: join(tmp, "db.json"), USERS_JSON_PATH: join(tmp, "users.json"),
  AUTH_DB_PATH: join(tmp, "auth.db"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  USER_PREFS_JSON_PATH: join(tmp, "user-prefs.json"),
  TRANSACTIONS_DB_PATH: join(tmp, "transactions.db"), CONTACT_RECORD_DB_PATH: join(tmp, "cr.db"),
  OUTREACH_DB_PATH: join(tmp, "outreach.db"), SMS_DB_PATH: join(tmp, "sms.db"),
  LISTINGS_DB_PATH: join(tmp, "listings.db"), CMA_DB_PATH: join(tmp, "cma.db"),
  TRACKER_DB_PATH: join(tmp, "tracker.db"),
};
delete env.SITE_LOGIN_ENABLED;
delete env.DASHBOARD_TOKEN;

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const until = async (fn, ms = 25000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

const raw = (p, o = {}) => fetch(B + p, { redirect: "manual", ...o });

try {
  ok("the lock arms itself with no env var set at all", /Site lock armed/.test(log), log.slice(-200));
  ok("and it says how many sessions it revoked", /session\(s\) revoked/.test(log));

  /* ── the gate, on the surfaces that were open ── */
  for (const [p, label] of [
    ["/crm", "the CRM page"],
    ["/dashboard", "the dashboard"],
    ["/shell", "the app shell"],
    ["/cma", "the CMA wizard"],
    ["/who", "the team identity picker"],
    ["/team", "the team admin page"],
  ]) {
    const r = await raw(p);
    ok(`${label} redirects to /login`, r.status === 302 && (r.headers.get("location") || "").startsWith("/login"),
      `${r.status} ${r.headers.get("location")}`);
  }

  /* THE STATIC BYPASS. Every page was also a plain file; this is the check
     that would have failed on the old build while /crm "passed". */
  for (const f of ["/crm-brivity.html", "/dashboard.html", "/cma.html", "/finance.html", "/team.html", "/shell.html"]) {
    const r = await raw(f);
    ok(`${f} is no longer served as a static file`, r.status === 302, String(r.status));
  }

  /* THE UNGATED APIs. None of these ever called the token check. */
  for (const p of [
    "/api/users", "/api/tracker/records", "/api/tasks", "/api/team/roster", "/api/team/chat",
    "/api/knowledge", "/api/scheduled", "/api/settings/command", "/api/browser/status",
    "/api/crm/lead/x/record", "/api/settings/table-prefs",
  ]) {
    const r = await raw(p);
    ok(`${p} requires a session`, r.status === 401, String(r.status));
  }
  /* And the ones that DID call it, which passed everyone when no token was set. */
  for (const p of ["/api/dashboard/data", "/api/cma/meta", "/api/mls/facets", "/api/transactions"]) {
    const r = await raw(p);
    ok(`${p} no longer opens just because no token is configured`, r.status === 401, String(r.status));
  }
  /* An API must answer JSON, not a redirect that fetch() reads as success. */
  const j = await (await raw("/api/users")).json();
  ok("an unauthenticated API call gets JSON, not a redirect", j.error === "Sign in required", JSON.stringify(j));

  /* A query string must not be able to walk past the path check. */
  for (const p of ["/api/users?x=/login", "/api/users?next=/health", "/api/users#/login"]) {
    ok(`a crafted query cannot fake a public path (${p})`, (await raw(p)).status === 401);
  }
  ok("and neither can a path that merely starts like a public one",
    (await raw("/login-history")).status === 302 || (await raw("/login-history")).status === 404,
    String((await raw("/login-history")).status));

  /* ── what must stay reachable ── */
  ok("/health stays open — Fly polls it to decide the machine is alive", (await raw("/health")).status === 200);
  ok("/login stays open, or nobody could ever sign in", (await raw("/login")).status === 200);
  const wh = await raw("/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  ok("the ManyChat webhook still accepts inbound DMs", wh.status !== 401 && wh.status !== 302, String(wh.status));
  const tw = await raw("/webhook/twilio", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "From=%2B15125550100&Body=hi" });
  ok("the Twilio webhook still accepts inbound SMS", tw.status !== 401 && tw.status !== 302, String(tw.status));
  const cl = await raw("/c/nope");
  ok("a client CMA link still resolves (404 for a real miss, not a login bounce)", cl.status === 404, String(cl.status));
  const lp = await raw("/l/nope");
  ok("a client listing link still resolves", lp.status === 404, String(lp.status));
  ok("the open pixel still fires", (await raw("/r/open?id=x")).status !== 302);

  /* ── signing in ── */
  let r = await raw("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "marco@example.com", password: "wrong-password" }) });
  ok("a wrong password is refused", r.status === 401, String(r.status));
  /* The pre-rotation hash must be dead — that account had a password before. */
  r = await raw("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "carlos@example.com", password: "anything" }) });
  ok("the other seeded account is not a way in either", r.status === 401, String(r.status));

  r = await raw("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "marco@example.com", password: PW }) });
  ok("the issued credential signs the admin in", r.status === 200, String(r.status));
  const setCookie = r.headers.get("set-cookie") || "";
  ok("the session cookie is HttpOnly", /HttpOnly/i.test(setCookie), setCookie.slice(0, 120));
  ok("and SameSite-scoped", /SameSite=Lax/i.test(setCookie));
  const cookie = setCookie.split(";")[0];

  const auth = { headers: { cookie } };

  /* The flag existed before this change and nothing read it, so a temporary
     password would have worked forever. Asserted before the change, while it
     is still true. */
  const me = await (await raw("/api/auth/me", auth)).json();
  ok("the account is flagged to change its password at first login", me.user.mustChangePassword === true,
    JSON.stringify(me.user.mustChangePassword));

  /* A temporary password gets you exactly as far as the change-password page.
     This is the check that makes the shipped credential single-use. */
  let cp = await raw("/crm", auth);
  ok("a temporary password cannot reach the CRM yet",
    cp.status === 302 && (cp.headers.get("location") || "").startsWith("/change-password"),
    `${cp.status} ${cp.headers.get("location")}`);
  ok("nor the static file behind it", (await raw("/crm-brivity.html", auth)).status === 302);
  const capi = await raw("/api/users", auth);
  ok("and the APIs say why rather than just refusing", capi.status === 403);
  ok("with a flag the page can act on", (await capi.json()).mustChangePassword === true);
  ok("the change-password page itself is reachable", (await raw("/change-password", auth)).status === 200);

  ok("a short new password is refused by the server, not just the page",
    (await raw("/api/auth/change-password", { method: "POST", ...auth,
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: PW, newPassword: "short1234" }) })).status === 400);
  ok("re-using the issued password is refused",
    (await raw("/api/auth/change-password", { method: "POST", ...auth,
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: PW, newPassword: PW }) })).status === 400);
  ok("a wrong current password is refused",
    (await raw("/api/auth/change-password", { method: "POST", ...auth,
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "nope", newPassword: "a-real-long-one-9182" }) })).status === 401);

  const NEWPW = "correct-horse-battery-9182";
  r = await raw("/api/auth/change-password", { method: "POST", ...auth,
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: PW, newPassword: NEWPW }) });
  ok("changing the password succeeds", r.status === 200, String(r.status));

  ok("and now the CRM page opens", (await raw("/crm", auth)).status === 200);
  ok("so does the static file behind it", (await raw("/crm-brivity.html", auth)).status === 200);
  ok("and the APIs answer", (await raw("/api/users", auth)).status === 200);

  /* The issued credential must be dead the moment it is replaced. */
  const old = await raw("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "marco@example.com", password: PW }) });
  ok("the issued credential no longer works once replaced", old.status === 401, String(old.status));
  const fresh = await raw("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "marco@example.com", password: NEWPW }) });
  ok("the operator's own password does", fresh.status === 200, String(fresh.status));

  /* The hash leak. This endpoint was handing scrypt hashes to anonymous
     callers; signed in it must still never return them. */
  const users = await (await raw("/api/users", auth)).json();
  ok("/api/users never returns a password hash, even to an admin",
    users.users.length === 2 && users.users.every((u) => u.passwordHash === undefined),
    JSON.stringify(users.users.map((u) => Object.keys(u).includes("passwordHash"))));


  /* Signing out must actually end it. */
  await raw("/api/auth/logout", { method: "POST", ...auth });
  ok("after logout the session is dead", (await raw("/api/users", auth)).status === 401);

  /* The rotation is once-per-marker, not once-per-boot: a restart must not
     wipe a password the operator has since set. */
  srv.kill("SIGKILL");
  await new Promise((r2) => setTimeout(r2, 600));
  const srv2 = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let log2 = ""; srv2.stdout.on("data", (d) => (log2 += d)); srv2.stderr.on("data", (d) => (log2 += d));
  await until(async () => (await fetch(B + "/health")).ok);
  ok("a restart does not re-run the rotation", !/Site lock armed/.test(log2), log2.slice(-160));
  ok("and the lock is still on after that restart", (await raw("/api/users")).status === 401);
  /* The real point of the marker: a restart must not clobber the password the
     operator set two steps ago. */
  const after = await raw("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "marco@example.com", password: NEWPW }) });
  ok("and the operator's own password survived the restart", after.status === 200, String(after.status));
  srv2.kill("SIGKILL");
} catch (err) {
  fail.push("threw: " + (err && err.stack ? err.stack : String(err)));
  console.error(err);
} finally {
  srv.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("\nFAILURES:\n" + fail.map((f) => " - " + f).join("\n")); if (process.env.DUMP_LOG) console.error(log.slice(-3000)); process.exit(1); }
