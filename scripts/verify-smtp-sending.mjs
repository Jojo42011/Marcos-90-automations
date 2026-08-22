#!/usr/bin/env node
/**
 * SMTP app-password sending: the protocol client, the MIME it builds, the
 * daily cap, and the send path the agents actually call.
 *
 * Nothing is mocked between the client and the wire. The suite stands up a
 * REAL SMTP server (self-signed TLS, generated here) that speaks the protocol
 * back, so every assertion is about bytes the client actually sent — the only
 * way to know the STARTTLS upgrade, AUTH LOGIN, dot-termination and header
 * construction are right without mailing a real person.
 *
 * Usage: node scripts/verify-smtp-sending.mjs
 */
import net from "node:net";
import tls from "node:tls";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const tmp = process.env.SMTP_VERIFY_CHILD && process.env.SMTP_VERIFY_CERT_DIR
  ? process.env.SMTP_VERIFY_CERT_DIR
  : mkdtempSync(join(tmpdir(), "smtp-verify-"));
// Self-signed cert for localhost so the client's TLS verification is REAL —
// the production client verifies certificates and this suite does not weaken
// that. Trusting this one cert is the only concession.
/* Generated ONLY in the parent. The child inherits the path via
   NODE_EXTRA_CA_CERTS, which Node reads at startup — regenerating here would
   serve a cert the child had already decided not to trust. */
if (!process.env.SMTP_VERIFY_CHILD) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem"),
    "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost",
  ], { stdio: "ignore" });
}
const key = readFileSync(join(tmp, "key.pem"));
const cert = readFileSync(join(tmp, "cert.pem"));

/* NODE_EXTRA_CA_CERTS is read once at startup, so it cannot be set from
   inside the process that needs it. Re-exec ourselves exactly once with the
   throwaway CA trusted, then run the suite in the child. */
if (!process.env.SMTP_VERIFY_CHILD) {
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
    stdio: "inherit",
    env: { ...process.env, SMTP_VERIFY_CHILD: "1", SMTP_VERIFY_CERT_DIR: tmp, NODE_EXTRA_CA_CERTS: join(tmp, "cert.pem") },
  });
  rmSync(tmp, { recursive: true, force: true });
  process.exit(child.status ?? 1);
}

/**
 * A fake submission server. Records every command and the DATA payload.
 * `mode` picks the port style; `rejectAuth` simulates a bad app password.
 */
