import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import type {
  ContentPatterns,
  ScoredTikTokVideo,
  TikTokProfileInfo,
  VideoScoreBreakdown,
} from "../integrations/apify/types.js";

const PLATFORM = "tiktok";
const SCHEMA_VERSION = 4;

function resolveSocialDbPath(): string {
  const env = process.env.SOCIAL_DB_PATH?.trim();
  if (env) return env;
  if (existsSync("/data")) return "/data/social.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "social.db");
}

let db: Database.Database | null = null;

function dropLegacySocialTables(database: Database.Database): void {
  database.exec(`
    DROP TABLE IF EXISTS social_profile_snapshots;
    DROP TABLE IF EXISTS social_video_scores;
    DROP TABLE IF EXISTS social_engagements;
    DROP TABLE IF EXISTS social_posts;
    DROP TABLE IF EXISTS social_daily_snapshots;
  `);
}

function initSchema(database: Database.Database): void {
  const meta = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='social_schema_meta'")
    .get() as { name: string } | undefined;

  if (!meta) {
    dropLegacySocialTables(database);
    database.exec(`CREATE TABLE social_schema_meta (version INTEGER NOT NULL)`);
    database.prepare("INSERT INTO social_schema_meta (version) VALUES (?)").run(SCHEMA_VERSION);
  } else {
    const row = database.prepare("SELECT version FROM social_schema_meta").get() as
      | { version: number }
      | undefined;
    if (!row || row.version < SCHEMA_VERSION) {
      if (!row || row.version < 2) {
        dropLegacySocialTables(database);
      }
      migrateVideoScoresTable(database);
      database.prepare("UPDATE social_schema_meta SET version = ?").run(SCHEMA_VERSION);
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      url TEXT,
      caption TEXT,
      cover_url TEXT,
      posted_at TEXT,
      pulled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS social_engagements (
      post_id TEXT PRIMARY KEY,
      views INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      comments INTEGER NOT NULL DEFAULT 0,
      shares INTEGER NOT NULL DEFAULT 0,
      saves INTEGER NOT NULL DEFAULT 0,
      engagement_rate REAL NOT NULL DEFAULT 0,
      pulled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS social_video_scores (
      post_id TEXT PRIMARY KEY,
      score INTEGER NOT NULL DEFAULT 0,
      views_score INTEGER NOT NULL DEFAULT 0,
      retention_score INTEGER NOT NULL DEFAULT 0,
      saves_score INTEGER NOT NULL DEFAULT 0,
      shares_score INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL,
      viral INTEGER NOT NULL DEFAULT 0,
      avg_views_at_time INTEGER NOT NULL DEFAULT 0,
      pulled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS social_daily_snapshots (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      total_videos INTEGER NOT NULL DEFAULT 0,
      avg_views INTEGER NOT NULL DEFAULT 0,
      total_views INTEGER NOT NULL DEFAULT 0,
      total_likes INTEGER NOT NULL DEFAULT 0,
      total_comments INTEGER NOT NULL DEFAULT 0,
      total_shares INTEGER NOT NULL DEFAULT 0,
      hot_count INTEGER NOT NULL DEFAULT 0,
      average_count INTEGER NOT NULL DEFAULT 0,
      cold_count INTEGER NOT NULL DEFAULT 0,
      viral_count INTEGER NOT NULL DEFAULT 0,
      follower_count INTEGER NOT NULL DEFAULT 0,
      top_video_url TEXT,
      top_video_views INTEGER NOT NULL DEFAULT 0,
      top_video_caption TEXT,
      content_patterns TEXT,
      pulled_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_social_posts_posted ON social_posts(posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_pulled ON social_daily_snapshots(pulled_at DESC);

    CREATE TABLE IF NOT EXISTS morning_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scanned_at TEXT NOT NULL,
      new_comments INTEGER NOT NULL,
      new_mentions INTEGER NOT NULL,
      lead_intent_flags TEXT NOT NULL,
      fetch_error TEXT
    );

    CREATE TABLE IF NOT EXISTS comment_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT,
      comment_text TEXT NOT NULL,
      author_username TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      generated_reply TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requires_approval INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT
    );

    CREATE TABLE IF NOT EXISTS social_refresh_schedule (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pull_time TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_pull_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pulled_at TEXT NOT NULL,
      pull_type TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT,
      duration_ms INTEGER
    );
  `);

  migrateVideoScoresTable(database);
  migrateMorningScansTable(database);
  purgeMockSocialRows(database);
}

/** Remove any legacy seeded mock rows (ids like mock_1/mock_2/...) so the
 *  dashboard only ever shows real pulled data. Idempotent — safe every boot. */
function purgeMockSocialRows(database: Database.Database): void {
  try {
    const res = database.prepare("DELETE FROM social_posts WHERE id LIKE 'mock\\_%' ESCAPE '\\'").run();
    database.prepare("DELETE FROM social_engagements WHERE post_id LIKE 'mock\\_%' ESCAPE '\\'").run();
    database.prepare("DELETE FROM social_video_scores WHERE post_id LIKE 'mock\\_%' ESCAPE '\\'").run();
    if (res.changes > 0) {
      console.log(`[social] Purged ${res.changes} legacy mock video row(s) — real data only.`);
    }
  } catch (err) {
    console.warn(`[social] Mock purge skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function migrateMorningScansTable(database: Database.Database): void {
  try {
    database.exec(`ALTER TABLE morning_scans ADD COLUMN fetch_error TEXT`);
  } catch {
    // column exists
  }
}

function migrateVideoScoresTable(database: Database.Database): void {
  const columns = [
    "views_score INTEGER NOT NULL DEFAULT 0",
    "retention_score INTEGER NOT NULL DEFAULT 0",
    "saves_score INTEGER NOT NULL DEFAULT 0",
    "shares_score INTEGER NOT NULL DEFAULT 0",
    "improvements TEXT",
    "improvements_generated_at TEXT",
  ];
  for (const col of columns) {
    try {
      database.exec(`ALTER TABLE social_video_scores ADD COLUMN ${col}`);
    } catch {
      // column exists
    }
  }
}

export function getSocialDb(): Database.Database {
  if (db) return db;
  const dbPath = resolveSocialDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

export interface SocialDailySnapshot {
  id: string;
  platform: string;
  fetchedAt: string;
  totalVideos: number;
  avgViews: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  hotCount: number;
  averageCount: number;
  coldCount: number;
  viralCount: number;
  followerCount: number;
  topVideoUrl: string | null;
  topVideoViews: number;
  topVideoCaption: string | null;
  contentPatterns: ContentPatterns | null;
}

export interface SocialDashboardVideo {
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
  score: number;
  tier: string;
  viral: boolean;
  scoreBreakdown?: VideoScoreBreakdown;
}

export interface SocialDashboardData {
  lastUpdated: string | null;
  profile: TikTokProfileInfo | null;
  summary: {
    totalVideos: number;
    avgViews: number;
    totalViews: number;
    totalLikes: number;
    totalComments: number;
    totalShares: number;
    hotCount: number;
    averageCount: number;
    coldCount: number;
    viralCount: number;
  };
  snapshot: SocialDailySnapshot | null;
  videos: SocialDashboardVideo[];
}

function chicagoDateId(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
}

export function upsertSocialPull(
  profile: TikTokProfileInfo,
  scoredVideos: ScoredTikTokVideo[],
  contentPatterns: ContentPatterns,
  avgViewsAtTime: number,
  pulledAt: string,
): SocialDailySnapshot {
  const database = getSocialDb();

  const upsertPost = database.prepare(`
    INSERT INTO social_posts (id, platform, url, caption, cover_url, posted_at, pulled_at)
    VALUES (@id, @platform, @url, @caption, @cover_url, @posted_at, @pulled_at)
    ON CONFLICT(id) DO UPDATE SET
      platform = excluded.platform,
      url = excluded.url,
      caption = excluded.caption,
      cover_url = excluded.cover_url,
      posted_at = excluded.posted_at,
      pulled_at = excluded.pulled_at
  `);

  const upsertEng = database.prepare(`
    INSERT INTO social_engagements
      (post_id, views, likes, comments, shares, saves, engagement_rate, pulled_at)
    VALUES (@post_id, @views, @likes, @comments, @shares, @saves, @engagement_rate, @pulled_at)
    ON CONFLICT(post_id) DO UPDATE SET
      views = excluded.views,
      likes = excluded.likes,
      comments = excluded.comments,
      shares = excluded.shares,
      saves = excluded.saves,
      engagement_rate = excluded.engagement_rate,
      pulled_at = excluded.pulled_at
  `);

  const upsertScore = database.prepare(`
    INSERT INTO social_video_scores
      (post_id, score, views_score, retention_score, saves_score, shares_score, tier, viral, avg_views_at_time, pulled_at)
    VALUES (@post_id, @score, @views_score, @retention_score, @saves_score, @shares_score, @tier, @viral, @avg_views_at_time, @pulled_at)
    ON CONFLICT(post_id) DO UPDATE SET
      score = excluded.score,
      views_score = excluded.views_score,
      retention_score = excluded.retention_score,
      saves_score = excluded.saves_score,
      shares_score = excluded.shares_score,
      tier = excluded.tier,
      viral = excluded.viral,
      avg_views_at_time = excluded.avg_views_at_time,
      pulled_at = excluded.pulled_at
  `);

  let totalViews = 0;
  let totalLikes = 0;
  let totalComments = 0;
  let totalShares = 0;
  let hotCount = 0;
  let averageCount = 0;
  let coldCount = 0;
  let viralCount = 0;
  let topVideo: ScoredTikTokVideo | null = null;

  const tx = database.transaction(() => {
    for (const v of scoredVideos) {
      upsertPost.run({
        id: v.id,
        platform: PLATFORM,
        url: v.url,
        caption: v.caption,
        cover_url: v.coverUrl,
        posted_at: v.postedAt,
        pulled_at: pulledAt,
      });
      upsertEng.run({
        post_id: v.id,
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        shares: v.shares,
        saves: v.saves,
        engagement_rate: v.engagementRate,
        pulled_at: pulledAt,
      });
      upsertScore.run({
        post_id: v.id,
        score: v.score,
        views_score: v.scoreBreakdown.viewsScore,
        retention_score: v.scoreBreakdown.retentionScore,
        saves_score: v.scoreBreakdown.savesScore,
        shares_score: v.scoreBreakdown.sharesScore,
        tier: v.tier,
        viral: v.viral ? 1 : 0,
        avg_views_at_time: Math.round(avgViewsAtTime),
        pulled_at: pulledAt,
      });

      totalViews += v.views;
      totalLikes += v.likes;
      totalComments += v.comments;
      totalShares += v.shares;
      if (v.tier === "hot") hotCount++;
      else if (v.tier === "warm") averageCount++;
      else coldCount++;
      if (v.viral) viralCount++;
      if (!topVideo || v.views > topVideo.views) topVideo = v;
    }
  });

  tx();

  const withViews = scoredVideos.filter((v) => v.views > 0);
  const avgViews =
    withViews.length > 0 ? Math.round(totalViews / withViews.length) : 0;

  const snapshotId = chicagoDateId(new Date(pulledAt));
  const patternsJson = JSON.stringify(contentPatterns);

  database
    .prepare(
      `INSERT INTO social_daily_snapshots (
        id, platform, total_videos, avg_views, total_views, total_likes, total_comments,
        total_shares, hot_count, average_count, cold_count, viral_count, follower_count,
        top_video_url, top_video_views, top_video_caption, content_patterns, pulled_at
      ) VALUES (
        @id, @platform, @total_videos, @avg_views, @total_views, @total_likes, @total_comments,
        @total_shares, @hot_count, @average_count, @cold_count, @viral_count, @follower_count,
        @top_video_url, @top_video_views, @top_video_caption, @content_patterns, @pulled_at
      )
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform,
        total_videos = excluded.total_videos,
        avg_views = excluded.avg_views,
        total_views = excluded.total_views,
        total_likes = excluded.total_likes,
        total_comments = excluded.total_comments,
        total_shares = excluded.total_shares,
        hot_count = excluded.hot_count,
        average_count = excluded.average_count,
        cold_count = excluded.cold_count,
        viral_count = excluded.viral_count,
        follower_count = excluded.follower_count,
        top_video_url = excluded.top_video_url,
        top_video_views = excluded.top_video_views,
        top_video_caption = excluded.top_video_caption,
        content_patterns = excluded.content_patterns,
        pulled_at = excluded.pulled_at`,
    )
    .run({
      id: snapshotId,
      platform: PLATFORM,
      total_videos: scoredVideos.length,
      avg_views: avgViews,
      total_views: totalViews,
      total_likes: totalLikes,
      total_comments: totalComments,
      total_shares: totalShares,
      hot_count: hotCount,
      average_count: averageCount,
      cold_count: coldCount,
      viral_count: viralCount,
      follower_count: profile.followers,
      top_video_url: topVideo?.url ?? null,
      top_video_views: topVideo?.views ?? 0,
      top_video_caption: topVideo?.caption ?? null,
      content_patterns: patternsJson,
      pulled_at: pulledAt,
    });

  return {
    id: snapshotId,
    platform: PLATFORM,
    fetchedAt: pulledAt,
    totalVideos: scoredVideos.length,
    avgViews,
    totalViews,
    totalLikes,
    totalComments,
    totalShares,
    hotCount,
    averageCount,
    coldCount,
    viralCount,
    followerCount: profile.followers,
    topVideoUrl: topVideo?.url ?? null,
    topVideoViews: topVideo?.views ?? 0,
    topVideoCaption: topVideo?.caption ?? null,
    contentPatterns,
  };
}

function rowToSnapshot(row: Record<string, unknown>): SocialDailySnapshot {
  let contentPatterns: ContentPatterns | null = null;
  const raw = row.content_patterns;
  if (typeof raw === "string" && raw.trim()) {
    try {
      contentPatterns = JSON.parse(raw) as ContentPatterns;
    } catch {
      contentPatterns = null;
    }
  }
  return {
    id: String(row.id),
    platform: String(row.platform),
    fetchedAt: String(row.pulled_at),
    totalVideos: Number(row.total_videos) || 0,
    avgViews: Number(row.avg_views) || 0,
    totalViews: Number(row.total_views) || 0,
    totalLikes: Number(row.total_likes) || 0,
    totalComments: Number(row.total_comments) || 0,
    totalShares: Number(row.total_shares) || 0,
    hotCount: Number(row.hot_count) || 0,
    averageCount: Number(row.average_count) || 0,
    coldCount: Number(row.cold_count) || 0,
    viralCount: Number(row.viral_count) || 0,
    followerCount: Number(row.follower_count) || 0,
    topVideoUrl: row.top_video_url ? String(row.top_video_url) : null,
    topVideoViews: Number(row.top_video_views) || 0,
    topVideoCaption: row.top_video_caption ? String(row.top_video_caption) : null,
    contentPatterns,
  };
}

export function getLatestDailySnapshot(): SocialDailySnapshot | null {
  const database = getSocialDb();
  const row = database
    .prepare(
      `SELECT * FROM social_daily_snapshots WHERE platform = ? ORDER BY pulled_at DESC LIMIT 1`,
    )
    .get(PLATFORM) as Record<string, unknown> | undefined;
  return row ? rowToSnapshot(row) : null;
}

export function getDailySnapshotByDate(dateId: string): SocialDailySnapshot | null {
  const database = getSocialDb();
  const row = database
    .prepare(`SELECT * FROM social_daily_snapshots WHERE id = ? AND platform = ?`)
    .get(dateId, PLATFORM) as Record<string, unknown> | undefined;
  return row ? rowToSnapshot(row) : null;
}

export function getSocialVideos(
  opts?: { tier?: string; limit?: number; days?: number },
): SocialDashboardVideo[] {
  const database = getSocialDb();
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);

  let sql = `
    SELECT
      p.id,
      p.url,
      p.caption,
      p.cover_url AS coverUrl,
      p.posted_at AS postedAt,
      e.views,
      e.likes,
      e.comments,
      e.shares,
      e.saves,
      s.score,
      s.tier,
      s.viral,
      s.views_score AS viewsScore,
      s.retention_score AS retentionScore,
      s.saves_score AS savesScore,
      s.shares_score AS sharesScore
    FROM social_posts p
    JOIN social_engagements e ON e.post_id = p.id
    JOIN social_video_scores s ON s.post_id = p.id
    WHERE p.platform = ?
  `;
  const params: unknown[] = [PLATFORM];

  if (opts?.days != null && Number.isFinite(opts.days) && opts.days > 0) {
    const cutoff = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString();
    sql += " AND (p.posted_at IS NULL OR p.posted_at = '' OR p.posted_at >= ?)";
    params.push(cutoff);
  }

  if (opts?.tier) {
    const tier = opts.tier === "average" ? "warm" : opts.tier;
    sql += " AND s.tier = ?";
    params.push(tier);
  }

  sql += " ORDER BY e.views DESC LIMIT ?";
  params.push(limit);

  const rows = database.prepare(sql).all(...params) as Array<{
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
    score: number;
    tier: string;
    viral: number;
    viewsScore: number;
    retentionScore: number;
    savesScore: number;
    sharesScore: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    caption: r.caption,
    coverUrl: r.coverUrl,
    postedAt: r.postedAt,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    saves: r.saves,
    score: r.score,
    tier: r.tier,
    viral: Boolean(r.viral),
    scoreBreakdown: {
      score: r.score,
      viewsScore: r.viewsScore ?? 0,
      retentionScore: r.retentionScore ?? 0,
      savesScore: r.savesScore ?? 0,
      sharesScore: r.sharesScore ?? 0,
      tier: r.tier as VideoScoreBreakdown["tier"],
    },
  }));
}

export function socialDataAvailable(): boolean {
  return getLatestDailySnapshot() !== null;
}

function videoViews(v: SocialDashboardVideo): number {
  return v.views ?? 0;
}

function videoLikes(v: SocialDashboardVideo): number {
  return v.likes ?? 0;
}

function videoComments(v: SocialDashboardVideo): number {
  return v.comments ?? 0;
}

function videoShares(v: SocialDashboardVideo): number {
  return v.shares ?? 0;
}

/** Harvey tool payload — same source as GET /api/social/data (getLatestSocialDashboardData). */
export function getSocialSummaryForHarvey(): Record<string, unknown> {
  try {
    const data = getLatestSocialDashboardData();

    if (!data.lastUpdated || !data.snapshot) {
      return {
        dataAvailable: false,
        status: "no_data",
        message: "No TikTok data available yet. Refresh via /api/social/refresh.",
        days_since_last_pull: null,
      };
    }

    const s = data.summary;
    const profile = data.profile;
    const videos = data.videos;

    const weekAgoId = chicagoDateId(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const weekAgo = getDailySnapshotByDate(weekAgoId);

    let wowAvgViewsChangePct: number | null = null;
    let weekOverWeekTrend: { avgViewsChange: number; direction: "up" | "down" | "flat" } | null =
      null;
    if (weekAgo && weekAgo.avgViews > 0) {
      wowAvgViewsChangePct = Math.round(((s.avgViews - weekAgo.avgViews) / weekAgo.avgViews) * 100);
      weekOverWeekTrend = {
        avgViewsChange: wowAvgViewsChangePct,
        direction:
          wowAvgViewsChangePct > 0 ? "up" : wowAvgViewsChangePct < 0 ? "down" : "flat",
      };
    }

    const pulledMs = new Date(data.lastUpdated).getTime();
    const daysSinceLastPull = Number.isFinite(pulledMs)
      ? Math.floor((Date.now() - pulledMs) / (24 * 60 * 60 * 1000))
      : null;

    const topVideos = [...videos]
      .sort((a, b) => videoViews(b) - videoViews(a))
      .slice(0, 5)
      .map((v) => ({
        url: v.url,
        caption: v.caption,
        description: v.caption,
        views: videoViews(v),
        likes: videoLikes(v),
        comments: videoComments(v),
        shares: videoShares(v),
        postedAt: v.postedAt,
        score: v.score,
        tier: v.tier,
      }));

    const username = profile?.username ?? "puga.realtor";
    const followers = profile?.followers ?? data.snapshot.followerCount;
    const humanSummary = `@${username} has ${followers.toLocaleString()} followers. ${s.totalVideos} videos tracked. Average ${s.avgViews.toLocaleString()} views per video. Total ${s.totalViews.toLocaleString()} views.`;

    return {
      dataAvailable: true,
      status: "ok",
      pulledAt: data.lastUpdated,
      fetchedAt: data.lastUpdated,
      platform: PLATFORM,
      profile: {
        username,
        nickname: profile?.nickname ?? username,
        followers,
        following: profile?.following ?? 0,
        heartCount: profile?.heartCount ?? 0,
        videoCount: profile?.videoCount ?? s.totalVideos,
        avatar: profile?.avatar ?? "",
      },
      stats: {
        videosTracked: s.totalVideos,
        avgViewsPerVideo: s.avgViews,
        totalViews: s.totalViews,
        totalLikes: s.totalLikes,
        totalComments: s.totalComments,
        totalShares: s.totalShares,
        hotCount: s.hotCount,
        averageCount: s.averageCount,
        coldCount: s.coldCount,
        viralCount: s.viralCount,
      },
      // Legacy flat fields — mirror dashboard summary for tool consumers
      follower_count: followers,
      total_videos: s.totalVideos,
      videoCount: s.totalVideos,
      avg_views: s.avgViews,
      total_views: s.totalViews,
      total_likes: s.totalLikes,
      total_comments: s.totalComments,
      total_shares: s.totalShares,
      hot_count: s.hotCount,
      average_count: s.averageCount,
      cold_count: s.coldCount,
      viral_count: s.viralCount,
      top_video_url: data.snapshot.topVideoUrl,
      top_video_views: data.snapshot.topVideoViews,
      top_video_caption: data.snapshot.topVideoCaption,
      topVideos,
      contentPatterns: data.snapshot.contentPatterns,
      weekOverWeekTrend,
      wow_avg_views_change_pct: wowAvgViewsChangePct,
      days_since_last_pull: daysSinceLastPull,
      humanSummary,
      summary: humanSummary,
    };
  } catch (err) {
    return {
      dataAvailable: false,
      status: "error",
      message: `Error reading social data: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function getLatestSocialDashboardData(): SocialDashboardData {
  const snapshot = getLatestDailySnapshot();
  const videos = getSocialVideos({ limit: 100, days: 30 });

  if (!snapshot) {
    return {
      lastUpdated: null,
      profile: null,
      summary: {
        totalVideos: 0,
        avgViews: 0,
        totalViews: 0,
        totalLikes: 0,
        totalComments: 0,
        totalShares: 0,
        hotCount: 0,
        averageCount: 0,
        coldCount: 0,
        viralCount: 0,
      },
      snapshot: null,
      videos: [],
    };
  }

  return {
    lastUpdated: snapshot.fetchedAt,
    profile: {
      username: process.env.TIKTOK_USERNAME?.replace(/^@/, "") || "puga.realtor",
      nickname: process.env.TIKTOK_USERNAME?.replace(/^@/, "") || "puga.realtor",
      followers: snapshot.followerCount,
      following: 0,
      heartCount: 0,
      videoCount: snapshot.totalVideos,
      avatar: "",
    },
    summary: {
      totalVideos: snapshot.totalVideos,
      avgViews: snapshot.avgViews,
      totalViews: snapshot.totalViews,
      totalLikes: snapshot.totalLikes,
      totalComments: snapshot.totalComments,
      totalShares: snapshot.totalShares,
      hotCount: snapshot.hotCount,
      averageCount: snapshot.averageCount,
      coldCount: snapshot.coldCount,
      viralCount: snapshot.viralCount,
    },
    snapshot,
    videos,
  };
}

/** @deprecated Use upsertSocialPull */
export function saveSocialPull(
  profile: TikTokProfileInfo,
  scoredVideos: ScoredTikTokVideo[],
  avgViewsAtTime: number,
  pulledAt: string,
): void {
  upsertSocialPull(profile, scoredVideos, {
    topHashtagsByAvgViews: [],
    hotCaptionKeywords: [],
    bestPostingDay: null,
    bestPostingHour: null,
    contentTypeBreakdown: [],
  }, avgViewsAtTime, pulledAt);
}

export function upsertVideoScore(postId: string, breakdown: VideoScoreBreakdown, pulledAt?: string): void {
  const database = getSocialDb();
  const at = pulledAt ?? new Date().toISOString();
  database
    .prepare(
      `INSERT INTO social_video_scores
        (post_id, score, views_score, retention_score, saves_score, shares_score, tier, viral, avg_views_at_time, pulled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
      ON CONFLICT(post_id) DO UPDATE SET
        score = excluded.score,
        views_score = excluded.views_score,
        retention_score = excluded.retention_score,
        saves_score = excluded.saves_score,
        shares_score = excluded.shares_score,
        tier = excluded.tier,
        pulled_at = excluded.pulled_at,
        improvements = CASE
          WHEN excluded.score != social_video_scores.score OR excluded.tier != social_video_scores.tier
          THEN NULL
          ELSE social_video_scores.improvements
        END,
        improvements_generated_at = CASE
          WHEN excluded.score != social_video_scores.score OR excluded.tier != social_video_scores.tier
          THEN NULL
          ELSE social_video_scores.improvements_generated_at
        END`,
    )
    .run(
      postId,
      breakdown.score,
      breakdown.viewsScore,
      breakdown.retentionScore,
      breakdown.savesScore,
      breakdown.sharesScore,
      breakdown.tier,
      at,
    );
}

export function getVideoScore(postId: string): VideoScoreBreakdown | null {
  const database = getSocialDb();
  const row = database
    .prepare(
      `SELECT score, views_score, retention_score, saves_score, shares_score, tier
       FROM social_video_scores WHERE post_id = ?`,
    )
    .get(postId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    score: Number(row.score) || 0,
    viewsScore: Number(row.views_score) || 0,
    retentionScore: Number(row.retention_score) || 0,
    savesScore: Number(row.saves_score) || 0,
    sharesScore: Number(row.shares_score) || 0,
    tier: String(row.tier) as VideoScoreBreakdown["tier"],
  };
}

// A professional-editor review (multi-section string) is stored per video.
// (Older data may hold a JSON array of short bullets — getVideoImprovements
// migrates that to a string on read.)
export function saveVideoImprovements(postId: string, review: string): void {
  const database = getSocialDb();
  database
    .prepare(
      `UPDATE social_video_scores
       SET improvements = ?, improvements_generated_at = ?
       WHERE post_id = ?`,
    )
    .run(JSON.stringify(review), new Date().toISOString(), postId);
}

export function getVideoImprovements(postId: string): string | null {
  const database = getSocialDb();
  const row = database
    .prepare(`SELECT improvements FROM social_video_scores WHERE post_id = ?`)
    .get(postId) as Record<string, unknown> | undefined;
  if (!row?.improvements) return null;
  try {
    const parsed = JSON.parse(String(row.improvements));
    if (typeof parsed === "string") return parsed || null;
    // Legacy bullet-array data → present as lines so the UI still renders it.
    if (Array.isArray(parsed)) return parsed.map(String).map((b) => `• ${b}`).join("\n") || null;
    return null;
  } catch {
    // Not JSON — treat the raw column value as the review string.
    return String(row.improvements) || null;
  }
}

export function setSocialRefreshTime(time: string): void {
  const database = getSocialDb();
  database
    .prepare(
      `INSERT INTO social_refresh_schedule (id, pull_time, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pull_time = excluded.pull_time, updated_at = excluded.updated_at`,
    )
    .run(time, new Date().toISOString());
}

export function getSocialRefreshTime(): string | null {
  const database = getSocialDb();
  const row = database
    .prepare(`SELECT pull_time FROM social_refresh_schedule WHERE id = 1`)
    .get() as Record<string, unknown> | undefined;
  return row?.pull_time ? String(row.pull_time) : null;
}

export interface CommentReply {
  id?: number;
  postId?: string;
  commentText: string;
  authorUsername: string;
  sentiment: "positive" | "neutral" | "negative";
  generatedReply: string;
  status: "pending" | "approved" | "rejected" | "sent";
  requiresApproval: boolean;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

function rowToCommentReply(row: Record<string, unknown>): CommentReply {
  return {
    id: Number(row.id),
    postId: row.post_id ? String(row.post_id) : undefined,
    commentText: String(row.comment_text),
    authorUsername: String(row.author_username),
    sentiment: String(row.sentiment) as CommentReply["sentiment"],
    generatedReply: String(row.generated_reply),
    status: String(row.status) as CommentReply["status"],
    requiresApproval: Number(row.requires_approval) === 1,
    createdAt: String(row.created_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : undefined,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
  };
}

export function createCommentReply(
  reply: Omit<CommentReply, "id" | "createdAt">,
): CommentReply {
  const database = getSocialDb();
  const createdAt = new Date().toISOString();
  const result = database
    .prepare(
      `INSERT INTO comment_replies
        (post_id, comment_text, author_username, sentiment, generated_reply, status, requires_approval, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      reply.postId ?? null,
      reply.commentText,
      reply.authorUsername,
      reply.sentiment,
      reply.generatedReply,
      reply.status,
      reply.requiresApproval ? 1 : 0,
      createdAt,
    );
  return { ...reply, id: Number(result.lastInsertRowid), createdAt };
}

export function getPendingCommentReplies(): CommentReply[] {
  const database = getSocialDb();
  const rows = database
    .prepare(`SELECT * FROM comment_replies WHERE status = 'pending' ORDER BY created_at DESC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToCommentReply);
}

export function updateCommentReplyStatus(
  id: number,
  status: "approved" | "rejected" | "sent",
  reviewedBy?: string,
): void {
  const database = getSocialDb();
  database
    .prepare(
      `UPDATE comment_replies SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
    )
    .run(status, new Date().toISOString(), reviewedBy ?? "marco", id);
}

export function saveMorningScanResult(result: {
  scannedAt: string;
  newComments: number;
  newMentions: number;
  leadIntentFlags: unknown[];
  fetchError?: string;
}): void {
  const database = getSocialDb();
  migrateMorningScansTable(database);
  database
    .prepare(
      `INSERT INTO morning_scans (scanned_at, new_comments, new_mentions, lead_intent_flags, fetch_error)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      result.scannedAt,
      result.newComments,
      result.newMentions,
      JSON.stringify(result.leadIntentFlags),
      result.fetchError ?? null,
    );
}

export function getLatestMorningScanFromDb(): {
  scannedAt: string;
  newComments: number;
  newMentions: number;
  leadIntentFlags: unknown[];
  fetchError?: string;
} | null {
  const database = getSocialDb();
  const row = database
    .prepare(`SELECT * FROM morning_scans ORDER BY scanned_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  let leadIntentFlags: unknown[] = [];
  try {
    leadIntentFlags = JSON.parse(String(row.lead_intent_flags)) as unknown[];
  } catch {
    leadIntentFlags = [];
  }
  return {
    scannedAt: String(row.scanned_at),
    newComments: Number(row.new_comments) || 0,
    newMentions: Number(row.new_mentions) || 0,
    leadIntentFlags,
    fetchError: row.fetch_error ? String(row.fetch_error) : undefined,
  };
}

export type AgentPullType =
  | "social_refresh"
  | "evening_pull"
  | "content_digest"
  | "morning_scan"
  | "content_suggestions"
  | "escalation_check";

export interface AgentPullLogEntry {
  id?: number;
  pulledAt: string;
  pullType: AgentPullType;
  status: "success" | "error";
  summary: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

function mapAgentPullRow(row: Record<string, unknown>): AgentPullLogEntry {
  let details: Record<string, unknown> | undefined;
  if (row.details) {
    try {
      details = JSON.parse(String(row.details)) as Record<string, unknown>;
    } catch {
      details = undefined;
    }
  }
  return {
    id: row.id != null ? Number(row.id) : undefined,
    pulledAt: String(row.pulled_at),
    pullType: row.pull_type as AgentPullType,
    status: row.status as AgentPullLogEntry["status"],
    summary: String(row.summary),
    details,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
  };
}

export function logAgentPull(entry: Omit<AgentPullLogEntry, "id">): void {
  const database = getSocialDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_pull_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pulled_at TEXT NOT NULL,
      pull_type TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT,
      duration_ms INTEGER
    )
  `);

  database
    .prepare(
      `INSERT INTO agent_pull_log (pulled_at, pull_type, status, summary, details, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.pulledAt,
      entry.pullType,
      entry.status,
      entry.summary,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.durationMs ?? null,
    );
}

export function getRecentAgentPulls(limit = 20): AgentPullLogEntry[] {
  const database = getSocialDb();
  try {
    const rows = database
      .prepare(`SELECT * FROM agent_pull_log ORDER BY pulled_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(mapAgentPullRow);
  } catch {
    return [];
  }
}

export function getTodaysAgentPulls(): AgentPullLogEntry[] {
  const database = getSocialDb();
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const rows = database
      .prepare(`SELECT * FROM agent_pull_log WHERE pulled_at >= ? ORDER BY pulled_at DESC`)
      .all(todayStart.toISOString()) as Array<Record<string, unknown>>;
    return rows.map(mapAgentPullRow);
  } catch {
    return [];
  }
}
