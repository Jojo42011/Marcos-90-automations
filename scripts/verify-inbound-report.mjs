#!/usr/bin/env node
/**
 * The inbound DM report — "did a message actually arrive, and when did it stop".
 *
 * WHY THIS SUITE IS SHAPED LIKE THIS. The report exists to settle one argument:
 * when the TikTok automation goes quiet, is this server declining to answer, or
 * was there nothing to answer? Those need opposite fixes, and the report is
 * useless — worse than useless — if it can confuse them. So the fixtures are
 * built as the three situations that actually occur:
 *
 *   a LIVE channel      — traffic today, must read as "reaching this server"
 *   a DEAD channel      — traffic that stops on a date, must read as "stopped"
 *                         and must name the date it stopped
 *   a channel that      — must not be described as "stopped", because it never
 *   never worked          started, and the operator would go looking in the
 *                         wrong place
 *
 * The other trap is counting our own replies as evidence of life. An assistant
 * message is this server talking to itself; a report that counted it would show
 * a dead channel as healthy, which is the exact failure it is meant to catch.
 *
 * Usage: node scripts/verify-inbound-report.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 3980);
const B = `http://localhost:${PORT}`;
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "inbound-"));
const DAY = 86400000;
const iso = (daysAgo, hour = 12) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

const mkLead = (id, platform) => ({
  id, platform, userId: id, username: id, name: id,
  phone: null, email: null, state: "new", source: platform, adCampaign: null,
  propertyInquired: null, criteria: null, brivityId: null,
  crmStatus: "new", crmStage: "new_lead", crmPriority: "normal", crmIntent: "buyer",
  crmCallQueue: "none", crmNotes: null, tags: [], address: null,
  birthday: null, homeAnniversary: null, autoPlanEnrollments: [],
  assignedUserId: null, assignedUserName: null,
  createdAt: iso(40), updatedAt: iso(0),
});

const leads = {};
const convos = {};
const add = (id, platform, msgs) => { leads[id] = mkLead(id, platform); convos[id] = { messages: msgs }; };

/* instagram: alive — inbound today and through the week. */
add("ig_1", "instagram", [
  { role: "user", text: "hi", at: iso(0, 9) },
  { role: "assistant", text: "hey", at: iso(0, 9) },
  { role: "user", text: "still looking", at: iso(2) },
]);
add("ig_2", "instagram", [{ role: "user", text: "info", at: iso(5) }]);

/* tiktok: dead — a healthy run that stops 9 days ago, then only OUR replies.
   The trailing assistant messages are the trap: a report that counted them
   would call this channel alive. */
add("tt_1", "tiktok", [
  { role: "user", text: "wow", at: iso(14) },
  { role: "user", text: "where", at: iso(12) },
  { role: "user", text: "price?", at: iso(9) },
  { role: "assistant", text: "sent you the breakdown", at: iso(1) },
  { role: "assistant", text: "following up", at: iso(0, 8) },
]);
add("tt_2", "tiktok", [
  { role: "user", text: "nice", at: iso(11) },
  { role: "user", text: "beautiful", at: iso(11) },
]);

/* snapchat: THE TRAP THIS SUITE EXISTS FOR.
   Healthy traffic that stops 20 days ago, then a SINGLE message today from one
   person testing. Recency alone calls this channel alive ("last inbound today"),
   which is precisely how a 16-day TikTok outage got described as "4 days ago"
   during the real diagnosis and sent it the wrong way. The 20-day hole is the
   fact; the one recent message is not evidence of recovery. */
add("sc_1", "snapchat", [
  { role: "user", text: "hi", at: iso(26) },
  { role: "user", text: "info?", at: iso(25) },
  { role: "user", text: "cost", at: iso(24) },
  { role: "user", text: "just a test", at: iso(0, 2) },
]);

/* facebook: never had a single inbound message. */
add("fb_1", "facebook", [{ role: "assistant", text: "opener", at: iso(3) }]);

writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 50, leadsById: leads,
  leadKeyToId: Object.fromEntries(Object.values(leads).map((l) => [l.platform + "::" + l.userId, l.id])),
  conversationsByLeadId: convos, commandTasks: [],
}));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db"), KNOWLEDGE_JSON_PATH: join(tmp, "knowledge.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };

