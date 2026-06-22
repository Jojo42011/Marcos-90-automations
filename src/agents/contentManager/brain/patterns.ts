import {
  CONTENT_BENCHMARK_VIEWS,
  listCombinationPatterns,
  listVideosForPatternAnalysis,
  upsertCombinationPattern,
  type CmCombinationPattern,
} from "../../../core/contentDb.js";
import { classifyHook } from "./hookClassifier.js";
import { computeDecayWeightedAvg } from "./decay.js";

function hourBucket(hour: number): string {
  if (hour >= 6 && hour <= 11) return "morning";
  if (hour >= 12 && hour <= 16) return "afternoon";
  if (hour >= 17 && hour <= 21) return "evening";
  return "night";
}

function captionBucket(len: number): string {
  if (len < 80) return "short";
  if (len <= 150) return "medium";
  return "long";
}

export function updateCombinationPatterns(): number {
  const videos = listVideosForPatternAnalysis();
  const groups = new Map<
    string,
    {
      pillar: string;
      hookType: string;
      postingDay: string;
      postingHourBucket: string;
      captionLengthBucket: string;
      videos: Array<{ views: number; publishedAt: string; above: boolean }>;
    }
  >();

  for (const v of videos) {
    if (!v.publishedAt || v.views <= 0) continue;
    const hookType = v.hookType || classifyHook(v.hook).hookType;
    const d = new Date(v.publishedAt);
    const postingDay = d.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "America/Chicago",
    });
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "numeric",
        hour12: false,
      }).format(d),
    );
    const key = `${v.pillar}|${hookType}|${postingDay}|${hourBucket(hour)}|${captionBucket(v.caption.length)}`;
    const g = groups.get(key) ?? {
      pillar: v.pillar,
      hookType,
      postingDay,
      postingHourBucket: hourBucket(hour),
      captionLengthBucket: captionBucket(v.caption.length),
      videos: [],
    };
    g.videos.push({
      views: v.views,
      publishedAt: v.publishedAt,
      above: v.views >= CONTENT_BENCHMARK_VIEWS,
    });
    groups.set(key, g);
  }

  let upserted = 0;
  for (const g of groups.values()) {
    const avgViews = computeDecayWeightedAvg(g.videos);
    const above = g.videos.filter((x) => x.above).length;
    upsertCombinationPattern({
      pillar: g.pillar,
      hookType: g.hookType,
      postingDay: g.postingDay,
      postingHourBucket: g.postingHourBucket,
      captionLengthBucket: g.captionLengthBucket,
      sampleCount: g.videos.length,
      avgViews,
      avgEngagementRate: 0,
      aboveBenchmarkCount: above,
    });
    upserted++;
  }
  return upserted;
}

export function getTopCombinations(limit = 5): CmCombinationPattern[] {
  return listCombinationPatterns({ minSamples: 2, limit, order: "desc" });
}

export function getWorstCombinations(limit = 3): CmCombinationPattern[] {
  return listCombinationPatterns({ minSamples: 3, limit, order: "asc" });
}

export function getBestHourForPillar(
  pillar: string,
): { day: string; hour_bucket: string; avg_views: number } | null {
  const patterns = listCombinationPatterns({ pillar, minSamples: 2, limit: 100, order: "desc" });
  if (patterns.length === 0) return null;
  const best = patterns[0];
  return {
    day: best.postingDay,
    hour_bucket: best.postingHourBucket,
    avg_views: best.avgViews,
  };
}
