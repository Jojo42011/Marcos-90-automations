# FORAI — Marcos-90-automations (marco-90-automation)

Last updated: 2026-07-24 by Claude Code

FORAI = "For AI." This is the living architectural summary of this repo — the source of truth agents read before working here, and the source the AETHON Chronicler pulls nightly to keep the master architecture docs current. Keep it short: current state, recent changes, known gaps. Not a commit log.

**Convention (non-negotiable, same as the green-build rule):** whenever you finish meaningful architectural work here — a new subsystem, endpoint, table, integration, or a change to how something works — add a dated line to `## Recent changes` (most recent first) and refresh Architecture / Known gaps if they changed. Not every commit — anything that changes what someone reading the architecture needs to know. Flag anything security/breaking explicitly (the words "security", "unauthenticated", "breaking change" route it to the Security register and ping Telegram).

## What this system is

A single-tenant business automation platform built for one real-estate agent (Marco Puga). It runs the full funnel: Instagram/ManyChat DMs and SMS in, an AI qualification pipeline, a Brivity-backed CRM, transaction and finance tracking, email marketing, lead-nurture and reporting agents, plus a short-form content pipeline that turns long video into published vertical clips. On top of it sits "Harvey," an operator-facing AI assistant with persistent memory that can read and act on the whole business state.

It deploys as one Docker image to Fly.io (app `marco-90-automation`, region `dfw`, 4 GB `performance-2x`, `/data` volume). Supervisord runs three processes in that image: the Node server on :3000, the OpenShorts Python video sidecar on :8000, and a CapCutAPI draft generator on :9001. Pushes to `main` (or `master`) trigger GitHub Actions, which builds with a buildx layer cache, pushes to `registry.fly.io`, and runs `flyctl deploy --image`.

## Architecture

- **`src/server.ts`** — one monolithic Express app (~10.5k lines, ~395 routes registered directly on `app`, no Routers). Also hosts the WebSocket upgrade router (ElevenLabs STT → Deepgram fallback → Hull `/ws`) and an OpenAI-compatible `/v1/chat` surface used by the WhatsApp gateway.
- **`src/core/`** — persistence + domain layer. ~12 `better-sqlite3` stores, each owning its own file under `/data` (`content.db`, `social.db`, `transactions.db`, `finance.db`, `email.db`, `auth.db`, `ads.db`, `sms.db`, `leadscores.db`, `reporting.db`, `crm-automation.db`, `voice-clone.db`) plus ~11 JSON stores (`local-dashboard-db.json` is the main app DB: leads, conversations, tasks, dashboard snapshot). `types.ts` holds shared types and the role/permission model.
- **`src/agents/`** — 22 scheduled/autonomous agent families: `contentManager` (largest — ingest → clip → enhance → publish, with a Claude-driven `brain/` strategy loop), `emailMarketing`, `finance`, `reporting`, `leadNurture`, `transactionFlows`, `leadScoring`, `socialMedia`, `voiceClone`, escalations, reminders, and re-engagement.
- **`src/harvey/`** — the operator AI: `perception` (fresh business snapshot) → `judgment` (focus areas/directives) → `communication` (Sonnet operator voice), with Anthropic tool definitions in `tools.ts` and persistent episodic/semantic memory in `harvey-memory.db`.
- **`src/hull/`** — the general agent runtime under Harvey ("Aethon hull"): agent loop, model routing, graph memory (`aethon-memory.db`), voice STT/TTS, WebSocket transport.
- **`src/app/` + `src/modules/`** — the DM request path: webhook intake → funnel state → numbered pipeline steps (01–12) → Claude reply.
- **`src/integrations/`** — thin per-vendor clients: Brivity, Twilio, Sinch, Apify (TikTok), Gmail/Google Drive, ManyChat, upload-post, ElevenLabs, Anthropic, OpenShorts, Forewarn.
- **`public/`** — ~20 standalone HTML pages, no build step and no framework. `shell.html` is the app shell that iframes the rest; `crm-brivity.html` is the Brivity-replica CRM (the centerpiece), alongside `jarvis.html` (Harvey), `social.html` (Content Manager), `dashboard.html`, `ads.html`, `finance.html`, `reporting.html`, and others.
- **`services/openshorts/`** — Python/FastAPI video sidecar. Upstream `mutonby/openshorts` cloned at build, with Marco-specific `*_marco.py` modules layered on: transcription, LLM viral-moment detection, gaze/take analysis, auto-reframe, burned ASS captions, emoji overlays, dead-air removal. Concurrency- and memory-guarded for the 4 GB VM.
- **`vendor/openreel`** — vendored MIT browser clip editor served same-origin at `/editor`, patched to load a clip by `?clip=<id>&token=`.
- **Auth (built, not enforced)** — session cookie `mp_sid` + scrypt passwords + `sessions`/`login_history`/`audit_log` in `auth.db`, gated behind the `SITE_LOGIN_ENABLED` env kill switch. Legacy API auth is `DASHBOARD_TOKEN`. See Known gaps.

## Recent changes (most recent first)

