import type { FunnelStage } from "./state.js";

export type CrmStatus = "new" | "hot" | "nurture" | "watch" | "dead" | "unresponsive";

/** Legacy status strings (pipeline / old DB rows) — normalized on read in db. */
export type CrmStatusLegacy = "not_contacted" | "contacted";

export type CrmStatusValue = CrmStatus | CrmStatusLegacy;

/** Valid CRM status values (dashboard + API). */
export const CRM_STATUSES: CrmStatus[] = ["new", "hot", "nurture", "watch", "dead", "unresponsive"];
export type CrmStage =
  | "new"
  | "hot"
  | "warm"
  | "cold"
  | "pending"
  | "appointment_set"
  | "showing_set"
  | "under_contract"
  | "closed";

export const CRM_STAGES: CrmStage[] = [
  "new",
  "hot",
  "warm",
  "cold",
  "pending",
  "appointment_set",
  "showing_set",
  "under_contract",
  "closed",
];
export type CrmPriority = "low" | "normal" | "high";
/** Buyer vs seller vs both — drives dashboard funnels and colored views. */
export type CrmIntent = "buyer" | "seller" | "buyer_seller";
/** Marco call prioritization in CRM (two queues + unset). */
export type CrmCallQueue = "none" | "urgent" | "routine";

/** Advanced leads filter (AND across fields; ANY within status/source/stage/tags arrays). */
export interface LeadFilter {
  intent?: CrmIntent;
  status?: string[];
  source?: string[];
  stage?: string[];
  tags?: string[];
  dateAddedFrom?: string;
  dateAddedTo?: string;
  lastContactFrom?: string;
  lastContactTo?: string;
  assignedUser?: string;
}

export type UserRole = "admin" | "agent" | "isa" | "custom";

export interface UserPermissions {
  canDeleteTasks: boolean;
  canViewAllLeads: boolean;
  canAccessSettings: boolean;
  canAccessAutomations: boolean;
  canExportCSV: boolean;
  canMassText: boolean;
  canMassEmail: boolean;
  canManageTags: boolean;
  canManageAutoPlans: boolean;
  canViewReports: boolean;
}

export const ROLE_PERMISSIONS: Record<UserRole, UserPermissions> = {
  admin: {
    canDeleteTasks: true,
    canViewAllLeads: true,
    canAccessSettings: true,
    canAccessAutomations: true,
    canExportCSV: true,
    canMassText: true,
    canMassEmail: true,
    canManageTags: true,
    canManageAutoPlans: true,
    canViewReports: true,
  },
  agent: {
    canDeleteTasks: false,
    canViewAllLeads: false,
    canAccessSettings: false,
    canAccessAutomations: false,
    canExportCSV: true,
    canMassText: true,
    canMassEmail: true,
    canManageTags: false,
    canManageAutoPlans: false,
    canViewReports: true,
  },
  isa: {
    canDeleteTasks: false,
    canViewAllLeads: true,
    canAccessSettings: false,
    canAccessAutomations: false,
    canExportCSV: false,
    canMassText: true,
    canMassEmail: false,
    canManageTags: false,
    canManageAutoPlans: false,
    canViewReports: false,
  },
  custom: {
    canDeleteTasks: false,
    canViewAllLeads: false,
    canAccessSettings: false,
    canAccessAutomations: false,
    canExportCSV: false,
    canMassText: false,
    canMassEmail: false,
    canManageTags: false,
    canManageAutoPlans: false,
    canViewReports: false,
  },
};

export interface CRMUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  permissions: UserPermissions;
  assignedLeadIds?: string[];
  active: boolean;
  createdAt: string;
  lastLogin?: string;
  avatarInitials: string;
  avatarColor: string;
}

/** Customizable tag template (badge color + label). */
export interface TagTemplate {
  id: string;
  name: string;
  /** Hex color for the badge, e.g. #f59e0b */
  color: string;
  createdAt: string;
}

/**
 * Lead — single source of truth per platform + userId.
 */
