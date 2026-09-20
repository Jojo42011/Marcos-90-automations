#!/usr/bin/env node
/**
 * Harvey's model layer, exercised for real.
 *
 * WHAT THIS IS TRYING TO CATCH. This layer decides which model runs, how much
 * history it sees, and whether the call is made at all — three things that are
 * invisible when they go wrong. A router that quietly picks the premium model,
 * a context planner that drops the question instead of the history, a spend cap
 * that reads zero because the rollup was never written: none of those throw,
 * they just cost money or answer badly. So the checks below assert on the
 * VALUES, not on "it returned something".
 *
 * WHAT IS REAL HERE AND WHAT IS STUBBED. The compiled modules under `dist/` are
 * the ones under test — same code that ships. SQLite is real, on a temp file.
 * The only thing replaced is `fetch`, because the point of the streaming and
 * fallback checks is to control exactly what an upstream sends back: frames
 * split mid-line, a usage-only final chunk, a 500 on the first model. No
 * network call is made and no key is needed.
 *
 * Persistence is tested across SEPARATE node processes, the same way
 * `verify-brivity-mirror.mjs` does it, because a module-level singleton can
 * fake "it survived" inside one process.
 *
 * Usage: node scripts/verify-harvey-model-layer.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "harvey-models-"));
let pass = 0;
const fail = [];
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log("  ok " + name);
  } else {
    fail.push(name + (detail ? " — " + detail : ""));
    console.error("FAIL " + name + (detail ? " — " + detail : ""));
  }
};

const dist = (rel) => pathToFileURL(join(process.cwd(), "dist/src", rel)).href;
const MOD = {
  translate: dist("hull/providers/translate.js"),
  openrouter: dist("hull/providers/openrouter.js"),
  context: dist("hull/providers/contextBudget.js"),
  routing: dist("hull/providers/routing.js"),
  budget: dist("hull/providers/budget.js"),
  index: dist("hull/providers/index.js"),
  promptCache: dist("hull/providers/promptCache.js"),
  catalog: dist("hull/providers/catalog.js"),
  store: dist("core/aiUsageStore.js"),
};

/** Run a snippet in a fresh process with a controlled environment. */
function run(script, env = {}) {
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        /* Every child starts from a known routing world; individual checks
           override what they care about. */
        OPENROUTER_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        HARVEY_DAILY_CAP_USD: "10",
        HARVEY_MONTHLY_CAP_USD: "150",
        HARVEY_MAX_COST_PER_CALL_USD: "0.50",
        HARVEY_MODEL_CHAT_FAST: "",
        HARVEY_MODEL_CHAT_DEEP: "",
        HARVEY_MODEL_CLASSIFY: "",
        HARVEY_PRE_ROT_RATIO: "",
        HARVEY_CONTEXT_CEILING_TOKENS: "",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.trim().split("\n").pop());
  } catch (err) {
    console.error(String(err.stderr || err.message).slice(0, 2000));
    throw err;
  }
}

/** A fetch stub that serves canned responses and records what was sent. */
const FETCH_STUB = `
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body, headers: init.headers || {} });
    return handler(calls.length - 1, body, String(url));
  };
  return calls;
}
function sse(text, pieceSize) {
  const encoder = new TextEncoder();
  const pieces = [];
  for (let i = 0; i < text.length; i += pieceSize) pieces.push(text.slice(i, i + pieceSize));
  const stream = new ReadableStream({
    start(c) { for (const p of pieces) c.enqueue(encoder.encode(p)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
`;

const FAKE_KEY = "sk-or-v1-abcdef0123456789abcdef0123456789";

/* ══════════════════════ 1. translation ══════════════════════ */

const conversation = [
  { role: "user", content: "what is 3705 Canyon worth" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Pulling the comps." },
      { type: "tool_use", id: "toolu_1", name: "mls_search", input: { postal: "78023", beds: 4 } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "3 active, median 615000" },
      { type: "text", text: "and here is the flyer" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAA" } },
    ],
  },
];

const t = run(`
  const T = await import(${JSON.stringify(MOD.translate)});
  const messages = ${JSON.stringify(conversation)};
  const openai = T.toOpenAiMessages(messages, "SYSTEM RULES: ask before sending.");
  const tools = T.toOpenAiTools([{ name: "mls_search", description: "search", input_schema: { type: "object", properties: { postal: { type: "string" } } } }]);
  const back = T.fromOpenAiMessages(openai);
  const malformed = T.toolUsesFromOpenAi([
    { id: "call_bad", type: "function", function: { name: "x", arguments: "{\\"unterminated" } },
    { id: "call_ok", type: "function", function: { name: "y", arguments: "{\\"a\\":1}" } },
  ]);
  console.log(JSON.stringify({ openai, tools, back, malformed }));
`);

ok("system prompt becomes the first OpenAI message", t.openai[0].role === "system" && /ask before sending/.test(t.openai[0].content), JSON.stringify(t.openai[0]).slice(0, 120));
ok("a string user turn stays a plain string", t.openai[1].role === "user" && t.openai[1].content === "what is 3705 Canyon worth");
ok("assistant tool_use becomes an OpenAI tool_call", t.openai[2].tool_calls?.[0]?.function?.name === "mls_search" && t.openai[2].tool_calls[0].id === "toolu_1", JSON.stringify(t.openai[2]));
ok("tool_call arguments are serialised JSON, not an object", typeof t.openai[2].tool_calls[0].function.arguments === "string" && JSON.parse(t.openai[2].tool_calls[0].function.arguments).postal === "78023");
ok("tool_result becomes its own role:tool message with a tool_call_id", t.openai[3].role === "tool" && t.openai[3].tool_call_id === "toolu_1" && /median 615000/.test(t.openai[3].content), JSON.stringify(t.openai[3]));
const imagePart = (t.openai[4]?.content || []).find((p) => p.type === "image_url");
ok("a base64 image becomes an image_url data URL", imagePart?.image_url?.url === "data:image/png;base64,iVBORw0KGgoAAAA", JSON.stringify(imagePart));
ok("tool definitions translate to OpenAI function tools", t.tools[0].type === "function" && t.tools[0].function.name === "mls_search" && t.tools[0].function.parameters.type === "object");

const roundTripToolUse = (t.back.messages[1]?.content || []).find((b) => b.type === "tool_use");
const roundTripResult = (t.back.messages[2]?.content || []).find((b) => b.type === "tool_result");
const roundTripImage = (t.back.messages[2]?.content || []).find((b) => b.type === "image");
ok("round trip keeps the system prompt", /ask before sending/.test(t.back.system));
ok("round trip keeps the tool_use id, name and parsed input", roundTripToolUse?.id === "toolu_1" && roundTripToolUse.name === "mls_search" && roundTripToolUse.input.beds === 4, JSON.stringify(roundTripToolUse));
ok("round trip regroups tool results back onto the user turn", roundTripResult?.tool_use_id === "toolu_1" && /median 615000/.test(roundTripResult.content), JSON.stringify(roundTripResult));
ok("round trip restores the image as base64, byte for byte", roundTripImage?.source?.data === "iVBORw0KGgoAAAA" && roundTripImage.source.media_type === "image/png", JSON.stringify(roundTripImage));
ok("malformed tool arguments do not throw and are kept verbatim", t.malformed[0].input._raw === '{"unterminated' && t.malformed[1].input.a === 1, JSON.stringify(t.malformed));

