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

On premature final answers or a reserved summary round, a successful current observation can yield the job automatically. Verifying a single step does not finish an unfinished plan. The checkpoint round permits browser observations when a read-back is missing, while rejecting clicks and other mutations server-side. Status/planning/stop requests cannot resume old plans. Unknown writes still require matching read-backs before continuation. Three unchanged continuation checkpoints stop with a no-progress reason; earlier repetitions tell the agent to change approach. Existing execution limits remain 24 hours and 256 continuations, and are reported separately from provider credit failures.

The fixed DOM-only browser_read_table probe returns rendered rows, IDs, bounded cells, truncation, scroll metrics and observed ARIA totals. Its offset is within current DOM rows, not server pagination. End-of-DOM never proves complete coverage. Oversized rows require a smaller observation rather than an unchanged-offset loop.

work_records projects JSON pointers from successful current receipts server-side; missing paths cannot become invented values. Collections are private to owner/chat and deduplicate stable source IDs across continuations and restarts. Save replaces a record, so all its fields must be included or sections stored in separate collections. Stored records are historical observations: current filters, exclusions, field meanings and full coverage still need verification. They are work product, not reusable memory or authorization.

Regression: verify-work-continuation.mjs, verify-harvey-onboarding.mjs and verify-harvey-reliability.mjs use isolated fixture stores and local services. Onboarding additionally exercises real Chromium pagination and source projection. The opt-in deployment check runs this same isolated fixture in the image, not a live customer CRM export.

Malformed responses during unfinished interactive work can checkpoint and resume automatically up to three times when there is no unobserved external action. Model markup is never executed as a tool call. Persistent failures remain visible rather than looping indefinitely; the same job budget applies. Transient model transport failures retry the same in-memory request up to three times, preserving tool results.

## Scrolling through retrieval workflows

Hosted computer exposes browser_inspect_scroll_regions and browser_scroll. Fixed DOM operations discover rendered scrollable containers and return before/after positions without screenshot coordinates or model-authored code. Read fresh rows after each scroll. Repeated identical scroll gestures require a distinct successful observation; the write replay guard remains unchanged for submissions. Local Chrome retains its own ref-based scrolling schemas.

A bounded runtime recovery pass challenges unsupported manual-scroll/copy-paste handoffs and asks the model to try its actual tools. Actual authentication, disconnect and authorization barriers still stop work. This is a recovery attempt, not a guarantee that every site is automatable.

work_records export creates an owner/chat-scoped CSV from persisted source projections, reports missing fields, escapes spreadsheet formulas, verifies file contents and reuses identical exports. It neither certifies filters/coverage nor creates a Google Sheet. The model must reconcile the requested scope and use the requested destination; truncated observations cannot be saved as complete source values. verify-lead-export.mjs covers an initially empty lazy table, five virtualized batches, exclusions, duplicates/restart, exact CSV counts and authenticated download.
