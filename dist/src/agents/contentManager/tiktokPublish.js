"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tiktokConfigured = tiktokConfigured;
exports.tiktokPrivacyLevel = tiktokPrivacyLevel;
exports.tiktokAudited = tiktokAudited;
exports.postVideoToTikTok = postVideoToTikTok;
exports.tiktokMode = tiktokMode;
exports.uploadToDrafts = uploadToDrafts;
exports.tiktokRedirectUri = tiktokRedirectUri;
exports.buildTikTokAuthorizeUrl = buildTikTokAuthorizeUrl;
exports.exchangeCodeForToken = exchangeCodeForToken;
exports.scheduleDailyTokenRefresh = scheduleDailyTokenRefresh;
/**
 * TikTok Content Posting API (official) — direct video post.
 *
 * Flow (https://developers.tiktok.com/doc/content-posting-api-reference-direct-post):
 *   1. Refresh the user access token from the long-lived refresh token.
 *   2. POST /v2/post/publish/video/init/ (FILE_UPLOAD) → publish_id + upload_url.
 *   3. PUT the video bytes to upload_url.
 *   4. Poll /v2/post/publish/status/fetch/ until PUBLISH_COMPLETE (or fail).
 *
 * Auth: a user access token with scope `video.publish`. Access tokens expire
 * (~24h) so every post refreshes from the refresh token first; the refresh
 * token rotates on each use, so the latest is persisted to /data (a Fly volume)
 * and only seeded from env the first time.
 *
 * Audit: unaudited apps can ONLY post SELF_ONLY (private). Set TIKTOK_AUDITED=1
 * once TikTok approves the app to allow public posting.
 */
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const TIKTOK_API = "https://open.tiktokapis.com";
const SINGLE_CHUNK_MAX = 64 * 1024 * 1024; // TikTok allows a single chunk up to 64MB.
function tokenStorePath() {
    const base = process.env.TIKTOK_TOKEN_STORE || (process.env.DATA_DIR || "/data");
    return path_1.default.join(base, ".tiktok_tokens.json");
}
function creds() {
    const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim() || "";
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim() || "";
    const refreshToken = process.env.TIKTOK_REFRESH_TOKEN?.trim() || "";
    if (!clientKey || !clientSecret || !refreshToken) {
        throw new Error("TikTok is not fully configured — set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and " +
            "TIKTOK_REFRESH_TOKEN (a user token from the video.publish OAuth consent).");
    }
    return { clientKey, clientSecret, refreshToken };
}
/** True when all credentials needed to post are present. */
function tiktokConfigured() {
    return Boolean(process.env.TIKTOK_CLIENT_KEY?.trim() &&
        process.env.TIKTOK_CLIENT_SECRET?.trim() &&
        process.env.TIKTOK_REFRESH_TOKEN?.trim());
}
/** Default privacy — unaudited apps may only use SELF_ONLY (private). */
function tiktokPrivacyLevel() {
    const override = process.env.TIKTOK_PRIVACY_LEVEL?.trim();
    if (override)
        return override;
    const audited = /^(1|true|yes)$/i.test(process.env.TIKTOK_AUDITED?.trim() || "");
    return audited ? "PUBLIC_TO_EVERYONE" : "SELF_ONLY";
}
function tiktokAudited() {
    return /^(1|true|yes)$/i.test(process.env.TIKTOK_AUDITED?.trim() || "");
}
async function readStoredToken() {
    try {
        const raw = await fs_1.promises.readFile(tokenStorePath(), "utf8");
        const parsed = JSON.parse(raw);
        return parsed?.refreshToken ? parsed : null;
    }
    catch {
        return null;
    }
}
async function writeStoredToken(state) {
    try {
        await fs_1.promises.mkdir(path_1.default.dirname(tokenStorePath()), { recursive: true });
        await fs_1.promises.writeFile(tokenStorePath(), JSON.stringify(state), "utf8");
    }
    catch (err) {
        // Non-fatal: we can still post this time, but the rotated refresh token
        // wasn't saved — the NEXT post may need a fresh token. Surface loudly.
        console.warn(`[tiktok-publish] could not persist rotated refresh token: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * Exchange the refresh token for a fresh access token. TikTok rotates the
 * refresh token on each call, so the new one is persisted for next time.
 */
async function getFreshAccessToken() {
    const { clientKey, clientSecret, refreshToken: envRefresh } = creds();
    const stored = await readStoredToken();
    const refreshToken = stored?.refreshToken || envRefresh;
    const body = new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
    });
    const res = await fetch(`${TIKTOK_API}/v2/oauth/token/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const data = (await res.json().catch(() => ({})));
    if (!res.ok || typeof data.access_token !== "string") {
        const detail = data.error_description || data.error || JSON.stringify(data).slice(0, 300);
        throw new Error(`TikTok token refresh failed (HTTP ${res.status}): ${detail}`);
    }
    const accessToken = data.access_token;
    const newRefresh = data.refresh_token || refreshToken;
    const expiresIn = Number(data.expires_in) || 86400;
    await writeStoredToken({
        refreshToken: newRefresh,
        accessToken,
        accessExpiresAt: Date.now() + expiresIn * 1000,
    });
    return accessToken;
}
async function tiktokJson(endpoint, accessToken, payload) {
    const res = await fetch(`${TIKTOK_API}${endpoint}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({})));
    const error = data.error || {};
    if (!res.ok || (error.code && error.code !== "ok")) {
        throw new Error(`TikTok ${endpoint} failed (HTTP ${res.status}): ${error.code || ""} ${error.message || JSON.stringify(data).slice(0, 300)}`.trim());
    }
    return data;
}
/**
 * Post a video file to TikTok. Returns the publish_id. Throws with the real
 * TikTok error on any failure (expired token, spam cap, audit restriction, …).
 */
async function postVideoToTikTok(filePath, caption, opts) {
    if (!filePath)
        throw new Error("TikTok post: no video file path");
    const bytes = await fs_1.promises.readFile(filePath);
    const videoSize = bytes.byteLength;
    if (videoSize === 0)
        throw new Error(`TikTok post: video file is empty (${filePath})`);
    if (videoSize > SINGLE_CHUNK_MAX) {
        // Our clips are short, downscaled, and comfortably under 64MB; multi-chunk
        // upload isn't implemented. Fail clearly rather than send a bad request.
        throw new Error(`TikTok post: video is ${(videoSize / 1024 / 1024).toFixed(1)}MB, over the ${SINGLE_CHUNK_MAX / 1024 / 1024}MB single-chunk limit (multi-chunk upload not implemented).`);
    }
    const privacyLevel = opts?.privacyLevel || tiktokPrivacyLevel();
    const accessToken = await getFreshAccessToken();
    // 1) init
    const init = await tiktokJson("/v2/post/publish/video/init/", accessToken, {
        post_info: {
            title: caption.slice(0, 2200),
            privacy_level: privacyLevel,
            disable_comment: false,
            disable_duet: false,
            disable_stitch: false,
        },
        source_info: {
            source: "FILE_UPLOAD",
            video_size: videoSize,
            chunk_size: videoSize,
            total_chunk_count: 1,
        },
    });
    const initData = init.data || {};
    const publishId = String(initData.publish_id || "");
    const uploadUrl = String(initData.upload_url || "");
    if (!publishId || !uploadUrl) {
        throw new Error(`TikTok init returned no publish_id/upload_url: ${JSON.stringify(init).slice(0, 300)}`);
    }
    // 2) upload the single chunk
    const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(videoSize),
            "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`,
        },
        body: bytes,
    });
    if (!uploadRes.ok) {
        const text = await uploadRes.text().catch(() => "");
        throw new Error(`TikTok video upload failed (HTTP ${uploadRes.status}): ${text.slice(0, 300)}`);
    }
    // 3) poll status until terminal
    const deadline = Date.now() + 120_000;
    let lastStatus = "PROCESSING_UPLOAD";
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        const statusResp = await tiktokJson("/v2/post/publish/status/fetch/", accessToken, {
            publish_id: publishId,
        });
        const sData = statusResp.data || {};
        lastStatus = String(sData.status || lastStatus);
        if (lastStatus === "PUBLISH_COMPLETE")
            return { publishId };
        if (lastStatus === "FAILED") {
            throw new Error(`TikTok publish FAILED: ${String(sData.fail_reason || "unknown")}`);
        }
    }
    // Uploaded and accepted, still processing on TikTok's side — not a failure.
    console.log(`[tiktok-publish] publish ${publishId} still ${lastStatus} after 120s — accepted, TikTok is finalizing`);
    return { publishId };
}
/**
 * Which TikTok capability this app currently has. We are granted `video.upload`
 * (draft upload to the creator's inbox), NOT `video.publish` (direct posting),
 * so this is "draft". The UI keys off it to label the action honestly.
 */