/* ══════════════════════ 2. streaming ══════════════════════ */

const streamFrames = [
  ": OPENROUTER PROCESSING",
  'data: {"id":"gen-1","model":"google/gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"Hello"}}]}',
  ": keep-alive",
  'data: {"id":"gen-1","model":"google/gemini-3.8-flash","choices":[{"index":0,"delta":{"content":" Marco"}}]}',
  "data: {this frame is not json",
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_lead","arguments":"{\\"id\\":"}}]}}]}',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"lead_7\\"}"}}]}}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  'data: {"id":"gen-1","model":"anthropic/claude-haiku-4.5","choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":85,"cost":0.0031,"prompt_tokens_details":{"cached_tokens":400}}}',
  "data: [DONE]",
].join("\n\n") + "\n\n";

const stream = run(`
  ${FETCH_STUB}
  const OR = await import(${JSON.stringify(MOD.openrouter)});
  const calls = installFetch(() => sse(${JSON.stringify(streamFrames)}, 7));
  const tokens = [];
  const res = await OR.callOpenRouter({
    model: "google/gemini-3.8-flash",
    fallbacks: ["openai/gpt-5.1-mini", "anthropic/claude-haiku-4.5"],
    system: "be brief",
    messages: [{ role: "user", content: "who is lead 7" }],
    tools: [{ name: "get_lead", input_schema: { type: "object", properties: { id: { type: "string" } } } }],
    maxTokens: 512,
    maxCostUsd: 0.25,
    onToken: (t) => tokens.push(t),
  });
  console.log(JSON.stringify({ res, tokens, sent: calls[0].body, url: calls[0].url, auth: String(calls[0].headers.Authorization || "") }));
`, { OPENROUTER_API_KEY: FAKE_KEY });

ok("SSE text survives chunks split mid-line", stream.res.text === "Hello Marco", JSON.stringify(stream.res.text));
ok("tokens stream out in order as they arrive", JSON.stringify(stream.tokens) === JSON.stringify(["Hello", " Marco"]), JSON.stringify(stream.tokens));
ok("a malformed frame costs one frame, not the turn", stream.res.text === "Hello Marco");
ok("tool_calls accumulate across chunks into one parsed call", stream.res.toolUses.length === 1 && stream.res.toolUses[0].name === "get_lead" && stream.res.toolUses[0].input.id === "lead_7", JSON.stringify(stream.res.toolUses));
ok("usage is read from the FINAL chunk", stream.res.promptTokens === 1200 && stream.res.completionTokens === 85, JSON.stringify(stream.res).slice(0, 200));
ok("cost from the provider is authoritative, not estimated", stream.res.costUsd === 0.0031 && stream.res.costEstimated === false);
ok("cached tokens are read when reported", stream.res.cachedTokens === 400);
ok("finish_reason is carried through", stream.res.stopReason === "tool_calls");
ok("modelUsed reflects the model that actually ran (a fallback fired)", stream.res.modelUsed === "anthropic/claude-haiku-4.5", stream.res.modelUsed);
ok("the model fallback array is sent to OpenRouter", JSON.stringify(stream.sent.models) === JSON.stringify(["google/gemini-3.8-flash", "openai/gpt-5.1-mini", "anthropic/claude-haiku-4.5"]), JSON.stringify(stream.sent.models));
ok("a cost ceiling forces price-first provider routing", stream.sent.provider?.sort === "price" && typeof stream.sent.provider?.max_price?.prompt === "number", JSON.stringify(stream.sent.provider));
ok("streaming asks for usage accounting in the final chunk", stream.sent.stream === true && stream.sent.stream_options?.include_usage === true && stream.sent.usage?.include === true, JSON.stringify(stream.sent.stream_options));
ok("the request goes to the chat-completions endpoint", /\/chat\/completions$/.test(stream.url), stream.url);
ok("the key is sent as a bearer token", stream.auth === "Bearer " + FAKE_KEY);

/* ── non-streaming, and the error path ── */

const plain = run(`
  ${FETCH_STUB}
  const OR = await import(${JSON.stringify(MOD.openrouter)});
  const calls = installFetch(() => json({
    id: "gen-2", model: "google/gemini-3.8-flash",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "615,000." } }],
    usage: { prompt_tokens: 900, completion_tokens: 12, cost: 0.00042 },
  }));
  const res = await OR.callOpenRouter({ model: "google/gemini-3.8-flash", messages: [{ role: "user", content: "hi" }], maxTokens: 256 });

  let err = null;
  installFetch(() => json({ error: { message: "Insufficient credits for key ${FAKE_KEY}", code: 402 } }, 402));
  try {
    await OR.callOpenRouter({ model: "google/gemini-3.8-flash", messages: [{ role: "user", content: "hi" }], maxTokens: 256 });
  } catch (e) {
    err = { name: e.name, code: e.code, status: e.status, message: e.message, body: e.body, summary: e.summary };
  }
  console.log(JSON.stringify({ res, err, sent: calls[0].body }));
`, { OPENROUTER_API_KEY: FAKE_KEY });

ok("a non-streaming answer comes back with its text", plain.res.text === "615,000." && plain.res.stopReason === "stop");
ok("its cost is the provider's number", plain.res.costUsd === 0.00042 && plain.res.costEstimated === false, JSON.stringify(plain.res));
ok("with no fallbacks, no model array is sent", plain.sent.models === undefined && plain.sent.stream === false, JSON.stringify(plain.sent).slice(0, 160));
ok("without a cost ceiling nothing forces price-first routing", plain.sent.provider === undefined, JSON.stringify(plain.sent.provider));
ok("an HTTP error becomes a typed ModelLayerError with the status", plain.err?.name === "ModelLayerError" && plain.err.code === "http_error" && plain.err.status === 402, JSON.stringify(plain.err));
ok("the provider's own error text is kept, truncated", /Insufficient credits/.test(plain.err?.body || ""), String(plain.err?.body).slice(0, 120));
ok("NO API KEY survives into the error anywhere", !JSON.stringify(plain.err).includes(FAKE_KEY) && /redacted/.test(plain.err.body), JSON.stringify(plain.err).slice(0, 200));

/* ══════════════════════ 3. context planning ══════════════════════ */

