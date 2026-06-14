import { ApifyClient } from "apify-client";
import type { TikTokFetchResult, TikTokProfileInfo, TikTokVideoNormalized, TikTokComment } from "./types.js";

export { scoreVideos, extractContentPatterns } from "./scoring.js";
export type {
  TikTokFetchResult,
  TikTokProfileInfo,
  TikTokVideoNormalized,
  ScoredTikTokVideo,
  ScoreVideosResult,
  VideoTier,
  VideoScoreBreakdown,
  ContentPatterns,
  TikTokComment,
} from "./types.js";

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }
  return 0;
}

/** Reject unix timestamps / IDs mistaken for view counts. */
function isLikelyMismappedMetric(n: number): boolean {
  if (n <= 0) return true;
  if (n >= 1_000_000_000 && n <= 2_100_000_000_000) return true;
  return n >= 500_000_000;
}

function pickNum(
  obj: Record<string, unknown>,
  paths: string[],
  maxSanity = 500_000_000,
): number {
  for (const p of paths) {
    const v = dig(obj, p);
    const n = num(v);
    if (n > 0 && n <= maxSanity && !isLikelyMismappedMetric(n)) return n;
  }
  return 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function dig(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function parsePostedAt(item: Record<string, unknown>): string {
  const iso = str(item.createTimeISO) || str(item.createTimeIso);
  if (iso) return iso;

  const raw = item.createTime ?? item.create_time ?? dig(item, "videoMeta.createTime");
  if (typeof raw === "number" && raw > 1_000_000_000) {
    const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 1_000_000_000) {
      const ms = n > 1_000_000_000_000 ? n : n * 1000;
      return new Date(ms).toISOString();
    }
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return "";
}

function normalizeVideo(item: Record<string, unknown>): TikTokVideoNormalized | null {
  const id =
    str(item.id) ||
    str(item.videoId) ||
    str(item.aweme_id) ||
    str(dig(item, "videoMeta.id"));
  if (!id) return null;

  const url =
    str(item.webVideoUrl) ||
    str(item.videoUrl) ||
    str(item.url) ||
    (id ? `https://www.tiktok.com/@_/video/${id}` : "");

  const caption =
    str(item.text) ||
    str(item.desc) ||
    str(item.description) ||
    str(item.caption) ||
    str(dig(item, "videoMeta.text"));

  const coverUrl =
    str(item.coverUrl) ||
    str(item.cover) ||
    str(item.thumbnail) ||
    str(dig(item, "videoMeta.coverUrl")) ||
    str(dig(item, "videoMeta.originalCoverUrl"));

  const views = pickNum(item, [
    "playCount",
    "play_count",
    "stats.playCount",
    "stats.play_count",
    "videoMeta.playCount",
    "views",
    "stats.views",
  ]);

  const likes = pickNum(item, [
    "diggCount",
    "digg_count",
    "likes",
    "stats.diggCount",
    "stats.digg_count",
    "stats.likes",
  ]);

  const comments = pickNum(item, [
    "commentCount",
    "comment_count",
    "comments",
    "stats.commentCount",
    "stats.comment_count",
    "stats.comments",
  ]);

  const shares = pickNum(item, [
    "shareCount",
    "share_count",
    "shares",
    "stats.shareCount",
    "stats.share_count",
    "stats.shares",
  ]);

  const saves = pickNum(item, [
    "collectCount",
    "collect_count",
    "saves",
    "stats.collectCount",
    "stats.collect_count",
    "stats.saves",
  ]);

  const avgWatchTime = pickNum(item, [
    "videoMeta.playTime",
    "playTime",
    "avgWatchTime",
    "stats.playTime",
  ]);

  const duration = pickNum(item, [
    "videoMeta.duration",
    "duration",
    "videoDuration",
    "stats.duration",
  ]);

  return {
    id,
    url,
    caption,
    coverUrl,
    postedAt: parsePostedAt(item),
    views,
    likes,
    comments,
    shares,
    saves,
    ...(avgWatchTime > 0 ? { avgWatchTime } : {}),
    ...(duration > 0 ? { duration } : {}),
  };
}

function extractProfile(items: Record<string, unknown>[]): TikTokProfileInfo | null {
  for (const item of items) {
    const author =
      (item.authorMeta && typeof item.authorMeta === "object"
        ? (item.authorMeta as Record<string, unknown>)
        : null) ||
      (item.author && typeof item.author === "object"
        ? (item.author as Record<string, unknown>)
        : null);

    if (!author) continue;

    const username =
      str(author.name) ||
      str(author.uniqueId) ||
      str(author.username) ||
      str(author.nickName);

    if (!username) continue;

    return {
      username,
      nickname:
        str(author.nickName) ||
        str(author.nickname) ||
        str(author.displayName) ||
        username,
      followers: pickNum(author, ["fans", "followerCount", "followers", "stats.followerCount"]),
      following: pickNum(author, ["following", "followingCount", "stats.followingCount"]),
      heartCount: pickNum(author, ["heart", "heartCount", "stats.heartCount", "stats.heart"]),
      videoCount: pickNum(author, ["video", "videoCount", "stats.videoCount"]),
      avatar:
        str(author.avatar) ||
        str(author.avatarThumb) ||
        str(author.avatarMedium) ||
        str(author.avatarLarger),
    };
  }
  return null;
}

function isProfileOnlyRow(item: Record<string, unknown>): boolean {
  const id =
    str(item.id) ||
    str(item.videoId) ||
    str(item.aweme_id) ||
    str(dig(item, "videoMeta.id"));
  return !id && Boolean(item.authorMeta || item.author);
}

let apifyClient: ApifyClient | null = null;

/** Shared Apify client — reuse across video and comment fetches. */
export function getApifyClient(): ApifyClient {
  const token =
    process.env.APIFY_API_TOKEN?.trim() || process.env.APIFY_API_KEY?.trim() || "";
  if (!token) {
    throw new Error("APIFY_API_TOKEN is not set");
  }
  if (!apifyClient) {
    apifyClient = new ApifyClient({ token });
  }
  return apifyClient;
}

function commentCreatedMs(item: Record<string, unknown>): number {
  const iso = str(item.createTimeISO) || str(item.createTimeIso);
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  const raw = item.createTime ?? item.create_time ?? item.createdAt;
  if (typeof raw === "number" && raw > 0) {
    return raw > 1_000_000_000_000 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 1_000_000_000) {
      return n > 1_000_000_000_000 ? n : n * 1000;
    }
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function normalizeComment(item: Record<string, unknown>): TikTokComment | null {
  const text = str(item.text) || str(item.comment) || str(item.content);
  if (!text) return null;

  const author =
    (item.user && typeof item.user === "object"
      ? (item.user as Record<string, unknown>)
      : null) ||
    (item.author && typeof item.author === "object"
      ? (item.author as Record<string, unknown>)
      : null);

  const authorUsername =
    str(item.uniqueId) ||
    str(item.username) ||
    (author ? str(author.uniqueId) || str(author.username) || str(author.nickName) : "") ||
    "unknown";

  const postId =
    str(item.videoId) ||
    str(item.postId) ||
    str(item.awemeId) ||
    str(dig(item, "videoMeta.id")) ||
    "";

  const createdMs = commentCreatedMs(item);
  const likes = pickNum(item, [
    "diggCount",
    "digg_count",
    "likes",
    "stats.diggCount",
    "stats.likes",
  ]);

  return {
    text,
    authorUsername,
    postId,
    createdAt: createdMs > 0 ? new Date(createdMs).toISOString() : new Date().toISOString(),
    likes,
  };
}

/**
 * Fetch TikTok comments for video URLs via Apify clockworks/tiktok-comments-scraper.
 * @param postURLs TikTok video URLs
 * @param sinceMs Only return comments created after this timestamp (optional)
 */
export async function fetchTikTokComments(
  postURLs: string[],
  sinceMs?: number,
): Promise<TikTokComment[]> {
  const urls = [...new Set(postURLs.filter((u) => u && u.includes("tiktok.com")))].slice(0, 15);
  if (urls.length === 0) {
    console.log("[Apify] No TikTok URLs provided for comment fetch");
    return [];
  }

  const client = getApifyClient();
  console.log("[Apify] Fetching comments for", urls.length, "video(s)");

  const run = await client.actor("clockworks/tiktok-comments-scraper").call({
    postURLs: urls,
    commentsPerPost: 30,
    maxRequestRetries: 2,
  });

  const datasetId = run.defaultDatasetId;
  if (!datasetId) {
    throw new Error("Apify comment run completed without a default dataset");
  }

  const { items } = await client.dataset(datasetId).listItems();
  const since = sinceMs ?? Date.now() - 24 * 60 * 60 * 1000;

  const comments: TikTokComment[] = [];
  for (const raw of items ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const createdMs = commentCreatedMs(item);
    if (createdMs > 0 && createdMs < since) continue;
    const normalized = normalizeComment(item);
    if (normalized) comments.push(normalized);
  }

  console.log("[Apify] Fetched", comments.length, "comments from", urls.length, "videos");
  return comments;
}

/**
 * Pull TikTok profile videos via Apify clockworks/tiktok-scraper.
 */
export async function fetchTikTokVideos(username: string): Promise<TikTokFetchResult> {
  const cleanUser = username.replace(/^@/, "").trim();
  if (!cleanUser) {
    throw new Error("TIKTOK_USERNAME is empty");
  }

  const client = getApifyClient();

  const run = await client.actor("clockworks/tiktok-scraper").call({
    profiles: [cleanUser],
    resultsPerPage: 100,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
  });

  const datasetId = run.defaultDatasetId;
  if (!datasetId) {
    throw new Error("Apify run completed without a default dataset");
  }

  const { items } = await client.dataset(datasetId).listItems();
  const rows = (items ?? []).filter(
    (x): x is Record<string, unknown> => Boolean(x) && typeof x === "object",
  );

  const profile = extractProfile(rows) ?? {
    username: cleanUser,
    nickname: cleanUser,
    followers: 0,
    following: 0,
    heartCount: 0,
    videoCount: 0,
    avatar: "",
  };

  const seen = new Set<string>();
  const videos: TikTokVideoNormalized[] = [];

  for (const row of rows) {
    if (isProfileOnlyRow(row)) continue;
    const video = normalizeVideo(row);
    if (!video || seen.has(video.id)) continue;
    seen.add(video.id);
    if (!video.url.includes("@")) {
      video.url = `https://www.tiktok.com/@${profile.username}/video/${video.id}`;
    }
    videos.push(video);
  }

  videos.sort((a, b) => {
    const ta = a.postedAt ? Date.parse(a.postedAt) : 0;
    const tb = b.postedAt ? Date.parse(b.postedAt) : 0;
    return tb - ta;
  });

  return { profile, videos };
}
