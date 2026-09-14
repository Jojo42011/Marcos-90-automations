/**
 * verify-comment-agent.mjs — the TikTok comment agent.
 *
 * The happy path here is the least interesting thing to test. What can hurt is
 * public and permanent: a loop where the agent answers itself under Marco's
 * video, a price posted in a comment, a backlog swept in one afternoon. So most
 * of these checks are refusals, and the suite drives the REAL agent against a
 * real SQLite ledger with the Zernio calls stubbed at the module boundary.
 *
 * Run:  node scripts/verify-comment-agent.mjs
 * Expects a built dist/ (npm run build).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "comment-agent-"));
process.env.COMMENT_AGENT_DB_PATH = path.join(tmp, "ca.db");
process.env.COMMENT_AGENT_ENABLED = "true";
process.env.COMMENT_AGENT_MAX_PER_HOUR = "500";
process.env.COMMENT_AGENT_MAX_PER_DAY = "500";
process.env.COMMENT_AGENT_MIN_SPACING_SEC = "0";
process.env.COMMENT_AGENT_MAX_COMMENT_AGE_HOURS = "48";
delete process.env.ANTHROPIC_API_KEY;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

/* dist/ is CommonJS, so require() hands back the live exports object and the two
   NETWORK calls can be swapped there — the agent reaches them through the module
   namespace, so the swap is what it actually calls. Classification is different:
   the agent calls it locally, so it comes in through the documented `classify`
   seam instead of a patch that would silently not apply. */
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

const store = require_("../dist/src/core/commentAgentStore.js");
const comments = require_("../dist/src/integrations/zernio/comments.js");
const agent = require_("../dist/src/agents/commentAgent/index.js");

let readBackImpl = async () => ({
  found: true, isOwner: false, canReply: true, username: "janeb",
  text: null, isHidden: false, replyCount: 0,
});
let postImpl = async () => ({ success: true, status: 200, postedCommentId: "ourreply_1" });
let posted = [];
comments.readBackComment = (...a) => readBackImpl(...a);
comments.postCommentReply = (...a) => { posted.push(a[0]); return postImpl(...a); };

let draftImpl = async () => ({ bucket: "high_intent", reply: "Shoot me a DM and I'll send the full breakdown.", reason: "asked price" });
const run = (e, acct, extra = {}) => agent.handleInboundComment(e, acct, { classify: (...a) => draftImpl(...a), ...extra });

let n = 0;
function evt(over = {}) {
  n += 1;
  return {
    eventId: `evt_${n}`,
    commentId: over.commentId ?? `c_${n}`,
    platformPostId: over.platformPostId ?? "vid_1",
    postId: "zpost_1",
    platform: "tiktok",
    text: "text" in over ? over.text : "How much is this one?",
    authorId: over.authorId ?? `author_${n}`,
    authorUsername: over.authorUsername ?? "janeb",
    createdAt: over.createdAt ?? new Date().toISOString(),
    isReply: false,
    parentCommentId: null,
  };
}
const ACCT = "acct_1";

// ─────────────────────────── PARSER ───────────────────────────
console.log("\nPARSER — what reaches the agent at all");
const wire = (over = {}) => ({
  id: "evt_wire", event: over.event ?? "comment.received",
  comment: {
    id: over.id ?? "c_wire", postId: "zp", platformPostId: over.platformPostId ?? "vid_9",
    platform: "tiktok", text: "text" in over ? over.text : "Info please",
    author: "author" in over ? over.author : { id: "a_wire" },
    createdAt: "2026-09-14T10:00:00Z", isReply: false, parentCommentId: null,
  },
  post: {}, account: { accountId: ACCT, platform: "tiktok" }, timestamp: "2026-09-14T10:00:00Z",
});
check("comment.received parses", comments.parseZernioInboundComment(wire()) !== null);
check("a DM event is not a comment", comments.parseZernioInboundComment({ ...wire(), event: "message.received" }) === null);
check("no author id is refused", comments.parseZernioInboundComment(wire({ author: {} })) === null);
check("garbage refused", comments.parseZernioInboundComment({ nope: 1 }) === null);
check(
  "TikTok's thin webhook (author id only, no username) still parses",
  comments.parseZernioInboundComment(wire({ author: { id: "a_only" } }))?.authorId === "a_only",
);

