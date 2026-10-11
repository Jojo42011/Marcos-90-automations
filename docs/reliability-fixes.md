# Reliability and account boundaries

Changes based on master `65c0631`. This document describes code and fixture verification, not production deployment or provider health.

## Data and delivery

- CRM JSON is written to a unique same-directory temporary file, flushed, and atomically renamed. Failed publication restores the last committed in-memory snapshot and propagates the error. Malformed existing files stop loading rather than becoming an empty database. Original files are retained for recovery. Imported numeric IDs cannot be overwritten by the next generated ID.
- Scheduled messages are durably claimed before delivery. Pending, failed and uncertain work is not removed by history retention. Interrupted or ambiguous deliveries become `uncertain`, displayed as **Verify delivery** in the CRM. Check the provider before scheduling a replacement; uncertain sends are never automatically replayed. Known missing configuration can retry up to the existing attempt limit.
- Signed Zernio DMs are queued before acknowledgment. The existing pipeline and debounce generate replies; prepared replies are saved before transport and retried with the same provider idempotency key. Five failed attempts remain visible through authenticated `GET /api/dm/queue`. Recovery remains single-gateway coordination, not distributed exactly-once delivery. A crash during generation can repeat internal processing; a prepared response is reused on transport retry.
- Shared social leads are reconciled to Marco over trusted IPC every 30 seconds. No direct writes into another worker’s database, automatic campaign replay, overwrite of divergent CRM fields, or deletion of retained source records. Work chats, account IDs and existing connections remain in place.

## Integration setup

Authenticated `GET /api/account/integrations` returns configured booleans only. `PUT` accepts an object of allowlisted provider environment settings for the signed-in account. Empty strings remove a setting. Secrets are saved in that account’s mode-0600 `integration-settings.json`; they are not returned to clients. This uses host filesystem permissions, not a separate encryption vault. Back up the volume securely.

The allowlist is in `src/core/accountIntegrations.ts`. Unsupported keys (including paths and account identity overrides) are rejected. A save returns `restartRequired: true`; apply during a controlled restart so active work is not interrupted. Root business credentials are never automatically copied. Provider credentials and registrations still require real account configuration.

Inbound URLs:

- `/api/account-inbound/<user-id>/quo` — registered with the existing Quo secret.
- `/api/account-inbound/<user-id>/mojo` — requires that account’s Mojo secret.
- `/api/account-inbound/<user-id>/website` — requires that account’s website secret.
- `/api/account-inbound/<user-id>/twilio` — requires a valid Twilio signature against the full original callback URL. Missing signatures/tokens fail closed.

Gmail OAuth callbacks route using the state’s owner prefix, then validate the worker’s single-use, ten-minute nonce. Existing model infrastructure and managed Harvey connections retain their current paths.

## Identity and public access

Startup preserves existing passwords and disabled accounts. Previously installed weak passwords are not automatically rotated by this patch; operators must rotate them using account settings. Automatic credential replacement would unexpectedly invalidate existing access.

Workspace permissions are migrated once from unambiguous historical members to immutable user IDs. New users with the same display name receive no grant. Public customer links are signed for one exact resource; those capabilities do not provide CRM or API access. Keep each account’s `public-link.key` when backing up/restoring, or previously issued signed links will stop working.

## Numbered jobs

- 09 repairs phone-bearing cold-call contacts through the existing Brivity lookup/client and reports configured/synced/failed/skipped counts. It does not guess results for email-only contacts. A failed lookup never falls through to creation.
- 10 calls the existing reply-aware email follow-up engine. It does not introduce a parallel next-day SMS campaign.
- 11 creates deduplicated weekly update and quarterly gift review tasks. Quarterly email uses the existing engine. Gift choice, address and budget require human review; no Amazon order is placed.
- 12 writes descriptive results for explicitly attributed `dmVariant` records. No attribution means no invented results. A randomized assignment policy, sample threshold and winner rule are still needed before running a live experiment.

These entry points do not install additional automatic schedules. Existing production schedules remain unchanged.

## Verification

`npm run build` and `node scripts/verify-reliability-fixes.mjs` cover storage failure/corruption, queue claims and retention, interrupted DM recovery, signed-link tampering, identity grants, provider isolation, social merge preservation and numbered-job idempotence.

Expanded `verify-team-access.mjs` covers real gateway/worker HTTP routes, signed unsubscribe, approval ownership, provider-setting isolation, retained logins and concurrent task writes. Expanded `verify-account-isolation.mjs` checks social handoff and DM duplicate prevention across restart. Existing comment, DM, task recovery, Harvey Work, credential-consent, reliability and browser/UI fixture suites remain applicable. Tests use temporary data; live client sends and provider credentials are not required.

Local verification on 2026-10-11: TypeScript compilation and 16 fixture suites passed, including 56 comment checks, 35 DM checks, 63 Harvey Work checks, 38 Harvey reliability/endpoint checks, 97 outreach/SMTP/browser checks, 15 team integration groups, and account isolation with real browser switching plus restart recovery. New failure-path coverage contains nine groups. The final affected source changes were rechecked with the targeted storage, DM, team/account and outreach suites. GitHub CI separately validates the committed head on Node 20/Linux.
