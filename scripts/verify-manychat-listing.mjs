/**
 * Assertions for the ManyChat listing_id wiring (Aug 2026).
 *
 * The DM agent used to open every thread blind — it had no idea which home the
 * lead messaged about, so it could not answer specifics and leaned on "would it
 * help if I sent the breakdown" as the only honest move. ManyChat already knows
 * which post fired the automation; passing it through removes that gap.
 *
 * The dangerous failure mode here is NOT "no listing" — that is the safe default
 * and always was. It is linking the WRONG listing, because the matcher, the
 * drips and the property PDF all key off `mlsListingKey` and would confidently
 * send a real lead the wrong house. Most of these assertions guard that.
 *
 * Run AFTER `npm run build`:  node scripts/verify-manychat-listing.mjs
 */
import { readFileSync } from "fs";
import assert from "assert";

let passed = 0; const failures = [];
function check(name, fn) { try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
async function checkAsync(name, fn) { try { await fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const { fromSimplyRets, upsertListings, getListing } = await import("../dist/src/core/listingsStore.js");
const { resolveInboundListingRef } = await import("../dist/src/app/inboundListing.js");

/* A listing the resolver can actually find. mlsId is the listingKey, listingId
   is the MLS number — a ManyChat field could plausibly hold either. */
upsertListings([fromSimplyRets({
  mlsId: "VERIFY-LR-1", listingId: "9911223", listPrice: 615000, modified: "2026-08-01T10:00:00Z",
  address: { full: "77 Verify Way", city: "San Antonio", state: "TX", postalCode: "78201" },
  property: { bedrooms: 4, bathrooms: 3, area: 2400, yearBuilt: 2021 },
  mls: { status: "Active" }, photos: [],
})]);

/* ── 1. Resolution: both id shapes, and the safe default ──────────────────── */
check("resolve: a listingKey from ManyChat links the lead", () => {
  const r = resolveInboundListingRef("VERIFY-LR-1", null);
  assert.equal(r.outcome, "resolved");
  assert.equal(r.listingKey, "VERIFY-LR-1");
  assert(/77 Verify Way/.test(r.address), `address should be human-readable, got ${r.address}`);
});
check("resolve: an MLS number works too — a ManyChat field holds whichever was pasted", () => {
  const r = resolveInboundListingRef("9911223", null);
  assert.equal(r.outcome, "resolved");
  assert.equal(r.listingKey, "VERIFY-LR-1", "must normalize to the canonical key, not store the MLS number");
});
check("resolve: no ref at all is the ordinary case, not an error", () => {
  for (const empty of [null, undefined, "", "   "]) {
    assert.equal(resolveInboundListingRef(empty, null).outcome, "none");
  }
});

/* ── 2. The failure modes that would send a lead the wrong house ──────────── */
check("resolve: an id the MLS mirror cannot confirm is DROPPED, never stored", () => {
  const r = resolveInboundListingRef("not-a-real-listing-id", null);
  assert.equal(r.outcome, "unresolved");
  assert.equal(r.listingKey, undefined,
    "a stale/typo'd/Zillow id must not become a link — wrong is worse than absent");
});
check("resolve: an existing link is never overwritten by a later inbound", () => {
  const r = resolveInboundListingRef("VERIFY-LR-1", "SOME-OTHER-KEY");
  assert.equal(r.outcome, "conflict");
  assert.equal(r.listingKey, "VERIFY-LR-1", "the conflict must still report what it saw, for the log");
});
check("resolve: re-sending the same listing is a no-op, not a conflict", () => {
  assert.equal(resolveInboundListingRef("VERIFY-LR-1", "VERIFY-LR-1").outcome, "already_linked");
});
check("pipeline: only a clean 'resolved' ever writes to the lead", () => {
  const s = read("src/app/pipeline.ts");
  const block = s.split("resolveInboundListingRef(payload.listingRef")[1]?.slice(0, 900) ?? "";
  assert(block, "the resolver must be called in the pipeline");
  assert(/outcome === "resolved"/.test(block), "the write must be gated on a confirmed match");
  assert(/mlsListingKey: listingRef\.listingKey/.test(block));
  assert(/marcoLog\("inbound_listing_ref"/.test(block),
    "every outcome must be logged — a silently dropped id is unexplainable in production");
});

/* ── 3. Intake accepts what a ManyChat flow would plausibly send ──────────── */
check("webhook: the field aliases cover how someone would actually name it", () => {
  const s = read("src/app/webhook.ts");
  for (const k of ["listing_id", "listingId", "listing_key", "mls_number", "property_id"]) {
    assert(new RegExp(`"${k}"`).test(s), `alias ${k} not accepted`);
  }
  assert(/typeof v === "number" && Number\.isFinite\(v\)/.test(
    s.split("function pickListingRef")[1]?.slice(0, 600) ?? ""),
    "an MLS number in a ManyChat custom field often arrives unquoted");
});
check("webhook: listingRef is set on every payload the parser returns", () => {
  const s = read("src/app/webhook.ts");
  const returns = (s.match(/marcoPreviousOutbound:[^\n]*\n/g) ?? []).length;
  const refs = (s.match(/listingRef:/g) ?? []).length;
  assert(refs >= returns, `${returns} payload sites but only ${refs} set listingRef`);
});
check("sms: SMS has no originating post and says so rather than guessing", () => {
  assert(/listingRef: null/.test(read("src/integrations/sinch/index.ts")));
});

/* ── 4. The agent must USE it — that was the whole point ──────────────────── */
check("prompt: a known listing forbids the 'which property?' round trip", () => {
  const s = read("src/integrations/llm/index.ts");
  const fn = s.split("function knownListingBlock")[1]?.split("\nfunction ")[0] ?? "";
  assert(fn, "knownListingBlock must exist");
  assert(/Never ask them which property they mean/.test(fn),
    "removing that round trip is the entire reason this was built");
  assert(/screenshot/.test(fn), "the screenshot ask is the same round trip wearing a hat");
  assert(/Do not invent any fact that is not listed here/.test(fn));
});
check("prompt: knowing the price still does not license quoting it in a DM", () => {
  const s = read("src/integrations/llm/index.ts");
  const fn = s.split("function knownListingBlock")[1]?.split("\nfunction ")[0] ?? "";
  assert(/Do NOT state the list price/.test(fn),
    "the neutral-DM price rule is independent of whether we know the number");
  assert(/neutralDm/.test(fn), "the rule must be conditioned on the DM flow, not applied blindly");
});
check("prompt: the block is actually injected into the opening request", () => {
  const s = read("src/integrations/llm/index.ts");
  assert(/knownListingBlock\(lead, isNeutralDmFlow\(/.test(s),
    "a block that is never added to userBlock does nothing");
});
check("prompt: an unlinked lead adds nothing at all (no empty scaffolding)", () => {
  const s = read("src/integrations/llm/index.ts");
  const fn = s.split("function knownListingBlock")[1]?.split("\nfunction ")[0] ?? "";
  assert(/if \(!key\) return "";/.test(fn));
  assert(/if \(!listing\) return "";/.test(fn),
    "a link pointing at a listing that left the feed must degrade to silence, not a half-block");
});

/* ── 5. Runtime directives must not re-ladder what the collapse removed ───── */
check("regression: the injected turn directives no longer defer the number ask", () => {
  const s = read("src/integrations/llm/index.ts");
  const banned = [
    /Number ask comes after they agree/i,
    /Do not ask for (a |their )?phone number in (the same reply|this reply) unless/i,
    /next turn can ask for a good mobile number/i,
  ];
  for (const re of banned) {
    assert(!re.test(s),
      `a per-turn directive still ladders (${re}) — these are injected at runtime and override the system prompt`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  ✗ " + f); process.exit(1); }
