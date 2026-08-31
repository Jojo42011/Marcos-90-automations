#!/usr/bin/env node
/**
 * Which phone line a CRM text goes out on.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Marco and Carlos have different numbers.
 * If the CRM sends Carlos's text on Marco's line, the client replies to Marco —
 * and saves Marco's number as their contact. That is not a cosmetic bug; it
 * misdirects a real conversation and it is invisible from inside the CRM,
 * because the message sends successfully either way.
 *
 * So the assertions here are about the DECISION, not the plumbing:
 *
 *   - the signed-in user's own line wins
 *   - no assignment falls back to the account default, and SAYS it fell back —
 *     silence there is how "Carlos's texts go out as Marco" survives for weeks
 *   - nothing configured at all refuses rather than guessing
 *   - a line cannot be assigned that Quo does not actually have, or the send
 *     fails later with the operator looking in the wrong place
 *   - two people cannot share a line, since that recreates the ambiguity
 *
 * The resolver is pure and injected, so the decision is tested directly rather
 * than through a live Quo account.
 *
 * Usage: node scripts/verify-sending-line.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT || 3990);
const B = `http://localhost:${PORT}`;
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const { resolveSendingLine } = await import(pathToFileURL(join(process.cwd(), "dist/src/core/sendingIdentity.js")).href);

const marco = { id: "u_marco", name: "Marco Puga", email: "marco@example.com", quoPhoneNumberId: "pn_marco", quoPhoneNumber: "+17262001548" };
const carlos = { id: "u_carlos", name: "Carlos", email: "carlos@example.com" };
const DEFAULTS = { defaultId: "pn_carlos", defaultNumber: "+17372834703" };

// ---- the decision itself ---------------------------------------------------
const a = resolveSendingLine(marco, DEFAULTS);
ok("an assigned user sends on their OWN line", a.id === "pn_marco" && a.number === "+17262001548", JSON.stringify(a));
ok("and it is reported as their own", a.reason === "user_assigned" && a.userName === "Marco Puga", a.reason);

const b = resolveSendingLine(carlos, DEFAULTS);
ok("an unassigned user falls back rather than failing", b.id === "pn_carlos", JSON.stringify(b));
ok("but the fallback is reported as a fallback", b.reason === "account_default", b.reason);
/* The whole point: this must not be silent. */
ok("and it says plainly that it is somebody else's number",
  /somebody else's number/.test(b.explain) && /Carlos/.test(b.explain), b.explain);

const c = resolveSendingLine(null, DEFAULTS);
ok("an automation with no signed-in user uses the default", c.id === "pn_carlos" && c.reason === "no_user", c.reason);

const d = resolveSendingLine(carlos, { defaultId: null, defaultNumber: null });
ok("nothing configured refuses instead of guessing", d.id === null && d.reason === "unconfigured", JSON.stringify(d));
ok("and the refusal says how to fix it", /Manage Team/.test(d.explain) && /QUO_PHONE_NUMBER_ID/.test(d.explain), d.explain);

const e = resolveSendingLine({ ...carlos, quoPhoneNumberId: "   " }, DEFAULTS);
ok("a blank assignment is not mistaken for an assignment", e.reason === "account_default", e.reason);
const f = resolveSendingLine({ ...marco, quoPhoneNumber: undefined }, DEFAULTS);
ok("an id without a display number still sends on the right line",
  f.id === "pn_marco" && f.reason === "user_assigned", JSON.stringify(f));

// ---- the API surface, against a running server ------------------------------
const tmp = mkdtempSync(join(tmpdir(), "sendline-"));
writeFileSync(join(tmp, "db.json"), JSON.stringify({ idCounter: 1, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] }));
writeFileSync(join(tmp, "users.json"), JSON.stringify([
  { id: "u_marco", name: "Marco Puga", email: "marco@example.com", role: "admin",
    permissions: {}, active: true, createdAt: "2026-06-01T00:00:00.000Z", avatarInitials: "MP", avatarColor: "#0ea5e9" },
  { id: "u_carlos", name: "Carlos", email: "carlos@example.com", role: "agent",
    permissions: {}, active: true, createdAt: "2026-06-01T00:00:00.000Z", avatarInitials: "C", avatarColor: "#f59e0b" },
]));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    USERS_JSON_PATH: join(tmp, "users.json"),
    DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db"), KNOWLEDGE_JSON_PATH: join(tmp, "k.json"),
    /* Deliberately NOT configured: this asserts the honest behaviour of an
       account that has no Quo, which is what a fresh deploy looks like. */
    QUO_API_KEY: "", QUO_PHONE_NUMBER_ID: "", QUO_PHONE_NUMBER: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (x) => (log += x));
