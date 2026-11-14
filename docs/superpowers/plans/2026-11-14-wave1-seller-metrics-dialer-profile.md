# Wave 1 — Seller metrics, Dialer profile, buyer stages, IA cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans after the human approves the design. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Marco’s call asks that do **not** need new MLS/telephony vendors: seller dial→close metrics, richer Dialer session card, shortened buyer Tracker vocabulary, Overview %, hide Nurture, Dialer remove-from-list/groups.

**Architecture:** Extend Dialer contact projection + CSV columns; aggregate Dialer calls/sessions with Tracker seller stages into Overview; remap buyer Tracker display ladder; small CRM rail IA change.

**Tech Stack:** TypeScript (`src/dialer/*`, `src/core/pipelineOverview.ts`, `src/core/types.ts`, `trackerStore`), vanilla Dialer UI, CRM Overview JS in `crm-brivity.html` / any Astryx overview host on master.

**Spec:** `docs/superpowers/specs/2026-11-14-marco-call-command-center-design.md`

## Global Constraints

- Manual `tel:` only — never claim Quo connected a call from open-link alone.
- Account isolation: Dialer metrics respect actor/owner; Overview agent filter unchanged (Marco/Wesley).
- Forward-only Tracker bumps preserved.
- No production CRM wipe in this wave.
- Prefer extending existing verify scripts over new frameworks.
- Docs-only planning commits may use `[skip ci]` until implementation starts.

---

### Task 1: Seller dial metrics backend

**Files:**
- Modify: `src/core/pipelineOverview.ts` (or new `src/dialer/metrics.ts` imported by overview + dialer routes)
- Modify: `src/dialer/routes.ts` — optional `GET /metrics`
- Modify: `src/harvey/platformTools.ts` — expose in `get_pipeline_overview` if shape changes
- Test: `scripts/verify-pipeline-overview.mjs` and/or `scripts/verify-dialer-workspace.mjs`

**Interfaces:**
- Produces: `SellerDialMetrics { talkSeconds, numbersCalled, conversations, apptsSet, apptsShown, listed, underContract, sold, showRate }`
- Consumes: Dialer store calls/sessions; Tracker seller stages; existing agent filter helpers

- [ ] **Step 1:** Write failing verify that fixtures with known talk seconds + outcomes + tracker stages produce the expected metric object.
- [ ] **Step 2:** Run verify — fail.
- [ ] **Step 3:** Implement aggregation + attach to Overview sellers payload (and/or `/api/dialer/metrics`).
- [ ] **Step 4:** Pass verify; commit.

### Task 2: Overview UI — seller metrics + buyer %

**Files:**
- Modify: CRM Overview rendering (locate current funnel paint in `public/crm-brivity.html` or Astryx overview if migrated on master)
- Test: `scripts/verify-growth-ui.mjs` / pipeline overview UI string checks

- [ ] **Step 1:** Failing assert for talk-time display (`H:MM:SS` or `Xh Ym Zs`) and buyer step `%` from `rateFromPrev`.
- [ ] **Step 2:** Implement UI; keep no-% request only for people steps if Marco wanted no % on people — **spec says % on social top only**.
- [ ] **Step 3:** Pass + commit.

### Task 3: Dialer contact property fields + CSV + session card

**Files:**
- Modify: `src/dialer/store.ts` Contact type + import column map
- Modify: `src/dialer/sync.ts` — pass through known CRM/listing fields when available
- Modify: `public/dialer.js` / `public/dialer.css` — Mojo-style session detail
- Test: `scripts/verify-dialer-workspace.mjs`

- [ ] **Step 1:** Failing test: CSV with List Price, MLS ID, Subdivision, List Agent, Expired Date → contact GET returns fields.
- [ ] **Step 2:** Implement import + optional listing join by mlsNumber when unambiguous.
- [ ] **Step 3:** Session panel shows name, from-line, phone, email, address, expired badge, price, DOM, MLS, type, subdivision, agent, office, owner (empty if missing).
- [ ] **Step 4:** Pass + commit.

### Task 4: Dialer leave-list / Appointments group

**Files:**
- Modify: `src/dialer/routes.ts` / store membership helpers
- Modify: `public/dialer.js` — actions on contact/session
- Test: verify-dialer-workspace

- [ ] **Step 1:** Failing test: remove member from list; contact remains; system group `Appointments` add works.
- [ ] **Step 2:** Optional: on `appointment_set` outcome, remove from current list membership if `listId`/`queue` was mojo/due session source list.
- [ ] **Step 3:** Pass + commit.

### Task 5: Buyer Tracker stage vocabulary

**Files:**
- Modify: `src/core/types.ts` (`BUYER_STAGES` / `BuyerStage`)
- Modify: `src/core/trackerDialerBump.ts`, `trackerEngagement.ts`, `pipelineOverview.ts` mappings
- Modify: `public/tracker.html` (or Astryx tracker) stage columns/labels
- Test: tracker + dialer bump + pipeline overview verifies

- [ ] **Step 1:** Failing tests for new/visible stage order: not_contacted (unstaged), contacted, nurture, appointment_set, appointment_show, showing, under_contract, closed.
- [ ] **Step 2:** Map legacy stages; hide unused columns in UI.
- [ ] **Step 3:** Align phone-capture → create/unstaged **not_contacted** (per approved spec).
- [ ] **Step 4:** Pass + commit.

### Task 6: Hide Lead Nurture (+ soft IA note)

**Files:**
- Modify: `public/crm-brivity.html` — hide nurture rail button
- Modify: `scripts/verify-crm-command-center.mjs` — assert nurture rail absent/hidden
- Optional: shell link removal if any

- [ ] **Step 1:** Failing verify nurture not in rail.
- [ ] **Step 2:** Hide; keep view code for rollback window.
- [ ] **Step 3:** Update FORAI.md Recent changes; commit.

### Task 7: Docs + Harvey discovery

**Files:**
- Modify: `FORAI.md`
- Modify: dialer `/guide` + harvey jobs pin if new routes

- [ ] **Step 1:** Document Wave 1 behavior vs Wave 3 blockers.
- [ ] **Step 2:** Ensure Harvey guide mentions metrics + profile fields.
- [ ] **Step 3:** Final `npm run build` + full Wave 1 verify set; push PR.

---

## Deferred (do not implement in Wave 1)

- Expired MLS auto-ingest, triple-line dial, reverse prospect
- Full Finance/Reporting/TX merge UI
- Profile field preference editor
- Production data wipe

## Spec coverage checklist

| Spec § | Task |
| --- | --- |
| 3.1 Seller metrics | T1–T2 |
| 3.2 Profile card | T3 |
| 3.5 Groups | T4 |
| 3.3 Buyer stages | T5 |
| 3.4 Nurture hide | T6 |
| Docs / Harvey | T7 |
