/**
 * Verification for the three Harvey Connect changes:
 *   1. per-account pairing tokens (no more shared-token interference)
 *   2. the extension side panel
 *   3. the agent-loop budget that used to dead-end on "hit the tool loop limit"
 *
 * Run AFTER `npm run build`:  node scripts/verify-harvey-connect.mjs
 *
 * The account tests are FUNCTIONAL, not greps: this is the surface that drives
 * a signed-in human's browser, so "Carlos cannot see Marco's machine" has to be
 * demonstrated against the real module, not asserted about its source.
 */

import { readFileSync } from "fs";
import assert from "assert";

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/* ── 1. Accounts ─────────────────────────────────────────────────────────── */
process.env.BROWSER_CONTROL_TOKENS = "Marco:tok-marco,Carlos:tok-carlos, Wesley : tok-wesley ";
process.env.BROWSER_CONTROL_TOKEN = "tok-legacy";

const acc = await import("../dist/src/core/browserAccounts.js");
acc._resetAccountCache();

check("accounts: each token resolves to its own account", () => {
  assert.equal(acc.resolveAccount("tok-marco")?.name, "Marco");
  assert.equal(acc.resolveAccount("tok-carlos")?.name, "Carlos");
  assert.equal(acc.resolveAccount("tok-wesley")?.name, "Wesley", "whitespace around name/token must be trimmed");
  assert.equal(acc.resolveAccount("tok-marco")?.id, "marco");
});

check("accounts: legacy single token still works, as its own account", () => {
  const a = acc.resolveAccount("tok-legacy");
  assert(a, "legacy BROWSER_CONTROL_TOKEN must keep working so nobody has to re-pair on deploy day");
  assert.equal(a.legacy, true);
});

check("accounts: a wrong or empty token resolves to nothing", () => {
  for (const t of ["", "   ", "nope", "tok-marc", "tok-marcoX", undefined, null]) {
    assert.equal(acc.resolveAccount(t), null, `must reject: ${JSON.stringify(t)}`);
  }
});

check("accounts: listAccounts never leaks a token", () => {
  const json = JSON.stringify(acc.listAccounts());
  for (const t of ["tok-marco", "tok-carlos", "tok-wesley", "tok-legacy"]) {
    assert(!json.includes(t), `token leaked in listAccounts: ${t}`);
  }
  assert.equal(acc.listAccounts().length, 4);
});

check("accounts: fails CLOSED when nothing is configured", () => {
  const savedMulti = process.env.BROWSER_CONTROL_TOKENS;
  const savedSingle = process.env.BROWSER_CONTROL_TOKEN;
  delete process.env.BROWSER_CONTROL_TOKENS;
  delete process.env.BROWSER_CONTROL_TOKEN;
  acc._resetAccountCache();
  try {
    assert.equal(acc.isConfigured(), false);
    assert.equal(acc.resolveAccount("anything"), null);
    assert.equal(acc.resolveAccount(""), null);
  } finally {
    process.env.BROWSER_CONTROL_TOKENS = savedMulti;
    process.env.BROWSER_CONTROL_TOKEN = savedSingle;
    acc._resetAccountCache();
  }
});

check("accounts: a token reused by two accounts is refused, not silently shared", () => {
  process.env.BROWSER_CONTROL_TOKENS = "Ann:same-token,Bob:same-token";
  delete process.env.BROWSER_CONTROL_TOKEN;
  acc._resetAccountCache();
  try {
    assert.equal(acc.listAccounts().length, 1, "the duplicate must be dropped, not mapped to both");
    assert.equal(acc.resolveAccount("same-token").name, "Ann");
  } finally {
    process.env.BROWSER_CONTROL_TOKENS = "Marco:tok-marco,Carlos:tok-carlos,Wesley:tok-wesley";
    process.env.BROWSER_CONTROL_TOKEN = "tok-legacy";
    acc._resetAccountCache();
  }
});

/* ── 2. Bus isolation between accounts ───────────────────────────────────── */
const bus = await import("../dist/src/core/browserControl.js");

function pair(token, deviceId, deviceName, enabled = true) {
  const account = bus.accountForToken(token);
  assert(account, `token should resolve: ${token}`);
  return bus.recordPoll(enabled, { url: `https://example.com/${deviceId}` }, {
    account, deviceId, deviceName, waitMs: 0,
  });
}

await checkAsync("bus: a device is only visible inside its own account", async () => {
  bus._resetForTests();
  await pair("tok-marco", "dev-marco", "Marco laptop");
  await pair("tok-carlos", "dev-carlos", "Carlos desktop");

  const marco = bus.listDevices("marco").map((d) => d.name);
  const carlos = bus.listDevices("carlos").map((d) => d.name);
  assert.deepEqual(marco, ["Marco laptop"]);
  assert.deepEqual(carlos, ["Carlos desktop"]);
});

