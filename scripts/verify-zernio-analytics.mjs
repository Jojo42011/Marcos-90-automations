/**
 * Pins Zernio analytics parsing + per-account Analytics payload shape.
 * Run after `npm run build`: node scripts/verify-zernio-analytics.mjs
 */
import assert from "assert";
import { readFileSync } from "fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const zernio = await import("../dist/src/integrations/zernio/index.js");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err.message}`);
  }
}

check("metricTotal reads insights metrics.<name>.total envelopes", () => {
  const metrics = {
    follower_count: { total: 5705 },
    likes_count: { total: 123003 },
    video_count: { total: 240 },
    views: { total: 16756 },
    page_follows: { total: 1 },
  };
  assert.equal(zernio.metricTotal(metrics, ["follower_count", "followers"]), 5705);
  assert.equal(zernio.metricTotal(metrics, ["likes_count", "likes"]), 123003);
  assert.equal(zernio.metricTotal(metrics, ["video_count"]), 240);
  assert.equal(zernio.metricTotal(metrics, ["views", "page_media_view"]), 16756);
  assert.equal(zernio.metricTotal(metrics, ["page_follows", "follower_count"]), 1);
  assert.equal(zernio.metricTotal(metrics, ["missing"]), null);
  assert.equal(zernio.metricTotal(null, ["follower_count"]), null);
});

check("integration exposes per-account fetch helpers", () => {
  assert.equal(typeof zernio.fetchAllZernioAccountAnalytics, "function");
  assert.equal(typeof zernio.fetchZernioAccount, "function");
  assert.equal(typeof zernio.fetchFollowerStats, "function");
  assert.equal(typeof zernio.listZernioAccounts, "function");
});

check("socialAnalytics builds account-scoped tabs from Zernio connections", () => {
  const src = read("src/core/socialAnalytics.ts");
  assert(/fetchAllZernioAccountAnalytics/.test(src));
  assert(/connectedAccounts/.test(src));
  assert(/accountLabel/.test(src));
  assert(/CANONICAL_PLATFORMS/.test(src));
});

check("Analytics UI reports connected account count", () => {
  const html = read("public/analytics.html");
  assert(/connectedAccounts/.test(html));
  assert(/connected on Zernio/.test(html));
});

check("Harvey social tools match by platform family and account id", () => {
  const tools = read("src/harvey/platformTools.ts");
  assert(/x\.platform === wanted/.test(tools));
  const harvey = read("src/harvey/tools.ts");
  assert(/tiktokAccounts/.test(harvey));
  assert(/p\.platform === "tiktok"/.test(harvey));
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error("FAIL:", f);
  process.exit(1);
}
