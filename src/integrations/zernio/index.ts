/**
 * Zernio — social analytics provider.
 *
 * Marco is wiring the account up separately, so this ships as a real client
 * that is INERT until `ZERNIO_API_KEY` is set. Unconfigured it reports
 * `configured: false` and returns no numbers at all — it never invents a
 * follower count to make the page look finished. An analytics screen showing
 * plausible-but-fake numbers is worse than an empty one: the whole point is
 * deciding what to post next, and a fabricated baseline poisons that.
 *
 * WHAT IS AND ISN'T VERIFIED HERE
 * The transport (config, auth header, timeout, error handling, normalisation
 * into the app's `PlatformMetrics` shape) is written and tested. The exact
 * response FIELD NAMES are not — I don't have Zernio's docs or a key, so
 * `mapZernioPayload` reads a set of common spellings and, when it recognises
 * nothing, says so explicitly rather than silently returning zeros. Zero and
 * "we couldn't read the response" must never look the same on a metrics page.
 *
 * To finish the wiring: set ZERNIO_API_KEY (and ZERNIO_BASE_URL if their host
 * differs), hit /api/analytics/platforms?debug=1 to see the raw payload, then
 * correct the field names in mapZernioPayload. Nothing else needs to change.
 */

export interface ZernioPlatformStats {
  followers: number | null;
  posts: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** Anything the mapper didn't recognise, kept for debugging the wiring. */
  raw?: unknown;
}

export interface ZernioFetchResult {
  ok: boolean;
  configured: boolean;
  stats?: ZernioPlatformStats;
  error?: string;
  /** True when the request succeeded but no known field could be read. */
  unmapped?: boolean;
}

const DEFAULT_BASE = "https://api.zernio.com";
const TIMEOUT_MS = 12000;

export function isZernioConfigured(): boolean {
  return Boolean(process.env.ZERNIO_API_KEY?.trim());
}

export function zernioBaseUrl(): string {
  return (process.env.ZERNIO_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

/** First numeric value among candidate keys, at the top level or one nested. */
function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * Normalise whatever Zernio returns into the app's shape.
 *
 * Deliberately tolerant about naming (`followers` / `follower_count` /
 * `followersCount`) because provider APIs vary, and deliberately intolerant
 * about failure: if nothing maps, `unmapped` is set so the UI can say "we
 * reached Zernio but couldn't read the response" instead of showing zeros.
 */
export function mapZernioPayload(payload: unknown): { stats: ZernioPlatformStats; unmapped: boolean } {
  const root = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  // Providers commonly nest under data/result/metrics/stats.
  const nestedKey = ["data", "result", "metrics", "stats", "summary"].find(
    (k) => root[k] && typeof root[k] === "object" && !Array.isArray(root[k]),
  );
  const src = (nestedKey ? root[nestedKey] : root) as Record<string, unknown>;

  const stats: ZernioPlatformStats = {
    followers: pickNumber(src, ["followers", "follower_count", "followersCount", "fans", "subscribers", "subscriberCount"]),
    posts: pickNumber(src, ["posts", "post_count", "postsCount", "media_count", "videos", "videoCount", "totalPosts"]),
    views: pickNumber(src, ["views", "view_count", "viewsCount", "impressions", "totalViews", "plays"]),
    likes: pickNumber(src, ["likes", "like_count", "likesCount", "totalLikes", "reactions"]),
    comments: pickNumber(src, ["comments", "comment_count", "commentsCount", "totalComments"]),
    shares: pickNumber(src, ["shares", "share_count", "sharesCount", "totalShares", "reposts"]),
  };

  const unmapped = Object.values(stats).every((v) => v === null);
  if (unmapped) stats.raw = payload;
  return { stats, unmapped };
}

/**
 * Fetch one platform's stats.
 *
 * Resolves with `ok:false` rather than throwing — an analytics page must be
 * able to render "Instagram: couldn't load" next to a working TikTok tab, not
 * fall over entirely because one provider is down.
 */
export async function fetchZernioPlatform(platform: string): Promise<ZernioFetchResult> {
  const key = process.env.ZERNIO_API_KEY?.trim();
  if (!key) return { ok: false, configured: false, error: "ZERNIO_API_KEY is not set" };

  const url = `${zernioBaseUrl()}/v1/analytics/${encodeURIComponent(platform)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, configured: true, error: `Zernio returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const { stats, unmapped } = mapZernioPayload(await res.json());
    return { ok: true, configured: true, stats, unmapped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, configured: true, error: /abort/i.test(msg) ? `Zernio timed out after ${TIMEOUT_MS / 1000}s` : msg };
  } finally {
    clearTimeout(timer);
  }
}
