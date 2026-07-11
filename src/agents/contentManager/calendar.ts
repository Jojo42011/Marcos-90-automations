import type { ContentManagerBrain } from "./brain/index.js";
import { claudeContent, CONTENT_MODELS, logContentAiFailure } from "../../integrations/claude-content.js";
import { getWeekStart } from "./brain/stats.js";
import { generateRecordingTask } from "./competitiveAnalysis.js";
import {
  countPipelineVideosForDate,
  countPublishedVideosForDate,
  countPublishScheduledForDate,
  deleteDayPlanRecordingTasks,
  getSprintProgressData,
  getActiveStrategyRecommendations,
  getDailyStrategy,
  insertCalendarEvent,
  insertRecordingTask,
  listCalendarEventsForDate,
  listPublishLogForDate,
  listRecordingTasks,
  todayDateCst,
  updateCalendarEventByRecordingTaskId,
  updateRecordingTask,
  type CmCalendarEvent,
  type CmRecordingTask,
} from "../../core/contentDb.js";

const SPRINT_TARGET = 861;
const SPRINT_END_DATE = "2026-11-30";

export interface CalendarDayData {
  date: string;
  videosScheduled: Array<{
    videoId: string;
    title: string;
    platform: string;
    scheduledFor: string;
    status: string;
    thumbnail: string | null;
    pillar: string;
  }>;
  videosPublished: Array<{
    videoId: string;
    title: string;
    platform: string;
    publishedAt: string;
    views: number;
    score: number;
    postUrl: string | null;
  }>;
  recordingTasks: CmRecordingTask[];
  totalScheduledAndPublished: number;
  targetGap: number;
  calendarEvents: CmCalendarEvent[];
}

export interface CalendarMonthData {
  year: number;
  month: number;
  days: Array<{
    date: string;
    publishCount: number;
    recordingTaskCount: number;
    hasUrgentTask: boolean;
    pillarsPublishing: string[];
    targetMet: boolean;
  }>;
  monthTotals: {
    totalPublished: number;
    targetTotal: number;
    recordingTasksTotal: number;
    completedRecordingTasks: number;
  };
  sprintProgress: {
    totalVideosEver: number;
    sprintTarget: number;
    sprintEndDate: string;
    daysRemaining: number;
    videosNeededPerDay: number;
  };
}

