# Video property knowledge

This build is local and disabled by default. Neither the default Dockerfile nor Fly deployment configuration is changed.

## Flow

1. When VIDEO_KNOWLEDGE_ENABLED=true, the worker checks the connected TikTok account through Zernio every ten minutes (after any active transcription finishes). This reads the latest 25 posts, including native uploads. It is a recent-post sweep, not a complete backfill; use Import link for older videos. An outage spanning more than 25 uploads can leave older posts undiscovered.
2. Metadata is stored in SQLite, scoped to account and native video ID. Repeated discovery is idempotent. Changed source metadata revokes approval and requeues processing.
3. Victoria's pinned yt-dlp route reads the public link and downloads full audio, trying audio-only first and small video formats as fallback. The paid Zernio Tools download API is no longer needed. Each connection goes through a public IPv4 DNS-pinning proxy. No app credentials, browser cookies or login profiles go to the media downloader.
4. FFmpeg verifies full audio coverage and local whisper.cpp transcribes it. Limits: 40 MB per media file, 20-minute video, one Whisper CPU thread and 15-minute speech deadline. Temporary media is deleted. The transcript is saved before extraction so a model retry does not redownload/retranscribe it.
5. The existing Anthropic connection extracts caption and transcript evidence separately using a structured tool. Values must appear in their source quotes. Invalid claims are omitted with review warnings. Bedroom/bathroom counts also receive independent comparison. Quoted calls to action such as JOHNSON and ELEVATOR supply matching keywords.
6. Every new record requires review. Differing scalar values or extraction warnings produce needs_confirmation. No source is silently preferred. Even different area descriptions that may both be true are held conservatively. Ordinary proposals stay needs_review. A model may still miss or misclassify a claim; exact quotation is evidence, not proof of accuracy.
7. The reviewer opens /video-knowledge.html from the dashboard, compares both sources, removes unsuitable proposed facts, and chooses a displayed value or omission for every disagreement, with a reason. Extraction omissions must be acknowledged. Approval is tied to the exact revision and audited; removing conflict or warning fields from a request cannot bypass review.
8. Only ready records may inform DMs, and only when the separate VIDEO_KNOWLEDGE_REPLIES_ENABLED=true switch is enabled. Public comments retain existing behavior. Existing consent, escalation, phone capture and Marco MLS priority remain intact.

## Retrieval and limits

Canonical TikTok link wins, followed by specific keyword, selected conversation video, then unique recent comment association. Ambiguous matches ask which house; unknown links and explicit property switches clear stale context. Context expires after seven days. Separate accounts never share video knowledge.

Only up to three requested facts are rendered in a short deterministic reply; entire transcripts never enter the DM model prompt. Replies identify the dated video. Prices are historical; current price and availability always need confirmation. Missing facts receive a verification response. Keywords can be reviewed manually; generic info or price cannot identify a home. This version retains one proposed feature per video, alongside scalar facts; full source text remains available for review.

The review queue is how this version asks the team for clarification. It does not send outbound notifications. A pending video cannot provide property details to a lead. Human review is deliberately required before activation, including when the sources agree.

Supports canonical TikTok links in message text. No OCR, DM attachment analysis, semantic guessing, automatic short-link resolution, or automatic merging of different videos into one listing. Historical import verifies the canonical video's author against the connected Zernio account username; it does not require Zernio analytics import access.

## Configuration

| Variable | Purpose |
| --- | --- |
| VIDEO_KNOWLEDGE_ENABLED | Discovery/processing opt-in; default off |
| VIDEO_KNOWLEDGE_REPLIES_ENABLED | Separate live reply opt-in; default off |
| ZERNIO_DM_API_KEY | Existing account/posts access; paid Tools access unnecessary |
| ZERNIO_TIKTOK_ACCOUNT_ID | Required account scope; never taken from review request bodies |
| VIDEO_WHISPER_MODEL | Absolute GGML model path |
| VIDEO_WHISPER_BIN | Optional executable; default whisper-cli |
| VIDEO_YTDLP_BIN | Optional executable; default yt-dlp |
| ANTHROPIC_API_KEY | Existing extraction connection; model calls are billed normally |
| VIDEO_FACT_MODEL | Default claude-haiku-4-5 |
| VIDEO_KNOWLEDGE_DB_PATH | Optional SQLite path; defaults to persistent app data |

FFmpeg, ffprobe, yt-dlp and whisper-cli must exist before processing is enabled. Dockerfile.video is an optional image extension with pinned yt-dlp 2026.08.19, whisper.cpp v1.9.5 and the base model. Build the ordinary app image first, then build Dockerfile.video with APP_IMAGE pointing to it. It does not enable either flag. The Linux container build and target Fly memory/latency still require validation before deployment; local Windows media tests cannot establish those limits. External public-video access can change or fail, in which case the record stays unusable.

Failures retry with backoff up to three attempts, then require Retry processing. A database lease protects in-flight work and permits recovery after interruption. Source edits and review operations invalidate stale worker writes. Turning off live replies leaves the original DM flow active.

## Review API and walkthrough

GET /api/video-knowledge?offset=0 returns configuration indicators, state counts, and 50 account-scoped records with sources, proposed facts, warnings, conflicts and revisions. Wesley requires administrator authentication; Marco uses its existing authenticated shared automation-console access. No anonymous dashboard exception applies.

POST /api/video-knowledge supports sync, import (url), retry/disable (post, revision), approve (post, revision, optional notes, resolutions, acknowledgeWarnings), and preview (message). Each resolution has field, candidate (zero-based index or null to omit), and a required reason. Notes contain facts and keywords. Server-held conflicts and warnings remain authoritative.

For the local walkthrough, enable processing only in the test environment and leave live replies off. Import an owned public link, wait for processing, inspect the transcript and proposals, resolve questions, approve the current revision, then preview keyword/location/bedroom/price questions. Preview returns sent:false and never sends a DM. Source corrections must be supported by source evidence; don't approve guessed values.

## Verification

- npm run verify:video builds and runs storage, media, conflict, warning, migration, matching and no-send regression checks.
- npm run verify:video:ui runs the review page in headless Playwright. Install its Chromium or set VIDEO_TEST_BROWSER to an installed Chrome executable.
- Run existing DM/comment/auth regression tests before release.

Real-video validation uses the two supplied TikTok links, public downloading, local Whisper, real model extraction and isolated SQLite files. Discovery may replay already verified provider metadata rather than publish a new video. Review approval is simulated only in a separate disposable fixture, leaving real review records pending. No test sends messages or writes production knowledge.