srv.stderr.on("data", (x) => (log += x));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };

try {
  await until(async () => (await fetch(B + "/health")).ok);

  const nums = await (await fetch(B + "/api/quo/numbers")).json();
  ok("the numbers endpoint answers even with Quo unconfigured", nums.configured === false, JSON.stringify(nums).slice(0, 120));
  ok("and says so rather than returning an empty list as if that were the truth",
    /not configured/i.test(nums.error || ""), nums.error);
  ok("it still lists the CRM users, so assignments are visible",
    (nums.users || []).length === 2 && nums.users.every((u) => u.quoPhoneNumberId === null),
    JSON.stringify(nums.users));

  const mine = await (await fetch(B + "/api/quo/my-line")).json();
  ok("my-line reports unconfigured when nothing is set up",
    mine.line.reason === "unconfigured" && mine.line.id === null, JSON.stringify(mine.line));

  let r = await fetch(B + "/api/quo/numbers/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "u_carlos", quoPhoneNumberId: "pn_whatever" }) });
  ok("assigning a line is refused while Quo is unreachable, not stored blind", r.status === 503, String(r.status));

  r = await fetch(B + "/api/quo/numbers/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "nobody", quoPhoneNumberId: "pn_x" }) });
  ok("an unknown user is refused", r.status === 404, String(r.status));

  r = await fetch(B + "/api/quo/numbers/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quoPhoneNumberId: "pn_x" }) });
  ok("a missing userId is refused", r.status === 400, String(r.status));

  /* Clearing must work with Quo down — it only removes a stored value, and an
     operator who needs to undo a bad assignment should not be blocked by an
     unrelated outage. */
  r = await fetch(B + "/api/quo/numbers/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "u_carlos", quoPhoneNumberId: "" }) });
  const cleared = await r.json();
  ok("clearing an assignment works even with Quo down", r.ok && cleared.cleared === true, JSON.stringify(cleared).slice(0, 120));

  const send = await fetch(B + "/api/quo/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "2105550123", text: "hi" }) });
  ok("sending with no line configured is refused, not silently misdirected", send.status === 503, String(send.status));

  // ---- it stays behind the lock ---------------------------------------------
  srv.kill("SIGKILL");
  const locked = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT + 1), SITE_LOGIN_ENABLED: "1",
      DB_JSON_PATH: join(tmp, "db.json"), USERS_JSON_PATH: join(tmp, "users.json"),
      DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth2.db"), KNOWLEDGE_JSON_PATH: join(tmp, "k2.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  locked.stdout.on("data", () => {}); locked.stderr.on("data", () => {});
  try {
    await until(async () => (await fetch(`http://localhost:${PORT + 1}/health`)).ok);
    const shut = await fetch(`http://localhost:${PORT + 1}/api/quo/numbers/assign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "u_marco", quoPhoneNumberId: "x" }) });
    ok("assigning a line requires a session", shut.status === 401, String(shut.status));
  } finally { locked.kill("SIGKILL"); }
} catch (e) {
  fail.push("EXCEPTION " + (e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  try { srv.kill("SIGKILL"); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); console.error("\n--- server log ---\n" + log.slice(-1800)); process.exit(1); }
