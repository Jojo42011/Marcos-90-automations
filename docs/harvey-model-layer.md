# Harvey model layer — architecture and HTTP contract

Status: implemented 2026-09-19. This is the contract the backend, the tools and the
chat UI are all built against. If you change a shape here, change it in all three.

## Why

Harvey called the Anthropic SDK directly, with model ids hardcoded in
`src/hull/modelRouting.ts`. Three consequences, all of which this layer removes:

1. **Switching models was a deploy.** No picker, no per-job choice, no fallback.
2. **Cost was invisible.** Nothing read `usage` off a response, so nobody could
   answer "what did Harvey spend today". A runaway loop was a surprise on a bill.
3. **Context was unbounded in principle.** History caps existed, but nothing
   measured tokens against the model actually running, and nothing degraded
   gracefully when a turn got large.

## One key, many models

**OpenRouter is the primary provider.** One `OPENROUTER_API_KEY` reaches
OpenAI, Anthropic, Google and ~400 other models over an OpenAI-compatible
endpoint (`https://openrouter.ai/api/v1`). That is the whole reason it was
chosen: the alternative is a separate key, client and billing relationship per
vendor.

Three properties of theirs are load-bearing here:

- **Real cost per request.** Every response carries `usage.cost` in credits plus
  token counts. Spend is therefore *measured*, not estimated from a price table
  that drifts. The catalog's per-million prices are used only for the pre-flight
  estimate and for models whose provider returns no cost.
- **Model fallback chains.** `models: [primary, ...fallbacks]` fails over on
  context-length errors, rate limits, moderation and outages, and bills for the
  model that actually ran. Provider-level failover underneath that is on by
  default.
- **Price-first routing.** `provider: { sort: "price" }` plus `max_price` keeps
  "cheap" honest. Note that tool-calling requests otherwise route through
  OpenRouter's quality-first tier, so price sorting has to be asked for.

**Direct Anthropic stays wired.** If `OPENROUTER_API_KEY` is unset and
`ANTHROPIC_API_KEY` is present, the layer uses the Anthropic SDK with the old
model ids. Harvey cannot be taken down by a missing OpenRouter key, and the
existing production setup keeps working with no new secret.

Keys live **only** as server environment secrets (`fly secrets set`). No key is
stored in the CRM, in a database, or in page source. The UI never sees a key; it
sees model ids and dollar totals.

## Job → model routing

Model choice is per **job**, not per call site.

| Job | What it is | Default intent |
|---|---|---|
| `chat_fast` | pleasantries, one-liners, no tools | cheapest |
| `chat_deep` | normal operator chat with tools | mid |
| `agent` | background jobs and cron tasks | mid |
| `summarize` | conversation folding / compaction | cheapest |
| `extract` | memory extraction to JSON | cheapest |
| `classify` | short routing decisions | cheapest |
| `vision` | anything containing an image | cheap vision-capable |
| `schedule` | operator sentence → cron | cheapest |

Resolution order: **explicit pick from the UI → stored override → env default →
built-in default**, then fallbacks appended. A model the configured keys cannot
reach is never returned as a primary.

## Context regulation (context rot)

The rule: **a model's advertised context window is not the budget.** Effective
quality degrades well before the limit, and every token is billed, so the layer
targets a *pre-rot* budget and compacts before it is reached.

Applied in this order, cheapest-first, because reversible beats lossy:

1. **Budget** = `min(contextTokens × PRE_ROT_RATIO, hard ceiling per job)`.
2. **Trim** oldest turns first; the most recent turns stay raw so the model keeps
   its rhythm and formatting.
3. **Compact tool results** — old ones become a short pointer/summary, recent
   ones stay verbatim. Tool output is re-fetchable, which makes it the first
   thing that should go.
4. **Summarize** only when trimming cannot free enough. Lossy, so it is last.
5. **Pin governance.** System prompt, safety rules and standing orders are never
   summarized away — a compaction pass must not quietly delete the sentence that
   says "ask before sending".

Every request records its `ContextPlan` (budget, estimate, what was dropped) so
"why did it forget" has an answer.

## Cost control

Enforced **before** the network call, since an un-made request is the only free one.

- Daily cap, monthly cap, and a per-call ceiling.
- Near the cap, cheap jobs **degrade** to the cheapest model instead of failing.
- Over the cap, the call is **refused** with an operator-readable reason.
- A model that errors repeatedly trips a short circuit breaker and traffic moves
  to its fallback rather than retrying into the same wall.
- Every attempt is written to `/data/ai-usage.db` — success or failure, with
  tokens, cost, latency, job, model and error text.

## Approval gate

Tool calls are classified before execution. Anything that **leaves the building
or cannot be undone** — outbound email/SMS/WhatsApp, public posting, deletes,
mass operations, spend — becomes a **pending approval** instead of running.