function parseJsonFromText<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function daysRemainingToSprint(): number {
  const end = new Date(`${SPRINT_END_DATE}T23:59:59`);
  const now = new Date();
  const diff = end.getTime() - now.getTime();
  return Math.max(1, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

export function getSprintProgress(): ReturnType<typeof getSprintProgressData> {
  return getSprintProgressData();
}

export function getCalendarDayData(date: string): CalendarDayData {
  const publishRows = listPublishLogForDate(date);
  const videosScheduled = publishRows
    .filter((r) => r.publishStatus === "scheduled")
    .map((r) => ({
      videoId: r.videoId,
      title: r.title,
      platform: r.platform,
      scheduledFor: r.scheduledFor ?? r.publishedAt,
      status: "Scheduled",
      thumbnail: r.thumbnail,
      pillar: r.pillar,
    }));

  const videosPublished = publishRows
    .filter((r) => r.publishStatus === "success" || r.publishedAt.startsWith(date))
    .map((r) => ({
      videoId: r.videoId,
      title: r.title,
      platform: r.platform,
      publishedAt: r.publishedAt,
      views: r.views,
      score: r.score,
      // Live post URL (if Upload-Post returned one on confirmation) so the
      // calendar can link out to the real post.
      postUrl: r.platformPostId && /^https?:\/\//i.test(r.platformPostId) ? r.platformPostId : null,
    }));

  const publishedCount = countPublishedVideosForDate(date);
  const scheduledCount = countPublishScheduledForDate(date);
  const totalScheduledAndPublished = publishedCount + scheduledCount;
  const recordingTasks = listRecordingTasks({
    status: "pending",
    dueBefore: date,
    limit: 50,
  });

  return {
    date,
    videosScheduled,
    videosPublished,
    recordingTasks,
    totalScheduledAndPublished,
    targetGap: Math.max(0, 7 - totalScheduledAndPublished),
    calendarEvents: listCalendarEventsForDate(date),
  };
}

export function getCalendarMonthData(year: number, month: number): CalendarMonthData {
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStr = String(month).padStart(2, "0");
  const days: CalendarMonthData["days"] = [];

  let totalPublished = 0;
  let recordingTasksTotal = 0;
  let completedRecordingTasks = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${monthStr}-${String(d).padStart(2, "0")}`;
    const dayData = getCalendarDayData(date);
    const publishCount = dayData.totalScheduledAndPublished;
    totalPublished += countPublishedVideosForDate(date);

    const pendingTasks = listRecordingTasks({ dueBefore: date, status: "pending", limit: 100 });
    const urgent = pendingTasks.some((t) => t.priority === "urgent");
    recordingTasksTotal += pendingTasks.length;

    const publishRows = listPublishLogForDate(date);
    const pillars = new Set<string>();
    for (const v of dayData.videosScheduled) pillars.add(v.pillar);
    for (const v of dayData.videosPublished) {
      const match = publishRows.find((r) => r.videoId === v.videoId);
      if (match) pillars.add(match.pillar);
    }

    days.push({
      date,
      publishCount,
      recordingTaskCount: pendingTasks.length,
      hasUrgentTask: urgent,
      pillarsPublishing: [...pillars],
      targetMet: publishCount >= 7,
    });
  }

  const allTasks = listRecordingTasks({ limit: 500 });
  completedRecordingTasks = allTasks.filter((t) => t.status === "filmed" || t.status === "uploaded").length;

  const sprint = getSprintProgress();

  return {
    year,
    month,
    days,
    monthTotals: {
      totalPublished,
      targetTotal: daysInMonth * 7,
      recordingTasksTotal,
      completedRecordingTasks,
    },
    sprintProgress: {
      totalVideosEver: sprint.totalPublished,
      sprintTarget: SPRINT_TARGET,
      sprintEndDate: SPRINT_END_DATE,
      daysRemaining: sprint.daysRemaining,
      videosNeededPerDay: sprint.videosNeededPerDay,
    },
  };
}

export async function generateWeeklyRecordingPlan(
  weekStart: string,
  brain: ContentManagerBrain,
): Promise<CmRecordingTask[]> {
  const dayDataList: CalendarDayData[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(`${weekStart}T12:00:00`);
    d.setDate(d.getDate() + i);
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
    dayDataList.push(getCalendarDayData(dateStr));
  }

  const pipelineGaps = dayDataList.map((d) => ({
    date: d.date,
    gap: d.targetGap,
    pipeline: countPipelineVideosForDate(d.date),
  }));

  const strategy = getDailyStrategy(todayDateCst());
  const sprint = getSprintProgress();
  const recommendations = getActiveStrategyRecommendations().slice(0, 3);

  const recordingPlanPrompt = `Plan next week's recording sessions for Marco Puga. Pipeline status for each day: ${JSON.stringify(pipelineGaps)}. Current pillar priority: ${JSON.stringify(strategy?.pillarPriority ?? ["brand", "education", "listings"])}. Sprint math: ${sprint.totalPublished} / ${SPRINT_TARGET} target, ${sprint.daysRemaining} days left, need ${sprint.videosNeededPerDay} per day to stay on track. Current strategy recommendations: ${JSON.stringify(recommendations.map((r) => r.recommendation))}. Generate a recording plan as JSON: { "sessions": [{ "due_date", "pillar", "topic", "hook_type", "priority", "filming_notes", "estimated_clips_from_session" }] }. Plan enough sessions to close the pipeline gap and keep the sprint on track.`;

  let raw = "";
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.QUALITY,
      max_tokens: 2048,
      system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
      messages: [{ role: "user", content: recordingPlanPrompt }],
    });
    raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  } catch (err) {
    logContentAiFailure("weekly recording plan", err);
  }

  const parsed = parseJsonFromText<{
    sessions: Array<{
      due_date: string;
      pillar: string;
      topic: string;
      hook_type: string;
      priority: string;
      filming_notes: string;
      estimated_clips_from_session: number;
    }>;
  }>(raw);

  const created: CmRecordingTask[] = [];
  const sessions = parsed?.sessions ?? [];

  if (sessions.length === 0) {
    for (const day of pipelineGaps.filter((d) => d.gap > 0).slice(0, 3)) {
      const task = insertRecordingTask({
        dueDate: day.date,
        pillar: strategy?.pillarPriority?.[0] ?? "brand",
        hookType: "question",
        topic: `Fill pipeline gap — ${day.gap} more clips needed for ${day.date}`,
        suggestedHooks: [
          "What San Antonio buyers need to know this week",
          "Here's the number nobody's talking about in San Antonio real estate",
          "If you're buying in San Antonio, watch this",
        ],
        suggestedDurationMin: 35,
        suggestedDurationMax: 55,
        filmingNotes: "Film 2-3 short clips. Open with a specific hook in the first 3 seconds.",
        reason: `Pipeline gap of ${day.gap} videos on ${day.date} threatens the 7/day sprint target.`,
        source: "brain",
        priority: day.gap >= 4 ? "urgent" : "normal",
        strategyRecommendationId: recommendations[0]?.id ?? null,
      });
      created.push(task);
    }
    return created;
  }

  for (const session of sessions) {
    const rec = recommendations[0];
    const hooks = [
      session.topic,
      `Alternative: ${session.topic}`,
      "If you're buying in San Antonio, you need to hear this",
    ];
    try {
      if (rec) {
        const task = await generateRecordingTask(
          {
            ...rec,
            recommendation: session.topic,
            pillar: session.pillar,
            hookType: session.hook_type,
            dataBacking: session.filming_notes,
          },
          brain,
        );
        if (session.due_date && session.due_date !== task.dueDate) {
          updateRecordingTask(task.id, { dueDate: session.due_date });
        }
        created.push(task);
      } else {
        const task = insertRecordingTask({
          dueDate: session.due_date,
          pillar: session.pillar,
          hookType: session.hook_type,
          topic: session.topic,
          suggestedHooks: hooks,
          suggestedDurationMin: 35,
          suggestedDurationMax: 55,
          filmingNotes: session.filming_notes,
          reason: "Weekly recording plan session",
          source: "brain",
          priority: session.priority ?? "normal",
          strategyRecommendationId: null,
        });
        insertCalendarEvent({
          eventDate: session.due_date,
          eventType: "recording_needed",
          title: `Film: ${session.topic.slice(0, 60)}`,
          description: session.filming_notes,
          pillar: session.pillar,
          platform: null,
          videoId: null,
          recordingTaskId: task.id,
        });
        created.push(task);
      }
    } catch {
      const task = insertRecordingTask({
        dueDate: session.due_date,
        pillar: session.pillar,
        hookType: session.hook_type,
        topic: session.topic,
        suggestedHooks: hooks,
        suggestedDurationMin: 35,
        suggestedDurationMax: 55,
        filmingNotes: session.filming_notes,
        reason: "Weekly recording plan session",
        source: "brain",
        priority: session.priority ?? "normal",
        strategyRecommendationId: rec?.id ?? null,
      });
      created.push(task);
    }
  }

  return created;
}

