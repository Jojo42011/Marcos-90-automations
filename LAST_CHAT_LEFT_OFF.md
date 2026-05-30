# Last chat left off

**Purpose:** Handoff for a new Cursor chat. Read this first so you have context without re-scanning the whole repo or a full conversation history.

**Last updated:** May 2026 (after CRM Overview polish + consolidated source donuts deploy).

---

## What this repo is

Node/TypeScript **Express** app: ManyChat (and similar) POST to **`/webhook`** → **`src/app/pipeline.ts`** runs funnel + Anthropic Haiku for DM copy → JSON **`{ reply }`** back so ManyChat sends the message. File-backed lead store (`src/core/db.ts`), default path **`/data/db.json`** on Fly (volume mount).

**Prod:** Fly app **`marco-90-automation`** → **`https://marco-90-automation.fly.dev`**. `fly.toml` at repo root: region **dfw**, volume **`data`** → **`/data`**, **`AD_DASHBOARD_BASE_URL`** points at the separate Flask Meta ads app (**`marco-agents`**) for the ads proxy.

**Deploy:** `fly deploy` from repo root (static `public/` is copied into the image; TypeScript is built in Docker).

---

## Branch & git state

- **Active branch:** `cursor/instagram-dm-opener-fly-dashboard` (not necessarily merged to `main`).
- **Large uncommitted diff** on that branch: CRM dashboard (`public/dashboard.html`), Sendblue integration (`src/integrations/sendblue/`), server routes, types/db, LLM/prompts, `fly.toml`, `public/jarvis.html`, etc.
- **`LAST_CHAT_LEFT_OFF.md`** itself may be untracked until committed.

---

## What we built recently (CRM + ops)

### CRM workspace (`public/dashboard.html`)

Single-page CRM shell inside the hub’s **CRM** card. **Overview is the default tab** (sidebar order puts it first).

| Sidebar section | `data-crm-section` | What it does |
|-----------------|-------------------|--------------|
| Overview | `dashboard` | Pipeline-first dashboard (see below) |
| Leads | `leads` | Full table: intent, source, status, stage, call queue, phone, **Compose** (→ Text tab), follow-up |
| Calls | `calls` | **Urgent / important** vs **Regular follow-up** lists (dead leads excluded) |
| Text | `text` | Sendblue compose UI (lead picker or custom number) |
| Deals | `transactions` | Deal-oriented view |
| Reports | `reports` | Market / listing report generation UI |
| Follow-up plans | `plans` | Auto follow-up schedule per lead |
| Activity | `activity` | Recent activity feed |

Also: **Harvey** link → **`/jarvis`** (`public/jarvis.html`), token passed when `DASHBOARD_TOKEN` is in URL.

Legacy **`pipeline`** section name redirects to **`leads`**. Kanban CSS (`.crm-kanban`) remains in the file but **no Kanban tab** in the sidebar anymore.

### Overview tab (current design — v4)

**Top:** Two horizontal funnels (minimal, no % squares between steps — only `›` separators).

- **Buyer pipeline:** DM leads → Phone captured → Active text → Consult set → Showing → Under contract → Closed  
  Counts derived from `crmStatus`, `crmStage`, and phone-captured buyer cohort.
- **Seller pipeline:** Leads → Contacted → Appt set → Appt held → Signed → Pending → Closed  

Stage labels (`.crm-fnl-step .lbl`) are **larger and white** for readability. Pipeline header no longer has an empty stat box (removed when summary stats were dropped).

**Bottom row (3 columns):**

1. **Volume & GCI · $20M track** — closed/pending/production volume (est. from `criteria.priceCap` on closed/`under_contract` leads), est. GCI @ 3%, annual pace, goal ring vs **$20M**. Note in UI: **MLS will replace estimates** when connected.
2. **Lead sources** — **one card**, horizontally scrollable (`.crm-src-scroll`): four mini donuts in a row — **All leads**, **Buyers**, **Sellers**, **Buyer vs seller** (Instagram/TikTok/Mojo/Referral bucketing in `makeSmallDonut`).
3. **Today & overdue** — table of leads with follow-up urgency today/overdue (click row → lead drawer).

**Removed from Overview (user asked):**

- Inbound/outbound DM turn KPI strip  
- Percentage squares between funnel stages  
- **“Step conversion · pie view”** section (redundant; `transitionPiesRow` helper may still exist in JS but is **not rendered**)

### Call task queues

- **Field:** `crmCallQueue`: `"none" | "urgent" | "routine"`
- Set via Leads table dropdown, Calls section, or lead profile drawer (`#pf-callq`)
- **Calls** tab splits urgent vs routine; dead leads excluded
- CSV export includes **Call queue** column

### CRM data model (persisted on `Lead` in `/data/db.json`)

| Field | Values / notes |
|-------|----------------|
| `crmStatus` | `not_contacted`, `contacted`, `nurture`, `dead` |
| `crmStage` | `new`, `hot`, `warm`, `cold`, `appointment_set`, `showing_set`, `under_contract`, `closed` |
| `crmPriority` | `low`, `normal`, `high` |
| `crmIntent` | `buyer`, `seller` — drives funnels and seller styling |
| `crmCallQueue` | `none`, `urgent`, `routine` |
| `crmNotes` | string or null |

Defaults on new leads (pipeline): `not_contacted`, `new`, `normal`, `buyer`, `crmCallQueue: "none"`, notes null.

**API:** `PATCH /api/crm/lead/:id` — same auth as dashboard (`DASHBOARD_TOKEN` query or Bearer). Accepts all CRM fields above plus name, email, phone, source, property, brivityId, criteria.

**Dashboard data:** `GET /api/dashboard/data` — `leads` array is **phone-captured leads only**; totals still include full DB counts.

---

