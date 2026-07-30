# Scope: Harvey as a recurring research coworker

The vision: give Harvey a standing brief — *"track mortgage-rate moves and new
listings in Boerne every morning"*, *"watch my three top competitors weekly"*,
*"keep a running doc on the San Antonio luxury market"* — and it runs on its
own, updates a living document, and is there to check each morning. Cowork, but
pointed at Marco's business.

This is a deep-dive on the distance between what we have and that, written after
reading the actual code, not from memory.

## What we already have (and it's most of the hard part)

- **A durable background job runner** (`src/hull/jobRunner.ts`): detached from
  any HTTP request, 40 tool-call ceiling, writes every step to disk as it goes,
  survives nothing-in-flight, and reconciles orphans at boot. This is the engine
  a research task runs on. It works today — a real job chained 34 tool calls
  unattended and wrote a 12 KB report.
- **A persistent workspace** on the `/data` volume (`src/core/workspace.ts`):
  files survive deploys. This is the substrate for a self-updating document.
- **A job/results UI** across every Harvey surface (`harvey-jobwatch.js`,
  `/jobs`): live progress, rendered reports, downloadable files, delete.
- **A memory store** (`aethon-memory.db`, embeddings): Harvey can already
  remember facts between sessions.
- **Code execution, hardened, default-off** (`src/core/codeExec.ts`): once on,
  a research job can compute and chart, not just prose.

So the runtime for "do a big task in the background and leave a document behind"
exists and is proven. What's missing is narrower than it looks.

## The four gaps, in priority order

### Gap 1 — Harvey cannot read the web. THIS IS THE BLOCKER.

`BRAVE_SEARCH_API_KEY` is not set in production, so the `web_search` tool is not
even registered (`getHullToolDefinitions` gates it on the key). Harvey has no
way to look anything up outside Marco's own data.

And even with the key, `web_search` returns Brave **snippets** — title,
description, URL — never the body of a page. You cannot research a topic from
search snippets; you research it by reading the sources. **There is no
`fetch_page` tool at all.**

Until Harvey can (a) search and (b) read a page, "research a topic daily" is not
a scheduling problem or a UI problem — it is simply impossible. Everything below
depends on closing this first.

Two ways to give Harvey the web, and they are not exclusive:

- **A search+read API** (Brave for search, plus a fetch-and-extract step that
  pulls a URL and strips it to readable text). Cheap, deterministic, no browser
  needed. Brave Search has a free tier. This is the fast path and the one I'd do
  first. Needs a key from Marco.
- **The browser-control extension we already built.** Harvey can already drive
  Marco's Chrome and read pages that have no API — including ones behind a login
  (MLS, a portal). For research that needs a logged-in source, this is the only
  path. But it needs Marco's browser open and armed, so it can't be the backbone
  of an unattended nightly job.

Recommendation: **API for the unattended backbone, browser for logged-in
sources on demand.** Build the API path first — a `web_search` that's actually
enabled plus a new `fetch_page` (fetch URL → readable text, size-capped, with
the same no-network-to-internal-services discipline as everything else).

### Gap 2 — Jobs are one-shot. There is no recurrence.

A job runs once and finishes. There is no store that says "run this brief every
morning at 7." The 14 recurring things in the codebase are all hardcoded agents
wired at boot with `setInterval` — there is no way for Marco to *define* a
recurring task without a code change.

What's needed: a small **research-brief store** (`briefs.db` on `/data`):
`{ id, title, prompt, cadence (daily/weekly/manual), lastRunAt, nextRunAt,
docPath, status }`. A single boot-time scheduler ticks every N minutes, finds
briefs whose `nextRunAt` has passed, and starts a job for each — reusing the
runner we already have. This is the same `setInterval`-at-boot pattern the
reminder agent already uses, generalised to a user-defined list. Persisted, so
it survives the daily deploy.

### Gap 3 — Nothing appends to a living document over time.

A job writes a file and stops. "Updates itself" means each run should *add to*
a running document, not overwrite it or start a fresh file each morning.

The `edit_file` tool already exists, so the mechanism is there — what's missing
is the pattern: a brief owns one doc (`research/boerne-market.md`), and each run
is told "here is what you found before; append today's findings with a dated
heading, and revise the summary at the top." A short, dated changelog at the top
of the doc is what turns 30 nightly runs into something readable rather than 30
disconnected files. This is mostly prompt-shape plus a convention, not new
infrastructure.

### Gap 4 — No "check in each morning" surface.

`/jobs` shows a flat list of one-off runs. A research coworker needs a view
organised around **briefs**: each brief as a card showing its living document,
when it last ran, what changed in the latest run, and a "run now" button. This
is a straightforward extension of the Jobs page we just rebuilt — the job card,
markdown renderer and file rows are already shared components.

## The shape of the build (phased, each shippable on its own)

**Phase 1 — give Harvey the web (unblocks everything).**
Enable `web_search` (needs a key) and add a `fetch_page` tool: fetch a URL,
extract readable text, cap the size, refuse internal/loopback addresses. Verify
Harvey can research a topic end-to-end in a one-off job. ~2–3 days once the key
exists. **Nothing else is worth building until this works.**

**Phase 2 — recurring briefs.**
The `briefs.db` store, a generic scheduler, the "one brief → one living doc,
append each run" convention, and a `manage_research_brief` tool so Harvey can
set one up when Marco asks in plain language. ~3–4 days.

**Phase 3 — the briefs surface.**
A briefs view: living doc, last-run diff, run-now, pause, edit cadence. ~2–3
days, mostly reusing the Jobs components.

**Phase 4 (optional) — a morning digest.**
One daily message ("3 briefs updated overnight; here's what changed") to
whatever channel is live. Depends on Gmail being reconnected or SMS configured —
both currently blocked on Marco.

## The honest constraints

- **A search/read key is required and only Marco can supply it.** Brave has a
  free tier; that's the cheapest start. Without it, Phase 1 cannot run, and
  without Phase 1 the rest is scaffolding around an empty room.
- **Research quality is bounded by what's readable.** Public web: fine via the
  API. Anything behind a login (MLS, a paid data source) needs the browser
  extension armed, which means it can't be part of an unattended nightly run —
  it's an on-demand, Marco-present task. Say this plainly rather than implying
  the nightly job can see everything.
- **This spends tokens on a schedule.** A daily brief is a 20–40 tool-call job
  every morning, unattended. Worth a per-brief on/off and a visible run count so
  it can't quietly run up a bill.
- **Cost of being wrong is low here.** Research writes to a document Marco reads;
  it does not touch client records, send anything, or move money — unlike the
  transaction and DM paths. That's what makes this a good place to let Harvey
  run more autonomously than elsewhere.

## Recommendation

Phase 1 first, and nothing else until it's real, because it is the one true
blocker. The moment I have a search key I can have Harvey researching a topic
end-to-end in a one-off job — that alone is a large step toward the vision and
proves the approach before we build the scheduler around it.

**Decision needed from you:** a Brave Search API key (free tier is fine to
start) so I can build and verify Phase 1. If you'd rather lean on the browser
extension for research instead of an API, tell me and I'll scope that path
instead — but it can't power an unattended nightly job, only an on-demand one
while your browser is open.