const DAILY_PLAN_SOURCE = "daily_plan";

/**
 * Generate a fresh recording plan for a SINGLE day. Unlike the weekly plan,
 * this is meant to be hit repeatedly: each call first clears the previous
 * daily-plan tasks for that date (only its own "daily_plan" source, never
 * filmed/uploaded or brain/manual tasks), then asks Claude for a NEW plan
 * that deliberately avoids the topics it just proposed — so hitting
 * "Generate" again yields a genuinely different plan.
 */
export async function generateDailyRecordingPlan(
  dateStr: string,
  brain: ContentManagerBrain,
): Promise<CmRecordingTask[]> {
  // Capture what the previous daily plan proposed so we can tell Claude to
  // avoid repeating it, then clear those pending tasks.
  const existing = listRecordingTasks({ status: "pending", dueBefore: dateStr, dueAfter: dateStr, limit: 50 });
  const previousTopics = existing
    .filter((t) => t.source === DAILY_PLAN_SOURCE)
    .map((t) => t.topic)
    .filter(Boolean);
  deleteDayPlanRecordingTasks(dateStr, DAILY_PLAN_SOURCE);

  const dayData = getCalendarDayData(dateStr);
  const strategy = getDailyStrategy(todayDateCst());
  const sprint = getSprintProgress();
  const recommendations = getActiveStrategyRecommendations().slice(0, 3);
  const pipeline = countPipelineVideosForDate(dateStr);

  const avoidSection = previousTopics.length
    ? ` The previous plan for this day proposed these topics — deliberately AVOID repeating them and propose genuinely different angles, pillars, or hooks: ${JSON.stringify(previousTopics)}.`
    : "";

  const dailyPlanPrompt = `Plan TODAY's recording session for Marco Puga (date ${dateStr}). This is a single-day filming plan of 2-4 short recording sessions Marco can film today. Current pillar priority: ${JSON.stringify(strategy?.pillarPriority ?? ["brand", "education", "listings"])}. Pipeline already scheduled/published for this day: ${dayData.totalScheduledAndPublished}, gap to the 7/day target: ${dayData.targetGap}, clips already in pipeline: ${pipeline}. Sprint math: ${sprint.totalPublished} / ${SPRINT_TARGET} target, ${sprint.daysRemaining} days left, need ${sprint.videosNeededPerDay} per day. Current strategy recommendations: ${JSON.stringify(recommendations.map((r) => r.recommendation))}.${avoidSection} Generate a fresh plan as JSON: { "sessions": [{ "pillar", "topic", "hook_type", "priority", "filming_notes", "estimated_clips_from_session" }] }. Vary the pillars and hook types across sessions. Make each topic specific to San Antonio real estate and concrete enough to film today.`;

  let raw = "";
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.QUALITY,
      max_tokens: 1536,
      temperature: 1,
      system:
        "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object. Be creative and vary your suggestions run-to-run.",
      messages: [{ role: "user", content: dailyPlanPrompt }],
    });
    raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  } catch (err) {
    logContentAiFailure("daily recording plan", err);
  }

  const parsed = parseJsonFromText<{
    sessions: Array<{
      pillar: string;
      topic: string;
      hook_type: string;
      priority: string;
      filming_notes: string;
      estimated_clips_from_session: number;
    }>;
  }>(raw);

  const sessions = parsed?.sessions ?? [];
  const created: CmRecordingTask[] = [];

  if (sessions.length === 0) {
    // Fallback: never leave the user with an empty plan.
    const task = insertRecordingTask({
      dueDate: dateStr,
      pillar: strategy?.pillarPriority?.[0] ?? "brand",
      hookType: "question",
      topic: "Film 2-3 short clips answering a San Antonio buyer question today",
      suggestedHooks: [
        "Here's what San Antonio buyers are asking me this week",
        "The number nobody's talking about in San Antonio real estate",
        "If you're buying in San Antonio, watch this before you do anything",
      ],
      suggestedDurationMin: 35,
      suggestedDurationMax: 55,
      filmingNotes: "Open with a specific hook in the first 3 seconds. Mention a real neighborhood or price.",
      reason: "Daily recording plan",
      source: DAILY_PLAN_SOURCE,
      priority: dayData.targetGap >= 4 ? "urgent" : "normal",
      strategyRecommendationId: recommendations[0]?.id ?? null,
    });
    created.push(task);
    return created;
  }

  for (const session of sessions) {
    const hooks = [
      session.topic,
      `Alternative angle: ${session.topic}`,
      "If you're buying in San Antonio, you need to hear this",
    ];
    const task = insertRecordingTask({
      dueDate: dateStr,
      pillar: session.pillar,
      hookType: session.hook_type,
      topic: session.topic,
      suggestedHooks: hooks,
      suggestedDurationMin: 35,
      suggestedDurationMax: 55,
      filmingNotes: session.filming_notes,
      reason: "Daily recording plan",
      source: DAILY_PLAN_SOURCE,
      priority: session.priority ?? "normal",
      strategyRecommendationId: recommendations[0]?.id ?? null,
    });
    created.push(task);
  }

  void brain;
  return created;
}

export function markRecordingTaskFiled(taskId: string, uploadBatchSessionId?: string): void {
  const now = new Date().toISOString();
  const status = uploadBatchSessionId ? "uploaded" : "filmed";
  updateRecordingTask(taskId, {
    status,
    filmedAt: now,
    uploadTriggeredAt: uploadBatchSessionId ? now : undefined,
  });
  updateCalendarEventByRecordingTaskId(taskId, { status: "complete" });
  if (uploadBatchSessionId) {
    console.log(`[calendar] Recording task ${taskId} linked to batch ${uploadBatchSessionId}`);
  }
}
