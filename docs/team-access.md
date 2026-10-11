# Three-account access

Marco and Wesley retain their existing account IDs and hashed data directories. Carlos can read and modify both accounts, together with any records already belonging to Carlos. Authorization is checked at the gateway and account workers; display cookies never grant access.

The gateway combines supported business collections and qualifies record references as `acct.<owner>.<record>`. Those references exist only in API presentation, never in the original databases. Subsequent detail/edit requests are decoded and sent to the owning process. Carlos chooses an owner when creating an independent business record. Mixed-owner bulk writes are rejected before any write; users can apply those actions separately per owner. A failed component read fails the combined request instead of presenting incomplete totals. Shared task counters are counted once, and finance rates/trends are recomputed from combined values.

Harvey chat/project/job IDs are resolved against the existing owner-keyed Work store. Carlos sees all authorized conversations automatically. The chat owner's process runs its jobs and integrations, while the initiating user is recorded separately. Carlos's own Harvey CRM bridge uses a per-process, loopback-only capability delivered over IPC to retrieve combined CRM data. Tokens are neither stored in browser state nor returned to model tools.

Task Center keeps its shared transactional store. Marco and Wesley see tasks assigned to them; Carlos sees and edits all three members' tasks. Creation uses the authenticated actor, independently of the assignee. The old Team/workspace/layout switching UI is replaced by per-account appearance settings and one logout action. Legacy browser drafts remain archived by account.

## Data retention and shared services

- Existing passwords, account status, IDs and permissions are preserved on startup. No shared testing password is installed. Optional ACCOUNT_BOOTSTRAP_PASSWORD (minimum 12 characters) only initializes active accounts without a password and requires a password change. Previously provisioned live passwords still need operator review/rotation. Historical backup files and migration markers remain intact.
- `workspace-owner-ids-v1` binds the three historical identities to immutable IDs once; subsequent display-name changes cannot grant cross-account access. Ambiguous initial identities stop provisioning. Harvey approval decisions carry the selected chat owner.
- `shared-knowledge.db` imports the root and retained account knowledge files additively. Original JSON files are untouched. Conflicting documents are retained under separate deterministic IDs. Identical built-in documents have aliases, preserving old links. Edits preserve prior revisions; stale concurrent edits fail with HTTP 409. All accounts and Harvey tools use this database.
- Explicit team business teaching is saved in the shared Knowledge Center with direct source-quote verification and author attribution. Chat-private preferences and history remain private. This is retrieval-based training, not changes to model weights.
- Only SimplyRETS feed credentials and the shared listings cache are newly shared; unrelated Gmail, Brivity and other business credentials remain isolated. Marco's worker owns scheduled MLS synchronization.
- Shared task, knowledge and relay write transactions acquire the SQLite write lock before reading, preventing lock-upgrade races across processes.

## Chat communication

Typing `@` searches authorized conversations by title and owner. Selected recipients receive the message when it is sent. Each relay has an idempotency key and creates at most four bounded recipient jobs; duplicate requests do not create duplicate deliveries. Recipient failures and busy chats are reported. Delegated runs cannot recursively relay or create more agents. A user may also explicitly ask Harvey to send a note to an accessible named chat through `chat_agents`.

## Verification

`npm run build`, `node scripts/verify-team-data.mjs`, `node scripts/verify-team-access.mjs`, and `node scripts/verify-account-isolation.mjs` cover ID collisions, permission denial, original-file preservation, additive migration, login preservation, signed public links, scoped provider settings, approval ownership, shared assignments, restart persistence, simultaneous knowledge/task writes, and relay idempotency. The integration fixtures block external provider traffic. `KEEP_TEAM_FIXTURE=1` retains a local fixture server for UI inspection; send a line to its stdin to stop it.

The existing credential-consent, Work runtime, memory, reliability, active-context and account UI regressions remain applicable. Live verification should compare retained IDs against a pre-deployment baseline, create only clearly labeled test records, and avoid client sends, existing-record changes or deletion of retained data.
