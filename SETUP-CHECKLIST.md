# Configuration and integration boundaries

Reconciled with master on 2026-10-11. These are source/configuration requirements, not a report that production credentials are present or valid.

## Application configuration

- Node 20 and dependencies are installed by Docker. Docker also installs Chromium and FFmpeg.
- fly.toml enables ACCOUNT_ISOLATION, HARVEY_BROWSER_ENABLED and HARVEY_WORKER_ENABLED and mounts /data.
- Account workers receive only the allowlisted environment in src/core/tenantGateway.ts. A secret configured on the parent is not automatically available inside an account.
- Authentication uses the central identity/session stores. Under account isolation, an unscoped DASHBOARD_TOKEN does not grant access to personal business APIs.
- Back up the volume and identity/owner mappings before an authorized migration. Existing recovery markers prevent repeating one-time imports.

## Integration map

| Capability | Configuration/source |
| --- | --- |
| Harvey models | OPENROUTER_API_KEY or ANTHROPIC_API_KEY; src/hull/providers |
| Social DM generation | ANTHROPIC_API_KEY and optional ANTHROPIC_MODEL; src/integrations/llm |
| Managed apps | COMPOSIO_API_KEY, followed by each user's provider consent in Plugins |
| Saved logins/direct connector tokens | Stable HARVEY_VAULT_KEY; see docs/harvey-work.md |
| Hosted browser | HARVEY_BROWSER_ENABLED, installed Chromium; optional HARVEY_BROWSER_EXECUTABLE |
| Scheduled Harvey agents | HARVEY_WORKER_ENABLED; HARVEY_SCHEDULE_MODEL; per-schedule timezone/budget |
| Shared MLS | SIMPLYRETS_* configuration in src/integrations/simplyrets/index.ts; shared listings.db |
| Social inbound | ManyChat /webhook contract and Zernio signature/account configuration in src/integrations/zernio |
| SMTP sending / Gmail inbox | src/integrations/smtp and src/integrations/gmail; SMTP sending and OAuth inbox access are separate |
| SMS | Quo, Twilio and Sinch clients exist; credentials and account routing must match the intended transport |
| Brivity contacts | src/integrations/brivity.ts and core/brivityPeople.ts; not a native transaction sync |
| Transaction imports | CSV import and optional TRANSACTIONS_SHEET_URL |
| Voice | ElevenLabs STT with Deepgram fallback; TTS routing in src/hull/voice; VoxCPM is a separate service |
| Social analytics/research | Apify/Zernio clients and their configured accounts |
| Ads reporting | AD_DASHBOARD_BASE_URL and optional API key; no campaign-write implementation |

## Account isolation

The shared parent owns POST /webhook, OPTIONS /webhook and POST /api/zernio/webhook, plus authenticated shared automation consoles. Other legacy webhook/machine routes cannot choose a personal account merely by knowing a URL or token.

Worker credentials explicitly share model infrastructure, Composio and SimplyRETS. Existing owner-scoped Harvey connections persist. Root Gmail, Brivity, SMS, OpenClaw and browser-extension credentials are not automatically inherited. Adding an unrelated service secret to Fly alone is not sufficient to wire a personal account.

See [team access](docs/team-access.md) and [account routing](docs/account-isolation.md). Do not disable isolation as an implicit integration setup step.

## Configuration is not verification

Check the selected account, effective configuration and read-only service status before an authorized integration test. A code path or saved connection does not prove token validity, delivery, permissions or correct data.

Fly runtime secrets and GitHub Actions secrets are separate: GitHub secrets are not automatically injected into the running app. Do not put credential values in repository documentation.

The old Content Manager, Calendar, OpenShorts, OpusClip and CapCut setup instructions were removed with those features. Their former prerequisites are not requirements for the current app.
