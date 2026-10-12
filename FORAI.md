# FORAI — Marcos-90-automations

Last reconciled: 2026-10-11 against master at 5954ead62cd6c56fd4924a44a99918807b26d9d9 (documentation-only cleanup).

**master is the default branch.** This file describes implemented source behavior. It is not a live credential, production-data or service-health report. Detailed historical changes remain in Git.

## What this system is

A real estate business platform for Marco, Wesley and Carlos with CRM, social lead automation, tasks, MLS/CMA, transactions, finance, reporting and Harvey. The original 12-module proposal is broader than the completed numbered modules; newer agents provide additional business workflows.

## Architecture

- **Server:** src/server.ts is the main Express application (roughly 15,000 lines). It registers business APIs, page routes, authentication integration, WebSockets and startup workers. Harvey Work adds a router from src/harvey/work/routes.ts.
- **Frontend:** public/shell.html hosts standalone pages. public/crm-brivity.html is the main CRM; Harvey, tasks, tracker, listings, CMA, finance, reporting, analytics and knowledge have dedicated pages. No frontend framework/build.
- **Accounts:** ACCOUNT_ISOLATION=true in fly.toml. The parent authenticates users and forks loopback-only account workers. dataPath() uses /data/accounts/<sha256(user-id)> for account-local stores. Carlos's combined access is enforced by accountProxy/accountFederation/workspaceAccess; owner-qualified references route edits to the original store. Shared task/knowledge/MLS stores are explicit exceptions. See docs/team-access.md.
- **Persistence:** CRM leads and conversations use JSON through core/db.ts. Business subsystems use separate SQLite or JSON stores. Command tasks use shared-tasks.db under isolation, with history and soft deletion. Shared knowledge uses shared-knowledge.db. Harvey retains owner/chat-keyed records and messages in harvey-work/work.db. Account IDs and retained source files are preserved during recovery.
- **Social intake:** app/webhook.ts and app/pipeline.ts handle qualification, conversation state, phone/criteria capture and replies. ManyChat POST /webhook and signed Zernio POST /api/zernio/webhook remain parent-owned shared services. Comment handling uses durable queueing and fact-free reply templates. DM history is recovered with bounded pagination and chronological guards. Unknown-property replies do not pretend to understand images/video.
- **Business automation:** src/agents plus core schedulers cover email drips, lead nurture/scoring, reminders, transaction flows, finance, reporting, listing outreach and social analytics. Availability depends on the worker's configured integrations.
- **Harvey:** src/hull runs the model/tool loop, provider adapters, context/spend limits, approvals and voice. src/harvey supplies business tools and src/harvey/work supplies persistent chats/projects, managed/custom connections, per-chat Playwright browsers, files, jobs, schedules, lessons and workflows. Chat and Work both expose authorized app/browser actions. Voice's separate interface is not the project coordinator.
- **Deployment:** Docker runs the Node server through supervisord; Node starts account/browser workers. Current fly.toml specifies dfw, shared-cpu-8x, 2 GB RAM, 1 GB swap and a /data volume. Hosted browser and scheduled Harvey worker are enabled in configuration. GitHub Actions builds on pushes to main or master unless skipped. Docker compiles source rather than relying on tracked dist.
- **Removed:** the old Content Manager/Calendar, OpenShorts/CapCut services, OpenReel editor and legacy Jarvis page/job scheduler. Remaining analytics/content-suggestion/voice modules do not restore the removed pipeline. Current jobs/schedules are under harvey/work.

## Recent changes

- 2026-10-12: Production video testing exposed invented filesystem download links. Restored edit_video download URLs, included them in workspace listings, and normalize generated links only when they match existing files in the current chat. No stored conversation history is rewritten.

- 2026-10-12: Harvey video edits now probe source streams/timing, select one decodable audio track (prefer AAC), normalize derived H.264/AAC exports, tone-map HDR, match clip durations by measured whole frames, bound decoding memory and retry resource failures once. Verified exports are reused; originals and pre-existing failed files remain untouched. Added inspect_video, retained media diagnostics and a two-edit-call per-source budget. Job polling reconnects after transient failures and the UI preserves specific errors through final rendering.

- 2026-10-12: Hardened Harvey uploads with validated workspace paths, preserved extensionless-media aliases, explicit chooser cancellation, 120-second upload allowance and paginated asset discovery. Added bounded streaming URL imports, durable task progress checkpoints, ordered work-tool execution, and two-attempt repair for empty/pseudo-tool model replies. Authorized connected-mailbox login codes are supported by runtime guidance; CAPTCHA and external approvals still require the user. No existing records or media are migrated or removed. Chromium CI verifies a 64 MiB multipart upload without duplicate submission.

- 2026-10-12: Added an account-specific Carlos’s tasks toggle to Marco and Wesley’s Task Center. Opt-in reads include Carlos assignments without expanding mutation, reminder or other-owner access. Reconciled master’s merged, default-disabled video property knowledge pipeline (see docs/video-knowledge.md); Harvey browser changes remain intact.

