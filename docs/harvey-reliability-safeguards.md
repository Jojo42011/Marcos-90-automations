# Harvey reliability safeguards — local review

Follow-on work: [bounded memory, taught workflows and coordinated agents](harvey-persistent-agents.md). The follow-on document has the latest combined validation counts.

Status: implemented and built locally on codex/harvey-reliability-safeguards. No commit, merge, push or deployment. Tests use disposable storage and local fixtures; no customer accounts or production volumes were modified.

## Implemented

- Tool evidence receipts record returned, failed or held outcomes. Completion checks reject missing evidence, failed results, unresolved limitations and truncated sources. Possible writes require a subsequent observation within the affected service. Later actions invalidate earlier verification.
- verify_source_values checks claimed values at exact JSON-pointer paths in current tool results. It can catch an invented address or number when invoked; it does not prove all records or pages were retrieved.
- Work responses are buffered until review. Unsupported completion claims receive a needs-verification result. Scheduled runs require accepted structured verification before receiving completed status.
- Canonical nested argument hashing and repeat guards prevent identical possible actions from executing twice in one turn. This also avoids blindly retrying ambiguous failures.
- Agent-maintained task plans and per-tool evidence checkpoints persist in the existing owner/chat-scoped SQLite store. Additive record types require no destructive migration.
- Interactive tasks run as persisted background jobs, separate from the browser HTTP connection. Request IDs deduplicate submissions. The UI reconnects to active jobs after refresh; explicit Stop requests cancellation. Queued tasks can start after restart; interrupted running tasks require inspection instead of automatic replay.
- Running or queued tasks prevent chat deletion and project/mode changes. Existing owner checks cover job status, cancellation and evidence endpoints. Job status omits the original prompt and fingerprint; progress records exclude tool arguments and raw responses.
- Browser click/type/fill/select/hover/drag actions obtain a fresh snapshot and reject target references absent from it. Persisted browser sessions continue to use the existing per-owner profiles.
- Monte Carlo chat-credential consent, model switching, creating agent chats, scheduling through conversation, existing approvals and schedule result cards remain supported.

## Validation performed

| Check | Result |
| --- | --- |
| TypeScript build | Passed |
| New reliability/HTTP acceptance plus actual Chrome chat refresh and cancellation | 25 checks passed |
| Existing Harvey Work regression | 60 checks passed |
| Credential consent across model paths | 13 checks passed |
| Account isolation and persistence regression, including shared DM/comment routing | 18 checks passed |
| Chat UI contract | 109 checks passed |
| Actual browser core UI | 18 checks passed |
| Browser worker restart and action guard | Both save/restore phases passed; same-owner session cookie retained, different owner signed out, stale target rejected, valid target clicked |

The endpoint suite uses the real routes, runtime, provider adapter, tool loop and SQLite, with a deterministic local model server. It creates an agent and schedule, validates read-backs, blocks duplicate actions, checks ownership, verifies store reopen and interrupted-job recovery, and rejects optimistic scheduled completion without evidence. Chrome opens the actual chat page, refreshes while a task is running, reconnects and cancels it. Browser persistence uses separate worker processes across restart.

These results establish local application behavior. They do not measure live model reasoning accuracy, Brivity extraction completeness, newsletter quality or CapCut editing success. The account routing regression uses fixtures; it is not a new live DM/comment delivery audit.

## Remaining limits

- Receipts and service-scoped read-backs are not independent semantic proof. They cannot ensure that a read concerns the exact object changed. Source-value checks are available to the model, not mandatory validation of every final sentence. Task-specific schemas, pagination checks and representative live-app evaluations remain necessary.
- Plans are saved context, not an autonomous durable step executor. Jobs use the existing single-worker/tenant architecture, not distributed leases or exactly-once external effects. Interrupted writes are not replayed. A running tool may finish after cancellation; cancellation is cooperative at tool boundaries.
- The repeat guard is conservative: a legitimate identical browser action may be blocked. Unknown connector reads may require supported read-back tools. Work-mode conversational requests can receive needs-verification when they provide no evidence.
- Response text arrives after review while tool progress is displayed. Reopening a completed chat restores its saved message history; completed job approvals are available in its job result and existing approval UI.
- Browser target checks reduce stale clicks but cannot eliminate page races or wrong-account mistakes. Persisted cookies do not prevent a service from expiring or revoking authentication; MFA and CAPTCHA still require handling.
- Full local-computer control is not added. That needs a paired local companion, explicit device scope, OS permissions, reconnect handling and secure credential storage. The current hosted browser remains the execution surface.
- No new isolated code sandbox, automated backup/restore service, CRM-specific exhaustive extraction, newsletter validator, CapCut connector or production data migration is included.

## References and design rationale

- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): separate task checkpoints from longer-term state; persistent backing is necessary across restarts.
- [Temporal activity execution](https://docs.temporal.io/activity-execution): separate execution from request lifetime and treat retries and uncertain external effects explicitly. This implementation is not a Temporal-equivalent durable workflow engine.
- [Playwright actionability](https://playwright.dev/docs/actionability) and [locators](https://playwright.dev/docs/locators): inspect current targets and verify outcomes instead of assuming a click succeeded.

Before release, use a copied dataset and test account to evaluate representative multi-page CRM searches, expired sessions, ambiguous listings, calendar gaps and CapCut tasks. Measure false completion, unsupported facts, task success and intervention counts. Verify a backup restore before any future migration.