const TURNS = 40;
/* Built inside the child: 40 turns of real-sized history is ~350 KB, which is
   past the argv limit if it is embedded in the snippet. */
const BUILD_HISTORY = `
  const messages = [];
  for (let i = 0; i < ${TURNS}; i++) {
    messages.push({ role: "user", content: "turn " + i + " question " + "x".repeat(7000) });
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_" + i, name: "crm_api", input: { path: "/leads" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_" + i, content: "RESULT " + i + " " + "y".repeat(6000) }] });
    messages.push({ role: "assistant", content: "answer " + i });
  }
  messages.push({ role: "user", content: "FINAL QUESTION: what is the median?" });
`;

const ctx = run(`
  const C = await import(${JSON.stringify(MOD.context)});
  ${BUILD_HISTORY}
  const inputLength = messages.length;
  const a = C.planContext({ job: "chat_deep", model: "anthropic/claude-sonnet-4.6", system: "SYSTEM", messages, maxTokens: 2048 });
  const b = C.planContext({ job: "chat_deep", model: "anthropic/claude-sonnet-4.6", system: "SYSTEM", messages, maxTokens: 2048 });
  const withBigSystem = C.planContext({ job: "chat_deep", model: "anthropic/claude-sonnet-4.6", system: "S".repeat(120000), messages, maxTokens: 2048 });
  const classify = C.planContext({ job: "classify", model: "google/gemini-3.8-flash", messages, maxTokens: 256 });
  const single = C.planContext({ job: "chat_deep", model: "anthropic/claude-sonnet-4.6", messages: [{ role: "user", content: "z".repeat(900000) }], maxTokens: 2048 });
  const raw = a.messages.filter((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"))
    .map((m) => m.content.find((b) => b.type === "tool_result").content);
  console.log(JSON.stringify({
    plan: a.plan,
    same: JSON.stringify(a.plan) === JSON.stringify(b.plan) && JSON.stringify(a.messages) === JSON.stringify(b.messages),
    first: JSON.stringify(a.messages[0]).slice(0, 200),
    last: a.messages[a.messages.length - 1],
    kept: a.messages.length,
    inputUnchanged: messages.length === inputLength && messages[0].content.startsWith("turn 0 question"),
    rawTail: raw.slice(-3).map((s) => String(s).slice(0, 12)),
    rawHead: raw.slice(0, 1).map((s) => String(s).slice(0, 40)),
    bigSystemKept: withBigSystem.messages.length,
    bigSystemDropped: withBigSystem.plan.droppedTurns,
    classifyBudget: classify.plan.budgetTokens,
    deepBudget: a.plan.budgetTokens,
    singleKept: single.messages.length,
  }));
`);

ok("the plan trims oldest turns to fit the budget", ctx.plan.droppedTurns > 0 && ctx.plan.estimatedTokens <= ctx.plan.budgetTokens, JSON.stringify(ctx.plan));
ok("the last user message is always kept verbatim", ctx.last.content === "FINAL QUESTION: what is the median?", JSON.stringify(ctx.last).slice(0, 120));
ok("old tool results are compacted to a pointer", ctx.plan.compactedToolResults > 0 && /compacted/.test(ctx.rawHead[0] || ""), ctx.rawHead[0]);
ok("the most recent tool results stay raw", ctx.rawTail.every((s) => s.startsWith("RESULT")), JSON.stringify(ctx.rawTail));
ok("a note is injected when turns were dropped", ctx.plan.summaryInjected && /Context note/.test(ctx.first), ctx.first.slice(0, 100));
ok("planning is deterministic — same input, same plan", ctx.same === true);
ok("planning does not mutate the caller's messages", ctx.inputUnchanged === true);
ok("a huge system prompt costs history, never itself", ctx.bigSystemDropped > ctx.plan.droppedTurns && ctx.bigSystemKept < ctx.kept, JSON.stringify({ big: ctx.bigSystemDropped, normal: ctx.plan.droppedTurns }));
ok("a classify job gets a far smaller budget than deep chat", ctx.classifyBudget < ctx.deepBudget && ctx.classifyBudget <= 4000, JSON.stringify({ classify: ctx.classifyBudget, deep: ctx.deepBudget }));
ok("an oversized single question is still sent rather than deleted", ctx.singleKept === 1, String(ctx.singleKept));

/* ══════════════════════ 4. usage store ══════════════════════ */

const usageDb = join(tmp, "usage.db");
const written = run(`
  const S = await import(${JSON.stringify(MOD.store)});
  S.recordUsage({ provider: "openrouter", model: "google/gemini-3.8-flash", job: "classify", promptTokens: 1000, completionTokens: 50, cachedTokens: 0, costUsd: 0.25, costEstimated: false, latencyMs: 400, ok: true, sessionId: "sess_a" });
  S.recordUsage({ provider: "openrouter", model: "anthropic/claude-sonnet-4.6", job: "chat_deep", promptTokens: 5000, completionTokens: 900, cachedTokens: 120, costUsd: 1.5, costEstimated: false, latencyMs: 2200, ok: true, sessionId: "sess_a" });
  S.recordUsage({ provider: "anthropic", model: "anthropic/claude-sonnet-4.6", job: "chat_deep", promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, costEstimated: true, latencyMs: 90, ok: false, error: "HTTP 529 overloaded", sessionId: "sess_b" });
  console.log(JSON.stringify({ today: S.spentToday(), month: S.spentThisMonth() }));
`, { AI_USAGE_DB_PATH: usageDb });

ok("spend is summed as it is recorded", Math.abs(written.today - 1.75) < 1e-9, String(written.today));
ok("the monthly figure includes today", Math.abs(written.month - 1.75) < 1e-9, String(written.month));

const reread = run(`
  const S = await import(${JSON.stringify(MOD.store)});
  const sum = S.usageSummary(30);
  console.log(JSON.stringify({
    today: S.spentToday(),
    month: S.spentThisMonth(),
    session: S.sessionCostUsd("sess_a"),
    calls: sum.today.calls,
    errors: sum.today.errors,
    byModel: sum.byModel.map((m) => [m.model, Number(m.costUsd.toFixed(4))]),
    byJob: sum.byJob.map((j) => j.job).sort(),
    dailyPoints: sum.daily.length,
    recent: S.recentErrors(5),
  }));
`, { AI_USAGE_DB_PATH: usageDb });

