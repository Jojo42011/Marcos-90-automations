"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.instagramConfigured = instagramConfigured;
exports.facebookConfigured = facebookConfigured;
exports.buildSignedClipUrl = buildSignedClipUrl;
exports.verifySignedClip = verifySignedClip;
exports.postReelToInstagram = postReelToInstagram;
exports.postVideoToFacebookPage = postVideoToFacebookPage;
exports.validateMeta = validateMeta;
/**
 * Meta Graph API posting — Instagram Reels + Facebook Page video (official).
 *
 * Instagram is a two-step, URL-based flow (Meta cURLs the video, so it must be
 * at a public URL): create a REELS media container → poll status_code until
 * FINISHED → media_publish. Facebook Page video posts via /{page}/videos with
 * a file_url. Both need a long-lived (or System User) token with the right
 * scopes (instagram_content_publish / pages_manage_posts).
 *
 * Since Meta fetches the video by URL, we mint a short-lived HMAC-signed public
 * clip URL (see buildSignedClipUrl / verifySignedClip) so the clip is reachable
 * without exposing the dashboard token.
 *
 * Required env:
 *   INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ACCOUNT_ID   (Instagram)
 *   FACEBOOK_PAGE_ACCESS_TOKEN, FACEBOOK_PAGE_ID            (Facebook)
 *   PUBLIC_BASE_URL   (https base the app is reachable at, for the video URL)
 *   DASHBOARD_TOKEN   (used as the signing key for clip URLs)
 * Optional: META_GRAPH_VERSION (default v21.0)
 */
