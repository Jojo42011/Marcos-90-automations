import type { FunnelStage } from "./state.js";
import type { MessageChannel } from "./messageChannels.js";

/**
 * `archived` and `trashed` were added 2026-08-24 at the operator's request.
 *
 * A lead is NEVER deleted here — that was explicit. Trash is a status, not a
 * removal: the record, its history and its transactions all stay, and the
 * lead table simply stops showing it by default. That way "we trashed it by
 * mistake" is one dropdown change rather than a restore from backup.
 */
export type CrmStatus =
  | "new" | "hot" | "nurture" | "watch" | "dead" | "unresponsive" | "archived" | "trashed";

/** Legacy status strings (pipeline / old DB rows) — normalized on read in db. */
export type CrmStatusLegacy = "not_contacted" | "contacted";

export type CrmStatusValue = CrmStatus | CrmStatusLegacy;

/** Valid CRM status values (dashboard + API). */
export const CRM_STATUSES: CrmStatus[] = [
  "new", "hot", "nurture", "watch", "dead", "unresponsive", "archived", "trashed",
];
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
  /** Include: lead must carry at least one of these tags. */
  tags?: string[];
  /** Exclude: lead must carry none of these tags. */
  tagsExclude?: string[];
  dateAddedFrom?: string;
  dateAddedTo?: string;
  lastContactFrom?: string;
  lastContactTo?: string;
  assignedUser?: string;
  /** Tri-state: true = must have, false = must not have, undefined = don't care. */
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasAddress?: boolean;
  /** "any" = enrolled in at least one plan, "none" = no enrollments, else a plan name. */
  autoPlan?: string;
  /** 1-12: month of the lead's birthday / home anniversary. */
  birthdayMonth?: number;
  anniversaryMonth?: number;
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
  /** scrypt hash, format "salt:hash" (hex). Absent until a password is set. */
  passwordHash?: string;
  /** true if the account still needs to change its (temp, admin-issued) password. */
  mustChangePassword?: boolean;
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
  /** Mailing address typed in the CRM (distinct from criteria.area / propertyInquired). */
  address?: string | null;
  /** ISO YYYY-MM-DD. Drives the Dates filters and future birthday touches. */
  birthday?: string | null;
  /** ISO YYYY-MM-DD — the anniversary of buying their home. */
  homeAnniversary?: string | null;
  /** Details block: free-text background on how the lead came in. */
  description?: string | null;
  /** Mail-merge personalization (Auto Plan emails / letters). */
  letterSalutation?: string | null;
  envelopeSalutation?: string | null;
  preferredLanguage?: string | null;
  /** Labeled links to other contacts (spouse, referred-by, co-buyer, ...). */
  relationships?: LeadRelationship[];
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
  /**
   * The MLS listing this lead asked about, once we are CERTAIN which one.
   *
   * Only ever written on an exact match (an MLS number, or an address that
   * resolves to a single listing) — `propertyInquired` stays as the lead's own
   * words. Keeping them separate matters: the free text is what they said, this
   * is what we resolved it to, and conflating them would make a wrong match
   * impossible to spot afterwards.
   */
  mlsListingKey?: string | null;
  /** ISO timestamp when phone was first captured. */
  phoneCapturedAt?: string;
  /** False until Marco/Carlos opens the lead in CRM after phone capture. */
  phoneNumberSeen?: boolean;
  /**
   * Out-of-state referral flow: `offered` = referral pitch sent;
   * `referral_needed` = lead accepted, Marco should connect them with a local agent.
   */
  referralStatus?: "offered" | "referral_needed" | null;
  /** Property showing appointment + reminder/confirmation state. */
  showingAppointment?: ShowingAppointment | null;
  /** Mojo cold-call text outreach sequence state. */
  mojoOutreach?: MojoOutreach | null;
  /** Conversation escalation paused automation until manually resumed. */
  automationPaused?: boolean;
  automationPausedReason?: ConversationEscalationTrigger | null;
  automationPausedAt?: string | null;
  /** Set when a transaction closes — triggers past client nurture eligibility. */
  isPastClient?: boolean;
  pastClientSince?: string | null;
  /** Manual CRM field — buyer pre-approval status for lead scoring. */
  preApprovalStatus?: PreApprovalStatus | null;
  /** Manual CRM override for property view count (also derived from activity when unset). */
  propertyViewsCount?: number;
  /** Set after source-based nurture routing runs once for this lead. */
  sourceRoutingCompletedAt?: string | null;
  /** Set after 3-minute auto-reply email is sent. */
  autoReplyEmailSentAt?: string | null;
  /** Set when no-reply follow-up moves lead to cold nurture (day 14). */
  movedToColdNurtureAt?: string | null;
  /** Last known website visit (future tracking pixel intake). */
  lastWebsiteVisitAt?: string | null;
  /** Cooldown guard — last time re-engagement automation fired. */
  lastReEngagementTriggeredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShowingAppointment {
  address: string;
  scheduledAt: string;
  reminderSentAt?: string;
  confirmationStatus: "pending" | "confirmed" | "no_response" | "cancelled";
  confirmationReceivedAt?: string;
  followUpSentAt?: string;
  followUpResponse?: string;
  followUpSentiment?: "positive" | "negative" | "neutral";
}

