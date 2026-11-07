/**
 * SmartPoster pins — naming parse, slot assignment, shell tab, Harvey route.
 * Run after `npm run build`: node scripts/verify-smartposter.mjs
 */
import assert from "assert";
import { readFileSync } from "fs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
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

const root = mkdtempSync(join(tmpdir(), "smartposter-"));
process.env.TENANT_DATA_ROOT = root;

const captions = await import("../dist/src/integrations/smartPoster/captions.js");
const store = await import("../dist/src/core/smartPosterStore.js");

check("filename parse: dated platform slug", () => {
  const p = captions.parseVideoFileName("2026-11-07__tiktok__oak-hills-tour.mp4");
  assert.equal(p.targetDate, "2026-11-07");
  assert.deepEqual(p.platforms, ["tiktok"]);
  assert.match(p.slug, /oak hills tour/i);
});

check("filename parse: all platforms", () => {
  const p = captions.parseVideoFileName("2026-11-07__all__listing.mov");
  assert.deepEqual(p.platforms, ["all"]);
});

check("slot assignment spaces across the day", () => {
  const tz = "America/Chicago";
  const date = "2026-11-07";
  const slots = ["09:00", "12:30", "16:00"];
  const a = store.nextOpenSlot(date, [], slots, tz);
  const b = store.nextOpenSlot(date, [a], slots, tz);
  const c = store.nextOpenSlot(date, [a, b], slots, tz);
  assert.ok(a && b && c);
  assert.notEqual(a, b);
  assert.notEqual(b, c);
});

check("settings persist slots and autoSchedule", () => {
  const s = store.saveSettings({
    driveFolderId: "folder123",
    slots: ["10:00", "14:00"],
    autoSchedule: true,
    timezone: "America/Chicago",
  });
  assert.equal(s.driveFolderId, "folder123");
  assert.deepEqual(s.slots, ["10:00", "14:00"]);
  assert.equal(store.getSettings().autoSchedule, true);
});

check("shell Growth tab includes SmartPoster under analytics", () => {
  const shell = read("public/shell.html");
  assert(/key:\s*"smartposter"/.test(shell));
  assert(/label:\s*"SmartPoster"/.test(shell));
  assert(/src:\s*"\/smartposter"/.test(shell));
  assert(/smartposter:\s*null/.test(shell));
  const analyticsIdx = shell.indexOf('key: "analytics"');
  const smartIdx = shell.indexOf('key: "smartposter"');
  assert.ok(analyticsIdx >= 0 && smartIdx > analyticsIdx, "SmartPoster should follow Analytics in TABS");
});

check("page + routes + Zernio publish client exist", () => {
  assert(/SmartPoster/.test(read("public/smartposter.html")));
  assert(/registerSmartPosterRoutes/.test(read("src/server.ts")));
  assert(/maybeSmartPosterAutoSync|maybeAutoSync/.test(read("src/server.ts")));
  assert(/createZernioPost|\/media\/presign/.test(read("src/integrations/zernio/posts.ts")));
  assert(/YYYY-MM-DD__platform__slug/.test(read("public/smartposter.html")));
});

check("Harvey get_smartposter ships with the surface", () => {
  assert(/get_smartposter/.test(read("src/harvey/platformTools.ts")));
  assert(/get_smartposter/.test(read("src/harvey/work/capabilities.ts")));
});

rmSync(root, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error("FAIL:", f);
  process.exit(1);
}