- 2026-10-12: Deployed browser testing exposed text-only models treating captured screenshots as visible evidence. Such screenshots now carry an explicit evidence limitation, cannot verify visual completion, and visual-only replies explain the model capability limit.
- 2026-10-12: Browser actions reuse recent observations, return focused/paginated evidence and model-visible screenshots, and report targeted recovery without replaying uncertain actions. Hosted tabs no longer expire on idle; tab selection and cookies checkpoint for restart restoration. Browser recovery and persistence fixtures cover these paths.
- 2026-10-11: Reconciled documentation with master; removed obsolete handoff/planning documents, stale production assertions and branch-mirroring instructions. Updated account/task storage, Harvey capabilities, deployment and verification references. Documentation only; no runtime, data or workflow changes.
- 2026-10-10: Polished account settings and dark surfaces; corrected signed-in CRM identity. Added compact crm_api field selection and per-owner dashboard totals, classified CRM GET receipts correctly, and fixed verified relay acknowledgements and negative-action constraints.
- 2026-10-10: Added Carlos combined business/chat access, shared knowledge and MLS, per-account appearance settings and permission-scoped chat relays while retaining original owner data. See docs/team-access.md.
- 2026-10-09: Unknown-property DMs use future follow-up wording and avoid unsupported media requests and repeated phone asks.
- 2026-10-08: Added bounded Zernio history/phone recovery, serialized overlapping turns, fact-free public comment replies and durable retries.
- 2026-10-07: Improved independent chat models, browser target recovery, provider retry handling and job recovery.
- 2026-10-05: Added chat computer previews and repaired shared task collaboration.
- 2026-10-02: Added persistent Harvey lessons/workflows/jobs and verification safeguards; restored retained Marco CRM.
- 2026-09-30: Introduced isolated account workers and shared task recovery. Subsequent changes restored parent-owned comment/DM intake and expanded Carlos access.
- 2026-09-23: Added the current Harvey Work architecture after retiring the legacy interface/runtime.
- 2026-09-20: Removed the old Content Manager and Calendar with their sidecars/editor.

## Current implementation limits

- **Integration routing:** account workers inherit a restricted environment. Model infrastructure, Composio and SimplyRETS are shared; unrelated root Gmail/Brivity/SMS/extension credentials are not inherited. Only the explicitly shared inbound routes bypass account routing. Route presence alone does not establish usability under isolation.
- **Stubs:** integrations/amazon, integrations/newhomebuddy and integrations/brivity/index.ts throw; integrations/manychat/sendDM is a stub because ManyChat normally delivers webhook replies itself. Numbered modules 09–12 retain scaffold/no-op functions. The real Brivity lead client is integrations/brivity.ts.
- **Transactions:** CSV and configured sheet synchronization exist. No native Brivity transaction API client is implemented. Standard deadline offsets are labeled placeholders in transactionsStore.ts.
- **Harvey execution:** hosted browser control is not a local desktop. Account workers force HARVEY_EXEC_MODE=off. codeExec.ts's optional local mode is hardening, not an OS sandbox.
- **Browser continuity:** laptop disconnect leaves the hosted session running. Explicit Close ends it; up to three live chat browsers per account remain supported. Fly/process restarts reload checkpointed URLs and selected tabs using retained profiles/cookies. Unsaved page memory, form state and expired website authentication cannot be guaranteed. Checkpoint warnings do not mean an action failed; uncertain actions are never automatically replayed. Visual coordinates require a recent screenshot, and arbitrary page code stays unavailable.
- **Reliability:** receipts/read-backs are not independent proof of semantic correctness or complete pagination. Jobs use local process coordination and SQLite, not distributed exactly-once execution. Running actions can finish after cancellation; interrupted jobs require inspection.
- **Ads:** local planning/reporting and an upstream proxy exist; do not imply real campaign creation or spend control.
- **Voice:** VoxCPM requires a separate compatible GPU service; it is not started by the Node Docker image.
- **Maintenance:** server and major frontend pages are large. Documentation must not substitute old data counts, provider health or feed observations for current checks.

## Verification references

CI selects scripts in .github/workflows/account-isolation.yml, including comment/DM behavior, task recovery, account isolation, credential consent, Harvey Work/reliability and browser persistence/UI. Additional team access/data, model, CRM and business checks are under scripts/.

The baseline SHA's existing deployment and isolation runs passed on 2026-10-10. This documentation cleanup did not run builds, tests, services or live integration checks. Passing fixture tests does not verify external account configuration or live model task quality.

## Focused documentation

- [Account routing](docs/account-isolation.md), [team access](docs/team-access.md), [task storage](docs/task-management-storage.md)
- [Harvey Work](docs/harvey-work.md), [model layer](docs/harvey-model-layer.md), [persistent agents](docs/harvey-persistent-agents.md), [reliability](docs/harvey-reliability-safeguards.md)
- [Setup](SETUP-CHECKLIST.md), [ManyChat listing context](docs/manychat-listing-id.md)
