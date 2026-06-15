/** Harvey operator stack — shared types (Aethon Intelligence / Marco Puga). */

export type HarveyDirectiveSeverity = "info" | "warn" | "danger";

export interface HarveyDirective {
  text: string;
  severity: HarveyDirectiveSeverity;
}

export interface HarveyLeadSummary {
  id: string;
  name: string | null;
  username: string | null;
  platform: string;
  phone: string | null;
  email: string | null;
  funnelState: string;
  crmStatus: string;
  crmStage: string;
  crmIntent: string;
  crmCallQueue: string;
  adCampaign: string | null;
  hasPhone: boolean;
  userMessageCount: number;
  assistantMessageCount: number;
  lastMessageAt: string | null;
  updatedAt: string;
  hoursSinceUpdate: number;
}

export interface HarveyAdsSnapshot {
  configured: boolean;
  generatedAt: string | null;
  datePreset: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  adLeads: number | null;
  ctr: number | null;
  cpl: number | null;
  campaignCount: number;
  adsetCount: number;
}

export interface HarveyContext {
  generatedAt: string;
  totals: {
    allLeads: number;
    withPhone: number;
    withEmail: number;
    phoneCaptureRatePct: number;
    phonesLast24h: number;
  };
  byPlatform: { instagram: number; tiktok: number; other: number };
  byAdCampaign: {
    canyon_lake_ad: number;
    low_interest_ad: number;
    unattributed: number;
    canyonWithPhone: number;
    lowInterestWithPhone: number;
  };
  funnelDistribution: Record<string, number>;
  crmStatusBreakdown: Record<string, number>;
  crmStageBreakdown: Record<string, number>;
  callQueue: { urgent: number; routine: number; none: number };
  hotLeads: HarveyLeadSummary[];
  noInteractionLeads: HarveyLeadSummary[];
  stalledOpeningLeads: HarveyLeadSummary[];
  recentLeads: HarveyLeadSummary[];
  ads: HarveyAdsSnapshot;
  systems: {
    anthropicConfigured: boolean;
    twilioConfigured: boolean;
    /** @deprecated Jarvis UI reads this — mirrors twilioConfigured */
    sendblueConfigured?: boolean;
    adsLinked: boolean;
  };
}

export type HarveyFocusArea =
  | "hot_leads_sms"
  | "new_phone_captures"
  | "no_interaction"
  | "stalled_dm_funnel"
  | "call_queue"
  | "ad_performance"
  | "platform_mix"
  | "steady_state";

export interface JudgmentResult {
  focus: HarveyFocusArea[];
  directives: HarveyDirective[];
  briefingSeed: string;
}

export interface HarveyUiPayload {
  panel: string;
  action: string;
  data: Record<string, unknown>;
}

export interface HarveyChatResponse {
  speech: string;
  intent: string;
  ui: HarveyUiPayload;
  directives: HarveyDirective[];
  sessionId: string;
  metrics: HarveyMetricsPanel;
  /** Back-compat for older clients */
  reply?: string;
}

export interface HarveyOpsResponse {
  context: HarveyContext;
  judgment: JudgmentResult;
  metrics: HarveyMetricsPanel;
}

export interface HarveyMetricsPanel {
  totalLeads: number;
  phonesCaptured: number;
  emailsCaptured: number;
  instagram: number;
  tiktok: number;
  canyonLakeAd: number;
  lowInterestAd: number;
  noInteraction: number;
  hotNeedsSms: number;
  phoneCaptureRatePct: number;
  phonesLast24h: number;
}

export interface HarveyMemoryTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}