ok("A DIFFERENT PROCESS reads the same spend back — this is the restart", Math.abs(reread.today - 1.75) < 1e-9, String(reread.today));
ok("the rollup counts every attempt, successes and failures", reread.calls === 3 && reread.errors === 1, JSON.stringify({ calls: reread.calls, errors: reread.errors }));
ok("spend breaks down by model", JSON.stringify(reread.byModel) === JSON.stringify([["anthropic/claude-sonnet-4.6", 1.5], ["google/gemini-3.8-flash", 0.25]]), JSON.stringify(reread.byModel));
ok("spend breaks down by job", JSON.stringify(reread.byJob) === JSON.stringify(["chat_deep", "classify"]), JSON.stringify(reread.byJob));
ok("per-session cost is available for cron run accounting", Math.abs(reread.session - 1.75) < 1e-9, String(reread.session));
ok("a failed call is recorded with its error text", reread.recent.length === 1 && /529/.test(reread.recent[0].error), JSON.stringify(reread.recent));
ok("the daily series has a point for today", reread.dailyPoints >= 1, String(reread.dailyPoints));

/* ── caps and overrides persist; the breaker parks a failing model ── */

const breakerDb = join(tmp, "breaker.db");
const breaker = run(`
  const S = await import(${JSON.stringify(MOD.store)});
  const before = S.isModelPaused("openai/gpt-5.1");
  S.noteFailure("openai/gpt-5.1", "500");
  const afterOne = S.isModelPaused("openai/gpt-5.1");
  S.noteFailure("openai/gpt-5.1", "500");
  S.noteFailure("openai/gpt-5.1", "500");
  const afterThree = S.isModelPaused("openai/gpt-5.1");
  const otherModel = S.isModelPaused("google/gemini-3.8-flash");
  S.noteSuccess("openai/gpt-5.1");
  const afterRecovery = S.isModelPaused("openai/gpt-5.1");
  S.setCaps({ dailyCapUsd: 42 });
  S.setModelOverride("chat_deep", "claude-sonnet-4-6");
  console.log(JSON.stringify({ before, afterOne, afterThree, otherModel, afterRecovery, caps: S.getCaps(), states: S.breakerStates().length }));
`, { AI_USAGE_DB_PATH: breakerDb });

ok("a healthy model is not paused", breaker.before === false);
ok("one failure does not park a model", breaker.afterOne === false);
ok("three consecutive failures do", breaker.afterThree === true);
ok("the breaker is per model, not global", breaker.otherModel === false);
ok("a success clears the breaker", breaker.afterRecovery === false);
ok("a raised cap is stored, not just held in memory", breaker.caps.dailyCapUsd === 42, JSON.stringify(breaker.caps));

const persisted = run(`
  const S = await import(${JSON.stringify(MOD.store)});
  console.log(JSON.stringify({ caps: S.getCaps(), override: S.getModelOverride("chat_deep"), all: S.allModelOverrides() }));
`, { AI_USAGE_DB_PATH: breakerDb, HARVEY_DAILY_CAP_USD: "10" });

ok("the stored cap beats the environment default after a restart", persisted.caps.dailyCapUsd === 42, JSON.stringify(persisted.caps));
ok("a per-job model override survives a restart", persisted.override === "claude-sonnet-4-6", String(persisted.override));

/* ══════════════════════ 5. budget verdicts ══════════════════════ */

const overCapDb = join(tmp, "overcap.db");
const overCap = run(`
  const S = await import(${JSON.stringify(MOD.store)});
  const B = await import(${JSON.stringify(MOD.budget)});
  S.recordUsage({ provider: "openrouter", model: "google/gemini-3.8-flash", job: "chat_deep", promptTokens: 10, completionTokens: 10, cachedTokens: 0, costUsd: 11.2, costEstimated: false, latencyMs: 10, ok: true });
  console.log(JSON.stringify(B.checkBudget({ job: "chat_deep", model: "google/gemini-3.8-flash", estimatedInputTokens: 1000, maxTokens: 512 })));
`, { AI_USAGE_DB_PATH: overCapDb, OPENROUTER_API_KEY: FAKE_KEY });

ok("over the daily cap the call is refused", overCap.allowed === false, JSON.stringify(overCap));
ok("the refusal reads like something an operator can act on", /Daily AI cap reached/.test(overCap.reason) && /\$11\.20/.test(overCap.reason), overCap.reason);
ok("the verdict reports both the spend and the cap", overCap.spentTodayUsd > 11 && overCap.dailyCapUsd === 10, JSON.stringify(overCap));

const nearCapDb = join(tmp, "nearcap.db");
const nearCap = run(`
  const S = await import(${JSON.stringify(MOD.store)});
  const B = await import(${JSON.stringify(MOD.budget)});
  S.recordUsage({ provider: "openrouter", model: "google/gemini-3.8-flash", job: "chat_deep", promptTokens: 10, completionTokens: 10, cachedTokens: 0, costUsd: 8.5, costEstimated: false, latencyMs: 10, ok: true });
  console.log(JSON.stringify({
    classify: B.checkBudget({ job: "classify", model: "google/gemini-3.8-flash", estimatedInputTokens: 2000, maxTokens: 256 }),
    agent: B.checkBudget({ job: "agent", model: "google/gemini-3.8-flash", estimatedInputTokens: 2000, maxTokens: 256 }),
    huge: B.checkBudget({ job: "chat_deep", model: "openai/gpt-5.1-pro", estimatedInputTokens: 200000, maxTokens: 8000 }),
    tight: B.checkBudget({ job: "chat_deep", model: "anthropic/claude-sonnet-4.6", estimatedInputTokens: 30000, maxTokens: 4000, maxCostUsd: 0.01 }),
  }));
`, { AI_USAGE_DB_PATH: nearCapDb, OPENROUTER_API_KEY: FAKE_KEY });

ok("near the cap a cheap-eligible job degrades instead of failing", nearCap.classify.allowed === true && nearCap.classify.degradeToCheap === true, JSON.stringify(nearCap.classify));
ok("an unattended agent run is never silently downgraded", nearCap.agent.allowed === true && !nearCap.agent.degradeToCheap, JSON.stringify(nearCap.agent));
ok("a single call over the per-call ceiling is refused with the number", nearCap.tight.allowed === false && /\$|ceiling|cap/.test(nearCap.tight.reason || ""), JSON.stringify(nearCap.tight));
ok("a caller's own tighter ceiling is honoured", nearCap.tight.allowed === false && /\$0\.01/.test(nearCap.tight.reason), nearCap.tight.reason);

/* ══════════════════════ 6. routing ══════════════════════ */

const routeOpenRouter = run(`
  const R = await import(${JSON.stringify(MOD.routing)});
  const C = await import(${JSON.stringify(dist("hull/providers/catalog.js"))});
  console.log(JSON.stringify({
    classify: R.resolveModel("classify"),
    chatFast: R.resolveModel("chat_fast"),
    chatDeep: R.resolveModel("chat_deep"),
    agent: R.resolveModel("agent"),
    vision: R.resolveModel("vision"),
    explicit: R.resolveModel("classify", { modelOverride: "anthropic/claude-opus-5" }),
    legacy: R.resolveModel("chat_deep", { modelOverride: "claude-sonnet-4-6" }),
    forceCheap: R.resolveModel("chat_deep", { forceCheap: true }),
    social: R.classifyChatTurn("hey harvey"),
    work: R.classifyChatTurn("pull the lead list for Boerne"),
    tiers: Object.fromEntries(C.getCatalog().map((m) => [m.id, m.tier])),
  }));
`, { AI_USAGE_DB_PATH: join(tmp, "routing.db"), OPENROUTER_API_KEY: FAKE_KEY });

