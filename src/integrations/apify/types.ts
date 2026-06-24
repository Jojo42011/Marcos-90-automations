export interface TikTokVideoNormalized {
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
  avgWatchTime?: number;
  duration?: number;
  accountHandle?: string;
}

export interface TikTokProfileInfo {
  username: string;
  nickname: string;
  followers: number;
  following: number;
  heartCount: number;
  videoCount: number;
  avatar: string;
}

export interface TikTokFetchResult {
  profile: TikTokProfileInfo | null;
  videos: TikTokVideoNormalized[];
}

export interface TikTokComment {
  text: string;
  authorUsername: string;
  postId: string;
  createdAt: string;
  likes: number;
}

export type VideoTier = "hot" | "warm" | "cold";

export interface VideoScoreBreakdown {
  score: number;
  viewsScore: number;
  retentionScore: number;
  savesScore: number;
  sharesScore: number;
  tier: VideoTier;
}

export interface ScoredTikTokVideo extends TikTokVideoNormalized {
  score: number;
  tier: VideoTier;
  viral: boolean;
  engagementRate: number;
  scoreBreakdown: VideoScoreBreakdown;
}

export interface ScoreVideosResult {
  avgViews: number;
  avgEngagementRate: number;
  videos: ScoredTikTokVideo[];
}

export interface ContentTypePerformance {
  category: string;
  videoCount: number;
  avgViews: number;
  avgEngagementRate: number;
}

export interface ContentPatterns {
  topHashtagsByAvgViews: Array<{ hashtag: string; avgViews: number; count: number }>;
  hotCaptionKeywords: string[];
  bestPostingDay: string | null;
  bestPostingHour: number | null;
  contentTypeBreakdown: ContentTypePerformance[];
}
