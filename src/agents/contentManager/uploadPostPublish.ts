/**
 * Upload-Post — unified multi-platform publishing (TikTok, Instagram, Facebook, …).
 *
 * Replaces the in-house TikTok OAuth integration. Upload-Post is a third-party
 * service that holds the OAuth connections for all platforms and exposes one
 * API-key interface (https://docs.upload-post.com). Social accounts are
 * connected in the Upload-Post dashboard under a profile name; our code just
 * needs the API key and that profile name.
 *
 * Env:
 *   UPLOAD_POST_API_KEY   — required. The Upload-Post API key.
 *   UPLOAD_POST_USER      — required for uploads. The Upload-Post profile name
 *                           that holds the connected TikTok/IG/FB accounts.
 *   UPLOAD_POST_FACEBOOK_PAGE_ID   — optional. Facebook destination page id.
 *   UPLOAD_POST_TIKTOK_PRIVACY     — optional. Default PUBLIC_TO_EVERYONE.
 *   UPLOAD_POST_TIKTOK_MODE        — optional. Default DIRECT_POST (public);
 *                                    set MEDIA_UPLOAD to send TikTok to drafts.
 *
 * NOTE on TikTok public vs draft: Upload-Post operates an APPROVED (audited)
 * TikTok Content Posting integration, so DIRECT_POST + PUBLIC_TO_EVERYONE is
 * available without us passing TikTok's audit — the draft-only limitation we
 * hit with our own unaudited client does not apply here. This is their
 * documented capability and should still be confirmed by a real test post.
 */
import { UploadPost, type VideoPlatform, type UploadVideoOptions } from "upload-post";

// The platforms this app targets. Upload-Post supports more, but clips only go
// to these three today.
const SUPPORTED: VideoPlatform[] = ["tiktok", "instagram", "facebook"];

export function uploadPostConfigured(): boolean {
  return Boolean(process.env.UPLOAD_POST_API_KEY?.trim());
}

/** The Upload-Post profile name that owns the connected social accounts. */
export function uploadPostUser(): string {
  return process.env.UPLOAD_POST_USER?.trim() || "";
}

function apiKey(): string {
  const k = process.env.UPLOAD_POST_API_KEY?.trim();
  if (!k) throw new Error("UPLOAD_POST_API_KEY is not set");
  return k;
}

let client: UploadPost | null = null;
function getClient(): UploadPost {
  if (!client) client = new UploadPost(apiKey());
  return client;
}

// A live connection probe (listUsers requires a valid key) is cached briefly so
// a page polling capabilities doesn't call Upload-Post on every render.
let connCache: { ok: boolean; at: number } | null = null;
const CONN_TTL_MS = 60_000;

/**
 * REAL connection check: connected only if UPLOAD_POST_API_KEY is set AND a live
 * authenticated call (listUsers) succeeds. A missing/invalid key → false, so the
 * UI honestly shows "Not connected" until account setup is complete. Never throws.
 */
export async function uploadPostConnected(): Promise<boolean> {
  if (!uploadPostConfigured()) return false;
  const now = Date.now();
  if (connCache && now - connCache.at < CONN_TTL_MS) return connCache.ok;
  try {
    const res = await getClient().listUsers();
    const ok = res?.success !== false;
    connCache = { ok, at: now };
    return ok;
  } catch (err) {
    console.warn(`[upload-post] connection check failed: ${err instanceof Error ? err.message : String(err)}`);
    connCache = { ok: false, at: now };
    return false;
  }
}

export interface SocialPublishResult {
  platform: string;
  success: boolean;
  url: string | null;
  postId: string | null;
  error: string | null;
}

/**
 * Publish one video to one or more platforms in a single Upload-Post call.
 * Returns a per-platform result — a partial failure (e.g. TikTok ok, Instagram
 * fails) is reported honestly, never collapsed into a blanket success.
 */