const tierOf = (id) => routeOpenRouter.tiers[id];
ok("cheap jobs resolve to a cheap model", tierOf(routeOpenRouter.classify.model) === "cheap" && tierOf(routeOpenRouter.chatFast.model) === "cheap", JSON.stringify([routeOpenRouter.classify.model, routeOpenRouter.chatFast.model]));
ok("chat with tools and agent runs resolve to mid, not premium", tierOf(routeOpenRouter.chatDeep.model) === "mid" && tierOf(routeOpenRouter.agent.model) === "mid", JSON.stringify([routeOpenRouter.chatDeep.model, routeOpenRouter.agent.model]));
ok("premium is never a default", !Object.values(routeOpenRouter).some((r) => r?.model && r.source === "default" && tierOf(r.model) === "premium"));
ok("vision resolves to a vision-capable cheap model", tierOf(routeOpenRouter.vision.model) === "cheap" && routeOpenRouter.vision.job === "vision");
ok("an explicit pick wins and is marked explicit", routeOpenRouter.explicit.model === "anthropic/claude-opus-5" && routeOpenRouter.explicit.source === "explicit", JSON.stringify(routeOpenRouter.explicit));
ok("a legacy bare Anthropic id still resolves", routeOpenRouter.legacy.model === "anthropic/claude-sonnet-4.6", routeOpenRouter.legacy.model);
ok("forcing cheap downgrades the deep-chat model", tierOf(routeOpenRouter.forceCheap.model) === "cheap" && routeOpenRouter.forceCheap.source === "fallback", JSON.stringify(routeOpenRouter.forceCheap));
ok("every resolution carries a fallback chain", routeOpenRouter.chatDeep.fallbacks.length > 0 && !routeOpenRouter.chatDeep.fallbacks.includes(routeOpenRouter.chatDeep.model), JSON.stringify(routeOpenRouter.chatDeep.fallbacks));
ok("the social/work split reuses the existing keyword heuristics", routeOpenRouter.social === "chat_fast" && routeOpenRouter.work === "chat_deep", JSON.stringify([routeOpenRouter.social, routeOpenRouter.work]));

const routeAnthropicOnly = run(`
  const R = await import(${JSON.stringify(MOD.routing)});
  const I = await import(${JSON.stringify(MOD.index)});
  console.log(JSON.stringify({
    classify: R.resolveModel("classify"),
    chatDeep: R.resolveModel("chat_deep"),
    explicitUnreachable: R.resolveModel("classify", { modelOverride: "google/gemini-3.8-flash" }),
    status: I.providerStatus(),
  }));
`, { AI_USAGE_DB_PATH: join(tmp, "routing-anthropic.db"), ANTHROPIC_API_KEY: "sk-ant-test-0123456789" });

ok("with only an Anthropic key, every primary is an Anthropic model", routeAnthropicOnly.classify.model.startsWith("anthropic/") && routeAnthropicOnly.chatDeep.model.startsWith("anthropic/"), JSON.stringify([routeAnthropicOnly.classify.model, routeAnthropicOnly.chatDeep.model]));
ok("and the provider is the direct SDK, not OpenRouter", routeAnthropicOnly.classify.provider === "anthropic" && routeAnthropicOnly.status.primary === "anthropic", JSON.stringify(routeAnthropicOnly.status));
ok("an unreachable explicit pick degrades rather than 404ing a turn", routeAnthropicOnly.explicitUnreachable.model.startsWith("anthropic/") && routeAnthropicOnly.explicitUnreachable.source === "fallback", JSON.stringify(routeAnthropicOnly.explicitUnreachable));
ok("no fallback in the chain is unreachable either", routeAnthropicOnly.chatDeep.fallbacks.every((m) => m.startsWith("anthropic/")), JSON.stringify(routeAnthropicOnly.chatDeep.fallbacks));

/* ══════════════════════ 7. the whole pipeline ══════════════════════ */

const pipelineDb = join(tmp, "pipeline.db");
const pipeline = run(`
  ${FETCH_STUB}
  const I = await import(${JSON.stringify(MOD.index)});
  const S = await import(${JSON.stringify(MOD.store)});
  /* First model 500s, the next one answers: the loop must fall forward. */
  const calls = installFetch((n, body) =>
    n === 0
      ? json({ error: { message: "upstream provider is down" } }, 500)
      : json({
          id: "gen-3", model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Median is 615k." } }],
          usage: { prompt_tokens: 800, completion_tokens: 20, cost: 0.0009 },
        }));
  const out = await I.complete({
    job: "chat_deep",
    system: "SYSTEM",
    messages: [{ role: "user", content: "median price in Boerne" }],
    sessionId: "sess_pipeline",
  });
  console.log(JSON.stringify({
    text: out.text,
    modelUsed: out.modelUsed,
    firstModel: calls[0].body.model,
    firstFallbacks: calls[0].body.models,
    secondModel: calls[1].body.model,
    attempts: calls.length,
    usage: out.usage,
    contextPlan: out.contextPlan,
    resolved: out.resolved,
    spend: S.spentToday(),
    summary: S.usageSummary(1).today,
    errors: S.recentErrors(5).map((e) => e.error),
    sessionCost: S.sessionCostUsd("sess_pipeline"),
  }));
`, { AI_USAGE_DB_PATH: pipelineDb, OPENROUTER_API_KEY: FAKE_KEY });

ok("complete() returns the model's answer", pipeline.text === "Median is 615k.", pipeline.text);
ok("a failing primary falls forward to the next model", pipeline.attempts === 2 && pipeline.secondModel !== pipeline.firstModel, JSON.stringify([pipeline.firstModel, pipeline.secondModel]));
ok("the remaining chain is handed to OpenRouter as its own fallbacks", Array.isArray(pipeline.firstFallbacks) && pipeline.firstFallbacks[0] === pipeline.firstModel && pipeline.firstFallbacks.length > 1, JSON.stringify(pipeline.firstFallbacks));
ok("the failed attempt is recorded, not swallowed", pipeline.errors.length === 1 && /HTTP 500/.test(pipeline.errors[0]) && /down/.test(pipeline.errors[0]), JSON.stringify(pipeline.errors));
ok("both attempts are in the rollup", pipeline.summary.calls === 2 && pipeline.summary.errors === 1, JSON.stringify(pipeline.summary));
ok("the successful call's real cost is recorded", Math.abs(pipeline.spend - 0.0009) < 1e-9 && pipeline.usage.costEstimated === false, String(pipeline.spend));
ok("usage is attributed to the session", Math.abs(pipeline.sessionCost - 0.0009) < 1e-9, String(pipeline.sessionCost));
ok("the context plan travels back with the answer", typeof pipeline.contextPlan.budgetTokens === "number" && pipeline.contextPlan.budgetTokens > 0, JSON.stringify(pipeline.contextPlan));
ok("the resolution says where the model choice came from", pipeline.resolved.source === "default" && pipeline.resolved.job === "chat_deep", JSON.stringify(pipeline.resolved));

