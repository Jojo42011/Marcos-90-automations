/**
 * Zernio social analytics — real API at https://zernio.com/api/v1.
 *
 * Uses the same API key value as DMs (`ZERNIO_DM_API_KEY`, with `ZERNIO_API_KEY`
 * as a fallback). Every active account on the current Zernio profile is fetched
 * (TikTok, Instagram, Facebook, YouTube, …). Inactive / missing platforms stay
 * honest not_connected — never fabricated zeros.
 *
 * Docs: GET /v1/analytics?platform=…, platform account-insights endpoints,
 * GET /v1/accounts/follower-stats, GET /v1/accounts.
 */
import { currentZernioSecrets } from "../../core/zernioOwnerConfig.js";

export interface ZernioPlatformStats {
  followers: number | null;
  posts: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  profileViews: number | null;
  followsFromPosts: number | null;
  topPost: { url: string | null; caption: string | null; views: number | null } | null;
  postsDetail: ZernioPostRow[];
  raw?: unknown;
}

export interface ZernioPostRow {
  availableMetrics?: string[];
  id: string;
  url: string | null;
  caption: string | null;
  publishedAt: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  reach: number | null;
  follows: number | null;
  profileViews: number | null;
  completionRate: number | null;
}

export interface ZernioAccountRef {
  id: string;
  platform: string;
  username: string | null;
  active: boolean;
}

export interface ZernioFetchResult {
  ok: boolean;
  configured: boolean;
  stats?: ZernioPlatformStats;
  error?: string;
  unmapped?: boolean;
  accountUsername?: string | null;
  accountId?: string;
  platform?: string;
}

const DEFAULT_BASE = "https://zernio.com/api/v1";
const TIMEOUT_MS = 20000;

const INSIGHTS_PATH: Record<string, string> = {
  tiktok: "/analytics/tiktok/account-insights",
  instagram: "/analytics/instagram/account-insights",
  facebook: "/analytics/facebook/page-insights",
  youtube: "/analytics/youtube/channel-insights",
};

export function isZernioConfigured(): boolean {
  return Boolean(currentZernioSecrets().apiKey);
}

