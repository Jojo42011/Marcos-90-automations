/**
 * Assertions for the collapsed DM opener (Aug 2026).
 *
 * The opener used to be a three-beat ladder: first-time-buyer question, wait;
 * breakdown offer, wait; number ask, wait. Kendrick's TikTok threads on Wesley's
 * account do all three in ONE message, and the observed gaps between DM turns are
 * DAYS, so each extra beat is a real chance to lose the lead.
 *
 * These pin the collapse in three places, because a partial collapse is worse than
 * none: the state machine must advance on the first turn, the prompts must not tell
 * the model to wait, and the no-LLM fallback text must still carry the ask.
 *
 * Run AFTER `npm run build`:  node scripts/verify-opener-collapse.mjs
 */
import { readFileSync } from "fs";
import assert from "assert";

let passed = 0; const failures = [];
function check(name, fn) { try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
async function checkAsync(name, fn) { try { await fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const { FunnelStage } = await import("../dist/src/core/state.js");
const { process: openingProcess } = await import("../dist/src/modules/03-tone-matched-dm/index.js");

/* generateMarcoOpeningReply hits Anthropic. These cases only assert the STATE the
   module lands on, so the reply text is irrelevant — but the call must not blow up
   the test on a missing key, so we drive the module and read lead.state only. */
const convo = (...turns) => ({
  leadId: "test",
  messages: turns.map(([role, text], i) => ({
    role, text, timestamp: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
  })),
});
const lead = (state, extra = {}) => ({
  id: "test", name: null, phone: null, email: null, platform: "tiktok",
  state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...extra,
});
async function stateAfter(l, c, opts = {}) {
  const r = await openingProcess(l, c, {
    leadRepeatedForAdvancement: false, leadLineRepeatForModel: false, coachingNote: "", ...opts,
  });
  return r.lead.state;
}

/* ── 1. The state machine advances on the FIRST turn ──────────────────────── */
await checkAsync("collapse: a brand-new lead reaches PhoneRequested after ONE outbound", async () => {
  const s = await stateAfter(lead(FunnelStage.New), convo(["user", "how much is this home?"]));
  assert.equal(s, FunnelStage.PhoneRequested,
    "the whole point of the collapse: no intermediate opening stage");
});
await checkAsync("collapse: leads stranded mid-ladder advance instead of waiting forever", async () => {
  for (const legacy of [FunnelStage.OpeningAskedFirstTime, FunnelStage.OpeningOfferedDetails]) {
    const s = await stateAfter(lead(legacy), convo(["user", "yeah first time"], ["assistant", "..."], ["user", "sounds good"]));
    assert.equal(s, FunnelStage.PhoneRequested, `${legacy} must not be a dead end`);
  }
});

/* ── 2. What the collapse deliberately did NOT flatten ────────────────────── */
await checkAsync("collapse: 'I already have an agent' still holds the opening phase", async () => {
  const s = await stateAfter(lead(FunnelStage.New), convo(["user", "I'm already working with an agent"]));
  assert.equal(s, FunnelStage.OpeningOfferedDetails,
    "a real objection is not a pacing beat — it must be answered before the funnel moves");
});
await checkAsync("collapse: has-an-agent BUT open to interviewing still advances", async () => {
  const s = await stateAfter(lead(FunnelStage.New), convo(["user", "I have an agent but I'm open to talking"]));
  assert.equal(s, FunnelStage.PhoneRequested);
});
await checkAsync("collapse: a repeated line does not re-ask on a loop", async () => {
  const c = convo(["user", "hey"], ["assistant", "..."], ["user", "hey"]);
  const s = await stateAfter(lead(FunnelStage.OpeningOfferedDetails), c, { leadRepeatedForAdvancement: true });
  assert.equal(s, FunnelStage.OpeningOfferedDetails, "holding position beats nagging");
});
await checkAsync("collapse: a phone already in the thread jumps straight past the ask", async () => {
  const s = await stateAfter(lead(FunnelStage.New), convo(["user", "sure, 210-310-9635"]));
  assert.equal(s, FunnelStage.PropertySent);
});

/* ── 3. Legacy stages are documented as legacy, not silently dead ─────────── */
check("collapse: both ladder stages survive in the enum and say what they now mean", () => {
  const s = read("src/core/state.ts");
  assert(/OpeningAskedFirstTime = "opening_asked_first_time"/.test(s),
    "the enum member must stay — live leads were persisted in it when this shipped");
  assert(/OpeningOfferedDetails = "opening_offered_details"/.test(s));
  assert(/LEGACY[\s\S]{0,300}OpeningOfferedDetails = /.test(s),
    "OpeningOfferedDetails is reachable only via the has-an-agent hold and must say so");
  assert(/Narrowed by the opener collapse/.test(s),
    "OpeningAskedFirstTime's meaning changed — an unexplained stage is how the pinned layer got missed");
});

/* ── 4. No prompt still tells the model to wait a turn ────────────────────── */
const PROMPTS = read("config/prompts.ts");
check("prompts: nothing defers the number ask to a later turn", () => {
  const banned = [
    /only after they (say yes|clearly agree|agree)/i,
    /ask for (a |the )?(mobile )?number only after/i,
    /then ask for number after they agree/i,
    /Do NOT ask for phone in Step 1/i,
    /(hold|defer|save).{0,30}number ask.{0,30}(next|later) turn/i,
  ];
  /* Match per line and skip prohibitions — the replacement rules say things like
     "Never hold the number ask for a later turn", and a naive whole-file scan
     flags the very prose that enforces the collapse. */
  const lines = PROMPTS.split("\n").filter(
    (l) => !/\b(never|do not|don't|no longer|used to|instead of)\b/i.test(l),
  );
  for (const re of banned) {
    const hit = lines.find((l) => re.test(l));
    assert(!hit, `a ladder rule survived in config/prompts.ts (${re}): ${hit}`);
  }
});
check("prompts: the TikTok opener states the one-beat rule in the imperative", () => {
  assert(/OFFERS THE BREAKDOWN AND ASKS FOR THE NUMBER IN THE SAME MESSAGE/.test(PROMPTS),
    "the rule the model actually reads must be unmissable, not buried in prose");
  assert(/Do NOT open by asking whether this is their first time/.test(PROMPTS),
    "the beat that was removed must be explicitly forbidden, or Haiku reinvents it");
});
check("prompts: qualification is ordered AFTER capture, never in front of it", () => {
  assert(/Qualification questions[\s\S]{0,120}AFTER you have the number/.test(PROMPTS));
});
check("prompts: nobody gets disqualified out of the opener", () => {
  assert(/Never disqualify a lead in the opener/.test(PROMPTS),
    "out-of-state / just-browsing leads still get the offer and the ask");
});
check("prompts: the shared reference blocks no longer teach the five-step ladder", () => {
  assert(!/FIVE-STEP FLOW/.test(PROMPTS),
    "toneMatchedOpening feeds BOTH the Instagram and TikTok opening prompts — a stale ladder there overrides the new rule");
  assert(/THE OPENING IS ONE BEAT, NOT A LADDER/.test(PROMPTS));
});
check("prompts: every TikTok tone anchor demonstrates the ask, not just the offer", () => {
  const block = PROMPTS.split("Tone anchors (paraphrase; never paste verbatim")[1] ?? "";
  const anchors = block.split("\n").filter((l) => /^- "/.test(l.trim()));
  assert(anchors.length >= 3, "expected the TikTok anchor examples");
  for (const a of anchors) {
    assert(/number/i.test(a), `an anchor models the old shape (offer with no ask): ${a.trim()}`);
  }
});

/* ── 5. The no-LLM fallback carries the ask too ───────────────────────────── */
check("fallback: New-stage replies end with a number ask even when the model is down", () => {
  const s = read("src/integrations/llm/index.ts");
  const fn = s.split("function fallbackOpeningReply")[1];
  assert(fn, "fallbackOpeningReply must still exist");
  const body = fn.split("\nfunction ")[0];
  const returns = body.match(/return `[^`]*`/g) ?? [];
  assert(returns.length >= 3, "expected several fallback branches");
  const askless = returns.filter((r) => !/number/i.test(r));
  assert.equal(askless.length, 0,
    `fallback branch with no number ask (an outage would silently restore the ladder): ${askless[0]}`);
});

/* ── 6. The PINNED replies, which fire BEFORE the model ───────────────────── *
 * These are the ones that actually answer the most common opening questions.
 * The first cut of this change missed them entirely: a live simulate returned a
 * bare "would it help if I sent over the entire breakdown?" with no ask, because
 * pipeline.ts short-circuits to a pinned constant and never reaches module 03.
 * Prompt-level collapse is worthless if the deterministic layer still ladders. */
await checkAsync("pinned: the price reply asks for the number in the same message", async () => {
  const { MARCO_PRICE_REPLY, MARCO_CITY_REPLY } = await import("../dist/config/prompts.js");
  for (const [name, text] of [["price", MARCO_PRICE_REPLY], ["city", MARCO_CITY_REPLY]]) {
    assert(/number/i.test(text), `the pinned ${name} reply offers without asking: ${text}`);
    assert(/\?/.test(text), `the pinned ${name} reply must end on a question`);
  }
});
check("pinned: offer-shaped pinned paths advance to PhoneRequested, not the legacy stage", () => {
  const s = read("src/app/pipeline.ts");
  for (const guard of ["messageAsksPropertyPriceOrCost(latestLeadText)", "messageAsksWhatCity(latestLeadText)"]) {
    const after = s.split(guard)[1] ?? "";
    const window = after.slice(0, 400);
    assert(/FunnelStage\.PhoneRequested/.test(window),
      `${guard} must land the lead where its own reply points`);
    assert(!/FunnelStage\.OpeningAskedFirstTime/.test(window),
      `${guard} still parks the lead in the ladder stage`);
  }
});
check("pinned: clarifier paths may still hold, and state.ts says so honestly", () => {
  const s = read("src/core/state.ts");
  assert(/pinned CLARIFYING question is outstanding/.test(s),
    "the narrowed meaning of this stage must be documented, not left claiming nothing enters it");
});

/* ── 7. The phone-only delivery rule is untouched by all of this ──────────── */
check("regression: phone-only delivery survives the rewrite", () => {
  assert(/Never ask "phone or email"/.test(PROMPTS), "the phone-only rule must not have been edited away");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  ✗ " + f); process.exit(1); }