const refused = run(`
  ${FETCH_STUB}
  const I = await import(${JSON.stringify(MOD.index)});
  const S = await import(${JSON.stringify(MOD.store)});
  S.recordUsage({ provider: "openrouter", model: "google/gemini-3.8-flash", job: "chat_deep", promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 12, costEstimated: false, latencyMs: 1, ok: true });
  const calls = installFetch(() => json({ choices: [] }));
  let err = null;
  try {
    await I.complete({ job: "chat_deep", messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    err = { name: e.name, code: e.code, reason: e.verdict?.reason, allowed: e.verdict?.allowed };
  }
  console.log(JSON.stringify({ err, networkCalls: calls.length, rows: S.usageSummary(1).today.calls }));
`, { AI_USAGE_DB_PATH: join(tmp, "refused.db"), OPENROUTER_API_KEY: FAKE_KEY });

ok("over the cap, complete() refuses with a typed budget error", refused.err?.name === "BudgetRefusedError" && refused.err.code === "budget" && /cap reached/i.test(refused.err.reason), JSON.stringify(refused.err));
ok("and makes NO network call — the only way not to spend is not to ask", refused.networkCalls === 0, String(refused.networkCalls));
ok("the refusal itself is recorded, so silence has an explanation", refused.rows === 2, String(refused.rows));

const noKeys = run(`
  const I = await import(${JSON.stringify(MOD.index)});
  let err = null;
  try {
    await I.complete({ job: "classify", messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    err = { name: e.name, code: e.code, message: e.message };
  }
  console.log(JSON.stringify({ err, status: I.providerStatus(), models: I.listModelsForUi().models.filter((m) => m.available).length }));
`, { AI_USAGE_DB_PATH: join(tmp, "nokeys.db") });

ok("with no keys at all the failure is clean and typed", noKeys.err?.name === "ModelLayerError" && /No API key|failed/.test(noKeys.err.message), JSON.stringify(noKeys.err));
ok("provider status reports no primary when nothing is configured", noKeys.status.primary === null && noKeys.status.openrouter === false, JSON.stringify(noKeys.status));
ok("and the picker marks every model unavailable rather than hiding them", noKeys.models === 0, String(noKeys.models));

const uiModels = run(`
  const I = await import(${JSON.stringify(MOD.index)});
  const ui = I.listModelsForUi();
  console.log(JSON.stringify({
    count: ui.models.length,
    families: [...new Set(ui.models.map((m) => m.family))].sort(),
    tiers: [...new Set(ui.models.map((m) => m.tier))].sort(),
    allPriced: ui.models.every((m) => m.inputPerM > 0 && m.outputPerM > 0 && m.contextTokens > 0),
    allTools: ui.models.every((m) => m.supportsTools),
    jobs: Object.keys(ui.routing).sort(),
  }));
`, { AI_USAGE_DB_PATH: join(tmp, "ui.db"), OPENROUTER_API_KEY: FAKE_KEY });

ok("the picker spans the big three labs and the value labs too", ["anthropic", "google", "openai"].every((f) => uiModels.families.includes(f)) && uiModels.families.length >= 6, JSON.stringify(uiModels.families));
ok("and all three tiers", JSON.stringify(uiModels.tiers) === JSON.stringify(["cheap", "mid", "premium"]), JSON.stringify(uiModels.tiers));
ok("every catalog model has a price and a context window", uiModels.allPriced === true);
ok("every catalog model can call a tool", uiModels.allTools === true);
ok("the routing table covers all eight jobs", uiModels.jobs.length === 8, JSON.stringify(uiModels.jobs));

/* ══════════════════════ 8. catalog refresh degrades silently ══════════════════════ */

const refresh = run(`
  ${FETCH_STUB}
  const C = await import(${JSON.stringify(dist("hull/providers/catalog.js"))});
  installFetch(() => { throw new Error("DNS is on fire"); });
  const broke = await C.refreshCatalog({ force: true });
  const stillThere = C.getModelInfo("google/gemini-3.8-flash");
  installFetch(() => json({ data: [
    { id: "google/gemini-3.8-flash", context_length: 2000000, pricing: { prompt: "0.0000002", completion: "0.0000008" }, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools"] },
    { id: "some/model-harvey-does-not-use", context_length: 999, pricing: { prompt: "0.1", completion: "0.1" } },
  ] }));
  const worked = await C.refreshCatalog({ force: true });
  const merged = C.getModelInfo("google/gemini-3.8-flash");
  console.log(JSON.stringify({ broke, stillThere, worked, merged, count: C.getCatalog().length }));
`, { OPENROUTER_API_KEY: FAKE_KEY, AI_USAGE_DB_PATH: join(tmp, "catalog.db") });

ok("a broken refresh returns false instead of throwing", refresh.broke === false);
ok("and the static catalog is untouched by the failure", refresh.stillThere.inputPerM === 0.75 && refresh.stillThere.contextTokens === 1048576, JSON.stringify(refresh.stillThere));
ok("a live refresh merges real pricing and context", refresh.worked === true && refresh.merged.inputPerM === 0.2 && refresh.merged.outputPerM === 0.8 && refresh.merged.contextTokens === 2000000, JSON.stringify(refresh.merged));
ok("the refresh does not turn the picker into 400 rows", refresh.count === 21, String(refresh.count));

/* ══════════════════════ prompt caching ══════════════════════
   Measured on the live server before this existed: "reply with exactly: model
   layer online" cost 21,012 input tokens and 6.3 cents, because ~14k tokens of
   tool schemas and ~2.3k of system prompt are resent verbatim on every turn. At
   that rate a $10 day is ~160 messages. Caching the two blocks that never change
   is what makes it affordable, and it costs nothing in capability — unlike
   sending fewer tools, which trades money for the occasional wrong refusal. */
console.log("\nPROMPT CACHING — the repetition is the bill");

const bigSystem = "You are Harvey. ".repeat(700);              // ~11k chars
const manyTools = Array.from({ length: 40 }, (_, i) => ({
  name: `tool_${i}`,
  description: "A tool with a long description. ".repeat(12),
  input_schema: { type: "object", properties: { q: { type: "string" } } },
}));

