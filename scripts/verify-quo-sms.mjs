#!/usr/bin/env node
/**
 * Quo SMS in the CRM: the mirror, the SMS tab, and sending.
 *
 * The two things that were wrong before this feature are the two things worth
 * proving: the SMS tab was permanently dim because nothing ever carried the
 * "sms" channel, and the composer's send only pushed a bubble into local state
 * — it never put a text on the wire. So this checks that Quo threads reach the
 * tab, that opening one loads its real history, and above all that a FAILED
 * send leaves no bubble behind. A text that didn't go out must never sit in
 * the thread looking delivered.
 *
 * Runs against a seeded local quo.db and a stubbed Quo API — no real API key,
 * no real text messages sent.
 *
 * Usage: node scripts/verify-quo-sms.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const PORT = Number(process.env.PORT || 3412);
const B = `http://localhost:${PORT}`;
const TOKEN = "verify-quo-token";
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "quo-"));
const quoDb = join(tmp, "quo.db");

// ---- seed the mirror with two threads --------------------------------------
{
  const db = new Database(quoDb);
  db.exec(`CREATE TABLE quo_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
    phone_number_id TEXT NOT NULL, peer_key TEXT NOT NULL, peer TEXT NOT NULL, direction TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, user_id TEXT)`);
  db.exec(`CREATE TABLE quo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const ins = db.prepare(`INSERT INTO quo_messages VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const rows = [
    ["M1", "C1", "PN1", "2105550101", "+12105550101", "incoming", "Is the Blanco house still available?", "received", "2026-08-12T15:00:00.000Z", null],
    ["M2", "C1", "PN1", "2105550101", "+12105550101", "outgoing", "It is — want to see it Saturday?", "delivered", "2026-08-12T15:04:00.000Z", "U1"],
    ["M3", "C1", "PN1", "2105550101", "+12105550101", "incoming", "Yes please, morning works", "received", "2026-08-12T15:09:00.000Z", null],
    ["M4", "C2", "PN1", "8305550777", "+18305550777", "incoming", "Sending the survey over now", "received", "2026-08-11T18:00:00.000Z", null],
  ];
  for (const r of rows) ins.run(...r);
  db.close();
}

writeFileSync(join(tmp, "db.json"), JSON.stringify({ idCounter: 1, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] }));

// ---- boot the server -------------------------------------------------------
const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT), DASHBOARD_TOKEN: TOKEN,
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "t.json"),
    EMAIL_DB_PATH: join(tmp, "e.db"), TRANSACTIONS_DB_PATH: join(tmp, "x.db"),
    QUO_DB_PATH: quoDb,
    /* A syntactically valid but fake key: the routes must work off the local
       mirror, and nothing here may reach the real Quo account. */
    QUO_API_KEY: "test-key-not-real", QUO_PHONE_NUMBER_ID: "PN1", QUO_PHONE_NUMBER: "+17372834703",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const until = async (fn, ms = 25000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

try {
  // ---- API layer -----------------------------------------------------------
  const q = (p) => fetch(B + p + (p.includes("?") ? "&" : "?") + "token=" + TOKEN);

  const threads = await (await q("/api/quo/threads")).json();
  ok("thread list returns one row per counterparty", threads.threads?.length === 2, JSON.stringify(threads).slice(0, 200));
  ok("threads are newest first", threads.threads?.[0]?.peerKey === "2105550101");
  ok("summary carries the last line and a count",
    threads.threads?.[0]?.lastText === "Yes please, morning works" && threads.threads?.[0]?.messageCount === 3,
    JSON.stringify(threads.threads?.[0]));

  const one = await (await q("/api/quo/threads/+1%20(210)%20555-0101")).json();
  ok("a thread loads by any phone format, oldest first",
    one.messages?.length === 3 && one.messages[0].id === "M1", JSON.stringify(one).slice(0, 160));

  ok("threads endpoint requires the dashboard token",
    (await fetch(B + "/api/quo/threads")).status === 401);

  // The webhook must not accept anything without the guard token.
  const spoof = await fetch(B + "/api/quo/webhook", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "SPOOF", direction: "incoming", from: "+12105559999", text: "fake" }),
  });
  const afterSpoof = await (await q("/api/quo/threads")).json();
  ok("an unguarded webhook post is refused", spoof.status === 202 && afterSpoof.threads.length === 2,
    "status " + spoof.status + ", threads " + afterSpoof.threads.length);

  // With the right key it stores — same code path Quo will hit.
  const { createHash } = await import("node:crypto");
  const secret = createHash("sha256").update("quo-webhook:test-key-not-real").digest("hex").slice(0, 24);
  const good = await fetch(B + "/api/quo/webhook?key=" + secret, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { id: "M5", direction: "incoming", from: "+12105550101", text: "See you Saturday", createdAt: "2026-08-12T16:00:00.000Z", conversationId: "C1", phoneNumberId: "PN1", status: "received" } }),
  });
  const afterHook = await (await q("/api/quo/threads")).json();
  ok("a guarded webhook post lands in the thread",
    good.ok && afterHook.threads[0].messageCount === 4, "count " + afterHook.threads[0]?.messageCount);
  // Replay must not double-post: Quo retries, and a poll covers the same id.
  await fetch(B + "/api/quo/webhook?key=" + secret, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { id: "M5", direction: "incoming", from: "+12105550101", text: "See you Saturday", createdAt: "2026-08-12T16:00:00.000Z" } }),
  });
  const afterReplay = await (await q("/api/quo/threads")).json();
  ok("a replayed webhook does not duplicate", afterReplay.threads[0].messageCount === 4, "count " + afterReplay.threads[0]?.messageCount);

  // Send validation happens before any network call.
  const badTo = await fetch(B + "/api/quo/send?token=" + TOKEN, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "12", text: "hi" }),
  });
  ok("send rejects a number that isn't dialable", badTo.status === 400);
  const noText = await fetch(B + "/api/quo/send?token=" + TOKEN, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "2105550101", text: "  " }),
  });
  ok("send rejects an empty message", noText.status === 400);

  // ---- the CRM page --------------------------------------------------------
  const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await br.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto(B + "/crm?token=" + TOKEN, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.click('.rail .r[data-view="messages"]').catch(() => {});
  await page.waitForTimeout(1200);

  ok("no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));

  const smsTab = await page.evaluate(() => {
    const b = document.querySelector('#msgTabs [data-mt="sms"]');
    return { dim: b.classList.contains("quiet"), count: b.querySelector("[data-cc]").textContent };
  });
  ok("the SMS tab is no longer greyed out", smsTab.dim === false, JSON.stringify(smsTab));

  await page.click('#msgTabs [data-mt="sms"]');
  await page.waitForTimeout(600);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll("#convList .conv"))
    .map((r) => r.querySelector(".conv-names").textContent.trim()));
  ok("both Quo threads show under SMS", rows.length === 2, JSON.stringify(rows));
  ok("an unknown number is shown formatted, not raw E.164",
    rows.some((r) => r.includes("(210) 555-0101")), JSON.stringify(rows));

  // Opening a thread must load the real history, not just the preview line.
  await page.click("#convList .conv");
  await page.waitForTimeout(900);
  const bubbles = await page.evaluate(() => Array.from(document.querySelectorAll("#threadBody .bub"))
    .map((b) => ({ me: b.classList.contains("me"), t: b.childNodes[0]?.textContent || "" })));
  ok("opening a thread loads its full history", bubbles.length === 4, JSON.stringify(bubbles).slice(0, 200));
  ok("direction is preserved (their message is not shown as Marco's)",
    bubbles[0].me === false && bubbles[1].me === true, JSON.stringify(bubbles.slice(0, 2)));
  const head = await page.textContent(".thread-head .th-sub");
  ok("the thread header shows the real number", /\(210\) 555-0101/.test(head), head);

  // ---- the part that matters: a failed send leaves nothing behind ----------
  await page.route("**/api/quo/send*", (r) =>
    r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "A2P brand not registered" }) }));
  await page.fill("#threadInput", "this one should fail");
  await page.click("#threadSend");
  await page.waitForTimeout(700);
  const afterFail = await page.evaluate(() => ({
    bubbles: document.querySelectorAll("#threadBody .bub").length,
    toast: (document.querySelector(".crm-toast, #crmToast")?.textContent || ""),
  }));
  ok("a failed send adds NO message to the thread", afterFail.bubbles === 4, JSON.stringify(afterFail));
  ok("a failed send says why, in Quo's words", /A2P brand not registered/.test(afterFail.toast), afterFail.toast);

  // A successful send posts to the right place with the right body.
  let sentBody = null;
  await page.unroute("**/api/quo/send*");
  await page.route("**/api/quo/send*", async (r) => {
    sentBody = JSON.parse(r.request().postData() || "{}");
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, id: "M9", status: "queued" }) });
  });
  await page.fill("#threadInput", "On my way");
  await page.click("#threadSend");
  await page.waitForTimeout(700);
  const afterOk = await page.evaluate(() => Array.from(document.querySelectorAll("#threadBody .bub"))
    .map((b) => ({ me: b.classList.contains("me"), t: b.childNodes[0]?.textContent || "" })));
  ok("a successful send appends the message", afterOk.length === 5 && afterOk[4].t === "On my way", JSON.stringify(afterOk.slice(-1)));
  ok("the send addresses the thread's real number",
    sentBody && sentBody.to === "+12105550101" && sentBody.text === "On my way", JSON.stringify(sentBody));

  await page.close();
  await br.close();
} finally {
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:\n - " + fail.join("\n - ")); process.exit(1); }
