# CapCutAPI — Marco integration files

The CapCut draft-export service is `ashreo/CapCutAPI` (Apache-2.0 per its
README; note the repo ships no LICENSE file), cloned at Docker build time at
pinned commit `369fa2d45e3cce0e633c5f43004464c0db268c11` into
`/app/services/capcutapi` and run by supervisord on port 9001 (internal only).

It exposes create_draft / add_video / add_subtitle / save_draft; the Node
route `POST /api/content/clip/:clipId/export-capcut` uses those to assemble a
CapCut draft (clip + its caption lines as subtitles) and returns a ZIP the
user extracts into their CapCut drafts folder.

## Files here (applied over the clone at build)
- `config.json` — port 9001, CapCut env, cloud upload OFF.
- `oss.py` — replaces upstream's Alibaba-OSS uploader with a stub. Upload only
  runs when `is_upload_draft=true` (never here), and upstream's module imports
  `oss2` unconditionally, which needs native builds for no benefit.
- `text_segment_shim.py` — appended to `pyJianYingDraft/text_segment.py`.
  Upstream HEAD imports `TextStyleRange` which its vendored library never
  defines (broken upstream); the shim restores the attribute-bag contract.

## Known upstream quirk
`/add_subtitle` crashes with a free-variable error when no `font` is passed —
the Node route always sends `font` to avoid it.

## Reality check (why this is draft-export, not rendering)
CapCutAPI is reverse-engineered and generates DRAFT PROJECTS ONLY — the final
video is rendered by the CapCut desktop app after the user drops the extracted
draft folder into CapCut's drafts directory. If a CapCut update changes the
draft format, exported drafts may stop opening until upstream catches up;
nothing else in the pipeline depends on this service.
