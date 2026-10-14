# Harvey projects, plugins, browser and scheduled agents

Current implementation on master. fly.toml enables the hosted browser and recurring worker. Real account configuration and site-specific workflows require separate live verification.

Canvas targeting uses `browser_inspect_targets` for bounded visible DOM node/port rectangles, exposed edges and viewport pixels. Optional observed `nodeIds` focus large graphs. `browser_drag_targets` accepts owner/chat-scoped observation IDs that expire after 30 seconds, checks target identity, position and obstruction, then sends 24 intermediate pointer moves with unconditional release. Coordinate drags use the same controlled gesture. Neither a returned gesture nor a missing alpha label proves the desired connection or an application limitation: inspect destination inputs and the rendered result. Pixel-only canvases still require screenshot targeting; hidden application state and arbitrary model-supplied JavaScript remain unavailable.

Interactive saved jobs can use `continue_work` with an unfinished authorized task plan and an exact current observation to wait and resume. The existing job, chat, browser profile and files are reused. Waiting checkpoints survive restart; interrupted running actions still require inspection rather than automatic replay. Continuations retain the original spend ceiling (default $2 total), stop after 12 yields or one hour, and remain cancellable in the chat. Scheduled/delegated jobs do not gain this capability. Resumption is not proof an external render finished, and requires a fresh state check before another write.

`verify-canvas-targeting.mjs` tests real Chromium gestures on six-pixel ports at 50% canvas zoom, edge read-back, stale/covered targets and owner isolation. `verify-work-continuation.mjs` tests saved waiting, cancellation, restart and aggregate budgets; `verify-harvey-reliability.mjs` covers reserved checkpoint rounds and forbids external actions in those rounds. CI runs all three. A deployment commit tagged `[harvey-canvas]` also runs the isolated canvas fixture inside the deployed image without opening existing customer profiles or contacting Beeble. This does not certify completion of an actual Beeble project.

Managed plugins now use Composio: configure COMPOSIO_API_KEY on the server, then connect supported apps from Plugins. Composio handles OAuth credentials and refresh; the legacy provider-client setup below is optional for direct connectors. Managed connections are owner-wide across that user's chats and projects; legacy custom connectors retain their saved scope. Real provider sign-in/consent is still required.

## User flow

1. Create a project, give it shared instructions and a timezone.
2. Open separate chats for the agents in that project. Each chat has persistent history and its own browser profile. Both Chat and Work can use connected apps, browser tools and schedules when authorized. Its business-tool bridge retains the existing CRM capabilities and approval rules.
3. Open Plugins and connect the services needed. Managed connections are owner-wide. Legacy custom connections can be project-scoped and have an explicit Enable actions setting; managed actions use provider permissions and the user's request.
4. In either Chat or Work, describe the job and timing. Harvey calls `schedule_agent`, which persists the prompt, five-field cron, timezone, next run and model-spend ceiling. The task appears under Scheduled agents; it can be edited, paused, resumed, run now or removed.
5. Results appear in the originating chat and in run history. A browser/API error, missing model or budget failure must not be reported as a successful run.

Plugins searches the live paginated Composio catalog; it is not restricted to a fixed app allowlist. Accounts still require provider consent unless a tool needs no authentication. The legacy direct OAuth catalog includes Google, Microsoft, GitHub, Slack and Notion services; those adapters need their own server configuration. Custom connectors accept an HTTPS Streamable HTTP MCP endpoint and optional bearer token; tools are discovered live. Custom MCP interactive OAuth and legacy SSE-only transport are not implemented.

## Browser choice and research

