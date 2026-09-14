/**
 * Zernio comment surface — reading TikTok comments and posting public replies.
 *
 * Separate from `dm.ts` because the two carry different risk. A DM reply is
 * seen by one person who asked for it; a comment reply is permanently attached
 * to Marco's video, visible to everyone who watches it afterwards. The guards
 * that matter here are about not embarrassing the account in public.
 *
 * WHY WE READ THE COMMENT BACK AFTER THE WEBHOOK FIRES. TikTok's
 * `comment.received` payload is thinner than every other platform's: Zernio
 * documents it as carrying "only the author id (no username, picture, or owner
 * flag)". That missing owner flag is the dangerous one — our own replies are
 * re-delivered as comment events, and with no way to recognise them the agent
 * would answer itself, publicly, on a loop. The REST read
 * (`GET /inbox/comments/{postId}`) does return `from.username`, `from.isOwner`
 * and `canReply`, verified against live comments on @puga.realtor. So the
 * webhook tells us something happened and the REST read tells us whether we are
 * allowed to act on it.
 *
 * COMMENT-TO-DM IS NOT AVAILABLE ON TIKTOK and no API provides it — Instagram
 * and Facebook are the only platforms exposing private-reply-to-comment. That is
 * the entire reason this agent posts a PUBLIC reply asking the person to DM,
 * rather than DMing them directly. TikTok also forbids a business opening a DM
 * thread at all, so the lead sending that DM is what legitimately opens the
 * 48-hour window the DM agent replies inside.
 */
import { randomUUID } from "crypto";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";

function apiKey(): string {
  return process.env.ZERNIO_DM_API_KEY?.trim() ?? "";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function zernioFetch(
  path: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(`${ZERNIO_API_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* Non-JSON error bodies exist; raw text is kept for the caller's log. */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/** A `comment.received` event, reduced to what this agent acts on. */
export interface ZernioInboundComment {
  eventId: string;
  commentId: string;
  /** TikTok video id. */
  platformPostId: string;
  /** Zernio's internal post id — null for posts not published through Zernio. */
  postId: string | null;
  platform: string;
  text: string;
  authorId: string;
  /** Absent on TikTok's webhook; filled in by the REST read when available. */
  authorUsername: string | null;
  createdAt: string | null;
  isReply: boolean;
  parentCommentId: string | null;
}

/**
 * Normalize a `comment.received` body, or null when it is not something to act
 * on.
 *
 * Refuses a comment with no author id: without it there is no way to dedupe per
 * person, and no way to tie a later DM back to the comment that caused it.
 */
export function parseZernioInboundComment(body: unknown): ZernioInboundComment | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.event !== "comment.received") return null;

  const c = (b.comment ?? {}) as Record<string, unknown>;
  const author = (c.author ?? {}) as Record<string, unknown>;

  const commentId = str(c.id);
  const platformPostId = str(c.platformPostId);
  const authorId = str(author.id);
  if (!commentId || !platformPostId || !authorId) return null;

  return {
    eventId: str(b.id) ?? `${commentId}:${randomUUID()}`,
    commentId,
    platformPostId,
    postId: str(c.postId),
    platform: str(c.platform) ?? "tiktok",
    text: str(c.text) ?? "",
    authorId,
    authorUsername: str(author.username),
    createdAt: str(c.createdAt),
    isReply: c.isReply === true,
    parentCommentId: str(c.parentCommentId),
  };
}

export interface CommentReadBack {
  found: boolean;
  /** True when the connected account authored it — the primary loop guard. */
  isOwner: boolean;
  /** False when the platform will not accept a reply to this comment. */
  canReply: boolean;
  username: string | null;
  text: string | null;
  isHidden: boolean;
  /** How many replies the comment already has, ours included. */
  replyCount: number;
}

/**
 * Re-read one comment from the post to recover what the webhook left out.
 *
 * Returns `found: false` on any failure rather than throwing, and the caller
 * treats not-found as "do not reply". Failing closed is the right default: the
 * cost of skipping one comment is one missed lead, and the cost of replying
 * blind is a public loop on Marco's video.
 */
export async function readBackComment(
  platformPostId: string,
  commentId: string,
  accountId: string,
): Promise<CommentReadBack> {
  const miss: CommentReadBack = {
    found: false,
    isOwner: false,
    canReply: false,
    username: null,
    text: null,
    isHidden: false,
    replyCount: 0,
  };
  if (!apiKey()) return miss;
  try {
    const qs = new URLSearchParams({ accountId, limit: "100" });
    const r = await zernioFetch(
      `/inbox/comments/${encodeURIComponent(platformPostId)}?${qs}`,
      { method: "GET" },
    );
    if (!r.ok) return miss;
    const payload = r.json as { comments?: unknown; data?: unknown } | null;
    const list = (Array.isArray(payload?.comments)
      ? payload?.comments
      : Array.isArray(payload?.data)
        ? payload?.data
        : []) as Record<string, unknown>[];

    /* Top-level comments carry up to three inline replies on TikTok, so the
       comment we want may be nested one level down. */
    const flat: Record<string, unknown>[] = [];
    for (const top of list) {
      flat.push(top);
      const replies = Array.isArray(top.replies) ? (top.replies as Record<string, unknown>[]) : [];
      for (const rep of replies) flat.push(rep);
    }

    const hit = flat.find((m) => str(m.id) === commentId);
    if (!hit) return miss;
    const from = (hit.from ?? {}) as Record<string, unknown>;
    return {
      found: true,
      isOwner: from.isOwner === true,
      canReply: hit.canReply !== false,
      username: str(from.username) ?? str(from.name),
      /* REST spells the body `message`; the webhook spells it `text`. */
      text: str(hit.message) ?? str(hit.text),
      isHidden: hit.isHidden === true,
      replyCount: typeof hit.replyCount === "number" ? hit.replyCount : 0,
    };
  } catch {
    return miss;
  }
}

export interface PostCommentReplyResult {
  success: boolean;
  status: number;
  /** The id of OUR reply. Recorded so we never treat it as an inbound comment. */
  postedCommentId?: string;
  error?: string;
}

/**
 * Post a public reply under one comment.
 *
 * `idempotencyKey` is derived from the comment being answered, so a webhook
 * retry replays the original response instead of posting a second reply. Zernio
 * scopes these keys to the path, so the same key cannot collide across posts.
 */
export async function postCommentReply(input: {
  platformPostId: string;
  commentId: string;
  accountId: string;
  message: string;
  idempotencyKey?: string;
}): Promise<PostCommentReplyResult> {
  if (!apiKey()) {
    return { success: false, status: 0, error: "ZERNIO_DM_API_KEY is not set" };
  }
  const message = input.message?.trim();
  if (!message) return { success: false, status: 0, error: "Empty reply, nothing posted" };

  try {
    const r = await zernioFetch(`/inbox/comments/${encodeURIComponent(input.platformPostId)}`, {
      method: "POST",
      headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {},
      body: JSON.stringify({
        accountId: input.accountId,
        message,
        commentId: input.commentId,
      }),
    });
    if (!r.ok) {
      return { success: false, status: r.status, error: r.text.slice(0, 400) || `HTTP ${r.status}` };
    }
    const d = (r.json ?? {}) as { data?: { commentId?: unknown }; commentId?: unknown };
    return {
      success: true,
      status: r.status,
      postedCommentId: str(d.data?.commentId) ?? str(d.commentId) ?? undefined,
    };
  } catch (err) {
    return {
      success: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