// ─────────────────────── COPY VETTING ────────────────────────
console.log("\nCOPY — what must never reach a public comment");
const vet = agent.vetCommentReply;
check("a normal reply passes", vet("Shoot me a DM and I'll send the breakdown.").ok);
check("a dollar price is refused", !vet("It's $534,149, DM me").ok);
check("a comma-formatted price is refused", !vet("Around 534,149 for this one").ok);
check("a bare 6-digit price is refused", !vet("Listed at 534149 right now").ok);
check("a street address is refused", !vet("It's 1234 Rockcress Rd, DM me").ok);
check("a wall of text is refused", !vet("x".repeat(240)).ok);
check("no draft is refused", !vet(null).ok);
check(
  "an em dash is repaired, not rejected",
  vet("Got it — DM me and I'll send it").text === "Got it, DM me and I'll send it",
);
check(
  "a hyphen used as a pause is repaired",
  vet("Sure thing - DM me").text === "Sure thing, DM me",
);
/* These three came out of the live dry-run against production, not imagination:
   asked "why can't you just post the price", the model answered "San Antonio,
   mid 500s" for a home whose price it had never been given, asserted a listing
   was "still on the market", and wrote "Dm". */
check('an invented price BAND is refused ("mid 500s")', !vet("San Antonio, mid 500s. DM me").ok);
check('"high 400s" is refused', !vet("Probably high 400s, DM me").ok);
check('"around 500k" is refused', !vet("Around 500k for this one").ok);
check('"starts in the 600s" is refused', !vet("Starts in the 600s, DM me").ok);
check("asserting it is still on the market is refused", !vet("Yep, still on the market. DM me").ok);
check("asserting it is sold is refused", !vet("That one's under contract already").ok);
check(
  "but offering to CHECK availability is allowed",
  vet("DM me and I'll check if it's still available").ok,
);
check("the city alone is still allowed", vet("San Antonio! DM me and I'll send the details.").ok);
check('"Dm" is normalised to "DM"', vet("Dm me and I'll send it").text === "DM me and I'll send it");

// ───────────────────── DECISION PIPELINE ─────────────────────
console.log("\nGUARDS — the refusals that protect the account");

let o = await run(evt({ commentId: "c_ok", authorId: "a_ok" }), ACCT);
check("a high-intent comment gets a reply posted", o.decision === "replied", o.reason);
check("the reply we posted is recorded for the loop guard", store.isOurOwnPostedComment("ourreply_1"));

o = await run(evt({ commentId: "c_ok", authorId: "a_ok" }), ACCT);
check("the same comment twice is refused", o.decision === "skipped_duplicate");

o = await run(evt({ commentId: "ourreply_1" }), ACCT);
check("LOOP GUARD 1: our own posted reply coming back is refused", o.decision === "skipped_own_comment");

readBackImpl = async () => ({ found: true, isOwner: true, canReply: true, username: "puga.realtor", text: "ours", isHidden: false, replyCount: 0 });
o = await run(evt(), ACCT);
check("LOOP GUARD 2: isOwner on read-back is refused", o.decision === "skipped_own_comment");

readBackImpl = async () => ({ found: false, isOwner: false, canReply: false, username: null, text: null, isHidden: false, replyCount: 0 });
o = await run(evt(), ACCT);
check("a comment we cannot read back FAILS CLOSED", o.decision === "skipped_cannot_reply");

readBackImpl = async () => ({ found: true, isOwner: false, canReply: false, username: "x", text: "hi", isHidden: false, replyCount: 0 });
o = await run(evt(), ACCT);
check("canReply:false is respected", o.decision === "skipped_cannot_reply");

readBackImpl = async () => ({ found: true, isOwner: false, canReply: true, username: "janeb", text: null, isHidden: false, replyCount: 0 });

o = await run(evt({ createdAt: new Date(Date.now() - 100 * 3600_000).toISOString() }), ACCT);
check("a 100-hour-old comment is not answered (no backlog sweeping)", o.decision === "skipped_too_old");