export type ConversationEscalationTrigger = "ready_to_offer" | "angry_client" | "legal_question";

export interface MojoOutreach {
  sequenceStarted: boolean;
  textsSent: number;
  lastTextSentAt?: string;
  pausedUntil?: string;
  status: "active" | "paused" | "replied" | "completed";
}

/** A single step in an Auto Plan drip campaign. */
export type AutoPlanStepType = "email" | "text" | "task";

/**
 * What a step's dayOffset counts from (Brivity's "After [...]" dropdown).
 * People plans: enrollment or a prior step's completion.
 * Transaction plans: one of the deal's real dates — dayOffset may be NEGATIVE
 * there ("-3 days from close_date" = 3 days before close).
 */
export type AutoPlanStepAnchor =
  | "enrollment"
  | "prev_step"
  | "contract_date"
  | "closing_date"
  | "expiration"
  | "inspection_date"
  /* Brivity's "Specific Dates" section: a step pinned to a real calendar date
     on the contact rather than to elapsed time. Both recur annually, so these
     pair naturally with recurrence "yearly". */
  | "birthday"
  | "home_anniversary";

/**
 * The unit of a step's offset amount. Brivity's step modals read
 * "Send [number] [unit] After [reference]" — days alone could not express
 * "text 30 minutes after the plan starts".
 */
export type AutoPlanOffsetUnit = "minutes" | "hours" | "days";

/** Task-step repeat, Brivity's "Recurring Frequency" (default Never). */
export type AutoPlanRecurrence = "never" | "daily" | "weekly" | "monthly" | "yearly";

export interface AutoPlanStep {
  id: string;
  type: AutoPlanStepType;
  /**
   * The offset AMOUNT (negative = before the anchor, 0 = at it). The unit is
   * `offsetUnit`, which defaults to days.
   *
   * Named `dayOffset` for history, not accuracy: every stored plan already
   * carries this key, and renaming it would silently reschedule live plans on
   * the first read. Read it as "offset", and always through `offsetUnit`.
   */
  dayOffset: number;
  /** Defaults to "days" — which is what every pre-existing step means. */
  offsetUnit?: AutoPlanOffsetUnit;
  /** Defaults to "enrollment" when absent — every pre-existing plan means that. */
  anchor?: AutoPlanStepAnchor;
  /** When anchor === "prev_step": which step's COMPLETION the offset counts from. */
  afterStepId?: string;
  /** Email subject only. */
  subject?: string;
  /** Email body, text message, or task description. */
  content: string;
  /** Task assignee — defaults to "Marco Puga". */
  assignedTo?: string;
  /** Task priority, Brivity's 1 (highest) – 9 (lowest) scale. */
  taskPriority?: number;
  /** Task execution instructions — detailed enough for a covering teammate. */
  instructions?: string;
  /**
   * Brivity's "Make Contingent": the due time follows when the previous step
   * ACTUALLY completed rather than staying pinned to the original schedule.
   * Only meaningful with anchor "prev_step" — a contingent step whose
   * predecessor is unfinished is simply not due yet.
   */
  contingent?: boolean;
  /** Task step only. Defaults to "never". */
  recurrence?: AutoPlanRecurrence;
  /**
   * Task step only. Posted to the contact's timeline when the task completes —
   * distinct from `instructions`, which tells the teammate how to do it.
   */
  notes?: string;
  /**
   * Email/text steps: who the message comes from — a role key
   * ("primary_agent", "listing_agent", ...) or a team member id. Brivity's own
   * guidance is to use a ROLE so the plan survives staffing changes.
   */
  sendFrom?: string;
  /** Email step only. Brivity has no CC on SMS, and neither do we. */
  cc?: string[];
  bcc?: string[];
  /** Email step only: reuse a saved template instead of retyping the body. */
  templateId?: string;
}

