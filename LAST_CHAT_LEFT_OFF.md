# Last chat left off

**Purpose:** Handoff for a new Cursor chat. Read this first so you have context without re-scanning the whole repo or a full conversation history.

**Last updated:** June 26, 2026 (after ElevenLabs STT swap, batch-upload JSON fix, production outage triage + rollback).

> The most recent session is documented immediately below. Older reference material (CRM/Sendblue era) is preserved further down under "EARLIER CONTEXT" and is still broadly valid for repo structure.

---

# ===== MOST RECENT SESSION — June 25–26, 2026 =====

## Environment / how to work in this repo
- **Prod:** Fly app `marco-90-automation` → `https://marco-90-automation.fly.dev`. Region `dfw`, single machine `811701f9455e08`. Volume `vol_vly5ljmnzdeqmpm4` (3 GB) mounted at `/data`.
- **Stack:** Node/TypeScript/Express + **Python OpenShorts sidecar** (video clipping, port 8000, run via supervisord in Docker).
- **Dev shell is Windows PowerShell.** Gotchas learned this session:
  - `&&` command chaining does NOT work — run commands separately or use `;`.
  - `git commit -m "$(cat <<'EOF' …)"` heredoc does NOT work — write the message to a temp file and use `git commit -F <file>`.
  - `fly ssh console -C "..."` works but always prints a harmless trailing `Error: The handle is invalid.` on Windows — the command output above it is valid.
- **Build/verify:** `npm run build` (tsc) must pass before deploy. **Deploy:** `fly deploy -a marco-90-automation` (~8 min).
- **GitHub:** `Jojo42011/Marcos-90-automations`, branch `main`. NOTE: a second dev (`jah.patel4124@gmail.com`) also deploys this app — key rotations / secret changes may come from them.

## ⚠️ CURRENT PRODUCTION STATE (read this first)
- **App health:** `200`. Disk healthy at **42%** after cleanup (was 100% full).
- **WORKING:** All non-Claude departments — CRM leads, social, finance, transactions, reporting, email/SMS stores, etc. Data verified intact on the `/data` volume.
- **STILL BROKEN — needs the user:** The **DM agent + every Claude/Anthropic feature** are down because `ANTHROPIC_API_KEY` is **revoked** (`401 invalid x-api-key`). The key in BOTH local `.env` (line 12) and Fly is the *same dead key*. **A brand-new valid Anthropic key is required.** Once provided: `fly secrets set ANTHROPIC_API_KEY=... -a marco-90-automation` and update `.env` line 12.
- **Harvey voice STT:** Reverted to Deepgram (also a dead key) — see rollback note below. Voice STT won't work until resolved.

## What happened, in order

### 1. Harvey voice STT: Deepgram → ElevenLabs Scribe v2 Realtime
- Deepgram STT key returns `401`; user had no new Deepgram key but a valid ElevenLabs key (TTS already uses ElevenLabs).
- ElevenLabs now offers real-time STT: **Scribe v2 Realtime**, `wss://api.elevenlabs.io/v1/speech-to-text/realtime`, model `scribe_v2_realtime`, PCM 16 kHz, ~150 ms, VAD auto-commit, auth via `xi-api-key` header.
- Rewrote `src/hull/voice/deepgramProxy.ts` to proxy ElevenLabs while **keeping the same route** (`/api/jarvis/deepgram/listen`) and **same export** (`handleDeepgramUpgrade`). Proxy translates both directions: client PCM → Scribe `input_audio_chunk` (base64 JSON); Scribe `partial_transcript`/`committed_transcript` → Deepgram Flux-style `TurnInfo` frames the client already parses.
- Updated `src/server.ts` health/startup logs from `DEEPGRAM_API_KEY` → `ELEVENLABS_API_KEY`.
- Optional env (defaults fine): `ELEVENLABS_STT_MODEL` (`scribe_v2_realtime`), `ELEVENLABS_STT_SILENCE_SECS` (`1.0`).
- **Committed `6f603e4`, pushed, deployed.** (This commit also carried a prior delete-button + in-app clip-player feature in `contentDb.ts`/`social.html`.)

