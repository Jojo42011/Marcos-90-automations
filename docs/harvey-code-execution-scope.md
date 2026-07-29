# Scope: code execution for Harvey

> **Status, 2026-07-29:** Phase **A is built and deployed with `HARVEY_EXEC_MODE=off`**
> (`src/core/codeExec.ts`, the `run_script` tool, `GET /api/harvey/exec-status`).
> Every guard below was adversarially tested — 30/30 on the runner, 11/11 on the
> tool boundary. **Phase B (the sandbox machine) is next and not started.**
> Until it lands, `local` mode is hardening, not isolation, and should only be
> switched on deliberately and temporarily.

The last real gap between Harvey and Claude Cowork. Everything else in spec 1.1
is built and working in production: a 40-step background job runner detached from
any HTTP request, workspace file create/read/edit, multi-tool chaining, and jobs
that run to completion without step-by-step prompting. Verified — the
`no-phone-buyers` job chained **13 tool calls**, swept all 228 Contacted buyers in
two source-split passes to beat a 200-record API cap, wrote a report, and created
a task, unattended.

What Harvey cannot do is **write a script and run it**. That is the whole gap.

## Why it matters, concretely

Harvey's tools are a fixed vocabulary. Anything outside it is impossible, no
matter how simple:

| Marco asks | Today | With execution |
|---|---|---|
| "Which of my 1,219 contacts share a phone number?" | No dedupe tool exists | 10 lines, seconds |
| "Chart closed volume by month" | No chart tool | Renders a PNG/SVG |
| "Cross-reference this MLS export against the tracker" | Only if a tool exists for that exact join | Reads both, joins, reports |
| "Reformat this CSV for Brivity's importer" | Can read and rewrite by hand, badly, and will truncate | Deterministic transform |
| "Sum the GCI column and check my math" | The model does arithmetic in its head | Computed, not guessed |

The last row is the real argument. **A model doing arithmetic on 200 rows in its
head will sometimes be wrong and always sound certain.** Code execution turns
"Harvey says $412k" into "Harvey computed $412k, and here is the script." For a
system that touches real commission numbers, that is a correctness change, not a
convenience.

## The options

### A — Node `child_process` in the existing container (2–3 days)

Harvey writes a `.js` file to the workspace, a new `run_script` tool spawns
`node` on it with a timeout, and stdout/stderr come back as the tool result.

- **Pros:** no new infrastructure, no new dependency (`node:child_process` is
  built in, so the fast overlay deploy path still works), runs in the same
  container that already holds the workspace.
- **Cons:** **it is not a sandbox.** A script gets the container's filesystem,
  its network, and its environment — which contains `ANTHROPIC_API_KEY`,
  `BRIVITY_API_KEY`, `TWILIO_AUTH_TOKEN`, the Fly deploy token, and the SQLite
  databases holding every client record. A model that writes a wrong path can
  delete `/data`. Mitigations exist (spawn with a scrubbed `env`, `cwd` set to
  the workspace, a wall-clock timeout, a memory cap, no shell) and they are
  worth doing, but they are hardening, not isolation. A determined or badly
  confused script still gets out.
- **Honest verdict:** the fastest thing that works, and the one I would not run
  against live client data without the mitigations above plus an allow-list on
  what the script may import.

### B — A separate Fly Machine as a disposable sandbox (1–1.5 weeks) — recommended

A second, tiny Fly app with **no secrets, no volume, and no network egress**.
Harvey posts the script and its inputs; the machine runs it, returns stdout plus
any produced files, and is destroyed. The main app keeps the credentials.

- **Pros:** real isolation. The worst case is a wasted machine. Secrets are
  absent rather than protected. Fly Machines start in ~300ms, so it is fast
  enough to feel synchronous inside a job step. Scales to Python (pandas,
  matplotlib for charts) without touching the main image.
- **Cons:** new infrastructure to deploy and monitor; input/output has to be
  shuttled explicitly, so a script cannot casually read the tracker — Harvey has
  to pass the data in, which is more work per task but also exactly the property
  that makes it safe. Costs a few dollars a month.
- **Why recommended:** this system handles real client PII, real ad spend and
  real SMS. Option A's failure mode is "a generated script had access to
  everything". That is not a risk worth 3 days of savings.

### C — A hosted sandbox API (e.g. E2B, Modal) (3–4 days)

Someone else's container-per-execution service.

- **Pros:** least code, mature isolation, Python/data-science stack out of the box.
- **Cons:** a new vendor, a new key, per-execution cost, and **client data leaves
  our infrastructure** to be executed on. That last point needs Marco's explicit
  sign-off, and for a single-tenant system it is a real ongoing dependency.

## Recommendation

**B**, with **A's plumbing built first** and pointed at the sandbox. The tool
surface is identical either way:

```
run_script(language: "node"|"python", code: string, inputs?: string[]) →
  { ok, stdout, stderr, exitCode, durationMs, files: [{path, bytes}] }
```

Build the tool, the job-step recording and the UI against a locally-spawned
runner behind an env flag (`HARVEY_EXEC_MODE=local|sandbox|off`, **defaulting to
`off`**), then swap the executor for the sandbox without touching Harvey's side.
Ship with `off` in production until the sandbox is live.

## What must be true before it goes anywhere near production

1. **Default off.** A capability this sharp is opt-in per environment, never on
   because it happened to deploy.
2. **Every execution is recorded** — script, inputs, stdout, exit code, duration
   — in the job steps, downloadable like any other artefact. If Harvey computes
   a commission number, the script that produced it is auditable forever. This
   is the same rule as the analytics roll-up: a number must be able to say where
   it came from.
3. **Hard timeout and output cap**, with the timeout reported as a timeout. A
   script killed at 30s must never be summarised as "no results found".
4. **No secrets in the execution environment**, ever, in any mode.
5. **Writes land in the workspace only**, through the existing `safePath`
   containment.
6. **It must refuse to send.** A script must not be a way around the guards on
   email and SMS. No network in the sandbox handles this by construction; in
   local mode it needs an explicit block.
7. **Failure is reported, not smoothed over.** A non-zero exit is a non-zero
   exit in the UI, not a paragraph explaining what the script would have found.

## Effort summary

| Path | Effort | Isolation | Prod-ready with live data |
|---|---|---|---|
| A — local spawn | 2–3 days | none (hardening only) | not without the allow-list |
| **B — Fly sandbox machine** | **1–1.5 weeks** | **real** | **yes** |
| C — hosted API | 3–4 days | real | only with sign-off on data leaving |

## Not in scope

Letting Harvey modify or deploy **this** codebase. That is a different and much
larger conversation, and nothing here moves toward it: the sandbox has no access
to the repo, the registry, or the Fly token.