const crypto_1 = __importDefault(require("crypto"));
const GRAPH = "https://graph.facebook.com";
function graphVersion() {
    return process.env.META_GRAPH_VERSION?.trim() || "v21.0";
}
function publicBaseUrl() {
    return (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}
function signingKey() {
    return process.env.DASHBOARD_TOKEN?.trim() || process.env.CLIP_URL_SECRET?.trim() || "";
}
function instagramConfigured() {
    return Boolean(process.env.INSTAGRAM_ACCESS_TOKEN?.trim() &&
        process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID?.trim() &&
        publicBaseUrl() &&
        signingKey());
}
function facebookConfigured() {
    return Boolean(process.env.FACEBOOK_PAGE_ACCESS_TOKEN?.trim() &&
        process.env.FACEBOOK_PAGE_ID?.trim() &&
        publicBaseUrl() &&
        signingKey());
}
/** Short-lived HMAC-signed public URL for one clip, for Meta to fetch. */
function buildSignedClipUrl(videoId, ttlSeconds = 7200) {
    const base = publicBaseUrl();
    if (!base) {
        throw new Error("PUBLIC_BASE_URL is not set — Instagram/Facebook need a public video URL to fetch.");
    }
    const key = signingKey();
    if (!key)
        throw new Error("No clip-URL signing key — set DASHBOARD_TOKEN.");
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = crypto_1.default.createHmac("sha256", key).update(`${videoId}.${exp}`).digest("hex");
    return `${base}/api/content/public-clip/${encodeURIComponent(videoId)}?exp=${exp}&sig=${sig}`;
}
/** Verify a signed clip URL (used by the public streaming route). */
function verifySignedClip(videoId, exp, sig) {
    const key = signingKey();
    if (!key || !exp || !sig)
        return false;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000))
        return false;
    const expected = crypto_1.default.createHmac("sha256", key).update(`${videoId}.${expNum}`).digest("hex");
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"));
    }
    catch {
        return false;
    }
}
async function graphRequest(method, path, params) {
    const url = `${GRAPH}${path}`;
    let res;
    if (method === "GET") {
        res = await fetch(`${url}?${new URLSearchParams(params).toString()}`);
    }
    else {
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(params),
        });
    }
    const data = (await res.json().catch(() => ({})));
    const err = data.error;
    if (!res.ok || err) {
        throw new Error(`Meta Graph ${method} ${path} failed (HTTP ${res.status}): ${err?.message || JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Post a Reel to Instagram. `videoUrl` must be publicly fetchable. Returns media id. */
async function postReelToInstagram(videoUrl, caption) {
    const igId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID.trim();
    const token = process.env.INSTAGRAM_ACCESS_TOKEN.trim();
    const v = graphVersion();
    const container = await graphRequest("POST", `/${v}/${igId}/media`, {
        media_type: "REELS",
        video_url: videoUrl,
        caption: caption.slice(0, 2200),
        access_token: token,
    });
    const creationId = String(container.id || "");
    if (!creationId)
        throw new Error(`Instagram container not created: ${JSON.stringify(container).slice(0, 200)}`);
    // Poll processing status — Meta recommends ~once/min for up to 5 min.
    const deadline = Date.now() + 5 * 60 * 1000;
    let status = "IN_PROGRESS";
    while (Date.now() < deadline) {
        await sleep(8000);
        const s = await graphRequest("GET", `/${v}/${creationId}`, { fields: "status_code", access_token: token });
        status = String(s.status_code || "");
        if (status === "FINISHED")
            break;
        if (status === "ERROR" || status === "EXPIRED") {
            throw new Error(`Instagram media container ${status} before publish`);
        }
    }
    if (status !== "FINISHED") {
        throw new Error(`Instagram media still ${status} after 5 min — not published`);
    }
    const published = await graphRequest("POST", `/${v}/${igId}/media_publish`, {
        creation_id: creationId,
        access_token: token,
    });
    const mediaId = String(published.id || "");
    if (!mediaId)
        throw new Error(`Instagram media_publish returned no id: ${JSON.stringify(published).slice(0, 200)}`);
    return { mediaId };
}
/** Post a video to a Facebook Page. `videoUrl` must be publicly fetchable. Returns video id. */
async function postVideoToFacebookPage(videoUrl, description) {
    const pageId = process.env.FACEBOOK_PAGE_ID.trim();
    const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN.trim();
    const v = graphVersion();
    const resp = await graphRequest("POST", `/${v}/${pageId}/videos`, {
        file_url: videoUrl,
        description: description.slice(0, 5000),
        access_token: token,
    });
    const videoId = String(resp.id || "");
    if (!videoId)
        throw new Error(`Facebook video post returned no id: ${JSON.stringify(resp).slice(0, 200)}`);
    return { videoId };
}
// Cache live validation so the capabilities endpoint isn't a Graph call on
// every dashboard load. { ok, error, at }
const _validationCache = new Map();
const VALIDATION_TTL_MS = 5 * 60 * 1000;
/**
 * Real connectivity check — actually calls the Graph API to confirm the token
 * works for the target account (not just that env vars are present). Cached.
 */
async function validateMeta(platform) {
    const cached = _validationCache.get(platform);
    if (cached && Date.now() - cached.at < VALIDATION_TTL_MS) {
        return { ok: cached.ok, error: cached.error };
    }
    let result;
    try {
        const v = graphVersion();
        if (platform === "instagram") {
            if (!instagramConfigured())
                throw new Error("not configured");
            const igId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID.trim();
            const token = process.env.INSTAGRAM_ACCESS_TOKEN.trim();
            const d = await graphRequest("GET", `/${v}/${igId}`, { fields: "id,username", access_token: token });
            result = { ok: Boolean(d.id) };
        }
        else {
            if (!facebookConfigured())
                throw new Error("not configured");
            const pageId = process.env.FACEBOOK_PAGE_ID.trim();
            const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN.trim();
            const d = await graphRequest("GET", `/${v}/${pageId}`, { fields: "id,name", access_token: token });
            result = { ok: Boolean(d.id) };
        }
    }
    catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    _validationCache.set(platform, { ...result, at: Date.now() });
    return result;
}