export interface Lead {
  id: string;
  platform: string;
  userId: string;
  username: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  state: FunnelStage;
  source: string | null;
  /** Detected from first inbound message phrase (Instagram ad attribution). */
  adCampaign: string | null;
  propertyInquired: string | null;
  criteria: Criteria | null;
  brivityId: string | null;
  /** Lightweight CRM fields for Marco's mission terminal. */
  crmStatus: CrmStatusValue;
  crmStage: CrmStage;
  crmPriority: CrmPriority;
  crmIntent: CrmIntent;
  crmCallQueue: CrmCallQueue;
  crmNotes: string | null;
  /** CRM labels (dashboard-managed). */
  tags?: string[];
  /** Listing-alert / market-report counts. Default 0; never auto-generated. */
  alerts?: number;
  reports?: number;
  /** Optional deal record attached from the lead profile drawer. */
  deal?: LeadDeal | null;
  /** Activity timeline entries (calls, texts, emails, web visits, etc.). */
  activity?: LeadActivity[];
  /** Skip trace lookup history (Forewarn or mock). */
  skipTraceResults?: SkipTraceResult[];
  /** Timestamp of the most recent activity/interaction (drives re-engagement checks). */
  lastActivity?: string | null;
  /** Seller listing status — drives the drawer badge and listing automations. */
  listingStatus?: ListingStatus | null;
  /** Auto Plan enrollments (drip campaigns triggered by tags). */
  autoPlanEnrollments?: LeadAutoPlanEnrollment[];
  /** Digital signing documents attached to this lead. */
  documents?: SigningDocument[];
  /** CRM user assigned to this lead. */
  assignedUserId?: string | null;
  assignedUserName?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A single step in an Auto Plan drip campaign. */
export type AutoPlanStepType = "email" | "text" | "task";

export interface AutoPlanStep {
  id: string;
  type: AutoPlanStepType;
  /** Days after plan start: 0 = same day, 3 = day 3, 30 = day 30. */
  dayOffset: number;
  /** Email subject only. */
  subject?: string;
  /** Email body, text message, or task description. */
  content: string;
  /** Task assignee — defaults to "Marco Puga". */
  assignedTo?: string;
}

export interface AutoPlan {
  id: string;
  name: string;
  /** Which tag triggers this plan: Watch, Nurture, etc. */
  tag: string;
  steps: AutoPlanStep[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LeadAutoPlanEnrollment {
  planId: string;
  planName: string;
  enrolledAt: string;
  currentStepIndex: number;
  /** Step IDs already executed. */
  completedSteps: string[];
  status: "active" | "paused" | "completed";
}

/** Digital signing document attached to a lead. */
export interface SigningDocument {
  id: string;
  name: string;
  /** base64 encoded PDF. */
  fileData: string;
  status: "pending" | "sent" | "signed" | "declined";
  sentAt?: string;
  signedAt?: string;
  signerEmail?: string;
  signerName?: string;
}

export type DealStatus = "prospect" | "active" | "under_contract" | "closed" | "fallen_through";

export type DealType = "buyer" | "seller" | "referral" | "investor";

export interface DealActivityLogEntry {
  type: string;
  description: string;
  timestamp: string;
}

/** Standalone transaction deal (Deals tab). */
export interface Deal {
  id: string;
  leadId?: string;
  leadName: string;
  phone?: string;
  email?: string;
  propertyAddress: string;
  dealType: DealType;
  status: DealStatus;
  salePrice?: number;
  commissionPercent?: number;
  estimatedGCI?: number;
  closeDate?: string;
  openedDate: string;
  closedDate?: string;
  assignedTo?: string;
  notes?: string;
  documents?: SigningDocument[];
  activityLog?: DealActivityLogEntry[];
  createdAt: string;
  updatedAt: string;
}

export type SkipTraceResult = {
  runAt: string;
  source: string;
  foundName?: string;
  foundEmail?: string;
  foundAddress?: string;
  propertyOwnership?: {
    address: string;
    owner: string;
    estimatedValue?: number;
    lastSaleDate?: string;
    lastSalePrice?: number;
  }[];
  additionalPhones?: string[];
  confidence?: "high" | "medium" | "low";
  raw?: unknown;
};

/** Deal attached to a lead (from the profile drawer "Deal" modal). */
export interface LeadDeal {
  name: string;
  address: string | null;
  value: number | null;
  stage: "prospect" | "active" | "under_contract" | "closed";
  closeDate: string | null;
  notes: string | null;
}

export type DialSessionStatus = "idle" | "active" | "paused" | "completed";

export type DialSessionLeadStatus =
  | "pending"
  | "calling"
  | "completed"
  | "skipped"
  | "no_answer"
  | "voicemail";

export interface DialSessionLead {
  leadId: string;
  name: string;
  phone: string;
  status: DialSessionLeadStatus;
  callStarted?: string;
  callEnded?: string;
  /** Call length in seconds. */
  duration?: number;
  /** Notes on the call / outcome label. */
  outcome?: string;
  aiSuggestionsCount?: number;
}

export interface DialSession {
  id: string;
  createdAt: string;
  status: DialSessionStatus;
  leads: DialSessionLead[];
  currentIndex: number;
  totalCalled: number;
  totalAnswered: number;
  totalSkipped: number;
}

/** Archived power-dial session (last 5 shown on Calls tab). */
export interface CompletedDialSessionRecord {
  id: string;
  completedAt: string;
  totalCalled: number;
  totalAnswered: number;
  totalSkipped: number;
  leads: DialSessionLead[];
  /** Sum of per-lead durations (seconds). */
  durationSec: number;
}

export type LeadActivityType =
  | "call"
  | "call_made"
  | "skip_trace"
  | "text_sent"
  | "text_received"
  | "email_sent"
  | "web_visit"
  | "home_hearted"
  | "home_clicked"
  | "re_engagement"
  | "listing_off_market"
  | "listing_active"
  | "task"
  | "email_pending";

/** Seller listing status (drives drawer badge + listing-status automations). */
export type ListingStatus = "active" | "off_market";

/** Single activity timeline entry on a lead. */
export interface LeadActivity {
  type: LeadActivityType;
  description: string;
  timestamp: string;
  /** Agent notes (power dialer / call logging). */
  notes?: string;
}

export interface Criteria {
  priceCap: number | null;
  beds: number | null;
  baths: number | null;
  area: string | null;
}

export interface Message {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface Conversation {
  messages: Message[];
}

/** Read-only aggregate for the lead desk dashboard (from file-backed DB). */
export interface DashboardLeadRow {
  id: string;
  platform: string;
  userId: string;
  username: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  state: string;
  source: string | null;
  adCampaign: string | null;
  propertyInquired: string | null;
  criteria: Criteria | null;
  brivityId: string | null;
  crmStatus: CrmStatusValue;
  crmStage: CrmStage;
  crmPriority: CrmPriority;
  crmIntent: CrmIntent;
  crmCallQueue: CrmCallQueue;
  crmNotes: string | null;
  tags: string[];
  alerts: number;
  reports: number;
  createdAt: string;
  updatedAt: string;
  userMessageCount: number;
  assistantMessageCount: number;
  totalMessages: number;
  lastMessageAt: string | null;
  /** Full conversation messages (for chat thread + drawer conversation history). */
  messages: Message[];
  /** Activity timeline entries (newest-first display handled client-side). */
  activity: LeadActivity[];
  /** Optional deal attached to this lead. */
  deal: LeadDeal | null;
  /** Timestamp of the most recent activity/interaction. */
  lastActivity: string | null;
  /** Seller listing status (active / off_market / null). */
  listingStatus: ListingStatus | null;
  /** Auto Plan enrollments (drip campaigns). */
  autoPlanEnrollments: LeadAutoPlanEnrollment[];
  /** Digital signing documents attached to this lead. */
  documents: SigningDocument[];
  assignedUserId: string | null;
  assignedUserName: string | null;
  skipTraceResults: SkipTraceResult[];
}

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type TaskType = "call" | "text" | "email" | "appointment" | "follow_up" | "other";

export type TaskSource = "manual" | "auto_plan" | "dial_session" | "automation";

export interface Task {
  id: string;
  title: string;
  description?: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string;
  dueTime?: string;
  leadId?: string;
  leadName?: string;
  assignedUserId?: string;
  assignedUserName?: string;
  completedAt?: string;
  completedBy?: string;
  createdAt: string;
  updatedAt: string;
  source: TaskSource;
  reminderMinutes?: number;
}

export interface TasksSummary {
  dueToday: number;
  overdue: number;
  pending: number;
  completedToday: number;
}

export interface DashboardSnapshot {
  generatedAt: string;
  totals: {
    leads: number;
    withPhone: number;
    withEmail: number;
    shownLeads: number;
    totalUserMessages: number;
    totalAssistantMessages: number;
    totalMessages: number;
  };
  byPlatform: Record<string, number>;
  /** All leads with adCampaign set (includes leads without phone). */
  byAdCampaign: Record<string, number>;
  /** Phone-captured leads with adCampaign set. */
  byAdCampaignWithPhone: Record<string, number>;
  leads: DashboardLeadRow[];
  tagTemplates: TagTemplate[];
  users: CRMUser[];
  deals: Deal[];
  /** Sum of estimatedGCI on deals with status closed. */
  totalGCI: number;
  tasksSummary: TasksSummary;
}

export interface IncomingWebhookPayload {
  platform: string;
  userId: string;
  /** IG handle / stable id — stored on Lead.username for lookups and CRM. */
  username: string | null;
  /** Display name when ManyChat maps Full Name into `username` or sends full_name / name. */
  displayName: string | null;
  message: string;
  /** `comment` when the automation fired from an Instagram comment (ManyChat `comment_or_dm`). */
  commentOrDm: "comment" | "dm";
  /**
   * TikTok: Marco’s first DM was sent manually in-app. On the lead’s first reply, pass that exact text
   * so the thread has Marco’s opener before the user line — AI continues without duplicating it.
   */
  marcoPreviousOutbound: string | null;
}