const cached = run(`
  ${FETCH_STUB}
  const OR = await import(${JSON.stringify(MOD.openrouter)});
  const calls = installFetch(() => json({
    id: "gen-1", model: "anthropic/claude-sonnet-4.6",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 2, cost: 0.0001 },
  }));
  const anthropicCall = await OR.callOpenRouter({
    model: "anthropic/claude-sonnet-4.6",
    system: ${JSON.stringify(bigSystem)},
    messages: [{ role: "user", content: "hi" }],
    tools: ${JSON.stringify(manyTools)},
    maxTokens: 256,
  });
  const anthropicBody = calls[0].body;
  const geminiCall = await OR.callOpenRouter({
    model: "google/gemini-3.8-flash",
    system: ${JSON.stringify(bigSystem)},
    messages: [{ role: "user", content: "hi" }],
    tools: ${JSON.stringify(manyTools)},
    maxTokens: 256,
  });
  const geminiBody = calls[1].body;
  const shortCall = await OR.callOpenRouter({
    model: "anthropic/claude-sonnet-4.6",
    system: "be brief",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "one", input_schema: { type: "object", properties: {} } }],
    maxTokens: 256,
  });
  console.log(JSON.stringify({ anthropicBody, geminiBody, shortBody: calls[2].body, ok: !!anthropicCall.text && !!geminiCall.text && !!shortCall.text }));
`, { OPENROUTER_API_KEY: FAKE_KEY });

const aTools = cached.anthropicBody.tools || [];
const aSystem = (cached.anthropicBody.messages || [])[0];
ok("the request still succeeds with breakpoints attached", cached.ok === true);
ok(
  "the LAST tool carries the cache breakpoint, so all of them are cached at once",
  aTools[aTools.length - 1]?.cache_control?.type === "ephemeral",
  JSON.stringify(aTools[aTools.length - 1]?.cache_control),
);
ok(
  "and only the last one does — breakpoints are limited, one covers the prefix",
  aTools.filter((t) => t.cache_control).length === 1,
  String(aTools.filter((t) => t.cache_control).length),
);
ok(
  "the system prompt becomes content parts so it can carry a breakpoint",
  Array.isArray(aSystem?.content) && aSystem.content[0]?.cache_control?.type === "ephemeral",
  JSON.stringify(aSystem?.content?.[0]?.cache_control),
);
ok("the system text survives the conversion intact", aSystem?.content?.[0]?.text === bigSystem);

/* Breakpoints are an Anthropic feature. OpenAI caches long prefixes on its own
   and Gemini does implicit caching, so sending markers there is at best ignored
   and at worst a 400 — the exact kind of avoidable outage this guards against. */
const gTools = cached.geminiBody.tools || [];
ok("a Gemini request gets NO tool breakpoint", !gTools.some((t) => t.cache_control));
ok(
  "and its system prompt stays a plain string",
  typeof (cached.geminiBody.messages || [])[0]?.content === "string",
);

/* Below Anthropic's minimum cacheable length a breakpoint is pure overhead. */
const sTools = cached.shortBody.tools || [];
ok("a small tool set gets no breakpoint", !sTools.some((t) => t.cache_control));
ok(
  "a short system prompt stays a plain string",
  typeof (cached.shortBody.messages || [])[0]?.content === "string",
);

/* The tool definitions are module-level constants shared by every request. A
   marker written into them in place would leak into the direct Anthropic path
   and every other caller, so the helpers must copy. */
const purity = run(`
  const PC = await import(${JSON.stringify(MOD.promptCache)});
  const tools = ${JSON.stringify(manyTools)};
  const before = JSON.stringify(tools);
  const out = PC.withCachedTools(tools, "anthropic/claude-sonnet-4.6");
  console.log(JSON.stringify({
    inputUnchanged: JSON.stringify(tools) === before,
    outputMarked: !!out[out.length - 1].cache_control,
    notSameArray: out !== tools,
    disabled: !!PC.withCachedTools(tools, "anthropic/claude-sonnet-4.6")[0].cache_control,
  }));
`, { HARVEY_PROMPT_CACHE: "true" });
ok("marking tools never mutates the shared definitions", purity.inputUnchanged === true);
ok("it returns a new array", purity.notSameArray === true);
ok("and the copy is marked", purity.outputMarked === true);
ok("the first tool is never marked (only the last)", purity.disabled === false);

const offSwitch = run(`
  const PC = await import(${JSON.stringify(MOD.promptCache)});
  const tools = ${JSON.stringify(manyTools)};
  console.log(JSON.stringify({
    marked: !!PC.withCachedTools(tools, "anthropic/claude-sonnet-4.6")[tools.length - 1].cache_control,
  }));
`, { HARVEY_PROMPT_CACHE: "false" });
ok("HARVEY_PROMPT_CACHE=false turns caching off entirely", offSwitch.marked === false);

/* ══════════════════════ an explicit pick is not negotiable ══════════════════
   Found in production: the picker read GPT-5.1 and every answer came back on
   Mercury 2.5. Not a UI bug and not our routing — OpenRouter caps prompt tokens
   per request on a free-tier balance, Harvey's 14k-token tool preamble exceeded
   that cap for every mid-tier model, and the `models` fallback chain we sent was
   read as permission to run the cheapest entry instead. The call succeeded, so
   nothing logged an error; the only trace was a different name in the footer. */
console.log("\nEXPLICIT PICK — honoured, or reported, never swapped");

const pick = run(`
  ${FETCH_STUB}
  const P = await import(${JSON.stringify(MOD.index)});
  const calls = installFetch(() => json({
    id: "gen-1", model: "anthropic/claude-sonnet-4.6",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 },
  }));
  const explicit = await P.complete({
    job: "chat_deep", modelOverride: "anthropic/claude-sonnet-4.6",
    messages: [{ role: "user", content: "hi" }], maxTokens: 32,
  });
  const explicitBody = calls[0].body;
  const auto = await P.complete({
    job: "chat_deep", messages: [{ role: "user", content: "hi" }], maxTokens: 32,
  });
  console.log(JSON.stringify({
    explicitSentChain: Array.isArray(explicitBody.models),
    explicitSource: explicit.resolved.source,
    autoSentChain: Array.isArray(calls[1].body.models) && calls[1].body.models.length > 1,
    autoSource: auto.resolved.source,
  }));
`, { OPENROUTER_API_KEY: FAKE_KEY, AI_USAGE_DB_PATH: join(tmp, "pick.db") });

ok("an explicit pick is resolved as explicit", pick.explicitSource === "explicit", pick.explicitSource);
ok(
  "and sends NO fallback chain, so the provider cannot substitute",
  pick.explicitSentChain === false,
  JSON.stringify(pick),
);
ok("while Harvey's own choice still gets a chain to fail over with", pick.autoSentChain === true, JSON.stringify(pick));
ok("and is reported as a default, not as the operator's pick", pick.autoSource === "default", pick.autoSource);