Selected [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp), Apache 2.0. Its accessibility tools fit the existing OpenRouter tool loop, and persistent profiles retain sessions. Harvey runs its installed, pinned local package, not a paid hosted browser API. Compared with [Browser Use](https://github.com/browser-use/browser-use) and [Stagehand](https://github.com/browserbase/stagehand), this avoids introducing another LLM orchestration layer. Open-source licensing does not cover hosting or model costs.

Interaction inspiration: [ChatGPT projects](https://learn.chatgpt.com/docs/projects), [Chat/Work](https://learn.chatgpt.com/docs/web), [scheduled tasks](https://learn.chatgpt.com/docs/automations), and [plugins](https://learn.chatgpt.com/docs/plugins). These describe product patterns, not a public copy of ChatGPT's private scheduler or execution infrastructure.

OAuth implementation references: [Google offline access](https://developers.google.com/identity/protocols/oauth2/web-server), [Microsoft Graph delegated access](https://learn.microsoft.com/en-us/graph/auth-v2-user), [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [Notion authorization](https://developers.notion.com/guides/get-started/authorization), and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

## Server setup before live use

The Docker build installs npm dependencies and Chromium. Configuration instructions below describe capabilities and do not authorize deployment.

- `HARVEY_WORK_DIR`: durable directory, defaults to `/data/harvey-work` on Linux with a data volume, otherwise `data/harvey-work`.
- `HARVEY_PUBLIC_URL`: canonical HTTPS app URL, used for OAuth callbacks.
- `HARVEY_VAULT_KEY`: a stable 32-byte AES key encoded as 64 hex characters. Generate it once with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; keep it in deployment secrets and back it up. Rotating or losing it without migration makes stored credentials unreadable.
- `HARVEY_BROWSER_ENABLED=true`: enable the browser after Chromium is installed. Dockerfile installs it. Local development can use `npx playwright install chromium`. `PLAYWRIGHT_BROWSERS_PATH` or `HARVEY_BROWSER_EXECUTABLE` can select a local installation.
- `HARVEY_BROWSER_MAX_SESSIONS`: default 3. Idle browser workers close after ten minutes; saved profiles remain.
- `HARVEY_WORKER_ENABLED=true`: starts the recurring worker at 30-second intervals. Keep off until ready for real external actions.
- Existing `OPENROUTER_API_KEY` (or Anthropic fallback) and global spend caps still apply. Tasks default to a $1 model budget per run; this is a preflight/recorded-usage ceiling, not a guarantee against provider billing adjustments or external-service charges.
- FFmpeg is already installed by the Dockerfile. `FFMPEG_PATH` can override the executable for local testing.

For optional legacy direct OAuth adapters (not Composio-managed apps), register an OAuth application per provider family and configure:

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

Records and messages retain their original owner keys. The gateway allows Carlos to access authorized chats and routes their work to the owning process while recording the initiating actor separately. Unscoped machine-token access is blocked with account isolation enabled; the `operator` fallback applies only outside that routing mode. Browser directories are hashed by owner and chat. Browser > Save login keeps credentials out of model context: the model sees login IDs and URLs, and a server-side fill inserts credentials only on the saved origin. A user can instead explicitly enable Monte Carlo for direct credential use in that chat, as described below. The saved-login helper supports a two-field username/password page. Multi-stage identity-provider sign-in, MFA, CAPTCHA and renewed consent can require human help. Cookie persistence cannot prevent sites from expiring sessions.

The deployment uses **one host/volume with a gateway and per-account worker processes**. Workers recover and execute only their own owner-keyed records. Claiming a scheduled run and advancing its next due time are transactional. Only one run can own a chat at a time. After downtime, a missed task runs once, not once per missed interval. At boot, interrupted runs become `needs_attention`; they are not blindly retried because an external write may already have happened. This is not an exactly-once guarantee for third-party actions. Scaling to multiple Fly machines requires a coordinated queue/lease service and per-worker browser volumes.

The browser is an isolated profile and process, not a complete isolated virtual desktop. On root Linux containers the fixed browser entrypoint drops to uid/gid 1001; it inherits only the minimal browser environment. Actual Fly/browser sandbox compatibility still needs staging validation. Arbitrary JavaScript execution and filesystem-wide uploads are not exposed to the model. A per-chat computer side panel exposes the hosted browser preview, including screenshots and tabs. It is not an interactive full-desktop takeover viewer.

## Files and video

The composer can upload a file or video (250 MB limit) to the current chat. `workspace_files` lists its files. `edit_video` trims/transcodes to MP4 and can mute audio; it has a ten-minute timeout and uses fixed FFmpeg arguments. Results can be downloaded in Browser > Chat files or uploaded through a compatible website using Playwright's file-upload tool. Full timeline editing, arbitrary effects, large resumable uploads and editor-specific workflows are not implemented.

## Verification

Relevant fixture checks include scripts/verify-harvey-work.mjs, verify-harvey-credential-consent.mjs, verify-harvey-reliability.mjs, verify-browser-persistence.mjs and verify-harvey-computer-ui.mjs. They cover persistence, scope, consent, scheduling and browser behavior. See CI configuration for the selected automated checks. Historical pass counts are omitted because they change with the suites; fixture results do not establish live account permissions or model accuracy.


Connected Composio apps are shared across the signed-in user’s chats and projects. Chat and Work both expose discovery, read/write actions and the hosted browser; authorization still comes from the user’s request and provider scopes. Connection status refreshes each turn. Disconnecting removes provider authorization; it does not erase messages already read into chat history.

The Fly configuration enables the background worker. Tasks created in either mode use IANA time zones (America/Chicago defaults), survive restarts, and open a right-side task panel showing the saved schedule and next run. The worker checks due tasks every 30 seconds; execution starts on or shortly after the scheduled minute, not with a real-time exact-second guarantee.

Send `Monte Carlo` (or `Monte Carlo on`) to allow Harvey to use credentials supplied directly in that conversation for the requested website. `Monte Carlo off` disables this behavior for subsequent turns. The setting survives refreshes but is not inherited by new chats. Credentials typed in chat are stored as chat history and sent to the configured model; this is not a hidden password-manager field. The separate browser profile keeps website sessions across restarts. MFA/CAPTCHA and provider permissions still apply.


Monte Carlo is a Harvey application setting, independent of the chosen model. Send the standalone command `Monte Carlo`, `Monte Carlo on`, or `Monte Carlo off`; Harvey persists and acknowledges it without calling a model, even during provider outages or exhausted model budgets. Ordinary discussion such as “Monte Carlo simulation” does not toggle consent. Both Chat and Work rebuild the system prompt and browser-tool description from the stored setting on each turn, including after switching models. OpenAI and other OpenRouter models, as well as direct Anthropic, receive the same authorization to use supplied credentials for the user's requested site. Scheduled prompts cannot change consent.

This authorizes ordinary sign-in; it does not make a provider unrestricted or guarantee that a particular model will execute a login. The selected model must support tool calling. With Monte Carlo off, Harvey is instructed not to use credentials from prior chat history, but existing messages and signed-in browser sessions remain. Use Save login when the password should stay out of the selected model's context. MFA, CAPTCHA, site permissions, spend limits and business approvals remain in effect.

Offline regression: `node scripts/verify-harvey-credential-consent.mjs` exercises the real runtime and provider serializers with fixture model responses and isolated browser/store substitutes. It verifies consent propagation, model changes, acknowledgement without a provider, opt-out, scheduled-command rejection and owner isolation; it does not establish live model compliance.
