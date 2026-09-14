/**
 * verify-zernio-webhook.mjs — the Zernio TikTok DM transport.
 *
 * Two halves, because they fail for different reasons:
 *
 *   STATIC  — the parser and signature verifier, driven directly. These are the
 *             refusals, and they matter more than the happy path: a bad
 *             signature that passes, or an outgoing echo treated as inbound,
 *             are both worse than no integration at all.
 *   LIVE    — the real route on a real server. The whole design rests on
 *             acking inside Zernio's 5-second budget while the pipeline runs
 *             afterwards, and that is a property of the ROUTE, not of any
 *             function. Only a live request can show it.
 *
 * Run:  node scripts/verify-zernio-webhook.mjs
 * Expects a built dist/ (npm run build) and, for the live half, a server it
 * starts itself on PORT_TEST.
 */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const SECRET = "test-secret-do-not-use-in-production";
const PORT = process.env.PORT_TEST || "3999";
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function sign(body, secret = SECRET) {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

function inboundBody(over = {}) {
  return JSON.stringify({
    id: over.eventId ?? "evt_test_1",
    event: over.event ?? "message.received",
    message: {
      id: "msg_1",
      conversationId: over.conversationId ?? "conv_1",
      platform: "tiktok",
      platformMessageId: "ptf_1",
      direction: over.direction ?? "incoming",
      text: "text" in over ? over.text : "how much is this home?",
      attachments: [],
      sender: "sender" in over ? over.sender : { id: "tt_user_123", name: "Jane B", username: "janeb" },
      sentAt: "2026-09-14T10:30:00.000Z",
      isRead: false,
    },
    conversation: {
      id: over.conversationId ?? "conv_1",
      platformConversationId: "ptfconv_1",
      participantId: "participantId" in over ? over.participantId : "tt_user_123",
      participantName: "Jane B",
      participantUsername: "janeb",
      status: "active",
    },
    account: { id: "acct_1", accountId: "acct_1", platform: "tiktok", username: "puga.realtor" },
    timestamp: "2026-09-14T10:30:00.000Z",
  });
}

// ─────────────────────────── STATIC ───────────────────────────
async function staticChecks() {
  console.log("\nSTATIC — parser and signature");
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  process.env.ZERNIO_DM_API_KEY = "sk_test_not_a_real_key";
  const dm = await import("../dist/src/integrations/zernio/dm.js");

  // Signature
  const body = inboundBody();
  check("valid signature accepted", dm.verifyZernioSignature(body, sign(body)));
  check("tampered body rejected", !dm.verifyZernioSignature(body + " ", sign(body)));
  check("wrong secret rejected", !dm.verifyZernioSignature(body, sign(body, "other-secret")));
  check("empty signature rejected", !dm.verifyZernioSignature(body, ""));
  check("truncated signature rejected", !dm.verifyZernioSignature(body, sign(body).slice(0, 32)));
  check(
    "uppercase hex signature accepted (case-normalised)",
    dm.verifyZernioSignature(body, sign(body).toUpperCase()),
  );

  // Secret unset must NOT mean "everything passes"
  const saved = process.env.ZERNIO_WEBHOOK_SECRET;
  delete process.env.ZERNIO_WEBHOOK_SECRET;
  check("unset secret rejects rather than opens", !dm.verifyZernioSignature(body, sign(body)));
  process.env.ZERNIO_WEBHOOK_SECRET = saved;

  // Parser — the refusals
  const good = dm.parseZernioInboundMessage(JSON.parse(inboundBody()));
  check("inbound message parses", good !== null);
  check("sender id becomes the lead key", good?.senderId === "tt_user_123", `got ${good?.senderId}`);
  check("conversationId captured", good?.conversationId === "conv_1");
  check("accountId captured", good?.accountId === "acct_1");
  check("platform is tiktok", good?.platform === "tiktok");

  check(
    "OUR OWN outgoing echo is refused (no self-reply loop)",
    dm.parseZernioInboundMessage(JSON.parse(inboundBody({ direction: "outgoing" }))) === null,
  );
  check(
    "non-message event refused",
    dm.parseZernioInboundMessage(JSON.parse(inboundBody({ event: "post.published" }))) === null,
  );
  check(
    "missing sender id refused (would merge every such lead into one thread)",
    dm.parseZernioInboundMessage(
      JSON.parse(inboundBody({ sender: { name: "No Id" }, participantId: undefined })),
    ) === null,
  );
  check("garbage body refused", dm.parseZernioInboundMessage({ nope: true }) === null);
  check("null body refused", dm.parseZernioInboundMessage(null) === null);

  // Attachment-only message keeps the turn rather than dropping it
  const noText = dm.parseZernioInboundMessage(JSON.parse(inboundBody({ text: null })));
  check("attachment-only message still parses, with empty text", noText !== null && noText.text === "");

  // Payload mapping onto the existing pipeline contract
  const mapped = dm.toIncomingWebhookPayload(good, "Hey, saw your comment!");
  check("maps to platform tiktok", mapped.platform === "tiktok");
  check("maps sender id to userId", mapped.userId === "tt_user_123");
  check("maps username", mapped.username === "janeb");
  check("maps display name", mapped.displayName === "Jane B");
  check("commentOrDm is dm", mapped.commentOrDm === "dm");
  check("VA opener carried as marcoPreviousOutbound", mapped.marcoPreviousOutbound === "Hey, saw your comment!");
  check("listingRef is null (TikTok DMs carry no post context)", mapped.listingRef === null);

  // The env-var separation that keeps analytics from self-arming
  const analytics = await import("../dist/src/integrations/zernio/index.js");
  const savedDm = process.env.ZERNIO_DM_API_KEY;
  delete process.env.ZERNIO_API_KEY;
  check(
    "DM key does NOT arm the separate analytics client",
    dm.isZernioDmConfigured() === true && analytics.isZernioConfigured() === false,
  );
  process.env.ZERNIO_DM_API_KEY = savedDm;
}

// ──────────────────────────── LIVE ────────────────────────────
async function liveChecks() {
  console.log("\nLIVE — the real route on a real server");

  const server = spawn(process.execPath, ["dist/src/server.js"], {
    env: {
      ...process.env,
      PORT,
      ZERNIO_WEBHOOK_SECRET: SECRET,
      ZERNIO_DM_API_KEY: "sk_test_not_a_real_key",
      ZERNIO_TIKTOK_ACCOUNT_ID: "acct_1",
      SITE_LOGIN_ENABLED: "true", // prove the lockdown allowlist actually opens this route
      ANTHROPIC_API_KEY: "",
      DB_JSON_PATH: "/tmp/zernio-verify-db.json",
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
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) { up = true; break; }
      } catch { /* still booting */ }
    }
    check("server booted", up, up ? "" : log.slice(-600));
    if (!up) return;

    // Bad signature
    const b1 = inboundBody({ eventId: "evt_live_badsig" });
    const r1 = await fetch(`${BASE}/api/zernio/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zernio-Signature": "deadbeef" },
      body: b1,
    });
    check("bad signature → 401", r1.status === 401, `got ${r1.status}`);

    // Missing signature
    const r2 = await fetch(`${BASE}/api/zernio/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: inboundBody({ eventId: "evt_live_nosig" }),
    });
    check("missing signature → 401", r2.status === 401, `got ${r2.status}`);

    // Lockdown: the route is reachable WITHOUT a session (it is allowlisted),
    // and is not silently redirected to /login.
    check("route is not behind the site login redirect", r1.status !== 302 && r2.status !== 302);

    // Outgoing echo → 200 ignored, and must NOT be retried by Zernio
    const b3 = inboundBody({ eventId: "evt_live_echo", direction: "outgoing" });
    const r3 = await fetch(`${BASE}/api/zernio/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zernio-Signature": sign(b3) },
      body: b3,
    });
    const j3 = await r3.json();
    check("our own echo → 200 ignored (no retry storm)", r3.status === 200 && j3.ignored === true);

    // The headline property: ack inside Zernio's 5s budget.
    const b4 = inboundBody({ eventId: "evt_live_ok", conversationId: "conv_live" });
    const t0 = Date.now();
    const r4 = await fetch(`${BASE}/api/zernio/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zernio-Signature": sign(b4) },
      body: b4,
    });
    const ms = Date.now() - t0;
    check("valid inbound → 200", r4.status === 200, `got ${r4.status}`);
    check(
      `acked in ${ms}ms, inside Zernio's 5000ms budget`,
      ms < 5000,
      `took ${ms}ms — Zernio would retry and duplicate the DM`,
    );
    check(
      `acked in ${ms}ms, faster than the pipeline's own 4s debounce`,
      ms < 4000,
      "ack is waiting on the pipeline, which is the bug this design exists to avoid",
    );

    // Duplicate delivery of the same event id is dropped
    const r5 = await fetch(`${BASE}/api/zernio/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zernio-Signature": sign(b4) },
      body: b4,
    });
    const j5 = await r5.json();
    check("replayed event id → 200 duplicate, not reprocessed", r5.status === 200 && j5.duplicate === true);

    // Malformed JSON with a correct signature over those bytes
    const bad = "{not json";
    const r6 = await fetch(`${BASE}/api/zernio/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zernio-Signature": sign(bad) },
      body: bad,
    });
    check("signed-but-unparseable body → 400", r6.status === 400, `got ${r6.status}`);

    // Give the async half a moment, then confirm it ran and logged a send attempt.
    /* Longer than the pipeline's 4s debounce, or the async half has not flushed yet. */
    await sleep(7000);
    check(
      "pipeline ran AFTER the ack (async half reached the send)",
      /zernio_reply_send|zernio_inbound_failed|pipeline_end/.test(log),
      "no pipeline/send activity in server log",
    );
  } finally {
    server.kill("SIGKILL");
  }
}

await staticChecks();
await liveChecks();

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