export interface AutoPlan {
  id: string;
  name: string;
  /** Which tag triggers this plan: Watch, Nurture, etc. (legacy trigger; see AutoPlanTrigger). */
  tag: string;
  /** "people" (contacts, default for all pre-existing plans) or "transaction" (deals, date-anchored). */
  planType?: "people" | "transaction";
  steps: AutoPlanStep[];
  active: boolean;
  /** Stop the plan the moment the contact actually replies by text (Brivity's safety valve). */
  autoPauseOnReply?: boolean;
  /** Pause automatically when the contact's CRM status changes to this value. */
  autoPauseOnStatus?: string | null;
  /** When every step finishes, flip the contact's CRM status to this. */
  completionStatus?: string | null;
  /** Archived plans are hidden from pickers/triggers but keep their history. */
  archived?: boolean;
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
  /** Step ID → ISO completion time; lets later steps chain off a prior step's completion. */
  completedAt?: Record<string, string>;
  /**
   * Step ID → ISO time a RECURRING step last fired, and how many times.
   * Recurring steps never enter `completedSteps` (they are never "done"), so
   * they need their own clock; the count is what stops a yearly step from
   * running forever on a contact nobody ever unenrolled.
   */
  lastRunAt?: Record<string, string>;
  runCount?: Record<string, number>;
  /** "manual" or the trigger id that auto-enrolled this contact. */
  enrolledVia?: string;
  status: "active" | "paused" | "completed";
}

/**
 * Automatic-enrollment rule (Brivity's "People Auto Plan Triggers"): when a
 * contact matches ALL non-null conditions, they are enrolled in the plan.
 * Per Brivity these four fields are the only ones a trigger can key off.
 */
export interface AutoPlanTrigger {
  id: string;
  /** null = Any. */
  intent: string | null;
  status: string | null;
  source: string | null;
  tag: string | null;
  planId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
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
  /** Honest status line when a lookup could not run (no provider configured). */
  note?: string;
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
  | "email_pending"
  | "auto_plan"
  /* Profile-page manual logging. "email_logged"/"text_logged" record that a
     message was written down, NOT that anything was delivered — the page has
     no send path and the type name must not imply one. */
  | "email_logged"
  | "text_logged"
  | "appointment"
  | "note"
  | "other";

/** Seller listing status (drives drawer badge + listing-status automations). */
export type ListingStatus = "active" | "off_market";

/** A labeled link from one contact to another (household / referral graph). */
export interface LeadRelationship {
  /** Other lead's id when they exist in the CRM; absent for a name-only link. */
  leadId?: string;
  name: string;
  /** e.g. "Spouse", "Referred by", "Co-buyer", "Child". Free text. */
  relation: string;
}

/** Single activity timeline entry on a lead. */
export interface LeadActivity {
  type: LeadActivityType;
  description: string;
  timestamp: string;
  /** Agent notes (power dialer / call logging). */
  notes?: string;
  /**
   * A narrower kind within `type`, chosen by a human in the composer.
   * The OTHER tab's Pop By / Mail / Social Media, and the CALL tab's outcome
   * (Talked, Left Message, No Answer …). Kept separate from `description`
   * because the timeline filters and colours on it, and parsing it back out
   * of a free-text sentence is exactly how a category quietly goes wrong.
   */
  subType?: string;
  /** Who logged it. Absent on entries the system generated for itself. */
  author?: string;
  /**
   * Flat, display-only detail the timeline card renders — subject, recipient,
   * duration, call source, message direction. Deliberately flat scalars: this
   * is what a card SHOWS, never state anything reads back to make a decision.
   */
  meta?: Record<string, string | number | boolean | null>;
}

export interface Criteria {
  priceCap: number | null;
  beds: number | null;
  baths: number | null;
  area: string | null;
  /** Buyer's timeline urgency — manual CRM entry (e.g. "ASAP", "3-6 months"). */
  timeline?: string | null;
}

export type PreApprovalStatus = "approved" | "in_progress" | "cash" | "not_approved";

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
  /**
   * Which Message Center inbox this thread belongs to — derived from
   * `platform` by messageChannels.ts, not stored. Social DMs (instagram /
   * tiktok) are separated from real SMS/email because they carry very
   * different urgency and shouldn't share one list.
   */
  channel: MessageChannel;
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
  address: string | null;
  birthday: string | null;
  homeAnniversary: string | null;
  description: string | null;
  letterSalutation: string | null;
  envelopeSalutation: string | null;
  preferredLanguage: string | null;
  relationships: LeadRelationship[];
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
  phoneCapturedAt?: string;
  phoneNumberSeen?: boolean;
}

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "on_hold"
  | "due_soon"
  | "overdue"
  | "completed"
  | "cancelled";