await checkAsync("bus: an unaddressed command resolves inside the calling account", async () => {
  bus._resetForTests();
  await pair("tok-marco", "dev-marco", "Marco laptop");
  await pair("tok-carlos", "dev-carlos", "Carlos desktop");

  const forCarlos = bus.withAccount("carlos", () => bus.resolveDevice());
  assert.equal(forCarlos.device?.name, "Carlos desktop",
    "Carlos's command must not land on Marco's browser even though Marco outranks him by priority");

  const forMarco = bus.withAccount("marco", () => bus.resolveDevice());
  assert.equal(forMarco.device?.name, "Marco laptop");
});

await checkAsync("bus: naming another account's device does not reach it", async () => {
  bus._resetForTests();
  await pair("tok-marco", "dev-marco", "Marco laptop");
  await pair("tok-carlos", "dev-carlos", "Carlos desktop");

  const cross = bus.withAccount("carlos", () => bus.resolveDevice("Marco laptop"));
  assert.equal(cross.device, null, "must not resolve across accounts");
  assert(/No connected browser matches/i.test(cross.error || ""), `unexpected error: ${cross.error}`);
});

await checkAsync("bus: two legacy-id browsers on different accounts stay separate", async () => {
  bus._resetForTests();
  // Both send no deviceId — an older extension build. Before the account key
  // these collapsed into one record and one queue.
  await bus.recordPoll(true, {}, { account: bus.accountForToken("tok-marco"), deviceName: "M", waitMs: 0 });
  await bus.recordPoll(true, {}, { account: bus.accountForToken("tok-carlos"), deviceName: "C", waitMs: 0 });
  assert.equal(bus.listDevices("marco").length, 1);
  assert.equal(bus.listDevices("carlos").length, 1);
  assert.equal(bus.listDevices("marco")[0].name, "M");
  assert.equal(bus.listDevices("carlos")[0].name, "C");
});

await checkAsync("bus: disarm stops at the account boundary", async () => {
  bus._resetForTests();
  await pair("tok-marco", "dev-marco", "Marco laptop");
  await pair("tok-carlos", "dev-carlos", "Carlos desktop");

  bus.requestDisarm(undefined, "carlos");
  // Marco's browser must be untouched: "turn the browser off" said by one
  // person cannot silently disarm someone else's machine.
  const marcoDev = bus.listDevices("marco")[0];
  assert.equal(marcoDev.disarmRequested, false, "Marco's device was disarmed by Carlos's request");
  assert.equal(bus.listDevices("carlos")[0].disarmRequested, true);
});

await checkAsync("bus: status is scoped, and a run with no device in scope fails honestly", async () => {
  bus._resetForTests();
  await pair("tok-marco", "dev-marco", "Marco laptop");
  const s = bus.status("carlos");
  assert.equal(s.devices.length, 0);
  assert.equal(s.connected, false, "Carlos must not be told a browser is connected because Marco has one");

  const r = await bus.run({ action: "navigate", url: "https://example.com" }, { account: "carlos" });
  assert.equal(r.ok, false);
  assert(/No paired browser/i.test(r.error || ""), `unexpected: ${r.error}`);
});

check("bus: withAccount/currentAccount carry scope through async work", () => {
  const seen = bus.withAccount("carlos", () => bus.currentAccount());
  assert.equal(seen, "carlos");
  assert.equal(bus.currentAccount(), undefined, "scope must not leak outside the callback");
});

bus._resetForTests();

/* ── 3. Agent loop budget ────────────────────────────────────────────────── */
const loopSrc = read("src/hull/agentLoop.ts");

check("loop: budget raised, and lower for the surfaces a human waits on", () => {
  assert(/MAX_AGENT_STEPS = 16/.test(loopSrc));
  assert(/MAX_AGENT_STEPS_FAST = 8/.test(loopSrc));
  assert(/opts\.fastMode \|\| opts\.voiceMode \? MAX_AGENT_STEPS_FAST : MAX_AGENT_STEPS/.test(loopSrc));
});

check("loop: the final round withholds tools so the budget ends in an answer", () => {
  assert(/const lastRound = step === stepBudget - 1/.test(loopSrc));
  assert(/const stepTools = lastRound \? undefined : activeTools/.test(loopSrc));
  assert(/FINAL ROUND/.test(loopSrc));
  // Both call paths (streaming and non-streaming) must use the gated values.
  const uses = loopSrc.match(/tools: stepTools/g) || [];
  assert.equal(uses.length, 2, `both API calls must pass stepTools, found ${uses.length}`);
  const sys = loopSrc.match(/system: stepSystem/g) || [];
  assert.equal(sys.length, 2, `both API calls must pass stepSystem, found ${sys.length}`);
});