The chat surfaces it as a card with Approve / Deny. Cron tasks run with the gate
**on**, so a schedule cannot quietly text 1,300 people at 3am.

## Scheduled tasks from chat

Harvey can put its own work on a cron. The operator says it in a sentence; the
`schedule_task` tool stores a real schedule; a ticker runs it.

- Store: `/data/harvey-tasks.db` (tasks + run history).
- Schedule: standard 5-field cron, or plain English parsed into one.
- Timezone: America/Chicago by default, since that is the business.
- Each run: its own budget ceiling, the approval gate on, output recorded and
  optionally delivered to chat.
- Failures are recorded and a task that keeps failing is paused rather than
  retried forever.

## HTTP contract

All routes require a session cookie or `DASHBOARD_TOKEN`, same as the rest of the app.

### Models and routing

```
GET /api/harvey/models
→ {
    models: ModelInfo[],
    routing: { [job]: { model, fallbacks, source } },
    provider: { openrouter: boolean, anthropic: boolean, primary: "openrouter"|"anthropic"|null },
    budget: { spentTodayUsd, spentMonthUsd, dailyCapUsd, monthlyCapUsd, state: "ok"|"near"|"over" }
  }

POST /api/harvey/models/route   { job, model }        → { ok, routing }
DELETE /api/harvey/models/route/:job                  → { ok, routing }
```

### Chat

```
POST /api/harvey/chat
body { message, sessionId?, model?, stream?: boolean, conversationId? }

stream: true  → SSE:
  event: token     data: { text }
  event: tool      data: { name, status: "running"|"done"|"error" }
  event: approval  data: { id, tool, summary, risk }
  event: usage     data: { model, promptTokens, completionTokens, costUsd, contextPlan }
  event: done      data: { sessionId, conversationId, text }
  event: error     data: { message }

stream: false → { text, sessionId, conversationId, usage, contextPlan, approvals[] }
```

### Conversations

```
GET    /api/harvey/conversations                → { conversations: [{ id, title, updatedAt, messageCount }] }
GET    /api/harvey/conversations/:id            → { id, title, messages: [{ role, content, at, model?, costUsd? }] }
DELETE /api/harvey/conversations/:id            → { ok }
POST   /api/harvey/conversations/:id/title      { title } → { ok }
```

### Usage

```
GET /api/harvey/usage?days=30
→ { today: {...}, month: {...}, byModel: [{ model, calls, costUsd, tokens }],
    byJob: [{ job, calls, costUsd }], recentErrors: [{ at, model, job, error }],
    daily: [{ date, costUsd, calls }] }

POST /api/harvey/usage/caps  { dailyCapUsd?, monthlyCapUsd? } → { ok, caps }
```

### Approvals

```
GET  /api/harvey/approvals                 → { pending: [{ id, tool, summary, risk, args, createdAt }] }
POST /api/harvey/approvals/:id/approve     → { ok, result }
POST /api/harvey/approvals/:id/deny        { reason? } → { ok }
```

### Scheduled tasks

```
GET    /api/harvey/tasks                   → { tasks: [{ id, title, prompt, cron, timezone, nextRunAt, lastRunAt, lastStatus, enabled, deliver }] }
POST   /api/harvey/tasks                   { title, prompt, cron | when, timezone?, deliver? } → { ok, task }
PATCH  /api/harvey/tasks/:id               { enabled?, cron?, prompt?, title?, deliver? } → { ok, task }
DELETE /api/harvey/tasks/:id               → { ok }
POST   /api/harvey/tasks/:id/run           → { ok, runId }
GET    /api/harvey/tasks/:id/runs          → { runs: [{ id, startedAt, finishedAt, ok, costUsd, output, error }] }
```

## Environment

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | the one key; unlocks every model in the picker |
| `OPENROUTER_APP_URL` / `OPENROUTER_APP_TITLE` | optional attribution headers |
| `ANTHROPIC_API_KEY` | fallback provider, and what production runs on today |
| `HARVEY_MODEL_<JOB>` | override one job's model, e.g. `HARVEY_MODEL_CHAT_DEEP` |
| `HARVEY_DAILY_CAP_USD` | daily spend cap (default 10) |
| `HARVEY_MONTHLY_CAP_USD` | monthly spend cap (default 150) |
| `HARVEY_MAX_COST_PER_CALL_USD` | per-call ceiling (default 0.50) |
| `HARVEY_PRE_ROT_RATIO` | fraction of the context window we allow (default 0.5) |
| `HARVEY_CONTEXT_CEILING_TOKENS` | hard input ceiling (default 60000) |
| `HARVEY_APPROVAL_REQUIRED` | `false` disables the approval gate (default on) |
| `HARVEY_CRON_ENABLED` | `false` stops the scheduled-task ticker |
| `AI_USAGE_DB_PATH`, `HARVEY_TASKS_DB_PATH` | store paths (default `/data`) |