export const CRM_TASK_STATUSES: TaskStatus[] = [
  "pending",
  "in_progress",
  "on_hold",
  "due_soon",
  "overdue",
  "completed",
  "cancelled",
];

/* The four at the end come from Brivity's Add Task dialog (team feature list,
   Aug 2026). They are kinds of touch, not kinds of task: a door knock and a
   postcard are both work somebody has to do and tick off. */
export type TaskType =
  | "call"
  | "text"
  | "email"
  | "appointment"
  | "follow_up"
  | "other"
  | "to_do"
  | "mail"
  | "social_media"
  | "door_knock";

/** A due date expressed relative to a date on the contact, not as a calendar day. */
export type ContingentEvent =
  | "birthday"
  | "anniversary"
  | "organization_end_date"
  | "licensed_since"
  | "organization_start_date";

export interface TaskContingency {
  /** Whole days between the event and the due date. */
  days: number;
  direction: "before" | "after";
  event: ContingentEvent;
}

/** Appointment lifecycle, separate from the task's own workflow status. */
export type AppointmentStatus = "scheduled" | "completed" | "cancelled";
/** What actually happened. "none" until somebody says. */
export type AppointmentOutcome = "none" | "held" | "no_show" | "rescheduled";

export type TaskSource = "manual" | "auto_plan" | "dial_session" | "automation";

export interface Task {
  id: string;
  title: string;
  description?: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  /** Status before automatic due_soon/overdue move (for reversal). */
  previousStatus?: TaskStatus;
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
  /** Physical address or a video-call link. */
  location?: string;
  /** Steps for whoever picks this up. Kept apart from `description` so the
      Add Task dialog's two boxes stay two boxes on the way back out. */
  instructions?: string;
  /** Internal notes on the task itself. */
  taskNotes?: string;
  /** Repeats on completion. The engine is spawnNextRecurrence in server.ts. */
  recurring?: boolean;
  recurringInterval?: string;
  /**
   * Set when the due date was derived from a date on the contact rather than
   * picked off a calendar. Stored so the rule is visible afterwards — "3 days
   * before their anniversary" is the thing the operator wrote, and a bare
   * date cannot be corrected when the anniversary moves.
   */
  contingent?: TaskContingency;
  /** Appointment-only fields. Present when `type === "appointment"`. */
  appointmentType?: string;
  appointmentStatus?: AppointmentStatus;
  outcome?: AppointmentOutcome;
}

export interface TasksSummary {
  dueToday: number;
  overdue: number;
  pending: number;
  completedToday: number;
}

/** Carlos command-center task board (stored in db.json `commandTasks`). */
export type CommandTaskColumn = "urgent" | "today" | "tomorrow" | "this_week" | "this_month";