function tiktokMode() {
    return "draft";
}
/**
 * Upload a video to the creator's TikTok INBOX as a DRAFT using the
 * `video.upload` scope. This is NOT a public post — TikTok sends the creator an
 * inbox notification; they must open the TikTok app to add a caption and tap
 * post. (https://developers.tiktok.com/doc/content-posting-api-reference-upload-video)
 *
 * Differences from postVideoToTikTok (direct post):
 *   - endpoint /v2/post/publish/inbox/video/init/  (vs .../video/init/)
 *   - payload has ONLY source_info — NO post_info (no title/privacy_level; the
 *     creator sets those in-app), so `caption` is NOT sent to TikTok here.
 *   - terminal success status is SEND_TO_USER_INBOX (vs PUBLISH_COMPLETE).
 *
 * Returns the publish_id and the terminal status. Throws with the real TikTok
 * error on any failure — never swallows it.
 */
async function uploadToDrafts(filePath, _caption) {
    if (!filePath)
        throw new Error("TikTok draft upload: no video file path");
    const bytes = await fs_1.promises.readFile(filePath);
    const videoSize = bytes.byteLength;
    if (videoSize === 0)
        throw new Error(`TikTok draft upload: video file is empty (${filePath})`);
    if (videoSize > SINGLE_CHUNK_MAX) {
        throw new Error(`TikTok draft upload: video is ${(videoSize / 1024 / 1024).toFixed(1)}MB, over the ${SINGLE_CHUNK_MAX / 1024 / 1024}MB single-chunk limit (multi-chunk upload not implemented).`);
    }
    const accessToken = await getFreshAccessToken();
    // 1) init — inbox/draft endpoint, source_info ONLY (no post_info for drafts).
    const init = await tiktokJson("/v2/post/publish/inbox/video/init/", accessToken, {
        source_info: {
            source: "FILE_UPLOAD",
            video_size: videoSize,
            chunk_size: videoSize,
            total_chunk_count: 1,
        },
    });
    const initData = init.data || {};
    const publishId = String(initData.publish_id || "");
    const uploadUrl = String(initData.upload_url || "");
    if (!publishId || !uploadUrl) {
        throw new Error(`TikTok draft init returned no publish_id/upload_url: ${JSON.stringify(init).slice(0, 300)}`);
    }
    // 2) upload the single chunk
    const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(videoSize),
            "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`,
        },
        body: bytes,
    });
    if (!uploadRes.ok) {
        const text = await uploadRes.text().catch(() => "");
        throw new Error(`TikTok draft upload failed (HTTP ${uploadRes.status}): ${text.slice(0, 300)}`);
    }
    // 3) poll status until terminal. For drafts, SEND_TO_USER_INBOX is success
    //    (the notification reached the creator's inbox). PUBLISH_COMPLETE only
    //    happens if the creator posts it from the app before we stop polling.
    const deadline = Date.now() + 120_000;
    let lastStatus = "PROCESSING_UPLOAD";
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        const statusResp = await tiktokJson("/v2/post/publish/status/fetch/", accessToken, {
            publish_id: publishId,
        });
        const sData = statusResp.data || {};
        lastStatus = String(sData.status || lastStatus);
        if (lastStatus === "SEND_TO_USER_INBOX" || lastStatus === "PUBLISH_COMPLETE") {
            return { publishId, status: lastStatus };
        }
        if (lastStatus === "FAILED") {
            throw new Error(`TikTok draft upload FAILED: ${String(sData.fail_reason || "unknown")}`);
        }
    }
    // Bytes accepted; TikTok is still moving it to the inbox. Not a failure — the
    // draft will land shortly. Return what we have.
    console.log(`[tiktok-publish] draft ${publishId} still ${lastStatus} after 120s — accepted, TikTok is finalizing to inbox`);
    return { publishId, status: lastStatus };
}
/* ──────────────────────────────────────────────────────────────────────────
 * OAuth token-grab flow (one-time) + daily refresh keep-alive.
 *
 * The refresh token is obtained ONCE by a human: visit GET /auth/tiktok, log in
 * as the target account, and copy the refresh token off the callback page into
 * the TIKTOK_REFRESH_TOKEN Fly secret. From then on getFreshAccessToken() (used
 * by every post) refreshes access tokens from it. All of this shares the single
 * token store above — there is deliberately no second store, because TikTok
 * rotates the refresh token on every refresh and two stores would invalidate
 * each other.
 * ────────────────────────────────────────────────────────────────────────── */
