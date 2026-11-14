# Marco call → Command Center completion — Design

**Status:** Draft for review (no implementation yet)  
**Date:** 2026-11-14 (America/Chicago)  
**Source:** Team call (Marco / Carlos / Grayson / Jahan) + Superpowers unfinished audit + current `master`  
**Baseline:** `master` includes Single Dialer smart queues (#95), Astryx People/profiles, SmartPoster refresh

## 0. Decomposition (this is not one PR)

The call spans **independent tracks**. Superpowers rule: one spec → one plan → one implementation cycle per track when possible. Below is a **wave plan** so we ship the maximum usable value without blocking on MLS expired access or Mojo triple-dial telephony.

| Wave | Track | External dependency? | Ships without ops? |
| --- | --- | --- | --- |
| **1** | Seller dial metrics + Overview seller funnel | No | Yes |
| **1** | Dialer Mojo-style session profile (from fields we have + CSV/import extras) | Partial (rich MLS fields need listing link) | Yes for core card |
| **1** | Buyer Tracker stage vocabulary → call’s short pipeline | No | Yes |
| **1** | Overview buyer social % conversion chips | No | Yes |
| **1** | Hide Lead Nurture rail; soft-merge Finance/Reporting/TX nav | No | Yes (IA only) |
| **1** | Dialer groups: remove from call queue without deleting CRM | No | Yes |
| **2** | Follow-up one-at-a-time dialer from Due today / smart filters | No | Yes |
| **2** | Intentional “Move to CRM/Tracker” from Dialer + stage sync | No | Yes |
| **2** | Per-user Dialer profile field prefs | No | Yes |
| **3** | Expired MLS ingest into Dialer | Yes — MLS provider / SimplyRETS expired | Blocked until source |
| **3** | Triple-line power dial | Yes — telephony beyond Quo `tel:` | Blocked |
| **3** | Reverse-prospect TikTok → legal name | Yes — Forewarn/TruePeopleSearch etc. | Blocked |
| **Ops** | Wesley Quo/onboarding; optional CRM wipe for clean buyer tracking | People/process | Not code-first |

**Recommended first implementation cycle after approval:** **Wave 1 only** (one branch/PR or a thin stack of 2 PRs if CRM IA is split). Wave 2 next. Wave 3 only after a sourcing/telephony decision.

---

## 1. Product outcomes Marco asked for

### Seller measurement (Dialer → Overview)
Show, for a chosen agent/window (default: this month / last 17–30 days, filterable):

1. **Talk time** — hours : minutes : seconds (from Dialer session `activeSeconds` + call durations where logged)
2. **Numbers called** — distinct phones / call attempts
3. **Conversations** — outcomes counted as talked (+ appointment_set)
4. **Appointments set**
5. **Appointments shown** (show rate = shown / set)
6. **Listed / signed** (listing agreement)
7. **Under contract**
8. **Sold / closed**

Buyer Overview funnel stays: Views → Comments → DMs → Numbers → Appt set → Appt show → Showing → U/C → Close, with **% between top social/DM steps** (Marco’s later ask).

### Dialer session contact card (Mojo-like)
While calling: name, from-line, phone, email, address/neighborhood, expired/canceled + expire date, list price, DOM, MLS ID, property type, subdivision, listing agent, brokerage, tax ID, MLS area, owner name — **preference toggles** later (Wave 2).

### Workflow rules
- Dialer list ≠ CRM dump of everyone dialed
- Groups / remove-from-queue so booked leads leave expired call list but stay in CRM
- Buyer Tracker stages shortened (see §3)
- Lead Nurture tab gone; Finance + Reporting + Transactions combined over time
- Keep finishing Command Center (not drop for AVAX)

---

## 2. Approach options

### Approach A — Wave-sliced on existing Dialer + Tracker + Overview (recommended)
Extend `shared-dialer.db` contact/listing projection, Overview `pipelineOverview`, Tracker stage enums/UI. No new vendor until Wave 3.

- **Pros:** Ships measurement + UX Marco needs for seller usage now; fits Single Dialer already on master  
- **Cons:** Expired inventory still CSV/Mojo-tagged until MLS unlock

### Approach B — Big-bang Mojo clone (Dialer + power dial + MLS + enrichment)
- **Pros:** Matches end vision  
- **Cons:** Blocked on APIs; months of risk; violates “use Dialer to get data”

### Approach C — Docs/ops only until MLS answers email
- **Pros:** Zero code risk  
- **Cons:** Marco can’t replace Mojo metrics; team stays on Mojo

**Recommendation:** Approach A, Wave 1 → 2 → 3.

---

## 3. Wave 1 design (implement after approval)

### 3.1 Seller dial metrics API + Overview UI

**Data (already mostly present):**
- Dialer: `session.activeSeconds`, `call` rows with `outcome`, `startedAt`/`endedAt`, `actorId`
- Tracker seller stages: `listing_appointment_set`, `appointment_held`, `listing_agreement_signed`, `active_on_mls`, `under_contract`, `closed`, etc. (`src/core/types.ts` `SELLER_STAGES`)
- Overview today: seller **Call → Contacted → Appointment → Listed → U/C → Closed** (`pipelineOverview.ts` `SELLER_BUCKETS`) — collapse/rename labels to match Marco’s chain and **prepend talk-time + dial/conversation counts**

**Add:**
- `GET /api/crm/pipeline-overview` (or sibling `GET /api/dialer/metrics?from=&to=&actorId=`) returns seller block:

```ts
{
  talkSeconds: number,      // display as H:MM:SS
  numbersCalled: number,    // distinct phoneKey or call attempts — pick one and document
  conversations: number,    // talked + appointment_set
  apptsSet: number,
  apptsShown: number,       // appointment_held (+ further)
  listed: number,           // listing_agreement_signed / active_on_mls bucket
  underContract: number,
  sold: number,             // closed
  showRate: number | null   // shown/set
}
```

**Counting rules (lock in plan):**
- Talk time = sum of Dialer session `activeSeconds` in window for actor (not wall-clock of open tabs)
- Numbers called = count of finished Dialer `call` rows with outcome ≠ `interrupted` (document; prefer attempts over distinct if Mojo-like)
- Conversations = outcomes in `{talked, appointment_set}`
- Funnel people steps remain Tracker cumulative (forward-only), filtered by agent like today
- Manual `tel:` honesty unchanged — never invent “connected” from dial click alone

**UI:** Overview seller card shows talk time + the conversion steps; buyer card adds `%` under Views→Comments→DMs→Numbers (rateFromPrev already exists in API — surface it).

**Tests:** extend `verify-pipeline-overview` / dialer workspace with fixture calls + tracker stages → metric assertions.

### 3.2 Dialer session profile card

**Enrich Dialer `Contact` (and sync) with optional property bag:**

| Field | Source priority |
| --- | --- |
| name, phone, email, address, source, tags | Existing CRM sync |
| from-line | Session `lineId` + Quo numbers |
| expired / canceled | Tags/source (existing Mojo queue) |
| expireDate, listPrice, daysOnMarket, mlsId, propertyType, subdivision, listAgent, listOffice, taxId, mlsArea, ownerName | New optional fields on contact OR join to `listings.db` by mlsNumber/address when known |
| neighborhood | subdivision / city |

**CSV import:** accept Mojo-export-like column headers for these fields so Marco can feed Dialer before MLS expired works.

**UI:** Replace thin session contact panel with a Mojo-style detail pane (scrollable facts). Missing fields show empty, never fake.

**Tests:** import CSV with MLS columns → contact detail GET returns them; session panel markup hooks in verify.

### 3.3 Buyer Tracker stages (call vocabulary)

Marco/Carlos agreed Tracker buyer flow:

`not_contacted` → `contacted` → `nurture` → `appointment_set` → `appointment_show` → `showing` → `under_contract` → `closed`

**Today:** long `BUYER_STAGES` (qualified, pre_approved, buyer_rep_signed, …).

**Design:**
- Introduce **Overview/Tracker display ladder** mapped from existing keys (minimize data migration pain):
  - not_contacted = unstaged / no buyerStage
  - contacted = `contacted` (ensure key exists or map from engagement)
  - nurture = map from `qualified` or add `nurture` key
  - appointment_set = `buyer_rep_signed` (current Overview mapping) **or** new key
  - appointment_show = CRM `met_with` / new key
  - showing = `actively_showing`
  - under_contract / closed = existing

**Prefer:** add missing keys (`not_contacted` as absence, `nurture`, `appointment_set`, `appointment_show`) and **hide** unused long stages in Tracker UI + Overview deep-links; keep old keys readable for legacy rows (forward-only bumps still work).

**Inbound DM:** when phone captured, land Tracker buyer at **not_contacted** (unstaged) not jumped to contacted — align `trackerEngagement` with call (today auto-bumps Unstaged→Contacted on engagement; confirm with product: call said first slot is not contacted when number arrives from DM).

**Decision to confirm on review:** On first DM phone capture, should Tracker create as **not_contacted** (unstaged) and only move to **contacted** after a human/Dialer outcome? Spec assumes **yes**.

### 3.4 CRM IA cleanup (soft)

- Hide `data-view="nurture"` rail button (keep route for 2 weeks if needed; no new work)
- Rail: keep Transactions; nest Reporting + Finance under one “Business” view **or** single iframe host with tabs — **minimal Wave 1:** hide Nurture only; add “Business” stub that iframes reporting with finance subtab **if** low risk — else Wave 2
- **Wave 1 minimum:** hide Nurture + stop linking `/lead-nurture` from shell if present

### 3.5 Dialer groups / leave call list

- Existing Dialer **groups** + list membership already exist
- Add action: **“Remove from this queue/list”** (membership delete) without archiving CRM contact
- Add action: **“Move to group: Appointments”** (create system group if missing)
- Outcome `appointment_set` optionally auto-removes from active Mojo/due session queue going forward (membership), does **not** delete contact

---

## 4. Wave 2 design (next cycle)

1. **Follow-up dialer:** Start session from smart queue `due` already exists; add CRM Smart Filter → Dialer handoff (`?queue=due` + filter id) and Brivity-like next/notes UX polish on session panel  
2. **Move to CRM/Tracker** explicit button with side + stage  
3. **Profile field prefs** in account preferences (show/hide Mojo fields)  
4. Harder Finance/Reporting/TX merge (one Astryx or CRM view)

---

## 5. Wave 3 / blocked (document only until unblocked)

| Item | Blocker | Interim |
| --- | --- | --- |
| Expired MLS auto-ingest | SimplyRETS/SABOR expired status + possibly reverse-prospect phones | CSV/Mojo tag import into Dialer |
| Triple-line dial | Quo has no multi-line dial API | Keep manual `tel:`; research Mojo behavior in a short design note later |
| Reverse-prospect username→name | No Forewarn API; TruePeopleSearch scrape not acceptable without vendor | Manual Carlos / optional later paid API |

---

## 6. Out of scope for Wave 1

- Power dial / buying numbers in-app  
- Wiping production CRM data (ops runbook, not this PR)  
- Wesley account provisioning (ops)  
- SmartPoster / Analytics redesign  
- Harvey Lessons/OpenClaw  
- Message Center Quo vs Twilio scheduled SMS (still backlog, not this wave unless trivial)

---

## 7. Verification strategy

- `npm run build`
- `node scripts/verify-dialer-workspace.mjs` (extend)
- `node scripts/verify-pipeline-overview.mjs` / growth UI if Overview DOM changes
- Tracker stage verify / dialer bump regression
- `verify-crm-command-center.mjs` for Nurture hidden
- No live calls/MLS mutations in CI

---

## 8. Success criteria (Wave 1)

Marco can open Overview and see **seller talk time + conversion chain**, open Dialer session and see a **richer property/contact card** (from CRM + imported MLS columns), use **groups to pull booked leads off the dial list**, see **buyer Tracker stages** matching the short call vocabulary, and **no Lead Nurture tab**. Expired auto-feed and triple dial remain explicit follow-ups.

---

## Review asks

1. Approve Wave 1 scope as above?  
2. Confirm phone-capture → Tracker starts at **not_contacted** (not auto-contacted)?  
3. Prefer **one PR for all Wave 1** or split **metrics/Overview** vs **Dialer profile/groups**?
