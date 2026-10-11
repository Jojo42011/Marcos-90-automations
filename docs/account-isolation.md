# Account routing and storage

Current behavior on master. [Team access](team-access.md) defines Marco, Wesley and Carlos's permissions.

## Processes and authorization

With ACCOUNT_ISOLATION=true, the public server authenticates users and starts one loopback-only Node process per active account. Each worker rechecks access; display cookies do not authorize a request. HTTP requests and WebSockets pass through the gateway.

Marco and Wesley access their own business records. Carlos can access authorized Marco/Wesley records as well as his own. Combined supported collections use owner-qualified IDs in API responses; the original stored IDs remain unchanged. Detail/edit requests route back to the owning worker. Requests mixing owners for one write are rejected. A failed component read prevents an incomplete combined response.

The current worker browser-session limit is three. Workers start with the gateway rather than depending on an open browser tab. Inactive account processes are stopped.

## Storage

Account-local data resolves through dataPath() under /data/accounts/<sha256(user-id)> on Fly. Separate processes also isolate singleton caches and database connections.

Explicit shared stores are:

- Central identity and session data.
- shared-tasks.db for Task Center.
- shared-knowledge.db for team knowledge.
- listings.db and the SimplyRETS feed.
- harvey-work/work.db, with records/messages keyed by owner and chat.

Existing owner IDs and Work records remain in place. Startup contains one-time recovery/provisioning steps; original CRM/task/knowledge source files are retained. Marco CRM recovery and additive task/knowledge imports are documented by the corresponding core modules. Do not assume every account starts empty or copy another account's files as setup.

## Integrations

The allowlist in src/core/tenantGateway.ts shares model infrastructure, Composio and SimplyRETS configuration. Other parent business credentials are not inherited. Workers use a private internal capability for CRM calls; Carlos's combined bridge goes through the gateway.

The parent owns ManyChat POST/OPTIONS /webhook and signed Zernio POST /api/zernio/webhook independently of dashboard sessions. Shared DM/comment consoles require authorized access. Other legacy webhooks and unscoped machine integrations do not receive a personal account implicitly.

Account workers force HARVEY_EXEC_MODE=off. This is application-level separation on a shared host, not independent OS sandboxes.

## Verification references

scripts/verify-account-isolation.mjs, scripts/verify-account-ui.mjs and scripts/verify-team-access.mjs exercise access boundaries and persistence with fixtures. See .github/workflows/account-isolation.yml for the current CI selection. No live credential or production-health status is implied by this document.
