import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export const CONTENT_BENCHMARK_VIEWS = 6006;
export const CONTENT_BENCHMARK_COMMENTS = 33;
export const CONTENT_BENCHMARK_SHARES = 68;

export type ContentPillar = "education" | "listings" | "brand";
export type ContentVideoStatus =
  | "processing"
  | "pending_review"
  | "approved"
  | "scheduled"
  | "submitted" // sent to Upload-Post, awaiting genuine per-platform confirmation
  | "published"
  | "rejected";
export type ContentSessionStatus = "processing" | "complete" | "failed";
export type ContentPlatformTarget = "tiktok" | "instagram" | "facebook" | "youtube";
export type PerformanceTier = "hot" | "average" | "cold";

export interface ContentSession {
  id: string;
  rawInputType: string;
  rawInputPath: string | null;
  rawInputMeta: Record<string, unknown>;
  clipsGenerated: number;
  status: ContentSessionStatus;
  createdAt: string;
  completedAt: string | null;
  batchSessionId?: string | null;
  opusJobId?: string | null;
  filmedBy?: string;
}

export interface ContentVideo {
  id: string;
  sourceSessionId: string | null;
  platformTarget: ContentPlatformTarget;
  title: string;
  caption: string;
  hook: string;
  hashtags: string[];
  pillar: ContentPillar;
  filePath: string | null;
  status: ContentVideoStatus;
  complianceFlagged: boolean;
  complianceNotes: string | null;
  createdAt: string;
  approvedAt: string | null;
  scheduledFor: string | null;
  publishedAt: string | null;
  batchSessionId?: string | null;
  sourceFileId?: string | null;
  trendAlignmentScore?: number;
  opusClipScore?: number;
  hookType?: string | null;
  platformTargets?: string[];
  optimalPostTime?: string | null;
}

export interface ContentPublishLog {
  id: string;
  videoId: string;
  platform: string;
  platformPostId: string | null;
  publishedAt: string;
  publishStatus: "success" | "failed" | "scheduled";
  errorMessage: string | null;
}

export interface ContentPerformance {
  id: string;
  videoId: string;
  platformPostId: string | null;
  platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  dmsGenerated: number;
  phoneNumbersCaptured: number;
  score: number;
  tier: PerformanceTier;
  benchmarkMet: boolean;
  pulledAt: string;
}

export interface ContentComplianceQueueItem {
  id: string;
  videoId: string;
  flaggedReason: string;
  flaggedAt: string;
  reviewedBy: string | null;
  reviewDecision: "approved" | "rejected" | null;
  reviewedAt: string | null;
}

export interface ContentDailyTargets {
  date: string;
  videosTarget: number;
  videosPublished: number;
  phoneNumbersTarget: number;
  phoneNumbersCaptured: number;
  commentsManaged: number;
  dmsTriaged: number;
  updatedAt: string;
}

export interface ContentLeadCapture {
  id: string;
  platform: string;
  platformUserId: string;
  phoneNumber: string;
  capturedFrom: "dm" | "comment";
  rawMessage: string;
  routedToCrm: boolean;
  routedAt: string | null;
  capturedAt: string;
}

function resolveContentDbPath(): string {
  const base = fs.existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "content.db");
}

let db: Database.Database | null = null;