try {
  await until(async () => (await fetch(B + "/health")).ok);
  const r = await (await fetch(B + "/api/dm/inbound-report?days=60")).json();
  const tt = r.platforms.tiktok, ig = r.platforms.instagram, fb = r.platforms.facebook;

  // ---- the dead channel, which is the reported symptom ---------------------
  ok("the dead channel reports its last inbound, not its last reply",
    tt.lastInboundAt.slice(0, 10) === iso(9).slice(0, 10), tt.lastInboundAt);
  ok("our own replies are not counted as inbound", tt.inbound24h === 0, String(tt.inbound24h));
  ok("it is not described as alive", !/ARE reaching/.test(r.verdict), r.verdict.slice(0, 90));
  ok("the verdict says the traffic stopped", /STOPPED/.test(r.verdict), r.verdict.slice(0, 120));
  ok("and gives the age in days so the date can be matched to an event",
    /\d+\.\d days ago \(20\d\d-\d\d-\d\d/.test(r.verdict), r.verdict.slice(0, 160));
  ok("the verdict points upstream rather than into this codebase",
    /upstream of it/.test(r.verdict) && /ManyChat/.test(r.verdict));
  /* Four days carried traffic (14, 12, 11 twice, 9 days ago) and then nothing —
     the gap after the last one is the cliff the operator is looking for. */
  ok("the day histogram shows the cliff",
    Object.keys(tt.byDay).length === 4 &&
    tt.byDay[iso(9).slice(0, 10)] === 1 &&
    tt.byDay[iso(11).slice(0, 10)] === 2 &&
    Object.keys(tt.byDay).sort().pop() === iso(9).slice(0, 10), JSON.stringify(tt.byDay));
  ok("silent days are omitted rather than printed as zeroes",
    !Object.values(tt.byDay).some((n) => n === 0));
  ok("counts are consistent across the windows",
    tt.inbound7d === 0 && tt.inbound30d === 5 && tt.inboundInWindow === 5,
    JSON.stringify([tt.inbound7d, tt.inbound30d, tt.inboundInWindow]));
  ok("hoursSinceLastInbound is real", tt.hoursSinceLastInbound > 200 && tt.hoursSinceLastInbound < 250,
    String(tt.hoursSinceLastInbound));

  // ---- the live channel ----------------------------------------------------
  const live = await (await fetch(B + "/api/dm/inbound-report?platform=instagram")).json();
  ok("a live channel is reported as reaching the server", /ARE reaching this server/.test(live.verdict), live.verdict.slice(0, 100));
  ok("and the live verdict rules the connection out rather than in",
    /NOT a broken connection/.test(live.verdict));
  ok("live counts are right", ig.inbound24h === 1 && ig.inbound7d === 3, JSON.stringify([ig.inbound24h, ig.inbound7d]));
  ok("contacts are counted once each regardless of message count",
    ig.contactsWithInbound === 2 && tt.contactsWithInbound === 2,
    JSON.stringify([ig.contactsWithInbound, tt.contactsWithInbound]));

  // ---- never worked vs stopped working ------------------------------------
  const never = await (await fetch(B + "/api/dm/inbound-report?platform=facebook")).json();
  ok("a channel with only outbound has no inbound recorded", !fb || fb.lastInboundAt === null,
    JSON.stringify(fb));
  ok("never-worked is not described as stopped",
    /has EVER reached/.test(never.verdict) && !/STOPPED/.test(never.verdict), never.verdict.slice(0, 110));
  const unknown = await (await fetch(B + "/api/dm/inbound-report?platform=whatsapp")).json();
  ok("an unknown platform says so plainly rather than erroring", /No inbound whatsapp message has EVER/.test(unknown.verdict));

  // ---- an outage must not hide behind one recent message -------------------
  /* The whole point. A single test message arriving today must not make a
     20-day hole read as a working channel. */
  const sc = await (await fetch(B + "/api/dm/inbound-report?days=60&platform=snapchat")).json();
  const scp = sc.platforms.snapchat;
  ok("a recent isolated message does NOT get called a working channel",
    !/ARE reaching this server/.test(sc.verdict), sc.verdict.slice(0, 120));
  ok("the verdict says plainly that it is not healthy",
    /NOT healthy/.test(sc.verdict), sc.verdict.slice(0, 120));
  ok("it names the silence before the recent message rather than the recency",
    /silent for 2[0-9] days/.test(sc.verdict), sc.verdict.slice(0, 220));
  ok("it calls the recent message what it is — one person, probably a test",
    /probably a test/.test(sc.verdict));
  ok("it reports distinct contacts, not just message count",
    /1 distinct contact/.test(sc.verdict), sc.verdict.slice(0, 260));
  ok("the longest silence is reported as a number, with its dates",
    /longest silence in this window is 2[0-9] days/.test(sc.verdict) &&
    /20\d\d-\d\d-\d\d → 20\d\d-\d\d-\d\d/.test(sc.verdict), sc.verdict.slice(0, 300));
  ok("it still points upstream", /upstream of this server/.test(sc.verdict));

  // the machine-readable fields behind that sentence
  ok("longestGapDays is exposed for the caller", scp.longestGapDays >= 20, String(scp.longestGapDays));
  ok("the gap is dated at both ends", !!scp.gapStart && !!scp.gapEnd, JSON.stringify([scp.gapStart, scp.gapEnd]));
  ok("the isolated last day is flagged", scp.lastDayIsolated === true, String(scp.lastDayIsolated));
  ok("distinct 7-day contacts are counted, not messages", scp.contacts7d === 1, String(scp.contacts7d));

  /* And the inverse: a genuinely busy channel must not be smeared as unhealthy
     just because it had a quiet stretch a month ago. */
  ok("a genuinely live channel is still called live", /ARE reaching this server/.test(live.verdict));
  ok("a live channel is not flagged as isolated", ig.lastDayIsolated !== true, String(ig.lastDayIsolated));

  /* A channel that is simply dead reports how long it has been dead. */
  ok("a dead channel reports its trailing silence", tt.trailingSilentDays >= 9, String(tt.trailingSilentDays));
  ok("and the stopped verdict states the ongoing silence",
    /Silent for \d+ day\(s\) and counting/.test(r.verdict), r.verdict.slice(0, 260));

  // ---- it must not leak what people wrote ---------------------------------
  const body = JSON.stringify(r);
  ok("the report carries no message text",
    !body.includes("beautiful") && !body.includes("price?") && !body.includes("still looking"));
  ok("and no handles or names", !body.includes("tt_1") && !body.includes("ig_1"));

  // ---- the window is bounded ----------------------------------------------
  const narrow = await (await fetch(B + "/api/dm/inbound-report?days=10")).json();
  ok("a narrower window excludes older traffic",
    narrow.platforms.tiktok.inboundInWindow === 1 && tt.inboundInWindow === 5,
    JSON.stringify([narrow.platforms.tiktok.inboundInWindow, tt.inboundInWindow]));
  ok("but lastInboundAt still reports the true last one, window or not",
    narrow.platforms.tiktok.lastInboundAt === tt.lastInboundAt);
  const clamped = await (await fetch(B + "/api/dm/inbound-report?days=99999")).json();
  ok("an absurd window is clamped", clamped.windowDays === 365, String(clamped.windowDays));

  // ---- it stays behind the lock -------------------------------------------
  srv.kill("SIGKILL");
  const locked = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT + 1), SITE_LOGIN_ENABLED: "1",
      DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
      DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth2.db"), KNOWLEDGE_JSON_PATH: join(tmp, "k2.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  locked.stdout.on("data", () => {}); locked.stderr.on("data", () => {});
  try {
    await until(async () => (await fetch(`http://localhost:${PORT + 1}/health`)).ok);
    const shut = await fetch(`http://localhost:${PORT + 1}/api/dm/inbound-report`);
    ok("the report is behind the site lock — it describes real conversations", shut.status === 401, String(shut.status));
  } finally {
    locked.kill("SIGKILL");
  }
} catch (e) {
  fail.push("EXCEPTION " + (e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  try { srv.kill("SIGKILL"); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); console.error("\n--- server log ---\n" + log.slice(-2000)); process.exit(1); }
