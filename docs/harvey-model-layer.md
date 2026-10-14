# Harvey model layer

Current source: src/hull/providers, src/hull/agentLoop.ts and src/core/aiUsageStore.ts. Project/chat execution is documented in [Harvey Work](harvey-work.md).

## Providers and routing

OpenRouter and direct Anthropic adapters normalize completions, tool calls and usage. The catalog/routing modules resolve configured model IDs, job routing and fallbacks. Provider availability depends on effective configuration; this document does not identify the provider currently serving production.

A chat can persist its own model selection. Jobs inherit that selection unless explicitly overridden. Scheduled runs use HARVEY_SCHEDULE_MODEL, defaulting in current code/config to inception/mercury-2.5. Consult the catalog and effective routing rather than assuming every listed model supports every tool or input type.

## Context and spending

contextBudget.ts budgets system context, history, tool schemas/results and output space. Provider limits and application ceilings both matter. Work also bounds recent history and retrieves archived messages or lessons on demand.

Usage is recorded in aiUsageStore.ts with model/job/token/cost/error information. Budget checks, configured daily/monthly/per-call caps and circuit breakers run before provider requests. Recorded cost and preflight estimates do not guarantee a total cap on third-party plugin or infrastructure charges.

## Approvals and evidence

src/hull/approval.ts classifies named business tools and crm_api by HTTP method. High-risk calls are held when the gate is enabled; strict mode also holds medium-risk calls. Pending approvals are in memory with expiry and are lost on restart. Unclassified tools default to low risk in this classifier, so it is not a universal guarantee that every external action has an approval card.

Work has additional connector/browser permissions and user-authorization rules. Business calls retain the business approval gate; managed/custom connector behavior is defined by its runtime path. See [reliability](harvey-reliability-safeguards.md) for receipt and read-back limits.

## HTTP surfaces

Routes are defined in src/server.ts and src/harvey/work/routes.ts. Treat those implementations as the exact request/response contract.

| Surface | Routes |
| --- | --- |
| Model catalog and effective routing | GET /api/harvey/models |
| Route overrides | POST /api/harvey/models/route; DELETE /api/harvey/models/route/:job |
| Usage and caps | GET /api/harvey/usage; POST /api/harvey/usage/caps |
| Approval decisions | GET /api/harvey/approvals; POST /api/harvey/approvals/:id/approve or /deny |
| Direct chat entry | POST /api/harvey/chat |
| Persistent chats | /api/harvey/conversations and /:id |
| Projects | /api/harvey/projects |
| Jobs, schedules, browser, files and plugins | /api/harvey/work/* |

The Work chat entry uses workspace:true with a conversation ID; the frontend also submits persistent background jobs and retrieves their progress/results. Direct streaming and background-job responses differ. Conversation history is server-persisted, not only browser localStorage.

Under ACCOUNT_ISOLATION=true these surfaces require account routing. A shared DASHBOARD_TOKEN alone does not select a personal account. Carlos's authorized combined access is described in [team access](team-access.md).

## Configuration

Provider keys are OPENROUTER_API_KEY and ANTHROPIC_API_KEY. Model overrides, context ceilings, prompt caching and budget settings are read in src/hull/providers and src/core/aiUsageStore.ts. Approval settings are HARVEY_APPROVAL_REQUIRED and HARVEY_APPROVAL_STRICT. Effective worker values depend on the gateway environment allowlist.

## Verification

scripts/verify-harvey-model-layer.mjs, verify-harvey-approval.mjs, verify-harvey-routes.mjs, verify-harvey-work.mjs and verify-harvey-reliability.mjs cover relevant contracts. See CI configuration for which checks run automatically. Fixture results do not establish live provider availability or task accuracy.

## Task guidance and onboarding

The authenticated /api/harvey/work/model-advice endpoint and model_advice tool share available configured models, routing, image capability and an illustrative uncached 10,000-input/2,000-output-token cost. Each price is labeled with catalog provenance/freshness; null provider prices retain static estimates instead of becoming zero. A model response estimate is not an entire-task quote.

The Models screen provides lower-cost routine/visual candidates and the configured multi-step option. Selection preserves the existing per-chat pinning behavior. Auto follows routing and is not guaranteed cheapest. Cost tier is not evidence of quality or speed: successful call latency is aggregated over seven days for the current owner's latest 200 chat sessions only, with at least three samples. These observations are not controlled benchmarks. Missing timings remain unknown. Model advice cannot inspect provider balances and does not change limits or settings.
