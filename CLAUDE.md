# CLAUDE.md

Guidance for agents working in this repo.

## Read this first

**`FORAI.md` at the repo root is the source of truth for architecture.** Read it before you start work here — it tells you what exists, what changed recently, and what is broken or stubbed. Then keep it current (see the convention below).

## FORAI.md convention (non-negotiable)

Update `FORAI.md` before you finish any meaningful architectural work — a new subsystem, endpoint, table, integration, or a change to how something works. Add a dated line to `## Recent changes` (most recent first) and refresh Architecture / Known gaps if they changed. AETHON's nightly Chronicler reads this file to keep the master architecture docs current, so an unlogged change silently rots the docs. Not every commit — only what changes the architecture. Flag security/breaking changes explicitly.

Three mechanical must-haves (the Chronicler won't pick it up otherwise):

1. File is named exactly `FORAI.md`, at the repo root, on the default branch.
2. The `## Recent changes` heading exists with `-` bullets, newest first (the Chronicler watermarks the top line each run — order is how it knows what's new).
3. The repo must be in the operator's GitHub config repo list, or the nightly sweep skips it. After adding a FORAI, run the Chronicler once (`POST /api/architecture/chronicler/run`) — it returns which repos it processed vs. skipped, so you can confirm each one wired up.

> **Branch caveat for this repo:** GitHub's configured default branch is `master`, but `master` is a stale unrelated history. All real work and every deploy happen on `main`, and `FORAI.md` lives there. Until the GitHub default is flipped to `main`, requirement #1 is not actually satisfied and the nightly sweep will read the wrong branch.

## Working here

* **Branch:** develop on `main`. Do not push to `master` — it is a dead, divergent history.
* **Build:** `npm run build` (tsc) is the only automated gate. There is no test suite and no linter, so verify behavior yourself — the established practice is a headless-browser pass against a locally running `dist/src/server.js` before deploying.
* **Deploy:** pushing to `main` triggers `.github/workflows/deploy.yml`, which builds, pushes to `registry.fly.io/marco-90-automation:<sha>`, and runs `flyctl deploy --image`. Confirm the run went green and that the live site actually serves the change before reporting success.
* **Dependencies:** the fast overlay deploy path cannot run `npm install`. Prefer Node built-ins over new packages; a new dependency forces a full image rebuild.
* **Frontend:** `public/*.html` are standalone pages with no build step and no framework — plain HTML/CSS/JS, edited in place. Match the surrounding style rather than introducing tooling.
* **Data:** each subsystem owns its own SQLite file under `/data` via a `src/core/*Store.ts` module. Follow that pattern (resolve path → lazy singleton → `init*Schema()`) rather than adding tables to an unrelated database.
* **Be honest about what is real.** This system touches live client data, real email, real SMS, and real ad spend. Do not build a button that appears to do something it cannot actually do — say what is wired and what is not.
