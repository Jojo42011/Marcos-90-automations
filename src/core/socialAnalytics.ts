/**
 * Social analytics payload for /analytics and Harvey.
 *
 * TikTok (and any other platform connected on the current account's Zernio
 * profile) comes from Zernio. Platforms with no connected account stay
 * `not_connected` — never fabricated zeros.
 */
import { isZernioConfigured, fetchZernioPlatform, type ZernioPlatformStats } from "../integrations/zernio/index.js";
import { currentZernioSecrets } from "./zernioOwnerConfig.js";

export type PlatformStatus = "live" | "not_connected" | "error" | "unreadable";

export interface PlatformMetrics {
  id: string;
  label: string;
  status: PlatformStatus;
  source: string | null;
  lastUpdated: string | null;
  stale: boolean;
  note: string | null;
  accountUsername: string | null;
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
  avgViews: number | null;
  engagementRate: number | null;
  topPost: { url: string | null; caption: string | null; views: number | null } | null;
  mix: { viral: number; hot: number; average: number; cold: number } | null;
  recentPosts: Array<{
    id: string;
    url: string | null;
    caption: string | null;
    publishedAt: string | null;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
  }>;
}

export interface CombinedMetrics extends Omit<PlatformMetrics, "id" | "label" | "topPost" | "mix" | "recentPosts" | "accountUsername"> {
  id: "all";
  label: "All platforms";
  included: string[];
  excluded: { label: string; reason: string }[];
  topPost: { url: string | null; caption: string | null; views: number | null; platform: string } | null;
  recentPosts: PlatformMetrics["recentPosts"];
  accountUsername: null;
}

export interface AnalyticsPayload {
  platforms: PlatformMetrics[];
  combined: CombinedMetrics;
  zernio: { configured: boolean; owner: string; tiktokAccountId: string | null };
  generatedAt: string;
}

const PLATFORMS: { id: string; label: string }[] = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "youtube", label: "YouTube" },
];

function engagement(likes: number | null, comments: number | null, shares: number | null, views: number | null): number | null {
  if (views == null || views <= 0) return null;
  return Math.round((((likes || 0) + (comments || 0) + (shares || 0)) / views) * 10000) / 100;
}

function emptyPlatform(id: string, label: string, note: string): PlatformMetrics {
  return {
    id, label,
    status: "not_connected",
    source: null,
    lastUpdated: null,
    stale: false,
    note,
    accountUsername: null,
    followers: null, posts: null, views: null, likes: null, comments: null, shares: null,
    saves: null, reach: null, profileViews: null, followsFromPosts: null,
    avgViews: null, engagementRate: null, topPost: null, mix: null, recentPosts: [],
  };
}

function mixFromPosts(posts: ZernioPlatformStats["postsDetail"]): PlatformMetrics["mix"] {
  if (!posts.length) return null;
  const avg = posts.reduce((s, p) => s + p.views, 0) / posts.length;
  let viral = 0, hot = 0, average = 0, cold = 0;
  for (const p of posts) {
    if (p.views >= avg * 3) viral++;
    else if (p.views >= avg * 1.5) hot++;
    else if (p.views >= avg * 0.5) average++;
    else cold++;
  }
  return { viral, hot, average, cold };
}

