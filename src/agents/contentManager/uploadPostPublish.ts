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
  // success = genuinely confirmed live; failed = confirmed failure;
  // pending = accepted but not yet confirmed (timed out while polling).
  state: "success" | "failed" | "pending";
  success: boolean; // convenience: state === "success"
  url: string | null; // real post_url once confirmed
  postId: string | null; // platform_post_id (or request_id while pending)
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
}): Promise<{ results: SocialPublishResult[]; requestId: string | null; usage: { count: number; limit: number } | null; confirmed: boolean }> {
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
    // TikTok/Instagram posting completes ASYNCHRONOUSLY on Upload-Post's side —
    // the upload() response only means "accepted". We poll getStatus() below for
    // the REAL per-platform result rather than trusting the initial response.
    asyncUpload: true,
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
    // A thrown error means the whole call was rejected (auth, network, quota) —
    // a terminal FAILURE for every requested platform. Never swallow it.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[upload-post] upload rejected: ${msg}`);
    return {
      results: platforms.map((p) => ({ platform: p, state: "failed" as const, success: false, url: null, postId: null, error: msg })),
      requestId: null,
      usage: null,
      confirmed: true,
    };
  }

  const requestId = resp?.request_id || null;
  const usage = readUsage(resp);

  // Scheduled/queued: Upload-Post accepted it for LATER — it isn't posted now, so
  // there's nothing to poll. Report acceptance; the clip is marked "scheduled"
  // upstream, not "published".
  if (input.scheduledDate) {
    const accepted = resp?.success !== false;
    return {
      results: platforms.map((p) => ({
        platform: p,
        state: "pending" as const,
        success: false,
        url: null,
        postId: requestId,
        error: accepted ? null : resp?.message || "scheduling rejected",
      })),
      requestId,
      usage,
      confirmed: accepted,
    };
  }

  // Immediate publish — poll getStatus(request_id) until each platform reaches a
  // genuine terminal state (success with post_url, or a real failure). We do NOT
  // treat "accepted" as "published".
  const POLL_TOTAL_MS = 180_000; // up to ~3 min (posts confirmed in ~2 min in testing)
  const POLL_EVERY_MS = 5_000;
  const wanted = platforms.map((p) => String(p));
  let statusResults: Array<Record<string, unknown>> = [];
  let confirmed = false;

  if (requestId) {
    const deadline = Date.now() + POLL_TOTAL_MS;
    while (Date.now() < deadline) {
      let st: Record<string, unknown> | null = null;
      try {
        st = (await getClient().getStatus(requestId)) as unknown as Record<string, unknown>;
      } catch {
        /* transient — keep polling */
      }
      if (st) {
        const overall = String(st.status || "").toLowerCase();
        const rs = Array.isArray(st.results) ? (st.results as Array<Record<string, unknown>>) : [];
        if (rs.length) statusResults = rs;
        const everyResolved = wanted.every((p) =>
          rs.some((x) => String(x.platform).toLowerCase() === p && x.success !== null && x.success !== undefined),
        );
        if (overall === "completed" || overall === "failed" || everyResolved) {
          confirmed = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    }
  } else {
    // No request_id to poll — fall back to any per-platform breakdown the initial
    // response happened to carry.
    statusResults = (Array.isArray(resp?.data?.platforms) ? resp.data!.platforms! : []).map((x) => ({
      platform: x.name,
      success: x.error ? false : Boolean(x.url),
      post_url: x.url,
      error_message: x.error,
    }));
    confirmed = statusResults.length > 0;
  }

  const byName = new Map(statusResults.map((x) => [String(x.platform).toLowerCase(), x]));
  const results: SocialPublishResult[] = platforms.map((p) => {
    const r = byName.get(p);
    if (r && r.success !== null && r.success !== undefined) {
      const ok = r.success === true;
      return {
        platform: p,
        state: ok ? "success" : "failed",
        success: ok,
        url: (r.post_url as string) || null,
        postId: (r.platform_post_id as string) || (r.post_url as string) || null,
        error: (r.error_message as string) || null,
      };
    }
    // Accepted but never confirmed within the window — honest "pending", NOT success.
    return { platform: p, state: "pending", success: false, url: null, postId: requestId, error: null };
  });

  const failed = results.filter((r) => r.state === "failed");
  const pending = results.filter((r) => r.state === "pending");
  if (failed.length) console.error(`[upload-post] confirmed failures: ${failed.map((f) => `${f.platform}=${f.error}`).join("; ")}`);
  if (pending.length) console.warn(`[upload-post] unconfirmed after ${POLL_TOTAL_MS / 1000}s (request ${requestId}): ${pending.map((p) => p.platform).join(", ")}`);

  return { results, requestId, usage, confirmed };
}

function readUsage(resp: unknown): { count: number; limit: number } | null {
  const rawUsage = (resp as Record<string, unknown> | null | undefined)?.usage as
    | { count?: unknown; limit?: unknown }
    | undefined;
  return rawUsage ? { count: Number(rawUsage.count) || 0, limit: Number(rawUsage.limit) || 0 } : null;
}