export type CommandTaskStatus = "pending" | "in_progress" | "on_hold" | "due_soon" | "overdue" | "done";

export const COMMAND_TASK_STATUSES: CommandTaskStatus[] = [
  "pending",
  "in_progress",
  "on_hold",
  "due_soon",
  "overdue",
  "done",
];

export type CommandTaskColor = "red" | "amber" | "green" | "blue" | "purple" | "gray";

export type CommandTaskRecurringInterval =
  | "daily"
  | "every_3_days"
  | "every_5_days"
  | "weekly"
  | "monthly";

/* ===== Buyers & Sellers Tracker =====
   Buyers and sellers run on separate pipelines, so stages are two distinct
   vocabularies rather than the single shared list the CRM used before. A record
   can sit on both tracks at once (Marco's "Buyer & Seller" intent), which is why
   buyerStage and sellerStage are independent rather than one `stage` field. */

export type TrackerSide = "buyer" | "seller";

/** Statuses are shared across both pipelines. */
export type TrackerStatus = "new" | "unqualified" | "watch" | "nurture" | "hot" | "pending";

export const TRACKER_STATUSES: TrackerStatus[] = [
  "new", "unqualified", "watch", "nurture", "hot", "pending",
];

export type BuyerStage =
  | "contacted"
  | "qualified"
  | "pre_approved"
  | "buyer_rep_signed"
  | "actively_showing"
  | "offer_submitted"
  | "under_contract"
  | "option_period"
  | "clear_to_close"
  | "closed"
  | "past_client";

export type SellerStage =
  | "new"
  | "contacted"
  | "cma_requested"
  | "listing_appointment_set"
  | "appointment_held"
  | "listing_agreement_signed"
  | "prep_pre_market"
  | "active_on_mls"
  | "price_adjustment"
  | "offer_received"
  | "under_contract"
  | "option_period"
  | "clear_to_close"
  | "closed"
  | "past_client";

/** Ordered, with labels, so UI and reporting share one source of truth. */
export const BUYER_STAGES: Array<{ key: BuyerStage; label: string }> = [
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "pre_approved", label: "Pre-Approved" },
  { key: "buyer_rep_signed", label: "Buyer Rep Signed" },
  { key: "actively_showing", label: "Actively Showing" },
  { key: "offer_submitted", label: "Offer Submitted" },
  { key: "under_contract", label: "Under Contract" },
  { key: "option_period", label: "Option Period" },
  { key: "clear_to_close", label: "Clear to Close" },
  { key: "closed", label: "Closed" },
  { key: "past_client", label: "Past Client" },
];

export const SELLER_STAGES: Array<{ key: SellerStage; label: string }> = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "cma_requested", label: "CMA Requested" },
  { key: "listing_appointment_set", label: "Listing Appointment Set" },
  { key: "appointment_held", label: "Appointment Held" },
  { key: "listing_agreement_signed", label: "Listing Agreement Signed" },
  { key: "prep_pre_market", label: "Prep/Pre-Market" },
  { key: "active_on_mls", label: "Active on MLS" },
  { key: "price_adjustment", label: "Price Adjustment" },
  { key: "offer_received", label: "Offer Received" },
  { key: "under_contract", label: "Under Contract" },
  { key: "option_period", label: "Option Period" },
  { key: "clear_to_close", label: "Clear to Close" },
  { key: "closed", label: "Closed" },
  { key: "past_client", label: "Past Client" },
];

/**
 * Per-stage extras. Buyer "Qualified" carries the buyer's timeline date, which is
 * why stages need somewhere to hang data instead of being a bare enum.
 */
export interface TrackerStageMeta {
  /** YYYY-MM-DD. Buyer > Qualified: when they intend to buy. */
  timelineDate?: string;
  /** When the record entered this stage. */
  enteredAt?: string;
  note?: string;
}