## Sendblue (partially done — main “what’s next”)

### Implemented

| Piece | Location |
|-------|----------|
| Outbound send helper | `src/integrations/sendblue/index.ts` — `sendSendblueMessage`, E.164 normalize |
| Inbound webhook | `POST /webhook/sendblue` — secret header `sb-signing-secret`, dedupe by `message_handle`, `findLeadByPhoneDigits`, runs **same pipeline** as ManyChat, auto-replies via Sendblue if configured |
| CRM manual send | `POST /api/sendblue/send` — auth `DASHBOARD_TOKEN`; body `{ leadId, content }` or `{ to, content }`; appends assistant message to thread when lead matches |
| CRM UI | Overview **Text** tab + **Compose** on Leads + drawer **Text** button |
| Health | `GET /health` → `sendblue.configured` |

### Env vars (Fly / `.env`)

- `SENDBLUE_API_KEY_ID`
- `SENDBLUE_API_SECRET_KEY`
- `SENDBLUE_FROM_NUMBER` (E.164)
- `SENDBLUE_WEBHOOK_SECRET` (optional; if set, inbound must match)

**Sendblue dashboard:** point inbound webhook to  
`https://marco-90-automation.fly.dev/webhook/sendblue`

### Sendblue — still to do / verify

User said they’re ready to **push more Sendblue work** after CRM Overview polish. Likely next items:

1. **Confirm plan** — outbound-first / AI agent rules with Sendblue (was discussed for a call; confirm before scaling automation).
2. **Production env** — ensure all `SENDBLUE_*` vars are set on Fly; smoke-test `/health`, CRM Text tab, inbound from a known lead phone.
3. **Unknown inbound numbers** — today webhook logs `unknown_lead` and does not create a lead; decide: auto-create lead, or VA workflow.
4. **Inbound user message persistence** — verify `handleIncomingPayload` appends **user** SMS to conversation history (not only outbound CRM sends).
5. **CRM polish** — thread view in CRM (read SMS history), “Text” status in lead drawer, link Sendblue delivery errors in UI.
6. **Optional:** Sinch vs Sendblue — both exist (`/sinch/inbound` + Sendblue); clarify which is primary for Marco handoff.

---

## DM / messaging logic (still relevant)

### Instagram + TikTok

- Flows separated in LLM + prompts.
- **Instagram price ask** → trained listing opener (4/4.5, half acre, west of Stone Oak, ~545k) when lead asks price/cost first.
- TikTok has its own manual/opener path (see commits on branch).

### Phone capture → “end of day” breakdown

- After phone: **by end of day**, not “sending now”.
- Urgency guard if they push ASAP: `src/app/conversationUtils.ts` → `signalsWantsBreakdownImmediately()`; hints in `src/integrations/llm/index.ts` + `config/prompts.ts` → `propertyBreakdown`.
- Deterministic fallback: `src/app/funnelDeterministic.ts` → `PHONE_JUST_CAPTURED_REPLY`.

### Ops debugging (ManyChat / IG)

- No `inbound_accepted` for a user line → **Marco never got HTTP** (upstream).
- “Unsupported message type” in ManyChat → non-text payloads; automation may not fire.
- `pipeline_unhandled_funnel_stage` → funnel gap if state lands outside branches (worth checking logs).

---

## Other planned / not done

| Item | Notes |
|------|--------|
| **MLS integration** | Real closed volume / GCI for $20M card; UI already says estimates use `criteria.priceCap` |
| **Simpler logging** | One `marco_turn` summary line; demote noise via `MARCO_LOG_LEVEL` (`src/app/marcoLog.ts`) |
| **Merge branch to main** | When CRM + Sendblue are stable |
| **Dead code cleanup** | `transitionPiesRow` in Overview JS; unused `.crm-kanban` if Kanban won’t return |

---

## Key files

| Area | Path |
|------|------|
| Server, webhooks, CRM/Sendblue APIs | `src/server.ts` |
| Webhook → pipeline | `src/app/webhook.ts` |
| Funnel + lead creation | `src/app/pipeline.ts` |
| DB + CRM fields + phone lookup | `src/core/db.ts` |
| Types | `src/core/types.ts` |
| Sendblue client + webhook helpers | `src/integrations/sendblue/index.ts` |
| Haiku + sanitizers | `src/integrations/llm/index.ts` |
| Prompts | `config/prompts.ts` |
| Hub + CRM UI | `public/dashboard.html` |
| Harvey UI | `public/jarvis.html` |
| Deterministic replies | `src/app/funnelDeterministic.ts` |
| Fly / Docker | `fly.toml`, `Dockerfile` |

---

## Env vars (non-exhaustive)

| Variable | Role |
|----------|------|
| `PORT` | Server port (default 3000) |
| `DASHBOARD_TOKEN` | Gates dashboard APIs + `/api/sendblue/send` |
| `AD_DASHBOARD_BASE_URL` | Flask ads base for `/api/ads/summary` |
| `AD_DASHBOARD_API_KEY` | Optional Bearer to Flask |
| `ANTHROPIC_API_KEY` | DM generation |
| `ANTHROPIC_MODEL` | Optional override |
| `MARCO_LOG_LEVEL` | `info` (default), `debug`, `off` |
| `DB_JSON_PATH` | Override DB file path |
| `SENDBLUE_*` | See Sendblue section |

---

## Commands

```bash
npm run build
npm start
# or
npm run dev:mock

fly deploy
```

**Live app:** https://marco-90-automation.fly.dev/

---

## Suggested next chat prompt

> Continue Sendblue: verify Fly env, test inbound/outbound with a real lead phone, persist inbound SMS on the conversation thread, and add CRM thread view. Then MLS placeholder → real sync when API is ready.

---

## Main README

See **`README.md`** for Marco’s product story and module list.
