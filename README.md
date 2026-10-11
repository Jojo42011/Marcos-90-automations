# Marco 90 Automation

Business automation for Marco Puga's real estate team: CRM, social lead conversations, tasks, listings, transactions, finance, reporting and Harvey.

The default branch is **master**. This overview describes the source on that branch; it does not assert that every external account is connected.

## Current application

- **CRM:** lead/contact records, communication history, imports, follow-up plans, scheduled messages, buyer/seller tracker and collaborator assignments.
- **Business operations:** MLS listing search, CMA, transaction deadlines and documents, email marketing, lead scoring/nurture, finance and reporting.
- **Social intake:** ManyChat and Zernio webhooks, conversation qualification, phone/criteria capture, comment reply queue and DM-history recovery.
- **Harvey:** persistent projects/chats, per-chat model selection and hosted browser, connected apps, files, taught workflows, memory, background jobs and scheduled agents.
- **Team access:** Marco and Wesley have separate account stores. Carlos has combined access to authorized business records and chats. Task Center, knowledge and MLS have explicit shared storage.

The original 12 numbered modules are not a completion checklist. Some are implemented, while modules 09–12 retain scaffold/no-op functions. Newer agents implement some related follow-up and retention behavior separately. The Amazon, New Home Buddy and directory-form Brivity clients remain stubs; the implemented Brivity client is `src/integrations/brivity.ts`.

The old Content Manager, Content Calendar, OpenShorts/CapCut sidecars and OpenReel editor were removed. Social analytics, comment automation, content suggestions and voice-clone support remain.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/server.ts` | Express routes, authentication integration, startup and WebSockets |
| `src/core/` | Domain logic, account routing and JSON/SQLite stores |
| `src/app/`, `src/modules/`, `config/prompts.ts` | Social conversation intake and funnel |
| `src/agents/` | Business automation and scheduled checks |
| `src/harvey/`, `src/hull/` | Harvey tools, Work runtime, providers, memory and voice |
| `src/integrations/` | Vendor clients |
| `public/` | Standalone HTML/CSS/JavaScript pages and browser extension |
| `scripts/` | Verification, simulation, migration and operational scripts |

Production configuration uses Node 20, Docker and Fly.io with a persistent `/data` volume. Account workers use separate processes because stores also cache data in memory. See [architecture](FORAI.md) and [team access](docs/team-access.md).

## Development and verification

`npm run build` compiles TypeScript; `npm start` starts `dist/src/server.js`. The frontend has no separate build. Starting the application can start workers and integration activity: use disposable storage and fixture credentials for development.

Verification scripts live under `scripts/verify-*`; CI runs a selected set in [.github/workflows/account-isolation.yml](.github/workflows/account-isolation.yml). A passing build is not a live integration test.

Pushes to `master` or `main` trigger the existing deployment workflow. Use `master` for current work; do not mirror or force-update it from `main`. A documentation-only commit can use `[skip ci]` when no build/deployment is intended.

## Documentation

- [Current architecture and implementation limits](FORAI.md)
- [Repository working conventions](CLAUDE.md)
- [Configuration and integration boundaries](SETUP-CHECKLIST.md)
- [Account routing](docs/account-isolation.md) and [team access](docs/team-access.md)
- [Task storage](docs/task-management-storage.md)
- [Harvey Work](docs/harvey-work.md), [model layer](docs/harvey-model-layer.md), [persistent agents](docs/harvey-persistent-agents.md) and [reliability](docs/harvey-reliability-safeguards.md)
- [ManyChat listing context](docs/manychat-listing-id.md)

Older proposals, incident handoffs and removed-feature designs remain available in Git history.
