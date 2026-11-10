# Repository working conventions

## Branch and scope

**master is the default branch and the baseline for current work.** Do not mirror or force-update it from main. Read [FORAI.md](FORAI.md) first, then the relevant focused document and current source. User instructions determine the authorized scope; a documentation-only task does not require building, running or deploying the application.

## Documentation

Keep FORAI.md at the repository root on master. For architectural changes, update its current architecture or implementation limits and add a dated bullet under the exact heading `## Recent changes`, newest first. The Chronicler uses that heading and ordering. Keep entries concise; Git history retains detailed change history.

Document implemented behavior separately from plans and live verification. Do not present old credential status, production record counts or historical test totals as current facts. Delete superseded handoffs and designs when their useful information is covered by current documentation.

## Working in the code

- Most frontend pages are plain HTML/CSS/JavaScript under public. People and lead profiles use React 19 + Astryx in web/people, bundled by npm run build:people into public/astryx. npm run build compiles both server and People UI.
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

<!-- ASTRYX:START -->
Astryx v0.7.11 · 174 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:
1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx template <Block>` for parts it lacks; `astryx component <Name>` to read props before using one.
Changing an existing page? Keep it: skip step 2 and add blocks/components inside its sections.
Before you deliver a build, run `astryx doctor --built <dir>`; don't deliver it if it fails.

RULES:
- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then tokens (var(--color-*|--spacing-*|--radius-*)). No raw hex/px. No StyleX/Tailwind compiler here — don't use xstyle/utility classes directly. Some templates use StyleX and need a compiler plugin; see `astryx docs styling-overview`.
- Palettes and custom colors go through the theme, never :root overrides. Run `astryx theme add <slug>` to import; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any raw <div>/<span>, imported .css/@apply, or hardcoded #hex/px with the component or a token.

`astryx help` lists every command. Key ones beyond the workflow:
  search "<query>"   find any component / hook / doc / template
  discover <words>   integrations you could add
  docs <topic>       getting-started, principles, tokens, theme … (`astryx docs` lists all)
  docs cli           commands and API reference
  docs authoring     build an integration package, and every field it holds
  upgrade --from <old version> --apply   run after a dependency bump
<!-- ASTRYX:END -->
