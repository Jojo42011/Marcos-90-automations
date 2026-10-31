/**
 * Zernio social analytics — real API at https://zernio.com/api/v1.
 *
 * Uses the same API key value as DMs (`ZERNIO_DM_API_KEY`, with `ZERNIO_API_KEY`
 * as a fallback). TikTok is the primary surface today; Instagram/Facebook/
 * YouTube return honest not_connected / empty when the Zernio profile has no
 * connected account for that platform.
 *
 * Docs: GET /v1/analytics?platform=…, GET /v1/analytics/tiktok/account-insights,
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

export interface ZernioFetchResult {
  ok: boolean;
  configured: boolean;
  stats?: ZernioPlatformStats;
  error?: string;
  unmapped?: boolean;
  accountUsername?: string | null;
}

const DEFAULT_BASE = "https://zernio.com/api/v1";
const TIMEOUT_MS = 20000;

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

function analyticsOf(post: Record<string, unknown>): Record<string, unknown> {
  const a = post.analytics;
  return a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}

function mapPost(post: Record<string, unknown>): ZernioPostRow {
  const a = analyticsOf(post);
  return {
    id: String(post._id ?? post.id ?? ""),
    url: str(post.platformPostUrl) ?? str(post.url),
    caption: str(post.caption) ?? str(post.title) ?? str(post.text),
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
  accounts: { id: string; platform: string; username: string | null; active: boolean }[];
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
        username: str(a.username),
        active: a.isActive !== false && a.needsReconnection !== true,
      })),
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
  // Default window is 90 days in the API; ask for the last 90 explicitly.
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

async function fetchTikTokAccountInsights(accountId: string): Promise<{
  followers: number | null;
  likes: number | null;
  videoCount: number | null;
  following: number | null;
}> {
  const qs = new URLSearchParams({ accountId });
  const r = await zernioGet(`/analytics/tiktok/account-insights?${qs}`);
  if (!r.ok) return { followers: null, likes: null, videoCount: null, following: null };
  const root = (r.json && typeof r.json === "object" ? r.json : {}) as Record<string, unknown>;
  const nested = ["data", "result", "metrics", "stats", "summary", "account"]
    .map((k) => root[k])
    .find((v) => v && typeof v === "object" && !Array.isArray(v)) as Record<string, unknown> | undefined;
  const src = nested || root;
  return {
    followers: num(src.follower_count) ?? num(src.followers) ?? num(src.followerCount),
    likes: num(src.likes_count) ?? num(src.likes) ?? num(src.heartCount),
    videoCount: num(src.video_count) ?? num(src.videos) ?? num(src.videoCount),
    following: num(src.following_count) ?? num(src.following),
  };
}

/**
 * Fetch one platform's roll-up for the Analytics tab and Harvey.
 * Never throws — a dead provider is a status the UI can show next to a live tab.
 */
export async function fetchZernioPlatform(platform: string): Promise<ZernioFetchResult> {
  if (!apiKey()) return { ok: false, configured: false, error: "ZERNIO_DM_API_KEY is not set" };

  try {
    const accounts = await listZernioAccounts();
    if (!accounts.ok) return { ok: false, configured: true, error: accounts.error || "Could not list Zernio accounts" };

    const wanted = platform.toLowerCase();
    const preferred = preferredAccountId();
    const match =
      accounts.accounts.find((a) => a.platform === wanted && a.active && (!preferred || a.id === preferred || wanted !== "tiktok")) ||
      accounts.accounts.find((a) => a.platform === wanted && a.active) ||
      accounts.accounts.find((a) => a.platform === wanted);

    if (!match) {
      return {
        ok: false,
        configured: true,
        error: `No ${platform} account is connected on this Zernio profile.`,
      };
    }

    const postsRes = await fetchPostAnalytics(wanted, match.id);
    if (!postsRes.ok) return { ok: false, configured: true, error: postsRes.error || "Analytics request failed" };

    const posts = postsRes.posts;
    const views = posts.reduce((s, p) => s + p.views, 0);
    const likes = posts.reduce((s, p) => s + p.likes, 0);
    const comments = posts.reduce((s, p) => s + p.comments, 0);
    const shares = posts.reduce((s, p) => s + p.shares, 0);
    const saves = posts.reduce((s, p) => s + p.saves, 0);
    const reachVals = posts.map((p) => p.reach).filter((v): v is number => v != null);
    const followsVals = posts.map((p) => p.follows).filter((v): v is number => v != null);
    const profileViewVals = posts.map((p) => p.profileViews).filter((v): v is number => v != null);
    const top = posts.slice().sort((a, b) => b.views - a.views)[0] || null;

    let followers: number | null = null;
    let accountLikes: number | null = null;
    let videoCount: number | null = posts.length || null;
    if (wanted === "tiktok") {
      const insights = await fetchTikTokAccountInsights(match.id);
      followers = insights.followers;
      accountLikes = insights.likes;
      if (insights.videoCount != null) videoCount = insights.videoCount;
    }

    const unmapped = posts.length === 0 && followers == null && views === 0;
    return {
      ok: true,
      configured: true,
      accountUsername: match.username,
      unmapped,
      stats: {
        followers,
        posts: videoCount,
        views: posts.length ? views : null,
        likes: posts.length ? likes : accountLikes,
        comments: posts.length ? comments : null,
        shares: posts.length ? shares : null,
        saves: posts.length ? saves : null,
        reach: reachVals.length ? reachVals.reduce((a, b) => a + b, 0) : null,
        profileViews: profileViewVals.length ? profileViewVals.reduce((a, b) => a + b, 0) : null,
        followsFromPosts: followsVals.length ? followsVals.reduce((a, b) => a + b, 0) : null,
        topPost: top
          ? { url: top.url, caption: top.caption, views: top.views }
          : null,
        postsDetail: posts,
        raw: unmapped ? { accounts: accounts.accounts, posts } : undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
