# Harvey projects, plugins, browser and scheduled agents

Deployed on Fly. Hosted browser has passed real navigation and model-driven reading tests. Recurring worker activation and real account workflows still require acceptance testing.

Managed plugins now use Composio: configure COMPOSIO_API_KEY on the server, then connect supported apps from Plugins. Composio handles OAuth credentials and refresh; the legacy provider-client setup below is optional for direct connectors. Connections are scoped by signed-in user and selected project. Real provider sign-in/consent is still required.

## User flow

1. Create a project, give it shared instructions and a timezone.
2. Open separate chats for the agents in that project. Each chat has persistent history and its own browser profile. Chat mode is conversational; Work mode can act. Its business-tool bridge retains the existing CRM capabilities and approval rules.
3. Open Plugins and connect the services the project needs. Connections can belong to a project or all of that user's projects. Enable actions explicitly for connections that may send or modify data.
4. In Work chat, describe the job and timing. Harvey calls `schedule_agent`, which persists the prompt, five-field cron, timezone, next run and model-spend ceiling. The task appears under Scheduled agents; it can be edited, paused, resumed, run now or removed.
5. Results appear in the originating chat and in run history. A browser/API error, missing model or budget failure must not be reported as a successful run.

Plugins catalog: Google Drive, Gmail, Google Calendar, Google Sheets, OneDrive, Outlook Mail, Outlook Calendar, GitHub, Slack and Notion. These are real OAuth adapters and JSON REST transports, **not preconnected accounts**. Missing server credentials show “App setup required.” Custom connectors accept an HTTPS Streamable HTTP MCP endpoint and optional bearer token; tools are discovered live. Custom MCP interactive OAuth and legacy SSE-only transport are not implemented.

## Browser choice and research

