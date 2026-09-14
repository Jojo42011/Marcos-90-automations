"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCommentAgentDb = getCommentAgentDb;
exports.hasActedOnComment = hasActedOnComment;
exports.isOurOwnPostedComment = isOurOwnPostedComment;
exports.authorAlreadyAnsweredOnPost = authorAlreadyAnsweredOnPost;
exports.repliesPostedSince = repliesPostedSince;
exports.lastReplyPostedAt = lastReplyPostedAt;
exports.recordCommentAction = recordCommentAction;
exports.markCommenterDmReceived = markCommenterDmReceived;
exports.getFollowUpQueue = getFollowUpQueue;
exports.getCommentAgentStats = getCommentAgentStats;
exports.getRecentCommentActions = getRecentCommentActions;
/**
 * Ledger for the TikTok comment agent.
 *
 * This table is not bookkeeping, it is the safety mechanism. Four different
 * failure modes are prevented by rows in it, and every one of them is public:
 *
 *   1. REPLYING TWICE to the same comment. The webhook can retry, and Zernio
 *      replays at-least-once. `comment_id` is the primary key, so a second
 *      attempt is refused by the database rather than by luck.
 *   2. ANSWERING OURSELVES. TikTok's comment webhook omits the owner flag, so
 *      our own replies come back looking like any other comment. Every reply we
 *      post is recorded in `posted_comment_id`, and an inbound comment matching
 *      one is dropped. This is the second of two independent guards; the first
 *      is the `isOwner` read-back in `integrations/zernio/comments.ts`.
 *   3. SPAMMING A VIDEO. Pacing needs a count of what we actually posted and
 *      when, not an in-memory tally that a deploy resets to zero mid-afternoon.
 *   4. PESTERING ONE PERSON. Someone who leaves four comments on one video gets
 *      one reply, resolved by an author+post lookup.
 *
 * It also answers the question the VA actually needs: who did we invite to DM
 * who never did? TikTok forbids a business opening a DM thread, so that follow
 * up can only be done by a human in the app — `getFollowUpQueue` is that list.
 *
 * Own SQLite file under /data, following the repo's store pattern (resolve path
 * → lazy singleton → init schema), because this subsystem owns its own data and
 * bolting it onto an unrelated database would make both harder to reason about.
 */
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function resolveCommentAgentDbPath() {
    const env = process.env.COMMENT_AGENT_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/comment-agent.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "comment-agent.db");
}
let db = null;
function initCommentAgentSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS comment_actions (
      comment_id         TEXT PRIMARY KEY,
      platform           TEXT NOT NULL,
      platform_post_id   TEXT NOT NULL,
      author_id          TEXT NOT NULL,
      author_username    TEXT,
      comment_text       TEXT,
      bucket             TEXT,
      decision           TEXT NOT NULL,
      reason             TEXT,
      reply_text         TEXT,
      posted_comment_id  TEXT,
      comment_created_at TEXT,
      acted_at           TEXT NOT NULL,
      dm_received_at     TEXT
    )
  `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_ca_author ON comment_actions(author_id)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_ca_post ON comment_actions(platform_post_id)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_ca_decision ON comment_actions(decision, acted_at)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_ca_posted ON comment_actions(posted_comment_id)`);
}
function getCommentAgentDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveCommentAgentDbPath());
        initCommentAgentSchema(db);
    }
    return db;
}
function rowToAction(r) {
    return {
        commentId: String(r.comment_id),
        platform: String(r.platform),
        platformPostId: String(r.platform_post_id),
        authorId: String(r.author_id),
        authorUsername: r.author_username == null ? null : String(r.author_username),
        commentText: r.comment_text == null ? null : String(r.comment_text),
        bucket: r.bucket == null ? null : String(r.bucket),
        decision: String(r.decision),
        reason: r.reason == null ? null : String(r.reason),
        replyText: r.reply_text == null ? null : String(r.reply_text),
        postedCommentId: r.posted_comment_id == null ? null : String(r.posted_comment_id),
        commentCreatedAt: r.comment_created_at == null ? null : String(r.comment_created_at),
        actedAt: String(r.acted_at),
        dmReceivedAt: r.dm_received_at == null ? null : String(r.dm_received_at),
    };
}
/** Have we already made a decision about this exact comment? */
function hasActedOnComment(commentId) {
    const row = getCommentAgentDb()
        .prepare(`SELECT 1 FROM comment_actions WHERE comment_id = ? LIMIT 1`)
        .get(commentId);
    return Boolean(row);
}
/**
 * Is this inbound comment one WE posted? The loop guard that does not depend on
 * TikTok telling us, because on TikTok's webhook it does not.
 */
