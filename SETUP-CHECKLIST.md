# Marco 90 — One-Stop Integration Checklist

Everything the system needs to run **fully live**, audited from the codebase
(every `process.env.*` read) + the production `/health` report. Status reflects
the live Fly app `marco-90-automation` as of 2026-07-21.

Legend: ✅ already configured & working · ❌ missing (feature waiting on it) ·
⚪ optional / nice-to-have · 🔧 not an API — just info from Marco

---

## 1. Already working — nothing needed
| What it powers | Service | Env vars |
|---|---|---|
| Harvey's brain, DM agent replies, content scoring, CRM AI | Anthropic Claude | `ANTHROPIC_API_KEY` ✅ |
| Harvey's ears (realtime STT) + voiceovers + voice clone platform | ElevenLabs | `ELEVENLABS_API_KEY` ✅ |
| Harvey's voice (TTS) | Google Gemini | `GEMINI_API_KEY` ✅ |
| Email inbox sync + sending (Email tab, CRM email) | Gmail OAuth | `GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` ✅ |
| Instagram DM agent (710 threads) | Meta Graph API | `INSTAGRAM_ACCESS_TOKEN`, `FACEBOOK_PAGE_*` ✅ |
| Clip pipeline (cutting, captions, scoring, reel analysis) | OpenShorts sidecar (own Fly app) | `OPENSHORTS_URL` ✅ (running) |
| Task-reminder push notifications | Web Push / VAPID | auto-generated ✅ |
| Dashboard auth | — | `DASHBOARD_TOKEN` ✅ |

## 2. Missing — the real unlock list (in priority order)

### ① Twilio — texting from the CRM (BIGGEST gap; /health confirms unconfigured)
Unlocks: sending real SMS from lead profiles/Message Center, SMS lead capture,
appointment/task SMS reminders, CRM → phone handoff.
- Marco creates an account at twilio.com → buys a local number (~$1.15/mo + ~$0.008/text)
- Needs **A2P 10DLC registration** (business texting compliance — Twilio walks through it; uses his brokerage EIN)
- Provide: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`

### ② Brivity API — his real leads/contacts/transactions into our CRM
Unlocks: the new CRM running on his true database instead of webhook-fed/mock data.
- In Brivity: Settings → API / Integrations (or ask Brivity support for an API key
  on his account — jamescarter.pugarealestate@gmail.com login)
- Provide: `BRIVITY_API_KEY` (+ `BRIVITY_BASE_URL` if not default)

### ③ ElevenLabs voice clone of Marco — one-time
Unlocks: TikTok voiceovers + (optionally) Harvey speaking in Marco's voice.
- Record ~30–60 min of clean solo audio (or reuse his best podcast/reel audio)
- One-time Professional Voice Clone on the existing ElevenLabs account → gives a `voice_id`
- Provide: `ELEVENLABS_VOICE_ID` (clone once, reuse forever — already designed this way)

### ④ upload-post.com — auto-publishing clips to TikTok/IG/FB
Unlocks: the Publishing step of the content pipeline actually posting.
- Sign up at upload-post.com, connect his TikTok/IG/FB accounts there
- Provide: `UPLOAD_POST_API_KEY`, `UPLOAD_POST_USER` (+ optional `UPLOAD_POST_FACEBOOK_PAGE_ID`)

### ⑤ Google Drive service account — raw-footage ingestion
Unlocks: Content Manager auto-pulling new recordings from a shared Drive folder.
- Google Cloud console → service account → JSON key; share the footage folder with it
- Provide: `GOOGLE_DRIVE_CREDENTIALS` (the JSON), `GOOGLE_DRIVE_FOLDER_ID`

### ⑥ Brave Search — Harvey's live web research
Unlocks: Harvey answering with fresh market/web data (free tier: 2k queries/mo).
- brave.com/search/api → free key
- Provide: `BRAVE_SEARCH_API_KEY`

### ⑦ OpenAI — semantic memory search (embeddings only)
Unlocks: Harvey's long-term memory recall ("what did we say about X?").
- platform.openai.com key (pennies/month — embeddings only, no chat)
- Provide: `OPENAI_API_KEY`

### ⑧ Pexels — B-roll in generated clips (lives on the OpenShorts sidecar app)
- pexels.com/api → free key → set `PEXELS_API_KEY` on the **openshorts** Fly app

### ⑨ Apify — TikTok competitor/trend research
Unlocks: Harvey's TikTok research reports. Free tier exists.
- apify.com → token → `APIFY_API_TOKEN`

## 3. Optional / alternates (only if wanted)
| Feature | Service | Vars |
|---|---|---|
| STT fallback if ElevenLabs hiccups | Deepgram (❌ per /health) | `DEEPGRAM_API_KEY` ⚪ |
| WhatsApp messaging | Sinch or OpenClaw gateway | `SINCH_*` / `OPENCLAW_GATEWAY_*` ⚪ |
| Alt clip generator | OpusClip | `OPUSCLIP_API_KEY` ⚪ |
| Caller safety lookups | Forewarn | `FOREWARN_API_KEY/URL` ⚪ |
| Ad-spend dashboard tile | (his ads platform) | `AD_DASHBOARD_BASE_URL/API_KEY` ⚪ |
| Local CapCut export bridge | dev-machine only | `CAPCUTAPI_URL` ⚪ |
| Extra TTS engine | VoxCPM sidecar | `VOXCPM_API_URL` ⚪ |

## 4. 🔧 Plain info from Marco (no accounts — 5 minutes)
- `MARCO_PHONE_NUMBER`, `HARVEY_OWNER_NUMBER` — his cell (SMS features + Harvey ownership)
- `CARLOS_PHONE_NUMBER` — for paired notifications
- `MARCO_EMAIL` / `GMAIL_FROM` — confirm sending address
- `TIKTOK_USERNAME` — @puga.realtor (research + publishing)
- `MONTHLY_GCI_GOAL`, `BROKERAGE_SPLIT_PCT` — powers Finance/Reporting goals & company dollar
- `VAPID_CONTACT` — an email for push-notification registration
- `PUBLIC_BASE_URL` — already the Fly URL; changes only with a custom domain

## How to set any of these
`flyctl secrets set NAME=value -a marco-90-automation` (or GitHub → repo →
Settings → Secrets if preferred) — the app picks them up on the next restart.
