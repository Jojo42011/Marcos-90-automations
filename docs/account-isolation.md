# Account workspaces

Historical implementation notes. The current three-account access, shared knowledge/MLS, and Carlos permissions are documented in [team-access.md](team-access.md); that document supersedes the older roster and workspace behavior below.

Fly enables `ACCOUNT_ISOLATION=true`. Authentication and admin account management remain on the public server. It starts one loopback-only application process per active account and forwards authenticated HTTP, streaming chat, uploads and WebSocket traffic to the matching process. An account cannot select its process with a query parameter, a display-name cookie or an HTTP header. Children recheck the session owner; in-process CRM requests use that child's private internal token and port.

The older stores cache records and SQLite connections in module globals, so request filters alone would not isolate them. Their paths now resolve through `dataPath()`. Account processes use `/data/accounts/<sha256(user-id)>/` for CRM contacts, conversations, tasks, transactions, email, knowledge, memory, documents and other business stores. They start empty instead of copying the legacy database. Existing shared files are retained unchanged. Default sample tasks, imported shared SOPs and seeded personal memory are not copied into accounts.

Harvey Work already keys projects, chats, messages, schedules, connections and browser directories by owner. Its existing storage remains in place, preserving those records. Each account worker clears only its own abandoned locks and recovers/runs only its own schedules. Workers restart with the gateway, so scheduled agents do not depend on an open browser tab. Deactivated accounts cannot start scheduled runs. There is one concurrent hosted browser slot per account to limit memory use on the current machine.

Account passwords and sessions remain in the central identity stores. CRM user lists and team rosters show the current account; the separate admin Team page can manage accounts but does not provide access to another person's CRM. Changing accounts requires password sign-in. Display caches are cleared on a switch and other open tabs reload. Use separate browser profiles if simultaneously signed into different accounts on one computer.

## Provisioning and integration boundary

The one-time account bootstrap ensures Marco, Wesley and Carlos exist, using `marco@example.com`, `wesley@example.com`, and `carlos@example.com` for missing accounts. Matching existing names keeps their existing email and password. Newly created accounts and active accounts without passwords receive the previously requested testing password `1234`. Subsequent boots do not reset passwords. The retired roster account is removed from the identity registry; old business files are not deleted or rewritten.

Model infrastructure keys and the managed-integration service key remain server configuration. Owner-scoped Harvey connections continue working, and each person connects their own additional services through Plugins. The old shared Brivity, Gmail, SMS, browser-extension and other business credentials are deliberately not inherited. Unscoped machine tokens, legacy webhooks and anonymous listing/report links cannot select an account and are unavailable while isolation is enabled. Restoring those integrations requires explicit account routing and individual connection configuration. Code execution remains off in account workers.

This is application-level account isolation on a shared host, not separate operating-system security sandboxes. Do not enable arbitrary local code execution for tenants.

## Verification

Run `npm run build`, `node scripts/verify-account-isolation.mjs`, `node scripts/verify-harvey-work.mjs`, and `node scripts/verify-harvey-credential-consent.mjs`. The isolation test launches the real server and three account processes against temporary stores, exercising actual sign-in, CRM writes and reads, cross-account ID rejection, preserved chats, schedules, account administration, worker lock ownership and restart persistence. It uses fixture passwords and no live integration credentials. The same suites run on pull requests.