function isOurOwnPostedComment(commentId) {
    const row = getCommentAgentDb()
        .prepare(`SELECT 1 FROM comment_actions WHERE posted_comment_id = ? LIMIT 1`)
        .get(commentId);
    return Boolean(row);
}
/** Did this person already get a reply on this video? One per author per post. */
function authorAlreadyAnsweredOnPost(authorId, platformPostId) {
    const row = getCommentAgentDb()
        .prepare(`SELECT 1 FROM comment_actions
        WHERE author_id = ? AND platform_post_id = ? AND decision = 'replied' LIMIT 1`)
        .get(authorId, platformPostId);
    return Boolean(row);
}
/** Replies actually posted since an ISO timestamp — the pacing counter. */
function repliesPostedSince(sinceIso) {
    const row = getCommentAgentDb()
        .prepare(`SELECT COUNT(*) AS n FROM comment_actions WHERE decision = 'replied' AND acted_at >= ?`)
        .get(sinceIso);
    return Number(row?.n ?? 0);
}
/** When the most recent reply went out, for minimum-spacing enforcement. */
function lastReplyPostedAt() {
    const row = getCommentAgentDb()
        .prepare(`SELECT acted_at FROM comment_actions WHERE decision = 'replied'
        ORDER BY acted_at DESC LIMIT 1`)
        .get();
    return row?.acted_at ?? null;
}
function recordCommentAction(a) {
    getCommentAgentDb()
        .prepare(`INSERT OR REPLACE INTO comment_actions
        (comment_id, platform, platform_post_id, author_id, author_username, comment_text,
         bucket, decision, reason, reply_text, posted_comment_id, comment_created_at, acted_at,
         dm_received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,
         (SELECT dm_received_at FROM comment_actions WHERE comment_id = ?))`)
        .run(a.commentId, a.platform, a.platformPostId, a.authorId, a.authorUsername, a.commentText, a.bucket, a.decision, a.reason, a.replyText, a.postedCommentId, a.commentCreatedAt, new Date().toISOString(), a.commentId);
}
/**
 * The commenter came through and DMed. Stamps every comment row for that author.
 *
 * Safe to call on every inbound DM: the commenter's platform id and the DM
 * `participantId` are the SAME string on TikTok (verified byte-for-byte against
 * a live thread), so this join needs no username matching and no guesswork. An
 * author with no comment rows simply updates nothing.
 */
function markCommenterDmReceived(authorId) {
    const res = getCommentAgentDb()
        .prepare(`UPDATE comment_actions SET dm_received_at = ?
        WHERE author_id = ? AND dm_received_at IS NULL`)
        .run(new Date().toISOString(), authorId);
    return res.changes ?? 0;
}
/**
 * People we publicly invited to DM who never did, oldest first.
 *
 * This is the VA's work queue and nothing else can do the job: TikTok will not
 * let a business open a DM thread through the API, so reaching these people is
 * a human opening the app. Deliberately one row per person rather than per
 * comment — the VA messages a person, not a comment.
 */
function getFollowUpQueue(olderThanHours = 24, limit = 100) {
    const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();
    const rows = getCommentAgentDb()
        .prepare(`SELECT author_id, author_username, platform_post_id, comment_text, bucket, reply_text,
              MIN(acted_at) AS invited_at
         FROM comment_actions
        WHERE decision = 'replied' AND dm_received_at IS NULL AND acted_at <= ?
        GROUP BY author_id
        ORDER BY invited_at ASC
        LIMIT ?`)
        .all(cutoff, limit);
    return rows.map((r) => ({
        authorId: String(r.author_id),
        authorUsername: r.author_username == null ? null : String(r.author_username),
        platformPostId: String(r.platform_post_id),
        commentText: r.comment_text == null ? null : String(r.comment_text),
        bucket: r.bucket == null ? null : String(r.bucket),
        replyText: r.reply_text == null ? null : String(r.reply_text),
        invitedAt: String(r.invited_at),
    }));
}
/** What the agent has actually done — for the status endpoint, not a guess. */
function getCommentAgentStats() {
    const d = getCommentAgentDb();
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    const one = (sql, ...p) => Number(d.prepare(sql).get(...p)?.n ?? 0);
    const byBucket = {};
    for (const r of d
        .prepare(`SELECT bucket, COUNT(*) AS n FROM comment_actions GROUP BY bucket`)
        .all()) {
        byBucket[String(r.bucket ?? "unclassified")] = Number(r.n ?? 0);
    }
    const byDecision = {};
    for (const r of d
        .prepare(`SELECT decision, COUNT(*) AS n FROM comment_actions GROUP BY decision`)
        .all()) {
        byDecision[String(r.decision)] = Number(r.n ?? 0);
    }
    return {
        totalSeen: one(`SELECT COUNT(*) AS n FROM comment_actions`),
        replied: one(`SELECT COUNT(*) AS n FROM comment_actions WHERE decision = 'replied'`),
        converted: one(`SELECT COUNT(DISTINCT author_id) AS n FROM comment_actions WHERE dm_received_at IS NOT NULL`),
        repliedLastHour: repliesPostedSince(hourAgo),
        repliedToday: repliesPostedSince(dayAgo),
        byBucket,
        byDecision,
        lastReplyAt: lastReplyPostedAt(),
    };
}
/** Recent decisions, newest first — for eyeballing what it is actually saying. */
function getRecentCommentActions(limit = 40) {
    const rows = getCommentAgentDb()
        .prepare(`SELECT * FROM comment_actions ORDER BY acted_at DESC LIMIT ?`)
        .all(limit);
    return rows.map(rowToAction);
}
