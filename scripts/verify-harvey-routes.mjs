#!/usr/bin/env node
/**
 * verify-harvey-routes.mjs — the Harvey model layer over real HTTP.
 *
 * The unit suites prove the routing table, the cron parser and the approval
 * gate in isolation. This one boots `dist/src/server.js` — the actual server,
 * not a harness — and asks it the questions the browser will ask, because the
 * failures that matter here only exist at the seam:
 *
 *   · a route that was never registered answers 404, and the page quietly drops
 *     to the legacy chat endpoint instead of saying the deploy is broken;
 *   · a route registered WITHOUT the token check is a hole in a system holding
 *     real client data, so every one of them is asked anonymously first;
 *   · a schedule form that guesses at "sometime soon" writes a cron that fires
 *     forever, so the refusals are asserted, not the happy path;
 *   · an SSE endpoint that answers `application/json` streams nothing, and the
 *     chat renders one silent block at the end rather than a live answer.
 *
 * NO PROVIDER KEY IS SET. `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY` are
 * deleted from the child's environment on purpose: the server must be honest
 * about having no way to reach a model rather than 500 with a stack, and that
 * is the state a machine is in the moment a secret is rotated badly. No network
 * call is made and no key is ever read, logged or printed by this file.
 *
 * Two servers are booted, because two different truths need proving:
 *   1. LOCKED (the default): every route refuses an anonymous caller.
 *   2. UNLOCKED (SITE_LOGIN_ENABLED=0): `/harvey` actually serves the page.
 *      A page route answers a signed-out browser with a redirect to /login, so
 *      the only way to see what it serves is with the lock deliberately off.
 *
 * Run:  node scripts/verify-harvey-routes.mjs
 * Expects a built dist/ (npm run build).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const TOKEN = "verify-harvey-routes-token";
const tmp = mkdtempSync(path.join(tmpdir(), "harvey-routes-"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    failures.push(name + (detail ? " — " + detail : ""));
    console.log("  FAIL " + name + (detail ? " — " + detail : ""));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseEnv(port, extra = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    DASHBOARD_TOKEN: TOKEN,
    /* Every store this suite touches goes to a throwaway directory. Pointing a
       verification run at /data would put test spend in the real ledger. */
    AI_USAGE_DB_PATH: path.join(tmp, "ai-usage.db"),
    HARVEY_TASKS_DB_PATH: path.join(tmp, "harvey-tasks.db"),
    DB_JSON_PATH: path.join(tmp, "db.json"),
    /* The cost floor the schedule validator enforces, pinned so the refusal
       message this suite asserts on does not depend on the deploy's setting. */
    HARVEY_CRON_MIN_INTERVAL_MINUTES: "15",
    /* The ticker would start running tasks mid-suite. The routes are what is
       under test here; the ticker has its own suite. */
    HARVEY_CRON_ENABLED: "false",
    ...extra,
  };
  if (!extra.OPENROUTER_API_KEY) delete env.OPENROUTER_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  /* Memory retrieval reaches OpenAI for embeddings when this is set. It falls
     back to keyword scoring without it, which is what this suite wants: no
     outbound call of any kind. */
  delete env.OPENAI_API_KEY;
  /* Belt and braces around the approval test, which approves a real tool call:
     with these blank, `gmail_send` and the SMS path cannot reach anybody even
     if a stray credential is sitting in the environment. */
  for (const k of [
    "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN",
    "GMAIL_SMTP_USER", "GMAIL_SMTP_APP_PASSWORD", "TWILIO_AUTH_TOKEN", "QUO_API_KEY",
  ]) env[k] = "";
  return env;
}

/**
 * A local stand-in for OpenRouter.
 *
 * The approval gate can only be exercised end-to-end if a model actually asks
 * for a tool, so one is faked here rather than skipped: round one returns a
 * `delete_file` call, round two (once a tool result is in the messages) returns
 * a sentence. Speaks the same OpenAI-shaped wire format, streamed or not, so
 * what is under test is the real provider client.
 *
 * It listens on loopback and its "key" is a local string. No request leaves
 * this machine and nothing here is a credential.
 */