const AUTHORIZE_ENDPOINT = "https://www.tiktok.com/v2/auth/authorize/";
// This app is granted video.upload (draft upload to the creator's inbox), NOT
// video.publish (direct public posting). Space-separated, NOT comma-separated.
const OAUTH_SCOPES = "user.info.basic video.upload";
/** OAuth redirect URI — must EXACTLY match the URI registered in the TikTok app. */
function tiktokRedirectUri() {
    return (process.env.TIKTOK_REDIRECT_URI?.trim() ||
        "https://marco-90-automation.fly.dev/auth/tiktok/callback");
}
/**
 * Build the TikTok login URL. scope is space-separated and every value is
 * percent-encoded (space → %20), which the authorize endpoint requires.
 */
function buildTikTokAuthorizeUrl(state) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
    if (!clientKey)
        throw new Error("TIKTOK_CLIENT_KEY is not set");
    const params = [
        ["client_key", clientKey],
        ["scope", OAUTH_SCOPES],
        ["response_type", "code"],
        ["redirect_uri", tiktokRedirectUri()],
        ["state", state],
    ];
    const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return `${AUTHORIZE_ENDPOINT}?${query}`;
}
/**
 * Exchange the ?code from the /auth/tiktok/callback redirect for the initial
 * token pair (authorization_code grant), persisting it to the same store the
 * publisher refreshes from. Returns the refresh token so the callback page can
 * display it. Only needs the client key/secret (the refresh token doesn't exist
 * yet), so it does NOT call creds().
 */