export function getContentDb(): Database.Database {
  if (!db) {
    db = new Database(resolveContentDbPath());
    db.pragma("journal_mode = WAL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS content_sessions (
        id TEXT PRIMARY KEY,
        raw_input_type TEXT NOT NULL,
        raw_input_path TEXT,
        raw_input_meta TEXT,
        clips_generated INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS content_videos (
        id TEXT PRIMARY KEY,
        source_session_id TEXT,
        platform_target TEXT NOT NULL,
        title TEXT NOT NULL,
        caption TEXT NOT NULL,
        hook TEXT NOT NULL,
        hashtags TEXT NOT NULL,
        pillar TEXT NOT NULL,
        file_path TEXT,
        status TEXT NOT NULL,
        compliance_flagged INTEGER NOT NULL DEFAULT 0,
        compliance_notes TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        scheduled_for TEXT,
        published_at TEXT
      );

      CREATE TABLE IF NOT EXISTS content_publish_log (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        platform_post_id TEXT,
        published_at TEXT NOT NULL,
        publish_status TEXT NOT NULL,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS content_performance (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        platform_post_id TEXT,
        platform TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        shares INTEGER NOT NULL DEFAULT 0,
        saves INTEGER NOT NULL DEFAULT 0,
        dms_generated INTEGER NOT NULL DEFAULT 0,
        phone_numbers_captured INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        tier TEXT NOT NULL,
        benchmark_met INTEGER NOT NULL DEFAULT 0,
        pulled_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS content_compliance_queue (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        flagged_reason TEXT NOT NULL,
        flagged_at TEXT NOT NULL,
        reviewed_by TEXT,
        review_decision TEXT,
        reviewed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS content_daily_targets (
        date TEXT PRIMARY KEY,
        videos_target INTEGER NOT NULL DEFAULT 7,
        videos_published INTEGER NOT NULL DEFAULT 0,
        phone_numbers_target INTEGER NOT NULL DEFAULT 22,
        phone_numbers_captured INTEGER NOT NULL DEFAULT 0,
        comments_managed INTEGER NOT NULL DEFAULT 0,
        dms_triaged INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS content_lead_captures (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        captured_from TEXT NOT NULL,
        raw_message TEXT NOT NULL,
        routed_to_crm INTEGER NOT NULL DEFAULT 0,
        routed_at TEXT,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_performance_model (
        id TEXT PRIMARY KEY,
        pillar_education_avg_views REAL,
        pillar_listings_avg_views REAL,
        pillar_brand_avg_views REAL,
        overall_avg_views REAL,
        overall_avg_engagement_rate REAL,
        benchmark_gap_pct REAL,
        trending_direction TEXT,
        best_posting_day TEXT,
        best_posting_hour TEXT,
        top_performing_pillar TEXT,
        top_performing_hashtags TEXT,
        working_hook_patterns TEXT,
        failing_hook_patterns TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS cm_learning_log (
        id TEXT PRIMARY KEY,
        cycle_type TEXT NOT NULL,
        date TEXT NOT NULL,
        insights TEXT NOT NULL,
        strategy_adjustments TEXT NOT NULL,
        performance_snapshot TEXT NOT NULL,
        videos_above_benchmark INTEGER NOT NULL DEFAULT 0,
        videos_below_benchmark INTEGER NOT NULL DEFAULT 0,
        phone_numbers_today INTEGER NOT NULL DEFAULT 0,
        logged_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_daily_strategy (
        date TEXT PRIMARY KEY,
        pillar_priority TEXT NOT NULL,
        recommended_hooks TEXT NOT NULL,
        hashtag_set TEXT NOT NULL,
        avoid_angles TEXT NOT NULL,
        platform_distribution TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        confidence_score INTEGER NOT NULL DEFAULT 0,
        generated_at TEXT NOT NULL,
        last_updated TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_briefings (
        id TEXT PRIMARY KEY,
        briefing_type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        key_metrics TEXT NOT NULL,
        action_items TEXT NOT NULL,
        sent_to_harvey INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_cut_list (
        id TEXT PRIMARY KEY,
        content_angle TEXT NOT NULL,
        reason TEXT NOT NULL,
        avg_views_when_cut REAL,
        benchmark_at_cut REAL,
        times_tested INTEGER NOT NULL DEFAULT 0,
        flagged_by TEXT NOT NULL,
        flagged_at TEXT NOT NULL,
        reinstated INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cm_hook_library (
        id TEXT PRIMARY KEY,
        hook_text TEXT NOT NULL,
        content_pillar TEXT NOT NULL,
        avg_views_when_used REAL NOT NULL DEFAULT 0,
        times_used INTEGER NOT NULL DEFAULT 0,
        times_above_benchmark INTEGER NOT NULL DEFAULT 0,
        performance_score REAL NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_used TEXT
      );

      CREATE TABLE IF NOT EXISTS cm_hashtag_performance (
        hashtag TEXT PRIMARY KEY,
        avg_views REAL NOT NULL DEFAULT 0,
        times_used INTEGER NOT NULL DEFAULT 0,
        times_above_benchmark INTEGER NOT NULL DEFAULT 0,
        performance_score REAL NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS cm_posting_time_matrix (
        day_of_week TEXT NOT NULL,
        hour_of_day INTEGER NOT NULL,
        avg_views REAL NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day_of_week, hour_of_day)
      );

      CREATE TABLE IF NOT EXISTS cm_strategy_accuracy (
        id TEXT PRIMARY KEY,
        strategy_date TEXT NOT NULL,
        recommended_top_pillar TEXT,
        actual_top_pillar TEXT,
        recommended_hooks TEXT NOT NULL,
        hooks_that_beat_benchmark TEXT NOT NULL,
        confidence_score_given INTEGER NOT NULL DEFAULT 0,
        outcome_score INTEGER NOT NULL DEFAULT 0,
        pillar_prediction_correct INTEGER NOT NULL DEFAULT 0,
        hooks_hit_rate REAL NOT NULL DEFAULT 0,
        overall_grade TEXT,
        evaluated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_combination_patterns (
        id TEXT PRIMARY KEY,
        pillar TEXT NOT NULL,
        hook_type TEXT NOT NULL,
        posting_day TEXT NOT NULL,
        posting_hour_bucket TEXT NOT NULL,
        caption_length_bucket TEXT NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        avg_views REAL NOT NULL DEFAULT 0,
        avg_engagement_rate REAL NOT NULL DEFAULT 0,
        above_benchmark_count INTEGER NOT NULL DEFAULT 0,
        performance_score REAL NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_experiments (
        id TEXT PRIMARY KEY,
        week_start TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        variable_tested TEXT NOT NULL,
        control_description TEXT NOT NULL,
        test_description TEXT NOT NULL,
        control_video_ids TEXT NOT NULL DEFAULT '[]',
        test_video_ids TEXT NOT NULL DEFAULT '[]',
        control_avg_views REAL NOT NULL DEFAULT 0,
        test_avg_views REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'proposed',
        result TEXT,
        conclusion TEXT,
        proposed_by TEXT NOT NULL DEFAULT 'brain',
        evaluated_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_chat_sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        session_summary TEXT,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        performance_context TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_self_evaluation (
        id TEXT PRIMARY KEY,
        week_start TEXT NOT NULL,
        strategies_followed INTEGER NOT NULL DEFAULT 0,
        strategies_ignored INTEGER NOT NULL DEFAULT 0,
        avg_outcome_score REAL NOT NULL DEFAULT 0,
        what_worked TEXT NOT NULL,
        what_failed TEXT NOT NULL,
        one_change TEXT NOT NULL,
        calibration_score REAL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cm_seasonal_model (
        week_number INTEGER PRIMARY KEY,
        historical_avg_views REAL NOT NULL DEFAULT 0,
        historical_avg_dms REAL NOT NULL DEFAULT 0,
        sample_years INTEGER NOT NULL DEFAULT 0,
        performance_multiplier REAL NOT NULL DEFAULT 1.0,
        season_label TEXT,
        notes TEXT,
        last_updated TEXT
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS cm_batch_sessions (
        id TEXT PRIMARY KEY,
        session_name TEXT,
        pillar TEXT,
        filmed_by TEXT,
        target_clip_count INTEGER,
        status TEXT,
        source_file_count INTEGER,
        clips_generated INTEGER DEFAULT 0,
        trend_brief_id TEXT,
        created_at TEXT,
        completed_at TEXT,
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_batch_source_files (
        id TEXT PRIMARY KEY,
        batch_session_id TEXT,
        original_filename TEXT,
        file_size_bytes INTEGER,
        file_path TEXT,
        duration_seconds REAL,
        opus_job_id TEXT,
        opus_status TEXT,
        clips_generated_count INTEGER DEFAULT 0,
        uploaded_at TEXT,
        opus_submitted_at TEXT,
        opus_completed_at TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_clip_versions (
        id TEXT PRIMARY KEY,
        video_id TEXT,
        file_path TEXT,
        note TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_clip_versions_video ON cm_clip_versions(video_id);
      CREATE TABLE IF NOT EXISTS cm_clip_chat (
        id TEXT PRIMARY KEY,
        clip_id TEXT,
        role TEXT,
        content TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_clip_chat_clip ON cm_clip_chat(clip_id);
      CREATE TABLE IF NOT EXISTS cm_drive_processed (
        file_id TEXT PRIMARY KEY,
        name TEXT,
        session_id TEXT,
        processed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_drive_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_poll_at TEXT,
        last_pull_date TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_drive_failed (
        file_id TEXT PRIMARY KEY,
        name TEXT,
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        quarantined INTEGER DEFAULT 0,
        first_failed_at TEXT,
        last_failed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_competitor_profiles (
        id TEXT PRIMARY KEY,
        tiktok_handle TEXT UNIQUE,
        display_name TEXT,
        profile_type TEXT,
        active INTEGER DEFAULT 1,
        last_scraped_at TEXT,
        added_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_competitor_trends (
        id TEXT PRIMARY KEY,
        scraped_at TEXT,
        profiles_scraped TEXT,
        raw_video_count INTEGER,
        top_hooks TEXT,
        trending_hashtags TEXT,
        top_performing_durations TEXT,
        best_duration_range TEXT,
        top_content_themes TEXT,
        trend_brief TEXT,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_clip_enhancements (
        id TEXT PRIMARY KEY,
        video_id TEXT,
        hook_primary TEXT,
        hook_variations TEXT,
        hook_type TEXT,
        caption_generated TEXT,
        caption_final TEXT,
        hashtags_generated TEXT,
        hashtags_final TEXT,
        title_generated TEXT,
        title_final TEXT,
        platform_targets TEXT,
        trend_alignment_score INTEGER,
        trend_alignment_reason TEXT,
        optimal_post_time_tiktok TEXT,
        optimal_post_time_instagram TEXT,
        opus_clip_score REAL,
        source_file_id TEXT,
        created_at TEXT,
        last_edited_at TEXT,
        edited_by TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_competitive_analysis (
        id TEXT PRIMARY KEY,
        analyzed_at TEXT,
        week_start TEXT,
        profiles_analyzed TEXT,
        marco_avg_views REAL,
        marco_avg_engagement_rate REAL,
        competitor_avg_views REAL,
        competitor_avg_engagement_rate REAL,
        marco_vs_field_pct REAL,
        top_competitor_handle TEXT,
        top_competitor_avg_views REAL,
        marco_strengths TEXT,
        marco_gaps TEXT,
        top_competitor_themes TEXT,
        full_analysis_markdown TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_strategy_recommendations (
        id TEXT PRIMARY KEY,
        analysis_id TEXT,
        priority INTEGER,
        recommendation TEXT,
        data_backing TEXT,
        pillar TEXT,
        hook_type TEXT,
        example_from_competitor TEXT,
        expected_impact TEXT,
        status TEXT DEFAULT 'pending',
        dismissed_reason TEXT,
        created_at TEXT,
        acted_on_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_recording_tasks (
        id TEXT PRIMARY KEY,
        due_date TEXT,
        pillar TEXT,
        hook_type TEXT,
        topic TEXT,
        suggested_hooks TEXT,
        suggested_duration_min INTEGER,
        suggested_duration_max INTEGER,
        filming_notes TEXT,
        reason TEXT,
        source TEXT DEFAULT 'brain',
        priority TEXT DEFAULT 'normal',
        status TEXT DEFAULT 'pending',
        strategy_recommendation_id TEXT,
        created_at TEXT,
        filmed_at TEXT,
        upload_triggered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_calendar_events (
        id TEXT PRIMARY KEY,
        event_date TEXT,
        event_type TEXT,
        title TEXT,
        description TEXT,
        pillar TEXT,
        platform TEXT,
        video_id TEXT,
        recording_task_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_knowledge_base (
        id TEXT PRIMARY KEY,
        category TEXT,
        title TEXT,
        content TEXT,
        source TEXT DEFAULT 'system',
        confidence REAL DEFAULT 1.0,
        created_at TEXT,
        last_referenced_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_competitor_youtube_profiles (
        id TEXT PRIMARY KEY,
        competitor_profile_id TEXT,
        youtube_channel_url TEXT NOT NULL,
        youtube_handle TEXT,
        channel_name TEXT,
        profile_type TEXT DEFAULT 'competitor',
        active INTEGER DEFAULT 1,
        last_scraped_at TEXT,
        videos_scraped_count INTEGER DEFAULT 0,
        added_at TEXT,
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_youtube_video_cache (
        id TEXT PRIMARY KEY,
        youtube_profile_id TEXT,
        video_id TEXT UNIQUE NOT NULL,
        title TEXT,
        channel_name TEXT,
        channel_url TEXT,
        upload_date TEXT,
        view_count INTEGER DEFAULT 0,
        duration_seconds INTEGER DEFAULT 0,
        url TEXT,
        fetched_at TEXT,
        transcript_fetched INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cm_youtube_transcripts (
        id TEXT PRIMARY KEY,
        video_id TEXT UNIQUE NOT NULL,
        video_title TEXT,
        channel_name TEXT,
        view_count INTEGER DEFAULT 0,
        full_text TEXT,
        hook_text TEXT,
        body_text TEXT,
        cta_text TEXT,
        word_count INTEGER DEFAULT 0,
        language TEXT DEFAULT 'en',
        fetch_status TEXT DEFAULT 'success',
        error_message TEXT,
        fetched_at TEXT,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_youtube_analysis (
        id TEXT PRIMARY KEY,
        analyzed_at TEXT,
        videos_analyzed INTEGER DEFAULT 0,
        channels_analyzed INTEGER DEFAULT 0,
        top_hook_structures TEXT,
        top_opening_phrases TEXT,
        top_topics TEXT,
        top_data_points TEXT,
        top_cta_patterns TEXT,
        content_gaps TEXT,
        full_analysis_markdown TEXT,
        trend_signals TEXT,
        week_start TEXT
      );
      CREATE TABLE IF NOT EXISTS cm_agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        ran_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cm_reddit_intel (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fetched_at TEXT NOT NULL,
        post_count INTEGER NOT NULL DEFAULT 0,
        posts_json TEXT
      );
    `);

    ensureBrainIntelligenceMigrations(db);
    ensureBatchPipelineMigrations(db);
    ensureStrategyEngineMigrations(db);
    initSeasonalModelIfEmpty(db);
    initCompetitorProfilesIfEmpty(db);
    ensureYoutubeIntelMigrations(db);
    initYoutubeProfilesIfEmpty(db);
    migrateYoutubeProfilesJosieToBiggerPockets(db);
    initKnowledgeBaseIfEmpty(db);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_cv_status ON content_videos(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cv_session ON content_videos(source_session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cpl_video ON content_publish_log(video_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cp_video ON content_performance(video_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ccq_pending ON content_compliance_queue(review_decision)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_clc_captured ON content_lead_captures(captured_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cm_combo_pillar_hook ON cm_combination_patterns(pillar, hook_type)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cm_chat_msg_session ON cm_chat_messages(session_id)`);
  }
  return db;
}

function ensureBrainIntelligenceMigrations(database: Database.Database): void {
  const addCol = (table: string, column: string, ddl: string) => {
    const info = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!info.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  addCol("cm_hook_library", "hook_type", `TEXT DEFAULT 'uncategorized'`);
  addCol("cm_hook_library", "hook_structure", "TEXT");
  addCol("cm_hook_library", "classified_at", "TEXT");
  addCol("cm_performance_model", "hot_streak_count", "INTEGER DEFAULT 0");
  addCol("cm_performance_model", "cold_streak_count", "INTEGER DEFAULT 0");
  addCol("cm_performance_model", "current_streak_type", `TEXT DEFAULT 'neutral'`);
  addCol("cm_performance_model", "streak_started_at", "TEXT");
  addCol("cm_performance_model", "calibration_score", "REAL");
  addCol("cm_performance_model", "self_grade_last_week", "TEXT");
  addCol("cm_performance_model", "season_multiplier", "REAL DEFAULT 1.0");
  addCol("cm_performance_model", "decay_weighted_avg_views", "REAL DEFAULT 0");
  addCol("cm_self_evaluation", "benchmark_assessment", "TEXT");
}

function ensureBatchPipelineMigrations(database: Database.Database): void {
  const addCol = (table: string, column: string, ddl: string) => {
    const info = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!info.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  addCol("content_videos", "batch_session_id", "TEXT");
  addCol("content_videos", "source_file_id", "TEXT");
  addCol("content_videos", "trend_alignment_score", "INTEGER DEFAULT 0");
  addCol("content_videos", "opus_clip_score", "REAL DEFAULT 0");
  addCol("content_videos", "hook_type", "TEXT");
  addCol("content_videos", "platform_targets", "TEXT");
  addCol("content_videos", "optimal_post_time", "TEXT");
  addCol("content_sessions", "batch_session_id", "TEXT");
  addCol("content_sessions", "opus_job_id", "TEXT");
  addCol("content_sessions", "filmed_by", `TEXT DEFAULT 'marco'`);
  // Script/context upload + AI Edit (natural-language clip edits):
  // - user_context / script_text ride the batch session into the clipping prompt
  //   so the AI cuts with human direction instead of guessing.
  // - edit_history records applied AI edits per clip (JSON array).
  // - edit_instructions is reserved for pending/queued instructions.
  addCol("cm_batch_sessions", "user_context", "TEXT");
  addCol("cm_batch_sessions", "script_text", "TEXT");
  // Per-batch video-enhancement toggles (captions / autoZoom / broll) as JSON.
  addCol("cm_batch_sessions", "enhance_options", "TEXT");
  addCol("content_videos", "edit_instructions", "TEXT");
  addCol("content_videos", "edit_history", "TEXT");
}

function initCompetitorProfilesIfEmpty(database: Database.Database): void {
  const count = database.prepare(`SELECT COUNT(*) AS c FROM cm_competitor_profiles`).get() as { c: number };
  if (Number(count.c) > 0) return;
  const now = new Date().toISOString();
  const defaults = [
    { handle: "ryan.serhant", name: "Ryan Serhant", type: "national_influencer" },
    { handle: "grahamstephan", name: "Graham Stephan", type: "national_influencer" },
    { handle: "realestategreg", name: "Real Estate Greg", type: "education_account" },
    { handle: "lisasalcido", name: "Lisa Salcido", type: "texas_state" },
    { handle: "realestaterob", name: "Real Estate Rob", type: "education_account" },
  ];
  const stmt = database.prepare(
    `INSERT INTO cm_competitor_profiles (id, tiktok_handle, display_name, profile_type, active, added_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  );
  for (const p of defaults) {
    stmt.run(randomUUID(), p.handle, p.name, p.type, now);
  }
}

function ensureStrategyEngineMigrations(database: Database.Database): void {
  /* tables created via CREATE TABLE IF NOT EXISTS above */
}

function ensureYoutubeIntelMigrations(database: Database.Database): void {
  const info = database
    .prepare(`PRAGMA table_info(cm_competitor_profiles)`)
    .all() as Array<{ name: string }>;
  if (!info.some((c) => c.name === "youtube_channel_url")) {
    database.exec(`ALTER TABLE cm_competitor_profiles ADD COLUMN youtube_channel_url TEXT`);
  }
}

function initYoutubeProfilesIfEmpty(database: Database.Database): void {
  const count = database
    .prepare(`SELECT COUNT(*) AS c FROM cm_competitor_youtube_profiles`)
    .get() as { c: number };
  if (Number(count.c) > 0) return;
  const now = new Date().toISOString();
  const defaults = [
    { handle: "@RyanSerhant", name: "Ryan Serhant", type: "national_influencer", url: "https://www.youtube.com/@RyanSerhant" },
    { handle: "@GrahamStephan", name: "Graham Stephan", type: "national_influencer", url: "https://www.youtube.com/@GrahamStephan" },
    { handle: "@RealEstateRookie", name: "Real Estate Rookie", type: "education_account", url: "https://www.youtube.com/@RealEstateRookie" },
    { handle: "@MeetKevin", name: "Meet Kevin", type: "national_influencer", url: "https://www.youtube.com/@MeetKevin" },
    { handle: "@BiggerPockets", name: "BiggerPockets", type: "education_account", url: "https://www.youtube.com/@BiggerPockets" },
  ];
  const stmt = database.prepare(
    `INSERT INTO cm_competitor_youtube_profiles
     (id, youtube_channel_url, youtube_handle, channel_name, profile_type, active, added_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  );
  for (const ch of defaults) {
    stmt.run(randomUUID(), ch.url, ch.handle, ch.name, ch.type, now);
  }
}

/**
 * One-time, idempotent fix for already-seeded databases: the "Real Estate With
 * Josie" channel (@JosieFayora) is dead — yt-dlp returns 400 on it — so
 * deactivate it and ensure @BiggerPockets (an active real-estate channel) is
 * present and active in its place. Safe to run on every startup.
 */
function migrateYoutubeProfilesJosieToBiggerPockets(database: Database.Database): void {
  const josieActive = database
    .prepare(
      `SELECT COUNT(*) AS c FROM cm_competitor_youtube_profiles
       WHERE active = 1 AND (youtube_handle = '@JosieFayora' OR channel_name = 'Real Estate With Josie')`,
    )
    .get() as { c: number };
  if (Number(josieActive.c) > 0) {
    database
      .prepare(
        `UPDATE cm_competitor_youtube_profiles SET active = 0
         WHERE youtube_handle = '@JosieFayora' OR channel_name = 'Real Estate With Josie'`,
      )
      .run();
    console.log("[youtube-intel] Deactivated dead channel @JosieFayora (400 on fetch)");
  }

  const bpExists = database
    .prepare(
      `SELECT COUNT(*) AS c FROM cm_competitor_youtube_profiles WHERE youtube_handle = '@BiggerPockets'`,
    )
    .get() as { c: number };
  if (Number(bpExists.c) === 0) {
    database
      .prepare(
        `INSERT INTO cm_competitor_youtube_profiles
         (id, youtube_channel_url, youtube_handle, channel_name, profile_type, active, added_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        randomUUID(),
        "https://www.youtube.com/@BiggerPockets",
        "@BiggerPockets",
        "BiggerPockets",
        "education_account",
        new Date().toISOString(),
      );
    console.log("[youtube-intel] Added replacement channel @BiggerPockets");
  } else {
    // If it exists but was deactivated, re-activate it.
    database
      .prepare(`UPDATE cm_competitor_youtube_profiles SET active = 1 WHERE youtube_handle = '@BiggerPockets'`)
      .run();
  }
}

function initKnowledgeBaseIfEmpty(database: Database.Database): void {
  const count = database.prepare(`SELECT COUNT(*) AS c FROM cm_knowledge_base`).get() as { c: number };
  if (Number(count.c) > 0) return;
  const now = new Date().toISOString();
  const entries: Array<{ category: string; title: string; content: string }> = [
    {
      category: "algorithm_mechanics",
      title: "The 1-3 Second Rule",
      content:
        "The first 1-3 seconds of any TikTok determine whether viewers stay or scroll. If the hook does not create immediate curiosity, a specific promise, or a surprising statement in those seconds, watch time collapses and the algorithm buries the video. Every clip must open with something that makes a viewer think 'I need to hear the rest of this.' This is why hook type matters more than production quality.",
    },
    {
      category: "algorithm_mechanics",
      title: "Watch Time Is the Primary Signal",
      content:
        "TikTok's algorithm prioritizes videos where viewers watch to completion or near-completion. A 45-second video watched 100% beats a 60-second video watched 70%. The goal is not the longest video but the most watched-through video. This is why 35-55 second clips consistently outperform longer content in real estate — they match the attention span of the intended audience.",
    },
    {
      category: "algorithm_mechanics",
      title: "Saves Signal Future Value",
      content:
        "When a viewer saves a video, they are telling TikTok this content is worth returning to. Saves drive algorithmic distribution more than likes. Educational content that teaches buyers something they want to remember — pre-approval steps, what $400K buys in San Antonio, rate explanation — generates saves at a disproportionately high rate. Every Education pillar video should be created with the question: what would make someone save this?",
    },
    {
      category: "algorithm_mechanics",
      title: "Shares Signal Social Proof",
      content:
        "Shares happen when a viewer thinks 'someone I know needs to see this.' In real estate, shares spike on price revelation content ('I just sold this for $___'), controversial takes ('Stop waiting for rates to drop'), and hyperlocal content that matches someone's specific situation. Shares are the hardest metric to earn and the most valuable for reach.",
    },
    {
      category: "algorithm_mechanics",
      title: "Comments Drive Distribution Loops",
      content:
        "Comments tell TikTok a video created conversation. Question-based hooks drive the most comments because they create an obvious reply point. 'What would you do with 5 acres in Texas?' generates more comments than 'Here is a 5-acre property.' Every Brand and Education video should end with a question or a statement that makes viewers feel compelled to respond.",
    },
    {
      category: "hook_science",
      title: "The Six Hook Structures That Work in Real Estate",
      content:
        "Question hooks ('Did you know you could buy a San Antonio home for under $350K?') drive comments. Shock hooks ('I just sold this house for $200K over asking') drive shares. Personal story hooks ('Last week my client walked away from a deal and I told them not to') drive trust. Data hooks ('Interest rates just hit X — here's what that means for your payment') drive saves. Controversy hooks ('Stop waiting for rates to drop — here's why') drive comments and shares. Local hooks ('Stone Oak buyers are doing something most agents won't tell you about') drive DMs. Know which outcome you want before you write the hook.",
    },
    {
      category: "hook_science",
      title: "Specificity Multiplies Hook Performance",
      content:
        "Generic hooks fail. Specific hooks win. 'I have a home you should see' → nobody cares. 'I have a 4-bedroom in Stone Oak for $445K that closes in 30 days' → buyers in that market stop scrolling. Replace every vague claim with a specific number, neighborhood name, price point, or timeline. Marco's San Antonio specificity is a competitive advantage — use it in every hook possible.",
    },
    {
      category: "conversion_psychology",
      title: "People Follow Agents They Trust, Not Listings",
      content:
        "No one on TikTok is looking for their next home. They are looking for someone who can help them understand a confusing and expensive decision. The real estate content that converts is not listing tours — it is Marco explaining what he knows in plain language. Trust is built through consistency, transparency about numbers, and moments where Marco shows he is on the buyer's side. Brand content converts 3x more than listing content because it builds the person, not the property.",
    },
    {
      category: "conversion_psychology",
      title: "The DM Is the Conversion Point",
      content:
        "A viewer becoming a DM sender is the moment the $14M goal moves forward. Everything before the DM is marketing. The DM is the beginning of a sales relationship. Content should be designed to generate curiosity that can only be satisfied in a DM — 'DM me for the full breakdown,' 'I can only share this privately,' 'Text me the neighborhood and I'll send you the data.' The 44 DMs per day target is not a vanity metric. It is a revenue target.",
    },
    {
      category: "conversion_psychology",
      title: "The 246K Views Per Closing Math",
      content:
        "Marco's data shows 246,000 views produces 1 closing. At 5,957 average views per video, that is 41 videos per closing. At 7 videos per day, Marco generates the views for 1 closing every 6 days. The 21-closing buyer target requires 861 videos. This math means every underperforming video that gets cut and replaced is a direct contribution to the closing count. The Brain's job is to maximize the percentage of videos that beat the 6,006 view benchmark, not just hit the volume target.",
    },
    {
      category: "platform_strategy",
      title: "TikTok First, Then Distribute",
      content:
        "TikTok is the primary platform because it has the strongest organic reach algorithm for new creators and the largest Millennial and Gen Z buyer audience. Instagram Reels captures the same content but for a warmer audience that is already following real estate accounts. Facebook reaches the 40-55 year old move-up buyer and seller demographic that TikTok does not reach. YouTube Shorts captures search intent — people actively searching 'buying a home in San Antonio' or 'first time buyer Texas.' Content should be created for TikTok first, then formatted for each downstream platform.",
    },
    {
      category: "platform_strategy",
      title: "Platform-Specific Content Matching",
      content:
        "Not all content belongs on all platforms. Brand content (Marco on camera, wins, personal moments) performs best on TikTok and Instagram where personality drives follows. Education content performs best on YouTube Shorts and TikTok where information drives saves and search. Listing content performs best on Facebook where buyers in the purchase mindset actively browse. Matching content type to platform increases performance across all channels without requiring any additional filming.",
    },
    {
      category: "real_estate_niche",
      title: "First-Time Buyers Are the Highest Volume TikTok Audience",
      content:
        "The majority of real estate TikTok's organic audience is Millennials and Gen Z who are confused, anxious, and curious about homeownership. They do not know what pre-approval means. They do not know what a good interest rate looks like. They do not understand what $400K actually buys. Content that answers these foundational questions in plain language — without condescension — generates the highest saves, shares, and DMs of any content type in real estate.",
    },
    {
      category: "real_estate_niche",
      title: "San Antonio Specificity Is a Moat",
      content:
        "Marco's hyperlocal knowledge of San Antonio — Stone Oak, Canyon Lake, New Braunfels, Alamo Heights, specific price bands by neighborhood — is something no national real estate influencer can replicate. Every time Marco says a specific neighborhood name with a specific price, he is speaking directly to the buyers in that market who are already looking. Hyperlocal content converts at a higher rate than generic real estate content because it feels like it was made for the viewer specifically.",
    },
    {
      category: "real_estate_niche",
      title: "Interest Rates Are the Permanent Hook",
      content:
        "Since 2022 every buyer in America has been obsessed with interest rates. Rate content — what they are today, what they mean for a monthly payment, whether to buy now or wait, how to buy down the rate — generates consistent engagement regardless of season. Any week where competitors are posting rate content that outperforms, Marco should be posting rate content. This is the one topic where Education pillar and Data hooks combine for maximum performance.",
    },
    {
      category: "community_management",
      title: "Responding to Comments Is an Algorithm Lever",
      content:
        "When Marco or the system responds to comments within the first hour of posting, TikTok reads the video as creating conversation and pushes it to more users. Every comment response is a mini-content piece. Asking a follow-up question in a comment response increases the comment count further. The 220 comments per day target is not just a service goal — it is an algorithm activation strategy.",
    },
    {
      category: "community_management",
      title: "Phone Number Capture Is the Only Metric That Generates Revenue",
      content:
        "Views build brand. Comments build distribution. DMs build relationships. Phone numbers generate closings. The 22 phone numbers per day target is the only community management metric that directly traces to the $14M buyer goal. Every DM conversation should be designed to create a moment where providing a phone number feels natural and valuable — 'send me your number and I'll text you the full breakdown.'",
    },
    {
      category: "sprint_math",
      title: "The 861-Video Sprint Context",
      content:
        "The sprint runs from now to November 30, 2026. 861 videos total at 7 per day. TikTok closings lag 2-4 months. Videos posted in July-August produce closings in October-November at the finish line. This means the most important time to post consistently is NOW — not when closings start appearing. The Brain should treat every day's video target as a non-negotiable sprint commitment, not a suggestion.",
    },
    {
      category: "content_pillars",
      title: "The Three Pillars in Conversion Order",
      content:
        "Brand converts first and most powerfully because people buy from people they trust. Marco on camera — sharing a win, walking a listing, reacting to a market moment — builds the personal trust that drives DMs. Education converts second by establishing expertise and generating saves that bring viewers back repeatedly. Listings convert third with the broadest reach but the lowest direct-to-DM conversion because buyers who want a specific listing will DM, but most viewers do not. A healthy content mix is approximately 40% Brand, 35% Education, 25% Listings.",
    },
  ];
  const stmt = database.prepare(
    `INSERT INTO cm_knowledge_base (id, category, title, content, source, confidence, created_at, last_referenced_at)
     VALUES (?, ?, ?, ?, 'system', 1.0, ?, NULL)`,
  );
  for (const e of entries) {
    stmt.run(randomUUID(), e.category, e.title, e.content, now);
  }
}

function initSeasonalModelIfEmpty(database: Database.Database): void {
  const count = database.prepare(`SELECT COUNT(*) AS c FROM cm_seasonal_model`).get() as { c: number };
  if (Number(count.c) > 0) return;
  const now = new Date().toISOString();
  const stmt = database.prepare(
    `INSERT INTO cm_seasonal_model (week_number, historical_avg_views, historical_avg_dms, sample_years, performance_multiplier, season_label, last_updated)
     VALUES (?, 0, 0, 0, 1.0, ?, ?)`,
  );
  for (let w = 1; w <= 52; w++) {
    let label = "shoulder";
    if (w <= 10) label = "buyer_peak_spring_approach";
    else if (w <= 20) label = "buyer_peak";
    else if (w <= 35) label = "summer_slowdown";
    else if (w <= 43) label = "buyer_peak_fall";
    else label = "holiday_slow";
    stmt.run(w, label, now);
  }
}

export function todayDateCst(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

export interface AgentRun {
  cycle: string;
  status: "success" | "failure";
  summary: string | null;
  ranAt: string;
}

/** Persist an autonomous-agent (content-brain) cycle run so status survives restarts. */
export function recordAgentRun(run: { cycle: string; status: "success" | "failure"; summary?: string | null }): void {
  try {
    getContentDb()
      .prepare(`INSERT INTO cm_agent_runs (cycle, status, summary, ran_at) VALUES (?, ?, ?, ?)`)
      .run(run.cycle, run.status, run.summary ?? null, new Date().toISOString());
  } catch (err) {
    // Never let state-recording break the cycle itself.
    console.warn(`[cm-agent] could not persist run: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Most recent agent run (any status), or null if none recorded yet. */
export function getLatestAgentRun(): AgentRun | null {
  try {
    const row = getContentDb()
      .prepare(`SELECT cycle, status, summary, ran_at FROM cm_agent_runs ORDER BY ran_at DESC LIMIT 1`)
      .get() as { cycle: string; status: string; summary: string | null; ran_at: string } | undefined;
    if (!row) return null;
    return {
      cycle: row.cycle,
      status: row.status === "failure" ? "failure" : "success",
      summary: row.summary ?? null,
      ranAt: row.ran_at,
    };
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToSession(row: Record<string, unknown>): ContentSession {
  return {
    id: String(row.id),
    rawInputType: String(row.raw_input_type),
    rawInputPath: row.raw_input_path ? String(row.raw_input_path) : null,
    rawInputMeta: parseJson<Record<string, unknown>>(String(row.raw_input_meta ?? ""), {}),
    clipsGenerated: Number(row.clips_generated) || 0,
    status: row.status as ContentSessionStatus,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    batchSessionId: row.batch_session_id ? String(row.batch_session_id) : null,
    opusJobId: row.opus_job_id ? String(row.opus_job_id) : null,
    filmedBy: row.filmed_by ? String(row.filmed_by) : "marco",
  };
}

function rowToVideo(row: Record<string, unknown>): ContentVideo {
  return {
    id: String(row.id),
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    platformTarget: row.platform_target as ContentPlatformTarget,
    title: String(row.title),
    caption: String(row.caption),
    hook: String(row.hook),
    hashtags: parseJson<string[]>(String(row.hashtags ?? "[]"), []),
    pillar: row.pillar as ContentPillar,
    filePath: row.file_path ? String(row.file_path) : null,
    status: row.status as ContentVideoStatus,
    complianceFlagged: row.compliance_flagged === 1,
    complianceNotes: row.compliance_notes ? String(row.compliance_notes) : null,
    createdAt: String(row.created_at),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    scheduledFor: row.scheduled_for ? String(row.scheduled_for) : null,
    publishedAt: row.published_at ? String(row.published_at) : null,
    batchSessionId: row.batch_session_id ? String(row.batch_session_id) : null,
    sourceFileId: row.source_file_id ? String(row.source_file_id) : null,
    trendAlignmentScore: Number(row.trend_alignment_score) || 0,
    opusClipScore: Number(row.opus_clip_score) || 0,
    hookType: row.hook_type ? String(row.hook_type) : null,
    platformTargets: parseJson<string[]>(String(row.platform_targets ?? "[]"), []),
    optimalPostTime: row.optimal_post_time ? String(row.optimal_post_time) : null,
  };
}

function rowToPublishLog(row: Record<string, unknown>): ContentPublishLog {
  return {
    id: String(row.id),
    videoId: String(row.video_id),
    platform: String(row.platform),
    platformPostId: row.platform_post_id ? String(row.platform_post_id) : null,
    publishedAt: String(row.published_at),
    publishStatus: row.publish_status as "success" | "failed" | "scheduled",
    errorMessage: row.error_message ? String(row.error_message) : null,
  };
}

function rowToPerformance(row: Record<string, unknown>): ContentPerformance {
  return {
    id: String(row.id),
    videoId: String(row.video_id),
    platformPostId: row.platform_post_id ? String(row.platform_post_id) : null,
    platform: String(row.platform),
    views: Number(row.views) || 0,
    likes: Number(row.likes) || 0,
    comments: Number(row.comments) || 0,
    shares: Number(row.shares) || 0,
    saves: Number(row.saves) || 0,
    dmsGenerated: Number(row.dms_generated) || 0,
    phoneNumbersCaptured: Number(row.phone_numbers_captured) || 0,
    score: Number(row.score) || 0,
    tier: row.tier as PerformanceTier,
    benchmarkMet: row.benchmark_met === 1,
    pulledAt: String(row.pulled_at),
  };
}

function rowToCompliance(row: Record<string, unknown>): ContentComplianceQueueItem {
  return {
    id: String(row.id),
    videoId: String(row.video_id),
    flaggedReason: String(row.flagged_reason),
    flaggedAt: String(row.flagged_at),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewDecision: row.review_decision
      ? (row.review_decision as "approved" | "rejected")
      : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  };
}

function rowToDailyTargets(row: Record<string, unknown>): ContentDailyTargets {
  return {
    date: String(row.date),
    videosTarget: Number(row.videos_target) || 7,
    videosPublished: Number(row.videos_published) || 0,
    phoneNumbersTarget: Number(row.phone_numbers_target) || 22,
    phoneNumbersCaptured: Number(row.phone_numbers_captured) || 0,
    commentsManaged: Number(row.comments_managed) || 0,
    dmsTriaged: Number(row.dms_triaged) || 0,
    updatedAt: String(row.updated_at),
  };
}

export function ensureDailyTargets(date = todayDateCst()): ContentDailyTargets {
  const database = getContentDb();
  const existing = database
    .prepare(`SELECT * FROM content_daily_targets WHERE date = ?`)
    .get(date) as Record<string, unknown> | undefined;
  if (existing) return rowToDailyTargets(existing);

  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO content_daily_targets
       (date, videos_target, videos_published, phone_numbers_target, phone_numbers_captured,
        comments_managed, dms_triaged, updated_at)
       VALUES (?, 7, 0, 22, 0, 0, 0, ?)`,
    )
    .run(date, now);
  return ensureDailyTargets(date);
}

export function createContentSession(input: {
  rawInputType: string;
  rawInputPath?: string | null;
  rawInputMeta?: Record<string, unknown>;
  status?: ContentSessionStatus;
  batchSessionId?: string | null;
  opusJobId?: string | null;
  filmedBy?: string;
}): ContentSession {
  const database = getContentDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO content_sessions
       (id, raw_input_type, raw_input_path, raw_input_meta, clips_generated, status, created_at, completed_at,
        batch_session_id, opus_job_id, filmed_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      input.rawInputType,
      input.rawInputPath ?? null,
      JSON.stringify(input.rawInputMeta ?? {}),
      input.status ?? "processing",
      now,
      input.batchSessionId ?? null,
      input.opusJobId ?? null,
      input.filmedBy ?? "marco",
    );
  return getContentSession(id)!;
}

export function getContentSession(id: string): ContentSession | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM content_sessions WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function updateContentSession(
  id: string,
  patch: Partial<Pick<ContentSession, "clipsGenerated" | "status" | "completedAt">>,
): ContentSession | null {
  const existing = getContentSession(id);
  if (!existing) return null;
  const database = getContentDb();
  database
    .prepare(
      `UPDATE content_sessions SET clips_generated = ?, status = ?, completed_at = ? WHERE id = ?`,
    )
    .run(
      patch.clipsGenerated ?? existing.clipsGenerated,
      patch.status ?? existing.status,
      patch.completedAt !== undefined ? patch.completedAt : existing.completedAt,
      id,
    );
  return getContentSession(id);
}

export function insertContentVideo(
  video: Omit<ContentVideo, "createdAt"> & { createdAt?: string },
): ContentVideo {
  const database = getContentDb();
  const createdAt = video.createdAt ?? new Date().toISOString();
  database
    .prepare(
      `INSERT INTO content_videos
       (id, source_session_id, platform_target, title, caption, hook, hashtags, pillar, file_path,
        status, compliance_flagged, compliance_notes, created_at, approved_at, scheduled_for, published_at,
        batch_session_id, source_file_id, trend_alignment_score, opus_clip_score, hook_type, platform_targets,
        optimal_post_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      video.id,
      video.sourceSessionId,
      video.platformTarget,
      video.title,
      video.caption,
      video.hook,
      JSON.stringify(video.hashtags),
      video.pillar,
      video.filePath,
      video.status,
      video.complianceFlagged ? 1 : 0,
      video.complianceNotes,
      createdAt,
      video.approvedAt,
      video.scheduledFor,
      video.publishedAt,
      video.batchSessionId ?? null,
      video.sourceFileId ?? null,
      video.trendAlignmentScore ?? 0,
      video.opusClipScore ?? 0,
      video.hookType ?? null,
      JSON.stringify(video.platformTargets ?? []),
      video.optimalPostTime ?? null,
    );
  return getContentVideo(video.id)!;
}

export function getContentVideo(id: string): ContentVideo | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM content_videos WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToVideo(row) : null;
}

export function updateContentVideo(
  id: string,
  patch: Partial<
    Pick<
      ContentVideo,
      | "status"
      | "complianceFlagged"
      | "complianceNotes"
      | "approvedAt"
      | "scheduledFor"
      | "publishedAt"
      | "hook"
      | "caption"
      | "title"
      | "hashtags"
      | "trendAlignmentScore"
      | "opusClipScore"
      | "hookType"
      | "platformTargets"
      | "optimalPostTime"
      | "platformTarget"
    >
  >,
): ContentVideo | null {
  const existing = getContentVideo(id);
  if (!existing) return null;
  const database = getContentDb();
  database
    .prepare(
      `UPDATE content_videos SET status = ?, compliance_flagged = ?, compliance_notes = ?,
       approved_at = ?, scheduled_for = ?, published_at = ?, hook = ?, caption = ?, title = ?,
       hashtags = ?, trend_alignment_score = ?, opus_clip_score = ?, hook_type = ?,
       platform_targets = ?, optimal_post_time = ?, platform_target = ? WHERE id = ?`,
    )
    .run(
      patch.status ?? existing.status,
      (patch.complianceFlagged ?? existing.complianceFlagged) ? 1 : 0,
      patch.complianceNotes !== undefined ? patch.complianceNotes : existing.complianceNotes,
      patch.approvedAt !== undefined ? patch.approvedAt : existing.approvedAt,
      patch.scheduledFor !== undefined ? patch.scheduledFor : existing.scheduledFor,
      patch.publishedAt !== undefined ? patch.publishedAt : existing.publishedAt,
      patch.hook ?? existing.hook,
      patch.caption ?? existing.caption,
      patch.title ?? existing.title,
      JSON.stringify(patch.hashtags ?? existing.hashtags),
      patch.trendAlignmentScore ?? existing.trendAlignmentScore ?? 0,
      patch.opusClipScore ?? existing.opusClipScore ?? 0,
      patch.hookType !== undefined ? patch.hookType : existing.hookType,
      JSON.stringify(patch.platformTargets ?? existing.platformTargets ?? []),
      patch.optimalPostTime !== undefined ? patch.optimalPostTime : existing.optimalPostTime,
      patch.platformTarget ?? existing.platformTarget,
      id,
    );
  return getContentVideo(id);
}

/**
 * Point a clip at a newly-rendered file (used by the trim editor). Kept separate
 * from updateContentVideo so the clip-file reference is only ever repointed by a
 * caller that has already confirmed the new file is good on disk.
 */
export function updateContentVideoFilePath(id: string, filePath: string): ContentVideo | null {
  const existing = getContentVideo(id);
  if (!existing) return null;
  getContentDb().prepare(`UPDATE content_videos SET file_path = ? WHERE id = ?`).run(filePath, id);
  return getContentVideo(id);
}

/** Append one applied AI-edit record to a clip's edit_history (JSON array).
 * Best-effort: history must never block an edit, so parse failures start fresh. */
export function appendContentVideoEditHistory(
  id: string,
  record: {
    instruction: string;
    description: string;
    appliedAt: string;
    durationBefore: number | null;
    durationAfter: number | null;
  },
): void {
  const row = getContentDb()
    .prepare(`SELECT edit_history FROM content_videos WHERE id = ?`)
    .get(id) as { edit_history?: string | null } | undefined;
  if (!row) return;
  let history: unknown[] = [];
  try {
    const parsed = row.edit_history ? JSON.parse(row.edit_history) : [];
    if (Array.isArray(parsed)) history = parsed;
  } catch {
    /* corrupt history — restart it rather than fail the edit */
  }
  history.push(record);
  getContentDb()
    .prepare(`UPDATE content_videos SET edit_history = ? WHERE id = ?`)
    .run(JSON.stringify(history), id);
}

/* ── Clip edit versioning (revert-once) ── */
export interface CmClipVersion {
  id: string;
  videoId: string;
  filePath: string;
  note: string | null;
  createdAt: string;
}

export function recordClipVersion(videoId: string, filePath: string, note?: string): CmClipVersion {
  const row: CmClipVersion = {
    id: randomUUID(),
    videoId,
    filePath,
    note: note ?? null,
    createdAt: new Date().toISOString(),
  };
  getContentDb()
    .prepare(`INSERT INTO cm_clip_versions (id, video_id, file_path, note, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(row.id, row.videoId, row.filePath, row.note, row.createdAt);
  return row;
}

export function getLatestClipVersion(videoId: string): CmClipVersion | null {
  const r = getContentDb()
    .prepare(`SELECT * FROM cm_clip_versions WHERE video_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(videoId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    videoId: String(r.video_id),
    filePath: String(r.file_path),
    note: r.note != null ? String(r.note) : null,
    createdAt: String(r.created_at),
  };
}

export function deleteClipVersion(id: string): void {
  getContentDb().prepare(`DELETE FROM cm_clip_versions WHERE id = ?`).run(id);
}

/** All version file references, for the disk-cleanup protection set. */
export function listClipVersionFileRefs(): { videoId: string; filePath: string }[] {
  const rows = getContentDb()
    .prepare(`SELECT video_id, file_path FROM cm_clip_versions WHERE file_path IS NOT NULL`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({ videoId: String(r.video_id), filePath: String(r.file_path) }));
}

/* ── Google Drive auto-pull: already-processed file IDs (never re-pull) ── */
export function isDriveFileProcessed(fileId: string): boolean {
  const row = getContentDb()
    .prepare(`SELECT 1 FROM cm_drive_processed WHERE file_id = ?`)
    .get(fileId);
  return Boolean(row);
}

export function markDriveFileProcessed(fileId: string, name: string, sessionId: string | null): void {
  getContentDb()
    .prepare(
      `INSERT OR IGNORE INTO cm_drive_processed (file_id, name, session_id, processed_at) VALUES (?, ?, ?, ?)`,
    )
    .run(fileId, name, sessionId, new Date().toISOString());
}

export function countDriveProcessed(): number {
  const row = getContentDb().prepare(`SELECT COUNT(*) AS c FROM cm_drive_processed`).get() as { c: number };
  return Number(row.c) || 0;
}

export function listDriveProcessed(): Array<{ fileId: string; name: string; processedAt: string }> {
  const rows = getContentDb()
    .prepare(`SELECT file_id, name, processed_at FROM cm_drive_processed ORDER BY processed_at ASC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    fileId: String(r.file_id),
    name: String(r.name ?? ""),
    processedAt: String(r.processed_at ?? ""),
  }));
}

/* ── Google Drive auto-pull: failed / quarantined files ──────────────────────
 * A file that keeps failing downstream (e.g. OpenShorts judges it unclippable)
 * must not block every file behind it forever. We track attempts + the last
 * error, and once a file is quarantined the poller skips it so the queue always
 * advances. Cleared automatically if the file later succeeds. */
export interface DriveFailure {
  fileId: string;
  name: string;
  attempts: number;
  lastError: string | null;
  quarantined: boolean;
  firstFailedAt: string | null;
  lastFailedAt: string | null;
}

export function getDriveFailure(fileId: string): DriveFailure | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_drive_failed WHERE file_id = ?`)
    .get(fileId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    fileId: String(row.file_id),
    name: String(row.name ?? ""),
    attempts: Number(row.attempts) || 0,
    lastError: (row.last_error as string) ?? null,
    quarantined: Boolean(row.quarantined),
    firstFailedAt: (row.first_failed_at as string) ?? null,
    lastFailedAt: (row.last_failed_at as string) ?? null,
  };
}

export function isDriveFileQuarantined(fileId: string): boolean {
  const row = getContentDb()
    .prepare(`SELECT 1 FROM cm_drive_failed WHERE file_id = ? AND quarantined = 1`)
    .get(fileId);
  return Boolean(row);
}

/** Record a failed pull attempt; increments the attempt count and sets the
 * quarantine flag when asked (a permanent content failure, or too many tries).
 * Returns the new attempt count. */
export function recordDriveFileFailure(
  fileId: string,
  name: string,
  error: string,
  quarantine: boolean,
): number {
  const now = new Date().toISOString();
  const existing = getDriveFailure(fileId);
  const attempts = (existing?.attempts ?? 0) + 1;
  getContentDb()
    .prepare(
      `INSERT INTO cm_drive_failed (file_id, name, attempts, last_error, quarantined, first_failed_at, last_failed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         name = excluded.name,
         attempts = excluded.attempts,
         last_error = excluded.last_error,
         quarantined = MAX(cm_drive_failed.quarantined, excluded.quarantined),
         last_failed_at = excluded.last_failed_at`,
    )
    .run(fileId, name, attempts, error, quarantine ? 1 : 0, existing?.firstFailedAt ?? now, now);
  return attempts;
}

/** Clear any failure record for a file (called when it finally succeeds). */
export function clearDriveFileFailure(fileId: string): void {
  getContentDb().prepare(`DELETE FROM cm_drive_failed WHERE file_id = ?`).run(fileId);
}

export function listDriveFailures(): DriveFailure[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_drive_failed ORDER BY last_failed_at DESC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    fileId: String(row.file_id),
    name: String(row.name ?? ""),
    attempts: Number(row.attempts) || 0,
    lastError: (row.last_error as string) ?? null,
    quarantined: Boolean(row.quarantined),
    firstFailedAt: (row.first_failed_at as string) ?? null,
    lastFailedAt: (row.last_failed_at as string) ?? null,
  }));
}

/* Drive poller state (survives restarts): last poll time + last calendar day a
 * file was actually pulled (drives the one-per-day throttle). */
export function getDriveState(): { lastPollAt: string | null; lastPullDate: string | null } {
  const row = getContentDb().prepare(`SELECT last_poll_at, last_pull_date FROM cm_drive_state WHERE id = 1`).get() as
    | { last_poll_at: string | null; last_pull_date: string | null }
    | undefined;
  return { lastPollAt: row?.last_poll_at ?? null, lastPullDate: row?.last_pull_date ?? null };
}

export function setDriveLastPollAt(iso: string): void {
  getContentDb()
    .prepare(
      `INSERT INTO cm_drive_state (id, last_poll_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_poll_at = excluded.last_poll_at`,
    )
    .run(iso);
}

export function setDriveLastPullDate(day: string): void {
  getContentDb()
    .prepare(
      `INSERT INTO cm_drive_state (id, last_pull_date) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_pull_date = excluded.last_pull_date`,
    )
    .run(day);
}

/* ── Per-clip edit-chat history ── */
export function insertClipChatMessage(clipId: string, role: "user" | "assistant", content: string): void {
  getContentDb()
    .prepare(`INSERT INTO cm_clip_chat (id, clip_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(randomUUID(), clipId, role, content, new Date().toISOString());
}

export function listClipChatMessages(clipId: string, limit = 40): Array<{ role: "user" | "assistant"; content: string }> {
  // Take the MOST RECENT `limit` messages (DESC + limit), then flip back to
  // chronological order for display/replay. rowid is the tiebreak so a user +
  // assistant pair written in the same millisecond keeps its true insert order
  // (ORDER BY created_at alone can reorder same-ms rows).
  const rows = getContentDb()
    .prepare(
      `SELECT role, content FROM cm_clip_chat WHERE clip_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(clipId, limit) as Array<Record<string, unknown>>;
  return rows
    .reverse()
    .map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: String(r.content) }));
}

export function listContentVideos(input?: {
  status?: ContentVideoStatus;
  limit?: number;
}): ContentVideo[] {
  const limit = input?.limit ?? 20;
  const database = getContentDb();
  const rows = input?.status
    ? (database
        .prepare(
          `SELECT * FROM content_videos WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(input.status, limit) as Record<string, unknown>[])
    : (database
        .prepare(`SELECT * FROM content_videos ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]);
  return rows.map(rowToVideo);
}

/** Lightweight refs for disk cleanup — every video's id/status/file_path (no limit). */
export function listAllContentVideoFileRefs(): { id: string; status: string; filePath: string | null }[] {
  const database = getContentDb();
  const rows = database
    .prepare(`SELECT id, status, file_path FROM content_videos`)
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    filePath: r.file_path != null ? String(r.file_path) : null,
  }));
}

/** Lightweight refs for disk cleanup — every source file's path + job status. */
export function listAllBatchSourceFileRefs(): { filePath: string; opusStatus: string }[] {
  const database = getContentDb();
  const rows = database
    .prepare(`SELECT file_path, opus_status FROM cm_batch_source_files`)
    .all() as Record<string, unknown>[];
  return rows
    .map((r) => ({
      filePath: r.file_path != null ? String(r.file_path) : "",
      opusStatus: String(r.opus_status ?? "queued"),
    }))
    .filter((r) => r.filePath);
}

export function insertPublishLog(
  log: Omit<ContentPublishLog, "id"> & { id?: string },
): ContentPublishLog {
  const database = getContentDb();
  const id = log.id ?? randomUUID();
  database
    .prepare(
      `INSERT INTO content_publish_log
       (id, video_id, platform, platform_post_id, published_at, publish_status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      log.videoId,
      log.platform,
      log.platformPostId,
      log.publishedAt,
      log.publishStatus,
      log.errorMessage,
    );
  return { ...log, id };
}

export function listSuccessfulPublishLogs(): ContentPublishLog[] {
  const rows = getContentDb()
    .prepare(
      `SELECT * FROM content_publish_log WHERE publish_status = 'success' ORDER BY published_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToPublishLog);
}

export interface PublishingQueueItem {
  video: ContentVideo;
  enhancement: CmClipEnhancement | null;
  entries: Array<{
    platform: string;
    scheduledFor: string;
    publishStatus: string;
  }>;
}

export function listPublishingQueue(limit = 50): PublishingQueueItem[] {
  const database = getContentDb();
  const rows = database
    .prepare(
      `SELECT * FROM content_videos
       WHERE status IN ('approved', 'scheduled', 'submitted', 'published')
       ORDER BY COALESCE(approved_at, scheduled_for, created_at) DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];

  return rows.map((row) => {
    const video = rowToVideo(row);
    const logRows = database
      .prepare(
        `SELECT * FROM content_publish_log WHERE video_id = ? ORDER BY published_at DESC`,
      )
      .all(video.id) as Record<string, unknown>[];
    const entries = logRows.map((lr) => ({
      platform: String(lr.platform),
      scheduledFor: String(lr.published_at),
      publishStatus: String(lr.publish_status),
    }));
    return {
      video,
      enhancement: getClipEnhancementByVideoId(video.id),
      entries,
    };
  });
}

export function countPublishingQueue(): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM content_videos WHERE status IN ('approved', 'scheduled', 'submitted', 'published')`,
    )
    .get() as { c: number };
  return Number(row.c) || 0;
}

export function insertPerformance(perf: Omit<ContentPerformance, "id"> & { id?: string }): ContentPerformance {
  const database = getContentDb();
  const id = perf.id ?? randomUUID();
  database
    .prepare(
      `INSERT INTO content_performance
       (id, video_id, platform_post_id, platform, views, likes, comments, shares, saves,
        dms_generated, phone_numbers_captured, score, tier, benchmark_met, pulled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      perf.videoId,
      perf.platformPostId,
      perf.platform,
      perf.views,
      perf.likes,
      perf.comments,
      perf.shares,
      perf.saves,
      perf.dmsGenerated,
      perf.phoneNumbersCaptured,
      perf.score,
      perf.tier,
      perf.benchmarkMet ? 1 : 0,
      perf.pulledAt,
    );
  return { ...perf, id };
}

export function getLatestPerformance(videoId: string): ContentPerformance | null {
  const row = getContentDb()
    .prepare(
      `SELECT * FROM content_performance WHERE video_id = ? ORDER BY pulled_at DESC LIMIT 1`,
    )
    .get(videoId) as Record<string, unknown> | undefined;
  return row ? rowToPerformance(row) : null;
}

export function insertComplianceQueueItem(input: {
  videoId: string;
  flaggedReason: string;
}): ContentComplianceQueueItem {
  const database = getContentDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO content_compliance_queue
       (id, video_id, flagged_reason, flagged_at, reviewed_by, review_decision, reviewed_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .run(id, input.videoId, input.flaggedReason, now);
  return {
    id,
    videoId: input.videoId,
    flaggedReason: input.flaggedReason,
    flaggedAt: now,
    reviewedBy: null,
    reviewDecision: null,
    reviewedAt: null,
  };
}

export function listPendingComplianceQueue(): Array<
  ContentComplianceQueueItem & {
    caption: string;
    hook: string;
    platformTarget: string;
    title: string;
  }
> {
  const rows = getContentDb()
    .prepare(
      `SELECT q.*, v.caption, v.hook, v.platform_target, v.title
       FROM content_compliance_queue q
       JOIN content_videos v ON v.id = q.video_id
       WHERE q.review_decision IS NULL
       ORDER BY q.flagged_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    ...rowToCompliance(row),
    caption: String(row.caption),
    hook: String(row.hook),
    platformTarget: String(row.platform_target),
    title: String(row.title),
  }));
}

export function incrementDailyTarget(
  date: string,
  field:
    | "videos_published"
    | "phone_numbers_captured"
    | "comments_managed"
    | "dms_triaged",
  amount = 1,
): ContentDailyTargets {
  ensureDailyTargets(date);
  const database = getContentDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE content_daily_targets SET ${field} = ${field} + ?, updated_at = ? WHERE date = ?`,
    )
    .run(amount, now, date);
  return ensureDailyTargets(date);
}

export function setDailyPhoneCaptureCount(date: string, count: number): ContentDailyTargets {
  ensureDailyTargets(date);
  const now = new Date().toISOString();
  getContentDb()
    .prepare(`UPDATE content_daily_targets SET phone_numbers_captured = ?, updated_at = ? WHERE date = ?`)
    .run(count, now, date);
  return ensureDailyTargets(date);
}

export function countLeadCapturesForDate(date: string): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM content_lead_captures
       WHERE captured_at >= ? AND captured_at < date(?, '+1 day')`,
    )
    .get(`${date}T00:00:00.000Z`, date) as { c: number };
  return Number(row.c) || 0;
}

export function insertLeadCapture(input: {
  platform: string;
  platformUserId: string;
  phoneNumber: string;
  capturedFrom: "dm" | "comment";
  rawMessage: string;
  routedToCrm?: boolean;
  routedAt?: string | null;
}): ContentLeadCapture {
  const database = getContentDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO content_lead_captures
       (id, platform, platform_user_id, phone_number, captured_from, raw_message, routed_to_crm, routed_at, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.platform,
      input.platformUserId,
      input.phoneNumber,
      input.capturedFrom,
      input.rawMessage,
      input.routedToCrm ? 1 : 0,
      input.routedAt ?? null,
      now,
    );
  return {
    id,
    platform: input.platform,
    platformUserId: input.platformUserId,
    phoneNumber: input.phoneNumber,
    capturedFrom: input.capturedFrom,
    rawMessage: input.rawMessage,
    routedToCrm: Boolean(input.routedToCrm),
    routedAt: input.routedAt ?? null,
    capturedAt: now,
  };
}

export function getDailyTargets(date: string): ContentDailyTargets {
  return ensureDailyTargets(date);
}

export function listDailyTargetsLastDays(days: number): ContentDailyTargets[] {
  const rows = getContentDb()
    .prepare(
      `SELECT * FROM content_daily_targets ORDER BY date DESC LIMIT ?`,
    )
    .all(days) as Record<string, unknown>[];
  return rows.map(rowToDailyTargets).reverse();
}

export function listPerformanceForDate(date: string): ContentPerformance[] {
  const rows = getContentDb()
    .prepare(
      `SELECT p.* FROM content_performance p
       INNER JOIN (
         SELECT video_id, MAX(pulled_at) AS max_pulled
         FROM content_performance
         GROUP BY video_id
       ) latest ON p.video_id = latest.video_id AND p.pulled_at = latest.max_pulled
       WHERE date(p.pulled_at) = ?`,
    )
    .all(date) as Record<string, unknown>[];
  return rows.map(rowToPerformance);
}

export function listConsistentlyBelowBenchmarkVideos(): Array<{
  videoId: string;
  title: string;
  consecutiveColdPulls: number;
  latestViews: number;
}> {
  const rows = getContentDb()
    .prepare(
      `SELECT v.id AS video_id, v.title, p.views, p.tier, p.pulled_at
       FROM content_performance p
       JOIN content_videos v ON v.id = p.video_id
       ORDER BY p.video_id, p.pulled_at DESC`,
    )
    .all() as Array<{
    video_id: string;
    title: string;
    views: number;
    tier: string;
    pulled_at: string;
  }>;

  const byVideo = new Map<string, Array<{ views: number; tier: string }>>();
  const titles = new Map<string, string>();
  for (const row of rows) {
    titles.set(row.video_id, row.title);
    const list = byVideo.get(row.video_id) ?? [];
    list.push({ views: row.views, tier: row.tier });
    byVideo.set(row.video_id, list);
  }

  const out: Array<{
    videoId: string;
    title: string;
    consecutiveColdPulls: number;
    latestViews: number;
  }> = [];

  for (const [videoId, pulls] of byVideo) {
    let consecutive = 0;
    for (const pull of pulls) {
      if (pull.views < 3000 && pull.tier === "cold") consecutive++;
      else break;
    }
    if (consecutive >= 3) {
      out.push({
        videoId,
        title: titles.get(videoId) ?? videoId,
        consecutiveColdPulls: consecutive,
        latestViews: pulls[0]?.views ?? 0,
      });
    }
  }
  return out;
}

export function computePerformanceScore(stats: {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}): { score: number; tier: PerformanceTier; benchmarkMet: boolean } {
  const views = Math.max(0, stats.views);
  const engagement = stats.comments + stats.shares + stats.saves + stats.likes * 0.1;
  const engagementRate = views > 0 ? engagement / views : 0;
  const benchmarkEngagementRate =
    (CONTENT_BENCHMARK_COMMENTS + CONTENT_BENCHMARK_SHARES) / CONTENT_BENCHMARK_VIEWS;

  const viewComponent = (views / CONTENT_BENCHMARK_VIEWS) * 60;
  const engagementComponent =
    benchmarkEngagementRate > 0 ? (engagementRate / benchmarkEngagementRate) * 40 : 0;
  const score = Math.round(Math.min(100, Math.max(0, viewComponent + engagementComponent)));

  let tier: PerformanceTier = "cold";
  if (score >= 70) tier = "hot";
  else if (score >= 40) tier = "average";

  return {
    score,
    tier,
    benchmarkMet: views >= CONTENT_BENCHMARK_VIEWS,
  };
}

export function countVideosByStatus(status: ContentVideoStatus): number {
  const row = getContentDb()
    .prepare(`SELECT COUNT(*) AS c FROM content_videos WHERE status = ?`)
    .get(status) as { c: number };
  return Number(row.c) || 0;
}

export function countVideosComplianceFlaggedPending(): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM content_videos WHERE status = 'pending_review' AND compliance_flagged = 1`,
    )
    .get() as { c: number };
  return Number(row.c) || 0;
}

export function countPipelineClips(): number {
  const pending = countVideosByStatus("pending_review");
  const processing = getContentDb()
    .prepare(`SELECT COUNT(*) AS c FROM content_sessions WHERE status = 'processing'`)
    .get() as { c: number };
  return pending + (Number(processing.c) || 0);
}

export function countVideosPublishedToday(date = todayDateCst()): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM content_videos WHERE status = 'published' AND date(published_at) = ?`,
    )
    .get(date) as { c: number };
  return Number(row.c) || 0;
}

export function getStatusCounts(): Record<string, number> {
  const rows = getContentDb()
    .prepare(`SELECT status, COUNT(*) AS c FROM content_videos GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  const out: Record<string, number> = {
    pending_review: 0,
    approved: 0,
    scheduled: 0,
    published: 0,
    rejected: 0,
  };
  for (const row of rows) {
    out[row.status] = Number(row.c) || 0;
  }
  return out;
}

export function listLeadCaptures(input?: {
  capturedFrom?: "dm" | "comment";
  limit?: number;
}): ContentLeadCapture[] {
  const limit = input?.limit ?? 100;
  const database = getContentDb();
  const rows = input?.capturedFrom
    ? (database
        .prepare(
          `SELECT * FROM content_lead_captures WHERE captured_from = ? ORDER BY captured_at DESC LIMIT ?`,
        )
        .all(input.capturedFrom, limit) as Record<string, unknown>[])
    : (database
        .prepare(`SELECT * FROM content_lead_captures ORDER BY captured_at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]);
  return rows.map((row) => ({
    id: String(row.id),
    platform: String(row.platform),
    platformUserId: String(row.platform_user_id),
    phoneNumber: String(row.phone_number),
    capturedFrom: row.captured_from as "dm" | "comment",
    rawMessage: String(row.raw_message),
    routedToCrm: row.routed_to_crm === 1,
    routedAt: row.routed_at ? String(row.routed_at) : null,
    capturedAt: String(row.captured_at),
  }));
}

export function resolveComplianceQueueForVideo(videoId: string): ContentComplianceQueueItem | null {
  const row = getContentDb()
    .prepare(
      `SELECT * FROM content_compliance_queue WHERE video_id = ? ORDER BY flagged_at DESC LIMIT 1`,
    )
    .get(videoId) as Record<string, unknown> | undefined;
  return row ? rowToCompliance(row) : null;
}

export function updateComplianceQueueDecision(
  videoId: string,
  decision: "approved" | "rejected",
  reviewedBy = "marco",
): void {
  getContentDb()
    .prepare(
      `UPDATE content_compliance_queue SET review_decision = ?, reviewed_by = ?, reviewed_at = ?
       WHERE video_id = ? AND review_decision IS NULL`,
    )
    .run(decision, reviewedBy, new Date().toISOString(), videoId);
}

export interface AnalyticsRow {
  videoId: string;
  title: string;
  caption: string;
  pillar: string;
  platformTarget: string;
  publishedAt: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  score: number;
  tier: string;
  benchmarkMet: boolean;
  pulledAt: string | null;
}

export function getAnalyticsDataset(): AnalyticsRow[] {
  const rows = getContentDb()
    .prepare(
      `SELECT v.id AS video_id, v.title, v.caption, v.pillar, v.platform_target, v.published_at,
              p.views, p.likes, p.comments, p.shares, p.saves, p.score, p.tier, p.benchmark_met, p.pulled_at
       FROM content_videos v
       LEFT JOIN (
         SELECT video_id, MAX(pulled_at) AS max_pulled FROM content_performance GROUP BY video_id
       ) latest ON v.id = latest.video_id
       LEFT JOIN content_performance p ON p.video_id = latest.video_id AND p.pulled_at = latest.max_pulled
       ORDER BY COALESCE(p.pulled_at, v.created_at) DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    videoId: String(row.video_id),
    title: String(row.title),
    caption: String(row.caption),
    pillar: String(row.pillar),
    platformTarget: String(row.platform_target),
    publishedAt: row.published_at ? String(row.published_at) : null,
    views: Number(row.views) || 0,
    likes: Number(row.likes) || 0,
    comments: Number(row.comments) || 0,
    shares: Number(row.shares) || 0,
    saves: Number(row.saves) || 0,
    score: Number(row.score) || 0,
    tier: String(row.tier || "cold"),
    benchmarkMet: row.benchmark_met === 1,
    pulledAt: row.pulled_at ? String(row.pulled_at) : null,
  }));
}

export function getPillarPerformanceSummary(): Array<{
  pillar: string;
  videoCount: number;
  avgViews: number;
  avgScore: number;
}> {
  const rows = getContentDb()
    .prepare(
      `SELECT v.pillar, AVG(COALESCE(p.views, 0)) AS avg_views, AVG(COALESCE(p.score, 0)) AS avg_score, COUNT(*) AS c
       FROM content_videos v
       LEFT JOIN (
         SELECT video_id, MAX(pulled_at) AS max_pulled FROM content_performance GROUP BY video_id
       ) latest ON v.id = latest.video_id
       LEFT JOIN content_performance p ON p.video_id = latest.video_id AND p.pulled_at = latest.max_pulled
       GROUP BY v.pillar`,
    )
    .all() as Array<{ pillar: string; avg_views: number; avg_score: number; c: number }>;
  return rows.map((r) => ({
    pillar: r.pillar,
    videoCount: Number(r.c) || 0,
    avgViews: Math.round(Number(r.avg_views) || 0),
    avgScore: Math.round(Number(r.avg_score) || 0),
  }));
}

export function getContentManagerStats() {
  const today = todayDateCst();
  const targets = ensureDailyTargets(today);
  return {
    today,
    targets,
    statusCounts: getStatusCounts(),
    pipelineClips: countPipelineClips(),
    reviewFlagged: countVideosComplianceFlaggedPending(),
    scheduled: countVideosByStatus("scheduled"),
    publishedToday: countVideosPublishedToday(today),
    dmsTarget: 44,
  };
}

/* ── Content Manager Brain tables ── */

export interface CmPerformanceModel {
  id: string;
  pillarEducationAvgViews: number;
  pillarListingsAvgViews: number;
  pillarBrandAvgViews: number;
  overallAvgViews: number;
  overallAvgEngagementRate: number;
  benchmarkGapPct: number;
  trendingDirection: "up" | "down" | "flat";
  bestPostingDay: string | null;
  bestPostingHour: number | null;
  topPerformingPillar: string | null;
  topPerformingHashtags: string[];
  workingHookPatterns: string[];
  failingHookPatterns: string[];
  hotStreakCount: number;
  coldStreakCount: number;
  currentStreakType: "hot" | "cold" | "neutral";
  streakStartedAt: string | null;
  calibrationScore: number | null;
  selfGradeLastWeek: string | null;
  seasonMultiplier: number;
  decayWeightedAvgViews: number;
  updatedAt: string;
}

export interface CmLearningLog {
  id: string;
  cycleType: string;
  date: string;
  insights: string[];
  strategyAdjustments: string[];
  performanceSnapshot: Record<string, unknown>;
  videosAboveBenchmark: number;
  videosBelowBenchmark: number;
  phoneNumbersToday: number;
  loggedAt: string;
}

export interface CmDailyStrategy {
  date: string;
  pillarPriority: string[];
  recommendedHooks: string[];
  hashtagSet: string[];
  avoidAngles: string[];
  platformDistribution: Record<string, number>;
  reasoning: string;
  confidenceScore: number;
  generatedAt: string;
  lastUpdated: string;
}

export interface CmBriefing {
  id: string;
  briefingType: string;
  title: string;
  body: string;
  keyMetrics: Record<string, unknown>;
  actionItems: string[];
  sentToHarvey: boolean;
  createdAt: string;
}

export interface CmCutListItem {
  id: string;
  contentAngle: string;
  reason: string;
  avgViewsWhenCut: number;
  benchmarkAtCut: number;
  timesTested: number;
  flaggedBy: string;
  flaggedAt: string;
  reinstated: boolean;
}

export interface CmHookLibraryEntry {
  id: string;
  hookText: string;
  contentPillar: string;
  avgViewsWhenUsed: number;
  timesUsed: number;
  timesAboveBenchmark: number;
  performanceScore: number;
  active: boolean;
  createdAt: string;
  lastUsed: string | null;
  hookType: string;
  hookStructure: string | null;
  classifiedAt: string | null;
}

export interface CmCombinationPattern {
  id: string;
  pillar: string;
  hookType: string;
  postingDay: string;
  postingHourBucket: string;
  captionLengthBucket: string;
  sampleCount: number;
  avgViews: number;
  avgEngagementRate: number;
  aboveBenchmarkCount: number;
  performanceScore: number;
  lastUpdated: string;
}

export interface CmStrategyAccuracy {
  id: string;
  strategyDate: string;
  recommendedTopPillar: string | null;
  actualTopPillar: string | null;
  recommendedHooks: string[];
  hooksThatBeatBenchmark: string[];
  confidenceScoreGiven: number;
  outcomeScore: number;
  pillarPredictionCorrect: boolean;
  hooksHitRate: number;
  overallGrade: string;
  evaluatedAt: string;
}

export interface CmExperiment {
  id: string;
  weekStart: string;
  hypothesis: string;
  variableTested: string;
  controlDescription: string;
  testDescription: string;
  controlVideoIds: string;
  testVideoIds: string;
  controlAvgViews: number;
  testAvgViews: number;
  status: string;
  result: string | null;
  conclusion: string | null;
  proposedBy: string;
  evaluatedAt: string | null;
  createdAt: string;
}

export interface CmChatSession {
  id: string;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
  sessionSummary: string | null;
  expiresAt: string;
}

export interface CmChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  performanceContext: Record<string, unknown> | null;
  createdAt: string;
}

export interface CmSelfEvaluation {
  id: string;
  weekStart: string;
  strategiesFollowed: number;
  strategiesIgnored: number;
  avgOutcomeScore: number;
  whatWorked: string;
  whatFailed: string;
  oneChange: string;
  calibrationScore: number | null;
  benchmarkAssessment: string | null;
  createdAt: string;
}

export interface CmSeasonalWeek {
  weekNumber: number;
  historicalAvgViews: number;
  historicalAvgDms: number;
  sampleYears: number;
  performanceMultiplier: number;
  seasonLabel: string | null;
  notes: string | null;
  lastUpdated: string | null;
}

export function yesterdayDateCst(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
  const today = fmt.format(now);
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return fmt.format(d);
}

function rowToPerformanceModel(row: Record<string, unknown>): CmPerformanceModel {
  return {
    id: String(row.id),
    pillarEducationAvgViews: Number(row.pillar_education_avg_views) || 0,
    pillarListingsAvgViews: Number(row.pillar_listings_avg_views) || 0,
    pillarBrandAvgViews: Number(row.pillar_brand_avg_views) || 0,
    overallAvgViews: Number(row.overall_avg_views) || 0,
    overallAvgEngagementRate: Number(row.overall_avg_engagement_rate) || 0,
    benchmarkGapPct: Number(row.benchmark_gap_pct) || 0,
    trendingDirection: (row.trending_direction as "up" | "down" | "flat") || "flat",
    bestPostingDay: row.best_posting_day ? String(row.best_posting_day) : null,
    bestPostingHour: row.best_posting_hour != null ? Number(row.best_posting_hour) : null,
    topPerformingPillar: row.top_performing_pillar ? String(row.top_performing_pillar) : null,
    topPerformingHashtags: parseJson<string[]>(String(row.top_performing_hashtags ?? "[]"), []),
    workingHookPatterns: parseJson<string[]>(String(row.working_hook_patterns ?? "[]"), []),
    failingHookPatterns: parseJson<string[]>(String(row.failing_hook_patterns ?? "[]"), []),
    hotStreakCount: Number(row.hot_streak_count) || 0,
    coldStreakCount: Number(row.cold_streak_count) || 0,
    currentStreakType: (row.current_streak_type as "hot" | "cold" | "neutral") || "neutral",
    streakStartedAt: row.streak_started_at ? String(row.streak_started_at) : null,
    calibrationScore: row.calibration_score != null ? Number(row.calibration_score) : null,
    selfGradeLastWeek: row.self_grade_last_week ? String(row.self_grade_last_week) : null,
    seasonMultiplier: Number(row.season_multiplier) || 1,
    decayWeightedAvgViews: Number(row.decay_weighted_avg_views) || 0,
    updatedAt: String(row.updated_at),
  };
}

function rowToLearningLog(row: Record<string, unknown>): CmLearningLog {
  return {
    id: String(row.id),
    cycleType: String(row.cycle_type),
    date: String(row.date),
    insights: parseJson<string[]>(String(row.insights ?? "[]"), []),
    strategyAdjustments: parseJson<string[]>(String(row.strategy_adjustments ?? "[]"), []),
    performanceSnapshot: parseJson<Record<string, unknown>>(String(row.performance_snapshot ?? "{}"), {}),
    videosAboveBenchmark: Number(row.videos_above_benchmark) || 0,
    videosBelowBenchmark: Number(row.videos_below_benchmark) || 0,
    phoneNumbersToday: Number(row.phone_numbers_today) || 0,
    loggedAt: String(row.logged_at),
  };
}

function rowToDailyStrategy(row: Record<string, unknown>): CmDailyStrategy {
  return {
    date: String(row.date),
    pillarPriority: parseJson<string[]>(String(row.pillar_priority ?? "[]"), []),
    recommendedHooks: parseJson<string[]>(String(row.recommended_hooks ?? "[]"), []),
    hashtagSet: parseJson<string[]>(String(row.hashtag_set ?? "[]"), []),
    avoidAngles: parseJson<string[]>(String(row.avoid_angles ?? "[]"), []),
    platformDistribution: parseJson<Record<string, number>>(
      String(row.platform_distribution ?? "{}"),
      {},
    ),
    reasoning: String(row.reasoning ?? ""),
    confidenceScore: Number(row.confidence_score) || 0,
    generatedAt: String(row.generated_at),
    lastUpdated: String(row.last_updated),
  };
}

function rowToBriefing(row: Record<string, unknown>): CmBriefing {
  return {
    id: String(row.id),
    briefingType: String(row.briefing_type),
    title: String(row.title),
    body: String(row.body),
    keyMetrics: parseJson<Record<string, unknown>>(String(row.key_metrics ?? "{}"), {}),
    actionItems: parseJson<string[]>(String(row.action_items ?? "[]"), []),
    sentToHarvey: row.sent_to_harvey === 1,
    createdAt: String(row.created_at),
  };
}

function rowToCutList(row: Record<string, unknown>): CmCutListItem {
  return {
    id: String(row.id),
    contentAngle: String(row.content_angle),
    reason: String(row.reason),
    avgViewsWhenCut: Number(row.avg_views_when_cut) || 0,
    benchmarkAtCut: Number(row.benchmark_at_cut) || CONTENT_BENCHMARK_VIEWS,
    timesTested: Number(row.times_tested) || 0,
    flaggedBy: String(row.flagged_by),
    flaggedAt: String(row.flagged_at),
    reinstated: row.reinstated === 1,
  };
}

function rowToHookLibrary(row: Record<string, unknown>): CmHookLibraryEntry {
  return {
    id: String(row.id),
    hookText: String(row.hook_text),
    contentPillar: String(row.content_pillar),
    avgViewsWhenUsed: Number(row.avg_views_when_used) || 0,
    timesUsed: Number(row.times_used) || 0,
    timesAboveBenchmark: Number(row.times_above_benchmark) || 0,
    performanceScore: Number(row.performance_score) || 0,
    active: row.active !== 0,
    createdAt: String(row.created_at),
    lastUsed: row.last_used ? String(row.last_used) : null,
    hookType: row.hook_type ? String(row.hook_type) : "uncategorized",
    hookStructure: row.hook_structure ? String(row.hook_structure) : null,
    classifiedAt: row.classified_at ? String(row.classified_at) : null,
  };
}

export function getPerformanceModel(): CmPerformanceModel {
  const row = readPerformanceModelRow();
  if (row) return rowToPerformanceModel(row);
  return upsertPerformanceModel({});
}

function readPerformanceModelRow(): Record<string, unknown> | undefined {
  return getContentDb()
    .prepare(`SELECT * FROM cm_performance_model WHERE id = 'current'`)
    .get() as Record<string, unknown> | undefined;
}

export function upsertPerformanceModel(
  patch: Partial<Omit<CmPerformanceModel, "id" | "updatedAt">>,
): CmPerformanceModel {
  const existingRow = readPerformanceModelRow();
  const existing = existingRow ? rowToPerformanceModel(existingRow) : null;
  const now = new Date().toISOString();
  const merged: CmPerformanceModel = {
    id: "current",
    pillarEducationAvgViews: patch.pillarEducationAvgViews ?? existing?.pillarEducationAvgViews ?? 0,
    pillarListingsAvgViews: patch.pillarListingsAvgViews ?? existing?.pillarListingsAvgViews ?? 0,
    pillarBrandAvgViews: patch.pillarBrandAvgViews ?? existing?.pillarBrandAvgViews ?? 0,
    overallAvgViews: patch.overallAvgViews ?? existing?.overallAvgViews ?? 0,
    overallAvgEngagementRate:
      patch.overallAvgEngagementRate ?? existing?.overallAvgEngagementRate ?? 0,
    benchmarkGapPct: patch.benchmarkGapPct ?? existing?.benchmarkGapPct ?? 0,
    trendingDirection: patch.trendingDirection ?? existing?.trendingDirection ?? "flat",
    bestPostingDay: patch.bestPostingDay !== undefined ? patch.bestPostingDay : (existing?.bestPostingDay ?? null),
    bestPostingHour: patch.bestPostingHour !== undefined ? patch.bestPostingHour : (existing?.bestPostingHour ?? null),
    topPerformingPillar:
      patch.topPerformingPillar !== undefined
        ? patch.topPerformingPillar
        : (existing?.topPerformingPillar ?? null),
    topPerformingHashtags: patch.topPerformingHashtags ?? existing?.topPerformingHashtags ?? [],
    workingHookPatterns: patch.workingHookPatterns ?? existing?.workingHookPatterns ?? [],
    failingHookPatterns: patch.failingHookPatterns ?? existing?.failingHookPatterns ?? [],
    hotStreakCount: patch.hotStreakCount ?? existing?.hotStreakCount ?? 0,
    coldStreakCount: patch.coldStreakCount ?? existing?.coldStreakCount ?? 0,
    currentStreakType: patch.currentStreakType ?? existing?.currentStreakType ?? "neutral",
    streakStartedAt:
      patch.streakStartedAt !== undefined ? patch.streakStartedAt : (existing?.streakStartedAt ?? null),
    calibrationScore:
      patch.calibrationScore !== undefined ? patch.calibrationScore : (existing?.calibrationScore ?? null),
    selfGradeLastWeek:
      patch.selfGradeLastWeek !== undefined
        ? patch.selfGradeLastWeek
        : (existing?.selfGradeLastWeek ?? null),
    seasonMultiplier: patch.seasonMultiplier ?? existing?.seasonMultiplier ?? 1,
    decayWeightedAvgViews: patch.decayWeightedAvgViews ?? existing?.decayWeightedAvgViews ?? 0,
    updatedAt: now,
  };
  getContentDb()
    .prepare(
      `INSERT INTO cm_performance_model
       (id, pillar_education_avg_views, pillar_listings_avg_views, pillar_brand_avg_views,
        overall_avg_views, overall_avg_engagement_rate, benchmark_gap_pct, trending_direction,
        best_posting_day, best_posting_hour, top_performing_pillar, top_performing_hashtags,
        working_hook_patterns, failing_hook_patterns, hot_streak_count, cold_streak_count,
        current_streak_type, streak_started_at, calibration_score, self_grade_last_week,
        season_multiplier, decay_weighted_avg_views, updated_at)
       VALUES ('current', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        pillar_education_avg_views=excluded.pillar_education_avg_views,
        pillar_listings_avg_views=excluded.pillar_listings_avg_views,
        pillar_brand_avg_views=excluded.pillar_brand_avg_views,
        overall_avg_views=excluded.overall_avg_views,
        overall_avg_engagement_rate=excluded.overall_avg_engagement_rate,
        benchmark_gap_pct=excluded.benchmark_gap_pct,
        trending_direction=excluded.trending_direction,
        best_posting_day=excluded.best_posting_day,
        best_posting_hour=excluded.best_posting_hour,
        top_performing_pillar=excluded.top_performing_pillar,
        top_performing_hashtags=excluded.top_performing_hashtags,
        working_hook_patterns=excluded.working_hook_patterns,
        failing_hook_patterns=excluded.failing_hook_patterns,
        hot_streak_count=excluded.hot_streak_count,
        cold_streak_count=excluded.cold_streak_count,
        current_streak_type=excluded.current_streak_type,
        streak_started_at=excluded.streak_started_at,
        calibration_score=excluded.calibration_score,
        self_grade_last_week=excluded.self_grade_last_week,
        season_multiplier=excluded.season_multiplier,
        decay_weighted_avg_views=excluded.decay_weighted_avg_views,
        updated_at=excluded.updated_at`,
    )
    .run(
      merged.pillarEducationAvgViews,
      merged.pillarListingsAvgViews,
      merged.pillarBrandAvgViews,
      merged.overallAvgViews,
      merged.overallAvgEngagementRate,
      merged.benchmarkGapPct,
      merged.trendingDirection,
      merged.bestPostingDay,
      merged.bestPostingHour,
      merged.topPerformingPillar,
      JSON.stringify(merged.topPerformingHashtags),
      JSON.stringify(merged.workingHookPatterns),
      JSON.stringify(merged.failingHookPatterns),
      merged.hotStreakCount,
      merged.coldStreakCount,
      merged.currentStreakType,
      merged.streakStartedAt,
      merged.calibrationScore,
      merged.selfGradeLastWeek,
      merged.seasonMultiplier,
      merged.decayWeightedAvgViews,
      now,
    );
  return merged;
}

export function insertLearningLog(input: {
  cycleType: string;
  date: string;
  insights: string[];
  strategyAdjustments: string[];
  performanceSnapshot: Record<string, unknown>;
  videosAboveBenchmark?: number;
  videosBelowBenchmark?: number;
  phoneNumbersToday?: number;
}): CmLearningLog {
  const id = randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_learning_log
       (id, cycle_type, date, insights, strategy_adjustments, performance_snapshot,
        videos_above_benchmark, videos_below_benchmark, phone_numbers_today, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.cycleType,
      input.date,
      JSON.stringify(input.insights),
      JSON.stringify(input.strategyAdjustments),
      JSON.stringify(input.performanceSnapshot),
      input.videosAboveBenchmark ?? 0,
      input.videosBelowBenchmark ?? 0,
      input.phoneNumbersToday ?? 0,
      now,
    );
  return {
    id,
    cycleType: input.cycleType,
    date: input.date,
    insights: input.insights,
    strategyAdjustments: input.strategyAdjustments,
    performanceSnapshot: input.performanceSnapshot,
    videosAboveBenchmark: input.videosAboveBenchmark ?? 0,
    videosBelowBenchmark: input.videosBelowBenchmark ?? 0,
    phoneNumbersToday: input.phoneNumbersToday ?? 0,
    loggedAt: now,
  };
}

export function listLearningLogs(input?: { limit?: number; days?: number }): CmLearningLog[] {
  const limit = input?.limit ?? 10;
  const database = getContentDb();
  if (input?.days) {
    const since = new Date();
    since.setDate(since.getDate() - input.days);
    const sinceDate = since.toISOString().slice(0, 10);
    const rows = database
      .prepare(
        `SELECT * FROM cm_learning_log WHERE date >= ? ORDER BY logged_at DESC LIMIT ?`,
      )
      .all(sinceDate, limit) as Record<string, unknown>[];
    return rows.map(rowToLearningLog);
  }
  const rows = database
    .prepare(`SELECT * FROM cm_learning_log ORDER BY logged_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToLearningLog);
}

export function getDailyStrategy(date = todayDateCst()): CmDailyStrategy | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_daily_strategy WHERE date = ?`)
    .get(date) as Record<string, unknown> | undefined;
  return row ? rowToDailyStrategy(row) : null;
}

export function upsertDailyStrategy(
  date: string,
  input: Omit<CmDailyStrategy, "date" | "generatedAt" | "lastUpdated"> & {
    generatedAt?: string;
  },
): CmDailyStrategy {
  const existing = getDailyStrategy(date);
  const now = new Date().toISOString();
  const generatedAt = input.generatedAt ?? existing?.generatedAt ?? now;
  getContentDb()
    .prepare(
      `INSERT INTO cm_daily_strategy
       (date, pillar_priority, recommended_hooks, hashtag_set, avoid_angles, platform_distribution,
        reasoning, confidence_score, generated_at, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
        pillar_priority=excluded.pillar_priority,
        recommended_hooks=excluded.recommended_hooks,
        hashtag_set=excluded.hashtag_set,
        avoid_angles=excluded.avoid_angles,
        platform_distribution=excluded.platform_distribution,
        reasoning=excluded.reasoning,
        confidence_score=excluded.confidence_score,
        last_updated=excluded.last_updated`,
    )
    .run(
      date,
      JSON.stringify(input.pillarPriority),
      JSON.stringify(input.recommendedHooks),
      JSON.stringify(input.hashtagSet),
      JSON.stringify(input.avoidAngles),
      JSON.stringify(input.platformDistribution),
      input.reasoning,
      input.confidenceScore,
      generatedAt,
      now,
    );
  return getDailyStrategy(date)!;
}

export function insertBriefing(input: {
  briefingType: string;
  title: string;
  body: string;
  keyMetrics: Record<string, unknown>;
  actionItems: string[];
  sentToHarvey?: boolean;
}): CmBriefing {
  const id = randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_briefings
       (id, briefing_type, title, body, key_metrics, action_items, sent_to_harvey, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.briefingType,
      input.title,
      input.body,
      JSON.stringify(input.keyMetrics),
      JSON.stringify(input.actionItems),
      input.sentToHarvey ? 1 : 0,
      now,
    );
  return {
    id,
    briefingType: input.briefingType,
    title: input.title,
    body: input.body,
    keyMetrics: input.keyMetrics,
    actionItems: input.actionItems,
    sentToHarvey: Boolean(input.sentToHarvey),
    createdAt: now,
  };
}

export function getLatestBriefing(briefingType?: string): CmBriefing | null {
  const row = briefingType
    ? (getContentDb()
        .prepare(
          `SELECT * FROM cm_briefings WHERE briefing_type = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(briefingType) as Record<string, unknown> | undefined)
    : (getContentDb()
        .prepare(`SELECT * FROM cm_briefings ORDER BY created_at DESC LIMIT 1`)
        .get() as Record<string, unknown> | undefined);
  return row ? rowToBriefing(row) : null;
}

export function listBriefings(input?: {
  briefingType?: string;
  limit?: number;
}): CmBriefing[] {
  const limit = input?.limit ?? 10;
  const rows = input?.briefingType
    ? (getContentDb()
        .prepare(
          `SELECT * FROM cm_briefings WHERE briefing_type = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(input.briefingType, limit) as Record<string, unknown>[])
    : (getContentDb()
        .prepare(`SELECT * FROM cm_briefings ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]);
  return rows.map(rowToBriefing);
}

export function insertCutListItem(input: {
  contentAngle: string;
  reason: string;
  avgViewsWhenCut: number;
  timesTested: number;
  flaggedBy?: string;
  benchmarkAtCut?: number;
}): CmCutListItem {
  const id = randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_cut_list
       (id, content_angle, reason, avg_views_when_cut, benchmark_at_cut, times_tested, flagged_by, flagged_at, reinstated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      input.contentAngle,
      input.reason,
      input.avgViewsWhenCut,
      input.benchmarkAtCut ?? CONTENT_BENCHMARK_VIEWS,
      input.timesTested,
      input.flaggedBy ?? "brain",
      now,
    );
  return {
    id,
    contentAngle: input.contentAngle,
    reason: input.reason,
    avgViewsWhenCut: input.avgViewsWhenCut,
    benchmarkAtCut: input.benchmarkAtCut ?? CONTENT_BENCHMARK_VIEWS,
    timesTested: input.timesTested,
    flaggedBy: input.flaggedBy ?? "brain",
    flaggedAt: now,
    reinstated: false,
  };
}

export function listCutList(activeOnly = true): CmCutListItem[] {
  const rows = activeOnly
    ? (getContentDb()
        .prepare(
          `SELECT * FROM cm_cut_list WHERE reinstated = 0 ORDER BY flagged_at DESC`,
        )
        .all() as Record<string, unknown>[])
    : (getContentDb()
        .prepare(`SELECT * FROM cm_cut_list ORDER BY flagged_at DESC`)
        .all() as Record<string, unknown>[]);
  return rows.map(rowToCutList);
}

export function upsertHookLibraryEntry(input: {
  hookText: string;
  contentPillar: string;
  views: number;
  aboveBenchmark: boolean;
}): CmHookLibraryEntry {
  const database = getContentDb();
  const existing = database
    .prepare(`SELECT * FROM cm_hook_library WHERE hook_text = ? AND content_pillar = ?`)
    .get(input.hookText, input.contentPillar) as Record<string, unknown> | undefined;
  const now = new Date().toISOString();
  if (existing) {
    const timesUsed = Number(existing.times_used) + 1;
    const timesAbove = Number(existing.times_above_benchmark) + (input.aboveBenchmark ? 1 : 0);
    const avgViews =
      (Number(existing.avg_views_when_used) * Number(existing.times_used) + input.views) /
      timesUsed;
    const score = timesUsed > 0 ? timesAbove / timesUsed : 0;
    database
      .prepare(
        `UPDATE cm_hook_library SET avg_views_when_used = ?, times_used = ?, times_above_benchmark = ?,
         performance_score = ?, last_used = ? WHERE id = ?`,
      )
      .run(avgViews, timesUsed, timesAbove, score, now, existing.id);
    const row = database
      .prepare(`SELECT * FROM cm_hook_library WHERE id = ?`)
      .get(existing.id) as Record<string, unknown>;
    return rowToHookLibrary(row);
  }
  const id = randomUUID();
  const score = input.aboveBenchmark ? 1 : 0;
  database
    .prepare(
      `INSERT INTO cm_hook_library
       (id, hook_text, content_pillar, avg_views_when_used, times_used, times_above_benchmark,
        performance_score, active, created_at, last_used)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      input.hookText,
      input.contentPillar,
      input.views,
      input.aboveBenchmark ? 1 : 0,
      score,
      now,
      now,
    );
  return rowToHookLibrary(
    database.prepare(`SELECT * FROM cm_hook_library WHERE id = ?`).get(id) as Record<string, unknown>,
  );
}

export function listHookLibrary(input?: {
  minUses?: number;
  limit?: number;
  order?: "asc" | "desc";
}): CmHookLibraryEntry[] {
  const minUses = input?.minUses ?? 1;
  const limit = input?.limit ?? 20;
  const order = input?.order === "asc" ? "ASC" : "DESC";
  const rows = getContentDb()
    .prepare(
      `SELECT * FROM cm_hook_library WHERE active = 1 AND times_used >= ?
       ORDER BY performance_score ${order} LIMIT ?`,
    )
    .all(minUses, limit) as Record<string, unknown>[];
  return rows.map(rowToHookLibrary);
}

export function upsertHashtagPerformance(input: {
  hashtag: string;
  views: number;
  aboveBenchmark: boolean;
}): void {
  const database = getContentDb();
  const tag = input.hashtag.replace(/^#/, "").toLowerCase();
  const existing = database
    .prepare(`SELECT * FROM cm_hashtag_performance WHERE hashtag = ?`)
    .get(tag) as Record<string, unknown> | undefined;
  const now = new Date().toISOString();
  if (existing) {
    const timesUsed = Number(existing.times_used) + 1;
    const timesAbove = Number(existing.times_above_benchmark) + (input.aboveBenchmark ? 1 : 0);
    const avgViews =
      (Number(existing.avg_views) * Number(existing.times_used) + input.views) / timesUsed;
    const score = timesUsed > 0 ? timesAbove / timesUsed : 0;
    database
      .prepare(
        `UPDATE cm_hashtag_performance SET avg_views = ?, times_used = ?, times_above_benchmark = ?,
         performance_score = ?, last_seen_at = ? WHERE hashtag = ?`,
      )
      .run(avgViews, timesUsed, timesAbove, score, now, tag);
  } else {
    database
      .prepare(
        `INSERT INTO cm_hashtag_performance
         (hashtag, avg_views, times_used, times_above_benchmark, performance_score, last_seen_at, active)
         VALUES (?, ?, 1, ?, ?, ?, 1)`,
      )
      .run(tag, input.views, input.aboveBenchmark ? 1 : 0, input.aboveBenchmark ? 1 : 0, now);
  }
}

export function listHashtagPerformance(limit = 10): Array<{
  hashtag: string;
  avgViews: number;
  timesUsed: number;
  timesAboveBenchmark: number;
  performanceScore: number;
}> {
  const rows = getContentDb()
    .prepare(
      `SELECT * FROM cm_hashtag_performance WHERE active = 1 ORDER BY performance_score DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    hashtag: String(r.hashtag),
    avgViews: Number(r.avg_views) || 0,
    timesUsed: Number(r.times_used) || 0,
    timesAboveBenchmark: Number(r.times_above_benchmark) || 0,
    performanceScore: Number(r.performance_score) || 0,
  }));
}

export function upsertPostingTimeMatrix(input: {
  publishedAt: string;
  views: number;
}): void {
  const d = new Date(input.publishedAt);
  const day = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Chicago" });
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      hour12: false,
    }).format(d),
  );
  const database = getContentDb();
  const existing = database
    .prepare(`SELECT * FROM cm_posting_time_matrix WHERE day_of_week = ? AND hour_of_day = ?`)
    .get(day, hour) as Record<string, unknown> | undefined;
  if (existing) {
    const sampleCount = Number(existing.sample_count) + 1;
    const avgViews =
      (Number(existing.avg_views) * Number(existing.sample_count) + input.views) / sampleCount;
    database
      .prepare(
        `UPDATE cm_posting_time_matrix SET avg_views = ?, sample_count = ? WHERE day_of_week = ? AND hour_of_day = ?`,
      )
      .run(avgViews, sampleCount, day, hour);
  } else {
    database
      .prepare(
        `INSERT INTO cm_posting_time_matrix (day_of_week, hour_of_day, avg_views, sample_count)
         VALUES (?, ?, ?, 1)`,
      )
      .run(day, hour, input.views);
  }
}

export function getBestPostingSlot(): { day: string; hour: number; avgViews: number } | null {
  const row = getContentDb()
    .prepare(
      `SELECT day_of_week, hour_of_day, avg_views FROM cm_posting_time_matrix
       WHERE sample_count >= 1 ORDER BY avg_views DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    day: String(row.day_of_week),
    hour: Number(row.hour_of_day),
    avgViews: Number(row.avg_views) || 0,
  };
}

export function getOldestPendingReview(): ContentVideo | null {
  const row = getContentDb()
    .prepare(
      `SELECT * FROM content_videos WHERE status = 'pending_review' ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return row ? rowToVideo(row) : null;
}

export function listPerformanceWithVideosSince(hoursAgo: number): Array<{
  video: ContentVideo;
  performance: ContentPerformance;
}> {
  const since = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  const rows = getContentDb()
    .prepare(
      `SELECT v.*, p.id AS perf_id, p.platform_post_id, p.platform AS perf_platform, p.views, p.likes,
              p.comments AS perf_comments, p.shares, p.saves, p.dms_generated, p.phone_numbers_captured,
              p.score, p.tier, p.benchmark_met, p.pulled_at
       FROM content_performance p
       JOIN content_videos v ON v.id = p.video_id
       WHERE p.pulled_at >= ?
       ORDER BY p.pulled_at DESC`,
    )
    .all(since) as Record<string, unknown>[];
  return rows.map((row) => ({
    video: rowToVideo(row),
    performance: {
      id: String(row.perf_id),
      videoId: String(row.id),
      platformPostId: row.platform_post_id ? String(row.platform_post_id) : null,
      platform: String(row.perf_platform),
      views: Number(row.views) || 0,
      likes: Number(row.likes) || 0,
      comments: Number(row.perf_comments) || 0,
      shares: Number(row.shares) || 0,
      saves: Number(row.saves) || 0,
      dmsGenerated: Number(row.dms_generated) || 0,
      phoneNumbersCaptured: Number(row.phone_numbers_captured) || 0,
      score: Number(row.score) || 0,
      tier: row.tier as PerformanceTier,
      benchmarkMet: row.benchmark_met === 1,
      pulledAt: String(row.pulled_at),
    },
  }));
}

export function listPerformanceDataForDays(days: number): Array<{
  videoId: string;
  captionPreview: string;
  pillar: string;
  platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  score: number;
  tier: string;
  benchmarkMet: boolean;
  publishedAt: string | null;
  pulledAt: string | null;
  date: string;
}> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString();
  const rows = getContentDb()
    .prepare(
      `SELECT v.id, v.caption, v.pillar, v.platform_target, v.published_at,
              p.views, p.likes, p.comments, p.shares, p.score, p.tier, p.benchmark_met, p.pulled_at
       FROM content_videos v
       LEFT JOIN (
         SELECT video_id, MAX(pulled_at) AS max_pulled FROM content_performance GROUP BY video_id
       ) latest ON v.id = latest.video_id
       LEFT JOIN content_performance p ON p.video_id = latest.video_id AND p.pulled_at = latest.max_pulled
       WHERE COALESCE(p.pulled_at, v.created_at) >= ?
       ORDER BY COALESCE(p.pulled_at, v.created_at) DESC`,
    )
    .all(sinceIso) as Record<string, unknown>[];
  return rows.map((row) => ({
    videoId: String(row.id),
    captionPreview: String(row.caption).slice(0, 60),
    pillar: String(row.pillar),
    platform: String(row.platform_target),
    views: Number(row.views) || 0,
    likes: Number(row.likes) || 0,
    comments: Number(row.comments) || 0,
    shares: Number(row.shares) || 0,
    score: Number(row.score) || 0,
    tier: String(row.tier || "cold"),
    benchmarkMet: row.benchmark_met === 1,
    publishedAt: row.published_at ? String(row.published_at) : null,
    pulledAt: row.pulled_at ? String(row.pulled_at) : null,
    date: (row.pulled_at ? String(row.pulled_at) : String(row.published_at ?? "")).slice(0, 10),
  }));
}

export function computeBenchmarkTrajectory(): {
  weeks: Array<{ week: string; avgViews: number; videosCount: number }>;
  trajectory: "improving" | "declining" | "flat";
  weeklyChangePct: number;
  currentVsBenchmark: number;
  daysToBenchmark: number | null;
} {
  const rows = getContentDb()
    .prepare(
      `SELECT date(p.pulled_at) AS d, AVG(p.views) AS avg_views, COUNT(*) AS c
       FROM content_performance p
       WHERE p.pulled_at >= date('now', '-30 days')
       GROUP BY strftime('%Y-W%W', p.pulled_at)
       ORDER BY d ASC`,
    )
    .all() as Array<{ d: string; avg_views: number; c: number }>;

  const weeks = rows.map((r, i) => ({
    week: `W${i + 1}`,
    avgViews: Math.round(Number(r.avg_views) || 0),
    videosCount: Number(r.c) || 0,
  }));

  let trajectory: "improving" | "declining" | "flat" = "flat";
  let weeklyChangePct = 0;
  if (weeks.length >= 2) {
    const prev = weeks[weeks.length - 2].avgViews;
    const curr = weeks[weeks.length - 1].avgViews;
    if (prev > 0) weeklyChangePct = ((curr - prev) / prev) * 100;
    if (weeklyChangePct > 2) trajectory = "improving";
    else if (weeklyChangePct < -2) trajectory = "declining";
  }

  const overall =
    weeks.length > 0 ? weeks.reduce((s, w) => s + w.avgViews, 0) / weeks.length : 0;
  const currentVsBenchmark = overall > 0 ? ((overall - CONTENT_BENCHMARK_VIEWS) / CONTENT_BENCHMARK_VIEWS) * 100 : -100;

  let daysToBenchmark: number | null = null;
  if (trajectory === "improving" && weeks.length >= 2 && overall < CONTENT_BENCHMARK_VIEWS) {
    const dailyGain = (weeks[weeks.length - 1].avgViews - weeks[0].avgViews) / (weeks.length * 7);
    if (dailyGain > 0) daysToBenchmark = Math.ceil((CONTENT_BENCHMARK_VIEWS - overall) / dailyGain);
  }

  return { weeks, trajectory, weeklyChangePct, currentVsBenchmark, daysToBenchmark };
}

export function recalculatePerformanceModelFromData(): CmPerformanceModel {
  const videoRows = getContentDb()
    .prepare(
      `SELECT v.pillar, p.views, v.published_at,
              (p.likes + p.comments + p.shares + p.saves) AS eng
       FROM content_videos v
       JOIN content_performance p ON p.video_id = v.id
       WHERE p.views > 0`,
    )
    .all() as Array<{
    pillar: string;
    views: number;
    published_at: string | null;
    eng: number;
  }>;

  const decayWeight = (publishedAt: string | null): number => {
    if (!publishedAt) return 0.1;
    const days = Math.max(0, Math.floor((Date.now() - new Date(publishedAt).getTime()) / 86400000));
    if (days <= 7) return 1;
    if (days <= 30) return 0.6;
    if (days <= 60) return 0.3;
    return 0.1;
  };

  const weightedAvg = (rows: Array<{ views: number; published_at: string | null }>): number => {
    let wSum = 0;
    let wTotal = 0;
    for (const r of rows) {
      const w = decayWeight(r.published_at);
      wSum += Number(r.views) * w;
      wTotal += w;
    }
    return wTotal > 0 ? wSum / wTotal : 0;
  };

  const weightedEng = (
    rows: Array<{ views: number; published_at: string | null; eng: number }>,
  ): number => {
    let wSum = 0;
    let wTotal = 0;
    for (const r of rows) {
      const v = Number(r.views) || 0;
      if (v <= 0) continue;
      const w = decayWeight(r.published_at);
      wSum += (Number(r.eng) / v) * w;
      wTotal += w;
    }
    return wTotal > 0 ? wSum / wTotal : 0;
  };

  const pillarGroups: Record<string, Array<{ views: number; published_at: string | null }>> = {};
  for (const r of videoRows) {
    const p = r.pillar || "brand";
    (pillarGroups[p] ??= []).push({ views: Number(r.views) || 0, published_at: r.published_at });
  }

  const pillarMap: Record<string, number> = {};
  for (const [pillar, rows] of Object.entries(pillarGroups)) {
    pillarMap[pillar] = weightedAvg(rows);
  }

  const overallAvg =
    videoRows.length > 0
      ? videoRows.reduce((s, r) => s + (Number(r.views) || 0), 0) / videoRows.length
      : 0;
  const decayWeightedOverall = weightedAvg(
    videoRows.map((r) => ({ views: Number(r.views) || 0, published_at: r.published_at })),
  );
  const overallEng = weightedEng(
    videoRows.map((r) => ({
      views: Number(r.views) || 0,
      published_at: r.published_at,
      eng: Number(r.eng) || 0,
    })),
  );

  const benchmarkGap =
    overallAvg > 0 ? ((overallAvg - CONTENT_BENCHMARK_VIEWS) / CONTENT_BENCHMARK_VIEWS) * 100 : -100;

  const recentRows = getContentDb()
    .prepare(
      `SELECT p.views, v.published_at FROM content_performance p
       JOIN content_videos v ON v.id = p.video_id
       WHERE p.pulled_at >= date('now', '-7 days')`,
    )
    .all() as Array<{ views: number; published_at: string | null }>;
  const priorRows = getContentDb()
    .prepare(
      `SELECT p.views, v.published_at FROM content_performance p
       JOIN content_videos v ON v.id = p.video_id
       WHERE p.pulled_at >= date('now', '-14 days') AND p.pulled_at < date('now', '-7 days')`,
    )
    .all() as Array<{ views: number; published_at: string | null }>;
  const l7 = weightedAvg(recentRows);
  const p7 = weightedAvg(priorRows);
  let trending: "up" | "down" | "flat" = "flat";
  if (l7 > p7 * 1.02) trending = "up";
  else if (l7 < p7 * 0.98) trending = "down";

  const bestSlot = getBestPostingSlot();
  const topPillar = Object.entries(pillarMap).sort((a, b) => b[1] - a[1])[0];
  const topHashtags = listHashtagPerformance(5).map((h) => h.hashtag);
  const workingHooks = listHookLibrary({ minUses: 1, limit: 5, order: "desc" }).map((h) => h.hookText);
  const failingHooks = listHookLibrary({ minUses: 3, limit: 5, order: "asc" }).map((h) => h.hookText);
  const existing = getPerformanceModel();

  return upsertPerformanceModel({
    pillarEducationAvgViews: pillarMap.education ?? 0,
    pillarListingsAvgViews: pillarMap.listings ?? 0,
    pillarBrandAvgViews: pillarMap.brand ?? 0,
    overallAvgViews: overallAvg,
    overallAvgEngagementRate: overallEng,
    benchmarkGapPct: benchmarkGap,
    trendingDirection: trending,
    bestPostingDay: bestSlot?.day ?? null,
    bestPostingHour: bestSlot?.hour ?? null,
    topPerformingPillar: topPillar?.[0] ?? null,
    topPerformingHashtags: topHashtags,
    workingHookPatterns: workingHooks,
    failingHookPatterns: failingHooks,
    decayWeightedAvgViews: decayWeightedOverall,
    hotStreakCount: existing.hotStreakCount,
    coldStreakCount: existing.coldStreakCount,
    currentStreakType: existing.currentStreakType,
    streakStartedAt: existing.streakStartedAt,
    calibrationScore: existing.calibrationScore,
    selfGradeLastWeek: existing.selfGradeLastWeek,
    seasonMultiplier: existing.seasonMultiplier,
  });
}

export function countLearningLogEventsToday(): number {
  const today = todayDateCst();
  const row = getContentDb()
    .prepare(`SELECT COUNT(*) AS c FROM cm_learning_log WHERE date = ?`)
    .get(today) as { c: number };
  return Number(row.c) || 0;
}

// ─── Brain intelligence tables ───────────────────────────────────────────────

function rowToCombinationPattern(row: Record<string, unknown>): CmCombinationPattern {
  return {
    id: String(row.id),
    pillar: String(row.pillar),
    hookType: String(row.hook_type),
    postingDay: String(row.posting_day),
    postingHourBucket: String(row.posting_hour_bucket),
    captionLengthBucket: String(row.caption_length_bucket),
    sampleCount: Number(row.sample_count) || 0,
    avgViews: Number(row.avg_views) || 0,
    avgEngagementRate: Number(row.avg_engagement_rate) || 0,
    aboveBenchmarkCount: Number(row.above_benchmark_count) || 0,
    performanceScore: Number(row.performance_score) || 0,
    lastUpdated: String(row.last_updated),
  };
}

function rowToExperiment(row: Record<string, unknown>): CmExperiment {
  return {
    id: String(row.id),
    weekStart: String(row.week_start),
    hypothesis: String(row.hypothesis),
    variableTested: String(row.variable_tested),
    controlDescription: String(row.control_description),
    testDescription: String(row.test_description),
    controlVideoIds: String(row.control_video_ids ?? "[]"),
    testVideoIds: String(row.test_video_ids ?? "[]"),
    controlAvgViews: Number(row.control_avg_views) || 0,
    testAvgViews: Number(row.test_avg_views) || 0,
    status: String(row.status),
    result: row.result ? String(row.result) : null,
    conclusion: row.conclusion ? String(row.conclusion) : null,
    proposedBy: String(row.proposed_by ?? "brain"),
    evaluatedAt: row.evaluated_at ? String(row.evaluated_at) : null,
    createdAt: String(row.created_at),
  };
}

function rowToChatSession(row: Record<string, unknown>): CmChatSession {
  return {
    id: String(row.id),
    startedAt: String(row.started_at),
    lastMessageAt: String(row.last_message_at),
    messageCount: Number(row.message_count) || 0,
    sessionSummary: row.session_summary ? String(row.session_summary) : null,
    expiresAt: String(row.expires_at),
  };
}

function rowToChatMessage(row: Record<string, unknown>): CmChatMessage {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content),
    performanceContext: row.performance_context
      ? parseJson<Record<string, unknown>>(String(row.performance_context), {})
      : null,
    createdAt: String(row.created_at),
  };
}

function rowToStrategyAccuracy(row: Record<string, unknown>): CmStrategyAccuracy {
  return {
    id: String(row.id),
    strategyDate: String(row.strategy_date),
    recommendedTopPillar: row.recommended_top_pillar ? String(row.recommended_top_pillar) : null,
    actualTopPillar: row.actual_top_pillar ? String(row.actual_top_pillar) : null,
    recommendedHooks: parseJson<string[]>(String(row.recommended_hooks ?? "[]"), []),
    hooksThatBeatBenchmark: parseJson<string[]>(String(row.hooks_that_beat_benchmark ?? "[]"), []),
    confidenceScoreGiven: Number(row.confidence_score_given) || 0,
    outcomeScore: Number(row.outcome_score) || 0,
    pillarPredictionCorrect: Number(row.pillar_prediction_correct) === 1,
    hooksHitRate: Number(row.hooks_hit_rate) || 0,
    overallGrade: String(row.overall_grade ?? "F"),
    evaluatedAt: String(row.evaluated_at),
  };
}

function rowToSelfEvaluation(row: Record<string, unknown>): CmSelfEvaluation {
  return {
    id: String(row.id),
    weekStart: String(row.week_start),
    strategiesFollowed: Number(row.strategies_followed) || 0,
    strategiesIgnored: Number(row.strategies_ignored) || 0,
    avgOutcomeScore: Number(row.avg_outcome_score) || 0,
    whatWorked: String(row.what_worked),
    whatFailed: String(row.what_failed),
    oneChange: String(row.one_change),
    calibrationScore: row.calibration_score != null ? Number(row.calibration_score) : null,
    benchmarkAssessment: row.benchmark_assessment ? String(row.benchmark_assessment) : null,
    createdAt: String(row.created_at),
  };
}

function rowToSeasonalWeek(row: Record<string, unknown>): CmSeasonalWeek {
  return {
    weekNumber: Number(row.week_number),
    historicalAvgViews: Number(row.historical_avg_views) || 0,
    historicalAvgDms: Number(row.historical_avg_dms) || 0,
    sampleYears: Number(row.sample_years) || 0,
    performanceMultiplier: Number(row.performance_multiplier) || 1,
    seasonLabel: row.season_label ? String(row.season_label) : null,
    notes: row.notes ? String(row.notes) : null,
    lastUpdated: row.last_updated ? String(row.last_updated) : null,
  };
}

export function listRecentPerformancePulls(
  limit: number,
): Array<{ videoId: string; views: number; pulledAt: string }> {
  const rows = getContentDb()
    .prepare(
      `SELECT p.video_id, p.views, p.pulled_at
       FROM content_performance p
       ORDER BY p.pulled_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ video_id: string; views: number; pulled_at: string }>;
  return rows.map((r) => ({
    videoId: r.video_id,
    views: Number(r.views) || 0,
    pulledAt: r.pulled_at,
  }));
}

export function listVideosForPatternAnalysis(): Array<{
  pillar: string;
  hook: string;
  hookType: string | null;
  caption: string;
  views: number;
  publishedAt: string | null;
}> {
  const rows = getContentDb()
    .prepare(
      `SELECT v.pillar, v.hook, v.caption, v.published_at, p.views, h.hook_type
       FROM content_videos v
       JOIN content_performance p ON p.video_id = v.id
       LEFT JOIN cm_hook_library h ON h.hook_text = v.hook
       WHERE p.views > 0 AND v.published_at IS NOT NULL`,
    )
    .all() as Array<{
    pillar: string;
    hook: string;
    caption: string;
    published_at: string;
    views: number;
    hook_type: string | null;
  }>;
  return rows.map((r) => ({
    pillar: r.pillar,
    hook: r.hook || "",
    hookType: r.hook_type,
    caption: r.caption || "",
    views: Number(r.views) || 0,
    publishedAt: r.published_at,
  }));
}

export function listCombinationPatterns(opts: {
  pillar?: string;
  minSamples?: number;
  limit?: number;
  order?: "asc" | "desc";
}): CmCombinationPattern[] {
  const minSamples = opts.minSamples ?? 2;
  const limit = opts.limit ?? 20;
  const order = opts.order === "asc" ? "ASC" : "DESC";
  let sql = `SELECT * FROM cm_combination_patterns WHERE sample_count >= ?`;
  const params: unknown[] = [minSamples];
  if (opts.pillar) {
    sql += ` AND pillar = ?`;
    params.push(opts.pillar);
  }
  sql += ` ORDER BY performance_score ${order} LIMIT ?`;
  params.push(limit);
  const rows = getContentDb()
    .prepare(sql)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToCombinationPattern);
}

export function upsertCombinationPattern(patch: {
  pillar: string;
  hookType: string;
  postingDay: string;
  postingHourBucket: string;
  captionLengthBucket: string;
  sampleCount: number;
  avgViews: number;
  avgEngagementRate: number;
  aboveBenchmarkCount: number;
}): CmCombinationPattern {
  const id = `${patch.pillar}|${patch.hookType}|${patch.postingDay}|${patch.postingHourBucket}|${patch.captionLengthBucket}`;
  const now = new Date().toISOString();
  const performanceScore =
    patch.sampleCount > 0 ? patch.aboveBenchmarkCount / patch.sampleCount : 0;
  getContentDb()
    .prepare(
      `INSERT INTO cm_combination_patterns
       (id, pillar, hook_type, posting_day, posting_hour_bucket, caption_length_bucket,
        sample_count, avg_views, avg_engagement_rate, above_benchmark_count, performance_score, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        sample_count=excluded.sample_count,
        avg_views=excluded.avg_views,
        avg_engagement_rate=excluded.avg_engagement_rate,
        above_benchmark_count=excluded.above_benchmark_count,
        performance_score=excluded.performance_score,
        last_updated=excluded.last_updated`,
    )
    .run(
      id,
      patch.pillar,
      patch.hookType,
      patch.postingDay,
      patch.postingHourBucket,
      patch.captionLengthBucket,
      patch.sampleCount,
      patch.avgViews,
      patch.avgEngagementRate,
      patch.aboveBenchmarkCount,
      performanceScore,
      now,
    );
  return rowToCombinationPattern(
    getContentDb().prepare(`SELECT * FROM cm_combination_patterns WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >,
  );
}

export function getActiveExperiment(): CmExperiment | null {
  const row = getContentDb()
    .prepare(
      `SELECT * FROM cm_experiments
       WHERE status IN ('proposed', 'running')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return row ? rowToExperiment(row) : null;
}

export function getExperimentForWeek(weekStart: string): CmExperiment | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_experiments WHERE week_start = ? ORDER BY created_at DESC LIMIT 1`)
    .get(weekStart) as Record<string, unknown> | undefined;
  return row ? rowToExperiment(row) : null;
}

export function insertExperiment(patch: {
  weekStart: string;
  hypothesis: string;
  variableTested: string;
  controlDescription: string;
  testDescription: string;
  status?: string;
}): CmExperiment {
  const id = randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_experiments
       (id, week_start, hypothesis, variable_tested, control_description, test_description,
        control_video_ids, test_video_ids, status, proposed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, 'brain', ?)`,
    )
    .run(
      id,
      patch.weekStart,
      patch.hypothesis,
      patch.variableTested,
      patch.controlDescription,
      patch.testDescription,
      patch.status ?? "proposed",
      now,
    );
  return rowToExperiment(
    getContentDb().prepare(`SELECT * FROM cm_experiments WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >,
  );
}

export function listExperiments(limit = 50): CmExperiment[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_experiments ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToExperiment);
}

export function updateExperiment(
  id: string,
  patch: Partial<{
    controlVideoIds: string[];
    testVideoIds: string[];
    controlAvgViews: number;
    testAvgViews: number;
    status: string;
    result: string;
    conclusion: string;
    evaluatedAt: string;
  }>,
): void {
  const existing = getContentDb()
    .prepare(`SELECT * FROM cm_experiments WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!existing) return;
  const controlIds = patch.controlVideoIds
    ? JSON.stringify(patch.controlVideoIds)
    : String(existing.control_video_ids);
  const testIds = patch.testVideoIds
    ? JSON.stringify(patch.testVideoIds)
    : String(existing.test_video_ids);
  getContentDb()
    .prepare(
      `UPDATE cm_experiments SET
        control_video_ids = ?,
        test_video_ids = ?,
        control_avg_views = COALESCE(?, control_avg_views),
        test_avg_views = COALESCE(?, test_avg_views),
        status = COALESCE(?, status),
        result = COALESCE(?, result),
        conclusion = COALESCE(?, conclusion),
        evaluated_at = COALESCE(?, evaluated_at)
       WHERE id = ?`,
    )
    .run(
      controlIds,
      testIds,
      patch.controlAvgViews ?? null,
      patch.testAvgViews ?? null,
      patch.status ?? null,
      patch.result ?? null,
      patch.conclusion ?? null,
      patch.evaluatedAt ?? null,
      id,
    );
}

export function assignVideoToExperiment(videoId: string): void {
  const exp = getActiveExperiment();
  if (!exp || (exp.status !== "proposed" && exp.status !== "running")) return;
  const controlIds: string[] = JSON.parse(exp.controlVideoIds || "[]");
  const testIds: string[] = JSON.parse(exp.testVideoIds || "[]");
  if (controlIds.includes(videoId) || testIds.includes(videoId)) return;
  if (controlIds.length <= testIds.length) controlIds.push(videoId);
  else testIds.push(videoId);
  updateExperiment(exp.id, {
    controlVideoIds: controlIds,
    testVideoIds: testIds,
    status: "running",
  });
}

export function getVideoPerformanceAvg(videoIds: string[]): number {
  if (videoIds.length === 0) return 0;
  const placeholders = videoIds.map(() => "?").join(",");
  const row = getContentDb()
    .prepare(
      `SELECT AVG(views) AS avg FROM content_performance WHERE video_id IN (${placeholders})`,
    )
    .get(...videoIds) as { avg: number };
  return Number(row?.avg) || 0;
}

export function insertStrategyAccuracy(
  patch: Omit<CmStrategyAccuracy, "id"> & { id?: string },
): CmStrategyAccuracy {
  const id = patch.id ?? randomUUID();
  const now = patch.evaluatedAt || new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_strategy_accuracy
       (id, strategy_date, recommended_top_pillar, actual_top_pillar, recommended_hooks,
        hooks_that_beat_benchmark, confidence_score_given, outcome_score, pillar_prediction_correct,
        hooks_hit_rate, overall_grade, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      patch.strategyDate,
      patch.recommendedTopPillar,
      patch.actualTopPillar,
      JSON.stringify(patch.recommendedHooks),
      JSON.stringify(patch.hooksThatBeatBenchmark),
      patch.confidenceScoreGiven,
      patch.outcomeScore,
      patch.pillarPredictionCorrect ? 1 : 0,
      patch.hooksHitRate,
      patch.overallGrade,
      now,
    );
  return rowToStrategyAccuracy(
    getContentDb().prepare(`SELECT * FROM cm_strategy_accuracy WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >,
  );
}

export function listStrategyAccuracy(limit = 14): CmStrategyAccuracy[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_strategy_accuracy ORDER BY strategy_date DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToStrategyAccuracy);
}

export function listVideosPublishedOnDate(
  date: string,
): Array<{ pillar: string; hook: string; views: number }> {
  const rows = getContentDb()
    .prepare(
      `SELECT v.pillar, v.hook, p.views
       FROM content_videos v
       JOIN content_performance p ON p.video_id = v.id
       WHERE v.published_at LIKE ?`,
    )
    .all(`${date}%`) as Array<{ pillar: string; hook: string; views: number }>;
  return rows.map((r) => ({
    pillar: r.pillar,
    hook: r.hook || "",
    views: Number(r.views) || 0,
  }));
}

export function countVideosPublishedOnDate(date: string): number {
  const row = getContentDb()
    .prepare(`SELECT COUNT(*) AS c FROM content_videos WHERE published_at LIKE ?`)
    .get(`${date}%`) as { c: number };
  return Number(row.c) || 0;
}

export function createChatSession(): CmChatSession {
  const id = randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_chat_sessions (id, started_at, last_message_at, message_count, expires_at)
       VALUES (?, ?, ?, 0, ?)`,
    )
    .run(id, nowIso, nowIso, expires);
  return rowToChatSession(
    getContentDb().prepare(`SELECT * FROM cm_chat_sessions WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >,
  );
}

export function getChatSession(sessionId: string): CmChatSession | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_chat_sessions WHERE id = ?`)
    .get(sessionId) as Record<string, unknown> | undefined;
  return row ? rowToChatSession(row) : null;
}

export function listActiveChatSessions(limit = 10): CmChatSession[] {
  const now = new Date().toISOString();
  const rows = getContentDb()
    .prepare(
      `SELECT * FROM cm_chat_sessions WHERE expires_at > ?
       ORDER BY last_message_at DESC LIMIT ?`,
    )
    .all(now, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToChatSession);
}

export function listChatMessages(sessionId: string): CmChatMessage[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_chat_messages WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(rowToChatMessage);
}

export function insertChatMessage(patch: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  performanceContext?: Record<string, unknown> | null;
}): CmChatMessage {
  const id = randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_chat_messages (id, session_id, role, content, performance_context, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      patch.sessionId,
      patch.role,
      patch.content,
      patch.performanceContext ? JSON.stringify(patch.performanceContext) : null,
      now,
    );
  getContentDb()
    .prepare(
      `UPDATE cm_chat_sessions SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?`,
    )
    .run(now, patch.sessionId);
  return rowToChatMessage(
    getContentDb().prepare(`SELECT * FROM cm_chat_messages WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >,
  );
}

export function updateChatSessionSummary(sessionId: string, summary: string): void {
  getContentDb()
    .prepare(`UPDATE cm_chat_sessions SET session_summary = ? WHERE id = ?`)
    .run(summary, sessionId);
}

/**
 * Clear a general "Ask the Content Manager" chat session — deletes its messages
 * and the session row. Only touches cm_chat_* (the general brain chat); the
 * per-clip edit chat lives in the separate cm_clip_chat table and is untouched.
 */
export function deleteChatSession(sessionId: string): void {
  const db = getContentDb();
  db.prepare(`DELETE FROM cm_chat_messages WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM cm_chat_sessions WHERE id = ?`).run(sessionId);
}

export function insertSelfEvaluation(
  patch: Omit<CmSelfEvaluation, "id" | "createdAt"> & { id?: string },
): CmSelfEvaluation {
  const id = patch.id ?? randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_self_evaluation
       (id, week_start, strategies_followed, strategies_ignored, avg_outcome_score,
        what_worked, what_failed, one_change, calibration_score, benchmark_assessment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      patch.weekStart,
      patch.strategiesFollowed,
      patch.strategiesIgnored,
      patch.avgOutcomeScore,
      patch.whatWorked,
      patch.whatFailed,
      patch.oneChange,
      patch.calibrationScore,
      patch.benchmarkAssessment,
      now,
    );
  return rowToSelfEvaluation(
    getContentDb().prepare(`SELECT * FROM cm_self_evaluation WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >,
  );
}

export function listSelfEvaluations(limit = 4): CmSelfEvaluation[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_self_evaluation ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToSelfEvaluation);
}

export function getSeasonalWeek(weekNumber: number): CmSeasonalWeek | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_seasonal_model WHERE week_number = ?`)
    .get(weekNumber) as Record<string, unknown> | undefined;
  return row ? rowToSeasonalWeek(row) : null;
}

export function upsertSeasonalWeek(patch: {
  weekNumber: number;
  historicalAvgViews: number;
  historicalAvgDms?: number;
  sampleYears?: number;
  performanceMultiplier: number;
  seasonLabel: string;
}): void {
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_seasonal_model
       (week_number, historical_avg_views, historical_avg_dms, sample_years, performance_multiplier, season_label, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_number) DO UPDATE SET
        historical_avg_views=excluded.historical_avg_views,
        performance_multiplier=excluded.performance_multiplier,
        season_label=excluded.season_label,
        last_updated=excluded.last_updated`,
    )
    .run(
      patch.weekNumber,
      patch.historicalAvgViews,
      patch.historicalAvgDms ?? 0,
      patch.sampleYears ?? 1,
      patch.performanceMultiplier,
      patch.seasonLabel,
      now,
    );
}

export function listVideosForWeekNumber(weekNumber: number): Array<{ views: number }> {
  const rows = getContentDb()
    .prepare(
      `SELECT p.views, v.published_at FROM content_videos v
       JOIN content_performance p ON p.video_id = v.id
       WHERE v.published_at IS NOT NULL AND p.views > 0`,
    )
    .all() as Array<{ views: number; published_at: string }>;
  const filtered = rows.filter((r) => {
    const d = new Date(r.published_at);
    const jan1 = new Date(Date.UTC(d.getFullYear(), 0, 1));
    const wk = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7);
    return wk === weekNumber;
  });
  return filtered.map((r) => ({ views: Number(r.views) || 0 }));
}

export function seasonLabelForWeek(weekNumber: number): string {
  if (weekNumber <= 10) return "buyer_peak_spring_approach";
  if (weekNumber <= 20) return "buyer_peak";
  if (weekNumber <= 35) return "summer_slowdown";
  if (weekNumber <= 43) return "buyer_peak_fall";
  return "holiday_slow";
}

/* ── Batch pipeline tables ── */

export type BatchSessionStatus =
  | "uploading"
  | "analyzing_trends"
  | "processing_opus"
  | "transcribing"
  | "analyzing"
  | "reframing"
  | "enhancing"
  | "complete"
  | "failed";

export interface CmBatchSession {
  id: string;
  sessionName: string | null;
  pillar: string;
  filmedBy: string;
  targetClipCount: number | null;
  status: BatchSessionStatus;
  sourceFileCount: number;
  clipsGenerated: number;
  trendBriefId: string | null;
  createdAt: string;
  completedAt: string | null;
  notes: string | null;
  userContext: string | null;
  scriptText: string | null;
  /** Per-batch video-enhancement toggles; null = use server defaults. */
  enhanceOptions: CmEnhanceOptions | null;
}

export interface CmEnhanceOptions {
  captions?: boolean;
  autoZoom?: boolean;
  broll?: boolean;
}

export interface CmBatchSourceFile {
  id: string;
  batchSessionId: string;
  originalFilename: string;
  fileSizeBytes: number;
  filePath: string;
  durationSeconds: number | null;
  opusJobId: string | null;
  opusStatus: string;
  clipsGeneratedCount: number;
  uploadedAt: string;
  opusSubmittedAt: string | null;
  opusCompletedAt: string | null;
  errorMessage: string | null;
}

export interface CmCompetitorProfile {
  id: string;
  tiktokHandle: string;
  displayName: string;
  profileType: string;
  active: boolean;
  lastScrapedAt: string | null;
  addedAt: string;
}

export interface CmCompetitorTrends {
  id: string;
  scrapedAt: string;
  profilesScraped: string[];
  rawVideoCount: number;
  topHooks: string[];
  trendingHashtags: string[];
  topPerformingDurations: Record<string, number>;
  bestDurationRange: string;
  topContentThemes: string[];
  trendBrief: string;
  expiresAt: string;
}

export interface CmCompetitiveAnalysis {
  id: string;
  analyzedAt: string;
  weekStart: string;
  profilesAnalyzed: string[];
  marcoAvgViews: number;
  marcoAvgEngagementRate: number;
  competitorAvgViews: number;
  competitorAvgEngagementRate: number;
  marcoVsFieldPct: number;
  topCompetitorHandle: string;
  topCompetitorAvgViews: number;
  marcoStrengths: string[];
  marcoGaps: string[];
  topCompetitorThemes: string[];
  fullAnalysisMarkdown: string;
  createdAt: string;
}

export interface CmStrategyRecommendation {
  id: string;
  analysisId: string;
  priority: number;
  recommendation: string;
  dataBacking: string;
  pillar: string | null;
  hookType: string | null;
  exampleFromCompetitor: string | null;
  expectedImpact: string | null;
  status: string;
  dismissedReason: string | null;
  createdAt: string;
  actedOnAt: string | null;
}

export interface CmRecordingTask {
  id: string;
  dueDate: string;
  pillar: string | null;
  hookType: string | null;
  topic: string;
  suggestedHooks: string[];
  suggestedDurationMin: number | null;
  suggestedDurationMax: number | null;
  filmingNotes: string | null;
  reason: string | null;
  source: string;
  priority: string;
  status: string;
  strategyRecommendationId: string | null;
  createdAt: string;
  filmedAt: string | null;
  uploadTriggeredAt: string | null;
}

export interface CmCalendarEvent {
  id: string;
  eventDate: string;
  eventType: string;
  title: string;
  description: string | null;
  pillar: string | null;
  platform: string | null;
  videoId: string | null;
  recordingTaskId: string | null;
  status: string;
  createdAt: string;
}

export interface CmClipEnhancement {
  id: string;
  videoId: string;
  hookPrimary: string;
  hookVariations: string[];
  hookType: string;
  captionGenerated: string;
  captionFinal: string;
  hashtagsGenerated: string[];
  hashtagsFinal: string[];
  titleGenerated: string;
  titleFinal: string;
  platformTargets: string[];
  trendAlignmentScore: number;
  trendAlignmentReason: string;
  optimalPostTimeTiktok: string | null;
  optimalPostTimeInstagram: string | null;
  opusClipScore: number;
  sourceFileId: string | null;
  createdAt: string;
  lastEditedAt: string | null;
  editedBy: string | null;
  thumbnailUrl?: string | null;
}

function rowToBatchSession(row: Record<string, unknown>): CmBatchSession {
  return {
    id: String(row.id),
    sessionName: row.session_name ? String(row.session_name) : null,
    pillar: String(row.pillar),
    filmedBy: String(row.filmed_by ?? "marco"),
    targetClipCount: row.target_clip_count != null ? Number(row.target_clip_count) : null,
    status: row.status as BatchSessionStatus,
    sourceFileCount: Number(row.source_file_count) || 0,
    clipsGenerated: Number(row.clips_generated) || 0,
    trendBriefId: row.trend_brief_id ? String(row.trend_brief_id) : null,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    notes: row.notes ? String(row.notes) : null,
    userContext: row.user_context ? String(row.user_context) : null,
    scriptText: row.script_text ? String(row.script_text) : null,
    enhanceOptions: row.enhance_options
      ? parseJson<CmEnhanceOptions | null>(String(row.enhance_options), null)
      : null,
  };
}

function rowToBatchSourceFile(row: Record<string, unknown>): CmBatchSourceFile {
  return {
    id: String(row.id),
    batchSessionId: String(row.batch_session_id),
    originalFilename: String(row.original_filename),
    fileSizeBytes: Number(row.file_size_bytes) || 0,
    filePath: String(row.file_path),
    durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    opusJobId: row.opus_job_id ? String(row.opus_job_id) : null,
    opusStatus: String(row.opus_status ?? "queued"),
    clipsGeneratedCount: Number(row.clips_generated_count) || 0,
    uploadedAt: String(row.uploaded_at),
    opusSubmittedAt: row.opus_submitted_at ? String(row.opus_submitted_at) : null,
    opusCompletedAt: row.opus_completed_at ? String(row.opus_completed_at) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
  };
}

function rowToCompetitorProfile(row: Record<string, unknown>): CmCompetitorProfile {
  return {
    id: String(row.id),
    tiktokHandle: String(row.tiktok_handle),
    displayName: String(row.display_name),
    profileType: String(row.profile_type),
    active: row.active === 1,
    lastScrapedAt: row.last_scraped_at ? String(row.last_scraped_at) : null,
    addedAt: String(row.added_at),
  };
}

function rowToCompetitorTrends(row: Record<string, unknown>): CmCompetitorTrends {
  return {
    id: String(row.id),
    scrapedAt: String(row.scraped_at),
    profilesScraped: parseJson<string[]>(String(row.profiles_scraped ?? "[]"), []),
    rawVideoCount: Number(row.raw_video_count) || 0,
    topHooks: parseJson<string[]>(String(row.top_hooks ?? "[]"), []),
    trendingHashtags: parseJson<string[]>(String(row.trending_hashtags ?? "[]"), []),
    topPerformingDurations: parseJson<Record<string, number>>(
      String(row.top_performing_durations ?? "{}"),
      {},
    ),
    bestDurationRange: String(row.best_duration_range ?? "30_to_60"),
    topContentThemes: parseJson<string[]>(String(row.top_content_themes ?? "[]"), []),
    trendBrief: String(row.trend_brief ?? ""),
    expiresAt: String(row.expires_at),
  };
}

function rowToClipEnhancement(row: Record<string, unknown>): CmClipEnhancement {
  return {
    id: String(row.id),
    videoId: String(row.video_id),
    hookPrimary: String(row.hook_primary ?? ""),
    hookVariations: parseJson<string[]>(String(row.hook_variations ?? "[]"), []),
    hookType: String(row.hook_type ?? ""),
    captionGenerated: String(row.caption_generated ?? ""),
    captionFinal: String(row.caption_final ?? ""),
    hashtagsGenerated: parseJson<string[]>(String(row.hashtags_generated ?? "[]"), []),
    hashtagsFinal: parseJson<string[]>(String(row.hashtags_final ?? "[]"), []),
    titleGenerated: String(row.title_generated ?? ""),
    titleFinal: String(row.title_final ?? ""),
    platformTargets: parseJson<string[]>(String(row.platform_targets ?? "[]"), []),
    trendAlignmentScore: Number(row.trend_alignment_score) || 0,
    trendAlignmentReason: String(row.trend_alignment_reason ?? ""),
    optimalPostTimeTiktok: row.optimal_post_time_tiktok ? String(row.optimal_post_time_tiktok) : null,
    optimalPostTimeInstagram: row.optimal_post_time_instagram
      ? String(row.optimal_post_time_instagram)
      : null,
    opusClipScore: Number(row.opus_clip_score) || 0,
    sourceFileId: row.source_file_id ? String(row.source_file_id) : null,
    createdAt: String(row.created_at),
    lastEditedAt: row.last_edited_at ? String(row.last_edited_at) : null,
    editedBy: row.edited_by ? String(row.edited_by) : null,
  };
}

export function createBatchSession(input: {
  sessionName?: string;
  pillar: string;
  filmedBy?: string;
  targetClipCount?: number;
  status?: BatchSessionStatus;
  sourceFileCount?: number;
  notes?: string;
  userContext?: string;
  scriptText?: string;
  enhanceOptions?: CmEnhanceOptions;
}): CmBatchSession {
  const database = getContentDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO cm_batch_sessions
       (id, session_name, pillar, filmed_by, target_clip_count, status, source_file_count,
        clips_generated, trend_brief_id, created_at, completed_at, notes, user_context, script_text,
        enhance_options)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sessionName ?? null,
      input.pillar,
      input.filmedBy ?? "marco",
      input.targetClipCount ?? null,
      input.status ?? "uploading",
      input.sourceFileCount ?? 0,
      now,
      input.notes ?? null,
      input.userContext ?? null,
      input.scriptText ?? null,
      input.enhanceOptions ? JSON.stringify(input.enhanceOptions) : null,
    );
  return getBatchSession(id)!;
}

export function getBatchSession(id: string): CmBatchSession | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_batch_sessions WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToBatchSession(row) : null;
}

export function updateBatchSession(
  id: string,
  patch: Partial<
    Pick<
      CmBatchSession,
      | "status"
      | "clipsGenerated"
      | "trendBriefId"
      | "completedAt"
      | "targetClipCount"
      | "sourceFileCount"
    >
  >,
): CmBatchSession | null {
  const existing = getBatchSession(id);
  if (!existing) return null;
  const database = getContentDb();
  database
    .prepare(
      `UPDATE cm_batch_sessions SET status = ?, clips_generated = ?, trend_brief_id = ?,
       completed_at = ?, target_clip_count = ?, source_file_count = ? WHERE id = ?`,
    )
    .run(
      patch.status ?? existing.status,
      patch.clipsGenerated ?? existing.clipsGenerated,
      patch.trendBriefId !== undefined ? patch.trendBriefId : existing.trendBriefId,
      patch.completedAt !== undefined ? patch.completedAt : existing.completedAt,
      patch.targetClipCount !== undefined ? patch.targetClipCount : existing.targetClipCount,
      patch.sourceFileCount !== undefined ? patch.sourceFileCount : existing.sourceFileCount,
      id,
    );
  return getBatchSession(id);
}

export function listBatchSessions(days = 7): CmBatchSession[] {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_batch_sessions WHERE created_at >= ? ORDER BY created_at DESC`)
    .all(since) as Record<string, unknown>[];
  return rows.map(rowToBatchSession);
}

export function deleteBatchSession(id: string): {
  deleted: boolean;
  videosDeleted: number;
  sourceFilesDeleted: number;
} {
  const database = getContentDb();
  const existing = database
    .prepare(`SELECT id FROM cm_batch_sessions WHERE id = ?`)
    .get(id) as { id: string } | undefined;
  if (!existing) {
    return { deleted: false, videosDeleted: 0, sourceFilesDeleted: 0 };
  }

  const txn = database.transaction(() => {
    const videoRows = database
      .prepare(`SELECT id FROM content_videos WHERE batch_session_id = ?`)
      .all(id) as Array<{ id: string }>;

    let videosDeleted = 0;
    for (const row of videoRows) {
      database.prepare(`DELETE FROM cm_clip_enhancements WHERE video_id = ?`).run(row.id);
      database.prepare(`DELETE FROM content_compliance_queue WHERE video_id = ?`).run(row.id);
      database.prepare(`DELETE FROM content_videos WHERE id = ?`).run(row.id);
      videosDeleted++;
    }

    const sf = database
      .prepare(`DELETE FROM cm_batch_source_files WHERE batch_session_id = ?`)
      .run(id);
    database.prepare(`DELETE FROM cm_batch_sessions WHERE id = ?`).run(id);

    return { videosDeleted, sourceFilesDeleted: sf.changes as number };
  });

  const result = txn();
  return { deleted: true, ...result };
}

export function createBatchSourceFile(input: {
  batchSessionId: string;
  originalFilename: string;
  fileSizeBytes: number;
  filePath: string;
  durationSeconds?: number | null;
}): CmBatchSourceFile {
  const database = getContentDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO cm_batch_source_files
       (id, batch_session_id, original_filename, file_size_bytes, file_path, duration_seconds,
        opus_job_id, opus_status, clips_generated_count, uploaded_at, opus_submitted_at,
        opus_completed_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'queued', 0, ?, NULL, NULL, NULL)`,
    )
    .run(
      id,
      input.batchSessionId,
      input.originalFilename,
      input.fileSizeBytes,
      input.filePath,
      input.durationSeconds ?? null,
      now,
    );
  return getBatchSourceFile(id)!;
}

export function getBatchSourceFile(id: string): CmBatchSourceFile | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_batch_source_files WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToBatchSourceFile(row) : null;
}

export function listBatchSourceFiles(batchSessionId: string): CmBatchSourceFile[] {
  const rows = getContentDb()
    .prepare(
      `SELECT * FROM cm_batch_source_files WHERE batch_session_id = ? ORDER BY uploaded_at`,
    )
    .all(batchSessionId) as Record<string, unknown>[];
  return rows.map(rowToBatchSourceFile);
}

export function updateBatchSourceFile(
  id: string,
  patch: Partial<
    Pick<
      CmBatchSourceFile,
      | "opusJobId"
      | "opusStatus"
      | "clipsGeneratedCount"
      | "opusSubmittedAt"
      | "opusCompletedAt"
      | "errorMessage"
      | "durationSeconds"
    >
  >,
): CmBatchSourceFile | null {
  const existing = getBatchSourceFile(id);
  if (!existing) return null;
  const database = getContentDb();
  database
    .prepare(
      `UPDATE cm_batch_source_files SET opus_job_id = ?, opus_status = ?, clips_generated_count = ?,
       opus_submitted_at = ?, opus_completed_at = ?, error_message = ?, duration_seconds = ? WHERE id = ?`,
    )
    .run(
      patch.opusJobId !== undefined ? patch.opusJobId : existing.opusJobId,
      patch.opusStatus ?? existing.opusStatus,
      patch.clipsGeneratedCount ?? existing.clipsGeneratedCount,
      patch.opusSubmittedAt !== undefined ? patch.opusSubmittedAt : existing.opusSubmittedAt,
      patch.opusCompletedAt !== undefined ? patch.opusCompletedAt : existing.opusCompletedAt,
      patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage,
      patch.durationSeconds !== undefined ? patch.durationSeconds : existing.durationSeconds,
      id,
    );
  return getBatchSourceFile(id);
}

export function listActiveCompetitorProfiles(): CmCompetitorProfile[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_competitor_profiles WHERE active = 1 ORDER BY display_name`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToCompetitorProfile);
}

export function listAllCompetitorProfiles(): CmCompetitorProfile[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_competitor_profiles ORDER BY display_name`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToCompetitorProfile);
}

export function insertCompetitorProfile(input: {
  tiktokHandle: string;
  displayName: string;
  profileType: string;
}): CmCompetitorProfile {
  const database = getContentDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const handle = input.tiktokHandle.replace(/^@/, "").trim();
  database
    .prepare(
      `INSERT INTO cm_competitor_profiles (id, tiktok_handle, display_name, profile_type, active, added_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(id, handle, input.displayName, input.profileType, now);
  const row = database
    .prepare(`SELECT * FROM cm_competitor_profiles WHERE id = ?`)
    .get(id) as Record<string, unknown>;
  return rowToCompetitorProfile(row);
}

export function updateCompetitorProfile(
  id: string,
  patch: { active?: boolean },
): CmCompetitorProfile | null {
  const database = getContentDb();
  if (patch.active !== undefined) {
    database
      .prepare(`UPDATE cm_competitor_profiles SET active = ? WHERE id = ?`)
      .run(patch.active ? 1 : 0, id);
  }
  const row = database
    .prepare(`SELECT * FROM cm_competitor_profiles WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToCompetitorProfile(row) : null;
}

export function getCompetitorTrendsById(id: string): CmCompetitorTrends | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_competitor_trends WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToCompetitorTrends(row) : null;
}

export function getLatestCompetitorTrends(): CmCompetitorTrends | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_competitor_trends ORDER BY scraped_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return row ? rowToCompetitorTrends(row) : null;
}

export function getCachedCompetitorTrends(): CmCompetitorTrends | null {
  const now = new Date().toISOString();
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_competitor_trends WHERE expires_at > ? ORDER BY scraped_at DESC LIMIT 1`)
    .get(now) as Record<string, unknown> | undefined;
  return row ? rowToCompetitorTrends(row) : null;
}

export function insertCompetitorTrends(
  input: Omit<CmCompetitorTrends, "id"> & { id?: string },
): CmCompetitorTrends {
  const database = getContentDb();
  const id = input.id ?? randomUUID();
  database
    .prepare(
      `INSERT INTO cm_competitor_trends
       (id, scraped_at, profiles_scraped, raw_video_count, top_hooks, trending_hashtags,
        top_performing_durations, best_duration_range, top_content_themes, trend_brief, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.scrapedAt,
      JSON.stringify(input.profilesScraped),
      input.rawVideoCount,
      JSON.stringify(input.topHooks),
      JSON.stringify(input.trendingHashtags),
      JSON.stringify(input.topPerformingDurations),
      input.bestDurationRange,
      JSON.stringify(input.topContentThemes),
      input.trendBrief,
      input.expiresAt,
    );
  const row = database
    .prepare(`SELECT * FROM cm_competitor_trends WHERE id = ?`)
    .get(id) as Record<string, unknown>;
  return rowToCompetitorTrends(row);
}

// ─── YouTube competitor transcript intelligence ──────────────────────────────

export interface CmYoutubeProfile {
  id: string;
  competitorProfileId: string | null;
  youtubeChannelUrl: string;
  youtubeHandle: string | null;
  channelName: string | null;
  profileType: string;
  active: boolean;
  lastScrapedAt: string | null;
  videosScrapedCount: number;
  addedAt: string | null;
  notes: string | null;
}

export interface CmYoutubeTranscript {
  id: string;
  videoId: string;
  videoTitle: string | null;
  channelName: string | null;
  viewCount: number;
  fullText: string | null;
  hookText: string | null;
  bodyText: string | null;
  ctaText: string | null;
  wordCount: number;
  language: string;
  fetchStatus: string;
  errorMessage: string | null;
  fetchedAt: string | null;
  expiresAt: string | null;
}

export interface CmYoutubeAnalysis {
  id: string;
  analyzedAt: string;
  videosAnalyzed: number;
  channelsAnalyzed: number;
  topHookStructures: string[];
  topOpeningPhrases: string[];
  topTopics: string[];
  topDataPoints: string[];
  topCtaPatterns: string[];
  contentGaps: string[];
  keyInsights: string;
  topRecommendedVideoIdea: string;
  weekStart: string;
}

function rowToYoutubeProfile(row: Record<string, unknown>): CmYoutubeProfile {
  return {
    id: String(row.id),
    competitorProfileId: row.competitor_profile_id ? String(row.competitor_profile_id) : null,
    youtubeChannelUrl: String(row.youtube_channel_url),
    youtubeHandle: row.youtube_handle ? String(row.youtube_handle) : null,
    channelName: row.channel_name ? String(row.channel_name) : null,
    profileType: String(row.profile_type ?? "competitor"),
    active: Number(row.active) === 1,
    lastScrapedAt: row.last_scraped_at ? String(row.last_scraped_at) : null,
    videosScrapedCount: Number(row.videos_scraped_count ?? 0),
    addedAt: row.added_at ? String(row.added_at) : null,
    notes: row.notes ? String(row.notes) : null,
  };
}

function rowToYoutubeTranscript(row: Record<string, unknown>): CmYoutubeTranscript {
  return {
    id: String(row.id),
    videoId: String(row.video_id),
    videoTitle: row.video_title ? String(row.video_title) : null,
    channelName: row.channel_name ? String(row.channel_name) : null,
    viewCount: Number(row.view_count ?? 0),
    fullText: row.full_text ? String(row.full_text) : null,
    hookText: row.hook_text ? String(row.hook_text) : null,
    bodyText: row.body_text ? String(row.body_text) : null,
    ctaText: row.cta_text ? String(row.cta_text) : null,
    wordCount: Number(row.word_count ?? 0),
    language: String(row.language ?? "en"),
    fetchStatus: String(row.fetch_status ?? "success"),
    errorMessage: row.error_message ? String(row.error_message) : null,
    fetchedAt: row.fetched_at ? String(row.fetched_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
  };
}

function parseYoutubeJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function rowToYoutubeAnalysis(row: Record<string, unknown>): CmYoutubeAnalysis {
  return {
    id: String(row.id),
    analyzedAt: String(row.analyzed_at ?? ""),
    videosAnalyzed: Number(row.videos_analyzed ?? 0),
    channelsAnalyzed: Number(row.channels_analyzed ?? 0),
    topHookStructures: parseYoutubeJsonArray(row.top_hook_structures),
    topOpeningPhrases: parseYoutubeJsonArray(row.top_opening_phrases),
    topTopics: parseYoutubeJsonArray(row.top_topics),
    topDataPoints: parseYoutubeJsonArray(row.top_data_points),
    topCtaPatterns: parseYoutubeJsonArray(row.top_cta_patterns),
    contentGaps: parseYoutubeJsonArray(row.content_gaps),
    keyInsights: String(row.full_analysis_markdown ?? ""),
    topRecommendedVideoIdea: String(row.trend_signals ?? ""),
    weekStart: String(row.week_start ?? ""),
  };
}

export function listActiveYoutubeProfiles(): CmYoutubeProfile[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_competitor_youtube_profiles WHERE active = 1 ORDER BY channel_name`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToYoutubeProfile);
}

export function listAllYoutubeProfiles(): CmYoutubeProfile[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_competitor_youtube_profiles ORDER BY channel_name`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToYoutubeProfile);
}

export function insertYoutubeProfile(input: {
  youtubeChannelUrl: string;
  channelName?: string;
  youtubeHandle?: string;
  profileType?: string;
}): CmYoutubeProfile {
  const database = getContentDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO cm_competitor_youtube_profiles
       (id, youtube_channel_url, youtube_handle, channel_name, profile_type, active, added_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      id,
      input.youtubeChannelUrl,
      input.youtubeHandle ?? null,
      input.channelName ?? null,
      input.profileType ?? "competitor",
      now,
    );
  const row = database
    .prepare(`SELECT * FROM cm_competitor_youtube_profiles WHERE id = ?`)
    .get(id) as Record<string, unknown>;
  return rowToYoutubeProfile(row);
}

export function updateYoutubeProfile(
  id: string,
  patch: { active?: boolean },
): CmYoutubeProfile | null {
  const database = getContentDb();
  if (patch.active !== undefined) {
    database
      .prepare(`UPDATE cm_competitor_youtube_profiles SET active = ? WHERE id = ?`)
      .run(patch.active ? 1 : 0, id);
  }
  const row = database
    .prepare(`SELECT * FROM cm_competitor_youtube_profiles WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToYoutubeProfile(row) : null;
}

export function markYoutubeProfileScraped(id: string, videosScrapedCount: number): void {
  getContentDb()
    .prepare(
      `UPDATE cm_competitor_youtube_profiles SET last_scraped_at = ?, videos_scraped_count = ? WHERE id = ?`,
    )
    .run(new Date().toISOString(), videosScrapedCount, id);
}

export function upsertYoutubeVideoCache(input: {
  youtubeProfileId: string;
  videoId: string;
  title: string;
  channelName: string;
  channelUrl: string;
  uploadDate: string;
  viewCount: number;
  durationSeconds: number;
  url: string;
}): void {
  getContentDb()
    .prepare(
      `INSERT OR REPLACE INTO cm_youtube_video_cache
       (id, youtube_profile_id, video_id, title, channel_name, channel_url, upload_date,
        view_count, duration_seconds, url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.youtubeProfileId,
      input.videoId,
      input.title,
      input.channelName,
      input.channelUrl,
      input.uploadDate,
      input.viewCount,
      input.durationSeconds,
      input.url,
      new Date().toISOString(),
    );
}

/** Returns a cached transcript only if it exists, succeeded, and has not expired. */
export function getCachedYoutubeTranscript(videoId: string): CmYoutubeTranscript | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_youtube_transcripts WHERE video_id = ? AND fetch_status = 'success'`)
    .get(videoId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const parsed = rowToYoutubeTranscript(row);
  if (parsed.expiresAt && new Date(parsed.expiresAt) < new Date()) return null;
  return parsed;
}

export function upsertYoutubeTranscript(input: {
  videoId: string;
  videoTitle: string;
  channelName: string;
  viewCount: number;
  fullText: string | null;
  hookText: string | null;
  bodyText: string | null;
  ctaText: string | null;
  wordCount: number;
  fetchStatus: string;
  errorMessage: string | null;
  cacheDays: number;
}): void {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.cacheDays * 24 * 60 * 60 * 1000);
  getContentDb()
    .prepare(
      `INSERT OR REPLACE INTO cm_youtube_transcripts
       (id, video_id, video_title, channel_name, view_count, full_text, hook_text, body_text, cta_text,
        word_count, language, fetch_status, error_message, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.videoId,
      input.videoTitle,
      input.channelName,
      input.viewCount,
      input.fullText,
      input.hookText,
      input.bodyText,
      input.ctaText,
      input.wordCount,
      "en",
      input.fetchStatus,
      input.errorMessage,
      now.toISOString(),
      expiresAt.toISOString(),
    );
}

export function listYoutubeTranscripts(options?: {
  channelName?: string;
  limit?: number;
}): CmYoutubeTranscript[] {
  const limit = options?.limit ?? 20;
  const database = getContentDb();
  let rows: Record<string, unknown>[];
  if (options?.channelName) {
    rows = database
      .prepare(
        `SELECT * FROM cm_youtube_transcripts WHERE fetch_status = 'success' AND channel_name = ?
         ORDER BY view_count DESC LIMIT ?`,
      )
      .all(options.channelName, limit) as Record<string, unknown>[];
  } else {
    rows = database
      .prepare(
        `SELECT * FROM cm_youtube_transcripts WHERE fetch_status = 'success'
         ORDER BY view_count DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
  }
  return rows.map(rowToYoutubeTranscript);
}

export function getYoutubeTranscript(videoId: string): CmYoutubeTranscript | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_youtube_transcripts WHERE video_id = ?`)
    .get(videoId) as Record<string, unknown> | undefined;
  return row ? rowToYoutubeTranscript(row) : null;
}

export function insertYoutubeAnalysis(input: {
  videosAnalyzed: number;
  channelsAnalyzed: number;
  topHookStructures: string[];
  topOpeningPhrases: string[];
  topTopics: string[];
  topDataPoints: string[];
  topCtaPatterns: string[];
  contentGaps: string[];
  keyInsights: string;
  topRecommendedVideoIdea: string;
  weekStart: string;
}): CmYoutubeAnalysis {
  const database = getContentDb();
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO cm_youtube_analysis
       (id, analyzed_at, videos_analyzed, channels_analyzed, top_hook_structures, top_opening_phrases,
        top_topics, top_data_points, top_cta_patterns, content_gaps, full_analysis_markdown,
        trend_signals, week_start)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      new Date().toISOString(),
      input.videosAnalyzed,
      input.channelsAnalyzed,
      JSON.stringify(input.topHookStructures),
      JSON.stringify(input.topOpeningPhrases),
      JSON.stringify(input.topTopics),
      JSON.stringify(input.topDataPoints),
      JSON.stringify(input.topCtaPatterns),
      JSON.stringify(input.contentGaps),
      input.keyInsights,
      input.topRecommendedVideoIdea,
      input.weekStart,
    );
  const row = database
    .prepare(`SELECT * FROM cm_youtube_analysis WHERE id = ?`)
    .get(id) as Record<string, unknown>;
  return rowToYoutubeAnalysis(row);
}

export function getLatestYoutubeAnalysis(): CmYoutubeAnalysis | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_youtube_analysis ORDER BY analyzed_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return row ? rowToYoutubeAnalysis(row) : null;
}

export function insertClipEnhancement(
  input: Omit<CmClipEnhancement, "id" | "lastEditedAt" | "editedBy"> & {
    id?: string;
    lastEditedAt?: string | null;
    editedBy?: string | null;
  },
): CmClipEnhancement {
  const database = getContentDb();
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO cm_clip_enhancements
       (id, video_id, hook_primary, hook_variations, hook_type, caption_generated, caption_final,
        hashtags_generated, hashtags_final, title_generated, title_final, platform_targets,
        trend_alignment_score, trend_alignment_reason, optimal_post_time_tiktok,
        optimal_post_time_instagram, opus_clip_score, source_file_id, created_at, last_edited_at, edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.videoId,
      input.hookPrimary,
      JSON.stringify(input.hookVariations),
      input.hookType,
      input.captionGenerated,
      input.captionFinal,
      JSON.stringify(input.hashtagsGenerated),
      JSON.stringify(input.hashtagsFinal),
      input.titleGenerated,
      input.titleFinal,
      JSON.stringify(input.platformTargets),
      input.trendAlignmentScore,
      input.trendAlignmentReason,
      input.optimalPostTimeTiktok,
      input.optimalPostTimeInstagram,
      input.opusClipScore,
      input.sourceFileId,
      input.createdAt ?? now,
      input.lastEditedAt ?? null,
      input.editedBy ?? "brain",
    );
  return getClipEnhancement(id)!;
}

export function getClipEnhancement(id: string): CmClipEnhancement | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_clip_enhancements WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToClipEnhancement(row) : null;
}

export function getClipEnhancementByVideoId(videoId: string): CmClipEnhancement | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_clip_enhancements WHERE video_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(videoId) as Record<string, unknown> | undefined;
  return row ? rowToClipEnhancement(row) : null;
}

export function updateClipEnhancement(
  id: string,
  patch: Partial<
    Pick<
      CmClipEnhancement,
      | "hookPrimary"
      | "captionFinal"
      | "hashtagsFinal"
      | "titleFinal"
      | "platformTargets"
      | "lastEditedAt"
      | "editedBy"
    >
  >,
): CmClipEnhancement | null {
  const existing = getClipEnhancement(id);
  if (!existing) return null;
  const database = getContentDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE cm_clip_enhancements SET hook_primary = ?, caption_final = ?, hashtags_final = ?,
       title_final = ?, platform_targets = ?, last_edited_at = ?, edited_by = ? WHERE id = ?`,
    )
    .run(
      patch.hookPrimary ?? existing.hookPrimary,
      patch.captionFinal ?? existing.captionFinal,
      JSON.stringify(patch.hashtagsFinal ?? existing.hashtagsFinal),
      patch.titleFinal ?? existing.titleFinal,
      JSON.stringify(patch.platformTargets ?? existing.platformTargets),
      patch.lastEditedAt ?? now,
      patch.editedBy ?? "human",
      id,
    );
  return getClipEnhancement(id);
}

export function listVideosByBatchSession(
  batchSessionId: string,
  status?: ContentVideoStatus,
): ContentVideo[] {
  const database = getContentDb();
  const rows = status
    ? (database
        .prepare(
          `SELECT * FROM content_videos WHERE batch_session_id = ? AND status = ? ORDER BY created_at`,
        )
        .all(batchSessionId, status) as Record<string, unknown>[])
    : (database
        .prepare(
          `SELECT * FROM content_videos WHERE batch_session_id = ? ORDER BY created_at`,
        )
        .all(batchSessionId) as Record<string, unknown>[]);
  return rows.map(rowToVideo);
}

export function countClipsInApprovedOrScheduled(): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM content_videos WHERE status IN ('approved', 'scheduled')`,
    )
    .get() as { c: number };
  return Number(row.c) || 0;
}

export function countVideosByBatchAndStatus(batchSessionId: string, status: ContentVideoStatus): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM content_videos WHERE batch_session_id = ? AND status = ?`,
    )
    .get(batchSessionId, status) as { c: number };
  return Number(row.c) || 0;
}

export function listContentVideosWithEnhancements(input?: {
  status?: ContentVideoStatus;
  batchSessionId?: string;
  limit?: number;
}): Array<ContentVideo & { enhancement: CmClipEnhancement | null; videoEnhancements: string[] }> {
  const limit = input?.limit ?? 200;
  const database = getContentDb();
  let rows: Record<string, unknown>[];
  if (input?.batchSessionId && input?.status) {
    rows = database
      .prepare(
        `SELECT * FROM content_videos WHERE batch_session_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(input.batchSessionId, input.status, limit) as Record<string, unknown>[];
  } else if (input?.batchSessionId) {
    rows = database
      .prepare(
        `SELECT * FROM content_videos WHERE batch_session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(input.batchSessionId, limit) as Record<string, unknown>[];
  } else if (input?.status) {
    rows = database
      .prepare(`SELECT * FROM content_videos WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .all(input.status, limit) as Record<string, unknown>[];
  } else {
    rows = database
      .prepare(`SELECT * FROM content_videos ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
  }
  // Which video-enhancement passes ran on each clip (auto_zoom, captions,
  // broll, smart_cuts...) — recorded on the source session at clip creation.
  // Cache session lookups within this call: many videos share a session read.
  const sessionEnhCache = new Map<string, string[]>();
  const enhancementsFor = (sessionId: string | null): string[] => {
    if (!sessionId) return [];
    const cached = sessionEnhCache.get(sessionId);
    if (cached) return cached;
    const applied = getContentSession(sessionId)?.rawInputMeta?.enhancementsApplied;
    const list = Array.isArray(applied) ? applied.map(String) : [];
    sessionEnhCache.set(sessionId, list);
    return list;
  };
  return rows.map((row) => {
    const video = rowToVideo(row);
    const enhancement = getClipEnhancementByVideoId(video.id);
    return { ...video, enhancement, videoEnhancements: enhancementsFor(video.sourceSessionId) };
  });
}

function parseJsonArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string" && val.trim()) {
    try {
      const parsed = JSON.parse(val) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowToCompetitiveAnalysis(row: Record<string, unknown>): CmCompetitiveAnalysis {
  return {
    id: String(row.id),
    analyzedAt: String(row.analyzed_at),
    weekStart: String(row.week_start),
    profilesAnalyzed: parseJsonArray(row.profiles_analyzed),
    marcoAvgViews: Number(row.marco_avg_views) || 0,
    marcoAvgEngagementRate: Number(row.marco_avg_engagement_rate) || 0,
    competitorAvgViews: Number(row.competitor_avg_views) || 0,
    competitorAvgEngagementRate: Number(row.competitor_avg_engagement_rate) || 0,
    marcoVsFieldPct: Number(row.marco_vs_field_pct) || 0,
    topCompetitorHandle: String(row.top_competitor_handle ?? ""),
    topCompetitorAvgViews: Number(row.top_competitor_avg_views) || 0,
    marcoStrengths: parseJsonArray(row.marco_strengths),
    marcoGaps: parseJsonArray(row.marco_gaps),
    topCompetitorThemes: parseJsonArray(row.top_competitor_themes),
    fullAnalysisMarkdown: String(row.full_analysis_markdown ?? ""),
    createdAt: String(row.created_at),
  };
}

function rowToStrategyRecommendation(row: Record<string, unknown>): CmStrategyRecommendation {
  return {
    id: String(row.id),
    analysisId: String(row.analysis_id),
    priority: Number(row.priority) || 5,
    recommendation: String(row.recommendation),
    dataBacking: String(row.data_backing ?? ""),
    pillar: row.pillar ? String(row.pillar) : null,
    hookType: row.hook_type ? String(row.hook_type) : null,
    exampleFromCompetitor: row.example_from_competitor ? String(row.example_from_competitor) : null,
    expectedImpact: row.expected_impact ? String(row.expected_impact) : null,
    status: String(row.status ?? "pending"),
    dismissedReason: row.dismissed_reason ? String(row.dismissed_reason) : null,
    createdAt: String(row.created_at),
    actedOnAt: row.acted_on_at ? String(row.acted_on_at) : null,
  };
}

function rowToRecordingTask(row: Record<string, unknown>): CmRecordingTask {
  return {
    id: String(row.id),
    dueDate: String(row.due_date),
    pillar: row.pillar ? String(row.pillar) : null,
    hookType: row.hook_type ? String(row.hook_type) : null,
    topic: String(row.topic),
    suggestedHooks: parseJsonArray(row.suggested_hooks),
    suggestedDurationMin: row.suggested_duration_min != null ? Number(row.suggested_duration_min) : null,
    suggestedDurationMax: row.suggested_duration_max != null ? Number(row.suggested_duration_max) : null,
    filmingNotes: row.filming_notes ? String(row.filming_notes) : null,
    reason: row.reason ? String(row.reason) : null,
    source: String(row.source ?? "brain"),
    priority: String(row.priority ?? "normal"),
    status: String(row.status ?? "pending"),
    strategyRecommendationId: row.strategy_recommendation_id
      ? String(row.strategy_recommendation_id)
      : null,
    createdAt: String(row.created_at),
    filmedAt: row.filmed_at ? String(row.filmed_at) : null,
    uploadTriggeredAt: row.upload_triggered_at ? String(row.upload_triggered_at) : null,
  };
}

function rowToCalendarEvent(row: Record<string, unknown>): CmCalendarEvent {
  return {
    id: String(row.id),
    eventDate: String(row.event_date),
    eventType: String(row.event_type),
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    pillar: row.pillar ? String(row.pillar) : null,
    platform: row.platform ? String(row.platform) : null,
    videoId: row.video_id ? String(row.video_id) : null,
    recordingTaskId: row.recording_task_id ? String(row.recording_task_id) : null,
    status: String(row.status ?? "pending"),
    createdAt: String(row.created_at),
  };
}

export function insertCompetitiveAnalysis(
  patch: Omit<CmCompetitiveAnalysis, "id" | "createdAt">,
): CmCompetitiveAnalysis {
  const id = randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_competitive_analysis
       (id, analyzed_at, week_start, profiles_analyzed, marco_avg_views, marco_avg_engagement_rate,
        competitor_avg_views, competitor_avg_engagement_rate, marco_vs_field_pct, top_competitor_handle,
        top_competitor_avg_views, marco_strengths, marco_gaps, top_competitor_themes,
        full_analysis_markdown, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      patch.analyzedAt,
      patch.weekStart,
      JSON.stringify(patch.profilesAnalyzed),
      patch.marcoAvgViews,
      patch.marcoAvgEngagementRate,
      patch.competitorAvgViews,
      patch.competitorAvgEngagementRate,
      patch.marcoVsFieldPct,
      patch.topCompetitorHandle,
      patch.topCompetitorAvgViews,
      JSON.stringify(patch.marcoStrengths),
      JSON.stringify(patch.marcoGaps),
      JSON.stringify(patch.topCompetitorThemes),
      patch.fullAnalysisMarkdown,
      now,
    );
  return getCompetitiveAnalysisById(id)!;
}

export function getCompetitiveAnalysisById(id: string): CmCompetitiveAnalysis | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_competitive_analysis WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToCompetitiveAnalysis(row) : null;
}

export function getLatestCompetitiveAnalysis(): CmCompetitiveAnalysis | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_competitive_analysis ORDER BY analyzed_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return row ? rowToCompetitiveAnalysis(row) : null;
}

export function insertStrategyRecommendation(
  patch: Omit<CmStrategyRecommendation, "id" | "createdAt" | "actedOnAt" | "status" | "dismissedReason"> &
    Partial<Pick<CmStrategyRecommendation, "status" | "dismissedReason">>,
): CmStrategyRecommendation {
  const id = randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_strategy_recommendations
       (id, analysis_id, priority, recommendation, data_backing, pillar, hook_type,
        example_from_competitor, expected_impact, status, dismissed_reason, created_at, acted_on_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      patch.analysisId,
      patch.priority,
      patch.recommendation,
      patch.dataBacking,
      patch.pillar,
      patch.hookType,
      patch.exampleFromCompetitor,
      patch.expectedImpact,
      patch.status ?? "pending",
      patch.dismissedReason ?? null,
      now,
    );
  return getStrategyRecommendationById(id)!;
}

export function getStrategyRecommendationById(id: string): CmStrategyRecommendation | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_strategy_recommendations WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToStrategyRecommendation(row) : null;
}

export function listStrategyRecommendations(input?: {
  status?: string;
  limit?: number;
  analysisId?: string;
}): CmStrategyRecommendation[] {
  const limit = input?.limit ?? 50;
  const database = getContentDb();
  let rows: Array<Record<string, unknown>>;
  if (input?.analysisId) {
    rows = database
      .prepare(
        `SELECT * FROM cm_strategy_recommendations WHERE analysis_id = ? ORDER BY priority ASC LIMIT ?`,
      )
      .all(input.analysisId, limit) as Array<Record<string, unknown>>;
  } else if (input?.status) {
    rows = database
      .prepare(
        `SELECT * FROM cm_strategy_recommendations WHERE status = ? ORDER BY priority ASC LIMIT ?`,
      )
      .all(input.status, limit) as Array<Record<string, unknown>>;
  } else {
    rows = database
      .prepare(`SELECT * FROM cm_strategy_recommendations ORDER BY priority ASC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
  }
  return rows.map(rowToStrategyRecommendation);
}

export function getActiveStrategyRecommendations(): CmStrategyRecommendation[] {
  const rows = getContentDb()
    .prepare(
      `SELECT * FROM cm_strategy_recommendations
       WHERE status IN ('pending', 'in_progress')
       ORDER BY priority ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToStrategyRecommendation);
}

export function countActiveStrategyRecommendations(): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM cm_strategy_recommendations WHERE status IN ('pending', 'in_progress')`,
    )
    .get() as { c: number };
  return Number(row.c) || 0;
}

export function updateStrategyRecommendation(
  id: string,
  patch: Partial<Pick<CmStrategyRecommendation, "status" | "dismissedReason" | "actedOnAt">>,
): CmStrategyRecommendation | null {
  const existing = getStrategyRecommendationById(id);
  if (!existing) return null;
  const status = patch.status ?? existing.status;
  const dismissedReason = patch.dismissedReason ?? existing.dismissedReason;
  const actedOnAt =
    patch.actedOnAt ??
    (patch.status && patch.status !== "pending" ? new Date().toISOString() : existing.actedOnAt);
  getContentDb()
    .prepare(
      `UPDATE cm_strategy_recommendations SET status = ?, dismissed_reason = ?, acted_on_at = ? WHERE id = ?`,
    )
    .run(status, dismissedReason, actedOnAt, id);
  return getStrategyRecommendationById(id);
}

export function insertRecordingTask(
  patch: Omit<
    CmRecordingTask,
    "id" | "createdAt" | "filmedAt" | "uploadTriggeredAt" | "status" | "source" | "priority"
  > &
    Partial<Pick<CmRecordingTask, "status" | "source" | "priority">>,
): CmRecordingTask {
  const id = randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_recording_tasks
       (id, due_date, pillar, hook_type, topic, suggested_hooks, suggested_duration_min,
        suggested_duration_max, filming_notes, reason, source, priority, status,
        strategy_recommendation_id, created_at, filmed_at, upload_triggered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      id,
      patch.dueDate,
      patch.pillar,
      patch.hookType,
      patch.topic,
      JSON.stringify(patch.suggestedHooks),
      patch.suggestedDurationMin,
      patch.suggestedDurationMax,
      patch.filmingNotes,
      patch.reason,
      patch.source ?? "brain",
      patch.priority ?? "normal",
      patch.status ?? "pending",
      patch.strategyRecommendationId,
      now,
    );
  return getRecordingTaskById(id)!;
}

export function getRecordingTaskById(id: string): CmRecordingTask | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_recording_tasks WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToRecordingTask(row) : null;
}

export function listRecordingTasks(input?: {
  status?: string;
  dueBefore?: string;
  dueAfter?: string;
  limit?: number;
}): CmRecordingTask[] {
  const limit = input?.limit ?? 100;
  const database = getContentDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input?.status) {
    conditions.push("status = ?");
    params.push(input.status);
  }
  if (input?.dueBefore) {
    conditions.push("due_date <= ?");
    params.push(input.dueBefore);
  }
  if (input?.dueAfter) {
    conditions.push("due_date >= ?");
    params.push(input.dueAfter);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const rows = database
    .prepare(`SELECT * FROM cm_recording_tasks ${where} ORDER BY due_date ASC, priority DESC LIMIT ?`)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToRecordingTask);
}

/** Delete the still-pending recording tasks for one day from a given source.
 * Used by the daily-plan generator so hitting "Generate" again replaces that
 * day's auto-generated plan instead of piling up duplicates. Never touches
 * filmed/uploaded tasks or tasks from other sources (e.g. manual). Returns the
 * number deleted. */
export function deleteDayPlanRecordingTasks(date: string, source: string): number {
  const info = getContentDb()
    .prepare(`DELETE FROM cm_recording_tasks WHERE due_date = ? AND source = ? AND status = 'pending'`)
    .run(date, source);
  return Number(info.changes) || 0;
}

export function countPendingRecordingTasksDueBefore(date: string): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM cm_recording_tasks WHERE status = 'pending' AND due_date <= ?`,
    )
    .get(date) as { c: number };
  return Number(row.c) || 0;
}

export function countOverdueRecordingTasks(today: string): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM cm_recording_tasks WHERE status = 'pending' AND due_date < ?`,
    )
    .get(today) as { c: number };
  return Number(row.c) || 0;
}

export function countPendingRecordingTasksThisWeek(weekStart: string, weekEnd: string): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM cm_recording_tasks
       WHERE status = 'pending' AND due_date >= ? AND due_date <= ?`,
    )
    .get(weekStart, weekEnd) as { c: number };
  return Number(row.c) || 0;
}

export function updateRecordingTask(
  id: string,
  patch: Partial<
    Pick<CmRecordingTask, "status" | "filmedAt" | "uploadTriggeredAt" | "priority" | "dueDate">
  >,
): CmRecordingTask | null {
  const existing = getRecordingTaskById(id);
  if (!existing) return null;
  getContentDb()
    .prepare(
      `UPDATE cm_recording_tasks SET status = ?, filmed_at = ?, upload_triggered_at = ?, priority = ?, due_date = ? WHERE id = ?`,
    )
    .run(
      patch.status ?? existing.status,
      patch.filmedAt !== undefined ? patch.filmedAt : existing.filmedAt,
      patch.uploadTriggeredAt !== undefined ? patch.uploadTriggeredAt : existing.uploadTriggeredAt,
      patch.priority ?? existing.priority,
      patch.dueDate ?? existing.dueDate,
      id,
    );
  return getRecordingTaskById(id);
}

export function insertCalendarEvent(
  patch: Omit<CmCalendarEvent, "id" | "createdAt" | "status"> &
    Partial<Pick<CmCalendarEvent, "status">>,
): CmCalendarEvent {
  const id = randomUUID();
  const now = new Date().toISOString();
  getContentDb()
    .prepare(
      `INSERT INTO cm_calendar_events
       (id, event_date, event_type, title, description, pillar, platform, video_id,
        recording_task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      patch.eventDate,
      patch.eventType,
      patch.title,
      patch.description,
      patch.pillar,
      patch.platform,
      patch.videoId,
      patch.recordingTaskId,
      patch.status ?? "pending",
      now,
    );
  return getCalendarEventById(id)!;
}

export function getCalendarEventById(id: string): CmCalendarEvent | null {
  const row = getContentDb()
    .prepare(`SELECT * FROM cm_calendar_events WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToCalendarEvent(row) : null;
}

export function listCalendarEventsForDate(date: string): CmCalendarEvent[] {
  const rows = getContentDb()
    .prepare(`SELECT * FROM cm_calendar_events WHERE event_date = ? ORDER BY created_at ASC`)
    .all(date) as Array<Record<string, unknown>>;
  return rows.map(rowToCalendarEvent);
}

export function updateCalendarEventByRecordingTaskId(
  recordingTaskId: string,
  patch: Partial<Pick<CmCalendarEvent, "status">>,
): void {
  if (!patch.status) return;
  getContentDb()
    .prepare(`UPDATE cm_calendar_events SET status = ? WHERE recording_task_id = ?`)
    .run(patch.status, recordingTaskId);
}

export function listPublishLogForDate(date: string): Array<{
  videoId: string;
  platform: string;
  publishedAt: string;
  publishStatus: string;
  title: string;
  pillar: string;
  thumbnail: string | null;
  scheduledFor: string | null;
  views: number;
  score: number;
  platformPostId: string | null;
}> {
  const rows = getContentDb()
    .prepare(
      `SELECT l.video_id, l.platform, l.published_at, l.publish_status, l.platform_post_id,
              v.title, v.pillar, v.file_path, v.scheduled_for,
              COALESCE(p.views, 0) AS views, COALESCE(p.score, 0) AS score
       FROM content_publish_log l
       JOIN content_videos v ON v.id = l.video_id
       LEFT JOIN content_performance p ON p.video_id = v.id
       WHERE l.published_at LIKE ? OR v.scheduled_for LIKE ? OR v.published_at LIKE ?
       ORDER BY l.published_at ASC`,
    )
    .all(`${date}%`, `${date}%`, `${date}%`) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    videoId: String(r.video_id),
    platform: String(r.platform),
    publishedAt: String(r.published_at),
    publishStatus: String(r.publish_status),
    title: String(r.title ?? ""),
    pillar: String(r.pillar ?? "brand"),
    thumbnail: r.file_path ? String(r.file_path) : null,
    scheduledFor: r.scheduled_for ? String(r.scheduled_for) : null,
    views: Number(r.views) || 0,
    score: Number(r.score) || 0,
    // Real post URL once the publish is confirmed (stored on the log at
    // confirmation) — used for the calendar "View on platform" link.
    platformPostId: r.platform_post_id ? String(r.platform_post_id) : null,
  }));
}

export function countPipelineVideosForDate(date: string): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM content_videos
       WHERE status IN ('pending_review', 'approved', 'scheduled')
       AND (scheduled_for LIKE ? OR created_at LIKE ?)`,
    )
    .get(`${date}%`, `${date}%`) as { c: number };
  return Number(row.c) || 0;
}

export function countPublishedVideosForDate(date: string): number {
  const row = getContentDb()
    .prepare(`SELECT COUNT(*) AS c FROM content_videos WHERE published_at LIKE ?`)
    .get(`${date}%`) as { c: number };
  return Number(row.c) || 0;
}

export function countTotalPublishedVideos(): number {
  const row = getContentDb()
    .prepare(`SELECT COUNT(*) AS c FROM content_videos WHERE status = 'published'`)
    .get() as { c: number };
  return Number(row.c) || 0;
}

export function countPublishScheduledForDate(date: string): number {
  const row = getContentDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM content_publish_log
       WHERE publish_status = 'scheduled' AND published_at LIKE ?`,
    )
    .get(`${date}%`) as { c: number };
  return Number(row.c) || 0;
}

export function listPublishCountsByDateRange(startDate: string, endDate: string): Array<{
  date: string;
  publishCount: number;
  pillars: string[];
}> {
  const rows = getContentDb()
    .prepare(
      `SELECT SUBSTR(COALESCE(v.published_at, l.published_at, v.scheduled_for), 1, 10) AS d,
              v.pillar
       FROM content_videos v
       LEFT JOIN content_publish_log l ON l.video_id = v.id
       WHERE (v.published_at >= ? AND v.published_at < ?)
          OR (l.published_at >= ? AND l.published_at < ?)
          OR (v.scheduled_for >= ? AND v.scheduled_for < ?)`,
    )
    .all(
      `${startDate}T00:00:00`,
      `${endDate}T23:59:59`,
      `${startDate}T00:00:00`,
      `${endDate}T23:59:59`,
      `${startDate}T00:00:00`,
      `${endDate}T23:59:59`,
    ) as Array<{ d: string; pillar: string }>;
  const byDate: Record<string, { count: number; pillars: Set<string> }> = {};
  for (const r of rows) {
    const d = String(r.d ?? "").slice(0, 10);
    if (!d) continue;
    if (!byDate[d]) byDate[d] = { count: 0, pillars: new Set() };
    byDate[d].count++;
    if (r.pillar) byDate[d].pillars.add(String(r.pillar));
  }
  return Object.entries(byDate).map(([date, v]) => ({
    date,
    publishCount: v.count,
    pillars: [...v.pillars],
  }));
}

export function countVideosPublishedLastDays(days: number): number {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();
  const row = getContentDb()
    .prepare(`SELECT COUNT(*) AS c FROM content_videos WHERE published_at >= ?`)
    .get(sinceStr) as { c: number };
  return Number(row.c) || 0;
}

const SPRINT_TARGET_VIDEOS = 861;
const SPRINT_END_DATE = "2026-11-30";

export function getSprintProgressData(): {
  totalPublished: number;
  sprintTarget: number;
  sprintEndDate: string;
  daysRemaining: number;
  videosNeededPerDay: number;
  currentPace: number;
  onTrack: boolean;
} {
  const totalPublished = countTotalPublishedVideos();
  const end = new Date(`${SPRINT_END_DATE}T23:59:59`);
  const daysRemaining = Math.max(1, Math.ceil((end.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  const videosNeededPerDay = (SPRINT_TARGET_VIDEOS - totalPublished) / daysRemaining;
  const currentPace = countVideosPublishedLastDays(7) / 7;
  return {
    totalPublished,
    sprintTarget: SPRINT_TARGET_VIDEOS,
    sprintEndDate: SPRINT_END_DATE,
    daysRemaining,
    videosNeededPerDay: Math.round(videosNeededPerDay * 10) / 10,
    currentPace: Math.round(currentPace * 10) / 10,
    onTrack: currentPace >= videosNeededPerDay,
  };
}
