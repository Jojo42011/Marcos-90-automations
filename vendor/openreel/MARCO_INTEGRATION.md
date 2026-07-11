# OpenReel — Marco integration (vendored fork)

Vendored from https://github.com/Augani/openreel-video (MIT). This is the clip
editor opened from the Content Manager Review Queue (`✂ EDIT CLIP`). It is
served **same-origin** by our Express server under `/editor` (see
`src/server.ts`), so the browser is cross-origin isolated (COOP/COEP) and the
editor can fetch/POST our API without CORS.

## Our patches (only these files differ from upstream)
- `apps/web/vite.config.ts` — `base: "/editor/"` so assets resolve under `/editor/`.
- `apps/web/src/marco-bridge.ts` — **new.** Reads `?clip=<id>&token=` from the
  hash, fetches `/api/content/clip/<id>/video`, and drops it on a fresh
  1080×1920/30 timeline (`importMedia` → `addClipToNewTrack`). Best-effort.
- `apps/web/src/App.tsx` — initial-route effect: if a `clip` param is present,
  create the project, navigate to the editor, and call the bridge.

Save-back (POST the export blob to `/api/content/clip/<id>/replace-upload`) is
**not yet wired** — the export is returned via the manual re-upload step in the
Content Manager modal, which keeps a revertable original. The export blob hook
lives in `apps/web/src/components/editor/Toolbar.tsx` (`runExport` /
`showSavePicker`).

## Rebuilding after editing the source
The built output is committed at `public/editor/`. To rebuild:

```bash
cd vendor/openreel
pnpm install            # Node 18+, pnpm 9
pnpm --filter @openreel/web build
rm -rf ../../public/editor && mkdir -p ../../public/editor
cp -R apps/web/dist/. ../../public/editor/
```

Then `npm run build` at the repo root and commit both `vendor/openreel` and
`public/editor`. The editor needs COOP/COEP headers — those are set for
`/editor` in `src/server.ts`, not in this build.
