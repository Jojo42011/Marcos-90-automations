# Harvey reliability safeguards

Current implementation on master. See [persistent learning and coordinated agents](harvey-persistent-agents.md). Source: src/harvey/reliability.ts, src/hull/agentLoop.ts and src/harvey/work.

## Implemented

- Tool evidence receipts record returned, failed or held outcomes. Completion checks reject missing evidence, failed results, unresolved limitations and truncated sources. Possible writes require a subsequent observation within the affected service. Later actions invalidate earlier verification.
- verify_source_values checks claimed values at exact JSON-pointer paths in current tool results. It can catch an invented address or number when invoked; it does not prove all records or pages were retrieved.
- Work responses are buffered until review. Unsupported completion claims receive a needs-verification result. Scheduled runs require accepted structured verification before receiving completed status.
- Canonical nested argument hashing and repeat guards prevent identical possible actions from executing twice in one turn. This also avoids blindly retrying ambiguous failures.
- Agent-maintained task plans and per-tool evidence checkpoints persist in the existing owner/chat-scoped SQLite store. Additive record types require no destructive migration.
- Interactive tasks run as persisted background jobs, separate from the browser HTTP connection. Request IDs deduplicate submissions. The UI reconnects to active jobs after refresh; explicit Stop requests cancellation. Queued tasks can start after restart; interrupted running tasks require inspection instead of automatic replay.
- Running or queued tasks prevent chat deletion and project/mode changes. Existing owner checks cover job status, cancellation and evidence endpoints. Job status omits the original prompt and fingerprint; progress records exclude tool arguments and raw responses.
- Browser click/type/fill/select/hover/drag actions obtain a fresh snapshot. Stale accessibility references are rejected; supported selectors are allowed, with visibility/uniqueness resolved by Playwright. Persisted browser sessions continue to use the existing per-owner profiles.
- Monte Carlo chat-credential consent, model switching, creating agent chats, scheduling through conversation, existing approvals and schedule result cards remain supported.

## Verification references

scripts/verify-harvey-reliability.mjs exercises real routes, runtime, provider adapters, SQLite, receipt checks and job/UI recovery against fixtures. verify-browser-persistence.mjs checks browser state across worker restarts. Work, credential-consent, account and team suites cover related contracts.

These checks do not measure live model reasoning accuracy, CRM extraction completeness or third-party editor success. No new build or live acceptance run was performed for the documentation cleanup.

## Remaining limits

- Receipts and service-scoped read-backs are not independent semantic proof. They cannot ensure that a read concerns the exact object changed. Source-value checks are available to the model, not mandatory validation of every final sentence. Task-specific schemas, pagination checks and representative live-app evaluations remain necessary.
- Plans are saved context, not an autonomous durable step executor. Jobs use the existing single-worker/tenant architecture, not distributed leases or exactly-once external effects. Interrupted writes are not replayed. A running tool may finish after cancellation; cancellation is cooperative at tool boundaries.
- The repeat guard is conservative: a legitimate identical browser action may be blocked. Unknown connector reads may require supported read-back tools. Ordinary acknowledgements and explanations need no tool receipt. Tool-backed actions and scheduled runs retain verification requirements.
- Response text arrives after review while tool progress is displayed. Reopening a completed chat restores its saved message history; completed job approvals are available in its job result and existing approval UI.
- Browser target checks reduce stale clicks but cannot eliminate page races or wrong-account mistakes. Persisted cookies do not prevent a service from expiring or revoking authentication; MFA and CAPTCHA still require handling.
- Full local-computer control is not added. That needs a paired local companion, explicit device scope, OS permissions, reconnect handling and secure credential storage. The current hosted browser remains the execution surface.
- No isolated code sandbox, automated backup/restore service, CRM-specific exhaustive extraction validator, newsletter validator or CapCut connector is implemented by these safeguards. Separate account/CRM/task recovery code exists; see team-access.md.

## References and design rationale

- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): separate task checkpoints from longer-term state; persistent backing is necessary across restarts.
- [Temporal activity execution](https://docs.temporal.io/activity-execution): separate execution from request lifetime and treat retries and uncertain external effects explicitly. This implementation is not a Temporal-equivalent durable workflow engine.
- [Playwright actionability](https://playwright.dev/docs/actionability) and [locators](https://playwright.dev/docs/locators): inspect current targets and verify outcomes instead of assuming a click succeeded.

For future changes, use a copied dataset and test account to evaluate representative multi-page CRM searches, expired sessions, ambiguous listings, calendar gaps and CapCut tasks. Measure false completion, unsupported facts, task success and intervention counts. Verify a backup restore before any future migration.

## Retrieval continuation and retained records

Interactive saved jobs seed request-scoped plans for counts, bulk retrieval, short numbered batches and login requests. Short resume/correction commands rebind the retained plan; legacy chats without a plan can seed one from prior authorized task history. Old turn-limit blockers can be cleared on an explicit follow-up, while actual service/authorization blockers remain. These bounded language checks are not a universal intent classifier.

Saved interactive execution keeps all tools available without a round ceiling or forced summary/checkpoint round. A successful current observation can yield the job automatically after a premature final answer. Verifying a single step does not finish an unfinished plan. Status/planning/stop requests cannot resume old plans. Unknown writes still require matching read-backs before continuation. Three unchanged continuation checkpoints stop with a no-progress reason; earlier repetitions tell the agent to change approach. There is no interactive task-duration or continuation-count cap. Individual calls retain hang timeouts, and repeated unusable model replies or eight tool rounds without a successful operation produce an explicit failure. The shared monthly provider allowance is unchanged. A 600-call local provider fixture covers 50 profiles in one request; it does not certify live model or Brivity behavior.

The fixed DOM-only browser_read_table probe returns rendered rows, IDs, bounded cells, truncation, scroll metrics and observed ARIA totals. Its offset is within current DOM rows, not server pagination. End-of-DOM never proves complete coverage. Oversized rows require a smaller observation rather than an unchanged-offset loop.

work_records projects JSON pointers from successful current receipts server-side; missing paths cannot become invented values. Collections are private to owner/chat and deduplicate stable source IDs across continuations and restarts. Save replaces a record, so all its fields must be included or sections stored in separate collections. Stored records are historical observations: current filters, exclusions, field meanings and full coverage still need verification. They are work product, not reusable memory or authorization.

Regression: verify-work-continuation.mjs, verify-harvey-onboarding.mjs and verify-harvey-reliability.mjs use isolated fixture stores and local services. Onboarding additionally exercises real Chromium pagination and source projection. The opt-in deployment check runs this same isolated fixture in the image, not a live customer CRM export.

Malformed responses during unfinished interactive work can checkpoint and resume automatically up to three times when there is no unobserved external action. Model markup is never executed as a tool call. Persistent failures remain visible rather than looping indefinitely; the same job budget applies. Transient model transport failures retry the same in-memory request up to three times, preserving tool results.

## Scrolling through retrieval workflows

Repeated browser failures trigger one runtime-managed, read-only recovery packet containing installed schemas and a current observation from the same selected computer. No navigation, login, browser switching or uncertain action is retried by that recovery. A missing pre-scroll observation is obtained automatically. Hosted rendered-table reads poll empty rows for up to one second; an empty result remains a coverage limitation, not proof of lazy loading or absent records.

Failed receipts retain redacted error messages and action metadata. Repeated failures report the underlying recorded error, and jobs classify it as a tool failure rather than a provider failure. Diagnostic-only follow-ups use saved error metadata directly, with no model inference about timing or lazy loading. Older failures without retained details remain explicitly undiagnosed. Tool arguments are not retained in diagnostics; these records do not establish a remote site's underlying cause.

The opt-in verify-mercury-browser-live.mjs uses the actual selected Mercury API with an isolated Chromium page, injected pre-execution validation failures and synthetic virtualized records through verified CSV export. It does not access customer records or prove a live Brivity task complete. Model-call/cost/time guards apply to this paid acceptance fixture only.

Hosted computer exposes browser_inspect_scroll_regions and browser_scroll. Fixed DOM operations discover rendered scrollable containers and return before/after positions without screenshot coordinates or model-authored code. Read fresh rows after each scroll. Repeated identical scroll gestures require a distinct successful observation; the write replay guard remains unchanged for submissions. Local Chrome retains its own ref-based scrolling schemas.

A bounded runtime recovery pass challenges unsupported manual-scroll/copy-paste handoffs and asks the model to try its actual tools. Actual authentication, disconnect and authorization barriers still stop work. This is a recovery attempt, not a guarantee that every site is automatable.

work_records export creates an owner/chat-scoped CSV from persisted source projections, reports missing fields, escapes spreadsheet formulas, verifies file contents and reuses identical exports. It neither certifies filters/coverage nor creates a Google Sheet. The model must reconcile the requested scope and use the requested destination; truncated observations cannot be saved as complete source values. verify-lead-export.mjs covers an initially empty lazy table, five virtualized batches, exclusions, duplicates/restart, exact CSV counts and authenticated download.
## Operational capability harness (2026-10-17)

The existing Work runtime now supplies a compact route map and a `capabilities` refresh tool: browser observation/action, visual inspection, managed/custom apps, saved records/files, continuation, reusable workflows and internal business tools. This is session availability, not authorization or proof a workflow works. Managed discovery failures remain unknown (not disconnected) and do not disable independent browser/file tools. `plugins` retries the service and returns its actual error.

`inspect_screen` captures only the selected computer through the existing runtime. Vision-capable main models receive pixels; text-only models receive auxiliary vision observations. `structured=true` requests an observer-produced `data` object for source-backed field projection, including for native-vision main models. It remains an interpretation requiring accuracy checks. Auxiliary usage goes through the existing provider ledger/shared allowance and contributes to the saved job totals and delegated budget. Identical image/question analyses are reused within a turn. Assisted coordinate actions require a fresh observation and still pass the browser's target/freshness checks; actions invalidate the assisted observation. Cancellation and existing account/computer boundaries remain. A vision interpretation does not establish factual completeness or grant access.

`task_plan.save` accepts an optional contract: scope, count, collection, fields, sections, exclusions and destination. Revisions preserve the current request's contract unless replaced. Completion refuses unfinished plans and, when count/collection are declared, reconciles saved unique records and required field presence. Section meaning, exclusions and actual destination contents still need source checks/read-back; the contract does not independently prove them. Explicit resume rebinds the existing plan, retains a historical blocker and requires reassessment rather than treating it as permanent. It does not bypass CAPTCHA/OAuth or replay writes. Stop/status requests remain non-executing.

`workflow.learn` retains a versioned chat-private procedure only after accepted current-task completion and safe execution receipts. It stores receipt metadata, never raw tool results. Steps must describe the reusable method, not transient browser refs. Current prerequisites must be checked every use. Existing taught workflows and pinned schedule revisions are retained.

Verification: `scripts/verify-harvey-capability-harness.mjs` runs isolated localhost-provider workflows at zero paid-provider spend. It covers assisted visual action/read-back, unsupported-capability recovery, plan follow-ups, count gates, instruction retention and diagnostics. The broader reliability suite retains its 600-action continuation and cancellation checks. These fixtures do not certify real Brivity/Google Sheets completion or model quality.

Opt-in deployed acceptance: `[harvey-harness-live]` runs `smoke-harvey-harness-live.mjs` with a real model and Chromium against three local canvas-only fixture records, excludes one source, saves two records and verifies CSV. The isolated test has a $0.03 aggregate model budget and timeout/action guards; these are test-only controls, not customer job limits. It keeps the actual shared allowance ledger and accesses no customer data. Its outcome must be reported separately from offline fixtures and Brivity completion.

Repeated browser actions are keyed by their latest observed origin/path as well as arguments. Reusing a Notes control on a different profile is permitted; same-page retries remain refused, query/hash changes do not reset the guard, and operations first attempted without a known page retain the conservative original guard. This distinguishes resources; it does not authorize new actions or replay unknown writes.

Visual observations carry an observed origin/path when available, so profile fields can be saved without asking the vision model to invent an invisible record ID. Query strings/fragments/credentials are omitted; use a visible stable ID if several records share one path. Unknown mutations invalidate the inherited page identity, requiring fresh inspection.


## Candidate hardening (2026-10-19; not deployed)

Completion now combines native source/revision checks with an optional independent semantic review. A reviewer approval cannot override missing native workbook-history coverage. That coverage compares complete read source history with reopened visible profiles matched by observed email or phone. Long-cell presence checks bind source bytes directly and return hashes/booleans. They do not prove unread rows, name-only matches, arbitrary field semantics, or every third-party workflow.

Simple resumptions retain the original user-message reference for completion and preservation rules. Profile identity must be re-observed after navigation. An unchanged missing-only field comparison can suppress a following observed Save/Update; pending edits remain submit-able. Current-page readers reject an unsupported URL argument. Unexpected execution exceptions retain sanitized diagnostics and observed receipts, rather than replacing their cause with a generic interruption.

Research informing these decisions:

- [Hermes persistent goals and quality gates](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals): persist scope and progress; run deterministic gates before model judgment. Its documentation also acknowledges imperfect judges and bounded recovery. Copy the useful pattern, not a claim of universal reliability.
- [Anthropic agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): grade actual environment outcomes as well as transcripts. Synthetic CRM tests inspect server-side notes/dates/relationships and POST counts; browser exports compare exact source cells and order.
- [Anthropic long-running harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps): carry structured progress across context boundaries and define concrete acceptance criteria.
- [Temporal durable execution](https://docs.temporal.io/tasks): persisted orchestration does not remove the need to make external effects safe to retry. Harvey retains its existing single-worker job/store architecture; no new orchestration platform is introduced. Unknown browser submissions still require inspection rather than blind replay.

Regression coverage includes source-bound long Unicode text, stale identity, ignored URL arguments, unchanged form submissions, pending edits, credential-consent adapters, exception redaction, persisted continuation, cancellation, and browser restart recovery. Local scripted providers test control flow; real Mercury/Luna acceptance results must be recorded separately. A passing fixture or model review is not proof that Wesley's actual Brivity import has run.
