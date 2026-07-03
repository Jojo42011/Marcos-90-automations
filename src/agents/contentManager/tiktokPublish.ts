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
import { promises as fs } from "fs";
import path from "path";

const TIKTOK_API = "https://open.tiktokapis.com";
const SINGLE_CHUNK_MAX = 64 * 1024 * 1024; // TikTok allows a single chunk up to 64MB.

type TokenState = { refreshToken: string; accessToken?: string; accessExpiresAt?: number };

function tokenStorePath(): string {
  const base = process.env.TIKTOK_TOKEN_STORE || (process.env.DATA_DIR || "/data");
  return path.join(base, ".tiktok_tokens.json");
}

function creds(): { clientKey: string; clientSecret: string; refreshToken: string } {
  const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim() || "";
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim() || "";
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN?.trim() || "";
  if (!clientKey || !clientSecret || !refreshToken) {
    throw new Error(
      "TikTok is not fully configured — set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and " +
        "TIKTOK_REFRESH_TOKEN (a user token from the video.publish OAuth consent).",
    );
  }
  return { clientKey, clientSecret, refreshToken };
}

/** True when all credentials needed to post are present. */
export function tiktokConfigured(): boolean {
  return Boolean(
    process.env.TIKTOK_CLIENT_KEY?.trim() &&
      process.env.TIKTOK_CLIENT_SECRET?.trim() &&
      process.env.TIKTOK_REFRESH_TOKEN?.trim(),
  );
}

/** Default privacy — unaudited apps may only use SELF_ONLY (private). */
export function tiktokPrivacyLevel(): string {
  const override = process.env.TIKTOK_PRIVACY_LEVEL?.trim();
  if (override) return override;
  const audited = /^(1|true|yes)$/i.test(process.env.TIKTOK_AUDITED?.trim() || "");
  return audited ? "PUBLIC_TO_EVERYONE" : "SELF_ONLY";
}

export function tiktokAudited(): boolean {
  return /^(1|true|yes)$/i.test(process.env.TIKTOK_AUDITED?.trim() || "");
}

async function readStoredToken(): Promise<TokenState | null> {
  try {
    const raw = await fs.readFile(tokenStorePath(), "utf8");
    const parsed = JSON.parse(raw) as TokenState;
    return parsed?.refreshToken ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStoredToken(state: TokenState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(tokenStorePath()), { recursive: true });
    await fs.writeFile(tokenStorePath(), JSON.stringify(state), "utf8");
  } catch (err) {
    // Non-fatal: we can still post this time, but the rotated refresh token
    // wasn't saved — the NEXT post may need a fresh token. Surface loudly.
    console.warn(
      `[tiktok-publish] could not persist rotated refresh token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Exchange the refresh token for a fresh access token. TikTok rotates the
 * refresh token on each call, so the new one is persisted for next time.
 */
async function getFreshAccessToken(): Promise<string> {
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
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    const detail = data.error_description || data.error || JSON.stringify(data).slice(0, 300);
    throw new Error(`TikTok token refresh failed (HTTP ${res.status}): ${detail}`);
  }

  const accessToken = data.access_token as string;
  const newRefresh = (data.refresh_token as string) || refreshToken;
  const expiresIn = Number(data.expires_in) || 86400;
  await writeStoredToken({
    refreshToken: newRefresh,
    accessToken,
    accessExpiresAt: Date.now() + expiresIn * 1000,
  });
  return accessToken;
}

async function tiktokJson(
  endpoint: string,
  accessToken: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${TIKTOK_API}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const error = (data.error as Record<string, unknown>) || {};
  if (!res.ok || (error.code && error.code !== "ok")) {
    throw new Error(
      `TikTok ${endpoint} failed (HTTP ${res.status}): ${error.code || ""} ${error.message || JSON.stringify(data).slice(0, 300)}`.trim(),
    );
  }
  return data;
}

/**
 * Post a video file to TikTok. Returns the publish_id. Throws with the real
 * TikTok error on any failure (expired token, spam cap, audit restriction, …).
 */
export async function postVideoToTikTok(
  filePath: string,
  caption: string,
  opts?: { privacyLevel?: string },
): Promise<{ publishId: string }> {
  if (!filePath) throw new Error("TikTok post: no video file path");
  const bytes = await fs.readFile(filePath);
  const videoSize = bytes.byteLength;
  if (videoSize === 0) throw new Error(`TikTok post: video file is empty (${filePath})`);
  if (videoSize > SINGLE_CHUNK_MAX) {
    // Our clips are short, downscaled, and comfortably under 64MB; multi-chunk
    // upload isn't implemented. Fail clearly rather than send a bad request.
    throw new Error(
      `TikTok post: video is ${(videoSize / 1024 / 1024).toFixed(1)}MB, over the ${SINGLE_CHUNK_MAX / 1024 / 1024}MB single-chunk limit (multi-chunk upload not implemented).`,
    );
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
  const initData = (init.data as Record<string, unknown>) || {};
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
    const sData = (statusResp.data as Record<string, unknown>) || {};
    lastStatus = String(sData.status || lastStatus);
    if (lastStatus === "PUBLISH_COMPLETE") return { publishId };
    if (lastStatus === "FAILED") {
      throw new Error(`TikTok publish FAILED: ${String(sData.fail_reason || "unknown")}`);
    }
  }
  // Uploaded and accepted, still processing on TikTok's side — not a failure.
  console.log(`[tiktok-publish] publish ${publishId} still ${lastStatus} after 120s — accepted, TikTok is finalizing`);
  return { publishId };
}
