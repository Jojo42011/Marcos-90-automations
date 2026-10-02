# Persistent learning and coordinated agents

Local implementation on `codex/harvey-reliability-safeguards`. Not committed,
merged or deployed. Production credentials, messages and volumes were not used.
This extends the local reliability changes documented in
[Harvey reliability safeguards](harvey-reliability-safeguards.md).

## Architecture

Harvey is a persistent application using replaceable reasoning models. Teaching
adds retrieved knowledge and procedures; it does not update model weights.
Agents wake for messages and scheduled work. SQLite, not an always-running model
conversation, retains their state while idle.

The existing owner/chat records table receives new kinds: `lesson`, `brief`,
`workflow` and `agent_team`. No tables are dropped, historical messages rewritten,
accounts merged, or existing records migrated. Existing business tools, browser
profiles, credential consent and model switching remain available.

### Bounded context and corrections

- Recent history supplied to the model is limited to 24 messages and 28,000
  characters. The current incoming request is separate and retains its existing
  50,000-character API limit. The existing provider context budget still applies
  to the full prompt, schemas and active tool chain. These are character/estimated
  token bounds, not an exact token-price guarantee.
- `history_search` accesses the retained archive in pages of five excerpts. Exact
  messages can be read in 2,000-character chunks. Omitted history is not deleted.
- `agent_memory` stores chat-private facts/corrections with exact user-message
  sequence references and quotes. Same-key corrections explicitly supersede the
  current revision; old revisions remain available in storage. Retirement also
  adds a revision instead of deleting records.
- Retrieval selects at most six active notes within a 3,200-character serialized
  budget. `continuity` provides a bounded agent-authored brief. Workflow discovery
  initially injects only up to eight names/IDs; full procedures load on demand.
- Plans injected automatically are shortened; their full records remain readable.
  Context diagnostics now reach the HTTP/job responses and usage tooltip.
- There is no additional summarizer model call per message. The active model can
  save useful notes as part of its normal tool loop. It is instructed to capture
  meaningful corrections, not save every utterance as a new fact.
- Compaction no longer tells models to repeat arbitrary tools to recover results.
  Unknown write outcomes require inspection; only known read-only calls may be
  repeated for missing detail.

Exact source quotes establish provenance, not semantic correctness. The model can
still summarize a quote incorrectly. Continuity briefs are explicitly fallible,
not fresh permissions. A credential-pattern check blocks common secret formats
in reusable notes, but is not a complete secret detector. Direct chat credentials
retain their existing authorized history/provider behavior; saved-login vaults
remain separate. Do not put passwords into reusable workflow instructions.

### Teach once, schedule a version

`workflow` stores prerequisites, steps, observable success checks and references
to teaching messages. Corrections create immutable revisions. Saving a workflow
does not claim that it has been executed successfully.

`schedule_agent` accepts `workflowId`. Each scheduled run receives that exact
revision. New revisions do not silently change existing schedules; an explicit
schedule update adopts them. Existing prompt-only schedules continue working.
Taught procedures run through the existing tool/evidence loop rather than a new
deterministic macro executor.

New schedules default to pausing after three consecutive failed/unverified runs;
the configurable threshold is 1–10. Explicit resume resets the counter. They also
pause immediately on recovery of a run interrupted by server restart, since an
external write may have completed. Existing schedules lacking this policy field
retain their old behavior. The schedule UI shows the reason for pausing. Existing
run results remain in the chat/schedule views; this is not a new push/SMS alert.

Scheduled and interactive jobs have cooperative 15-minute cancellation deadlines.
A tool already in progress may finish. The existing per-run model budget remains
in force; plugin charges, browser infrastructure and retries outside this app are
not covered by that model-dollar figure.

### Head agent and departments

`agent_team` lets an interactive chat act as a head for an explicitly configured
set of up to 20 member chats in the same owner/project. Existing project grouping
can represent a department. Configuration never changes account access.

The head dispatches a short brief as a persistent job and reads bounded status and
result reports. It does not receive all member transcripts. Dispatch uses request
IDs for deduplication, allows at most two child jobs per head turn, and sets a
$0.50 model budget per child. The existing job worker runs at most two jobs at a
time per process. There is no model polling loop while jobs are idle.

Delegated workers cannot recursively dispatch, create schedules/projects, change
durable lessons/workflows, or toggle Monte Carlo consent. Their messages are
marked delegated and cannot serve as human teaching sources. They retain their
own browser, history and existing connection/approval boundaries. A queued job is
not reported as a completed task. Member reports remain untrusted content.

## Validation

All tests use disposable databases and local fixtures, including the provider.

- `verify-harvey-learning.mjs`: 22 checks for long-history recall, bounded context,
  provenance, corrections, scope isolation, revision pinning, schedule failure
  handling, coordinator dispatch, restart recovery and an actual SQLite backup
  restored into a separate directory.
- `verify-harvey-reliability.mjs` with Chrome: 29 checks. The real HTTP routes,
  provider adapter and tool loop teach/save/schedule a procedure, enforce delegated
  restrictions, resume a running task after page refresh, cancel it, and display
  a paused schedule's explanation.
- Existing Work: 60 checks; credential consent: 13; account isolation/shared
  DM/comment routing and process-restart persistence: 18; chat UI contract: 109.
- TypeScript build and diff whitespace checks pass.

These are application contract tests, not evidence of real-model task accuracy or
live CRM/CapCut performance. Production data has not been restored or migrated.

## Remaining work before broader autonomy

1. Real-model evaluation of Carlos's actual workflows on copied/test accounts:
   account identity, complete pagination, correct values, output quality, cost and
   intervention rate. Provenance and generic read-back checks are not enough.
2. Voice/phone integration with a selected head chat. The existing voice interface
   remains intact; it is not wired to this new coordinator. No telephony provider,
   phone number or call permissions were provisioned.
3. Explicit sharing grants for departments spanning different human accounts.
   This change deliberately keeps existing account boundaries; it does not combine
   Marco/Wesley/Carlos histories or memories.
4. Distributed job leases, total department/day spend controls, richer capability
   health checks and supervised recovery of uncertain actions. Current workers
   retain the existing single-process/tenant architecture, not an exactly-once
   distributed workflow engine. No guarantee of infinite error-free execution.
5. Local desktop companion and live browser-editor validation. Hosted browser
   automation is not general control of the user's computer.
6. Backups/retention appropriate for production growth. Archive retrieval is
   bounded in model context, but the database itself continues to grow. The
   existing generic record-list queries also need indexing/pagination at scale.

## References

- [Anthropic: effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): incremental execution, durable handoff artifacts, explicit success checks.
- [Temporal: activity execution](https://docs.temporal.io/activity-execution): persisted execution and the distinction between retries and uncertain side effects. No Temporal dependency was added.
- [LangGraph: memory overview](https://docs.langchain.com/oss/javascript/concepts/memory): short-term task state versus longer-term, scoped memory. No LangGraph migration was performed.
