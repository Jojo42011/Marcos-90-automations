#!/usr/bin/env node
/**
 * Harvey can see the operator's screen.
 *
 * THE REPORT: "the chrome harvey still doesn't have the capability to see
 * what's going on in the screen."
 *
 * THE CAUSE, which was two things:
 *
 *   1. By design, the extension reports only the tab HARVEY drives, never the
 *      one the human is looking at. That part is correct and stays — reporting
 *      whatever the operator just clicked would make Harvey act somewhere else
 *      entirely (see pollOnce's comment). But it meant that with no tab of his
 *      own, Harvey could see NOTHING, and "look at my screen" answered "no
 *      page open to act on yet".
 *
 *   2. The escape hatch — drag a tab into the "Harvey" tab group — could never
 *      work: `groupWorkTabs()` guards on `chrome.tabGroups`, and the manifest
 *      never requested the `tabGroups` permission, so the guard returned early
 *      every single time and the group never appeared. A documented feature,
 *      guarded, and dead.
 *
 * This suite drives the REAL server with a SIMULATED extension — polling,
 * answering commands, returning a real JPEG — because the failure was in the
 * contract between the two halves, and testing either half alone would have
 * missed it.
 *
 * Usage: node scripts/verify-harvey-browser-vision.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 4004;
const B = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-browser-token-abcdefghijklmnop";
const tmp = mkdtempSync(join(tmpdir(), "harvey-vision-"));
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

/* ---- static checks on the extension itself ------------------------------ */
const manifest = JSON.parse(readFileSync("public/extension/manifest.json", "utf8"));
const bg = readFileSync("public/extension/background.js", "utf8");

ok("the extension requests the tabGroups permission",
  manifest.permissions.includes("tabGroups"), JSON.stringify(manifest.permissions));
/* The guard that made the feature dead is only safe once the permission exists. */
ok("grouping is still guarded for older Chrome rather than assumed",
  /if \(!chrome\.tabs\.group \|\| !chrome\.tabGroups\)/.test(bg));
ok("screenshot is a read-only action that may adopt the operator's tab",
  /READ_ONLY = new Set\(\[[^\]]*"screenshot"/.test(bg), "screenshot missing from READ_ONLY");
ok("read is too", /READ_ONLY = new Set\(\[[^\]]*"read"/.test(bg));
/* The line that must NOT be crossed: adopting the human's tab and then
   clicking inside it is the surprise that would make this dangerous. */
for (const act of ["click", "fill", "navigate", "scroll"]) {
  ok(`'${act}' is NOT read-only, so it never silently adopts the operator's tab`,
    !new RegExp(`READ_ONLY = new Set\\(\\[[^\\]]*"${act}"`).test(bg));
}
ok("the poll reports the operator's tab separately from Harvey's",
  /operatorTab/.test(bg) && /page: tabInfo, operatorTab/.test(bg));

/* ---- the live loop ------------------------------------------------------ */
writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 1, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks: [] }));
const env = { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
  /* `name:token` pairs — a bare token is not a valid config and pairs nothing. */
  BROWSER_CONTROL_TOKENS: `Marco:${TOKEN}`,
  DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
  DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db") };
delete env.BRIVITY_API_KEY;
const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch {} });
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

/* A 1x1 JPEG — a real image, so the base64 round trip is exercised for real. */
const JPEG_1PX = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAA" +
  "AAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

/** Stand in for the extension: poll, answer, report the operator's tab. */
let sawOperatorTab = null;
async function extensionTick({ answer }) {
  const r = await fetch(B + "/api/browser/poll", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: TOKEN, enabled: true, deviceId: "test-device", deviceName: "Test Chrome",
      page: { url: "https://example.com/harvey-tab", title: "Harvey's tab" },
      operatorTab: { url: "https://marcos-screen.example/listing/123", title: "What Marco is looking at" },
      waitMs: 2500,
    }),
  });
  const j = await r.json();
  for (const cmd of j.commands || []) {
    await fetch(B + "/api/browser/result", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, id: cmd.id, ...answer(cmd) }),
    });
  }
  return j;
}

try {
  // one poll to register the device and deliver operatorTab
  await extensionTick({ answer: () => ({ ok: true, data: "noop" }) });
  const status = await (await fetch(B + `/api/browser/status?token=${TOKEN}`)).json();
  const dev = (status.devices || [])[0];
  ok("the device registers", !!dev, JSON.stringify(status).slice(0, 160));
  ok("the server records what HARVEY's tab is",
    dev && /harvey-tab/.test(dev.page?.url || ""), JSON.stringify(dev?.page));
  ok("and separately what the OPERATOR is looking at",
    dev && /marcos-screen/.test(dev.operatorTab?.url || ""), JSON.stringify(dev?.operatorTab));
  ok("the two are not confused with each other",
    dev && dev.page?.url !== dev.operatorTab?.url);

  /* A screenshot must round-trip as a real image the model can be handed. */
  /* Token travels in the header; the action is nested under `command`. */
  const shotP = fetch(B + "/api/browser/command", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Browser-Token": TOKEN },
    body: JSON.stringify({ command: { action: "screenshot" }, timeoutMs: 15000 }),
  }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 400));
  await extensionTick({ answer: (cmd) => cmd.action === "screenshot"
    ? { ok: true, data: { screenshot: "captured" }, url: "https://marcos-screen.example/listing/123",
        title: "What Marco is looking at", image: { media_type: "image/jpeg", data: JPEG_1PX },
        meta: { adoptedOperatorTab: true } }
    : { ok: true, data: "noop" } });
  const shot = await shotP;
  ok("a screenshot command completes", shot && shot.ok === true && !shot.error,
    JSON.stringify(shot).slice(0, 200));
  ok("the image comes back as real base64 JPEG data",
    shot?.image?.data === JPEG_1PX && shot.image.media_type === "image/jpeg",
    JSON.stringify(shot?.image || null).slice(0, 120));
  ok("it is attributed to the page the operator was on",
    /marcos-screen/.test(shot?.url || ""), shot?.url);

  /* The audit history must not carry the image — a few hundred KB per capture
     would exhaust memory in an afternoon — but must record that one happened. */
  const hist = await (await fetch(B + `/api/browser/status?token=${TOKEN}`)).json();
  const raw = JSON.stringify(hist);
  ok("the screenshot is not stored in the audit history",
    !raw.includes(JPEG_1PX.slice(0, 40)), "base64 image found in history");
} finally { srv.kill("SIGKILL"); }

/* ---- the model-facing hop ----------------------------------------------- */
const tools = readFileSync("src/harvey/platformTools.ts", "utf8");
ok("the screenshot tool lifts the image into the agent loop's `_image` slot",
  /_image: image/.test(tools));
ok("its description tells Harvey it can look at the operator's tab",
  /THE TAB THE OPERATOR IS ON/.test(tools));
const loop = readFileSync("src/hull/agentLoop.ts", "utf8");
ok("the agent loop turns `_image` into a real base64 image block",
  /type: "base64"/.test(loop) && /media_type/.test(loop));

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); if (log) console.error(log.slice(-900)); process.exit(1); }
