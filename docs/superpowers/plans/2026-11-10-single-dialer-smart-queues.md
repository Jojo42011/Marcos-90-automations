# Single Dialer Smart Queues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move CRM Dialer queues into shell Dialer as server-side smart queues with better UX, then delete the in-CRM Dialer completely.

**Architecture:** Enrich Dialer contact sync with CRM status/tags/call-queue fields; add queue matchers + API; allow sessions from `queueId`; upgrade Dialer UI; strip CRM Dialer surface and retarget verifies/docs.

**Tech Stack:** TypeScript Express (`src/dialer/*`), vanilla `public/dialer.*`, CRM `public/crm-brivity.html`, Node verify scripts under `scripts/`.

## Global Constraints

- Manual `tel:` only — never claim automatic dialing.
- Account isolation: workers sync only their CRM into shared dialer; private chats stay isolated.
- Preserve Tracker forward-only bumps via existing outbox outcomes.
- New Command Center surface must remain discoverable via dialer guide / Harvey routes.
- Verify with `npm run build` then `node scripts/verify-dialer-workspace.mjs` and updated CRM command-center checks.

---

### Task 1: Contact enrichment + queue matchers

**Files:**
- Modify: `src/dialer/store.ts` (Contact type + export helpers)
- Modify: `src/dialer/sync.ts` (project tags/crmStatus/crmCallQueue)
- Create: `src/dialer/queues.ts` (pure matchers + queue catalog)
- Test: extend `scripts/verify-dialer-workspace.mjs`

**Interfaces:**
- Produces: `statusDisp(crmStatus)`, `isMojoExpired(c)`, `matchesQueue(c, id)`, `QUEUE_DEFS`, enriched Contact fields

- [ ] **Step 1:** Add failing verify asserts that synced CRM leads expose `crmStatus`/`tags`/`crmCallQueue` and that `due`/`mojo`/`new`/`nurture` queues count correctly.
- [ ] **Step 2:** Run verify — expect fail (fields/queues missing).
- [ ] **Step 3:** Implement enrichment + `queues.ts` + minimal route stub if needed for assert.
- [ ] **Step 4:** Verify passes for enrichment/matchers.
- [ ] **Step 5:** Commit.

### Task 2: Queue API + sessions from queueId + add contact

**Files:**
- Modify: `src/dialer/store.ts` (`start` accepts queueId; `createContact`)
- Modify: `src/dialer/routes.ts` (`GET /queues`, contacts `?queue=`, sessions `queueId`, `POST /contacts`)
- Test: `scripts/verify-dialer-workspace.mjs`

- [ ] **Step 1:** Failing tests for `/queues`, session with `queueId`, `POST /contacts`.
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement routes/store.
- [ ] **Step 4:** Pass verify.
- [ ] **Step 5:** Commit.

### Task 3: Dialer UI — Queues nav + session start + add contact

**Files:**
- Modify: `public/dialer.html`, `public/dialer.js`, `public/dialer.css`
- Test: string/fixture checks in verify-dialer-workspace for queue UI hooks

- [ ] **Step 1:** Assert Dialer page exposes Queues nav / `data-queue` / start-from-queue hooks.
- [ ] **Step 2:** Fail then implement UI (counts, empty states, start session with queueId, add contact dialog).
- [ ] **Step 3:** Pass + commit.

### Task 4: Remove CRM Dialer + redirects + CRM verify update

**Files:**
- Modify: `public/crm-brivity.html`
- Delete or stop linking: `public/growth-dialer.css` if Dialer-only
- Modify: `scripts/verify-crm-command-center.mjs`
- Modify: `FORAI.md`

- [ ] **Step 1:** Update CRM verify to assert no `#view-followup` / no Dialer rail; followup navigates to dialer.
- [ ] **Step 2:** Fail, then strip CRM Dialer + wire redirect.
- [ ] **Step 3:** Run CRM + dialer verifies + build.
- [ ] **Step 4:** Commit + push.