async function exchangeCodeForToken(code) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim();
    if (!clientKey || !clientSecret) {
        throw new Error("TikTok OAuth not configured — set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET");
    }
    const res = await fetch(`${TIKTOK_API}/v2/oauth/token/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_key: clientKey,
            client_secret: clientSecret,
            code,
            grant_type: "authorization_code",
            redirect_uri: tiktokRedirectUri(),
        }),
    });
    const data = (await res.json().catch(() => ({})));
    const accessToken = typeof data.access_token === "string" ? data.access_token : "";
    const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
    if (!res.ok || !accessToken || !refreshToken) {
        const detail = data.error_description || data.error || JSON.stringify(data).slice(0, 300);
        throw new Error(`TikTok code exchange failed (HTTP ${res.status}): ${detail}`);
    }
    const expiresIn = Number(data.expires_in) || 86400;
    await writeStoredToken({ refreshToken, accessToken, accessExpiresAt: Date.now() + expiresIn * 1000 });
    return {
        refreshToken,
        accessToken,
        expiresIn,
        scope: typeof data.scope === "string" ? data.scope : undefined,
        openId: typeof data.open_id === "string" ? data.open_id : undefined,
    };
}
let refreshTimer = null;
/**
 * Keep the access token warm: refresh on startup and every 23h (access tokens
 * live ~24h), which also rotates + persists the refresh token so it never goes
 * stale between posts. Never throws — logs a note if not configured yet.
 */
function scheduleDailyTokenRefresh() {
    const runOnce = () => {
        if (!tiktokConfigured()) {
            console.log("[tiktok] daily refresh skipped — TIKTOK_REFRESH_TOKEN not set yet (visit /auth/tiktok)");
            return;
        }
        getFreshAccessToken()
            .then(() => console.log("[tiktok] daily token refresh OK"))
            .catch((err) => console.warn(`[tiktok] daily token refresh failed: ${err instanceof Error ? err.message : String(err)}`));
    };
    runOnce();
    if (refreshTimer)
        clearInterval(refreshTimer);
    refreshTimer = setInterval(runOnce, 23 * 60 * 60 * 1000);
}
