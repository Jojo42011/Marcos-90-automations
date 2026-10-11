# Repository working conventions

## Branch and scope

**master is the default branch and the baseline for current work.** Do not mirror or force-update it from main. Read [FORAI.md](FORAI.md) first, then the relevant focused document and current source. User instructions determine the authorized scope; a documentation-only task does not require building, running or deploying the application.

## Documentation

Keep FORAI.md at the repository root on master. For architectural changes, update its current architecture or implementation limits and add a dated bullet under the exact heading `## Recent changes`, newest first. The Chronicler uses that heading and ordering. Keep entries concise; Git history retains detailed change history.

Document implemented behavior separately from plans and live verification. Do not present old credential status, production record counts or historical test totals as current facts. Delete superseded handoffs and designs when their useful information is covered by current documentation.

## Working in the code

- Frontend pages are plain HTML/CSS/JavaScript under public; there is no framework or frontend build.
- Domain stores live under src/core. Resolve account-local data through dataPath(); shared stores require an explicit shared path and authorization boundary. Do not copy or merge account data implicitly.
- Harvey Work stores owner-keyed records in its existing work.db. Preserve owner IDs, chat IDs, profiles and saved connections.
- Preserve existing data and migration markers. Check source/target ownership and backups before any data repair.
- Distinguish real integrations from stubs and configuration-dependent features.

## Verification and deployment

- TypeScript compilation: `npm run build`.
- Behavioral checks: relevant scripts under scripts/verify-*. CI's selected checks are in .github/workflows/account-isolation.yml; package.json does not define a general test or lint command.
- Use isolated fixture stores and credentials for tests. Some operational scripts mutate records or contact real services; inspect them before running.
- Docker installs dependencies and Chromium and compiles source. The frontend is copied into the image.
- The existing deploy workflow runs on pushes to main and master, builds an image tagged with the commit SHA and deploys it to Fly. A push can therefore affect production.
- For documentation-only updates with no build/deployment intended, use a commit message containing `[skip ci]`.
- When deployment is in scope, check the workflow, machine image and relevant live behavior before reporting it verified.