function startServer({ implicitTls, rejectAuth = false } = {}) {
  const state = { commands: [], data: "", authUser: null, authPass: null };
  const handle = (sock) => {
    let buf = "";
    let inData = false;
    sock.setEncoding("utf8");
    sock.write("220 fake.smtp ESMTP ready\r\n");
    let expecting = null; // "user" | "pass"
    sock.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") { inData = false; sock.write("250 2.0.0 OK  1a2b3c4d - gsmtp\r\n"); }
          else state.data += line + "\r\n";
          continue;
        }
        state.commands.push(line);
        const upper = line.toUpperCase();
        if (expecting === "user") { state.authUser = Buffer.from(line, "base64").toString(); expecting = "pass"; sock.write("334 UGFzc3dvcmQ6\r\n"); }
        else if (expecting === "pass") {
          state.authPass = Buffer.from(line, "base64").toString(); expecting = null;
          if (rejectAuth) sock.write("535-5.7.8 Username and Password not accepted\r\n535 5.7.8 BadCredentials\r\n");
          else sock.write("235 2.7.0 Accepted\r\n");
        }
        else if (upper.startsWith("EHLO")) sock.write("250-fake.smtp\r\n250-STARTTLS\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n");
        else if (upper === "STARTTLS") {
          sock.write("220 2.0.0 Ready to start TLS\r\n");
          const secured = new tls.TLSSocket(sock, { isServer: true, key, cert });
          secured.on("secure", () => {});
          handleSecured(secured);
          return;
        }
        else if (upper === "AUTH LOGIN") { expecting = "user"; sock.write("334 VXNlcm5hbWU6\r\n"); }
        else if (upper.startsWith("MAIL FROM")) sock.write("250 2.1.0 OK\r\n");
        else if (upper.startsWith("RCPT TO")) sock.write("250 2.1.5 OK\r\n");
        else if (upper === "DATA") { inData = true; sock.write("354 Go ahead\r\n"); }
        else if (upper === "QUIT") { sock.write("221 2.0.0 closing\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => {});
  };
  // After STARTTLS the same command loop continues on the encrypted socket.
  const handleSecured = (sock, greet = false) => {
    let buf = ""; let inData = false; let expecting = null;
    sock.setEncoding("utf8");
    /* On the implicit-TLS port the greeting is the FIRST thing the server
       says; in the STARTTLS flow it was already sent before the upgrade. */
    if (greet) sock.write("220 fake.smtp ESMTP ready\r\n");
    sock.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") { inData = false; sock.write("250 2.0.0 OK  1a2b3c4d - gsmtp\r\n"); }
          else state.data += line + "\r\n";
          continue;
        }
        state.commands.push(line);
        const upper = line.toUpperCase();
        if (expecting === "user") { state.authUser = Buffer.from(line, "base64").toString(); expecting = "pass"; sock.write("334 UGFzc3dvcmQ6\r\n"); }
        else if (expecting === "pass") {
          state.authPass = Buffer.from(line, "base64").toString(); expecting = null;
          if (rejectAuth) sock.write("535-5.7.8 Username and Password not accepted\r\n535 5.7.8 BadCredentials\r\n");
          else sock.write("235 2.7.0 Accepted\r\n");
        }
        else if (upper.startsWith("EHLO")) sock.write("250-fake.smtp\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n");
        else if (upper === "AUTH LOGIN") { expecting = "user"; sock.write("334 VXNlcm5hbWU6\r\n"); }
        else if (upper.startsWith("MAIL FROM")) sock.write("250 2.1.0 OK\r\n");
        else if (upper.startsWith("RCPT TO")) sock.write("250 2.1.5 OK\r\n");
        else if (upper === "DATA") { inData = true; sock.write("354 Go ahead\r\n"); }
        else if (upper === "QUIT") { sock.write("221 2.0.0 closing\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => {});
  };

  const server = implicitTls
    ? tls.createServer({ key, cert }, (sock) => handleSecured(sock, true))
    : net.createServer(handle);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

const { smtpSend, smtpLoginCheck, buildMimeMessage } = await import("../dist/src/core/smtpClient.js");

try {
  // ---- 1. STARTTLS path (port 587 shape) ----------------------------------
  {
    const { server, state, port } = await startServer({ implicitTls: false });
    const res = await smtpSend(
      { host: "localhost", port, secure: false },
      { user: "marco@example.com", pass: "abcdefghijklmnop" },
      { from: "marco@example.com", fromName: "Marco Puga", to: ["buyer@example.com"], cc: ["tc@example.com"], bcc: ["hidden@example.com"], subject: "Test subject", body: "<p>Hello</p>", html: true },
    );
    ok("STARTTLS send resolves", res.ok);
    ok("client issued STARTTLS", state.commands.includes("STARTTLS"));
    ok("client re-issued EHLO after the upgrade", state.commands.filter((c) => c.toUpperCase().startsWith("EHLO")).length === 2, JSON.stringify(state.commands.filter((c) => /EHLO/i.test(c))));
    ok("AUTH LOGIN carried the right user", state.authUser === "marco@example.com", state.authUser);
    ok("AUTH LOGIN carried the app password", state.authPass === "abcdefghijklmnop");
    ok("MAIL FROM used the account address", state.commands.some((c) => c === "MAIL FROM:<marco@example.com>"));
    const rcpts = state.commands.filter((c) => c.startsWith("RCPT TO:"));
    ok("every recipient got a RCPT TO (to + cc + bcc)", rcpts.length === 3, JSON.stringify(rcpts));
    ok("bcc appears in RCPT TO", rcpts.some((c) => c.includes("hidden@example.com")));
    ok("bcc does NOT appear in the headers (that is what blind means)", !/hidden@example\.com/i.test(state.data), state.data.slice(0, 400));
    ok("cc DOES appear in the headers", /^Cc: tc@example\.com/m.test(state.data));
    ok("From carries the display name", /^From: Marco Puga <marco@example\.com>/m.test(state.data));
    ok("Subject header present", /^Subject: Test subject/m.test(state.data));
    ok("Message-ID and Date present", /^Message-ID: </m.test(state.data) && /^Date: /m.test(state.data));
    ok("body is base64 encoded", /Content-Transfer-Encoding: base64/.test(state.data));
    const b64body = state.data.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
    ok("body decodes back to the original html", Buffer.from(b64body, "base64").toString("utf8") === "<p>Hello</p>", b64body.slice(0, 60));
    ok("server reported acceptance and the client returned its id", /1a2b3c4d/.test(res.response));
    server.close();
  }

  // ---- 2. implicit TLS path (port 465 shape) ------------------------------
  {
    const { server, state, port } = await startServer({ implicitTls: true });
    const res = await smtpSend(
      { host: "localhost", port, secure: true },
      { user: "marco@example.com", pass: "pw" },
      { from: "marco@example.com", to: ["a@example.com"], subject: "Implicit", body: "plain", html: false },
    );
    ok("implicit-TLS send resolves", res.ok);
    ok("no STARTTLS issued on the implicit port", !state.commands.includes("STARTTLS"));
    ok("plain body declares text/plain", /Content-Type: text\/plain/.test(state.data));
    server.close();
  }

  // ---- 3. a rejected app password fails loudly ----------------------------
  {
    const { server, port } = await startServer({ implicitTls: false, rejectAuth: true });
    let threw = null;
    try {
      await smtpSend({ host: "localhost", port, secure: false }, { user: "u@example.com", pass: "bad" },
        { from: "u@example.com", to: ["a@example.com"], subject: "x", body: "y" });
    } catch (e) { threw = e; }
    ok("bad credentials throw", !!threw);
    ok("the error carries the server's own words", /535|BadCredentials/i.test(String(threw?.message)), String(threw?.message).slice(0, 120));
    ok("the password is never echoed in the error", !/\bbad\b/.test(String(threw?.message).replace(/BadCredentials/gi, "")), String(threw?.message));
    server.close();
  }

  // ---- 4. login check without sending anything ----------------------------
  {
    const { server, state, port } = await startServer({ implicitTls: false });
    await smtpLoginCheck({ host: "localhost", port, secure: false }, { user: "marco@example.com", pass: "pw" });
    ok("login check authenticates", state.authUser === "marco@example.com");
    ok("login check sends no mail", !state.commands.some((c) => c.startsWith("MAIL FROM") || c === "DATA"), JSON.stringify(state.commands));
    server.close();
  }

  // ---- 5. MIME details --------------------------------------------------
  {
    const mime = buildMimeMessage({ from: "a@b.com", to: ["c@d.com"], subject: "Café ☕ update", body: "x" });
    ok("non-ASCII subject is RFC 2047 encoded", /^Subject: =\?UTF-8\?B\?/m.test(mime), mime.split("\r\n").find((l) => l.startsWith("Subject")));
    const injected = buildMimeMessage({ from: "a@b.com", to: ["c@d.com"], subject: "Hi\r\nBcc: sneaky@evil.com", body: "x" });
    ok("header injection via subject is neutralised", !/^Bcc:/m.test(injected), injected.slice(0, 200));
    const long = buildMimeMessage({ from: "a@b.com", to: ["c@d.com"], subject: "s", body: "<p>" + "x".repeat(5000) + "</p>" });
    ok("no encoded line exceeds SMTP's 998-octet limit", long.split("\r\n").every((l) => l.length <= 998));
  }

  // ---- 6. the daily cap actually refuses ----------------------------------
  {
    const { server, port } = await startServer({ implicitTls: false });
    const tmpDb = mkdtempSync(join(tmpdir(), "smtp-cap-"));
    process.env.DB_JSON_PATH = join(tmpDb, "db.json");
    process.env.EMAIL_DB_PATH = join(tmpDb, "email.db");
    process.env.GMAIL_SMTP_USER = "marco@example.com";
    process.env.GMAIL_SMTP_APP_PASSWORD = "abcd efgh ijkl mnop"; // spaced, as Google shows it
    process.env.GMAIL_SMTP_HOST = "localhost";
    process.env.GMAIL_SMTP_PORT = String(port);
    process.env.GMAIL_SMTP_DAILY_CAP = "2";
    const smtp = await import("../dist/src/integrations/smtp/index.js");
    ok("config reads the env", smtp.isSmtpConfigured());
    ok("spaces are stripped from the app password", smtp.getSmtpConfig().pass === "abcdefghijklmnop");
    await smtp.sendViaSmtp({ to: "one@example.com", subject: "1", body: "b" });
    await smtp.sendViaSmtp({ to: "two@example.com", subject: "2", body: "b" });
    ok("counter tracked both sends", smtp.smtpSentToday() === 2, String(smtp.smtpSentToday()));
    let capErr = null;
    try { await smtp.sendViaSmtp({ to: "three@example.com", subject: "3", body: "b" }); } catch (e) { capErr = e; }
    ok("third send refused at the cap", !!capErr);
    ok("cap error explains the 24h suspension risk", /24h|suspend/i.test(String(capErr?.message)), String(capErr?.message).slice(0, 140));
    await smtp.sendViaSmtp({ to: "test@example.com", subject: "t", body: "b", bypassCap: true });
    ok("an explicit test send bypasses the cap", true);
    const st = smtp.getSmtpStatus();
    ok("status reports usage", st.configured && st.sentToday >= 2 && st.dailyCap === 2, JSON.stringify(st));
    server.close();
    rmSync(tmpDb, { recursive: true, force: true });
  }
  // ---- 7. end to end: the Auto Plan engine really delivers ----------------
  {
    const { server, state, port } = await startServer({ implicitTls: false });
    const tmpRun = mkdtempSync(join(tmpdir(), "smtp-e2e-"));
    const iso = (ms) => new Date(ms).toISOString();
    const nowMs = Date.now();
    const plan = {
      id: "plan_mail", name: "Email test plan", tag: "", planType: "people", active: true,
      autoPauseOnReply: false, autoPauseOnStatus: null, completionStatus: null, archived: false,
      createdAt: iso(nowMs - 86400000), updatedAt: iso(nowMs - 86400000),
      steps: [{ id: "s1", type: "email", dayOffset: 0, subject: "Hi {{recipient_first_name}}", content: "<p>Welcome, {{recipient_first_name}}.</p>", cc: ["tc@example.com"] }],
    };
    writeFileSync(join(tmpRun, "auto-plans.json"), JSON.stringify([plan]));
    const lead = {
      id: "lead_e2e", platform: "tiktok", userId: "ue2e", username: "u", name: "Dana Reyes",
      phone: "2105550199", email: "dana@example.com", state: "new", source: "TikTok",
      adCampaign: null, propertyInquired: null, criteria: null, brivityId: null,
      crmStatus: "new", crmStage: "new", crmPriority: "normal", crmIntent: "buyer",
      crmCallQueue: "none", crmNotes: null, tags: [],
      autoPlanEnrollments: [{ planId: "plan_mail", planName: "Email test plan", enrolledAt: iso(nowMs - 3600000), currentStepIndex: 0, completedSteps: [], status: "active" }],
      createdAt: iso(nowMs - 86400000), updatedAt: iso(nowMs - 86400000),
    };
    writeFileSync(join(tmpRun, "db.json"), JSON.stringify({
      idCounter: 5, leadsById: { lead_e2e: lead }, leadKeyToId: { "tiktok::ue2e": "lead_e2e" },
      conversationsByLeadId: { lead_e2e: { messages: [] } }, commandTasks: [],
    }));

    const { spawn } = await import("node:child_process");
    const PORT = 3399;
    const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env, PORT: String(PORT),
    /* The site lock defaults to ON as of 2026-08-22. These suites exercise the
       app, not the door, so it is switched off explicitly here rather than
       every fixture growing a login step. scripts/verify-site-lock.mjs is the
       one that tests the lock, and deliberately sets nothing. */
    SITE_LOGIN_ENABLED: "0",
        DB_JSON_PATH: join(tmpRun, "db.json"), TASKS_JSON_PATH: join(tmpRun, "tasks.json"),
        AUTO_PLANS_JSON_PATH: join(tmpRun, "auto-plans.json"),
        AUTO_PLAN_TRIGGERS_JSON_PATH: join(tmpRun, "triggers.json"),
        EMAIL_DB_PATH: join(tmpRun, "email.db"),
        TRANSACTIONS_DB_PATH: join(tmpRun, "tx.db"),
        GMAIL_SMTP_USER: "marco@example.com",
        GMAIL_SMTP_APP_PASSWORD: "abcdefghijklmnop",
        GMAIL_SMTP_HOST: "localhost",
        GMAIL_SMTP_PORT: String(port),
        GMAIL_SMTP_DAILY_CAP: "50",
        GMAIL_FROM_NAME: "Marco Puga",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let srvLog = ""; srv.stdout.on("data", (d) => (srvLog += d)); srv.stderr.on("data", (d) => (srvLog += d));
    const base = `http://localhost:${PORT}`;
    const until = async (fn, ms = 25000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 300)); } };
    const up = await until(async () => (await fetch(base + "/health")).ok);
    ok("server booted with SMTP configured", up, srvLog.slice(-300));

    if (up) {
      const status = await (await fetch(base + "/api/email/connection-status")).json();
      ok("connection-status reports the smtp transport", status.transport === "smtp", JSON.stringify(status).slice(0, 200));
      ok("connection-status verified against a real login", status.verified === true, JSON.stringify(status).slice(0, 200));
      ok("status exposes the daily budget", status.smtp && status.smtp.dailyCap === 50);

      await fetch(base + "/api/auto-plans/execute-due-steps", { method: "POST" });
      await new Promise((r) => setTimeout(r, 800));

      ok("the engine actually delivered a message", /Subject: Hi Dana/.test(state.data), state.data.slice(0, 300));
      ok("merge field resolved in the delivered body",
        /Welcome, Dana\./.test(Buffer.from(state.data.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim(), "base64").toString("utf8")),
        state.data.slice(-200));
      ok("From used the configured display name", /^From: Marco Puga <marco@example\.com>/m.test(state.data));
      ok("the step's CC went out", state.commands.some((c) => c.includes("tc@example.com")));

      const snap = await (await fetch(base + "/api/dashboard/data")).json();
      const acts = (snap.leads.find((l) => l.id === "lead_e2e") || {}).activity || [];
      ok("activity records it as SENT, not pending", acts.some((a) => a.type === "email_sent"), JSON.stringify(acts.map((a) => a.type)));
      ok("no pending-email entry was written", !acts.some((a) => a.type === "email_pending"));

      const testRes = await (await fetch(base + "/api/email/smtp-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "marco@example.com" }) })).json();
      ok("the operator test-send endpoint works", testRes.ok === true && testRes.stage === "sent", JSON.stringify(testRes).slice(0, 200));
    }
    srv.kill();
    server.close();
    rmSync(tmpRun, { recursive: true, force: true });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:\n - " + fail.join("\n - ")); process.exit(1); }
