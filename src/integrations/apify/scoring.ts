import type {
  ContentPatterns,
  ContentTypePerformance,
  ScoreVideosResult,
  ScoredTikTokVideo,
  TikTokVideoNormalized,
  VideoScoreBreakdown,
  VideoTier,
} from "./types.js";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
  "is", "it", "this", "that", "was", "are", "be", "has", "had", "do", "did", "will",
  "you", "your", "we", "our", "my", "me", "i", "he", "she", "they", "them", "so",
  "if", "as", "by", "from", "up", "out", "about", "just", "get", "got", "can", "all",
  "not", "no", "yes", "what", "when", "where", "how", "why", "who", "which", "than",
  "then", "there", "here", "they're", "it's", "im", "i'm", "dont", "don't", "cant",
  "can't", "would", "could", "should", "have", "been", "being", "was", "were", "am",
  "https", "http", "www", "com", "tiktok",
]);

function engagementRate(video: TikTokVideoNormalized): number {
  if (video.views <= 0) return 0;
  return (video.likes + video.comments + video.shares + video.saves) / video.views;
}

function videoSaves(v: TikTokVideoNormalized): number {
  return v.saves ?? 0;
}

function videoShares(v: TikTokVideoNormalized): number {
  return v.shares ?? 0;
}

/** 95th percentile cap — one outlier cannot crush all other scores. */
function getRobustMax(values: number[]): number {
  const positive = values.filter((v) => v > 0);
  if (positive.length === 0) return 1;
  const sorted = [...positive].sort((a, b) => a - b);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return Math.max(sorted[p95Index], 1);
}

/** Weighted 0–100 score: views 35%, retention 30%, saves 20%, shares 15%. */
export function calculateVideoScore(
  video: TikTokVideoNormalized,
  allVideos: TikTokVideoNormalized[],
): VideoScoreBreakdown {
  const viewCounts = allVideos.map((v) => v.views || 0);
  const saveCounts = allVideos.map((v) => videoSaves(v));
  const shareCounts = allVideos.map((v) => videoShares(v));

  const positiveViews = viewCounts.filter((v) => v > 0);
  const avgViews =
    positiveViews.length > 0
      ? positiveViews.reduce((sum, v) => sum + v, 0) / positiveViews.length
      : 1;
  const p95Views = getRobustMax(viewCounts);
  // Blend p95 with avg — outlier-resistant but low-view videos aren't crushed vs one viral hit
  const maxViews = Math.max((p95Views + avgViews) / 2, 1);
  const maxSaves = getRobustMax(saveCounts);
  const maxShares = getRobustMax(shareCounts);

  const viewsScore = Math.min(100, ((video.views || 0) / maxViews) * 100);

  let retentionScore: number;
  if (video.avgWatchTime && video.duration && video.duration > 0) {
    retentionScore = Math.min(100, (video.avgWatchTime / video.duration) * 100);
  } else {
    const engagementRateVal =
      (video.views || 0) > 0
        ? ((video.likes || 0) + (video.comments || 0)) / (video.views || 1)
        : 0;
    retentionScore = Math.min(100, engagementRateVal * 1000);
  }

  const savesScore = Math.min(100, (videoSaves(video) / maxSaves) * 100);
  const sharesScore = Math.min(100, (videoShares(video) / maxShares) * 100);

  const score = Math.round(
    viewsScore * 0.35 + retentionScore * 0.3 + savesScore * 0.2 + sharesScore * 0.15,
  );

  let tier: VideoTier;
  if (score >= 70) tier = "hot";
  else if (score >= 40) tier = "warm";
  else tier = "cold";

  return {
    score,
    viewsScore: Math.round(viewsScore),
    retentionScore: Math.round(retentionScore),
    savesScore: Math.round(savesScore),
    sharesScore: Math.round(sharesScore),
    tier,
  };
}

/** Score each video 0–100 with component breakdown. */
export function scoreVideos(videos: TikTokVideoNormalized[]): ScoreVideosResult {
  const viewCounts = videos.map((v) => v.views || 0);
  const positiveViews = viewCounts.filter((v) => v > 0);
  const avgViewsLog =
    positiveViews.length > 0
      ? positiveViews.reduce((sum, v) => sum + v, 0) / positiveViews.length
      : 0;
  const p95Views = getRobustMax(viewCounts);
  const blendMax = Math.max((p95Views + avgViewsLog) / 2, 1);
  const topViews = [...viewCounts].sort((a, b) => b - a).slice(0, 10);
  console.log(
    "[Scoring] maxViews (p95):",
    p95Views,
    "avgViews:",
    Math.round(avgViewsLog),
    "blendMax:",
    Math.round(blendMax),
    "top views:",
    topViews,
  );

  const withViews = videos.filter((v) => v.views > 0);
  const avgViews =
    withViews.length > 0
      ? withViews.reduce((sum, v) => sum + v.views, 0) / withViews.length
      : 0;

  const rates = withViews.map(engagementRate).filter((r) => r > 0);
  const avgEngagementRate =
    rates.length > 0 ? rates.reduce((sum, r) => sum + r, 0) / rates.length : 0;

  const scored: ScoredTikTokVideo[] = videos.map((video) => {
    const breakdown = calculateVideoScore(video, videos);
    const rate = engagementRate(video);
    const viral = avgViews > 0 && video.views >= avgViews * 3;

    return {
      ...video,
      engagementRate: rate,
      score: breakdown.score,
      scoreBreakdown: breakdown,
      tier: breakdown.tier,
      viral,
    };
  });

  return { avgViews, avgEngagementRate, videos: scored };
}