### 2. Batch-upload / status routes returned HTML 500 instead of JSON
- **Root cause:** no global Express error handler + no try/catch around DB calls in `batch-upload` and `batch/:id/status` → throws returned Express's default HTML page → frontend `await res.json()` crashed on `<!DOCTYPE`.
- Fixes in `src/server.ts`: added a **global error handler** (`app.use((err,req,res,next)=>…)`, registered last, before `httpServer`; returns JSON, special-cases `multer.MulterError`→400); wrapped both routes in try/catch returning JSON.
- Fixes in `public/social.html`: `startBatchProcessing()` + `cmFetch()` now check `content-type` and handle non-JSON gracefully.
- Already-satisfied items: upload dir auto-created via `resolveContentVideoUploadDir()`; content DB is a lazy singleton `getContentDb()`; no circular dependency (`batchProcessor`→`brain/index.ts`, brain doesn't import back).
- Built clean, deployed (Fly release v161). **⚠️ These changes were NOT committed — they were discarded during the rollback (step 4).**

### 3. Production outage triage ("DM agent and others are down")
- User asked to "reroll all changes." Checked **live logs first** and proved today's code was NOT the cause. Two infra problems:
  1. **`/data` volume 100% full** → `ENOSPC` → all SQLite/upload/log writes failing.
  2. **`ANTHROPIC_API_KEY` revoked** → `401 invalid x-api-key` → breaks DM agent + all Claude features.

### 4. Outage actions taken
- **Freed disk (safe):** `find /data/uploads -type f -delete` — deleted ONLY raw uploaded source videos (~587 MB). Volume 100%→42%. Did NOT touch any `.db`, `db.json`, JSON state files, or `/data/clips` (369 MB kept). Health back to 200, ENOSPC gone.
- **Anthropic key:** tested the `.env` key directly against `api.anthropic.com` → `401`. Confirmed `.env` and Fly hold the *same revoked key*. Git history shows the key string never changed → it was deactivated on Anthropic's side (revoked/rotated/billing). **Did not push the dead key. Still needs a new one.**
- **Rolled back this session's code** (user insisted, knowing the key stays dead):
  - `git checkout -- src/server.ts public/social.html dist/src/server.js` (dropped uncommitted batch fix)
  - `git revert --no-edit 6f603e4` → revert commit **`2030a42`** ("Revert Switch Harvey voice STT…"). This reverted ElevenLabs STT (back to dead Deepgram) AND the delete/clip-player feature.
  - **⚠️ The revert commit `2030a42` was NOT pushed, and NO redeploy ran after the revert.** Decide: push + deploy the revert, OR un-revert to restore ElevenLabs STT + delete/clip-player. (Recommendation given: rollback doesn't fix the outage and re-breaks voice + uploads.)

### 5. Data-source audit (read-only)
- **CRM Leads tab** path: `dashboard.html` → `GET /api/dashboard/data` → `getDashboardSnapshot()` (`src/core/db.ts:920`) → in-memory `leadsById` Map → persisted to **`/data/db.json`** (JSON, not SQLite); leads under the `leadsById` key. Path resolver: `DB_JSON_PATH` env → `/data/db.json` on Fly → `./data/local-dashboard-db.json` local.
- Verified against the **live mounted volume**: every department resolves to `/data` and every active file exists. `db.json` is 1.1 MB rewritten today — CRM leads survived the disk-full event (in-memory state flushed back once space freed).

## Department → storage map (all verified present on the live volume unless noted)
| Department | Module | File on `/data` | Type |
|---|---|---|---|
| CRM leads / conversations | `core/db.ts` | `db.json` | JSON |
| Lead scoring | `core/leadScoreStore.ts` | `leadscores.db` | SQLite |
| Transactions / deadlines | `core/transactionsStore.ts` | `transactions.db` | SQLite |
| Finance | `core/financeStore.ts` | `finance.db` | SQLite |
| Social | `core/socialStore.ts` | `social.db` | SQLite |
| Email | `core/emailStore.ts` | `email.db` | SQLite |
| SMS | `core/smsStore.ts` | `sms.db` | SQLite |
| CRM automation / notifications | `core/crmNotificationStore.ts` | `crm-automation.db` | SQLite |
| Reporting | `core/reportingStore.ts` | `reporting.db` | SQLite |
| Content manager | `core/contentDb.ts` | `content.db` | SQLite |
| Voice clone | `core/voiceCloneStore.ts` | `voice-clone.db` | SQLite |
| Harvey memory | `harvey/memory/store.ts` | `harvey-memory.db` | SQLite |
| Aethon/Hull memory | `hull/memory/store.ts` | `aethon-memory.db` | SQLite |
| Tasks | `core/tasks.ts` | `tasks.json` | JSON |
| Marco tasks | `core/marcoTasks.ts` | `marco-tasks.json` | JSON |
| Users | `core/users.ts` | `users.json` | JSON |
| Tag templates | `core/tagTemplates.ts` | `tag-templates.json` | JSON |
| Auto plans | `core/autoPlans.ts` | `auto-plans.json` | JSON |
| Deals | `core/deals.ts` | `deals.json` | JSON — ⏳ created on first deal |
| Dial session | `core/dialSession.ts` | `dial-session*.json` | JSON — ⏳ created on first dial |
| Harvey notes | `core/harveyNotes.ts` | `harvey-notes.json` | JSON — ⏳ created on first note |

**All stores use the same rule:** `existsSync("/data") ? "/data/<file>" : "./data/<file>"`. The volume is confirmed mounted (`/dev/vdc on /data type ext4`), so everything points at the same persistent disk. ⚠️ One real risk: paths resolve **once at module load** — if the volume ever fails to mount, every department silently falls back to ephemeral local `./data`.

## Recovery of deleted source videos (if asked)
- Only raw uploads in `/data/uploads` were deleted (not DBs, not clips). Options: (a) re-upload originals from the user's device (simplest), or (b) restore a Fly volume snapshot — daily auto-snapshots, 5-day retention; most recent ~23 h old at deletion time (`vs_5l9LmLQJROPsjzxyZmY0`). Anything uploaded after that snapshot is unrecoverable from Fly.

## Outstanding / next steps
1. **Get a new `ANTHROPIC_API_KEY`** (the #1 blocker for the DM agent). Check Anthropic console billing/credits. Then set on Fly + update `.env` line 12.
2. **Decide on revert `2030a42`:** push + deploy it, or un-revert to restore ElevenLabs STT + delete/clip-player feature.
3. **Recommended safeguards (proposed, not built):**
   - `GET /api/health/storage` endpoint — per-department resolved path / exists / size / record count.
   - Startup guard asserting `/data` is a mounted volume (not the ephemeral local fallback) in prod.
   - Auto-delete processed source videos after clipping + consider growing the 3 GB volume (it filling up is what caused the outage).

## Key files touched/relevant this session
- `src/hull/voice/deepgramProxy.ts` — STT proxy (currently Deepgram after revert; was ElevenLabs Scribe).
- `src/server.ts` — routes; `batch-upload` ~3706, `batch/:id/status` ~3765, `GET /api/dashboard/data` ~730, startup/listen ~7385.
- `src/core/db.ts` — CRM leads JSON store + `getDashboardSnapshot()` ~920.
- `src/core/contentDb.ts` — content manager SQLite.
- `src/agents/contentManager/batchProcessor.ts` — batch video pipeline.
- `services/openshorts/app_marco.py` — Python sidecar (earlier sessions fixed ffmpeg clip/thumbnail helpers).
- `public/social.html` — content manager UI (batch upload, review/publishing).
- `public/dashboard.html` — main CRM dashboard (Leads tab).

---

# ===== EARLIER CONTEXT (CRM / Sendblue era — still valid repo reference) =====

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