check("loop: identical repeat calls are refused instead of re-executed", () => {
  assert(/MAX_IDENTICAL_CALLS = 2/.test(loopSrc));
  assert(/REPEATED CALL REFUSED/.test(loopSrc));
  assert(/function signature\(/.test(loopSrc));
  // Sorted keys, or the same call with different key order looks new.
  assert(/JSON\.stringify\(input, Object\.keys\(input\)\.sort\(\)\)/.test(loopSrc));
  // Every execution must go through the guard.
  assert(!/result = await executeHullTool/.test(loopSrc), "a raw executeHullTool call bypasses the repeat guard");
  const guarded = loopSrc.match(/await runTool\(tu\.name, input\)/g) || [];
  assert.equal(guarded.length, 2, `both tool paths must use runTool, found ${guarded.length}`);
});

check("loop: the dead-end apology is no longer something Harvey can say", () => {
  // The phrase survives in the comment explaining what was wrong; what must
  // not survive is it being a value Harvey returns.
  assert(!/speech: "Hit the tool loop limit/.test(loopSrc));
  assert(/ran out of room to keep digging/.test(loopSrc), "the fallback should be a usable next step, not an error");
});

/* ── 4. Side panel ───────────────────────────────────────────────────────── */
const manifest = JSON.parse(read("public/extension/manifest.json"));
const bg = read("public/extension/background.js");
const panelJs = read("public/extension/sidepanel.js");
const panelHtml = read("public/extension/sidepanel.html");

check("panel: manifest declares the side panel and drops the popup as the click target", () => {
  assert.equal(manifest.side_panel?.default_path, "sidepanel.html");
  assert(manifest.permissions.includes("sidePanel"));
  assert(!manifest.action.default_popup, "a default_popup would swallow the click and the panel would never open");
  assert.equal(manifest.options_page, "popup.html", "the old popup should stay reachable as options");
  assert.equal(manifest.version, "1.6.0", "version must be bumped or Chrome keeps the old build");
});

check("panel: clicking the toolbar icon opens the panel, on install and on restart", () => {
  assert(/openPanelOnActionClick: true/.test(bg));
  assert(/onInstalled\.addListener\(\(\) => \{[\s\S]*?enableSidePanelOnClick\(\)/.test(bg));
  assert(/onStartup\.addListener\(\(\) => \{[\s\S]*?enableSidePanelOnClick\(\)/.test(bg));
  assert(/chrome\.sidePanel\?\./.test(bg), "must not throw on a Chrome without sidePanel");
});

check("panel: chat uses the pairing token against the account-scoped endpoint", () => {
  assert(/\/api\/browser\/chat/.test(panelJs));
  assert(/"X-Browser-Token": c\.token/.test(panelJs));
  assert(/deviceId: c\.deviceId/.test(panelJs), "session must be keyed per browser");
});

check("panel: transcript survives closing and reopening the panel", () => {
  assert(/const LOG_KEY = "panelLog"/.test(panelJs));
  assert(/chrome\.storage\.local\.set\(\{ \[LOG_KEY\]: log \}\)/.test(panelJs));
});

check("panel: pairing failures are named, not generalised", () => {
  assert(/Pairing token doesn't match/.test(panelJs));
  assert(/Wrong server address/.test(panelJs));
  assert(/Server has no pairing token set/.test(panelJs));
});

check("panel: html loads its script and has the chat + setup surfaces", () => {
  for (const id of ["log", "input", "send", "setup", "token", "serverUrl", "deviceName", "enabled"]) {
    assert(new RegExp(`id="${id}"`).test(panelHtml), `missing #${id}`);
  }
  assert(/<script src="sidepanel\.js">/.test(panelHtml));
  assert(/prefers-color-scheme: light/.test(panelHtml), "panel should not be a dark slab in a light browser");
});

/* ── 5. Server wiring ────────────────────────────────────────────────────── */
const server = read("src/server.ts");

check("server: poll, status, command and chat all resolve the ACCOUNT, not just validity", () => {
  assert(/const account = browserAccountForToken\(String\(b\.token \|\| ""\)\)/.test(server), "poll");
  assert(/browserStatus\(account\.id\)/.test(server), "status must be account-scoped");
  assert(/account: cmdAccount\.id/.test(server), "operator command must be account-scoped");
  assert(/app\.post\("\/api\/browser\/chat"/.test(server));
  assert(/withBrowserAccount\(account\.id/.test(server), "chat must scope Harvey's browser actions");
});

check("server: extension chat threads are keyed per account and device", () => {
  assert(/ext-\$\{account\.id\}-\$\{deviceId\}/.test(server));
});

/* ── Report ──────────────────────────────────────────────────────────────── */
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