function startStubProvider(port, state) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* handled below as a round-one request */
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      state.requests++;
      const answered = messages.some((m) => m.role === "tool");
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const target = /spared/.test(JSON.stringify(lastUser?.content || "")) ? "spared.txt" : "doomed.txt";
      const usage = { prompt_tokens: 1200, completion_tokens: 40, cost: 0.0021 };

      if (!body.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "stub/model",
            choices: [
              answered
                ? { index: 0, message: { role: "assistant", content: "Done — it is waiting on you." }, finish_reason: "stop" }
                : {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: [
                        { id: "call_1", type: "function", function: { name: "delete_file", arguments: JSON.stringify({ path: target }) } },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
            ],
            usage,
          }),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      frame({ model: "stub/model", choices: [{ index: 0, delta: { role: "assistant" } }] });
      if (answered) {
        for (const piece of ["That file is ", "waiting on your approval."]) {
          frame({ choices: [{ index: 0, delta: { content: piece } }] });
        }
        frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else {
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "delete_file", arguments: JSON.stringify({ path: target }) } },
                ],
              },
            },
          ],
        });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      }
      frame({ model: "stub/model", usage, choices: [] });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function boot(port, extra) {
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    env: baseEnv(port, extra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, log: () => log };
    } catch {
      /* still booting */
    }
  }
  child.kill("SIGKILL");
  throw new Error(`server did not boot on ${port}:\n${log.slice(-2000)}`);
}

const json = async (res) => {
  const text = await res.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { __raw: text };
  }
};

if (!existsSync(path.join(process.cwd(), "dist/src/server.js"))) {
  console.error("dist/src/server.js is missing — run `npm run build` first.");
  process.exit(1);
}

const PORT = 4300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const auth = (p) => `${BASE}${p}${p.includes("?") ? "&" : "?"}token=${TOKEN}`;
const anon = (p) => `${BASE}${p}`;