Selected [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp), Apache 2.0. Its accessibility tools fit the existing OpenRouter tool loop, and persistent profiles retain sessions. Harvey runs its installed, pinned local package, not a paid hosted browser API. Compared with [Browser Use](https://github.com/browser-use/browser-use) and [Stagehand](https://github.com/browserbase/stagehand), this avoids introducing another LLM orchestration layer. Open-source licensing does not cover hosting or model costs.

Interaction inspiration: [ChatGPT projects](https://learn.chatgpt.com/docs/projects), [Chat/Work](https://learn.chatgpt.com/docs/web), [scheduled tasks](https://learn.chatgpt.com/docs/automations), and [plugins](https://learn.chatgpt.com/docs/plugins). These describe product patterns, not a public copy of ChatGPT's private scheduler or execution infrastructure.

OAuth implementation references: [Google offline access](https://developers.google.com/identity/protocols/oauth2/web-server), [Microsoft Graph delegated access](https://learn.microsoft.com/en-us/graph/auth-v2-user), [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [Notion authorization](https://developers.notion.com/guides/get-started/authorization), and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

## Server setup before live use

Use a full image build: this adds npm dependencies and Chromium. The old source-only overlay deploy cannot install them.

- `HARVEY_WORK_DIR`: durable directory, defaults to `/data/harvey-work` on Linux with a data volume, otherwise `data/harvey-work`.
- `HARVEY_PUBLIC_URL`: canonical HTTPS app URL, used for OAuth callbacks.
- `HARVEY_VAULT_KEY`: a stable 32-byte AES key encoded as 64 hex characters. Generate it once with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; keep it in deployment secrets and back it up. Rotating or losing it without migration makes stored credentials unreadable.
- `HARVEY_BROWSER_ENABLED=true`: enable the browser after Chromium is installed. Dockerfile installs it. Local development can use `npx playwright install chromium`. `PLAYWRIGHT_BROWSERS_PATH` or `HARVEY_BROWSER_EXECUTABLE` can select a local installation.
- `HARVEY_BROWSER_MAX_SESSIONS`: default 3. Idle browser workers close after ten minutes; saved profiles remain.
- `HARVEY_WORKER_ENABLED=true`: starts the recurring worker at 30-second intervals. Keep off until ready for real external actions.
- Existing `OPENROUTER_API_KEY` (or Anthropic fallback) and global spend caps still apply. Tasks default to a $1 model budget per run; this is a preflight/recorded-usage ceiling, not a guarantee against provider billing adjustments or external-service charges.
- FFmpeg is already installed by the Dockerfile. `FFMPEG_PATH` can override the executable for local testing.

Register one OAuth application per provider family and configure:

| Services | Environment variables |
| --- | --- |
| Drive, Gmail, Google Calendar, Sheets | `HARVEY_GOOGLE_CLIENT_ID`, `HARVEY_GOOGLE_CLIENT_SECRET` |
| OneDrive, Outlook Mail/Calendar | `HARVEY_MICROSOFT_CLIENT_ID`, `HARVEY_MICROSOFT_CLIENT_SECRET` |
| GitHub | `HARVEY_GITHUB_CLIENT_ID`, `HARVEY_GITHUB_CLIENT_SECRET` |
| Slack | `HARVEY_SLACK_CLIENT_ID`, `HARVEY_SLACK_CLIENT_SECRET` |
| Notion | `HARVEY_NOTION_CLIENT_ID`, `HARVEY_NOTION_CLIENT_SECRET` |

All use `https://YOUR-APP/api/harvey/work/oauth/callback`. Enable each provider's APIs and configure its consent screen/scopes. Some providers require app review, workspace approval or test-user registration. Once the application is configured, each user connects through the UI. Tokens are encrypted in the work database and refresh automatically when the provider supplies a refresh token. Disconnect removes Harvey's stored token; provider-side revocation remains in that provider's account settings.

## Execution and persistence

`src/harvey/work/` contains the SQLite store, connector transports, browser worker, files/video actions, agent runtime and Express router. `public/harvey-work.js` extends the existing vanilla-JS interface. The new UI passes `workspace:true` to `/api/harvey/chat`; the existing voice and legacy machine clients retain their previous path. Voice dictation works in the composer; the separate voice overlay has not yet been migrated to project-scoped Work tools.

Records and messages are scoped by the signed-in user. Machine-token/explicitly unlocked local access uses the shared `operator` owner. Browser directories are hashed by owner and chat. Passwords must be added through Save login, not chat; the model sees login IDs and URLs, and a server-side fill inserts credentials only on the saved origin. This first version supports a two-field username/password page. Multi-stage identity-provider sign-in, MFA, CAPTCHA and renewed consent can require human help. Cookie persistence cannot prevent sites from expiring sessions.

The worker supports **one application process on one durable volume**. Claiming a scheduled run and advancing its next due time are transactional. Only one run can own a chat at a time. After downtime, a missed task runs once, not once per missed interval. At boot, interrupted runs become `needs_attention`; they are not blindly retried because an external write may already have happened. This is not an exactly-once guarantee for third-party actions. Scaling to multiple Fly machines requires a coordinated queue/lease service and per-worker browser volumes.

The browser is an isolated profile and process, not a complete isolated virtual desktop. On root Linux containers the fixed browser entrypoint drops to uid/gid 1001; it inherits only the minimal browser environment. Actual Fly/browser sandbox compatibility still needs staging validation. Arbitrary JavaScript execution and filesystem-wide uploads are not exposed to the model. An interactive desktop/takeover viewer is follow-up work.

## Files and video

The composer can upload a file or video (250 MB limit) to the current chat. `workspace_files` lists its files. `edit_video` trims/transcodes to MP4 and can mute audio; it has a ten-minute timeout and uses fixed FFmpeg arguments. Results can be downloaded in Browser > Chat files or uploaded through a compatible website using Playwright's file-upload tool. Full timeline editing, arbitrary effects, large resumable uploads and editor-specific workflows are not implemented.

## Verification

`npm run build` compiles the server. `node scripts/verify-harvey-work.mjs` checks owner isolation, durable history, vault encryption, schedule validation and DST, overlap protection, restart behavior, connection permissions, OAuth state/PKCE, actual OpenRouter-shaped fixture tool execution and HTTP routes. The test uses temporary data and a local model fixture. Local browser UI verification also covered project creation, scheduling through a Work chat, manual runs with saved results, and actual Chromium navigation. Closing and reopening the browser restored the fixture site's persistent session cookie. Existing Harvey/CRM verification scripts remain regression checks. Live OAuth provider accounts, production Fly execution and real site-specific workflows must be tested after configuration.


Connected Composio apps are shared across the signed-in user’s chats and projects. Chat and Work both expose discovery, read/write actions and the hosted browser; authorization still comes from the user’s request and provider scopes. Connection status refreshes each turn. Disconnecting removes provider authorization; it does not erase messages already read into chat history.

The Fly background worker is enabled. Tasks created in either mode use IANA time zones (America/Chicago defaults), survive restarts, and open a right-side task panel showing the saved schedule and next run. The worker checks due tasks every 30 seconds; execution starts on or shortly after the scheduled minute, not with a real-time exact-second guarantee.

Send `Monte Carlo` (or `Monte Carlo on`) to allow Harvey to use credentials supplied directly in that conversation for the requested website. `Monte Carlo off` disables this behavior for subsequent turns. The setting survives refreshes but is not inherited by new chats. Credentials typed in chat are stored as chat history and sent to the configured model; this is not a hidden password-manager field. The separate browser profile keeps website sessions across restarts. MFA/CAPTCHA and provider permissions still apply.