async function platformMetrics(id: string, label: string): Promise<PlatformMetrics> {
  if (!isZernioConfigured()) {
    return emptyPlatform(id, label, "Waiting on the Zernio connection — set this account's Zernio API key to load analytics.");
  }
  const r = await fetchZernioPlatform(id);
  if (!r.ok) {
    const missingAccount = /no .+ account is connected/i.test(r.error || "");
    return {
      ...emptyPlatform(id, label, r.error || "Zernio request failed."),
      status: missingAccount ? "not_connected" : "error",
      source: "Zernio",
    };
  }
  if (r.unmapped) {
    return {
      ...emptyPlatform(id, label, "Zernio replied but returned no readable metrics for this platform yet."),
      status: "unreadable",
      source: "Zernio",
      accountUsername: r.accountUsername || null,
    };
  }
  const st = r.stats!;
  return {
    id, label,
    status: "live",
    source: "Zernio",
    lastUpdated: new Date().toISOString(),
    stale: false,
    note: null,
    accountUsername: r.accountUsername || null,
    followers: st.followers,
    posts: st.posts,
    views: st.views,
    likes: st.likes,
    comments: st.comments,
    shares: st.shares,
    saves: st.saves,
    reach: st.reach,
    profileViews: st.profileViews,
    followsFromPosts: st.followsFromPosts,
    avgViews: st.views != null && st.posts ? Math.round(st.views / Math.max(1, st.posts)) : null,
    engagementRate: engagement(st.likes, st.comments, st.shares, st.views),
    topPost: st.topPost,
    mix: mixFromPosts(st.postsDetail),
    recentPosts: st.postsDetail.slice(0, 25).map((p) => ({
      id: p.id,
      url: p.url,
      caption: p.caption,
      publishedAt: p.publishedAt,
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      shares: p.shares,
      saves: p.saves,
    })),
  };
}

function combine(platforms: PlatformMetrics[]): CombinedMetrics {
  const live = platforms.filter((p) => p.status === "live");
  const excluded = platforms
    .filter((p) => p.status !== "live")
    .map((p) => ({ label: p.label, reason: p.note || "No data." }));

  const sum = (pick: (p: PlatformMetrics) => number | null): number | null => {
    const vals = live.map(pick).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };

  const views = sum((p) => p.views);
  const likes = sum((p) => p.likes);
  const comments = sum((p) => p.comments);
  const shares = sum((p) => p.shares);
  const posts = sum((p) => p.posts);

  let top: CombinedMetrics["topPost"] = null;
  for (const p of live) {
    if (p.topPost && p.topPost.views != null && (!top || top.views == null || p.topPost.views > top.views)) {
      top = { ...p.topPost, platform: p.label };
    }
  }

  const oldest = live
    .map((p) => p.lastUpdated)
    .filter((d): d is string => Boolean(d))
    .sort()[0] || null;

  return {
    id: "all",
    label: "All platforms",
    status: live.length ? "live" : "not_connected",
    source: live.length ? live.map((p) => p.label).join(" + ") : null,
    lastUpdated: oldest,
    stale: live.some((p) => p.stale),
    note: live.length
      ? excluded.length
        ? `Totals cover ${live.map((p) => p.label).join(", ")} only. ${excluded.map((e) => e.label).join(", ")} ${excluded.length === 1 ? "is" : "are"} not included.`
        : null
      : "No platform is reporting yet, so there is nothing to roll up.",
    accountUsername: null,
    followers: sum((p) => p.followers),
    posts,
    views,
    likes,
    comments,
    shares,
    saves: sum((p) => p.saves),
    reach: sum((p) => p.reach),
    profileViews: sum((p) => p.profileViews),
    followsFromPosts: sum((p) => p.followsFromPosts),
    avgViews: views != null && posts ? Math.round(views / Math.max(1, posts)) : null,
    engagementRate: engagement(likes, comments, shares, views),
    included: live.map((p) => p.label),
    excluded,
    topPost: top,
    recentPosts: live.flatMap((p) => p.recentPosts).sort((a, b) => b.views - a.views).slice(0, 25),
  };
}

export async function getSocialAnalytics(): Promise<AnalyticsPayload> {
  const secrets = currentZernioSecrets();
  const platforms = await Promise.all(PLATFORMS.map((p) => platformMetrics(p.id, p.label)));
  return {
    platforms,
    combined: combine(platforms),
    zernio: {
      configured: isZernioConfigured(),
      owner: secrets.ownerSlug,
      tiktokAccountId: secrets.tiktokAccountId || null,
    },
    generatedAt: new Date().toISOString(),
  };
}
