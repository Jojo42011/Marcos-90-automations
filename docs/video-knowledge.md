# Backend video knowledge

Feature flags default off in code. The approved Fly deployment explicitly enables video processing and grounded replies.

## Automatic processing

The worker checks the connected TikTok account's latest 25 posts through Zernio every ten minutes, after active transcription finishes. Older videos can be imported through the authenticated backend API; import verifies ownership against the connected account. This is not a full historical backfill.

Victoria's pinned yt-dlp route downloads public audio without paid Zernio Tools access. FFmpeg checks full coverage and local Whisper transcribes it with one CPU thread. Limits remain 40 MB media, 20 minutes duration, and a 15-minute speech deadline. Temporary media is removed. Transcripts are cached before model extraction so retries need not repeat the download.

Caption and transcript are extracted separately. Each proposed fact keeps an exact source quote. Only claims corroborated by both sources are made available; conflicting or single-source details are withheld. An extraction warning blocks the affected field; an unrecognized warning blocks all facts. Corroborated fields remain usable even if other fields disagree. A video with no usable facts stays unavailable. Decisions, reasons and evidence are retained for diagnostics. Agreement does not guarantee that speech recognition or extraction captured every statement correctly.

There is no review queue or manual approval step. The former review page and dashboard links are removed. Missing facts get a short uncertainty response instead of an invented answer or a promise that someone is reviewing them. Existing historical approval records are preserved by migration; reprocessing applies the new field-level policy.

## Property matching

Each video stores a compact searchable description made from its extracted evidence, plus a separate summary of usable facts. Descriptive evidence helps identify the video but is never itself authority for an answer. Transcripts are not injected into every DM prompt.

Canonical links take priority, then exact CTA keywords, then conservative descriptive matching, then existing conversation/comment context. For example, the house with the glass elevator can identify a unique video. All meaningful descriptive tokens must match. Unknown descriptions, conflicting numeric qualifiers and negated descriptions do not select a different house by guess. Multiple matches ask the lead for a quick description or distinguishing detail. Search is account scoped and uses stored extracted descriptions, not fuzzy semantic inference or image analysis. It can miss paraphrases; clarification is the fallback.

Only the selected video's usable fields are returned. Current availability is never inferred; historical price answers require current confirmation. Existing consent, escalation, contact capture, and Marco's linked MLS priority are preserved.

## Texting voice

Property answers use short conversational sentences instead of database labels. Wesley's existing voice profile and retrieved approved examples, and Marco's existing TikTok voice rules, select among a few grounded reply variants. The style model returns only a choice index, so it cannot add a city, price, feature, contact request or delivery promise. Failure or invalid output uses the base grounded reply. Full source transcripts and the whole video library are never sent to that voice-selection call. This offers bounded wording variations rather than unrestricted rewriting.

## Configuration and backend operations

- VIDEO_KNOWLEDGE_ENABLED: discovery/processing opt-in, default off.
- VIDEO_KNOWLEDGE_REPLIES_ENABLED: separate live reply opt-in, default off.
- ZERNIO_DM_API_KEY and ZERNIO_TIKTOK_ACCOUNT_ID: existing account/posts access and account scope.
- VIDEO_WHISPER_MODEL: installed GGML model path; VIDEO_WHISPER_BIN defaults to whisper-cli.
- VIDEO_YTDLP_BIN: defaults to yt-dlp. FFmpeg and ffprobe must also be installed.
- ANTHROPIC_API_KEY: existing extraction/voice connection. VIDEO_FACT_MODEL defaults to claude-haiku-4-5. Local speech has no speech-API charge; model calls use the existing billed connection.
- VIDEO_KNOWLEDGE_DB_PATH: optional override; otherwise persistent app data.

GET /api/video-knowledge remains authenticated operational diagnostics with records and state counts. POST supports sync, import, retry, disable, and no-send preview. The approve action is no longer exposed. SQLite revisions and leases reject stale workers and source edits revoke earlier knowledge. Failed processing retries with backoff up to three attempts; exhausted technical failures remain visible in backend diagnostics.

The standard Dockerfile now builds yt-dlp 2026.08.19 and whisper.cpp v1.9.5/base with FFmpeg, and checks the binaries during image construction. Fly stores knowledge on the existing persistent volume. Wesley uses 1 GB RAM with 512 MB swap for local speech processing; Marco retains his existing machine allocation. Health, installed binaries, discovery and processing state are checked during rollout.

## Tests

npm run verify:video builds and runs storage, extraction, source agreement, field withholding, descriptive matching, voice selection bounds, stale-context, persistence and no-send tests. Wesley's npm test also exercises the live DM pipeline with its injected voice client. No test requires sending a real DM. The two supplied videos' stored extraction evidence can be replayed locally without another media download or model request.

## DM link fallback

An unmatched property question or uppercase keyword first asks for a description. A failed follow-up asks for Share > Copy link. Clarification state and the original question persist for 24 hours, scoped by account and person. A supplied TikTok link resolves only against the connected account’s stored videos; it does not initiate an arbitrary download or promise immediate details. Known videos with withheld facts still receive an uncertainty reply. Unknown links never reuse the previous home.

Zernio shared attachments preserve their payload.videoId or recognized TikTok embed/canonical URL in both live intake and recovered history. A preview without a usable reference requests the copied URL without claiming to see its contents. TikTok vm/vt and /t/ short links use bounded HTTPS redirects restricted to TikTok hosts, without credentials. Failed resolution falls back honestly. Exact production attachment delivery remains dependent on the provider; local fixtures validate the documented payload shape.