export interface TrackerRecord {
  id: string;
  /** Links back to the CRM lead when the record came from there. */
  leadId?: string;
  /** Which pipeline(s) this record is on. */
  sides: TrackerSide[];
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  source?: string;
  status: TrackerStatus;
  buyerStage?: BuyerStage;
  sellerStage?: SellerStage;
  /** Keyed "buyer:qualified" / "seller:active_on_mls". */
  stageMeta?: Record<string, TrackerStageMeta>;
  notes?: string;
  /** Same shape as task checklists, so items can sync into Task Command. */
  checklist?: CommandTaskChecklistItem[];
  /** Tasks this record has pushed into the Task Manager. */
  taskIds?: string[];
  assignedTo?: string;
  lastInteractionAt?: string;
  addedAt: string;
  updatedAt: string;
  /**
   * The pre-tracker CRM stage this record carried, kept so the migration is
   * reversible and a mis-mapped record can be re-derived rather than re-entered.
   */
  legacyStage?: string;
}

/** One row of a task's "Details / Notes" checklist. */
export interface CommandTaskChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /**
   * Set when a tracker checklist item has been pushed to the Task Manager as a
   * real CommandTask. Completion then travels both ways between the two.
   */
  taskId?: string;
}

export interface CommandTask {
  id: string;
  title: string;
  description?: string;
  /** Optional checkbox list kept alongside the free-text notes. */
  checklist?: CommandTaskChecklistItem[];
  column: CommandTaskColumn;
  status: CommandTaskStatus;
  /** Status before automatic due_soon/overdue move (for reversal). */
  previousStatus?: CommandTaskStatus;
  color: CommandTaskColor;
  recurring?: boolean;
  recurringInterval?: CommandTaskRecurringInterval;
  createdBy?: string;
  assignedTo?: string;
  dueDate?: string;
  /** Time of day the task is due, "HH:MM" 24h local, paired with dueDate. */
  dueTime?: string;
  /** Minutes-before-due to fire early reminders, e.g. [10, 5]. */
  reminderMinutes?: number[];
  /** Manual drag-and-drop position within a task bar (lower = higher). */
  sortOrder?: number;
  /**
   * Set when this task was raised from a Content Planner slot. It is the WHOLE
   * link between the two: the content card reads its tasks straight out of this
   * store, so there is no second copy of a task's state to drift. Tasks created
   * on a content card are ordinary Task Command tasks in every other respect —
   * same board, same notifications, same reminders.
   */
  contentSlotId?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}

export interface CommandTasksSummary {
  urgent: number;
  today: number;
  totalPending: number;
}

export type MarcoTaskPriority = "high" | "medium" | "low";

export type MarcoTaskStatus =
  | "pending"
  | "in_progress"
  | "on_hold"
  | "due_soon"
  | "overdue"
  | "done";

export const MARCO_TASK_STATUSES: MarcoTaskStatus[] = [
  "pending",
  "in_progress",
  "on_hold",
  "due_soon",
  "overdue",
  "done",
];

export interface MarcoTask {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  priority: MarcoTaskPriority;
  status: MarcoTaskStatus;
  /** Status before automatic due_soon/overdue move (for reversal). */
  previousStatus?: MarcoTaskStatus;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface MarcoTasksSummary {
  pending: number;
  inProgress: number;
  done: number;
  highPriority: number;
  overdue: number;
}

export type HarveyNoteCategory =
  | "general"
  | "lead"
  | "listing"
  | "idea"
  | "follow_up"
  | "meeting";

export interface HarveyNote {
  id: string;
  content: string;
  title?: string;
  category: HarveyNoteCategory;
  leadId?: string;
  leadName?: string;
  tags?: string[];
  source: "voice" | "text" | "auto";
  createdAt: string;
  updatedAt: string;
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
  commandTasksSummary: CommandTasksSummary;
  marcoTasksSummary: MarcoTasksSummary;
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
  /**
   * Which listing the lead messaged about, as ManyChat knows it — the post or
   * video the automation fired from. Accepts an MLS number or a listingKey; the
   * pipeline resolves it against the MLS mirror and only then links the lead.
   *
   * This is the difference between an agent that has to ask "which property?"
   * and one that already knows. Absent (the default for every automation that
   * has not been configured to send it), everything behaves exactly as before.
   */
  listingRef: string | null;
}