o = await run(evt({ authorId: "a_ok", platformPostId: "vid_1" }), ACCT);
check("the same person twice on one video gets one reply", o.decision === "skipped_author_already_answered");

o = await run(evt({ authorId: "a_ok", platformPostId: "vid_OTHER" }), ACCT);
check("but the same person on a DIFFERENT video is answered", o.decision === "replied", o.reason);

o = await run(evt({ text: "" }), ACCT);
check("an empty comment is skipped", o.decision === "skipped_bucket");

console.log("\nBUCKETS — only three of five earn a reply");
for (const b of ["skip", "social", "frustrated", "casual"]) {
  draftImpl = async () => ({ bucket: b, reply: b === "skip" ? null : "Nice one, DM me and I'll send details.", reason: b });
  o = await run(evt(), ACCT);
  if (b === "skip") check("bucket skip posts nothing", o.decision === "skipped_bucket");
  else check(`bucket ${b} replies`, o.decision === "replied", o.reason);
}

draftImpl = async () => ({ bucket: "high_intent", reply: "It's $534,149, DM me", reason: "price" });
o = await run(evt(), ACCT);
check("a model that drafts a PRICE is blocked at the gate, not posted",
  o.decision === "failed" && /price/.test(o.reason), o.reason);

const postedBeforeNullDraft = posted.length;
draftImpl = async () => null;
o = await run(evt(), ACCT);
check("no classifier means SILENCE, never a canned template",
  o.decision === "failed" && posted.length === postedBeforeNullDraft, o.reason);

draftImpl = async () => ({ bucket: "high_intent", reply: "Shoot me a DM, happy to send it.", reason: "ok" });

console.log("\nPACING — enforced against the ledger, before any model call");
/* The cap counts replies already in the ledger, so it is set relative to what
   the earlier sections posted: allow exactly 3 more, then attempt 9. */
const before = store.getCommentAgentStats().replied;
process.env.COMMENT_AGENT_MAX_PER_HOUR = String(before + 3);
process.env.COMMENT_AGENT_MAX_PER_DAY = String(before + 3);
let capped = 0, allowed = 0;
for (let i = 0; i < 9; i++) {
  const r = await run(evt(), ACCT);
  if (r.decision === "skipped_rate_limit") capped++;
  if (r.decision === "replied") allowed++;
}
const after = store.getCommentAgentStats();
check(`the cap let exactly 3 through and throttled the rest (${allowed} posted, ${capped} throttled)`,
  allowed === 3 && capped === 6, `allowed ${allowed}, capped ${capped}`);
check("the ledger never went past the cap", after.replied === before + 3, `got ${after.replied}`);
check("throttling costs no model call (it is checked before classify)",
  (await run(evt(), ACCT, { classify: async () => { throw new Error("classifier must not be reached"); } })).decision === "skipped_rate_limit");

process.env.COMMENT_AGENT_ENABLED = "false";
o = await run(evt({ commentId: "c_killed" }), ACCT);
check("KILL SWITCH stops posting immediately", o.decision === "skipped_disabled");
process.env.COMMENT_AGENT_ENABLED = "true";

console.log("\nATTRIBUTION & THE VA QUEUE");
const q0 = store.getFollowUpQueue(0, 100);
check("people invited to DM appear on the VA follow-up queue", q0.length > 0, `got ${q0.length}`);
check("the queue is one row per person, not per comment", new Set(q0.map((r) => r.authorId)).size === q0.length);

const marked = store.markCommenterDmReceived("a_ok");
check("a DM from a commenter is attributed by id alone", marked > 0, `marked ${marked}`);
const q1 = store.getFollowUpQueue(0, 100);
check("and they drop off the VA queue once they DM", !q1.some((r) => r.authorId === "a_ok"));
check("converted count reflects the real join", store.getCommentAgentStats().converted >= 1);
check("a DM from someone who never commented marks nothing", store.markCommenterDmReceived("stranger_9") === 0);

console.log("\nLEDGER");
const s = store.getCommentAgentStats();
check("every decision is recorded with a reason", s.totalSeen > 0 && Object.keys(s.byDecision).length >= 4);
check("recent actions are readable for review", store.getRecentCommentActions(5).length > 0);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