let locked = null;
let unlocked = null;
let stubbed = null;
let stub = null;
try {
  console.log("\nBOOT — the real server, no provider key");
  locked = await boot(PORT);
  ok("dist/src/server.js booted", true);

  /* ── 1. every route exists and is behind the token ────────────────── */
  console.log("\nAUTH — a new route is protected by default, or it is a hole");
  const guarded = [
    ["GET", "/api/harvey/models"],
    ["POST", "/api/harvey/models/route"],
    ["DELETE", "/api/harvey/models/route/chat_deep"],
    ["POST", "/api/harvey/chat"],
    ["GET", "/api/harvey/usage?days=30"],
    ["POST", "/api/harvey/usage/caps"],
    ["GET", "/api/harvey/approvals"],
    ["POST", "/api/harvey/approvals/nope/approve"],
    ["POST", "/api/harvey/approvals/nope/deny"],
    ["GET", "/api/harvey/tasks"],
    ["GET", "/api/harvey/tasks/preview?when=every%20day%20at%207am"],
    ["POST", "/api/harvey/tasks"],
    ["PATCH", "/api/harvey/tasks/nope"],
    ["DELETE", "/api/harvey/tasks/nope"],
    ["POST", "/api/harvey/tasks/nope/run"],
    ["GET", "/api/harvey/tasks/nope/runs"],
  ];
  for (const [method, route] of guarded) {
    const res = await fetch(anon(route), {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    ok(`${method} ${route} refuses an anonymous caller`, res.status === 401, `HTTP ${res.status}`);
  }
  {
    const res = await fetch(anon("/harvey"), { redirect: "manual" });
    ok(
      "GET /harvey sends a signed-out browser to the login page",
      res.status === 302 && String(res.headers.get("location") || "").startsWith("/login"),
      `HTTP ${res.status} → ${res.headers.get("location")}`,
    );
  }

  /* ── 2. the catalog, and honesty about having no key ──────────────── */
  console.log("\nMODELS — a catalog, a routing table, and what has been spent");
  let res = await fetch(auth("/api/harvey/models"));
  let body = await json(res);
  ok("GET /api/harvey/models answers", res.ok, `HTTP ${res.status}`);
  ok("it returns a catalog", Array.isArray(body?.models) && body.models.length > 0);
  ok(
    "every model carries an id and a price",
    (body?.models || []).every((m) => m.id && typeof m.inputPerM === "number" && typeof m.outputPerM === "number"),
  );
  ok("it returns a routing table keyed by job", !!body?.routing?.chat_deep?.model);
  ok(
    "with no key configured, provider.primary is null",
    body?.provider?.primary === null,
    JSON.stringify(body?.provider),
  );
  ok("and neither provider claims to be configured", body?.provider?.openrouter === false && body?.provider?.anthropic === false);
  ok(
    "no response field looks like a key",
    !/sk-|sk_live|api[_-]?key/i.test(JSON.stringify(body)),
    "a credential must never reach the browser",
  );
  ok(
    "it carries the budget block the pill reads",
    typeof body?.budget?.spentTodayUsd === "number" &&
      typeof body?.budget?.dailyCapUsd === "number" &&
      typeof body?.budget?.monthlyCapUsd === "number" &&
      ["ok", "near", "over"].includes(body?.budget?.state),
    JSON.stringify(body?.budget),
  );

  /* ── 3. routing overrides round-trip ──────────────────────────────── */
  console.log("\nROUTING — an operator's pick is stored, shown, and reversible");
  const defaultChatDeep = body.routing.chat_deep.model;
  const other = (body.models || []).map((m) => m.id).find((id) => id !== defaultChatDeep);
  res = await fetch(auth("/api/harvey/models/route"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job: "chat_deep", model: other }),
  });
  body = await json(res);
  ok("POST /models/route sets an override", res.ok && body?.ok === true, `HTTP ${res.status}`);
  ok("and the returned routing table shows it", body?.routing?.chat_deep?.model === other, body?.routing?.chat_deep?.model);
  ok("recorded as an override, not as Harvey's own choice", body?.routing?.chat_deep?.source === "override");

  res = await fetch(auth("/api/harvey/models"));
  body = await json(res);
  ok("the override survives a second read", body?.routing?.chat_deep?.model === other);

  res = await fetch(auth("/api/harvey/models/route"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job: "not_a_job", model: other }),
  });
  body = await json(res);
  ok("an unknown job is refused with 400", res.status === 400, `HTTP ${res.status}`);
  ok("and the message lists the jobs that exist", /chat_deep/.test(body?.error || ""), body?.error);

  res = await fetch(auth("/api/harvey/models/route"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job: "chat_deep", model: "acme/does-not-exist" }),
  });
  body = await json(res);
  ok("a model outside the catalog is refused with 400", res.status === 400, `HTTP ${res.status}`);
  ok("and says where to find the real list", /\/api\/harvey\/models/.test(body?.error || ""), body?.error);

  res = await fetch(auth("/api/harvey/models/route/chat_deep"), { method: "DELETE" });
  body = await json(res);
  ok("DELETE /models/route/:job clears the override", res.ok && body?.ok === true, `HTTP ${res.status}`);
  ok("and routing falls back to the built-in default", body?.routing?.chat_deep?.model === defaultChatDeep);
  res = await fetch(auth("/api/harvey/models/route/not_a_job"), { method: "DELETE" });
  ok("clearing an unknown job is a 400, not a silent no-op", res.status === 400, `HTTP ${res.status}`);

  /* ── 4. usage and caps ────────────────────────────────────────────── */
  console.log("\nUSAGE — measured spend, and the caps that stop it");
  res = await fetch(auth("/api/harvey/usage?days=30"));
  body = await json(res);
  ok("GET /api/harvey/usage answers", res.ok, `HTTP ${res.status}`);
  ok(
    "with today, month, per-model, per-job, daily and recent errors",
    typeof body?.today?.costUsd === "number" &&
      typeof body?.month?.costUsd === "number" &&
      Array.isArray(body?.byModel) &&
      Array.isArray(body?.byJob) &&
      Array.isArray(body?.daily) &&
      Array.isArray(body?.recentErrors),
  );
  ok("and the caps the page draws its meters against", typeof body?.caps?.dailyCapUsd === "number");

  res = await fetch(auth("/api/harvey/usage/caps"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dailyCapUsd: 4.25, monthlyCapUsd: 90 }),
  });
  body = await json(res);
  ok("POST /usage/caps saves both caps", res.ok && body?.caps?.dailyCapUsd === 4.25 && body?.caps?.monthlyCapUsd === 90, `HTTP ${res.status}`);
  res = await fetch(auth("/api/harvey/usage?days=7"));
  body = await json(res);
  ok("and they are read back on the next request", body?.caps?.dailyCapUsd === 4.25);
  res = await fetch(auth("/api/harvey/models"));
  body = await json(res);
  ok("the models endpoint reports the same cap", body?.budget?.dailyCapUsd === 4.25);

  for (const bad of [{ dailyCapUsd: 0 }, { dailyCapUsd: -3 }, { monthlyCapUsd: "lots" }, {}]) {
    res = await fetch(auth("/api/harvey/usage/caps"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bad),
    });
    ok(`an invalid cap ${JSON.stringify(bad)} is refused with 400`, res.status === 400, `HTTP ${res.status}`);
  }
  res = await fetch(auth("/api/harvey/usage?days=7"));
  body = await json(res);
  ok("a refused cap did not overwrite the good one", body?.caps?.dailyCapUsd === 4.25);

  /* ── 5. scheduled tasks ───────────────────────────────────────────── */
  console.log("\nTASKS — a sentence becomes a cron, or it is refused");
  res = await fetch(auth("/api/harvey/tasks"));
  body = await json(res);
  ok("GET /api/harvey/tasks answers with a list", res.ok && Array.isArray(body?.tasks), `HTTP ${res.status}`);

  res = await fetch(auth("/api/harvey/tasks/preview?when=every%20weekday%20at%207am"));
  body = await json(res);
  ok("GET /tasks/preview reads a sentence back before anything is saved", res.ok && body?.ok === true, `HTTP ${res.status}`);
  ok("with the cron it would store", body?.cron === "0 7 * * 1-5", body?.cron);
  ok("a label an operator can confirm", /Weekdays/.test(body?.label || ""), body?.label);
  ok("and the next time it would fire", !!body?.nextRun && new Date(body.nextRun).getTime() > Date.now());

  res = await fetch(auth("/api/harvey/tasks"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Morning pipeline report",
      prompt: "Summarise new leads and what needs a call today.",
      when: "every weekday at 7am",
    }),
  });
  body = await json(res);
  const task = body?.task;
  ok("POST /tasks accepts plain English", res.status === 201 && !!task?.id, `HTTP ${res.status}`);
  ok("and stores a real cron for it", task?.cron === "0 7 * * 1-5", task?.cron);
  ok("with a human label beside it", /Weekdays/.test(task?.scheduleLabel || ""), task?.scheduleLabel);
  ok("it computes a next run", !!task?.nextRunAt && new Date(task.nextRunAt).getTime() > Date.now());
  ok("it defaults to the business timezone", task?.timezone === "America/Chicago", task?.timezone);
  ok("and starts enabled, delivering to chat", task?.enabled === true && task?.deliver === "chat");

  res = await fetch(auth("/api/harvey/tasks"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Vague", prompt: "do the thing", when: "sometime when you get a chance" }),
  });
  body = await json(res);
  ok("a schedule nobody could read is refused with 400", res.status === 400, `HTTP ${res.status}`);
  ok("the refusal quotes what was asked and why it is a question, not a guess", /sometime when you get a chance/.test(body?.error || ""), body?.error);
  ok("and it comes with examples the operator can copy", Array.isArray(body?.examples) && body.examples.length > 0, JSON.stringify(body?.examples));

  res = await fetch(auth("/api/harvey/tasks"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Every minute", prompt: "burn money", cron: "* * * * *" }),
  });
  body = await json(res);
  ok("`* * * * *` is refused by the cost floor", res.status === 400, `HTTP ${res.status}`);
  ok("and the refusal names the floor rather than just saying no", /floor is 15/.test(body?.error || ""), body?.error);

  res = await fetch(auth("/api/harvey/tasks"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "", prompt: "", when: "every day at 6pm" }),
  });
  ok("a task with no title or prompt is a 400, not a 500", res.status === 400, `HTTP ${res.status}`);

  res = await fetch(auth(`/api/harvey/tasks/${task.id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  body = await json(res);
  ok("PATCH pauses a task", res.ok && body?.task?.enabled === false, `HTTP ${res.status}`);
  ok("and a paused task has no next run, so it cannot fire while paused", body?.task?.nextRunAt === null);

  res = await fetch(auth(`/api/harvey/tasks/${task.id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, when: "every day at 6pm" }),
  });
  body = await json(res);
  ok("PATCH resumes it and takes a new schedule in plain English", res.ok && body?.task?.enabled === true && body?.task?.cron === "0 18 * * *", body?.task?.cron);
  ok("and recomputes the next run", new Date(body?.task?.nextRunAt).getTime() > Date.now());

  res = await fetch(auth(`/api/harvey/tasks/${task.id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cron: "*/5 * * * *" }),
  });
  ok("a reschedule below the floor is refused too", res.status === 400, `HTTP ${res.status}`);

  res = await fetch(auth("/api/harvey/tasks/does-not-exist"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  ok("patching a task that does not exist is a 404", res.status === 404, `HTTP ${res.status}`);

  res = await fetch(auth(`/api/harvey/tasks/${task.id}/runs`));
  body = await json(res);
  ok("GET /tasks/:id/runs answers before anything has run", res.ok && Array.isArray(body?.runs) && body.runs.length === 0, `HTTP ${res.status}`);

  res = await fetch(auth(`/api/harvey/tasks/${task.id}/run`), { method: "POST" });
  body = await json(res);
  ok("POST /tasks/:id/run answers rather than crashing with no key", res.ok, `HTTP ${res.status}`);
  ok("and hands back the run id it recorded", !!body?.runId, JSON.stringify(body));

  res = await fetch(auth(`/api/harvey/tasks/${task.id}/runs`));
  body = await json(res);
  const lastRun = (body?.runs || [])[0];
  ok("the run is in the history, finished", !!lastRun && !!lastRun.finishedAt, JSON.stringify(lastRun));
  ok("it is recorded as a manual run, not a schedule firing", lastRun?.trigger === "manual");
  /* A run that produced nothing must be recorded as a FAILURE, not as a success
     whose deliverable is an apology — otherwise a task on a keyless server reads
     healthy in this list forever and never trips the auto-pause. */
  ok("and the record is a failure, not a success carrying an apology", lastRun?.ok === false, JSON.stringify(lastRun));
  ok(
    "with the missing key named as the reason",
    /OPENROUTER_API_KEY|ANTHROPIC_API_KEY|No model provider/.test(String(lastRun?.error || "")),
    JSON.stringify(lastRun),
  );

  res = await fetch(auth("/api/harvey/tasks/does-not-exist/run"), { method: "POST" });
  ok("running a task that does not exist is a 404, never a 500", res.status === 404, `HTTP ${res.status}`);
  res = await fetch(auth("/api/harvey/tasks/does-not-exist/runs"));
  ok("and so is asking for its history", res.status === 404, `HTTP ${res.status}`);

  res = await fetch(auth(`/api/harvey/tasks/${task.id}`), { method: "DELETE" });
  body = await json(res);
  ok("DELETE removes the task", res.ok && body?.ok === true, `HTTP ${res.status}`);
  res = await fetch(auth("/api/harvey/tasks"));
  body = await json(res);
  ok("and it is gone from the list", !(body?.tasks || []).some((t) => t.id === task.id));
  res = await fetch(auth(`/api/harvey/tasks/${task.id}`), { method: "DELETE" });
  ok("deleting it twice is a 404, not a 500", res.status === 404, `HTTP ${res.status}`);

  /* ── 6. approvals ─────────────────────────────────────────────────── */
  console.log("\nAPPROVALS — nothing fires without a click, and never twice");
  res = await fetch(auth("/api/harvey/approvals"));
  body = await json(res);
  ok("GET /api/harvey/approvals answers with a pending list", res.ok && Array.isArray(body?.pending), `HTTP ${res.status}`);

  for (const decision of ["approve", "deny"]) {
    res = await fetch(auth(`/api/harvey/approvals/00000000-0000-4000-8000-000000000000/${decision}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    body = await json(res);
    ok(`a fabricated id cannot be ${decision}d — 404, never 500`, res.status === 404, `HTTP ${res.status}`);
    ok(`and the ${decision} refusal explains itself`, /expired|not in the queue/i.test(body?.error || ""), body?.error);
  }

  /* ── 7. chat with no provider key ─────────────────────────────────── */
  console.log("\nCHAT — honest when there is no key, and a real stream when asked");
  res = await fetch(auth("/api/harvey/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "what needs my attention today?", sessionId: "verify-session-1" }),
  });
  body = await json(res);
  ok("POST /api/harvey/chat answers 200 with no key configured", res.status === 200, `HTTP ${res.status}`);
  ok(
    "and says plainly that no provider is configured",
    /no model provider is configured/i.test(body?.text || ""),
    body?.text,
  );
  ok("the reply is a sentence, not a stack trace", !/ {4}at |Error:/.test(body?.text || ""), body?.text);
  ok("it names the keys that would fix it", /OPENROUTER_API_KEY/.test(body?.text || "") && /ANTHROPIC_API_KEY/.test(body?.text || ""));
  ok("it returns the session id the page has to keep", body?.sessionId === "verify-session-1", body?.sessionId);
  ok("with the usage block the message footer reads", body?.usage && typeof body.usage.costUsd === "number");
  ok("and an approvals array, even when empty", Array.isArray(body?.approvals));
  ok("an empty message is a 400, not a turn", (await fetch(auth("/api/harvey/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  })).status === 400);

  res = await fetch(auth("/api/harvey/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message: "stream me something", sessionId: "verify-session-2", stream: true }),
  });
  const ctype = String(res.headers.get("content-type") || "");
  ok("stream:true answers as an event stream", /text\/event-stream/.test(ctype), ctype);
  ok("with caching turned off, or a proxy will hold the whole answer", /no-cache/.test(String(res.headers.get("cache-control") || "")));
  const sse = await res.text();
  const events = [...sse.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  ok("at least one named event arrives", events.length > 0, JSON.stringify(sse.slice(0, 200)));
  ok("the frames are named SSE events, not bare data", /^event: /m.test(sse) && /^data: /m.test(sse));
  ok("every event name is one the page handles", events.every((e) => ["token", "tool", "approval", "usage", "done", "error"].includes(e)), events.join(","));
  ok("the stream ends with `done` or `error`, never mid-sentence", ["done", "error"].includes(events[events.length - 1]), events.join(","));
  {
    const done = /event: done\ndata: (.+)/.exec(sse);
    const payload = done ? JSON.parse(done[1]) : null;
    ok("the done frame carries the session id back", payload?.sessionId === "verify-session-2", JSON.stringify(payload));
    ok("and the text, so a page that missed a token still renders the answer", typeof payload?.text === "string" && payload.text.length > 0);
    ok("which is the same honest sentence about the missing key", /no model provider is configured/i.test(payload?.text || ""));
  }
  ok("no key material appears anywhere in the stream", !/sk-[A-Za-z0-9]/.test(sse));

  locked.child.kill("SIGTERM");
  locked = null;

  /* ── 8. the page itself ───────────────────────────────────────────── */
  console.log("\nPAGE — /harvey serves the chat surface");
  const PORT2 = PORT + 1;
  unlocked = await boot(PORT2, { SITE_LOGIN_ENABLED: "0" });
  res = await fetch(`http://127.0.0.1:${PORT2}/harvey?token=${TOKEN}`);
  const html = await res.text();
  ok("GET /harvey serves a page", res.ok, `HTTP ${res.status}`);
  ok("it is public/harvey.html and not some other screen", /id="modelPill"/.test(html) && /harvey-chat\.js/.test(html));
  const shell = await (await fetch(`http://127.0.0.1:${PORT2}/shell?token=${TOKEN}`)).text();
  ok("the shell offers it as a tab", /key: "harvey-chat"/.test(shell) && /src: "\/harvey"/.test(shell));
  ok(
    "the tab sits in the Harvey group, above CRM",
    shell.indexOf('key: "harvey"') < shell.indexOf('key: "harvey-chat"') &&
      shell.indexOf('key: "harvey-chat"') < shell.indexOf('key: "crm"'),
  );
  /* The old clean-chat surface is gone rather than left beside this one: two
     chat pages would disagree about which model ran and what it cost, because
     only one of them reports either. */
  ok("the retired hull-chat tab is gone from the shell", !/key: "chat"/.test(shell) && !/hull-chat/.test(shell));
  ok("and its page is deleted", !existsSync(path.join(process.cwd(), "public/hull-chat.html")));
  ok("so the old route 404s", (await fetch(`http://127.0.0.1:${PORT2}/hull-chat?token=${TOKEN}`)).status === 404);
  unlocked.child.kill("SIGTERM");
  unlocked = null;

  /* ── 9. a real turn, with a model that asks to delete a file ──────── */
  console.log("\nTOOLS & APPROVALS — a held call, and the click that runs it");
  const workspace = path.join(tmp, "workspace");
  mkdirSync(workspace, { recursive: true });
  const doomed = path.join(workspace, "doomed.txt");
  const spared = path.join(workspace, "spared.txt");
  writeFileSync(doomed, "this file is the proof that approving executes");
  writeFileSync(spared, "this file is the proof that denying does not");

  const STUB_PORT = PORT + 2;
  const PORT3 = PORT + 3;
  const stubState = { requests: 0 };
  stub = await startStubProvider(STUB_PORT, stubState);
  stubbed = await boot(PORT3, {
    /* Local loopback, not a credential: the "provider" is the stub above. */
    OPENROUTER_API_KEY: "stub-local-loopback-only",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    HARVEY_WORKSPACE_PATH: workspace,
  });
  const chat = (payload, headers = {}) =>
    fetch(`http://127.0.0.1:${PORT3}/api/harvey/chat?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  const api3 = (p) => `http://127.0.0.1:${PORT3}${p}${p.includes("?") ? "&" : "?"}token=${TOKEN}`;

  res = await chat(
    { message: "tidy the workspace up for me", sessionId: "verify-session-3", stream: true },
    { Accept: "text/event-stream" },
  );
  const stream = await res.text();
  const frames = [...stream.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map((m) => ({ name: m[1], data: JSON.parse(m[2]) }));
  const named = (n) => frames.filter((f) => f.name === n);
  ok("a turn that calls a tool still streams as an event stream", /text\/event-stream/.test(String(res.headers.get("content-type"))));
  ok("the model's answer arrives as token events", named("token").length > 0 && named("token").some((f) => typeof f.data.text === "string"));
  ok("spend arrives as usage events", named("usage").length > 0 && named("usage").some((f) => f.data.costUsd > 0));
  ok("the last usage frame carries the whole turn and its context plan", (() => {
    const last = named("usage").pop();
    return last && typeof last.data.costUsd === "number" && last.data.contextPlan !== undefined;
  })());
  ok("the turn ends with done", frames[frames.length - 1]?.name === "done");

  const approvalFrame = named("approval")[0];
  ok("a tool that deletes something is held for approval, streamed as an approval event", !!approvalFrame, JSON.stringify(frames.map((f) => f.name)));
  ok("the card gets an id, the tool, a human summary and a risk level",
    !!approvalFrame?.data?.id && approvalFrame?.data?.tool === "delete_file" &&
      /doomed\.txt/.test(approvalFrame?.data?.summary || "") && approvalFrame?.data?.risk === "high",
    JSON.stringify(approvalFrame?.data));
  ok("and the file is STILL THERE — the gate stopped the call, it did not run it", existsSync(doomed));

  res = await fetch(api3("/api/harvey/approvals"));
  body = await json(res);
  const pending = (body?.pending || []).find((a) => a.id === approvalFrame.data.id);
  ok("it is waiting in GET /api/harvey/approvals", !!pending, JSON.stringify(body?.pending));
  ok("with the arguments it would run with", pending?.args?.path === "doomed.txt", JSON.stringify(pending?.args));
  ok("and the reason it was held", /cannot be undone/i.test(pending?.reason || ""), pending?.reason);

  res = await fetch(api3(`/api/harvey/approvals/${approvalFrame.data.id}/approve`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  body = await json(res);
  ok("approving answers ok with the tool's own result", res.ok && body?.ok === true, `HTTP ${res.status} ${JSON.stringify(body)}`);
  ok("the result is what the tool returned, not a fabricated acknowledgement", body?.result?.deleted === "doomed.txt", JSON.stringify(body?.result));
  ok("and the file is GONE — approving actually executed the held call", !existsSync(doomed));

  res = await fetch(api3(`/api/harvey/approvals/${approvalFrame.data.id}/approve`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  body = await json(res);
  ok("the same approval cannot be run twice — 409, no replay", res.status === 409, `HTTP ${res.status}`);
  ok("and it says it was already approved", /already approved/i.test(body?.error || ""), body?.error);

  res = await chat({ message: "get rid of the spared note", sessionId: "verify-session-4", stream: true }, { Accept: "text/event-stream" });
  const denyStream = await res.text();
  const denyId = (() => {
    const m = /^event: approval\ndata: (.*)$/m.exec(denyStream);
    return m ? JSON.parse(m[1]).id : null;
  })();
  ok("a second turn is held the same way", !!denyId);
  res = await fetch(api3(`/api/harvey/approvals/${denyId}/deny`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "I still want that file" }),
  });
  body = await json(res);
  ok("denying answers ok", res.ok && body?.ok === true, `HTTP ${res.status}`);
  ok("and the file survives — a denial runs nothing", existsSync(spared));
  res = await fetch(api3("/api/harvey/approvals"));
  body = await json(res);
  ok("a decided approval leaves the pending list", !(body?.pending || []).some((a) => a.id === denyId));
  res = await fetch(api3(`/api/harvey/approvals/${denyId}/approve`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  ok("and it cannot be approved after the fact", res.status === 409, `HTTP ${res.status}`);

  res = await chat({ message: "one more pass on the spared note", sessionId: "verify-session-5" });
  body = await json(res);
  ok("the non-stream shape answers with the model's text", res.ok && typeof body?.text === "string" && body.text.length > 0, `HTTP ${res.status}`);
  ok("it reports the model that actually ran and what the turn cost", body?.usage?.model === "stub/model" && body?.usage?.costUsd > 0, JSON.stringify(body?.usage));
  ok("it carries the context plan the page shows on hover", !!body?.contextPlan && typeof body.contextPlan.budgetTokens === "number", JSON.stringify(body?.contextPlan));
  ok("and the approvals it held, so a non-streaming client still sees the card", (body?.approvals || [])[0]?.tool === "delete_file");

  res = await fetch(api3("/api/harvey/usage?days=1"));
  body = await json(res);
  ok("every one of those calls landed in the spend ledger", body?.today?.calls > 0 && body?.today?.costUsd > 0, JSON.stringify(body?.today));
  ok("attributed to the model that actually ran", (body?.byModel || []).some((m) => m.model === "stub/model"), JSON.stringify(body?.byModel));
  ok("and to the job the chat route asked for", (body?.byJob || []).some((j) => j.job === "chat_deep"), JSON.stringify(body?.byJob));
  res = await fetch(api3("/api/harvey/models"));
  body = await json(res);
  ok("the budget block now shows today's measured spend", body?.budget?.spentTodayUsd > 0, JSON.stringify(body?.budget));
  ok("with a key configured, the provider reports itself as primary", body?.provider?.primary === "openrouter" && body?.provider?.openrouter === true);
  ok("and still returns no key material", !/stub-local-loopback-only/.test(JSON.stringify(body)));
} catch (err) {
  failures.push(`suite crashed: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  locked?.child.kill("SIGKILL");
  unlocked?.child.kill("SIGKILL");
  stubbed?.child.kill("SIGKILL");
  stub?.close();
  rmSync(tmp, { recursive: true, force: true });
}

const total = pass + failures.length;
console.log(`\n${pass}/${total} checks passed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  · " + f));
  process.exit(1);
}