export async function publishToSocials(input: {
  videoPath: string;
  title: string;
  caption: string;
  hashtags: string[];
  platforms: string[];
  scheduledDate?: string | null;
}): Promise<{ results: SocialPublishResult[]; requestId: string | null; usage: { count: number; limit: number } | null }> {
  if (!uploadPostConfigured()) throw new Error("Upload-Post is not connected — set UPLOAD_POST_API_KEY.");
  const user = uploadPostUser();
  if (!user) {
    throw new Error("UPLOAD_POST_USER is not set (the Upload-Post profile name that holds the connected accounts).");
  }

  const platforms = input.platforms
    .map((p) => p.toLowerCase().trim())
    .filter((p): p is VideoPlatform => (SUPPORTED as string[]).includes(p));
  if (!platforms.length) {
    throw new Error(`No supported platforms in [${input.platforms.join(", ")}] (supported: ${SUPPORTED.join(", ")}).`);
  }

  // Upload-Post has no dedicated hashtag field — hashtags must live in the text.
  // Build the caption body (caption + hashtags) and use it as the post text on
  // every platform (title doubles as the caption on TikTok/Instagram).
  const tags = (input.hashtags || []).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  const body = [input.caption?.trim(), tags].filter(Boolean).join("\n\n") || input.title?.trim() || "";

  const options: UploadVideoOptions = {
    user,
    platforms,
    title: body,
    description: body,
    asyncUpload: false, // synchronous → per-platform results come back in the response
    tiktokPrivacyLevel: (process.env.UPLOAD_POST_TIKTOK_PRIVACY?.trim() ||
      "PUBLIC_TO_EVERYONE") as UploadVideoOptions["tiktokPrivacyLevel"],
    tiktokPostMode: (process.env.UPLOAD_POST_TIKTOK_MODE?.trim() ||
      "DIRECT_POST") as UploadVideoOptions["tiktokPostMode"],
    instagramMediaType: "REELS",
  };
  const fbPageId = process.env.UPLOAD_POST_FACEBOOK_PAGE_ID?.trim();
  if (fbPageId) options.facebookPageId = fbPageId;
  if (input.scheduledDate) options.scheduledDate = input.scheduledDate;

  let resp: Awaited<ReturnType<UploadPost["upload"]>>;
  try {
    resp = await getClient().upload(input.videoPath, options);
  } catch (err) {
    // A thrown error means the whole call failed (auth, network, quota). Report
    // it for every requested platform rather than swallowing it.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[upload-post] upload failed: ${msg}`);
    return {
      results: platforms.map((p) => ({ platform: p, success: false, url: null, postId: null, error: msg })),
      requestId: null,
      usage: null,
    };
  }

  const perPlatform = Array.isArray(resp?.data?.platforms) ? resp.data!.platforms! : [];
  const byName = new Map(perPlatform.map((x) => [String(x.name).toLowerCase(), x]));
  // When scheduled or when the API returns no per-platform breakdown, fall back
  // to the overall success flag.
  const overallOk = resp?.success === true;

  const results: SocialPublishResult[] = platforms.map((p) => {
    const r = byName.get(p);
    if (r) {
      const success = !r.error;
      const anyId = r as unknown as Record<string, unknown>;
      const postId = (anyId.post_id as string) || (anyId.id as string) || null;
      return { platform: p, success, url: r.url || null, postId, error: r.error || null };
    }
    return {
      platform: p,
      success: overallOk,
      url: null,
      postId: resp?.request_id || null,
      error: overallOk ? null : resp?.message || "No result returned for this platform",
    };
  });

  const rawUsage = (resp as unknown as Record<string, unknown>).usage as
    | { count?: unknown; limit?: unknown }
    | undefined;
  const usage = rawUsage
    ? { count: Number(rawUsage.count) || 0, limit: Number(rawUsage.limit) || 0 }
    : null;

  const failed = results.filter((r) => !r.success);
  if (failed.length) {
    console.error(`[upload-post] partial/failed publish: ${failed.map((f) => `${f.platform}=${f.error}`).join("; ")}`);
  }

  return { results, requestId: resp?.request_id || null, usage };
}