export function zernioBaseUrl(): string {
  return (process.env.ZERNIO_API_BASE?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

function apiKey(): string {
  return currentZernioSecrets().apiKey;
}

function preferredAccountId(): string {
  return currentZernioSecrets().tiktokAccountId;
}

async function zernioGet(path: string): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const key = apiKey();
  if (!key) return { ok: false, status: 0, json: null, text: "ZERNIO_DM_API_KEY is not set" };
  const res = await fetch(`${zernioBaseUrl()}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { ok: res.ok, status: res.status, json, text };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Insights envelopes use metrics.<name>.total (and occasionally a bare number). */
export function metricTotal(metrics: Record<string, unknown> | null | undefined, names: string[]): number | null {
  if (!metrics) return null;
  for (const name of names) {
    const raw = metrics[name];
    if (raw == null) continue;
    if (typeof raw === "number" || typeof raw === "string") {
      const n = num(raw);
      if (n != null) return n;
      continue;
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
      const total = num((raw as Record<string, unknown>).total);
      if (total != null) return total;
      const value = num((raw as Record<string, unknown>).value);
      if (value != null) return value;
    }
  }
  return null;
}

function analyticsOf(post: Record<string, unknown>): Record<string, unknown> {
  const a = post.analytics;
  return a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}

export function mapPost(post: Record<string, unknown>): ZernioPostRow {
  const a = analyticsOf(post);
  return {
    availableMetrics: ["views","likes","comments","shares","saves"].filter(k => num(a[k]) != null),
    id: String(post._id ?? post.id ?? post.postId ?? ""),
    url: str(post.platformPostUrl) ?? str(post.url),
    caption: str(post.content) ?? str(post.caption) ?? str(post.description) ?? str(post.text) ?? str(post.title),
    publishedAt: str(post.publishedAt) ?? str(post.createdAt),
    views: num(a.views) ?? 0,
    likes: num(a.likes) ?? 0,
    comments: num(a.comments) ?? 0,
    shares: num(a.shares) ?? 0,
    saves: num(a.saves) ?? 0,
    reach: num(a.reach),
    follows: num(a.follows),
    profileViews: num(a.profileViews),
    completionRate: num(a.completionRate),
  };
}

export async function listZernioAccounts(): Promise<{
  ok: boolean;
  accounts: ZernioAccountRef[];
  error?: string;
}> {
  if (!apiKey()) return { ok: false, accounts: [], error: "ZERNIO_DM_API_KEY is not set" };
  try {
    const r = await zernioGet("/accounts");
    if (!r.ok) return { ok: false, accounts: [], error: r.text.slice(0, 300) || `HTTP ${r.status}` };
    const payload = r.json as { accounts?: Record<string, unknown>[] } | null;
    const list = Array.isArray(payload?.accounts) ? payload!.accounts! : [];
    return {
      ok: true,
      accounts: list.map((a) => ({
        id: String(a._id ?? a.id ?? ""),
        platform: String(a.platform ?? "").toLowerCase(),
        username: str(a.username) ?? str(a.displayName),
        active: a.isActive !== false && a.needsReconnection !== true,
      })).filter((a) => a.id && a.platform),
    };
  } catch (err) {
    return { ok: false, accounts: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchPostAnalytics(platform: string, accountId?: string): Promise<{
  ok: boolean;
  posts: ZernioPostRow[];
  error?: string;
}> {
  const qs = new URLSearchParams({ platform, limit: "100", page: "1", sortBy: "engagement", order: "desc" });
  if (accountId) qs.set("accountId", accountId);
  const to = new Date();
  const from = new Date(Date.now() - 90 * 864e5);
  qs.set("fromDate", from.toISOString().slice(0, 10));
  qs.set("toDate", to.toISOString().slice(0, 10));

  const r = await zernioGet(`/analytics?${qs}`);
  if (!r.ok) return { ok: false, posts: [], error: r.text.slice(0, 300) || `HTTP ${r.status}` };
  const payload = r.json as { posts?: Record<string, unknown>[]; data?: Record<string, unknown>[] } | null;
  const list = Array.isArray(payload?.posts)
    ? payload!.posts!
    : Array.isArray(payload?.data)
      ? payload!.data!
      : [];
  return { ok: true, posts: list.map(mapPost) };
}

/** Latest follower counts from the cross-platform snapshotter. */
export async function fetchFollowerStats(accountIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(accountIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length || !apiKey()) return out;
  try {
    const qs = new URLSearchParams({ accountIds: ids.join(",") });
    const r = await zernioGet(`/accounts/follower-stats?${qs}`);
    if (!r.ok || !r.json || typeof r.json !== "object") return out;
    const root = r.json as { accounts?: Record<string, unknown>[] };
    for (const row of Array.isArray(root.accounts) ? root.accounts : []) {
      const id = String(row._id ?? row.id ?? row.accountId ?? "");
      const followers = num(row.currentFollowers) ?? num(row.followers);
      if (id && followers != null) out.set(id, followers);
    }
  } catch {
    /* optional enrichment */
  }
  return out;
}

interface AccountInsightRollup {
  followers: number | null;
  likes: number | null;
  posts: number | null;
  views: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  profileViews: number | null;
  followsFromPosts: number | null;
}

async function fetchAccountInsights(platform: string, accountId: string): Promise<AccountInsightRollup> {
  const empty: AccountInsightRollup = {
    followers: null, likes: null, posts: null, views: null, comments: null,
    shares: null, saves: null, reach: null, profileViews: null, followsFromPosts: null,
  };
  const path = INSIGHTS_PATH[platform];
  if (!path) return empty;
  try {
    const qs = new URLSearchParams({ accountId });
    const r = await zernioGet(`${path}?${qs}`);
    if (!r.ok || !r.json || typeof r.json !== "object") return empty;
    const root = r.json as Record<string, unknown>;
    const metrics = (root.metrics && typeof root.metrics === "object" && !Array.isArray(root.metrics)
      ? root.metrics
      : null) as Record<string, unknown> | null;
    // Legacy parsers looked at top-level / nested bags; keep that as a fallback.
    const nested = ["data", "result", "metrics", "stats", "summary", "account"]
      .map((k) => root[k])
      .find((v) => v && typeof v === "object" && !Array.isArray(v)) as Record<string, unknown> | undefined;
    const src = nested || root;

    const followers =
      metricTotal(metrics, ["follower_count", "followers", "page_follows", "page_fans", "subscribers", "subscriberCount"]) ??
      num(src.follower_count) ?? num(src.followers) ?? num(src.followerCount) ?? num(src.page_follows);

    const likes =
      metricTotal(metrics, ["likes_count", "likes", "page_post_engagements", "total_interactions"]) ??
      num(src.likes_count) ?? num(src.likes) ?? num(src.heartCount);

    const posts =
      metricTotal(metrics, ["video_count", "videos", "videoCount", "posts", "media_count"]) ??
      num(src.video_count) ?? num(src.videos) ?? num(src.videoCount);

    const views =
      metricTotal(metrics, ["views", "page_media_view", "page_total_media_view", "impressions"]) ??
      num(src.views);

    const comments = metricTotal(metrics, ["comments"]);
    const shares = metricTotal(metrics, ["shares"]);
    const saves = metricTotal(metrics, ["saves"]);
    const reach = metricTotal(metrics, ["reach", "page_impressions_unique", "page_total_media_view_unique"]);
    const profileViews = metricTotal(metrics, ["profile_views", "profileViews"]);
    const followsFromPosts =
      metricTotal(metrics, ["follows_and_unfollows", "followers_gained", "subscribersGained", "follows"]) ??
      null;

    return {
      followers,
      likes,
      posts,
      views,
      comments,
      shares,
      saves,
      reach,
      profileViews,
      followsFromPosts,
    };
  } catch {
    return empty;
  }
}

function pickAccount(accounts: ZernioAccountRef[], platform: string, accountId?: string): ZernioAccountRef | null {
  const wanted = platform.toLowerCase();
  const preferred = preferredAccountId();
  if (accountId) {
    return accounts.find((a) => a.id === accountId) || null;
  }
  return (
    accounts.find((a) => a.platform === wanted && a.active && (!preferred || a.id === preferred || wanted !== "tiktok")) ||
    accounts.find((a) => a.platform === wanted && a.active) ||
    accounts.find((a) => a.platform === wanted) ||
    null
  );
}

/**
 * Fetch one connected account's roll-up (posts + account insights + follower snapshot).
 */
export async function fetchZernioAccount(
  account: ZernioAccountRef,
  followerOverride?: number | null,
): Promise<ZernioFetchResult> {
  if (!apiKey()) return { ok: false, configured: false, error: "ZERNIO_DM_API_KEY is not set" };
  try {
    const wanted = account.platform.toLowerCase();
    const [postsRes, insights] = await Promise.all([
      fetchPostAnalytics(wanted, account.id),
      fetchAccountInsights(wanted, account.id),
    ]);
    if (!postsRes.ok && insights.followers == null && insights.views == null && followerOverride == null) {
      return {
        ok: false,
        configured: true,
        accountId: account.id,
        platform: wanted,
        accountUsername: account.username,
        error: postsRes.error || "Analytics request failed",
      };
    }

    const posts = postsRes.ok ? postsRes.posts : [];
    const viewsFromPosts = posts.reduce((s, p) => s + p.views, 0);
    const likesFromPosts = posts.reduce((s, p) => s + p.likes, 0);
    const commentsFromPosts = posts.reduce((s, p) => s + p.comments, 0);
    const sharesFromPosts = posts.reduce((s, p) => s + p.shares, 0);
    const savesFromPosts = posts.reduce((s, p) => s + p.saves, 0);
    const reachVals = posts.map((p) => p.reach).filter((v): v is number => v != null);
    const followsVals = posts.map((p) => p.follows).filter((v): v is number => v != null);
    const profileViewVals = posts.map((p) => p.profileViews).filter((v): v is number => v != null);
    const top = posts.slice().sort((a, b) => b.views - a.views)[0] || null;

    const followers = followerOverride ?? insights.followers;
    const views = posts.length ? viewsFromPosts : insights.views;
    const likes = posts.length ? likesFromPosts : insights.likes;
    const comments = posts.length ? commentsFromPosts : insights.comments;
    const shares = posts.length ? sharesFromPosts : insights.shares;
    const saves = posts.length ? savesFromPosts : insights.saves;
    const postsCount = insights.posts != null ? insights.posts : (posts.length ? posts.length : null);

    const unmapped =
      posts.length === 0 &&
      followers == null &&
      views == null &&
      likes == null &&
      postsCount == null;

    return {
      ok: true,
      configured: true,
      accountId: account.id,
      platform: wanted,
      accountUsername: account.username,
      unmapped,
      stats: {
        followers,
        posts: postsCount,
        views,
        likes,
        comments,
        shares,
        saves,
        reach: reachVals.length ? reachVals.reduce((a, b) => a + b, 0) : insights.reach,
        profileViews: profileViewVals.length ? profileViewVals.reduce((a, b) => a + b, 0) : insights.profileViews,
        followsFromPosts: followsVals.length ? followsVals.reduce((a, b) => a + b, 0) : insights.followsFromPosts,
        topPost: top ? { url: top.url, caption: top.caption, views: top.views } : null,
        postsDetail: posts,
        raw: unmapped ? { account, posts } : undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      accountId: account.id,
      platform: account.platform,
      accountUsername: account.username,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch one platform's roll-up for the Analytics tab and Harvey.
 * When multiple accounts exist for the platform, prefers the configured TikTok
 * account id for TikTok, otherwise the first active match.
 */
export async function fetchZernioPlatform(platform: string, accountId?: string): Promise<ZernioFetchResult> {
  if (!apiKey()) return { ok: false, configured: false, error: "ZERNIO_DM_API_KEY is not set" };

  try {
    const accounts = await listZernioAccounts();
    if (!accounts.ok) return { ok: false, configured: true, error: accounts.error || "Could not list Zernio accounts" };

    const match = pickAccount(accounts.accounts, platform, accountId);
    if (!match) {
      return {
        ok: false,
        configured: true,
        error: `No ${platform} account is connected on this Zernio profile.`,
      };
    }

    const followers = await fetchFollowerStats([match.id]);
    return fetchZernioAccount(match, followers.get(match.id) ?? null);
  } catch (err) {
    return {
      ok: false,
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Every active connected account on this Zernio profile, with analytics. */
export async function fetchAllZernioAccountAnalytics(): Promise<{
  ok: boolean;
  configured: boolean;
  accounts: ZernioAccountRef[];
  results: ZernioFetchResult[];
  error?: string;
}> {
  if (!apiKey()) return { ok: false, configured: false, accounts: [], results: [], error: "ZERNIO_DM_API_KEY is not set" };
  const listed = await listZernioAccounts();
  if (!listed.ok) return { ok: false, configured: true, accounts: [], results: [], error: listed.error };

  const preferred = preferredAccountId();
  const active = listed.accounts
    .filter((a) => a.active)
    .sort((a, b) => {
      // Preferred TikTok first, then platform name, then username.
      if (a.id === preferred) return -1;
      if (b.id === preferred) return 1;
      if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
      return String(a.username || "").localeCompare(String(b.username || ""));
    });

  const followers = await fetchFollowerStats(active.map((a) => a.id));
  const results = await Promise.all(active.map((a) => fetchZernioAccount(a, followers.get(a.id) ?? null)));
  return { ok: true, configured: true, accounts: active, results };
}

/** Normalized videos for the social store / Harvey video tools. */
export async function fetchZernioTikTokVideos(): Promise<{
  ok: boolean;
  error?: string;
  username: string | null;
  followers: number | null;
  videos: Array<{
    id: string;
    url: string;
    caption: string;
    coverUrl: string;
    postedAt: string;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
  }>;
}> {
  const r = await fetchZernioPlatform("tiktok");
  if (!r.ok || !r.stats) return { ok: false, error: r.error || "TikTok analytics unavailable", username: null, followers: null, videos: [] };
  return {
    ok: true,
    username: r.accountUsername || null,
    followers: r.stats.followers,
    videos: r.stats.postsDetail.map((p) => ({
      id: p.id,
      url: p.url || "",
      caption: p.caption || "",
      coverUrl: "",
      postedAt: p.publishedAt || new Date().toISOString(),
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      shares: p.shares,
      saves: p.saves,
    })),
  };
}