- [2026-07-24] — Task Command: `CommandTask` gains an optional `checklist` (`CommandTaskChecklistItem[]`, parsed and capped server-side on POST/PATCH `/api/tasks`), surfaced as a checkbox list under Details / Notes with a progress chip on the card. Task Description became an auto-growing textarea (newlines collapsed on save so the title stays one logical line). Added `color-scheme` per theme plus solid `select`/`option` colors, which fixes native dropdowns and date pickers rendering washed out in dark mode.
- [2026-07-24] — Ad Manager tab removed from the app shell at the owner's request. Nothing deleted: `public/ads.html`, `src/core/adsStore.ts`, the `/ads` route and `/api/ads/*` all still work, so restoring it means uncommenting one `TABS` entry in `public/shell.html`.
- [2026-07-24] — People smart filters now actually filter. They were a dead `<a>` with no list and no handler; `mapPeopleLive` was also dropping the fields predicates need (`statusDisp`, `alerts`, `reports`, `autoPlanEnrollments`), so reusing the Leads predicates would have silently matched every row. Filters needing website-visit data are shown but flagged as having no source data instead of returning everything, and the same three no-op `=> true` filters were fixed in the Leads list.
- [2026-07-24] — DM agent: re-anchor reply when a lead is confused by the first-time-buying opener, and a smoother recovery when a lead says they already sent a number that never landed. Known gap: numbers sent inside a quoted/reply bubble still are not captured, since only `message.text` is read.
- [2026-07-24] — Initial FORAI.md added; repo joined the Chronicler's nightly sweep.
- [2026-07-24] — CRM Dashboard: "Filtered" chip now opens a real multi-select Timeline Filter popup, Take Action refresh button wired; Calendar events are derived from transaction records and click through to the matching transaction row.
- [2026-07-24] — Ad Manager tab added (`public/ads.html`, `src/core/adsStore.ts`, `/api/ads/*`). Live Meta *reporting* reuses the existing `AD_DASHBOARD_BASE_URL` proxy; campaign creation is a local planner only — there is no write-capable Meta Marketing API in this codebase.
- [2026-07-24] — **Security:** site-wide login, team accounts, and an action audit trail added (`src/core/authStore.ts`, `public/login.html`, `public/team.html`, `/api/auth/*`). Deliberately left **unenforced** behind `SITE_LOGIN_ENABLED` at the owner's request — the app is currently open. Uses Node's built-in `crypto.scrypt` and hand-rolled cookie parsing so the no-npm-install overlay deploy path keeps working.
- [2026-07-23] — CRM Email Marketing wired to real Gmail sending via the existing OAuth link; Newsletters list and per-row delete added.
- [2026-07-23] — Transactions CSV import in Brivity export format; system-wide always-visible top scrollbar synced to each table's bottom bar.

## Known gaps / open issues

- **Security — the app is currently unauthenticated.** `SITE_LOGIN_ENABLED` is off in production (owner's explicit decision: "keep it in the back end for now"), and `dashboardTokenOkIncoming()` returns `true` whenever `DASHBOARD_TOKEN` is unset. Re-enabling is a one-secret change, no code edits.
- **Default branch is wrong.** GitHub reports `master` as the default branch, but `master` is a stale, *unrelated* history (7 commits, last real change 2026-07-20) with no merge base against `main`. All 267+ commits of real work, and every deploy, live on `main`. This file is on `main`. Until the GitHub default is flipped to `main`, the Chronicler's nightly sweep will look at the wrong branch and miss this file.
- **`server.ts` is a 10.5k-line monolith** with ~395 routes on a single `app` and no Routers. It works, but every feature widens the same file; it is the main structural debt here.
- **Ad Manager is hidden and is reporting + local planner only.** Its shell tab is commented out (owner's request), though `/ads` and `/api/ads/*` still serve. There is no Meta Business/ad-account write access, so nothing in the app can create or edit a real campaign. Doing so needs a System User token, an ad account ID, and spend guardrails (budget caps, approval-before-live) that do not exist yet.
- **No website-visit tracking.** Several Brivity smart filters ("site visit today / this week / last 30 days") depend on it, so in both Leads and People they are listed but disabled with an explanatory toast rather than silently matching every row.
- **`AD_DASHBOARD_BASE_URL`** points at `https://marco-agents.fly.dev`, which is not currently reachable; the Ad Manager degrades to an honest "unreachable" badge.
- **Content pipeline is TikTok-only in practice.** `src/core/socialStore.ts` hardcodes `const PLATFORM = "tiktok"`, so scoring/analytics are not Instagram-native despite the UI implying multi-platform.
- **No test suite and no linter.** `npm run build` (tsc) is the only automated gate; verification is manual, usually a headless-browser pass before deploying.
- **Several integrations are stubs** that throw or no-op: `integrations/manychat` (`sendDM`), `integrations/amazon`, `integrations/newhomebuddy`, `integrations/brivity/index.ts` (the real client is `integrations/brivity.ts`).
- **`voxcpm-service` cannot run in production** — it needs CUDA and ~8 GB VRAM, so voice-clone TTS relies on ElevenLabs instead.
- Deploys cannot add npm dependencies via the fast overlay path; a new dependency requires a full image rebuild.