function tokenizeCaption(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\w#@'\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t.replace(/^#/, "")));
}

function extractHashtags(text: string): string[] {
  const tags: string[] = [];
  const re = /#([\w]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].toLowerCase();
    if (tag) tags.push(tag);
  }
  return tags;
}

type ContentCategory = "pricing" | "tour" | "educational" | "location" | "general";

function detectContentCategory(caption: string): ContentCategory {
  const t = caption.toLowerCase();
  if (/\b(price|cost|how much|pricing|afford|payment|mortgage)\b/.test(t)) return "pricing";
  if (/\b(tour|walkthrough|inside|walk through|showing|see the)\b/.test(t)) return "tour";
  if (/\b(tip|mistake|secret|hack|advice|learn|did you know)\b/.test(t)) return "educational";
  if (
    /\b(canyon lake|stone oak|new braunfels|san antonio|boerne|schertz|alamo ranch)\b/.test(t)
  ) {
    return "location";
  }
  return "general";
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Content intelligence from captions + performance. */
export function extractContentPatterns(videos: ScoredTikTokVideo[]): ContentPatterns {
  const withViews = videos.filter((v) => v.views > 0);

  const hashtagBuckets: Record<string, { totalViews: number; count: number }> = {};
  for (const v of withViews) {
    for (const tag of extractHashtags(v.caption)) {
      if (!hashtagBuckets[tag]) hashtagBuckets[tag] = { totalViews: 0, count: 0 };
      hashtagBuckets[tag].totalViews += v.views;
      hashtagBuckets[tag].count += 1;
    }
  }

  const topHashtagsByAvgViews = Object.entries(hashtagBuckets)
    .map(([hashtag, b]) => ({
      hashtag,
      avgViews: Math.round(b.totalViews / b.count),
      count: b.count,
    }))
    .sort((a, b) => b.avgViews - a.avgViews)
    .slice(0, 5);

  const hotVideos = withViews.filter((v) => v.tier === "hot");
  const coldVideos = withViews.filter((v) => v.tier === "cold");

  const hotWordFreq: Record<string, number> = {};
  const coldWordFreq: Record<string, number> = {};

  for (const v of hotVideos) {
    for (const w of tokenizeCaption(v.caption)) {
      hotWordFreq[w] = (hotWordFreq[w] ?? 0) + 1;
    }
  }
  for (const v of coldVideos) {
    for (const w of tokenizeCaption(v.caption)) {
      coldWordFreq[w] = (coldWordFreq[w] ?? 0) + 1;
    }
  }

  const hotCaptionKeywords = Object.keys(hotWordFreq)
    .filter((w) => (hotWordFreq[w] ?? 0) >= 2 && !coldWordFreq[w])
    .sort((a, b) => (hotWordFreq[b] ?? 0) - (hotWordFreq[a] ?? 0))
    .slice(0, 3);

  const dayBuckets: Record<number, { totalViews: number; count: number }> = {};
  const hourBuckets: Record<number, { totalViews: number; count: number }> = {};

  for (const v of withViews) {
    if (!v.postedAt) continue;
    const d = new Date(v.postedAt);
    if (Number.isNaN(d.getTime())) continue;
    const day = d.getDay();
    const hour = d.getHours();
    if (!dayBuckets[day]) dayBuckets[day] = { totalViews: 0, count: 0 };
    dayBuckets[day].totalViews += v.views;
    dayBuckets[day].count += 1;
    if (!hourBuckets[hour]) hourBuckets[hour] = { totalViews: 0, count: 0 };
    hourBuckets[hour].totalViews += v.views;
    hourBuckets[hour].count += 1;
  }

  let bestPostingDay: string | null = null;
  let bestDayAvg = 0;
  for (const [day, b] of Object.entries(dayBuckets)) {
    const avg = b.totalViews / b.count;
    if (avg > bestDayAvg) {
      bestDayAvg = avg;
      bestPostingDay = DAY_NAMES[Number(day)] ?? null;
    }
  }

  let bestPostingHour: number | null = null;
  let bestHourAvg = 0;
  for (const [hour, b] of Object.entries(hourBuckets)) {
    const avg = b.totalViews / b.count;
    if (avg > bestHourAvg) {
      bestHourAvg = avg;
      bestPostingHour = Number(hour);
    }
  }

  const categoryBuckets: Record<
    ContentCategory,
    { totalViews: number; totalEng: number; count: number }
  > = {
    pricing: { totalViews: 0, totalEng: 0, count: 0 },
    tour: { totalViews: 0, totalEng: 0, count: 0 },
    educational: { totalViews: 0, totalEng: 0, count: 0 },
    location: { totalViews: 0, totalEng: 0, count: 0 },
    general: { totalViews: 0, totalEng: 0, count: 0 },
  };

  for (const v of withViews) {
    const cat = detectContentCategory(v.caption);
    categoryBuckets[cat].totalViews += v.views;
    categoryBuckets[cat].totalEng += v.engagementRate;
    categoryBuckets[cat].count += 1;
  }

  const contentTypeBreakdown: ContentTypePerformance[] = Object.entries(categoryBuckets)
    .filter(([, b]) => b.count > 0)
    .map(([category, b]) => ({
      category,
      videoCount: b.count,
      avgViews: Math.round(b.totalViews / b.count),
      avgEngagementRate: b.totalEng / b.count,
    }))
    .sort((a, b) => b.avgViews - a.avgViews);

  return {
    topHashtagsByAvgViews,
    hotCaptionKeywords,
    bestPostingDay,
    bestPostingHour,
    contentTypeBreakdown,
  };
}