/* A provider that answers with a different model than we asked for must be
   reported, because the call SUCCEEDS and nothing else would notice. */
const swapped = run(`
  ${FETCH_STUB}
  const P = await import(${JSON.stringify(MOD.index)});
  installFetch(() => json({
    id: "gen-2", model: "inception/mercury-2.5",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 },
  }));
  const out = await P.complete({
    job: "chat_deep", modelOverride: "anthropic/claude-sonnet-4.6",
    messages: [{ role: "user", content: "hi" }], maxTokens: 32,
  });
  console.log(JSON.stringify({ substituted: out.substituted, modelUsed: out.modelUsed }));
`, { OPENROUTER_API_KEY: FAKE_KEY, AI_USAGE_DB_PATH: join(tmp, "swap.db") });

ok("a substituted model is reported, not swallowed", !!swapped.substituted, JSON.stringify(swapped));
ok(
  "and names both what was asked and what ran",
  swapped.substituted?.asked === "anthropic/claude-sonnet-4.6" && swapped.substituted?.ran === "inception/mercury-2.5",
  JSON.stringify(swapped.substituted),
);

/* The 402 that started all of this must reach the operator intact, since it is
   the message that says what to do about it. */
const tokenCapRefusal = run(`
  ${FETCH_STUB}
  const P = await import(${JSON.stringify(MOD.index)});
  installFetch(() => ({
    ok: false, status: 402,
    text: async () => JSON.stringify({ error: { message: "Prompt tokens limit exceeded: 13663 > 11211", code: 402 } }),
    json: async () => ({ error: { message: "Prompt tokens limit exceeded: 13663 > 11211", code: 402 } }),
    headers: { get: () => "application/json" },
  }));
  let err = null;
  try {
    await P.complete({
      job: "chat_deep", modelOverride: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "user", content: "hi" }], maxTokens: 32,
    });
  } catch (e) { err = { name: e.name, summary: e.summary || e.message, status: e.status }; }
  console.log(JSON.stringify({ err }));
`, { OPENROUTER_API_KEY: FAKE_KEY, AI_USAGE_DB_PATH: join(tmp, "refuse.db") });

ok("an explicit pick that cannot run THROWS instead of running something cheaper", !!tokenCapRefusal.err, JSON.stringify(tokenCapRefusal));
ok(
  "and the provider's own reason survives to the operator",
  /Prompt tokens limit exceeded/.test(tokenCapRefusal.err?.summary || ""),
  tokenCapRefusal.err?.summary,
);

/* ══════════════════════ the catalog is real ══════════════════════
   The picker previously offered `openai/gpt-5.1-mini`, `openai/gpt-5.1-pro` and
   `google/gemini-3-pro`, none of which exist on OpenRouter — choosing one would
   have failed at request time, and nothing here would have noticed. Prices were
   also wrong or missing, which is what made every row read "no price reported".
   So: every id is checked against the live list when a key is available, and the
   shape is checked always. */
console.log("\nCATALOG — every model offered must exist and carry a price");

const catalogRows = run(`
  const C = await import(${JSON.stringify(MOD.catalog)});
  console.log(JSON.stringify(C.getCatalog()));
`);

ok("the catalog is a useful size for a picker", catalogRows.length >= 12 && catalogRows.length <= 40, String(catalogRows.length));
ok("every entry has a provider-qualified id", catalogRows.every((m) => /\//.test(m.id)), JSON.stringify(catalogRows.filter((m) => !/\//.test(m.id)).map((m) => m.id)));
ok(
  "every entry carries a real input AND output price",
  catalogRows.every((m) => typeof m.inputPerM === "number" && m.inputPerM > 0 && typeof m.outputPerM === "number" && m.outputPerM > 0),
  JSON.stringify(catalogRows.filter((m) => !(m.inputPerM > 0 && m.outputPerM > 0)).map((m) => m.id)),
);
ok(
  "every entry carries a real context window",
  catalogRows.every((m) => typeof m.contextTokens === "number" && m.contextTokens >= 100_000),
  JSON.stringify(catalogRows.filter((m) => !(m.contextTokens >= 100_000)).map((m) => m.id)),
);
ok("every entry can call a tool (Harvey is useless otherwise)", catalogRows.every((m) => m.supportsTools === true));
ok("all three tiers are represented", ["cheap", "mid", "premium"].every((t) => catalogRows.some((m) => m.tier === t)));
ok(
  "the picker spans more than the three big labs",
  new Set(catalogRows.map((m) => m.family)).size >= 6,
  [...new Set(catalogRows.map((m) => m.family))].join(","),
);
ok(
  "output price is never below input price (a transposed pair)",
  catalogRows.every((m) => m.outputPerM >= m.inputPerM),
  JSON.stringify(catalogRows.filter((m) => m.outputPerM < m.inputPerM).map((m) => m.id)),
);

/* The live half. Skipped without a key rather than failed, because CI has no
   credential and a network assertion is not what this suite is mainly for. */
const liveKey = process.env.OPENROUTER_API_KEY?.trim();
if (!liveKey) {
  console.log("  skip  live id check (no OPENROUTER_API_KEY in this environment)");
} else {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${liveKey}` },
  });
  const live = await res.json();
  const ids = new Set((live.data || []).map((m) => m.id));
  ok("the live model list is reachable", ids.size > 100, String(ids.size));
  const missing = catalogRows.filter((m) => !ids.has(m.id)).map((m) => m.id);
  ok("EVERY catalog id exists on OpenRouter", missing.length === 0, "missing: " + missing.join(", "));

  /* Prices drift. A wrong number here under-reports the pre-flight estimate, so
     flag anything off by more than 25% rather than pinning exact figures. */
  const byId = new Map((live.data || []).map((m) => [m.id, m]));
  const drifted = [];
  for (const m of catalogRows) {
    const l = byId.get(m.id);
    if (!l?.pricing) continue;
    const liveIn = Number(l.pricing.prompt) * 1e6;
    if (liveIn > 0 && Math.abs(liveIn - m.inputPerM) / liveIn > 0.25) {
      drifted.push(`${m.id} listed ${m.inputPerM} live ${liveIn.toFixed(2)}`);
    }
  }
  ok("catalog input prices match the live list within 25%", drifted.length === 0, drifted.join("; "));
  const noTools = catalogRows.filter((m) => {
    const l = byId.get(m.id);
    return l && !(l.supported_parameters || []).includes("tools");
  });
  ok("every catalog model really supports tools upstream", noTools.length === 0, noTools.map((m) => m.id).join(", "));
}

/* ══════════════════════ result ══════════════════════ */

const total = pass + fail.length;
console.log(`\n${pass}/${total} checks passed`);
if (fail.length) {
  console.error(fail.map((f) => " - " + f).join("\n"));
  process.exit(1);
}
