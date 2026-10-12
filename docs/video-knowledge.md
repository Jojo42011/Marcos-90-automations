# Video property knowledge — review build

This feature is disabled by default. No deployment, production secrets, webhook subscriptions or existing Dockerfile were changed.

## Flow

1. With `VIDEO_KNOWLEDGE_ENABLED=true`, a background worker asks Zernio for the connected TikTok account's latest 25 posts every ten minutes (after any in-progress transcription finishes). Both native uploads and Zernio-published posts are covered. This is a recent-post sweep, not a complete historical backfill. Import an older link explicitly through the review API when Zernio can resolve it.
2. New video metadata is saved in `video-knowledge.db`, keyed by social account and native post ID. Duplicate discoveries are ignored. Caption/publication changes revoke prior approval and queue new processing.
3. Zernio's Tools API supplies the download URL using the existing `ZERNIO_DM_API_KEY`. The downloader pins public IPv4 DNS results, validates every redirect, caps downloads at 40 MB and never sends the key to a media host.
4. FFmpeg extracts the full audio. Local whisper.cpp transcribes clips up to 20 minutes, with one CPU thread and a 15-minute transcription deadline. Media is temporary and removed afterward. No OpenAI speech API is called.
5. The existing Anthropic connection proposes property facts and specific keywords. Every fact must include a source quotation, and its value must occur in that quotation. No invented values, duplicate/conflicting fields or generic `info` keywords pass validation. Extraction is a paid model call even though speech transcription is local.
6. The result stays `needs_review`. An authorized reviewer compares the transcript and evidence with the source video, edits/removes unsuitable facts, and approves that exact revision. Local speech recognition and exact quote matching do not prove the fact is true; this review is intentional.
7. Only with the separate `VIDEO_KNOWLEDGE_REPLIES_ENABLED=true` flag do DMs use approved facts. Public comment replies retain their existing fact-free behavior. Consent, escalation and fresh contact capture retain priority. Marco's linked MLS behavior remains authoritative.

## Matching and reply limits

Exact canonical TikTok links take priority, then specific approved keywords, then the saved conversation selection, then a unique recent comment association. Context and comment associations expire after seven days. Multiple matching videos require clarification. An unknown link or explicit switch to another house blocks reuse of the old property. Generic `info` does not choose a house by itself.

Only up to three requested fields are rendered in a deterministic response; complete transcripts never enter the DM model prompt. The reply attributes facts to the dated video. Price is historical and requires current confirmation; availability is never inferred. Unknown fields receive a verification response. Descriptive phrases work when they are approved as keywords; there is no fuzzy semantic guess. Multiple videos of one house are conservatively treated as separate sources until a unique link/keyword identifies one.

The first version supports TikTok video links present as message text and signed comment-to-person associations. It does not read DM image/video attachments, automatically resolve short links in DM turns, perform OCR, or infer unseen details. Review import accepts a link that Zernio can resolve. Missing/unsupported inputs keep the existing fallback or ask for the keyword/location.

## Configuration for a later local walkthrough

| Variable | Purpose |
| --- | --- |
| `VIDEO_KNOWLEDGE_ENABLED` | Opt-in discovery and processing; default off |
| `VIDEO_KNOWLEDGE_REPLIES_ENABLED` | Separate opt-in for live reply changes; default off |
| `ZERNIO_DM_API_KEY` | Existing Zernio credential, requires account posts and Tools API access |
| `ZERNIO_TIKTOK_ACCOUNT_ID` | Required account scope; never accepted from request bodies |
| `VIDEO_WHISPER_MODEL` | Absolute path to a whisper.cpp GGML model |
| `VIDEO_WHISPER_BIN` | Optional absolute executable path; default `whisper-cli` |
| `ANTHROPIC_API_KEY` | Existing fact extraction connection |
| `VIDEO_FACT_MODEL` | Optional extraction model; default `claude-haiku-4-5` |
| `VIDEO_KNOWLEDGE_DB_PATH` | Optional database override; otherwise the persistent data directory |

FFmpeg/ffprobe and whisper-cli must be installed before enabling processing. `Dockerfile.video` is an optional local image extension using Victoria's pinned whisper.cpp release and the base model. Build the existing application image locally first, then use it as `APP_IMAGE`. It does not change Fly's Dockerfile or enable flags. Docker/media runtime execution and real-account provider permissions still need validation before deployment; offline tests mock external APIs and media tools. Local transcription also needs a memory/latency check on the intended Fly machine.

Failures retry with backoff up to three attempts; afterward an explicit retry is required. SQLite leases protect against concurrent completion and recover after an interrupted worker. Source edits or review changes invalidate old in-flight results. A disabled record remains unusable until reviewed again; current platform availability is never inferred from its existence in this library.

## Review API

`GET /api/video-knowledge?offset=0` returns feature flags, configuration booleans and up to 50 source records, including transcript, proposed notes, processing state and revision. The endpoint uses administrator authentication in Wesley; Marco uses authenticated shared automation-console access, with no anonymous unlocked-dashboard exception.

`POST /api/video-knowledge` accepts JSON. Use the existing Authorization bearer header or Marco's authenticated session. Do not put secrets in files or URLs.

```json
{"action":"sync"}
{"action":"import","url":"https://www.tiktok.com/@account/video/123"}
{"action":"approve","post":"123","revision":"revision-returned-by-GET","notes":{"facts":[{"field":"city","value":"San Antonio","quote":"This house is in San Antonio.","source":"transcript"}],"keywords":["oak hill"]}}
{"action":"disable","post":"123","revision":"revision-returned-by-GET"}
{"action":"retry","post":"123","revision":"revision-returned-by-GET"}
{"action":"preview","message":"OAK HILL location?"}
```

Each line is a separate request. Reload after each review operation to get the new revision. Preview works while live replies remain disabled, uses temporary conversation context and returns `sent:false`; it never sends a DM or invokes the conversation model. Approving without `notes` approves the currently displayed proposal. Remove unsupported facts rather than adding values absent from the source; corrections to a misheard transcript need a better transcription/source before approval.

For the walkthrough: enable processing only in a local test environment, import one account-owned video, inspect transcript and quotes, approve its revision, preview its keyword/location/price questions, then preview a reused keyword and an unknown link. Live replies stay off throughout.

## Offline verification

Run `npm run build` then `node scripts/verify-video-knowledge.mjs`. This covers persistence, recovery, scope, matching, review revisions, unsupported facts, stale worker writes, download restrictions and no-send previews. Run the repository's existing DM regression checks as well.

API contracts: [account posts](https://docs.zernio.com/accounts/get-account-posts), [TikTok downloads](https://docs.zernio.com/tools/download-tiktok-video), [external post import](https://docs.zernio.com/analytics/sync-external-posts). Provider account access and extraction quality are not proven by offline fixtures.
