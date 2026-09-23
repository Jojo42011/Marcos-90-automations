#!/usr/bin/env node
/**
 * Static checks on Harvey's chat surface (public/harvey.html + public/harvey-chat.js).
 *
 * Two things are being protected here.
 *
 * 1. THE CONTRACT. docs/harvey-model-layer.md is what the backend, the tools
 *    and this page are all built against. If the page stops handling an SSE
 *    event, or starts posting approvals somewhere else, the failure is silent
 *    in a browser — a stream that quietly drops `approval` frames just looks
 *    like Harvey never asked. So the event names and endpoint paths are
 *    asserted against the doc, in source.
 *
 * 2. HONESTY. This page ships before its backend does. The temptation in that
 *    situation is a placeholder conversation list or an example spend figure
 *    so the screen "looks right" — which is exactly the thing that must never
 *    happen on a surface showing real client data and real money. These checks
 *    fail the build on fabricated sample data and on empty states that do not
 *    say the truth.
 *
 * Usage: node scripts/verify-harvey-ui.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";

const root = process.cwd();
const HTML_PATH = join(root, "public/harvey.html");
const JS_PATH = join(root, "public/harvey-chat.js");
const DOC_PATH = join(root, "docs/harvey-model-layer.md");
const SHELL_PATH = join(root, "public/shell.html");
const SERVER_PATH = join(root, "src/server.ts");

let pass = 0;
const fail = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail.push(name + (detail ? " — " + detail : "")); console.error("FAIL " + name + (detail ? " — " + detail : "")); }
};

/* ── 0. the files exist and parse ─────────────────────────────────────── */
console.log("\nFILES");
ok("public/harvey.html exists", existsSync(HTML_PATH));
ok("public/harvey-chat.js exists", existsSync(JS_PATH));
if (fail.length) { console.log(`\n${pass}/${pass + fail.length} checks passed`); process.exit(1); }

const html = readFileSync(HTML_PATH, "utf8");
const js = readFileSync(JS_PATH, "utf8");
const both = html + "\n" + js;

ok("the page loads its own script and nothing else remote",
  html.includes('src="/harvey-chat.js"') && !/<script[^>]+src="https?:/i.test(html),
  "a CDN <script> would break the no-dependencies rule");

{
  const tmp = join(tmpdir(), "harvey-ui-check.js");
  writeFileSync(tmp, js);
  let parsed = true, why = "";
  try { execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" }); }
  catch (e) { parsed = false; why = String(e.stderr || e).split("\n").slice(0, 2).join(" "); }
  ok("harvey-chat.js parses", parsed, why);

  // Inline <script> blocks in the page have to parse too (theme bootstrap).
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let inlineOk = true, inlineWhy = "";
  inline.forEach((src, i) => {
    const f = join(tmpdir(), `harvey-inline-${i}.js`);
    writeFileSync(f, src);
    try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
    catch (e) { inlineOk = false; inlineWhy = String(e.stderr || e).split("\n").slice(0, 2).join(" "); }
  });
  ok(`all ${inline.length} inline script block(s) parse`, inlineOk, inlineWhy);
}

ok("no npm/ESM imports — it is a plain browser script",
  !/^\s*import\s.+from\s/m.test(js) && !/\brequire\(/.test(js));

/* ── 1. composer layout: model pill sits between the text box and send ── */
console.log("\nCOMPOSER");
const iModelPill = html.indexOf('id="modelPill"');
const iSend = html.indexOf('id="sendBtn"');
const iInput = html.indexOf('id="input"');
const iPlus = html.indexOf('id="plusBtn"');
ok("the composer has a model picker pill", iModelPill > 0);
ok("the pill is to the RIGHT of the textarea and LEFT of the send button",
  iInput < iModelPill && iModelPill < iSend, `input@${iInput} pill@${iModelPill} send@${iSend}`);
ok("a + button leads the composer", iPlus > 0 && iPlus < iInput);
ok("there is a mic button between the pill and send",
  iModelPill < html.indexOf('id="micBtn"') && html.indexOf('id="micBtn"') < iSend);
ok("the pill opens a popover listing models", /id="modelMenu"/.test(html) && /buildModelMenu/.test(js));
ok("the picker offers an Auto option meaning Harvey routes per job",
  /data-model="auto"/.test(js) && /routes each job/i.test(js));
ok("models are grouped by family", /FAMILY_ORDER\s*=\s*\[\s*"Anthropic",\s*"OpenAI",\s*"Google"/.test(js));
ok("the choice persists in localStorage",
  /MODEL_KEY\s*=\s*"harvey_model"/.test(js) && /localStorage\.setItem\(MODEL_KEY/.test(js));
ok("Enter sends and Shift+Enter makes a newline",
  /e\.key === "Enter" && !e\.shiftKey/.test(js));
ok("the textarea autogrows", /function autosize/.test(js) && /scrollHeight/.test(js));

/* ── 2. the chat contract ─────────────────────────────────────────────── */
console.log("\nCHAT CONTRACT (docs/harvey-model-layer.md)");
ok("posts to /api/harvey/chat", /apiUrl\("\/api\/harvey\/chat"\)/.test(js));
ok("asks for a stream", /stream:\s*true/.test(js));
for (const ev of ["token", "tool", "approval", "usage", "done", "error"]) {
  ok(`handles the \`${ev}\` SSE event`, new RegExp(`case "${ev}":`).test(js));
}
ok("parses SSE frames itself (event:/data: over a reader)",
  /\/\^event:\//.test(js) && /\/\^data:\//.test(js) && /getReader\(\)/.test(js));
ok("falls back to the non-stream JSON shape when the reply is not SSE",
  /text\/event-stream/.test(js) && /applyNonStream/.test(js));
ok("the non-stream path reads text, usage, contextPlan and approvals",
  /data\.usage/.test(js) && /contextPlan/.test(js) && /data\.approvals/.test(js));
ok("tokens render incrementally behind a typing caret",
  /class="caret"/.test(js) && /requestAnimationFrame/.test(js));

/* ── 3. tools and approvals ───────────────────────────────────────────── */
console.log("\nTOOLS & APPROVALS");
ok("a tool call renders one inline row", /className = "tool-row"/.test(js) && /\.tool-row\{/.test(html.replace(/\s*\{/g, "{")));
ok("that row shows running / done / error from the server, not a guess",
  /status === "done"/.test(js) && /status === "error"/.test(js) && /"running"/.test(js));
ok("tool rows are only created from a server `tool` event",
  /case "tool":\s*\n\s*ui\.tool\(d\);/.test(js));
ok("an approval renders a card with the tool, summary and risk",
  /function approvalCard/.test(js) && /class="risk /.test(js) && /a\.summary/.test(js));
ok("Approve posts to /api/harvey/approvals/:id/approve",
  /"\/api\/harvey\/approvals\/" \+ encodeURIComponent\(a\.id\) \+ "\/approve"/.test(js));
ok("Deny posts to /api/harvey/approvals/:id/deny with a reason",
  /"\/api\/harvey\/approvals\/" \+ encodeURIComponent\(a\.id\) \+ "\/deny"/.test(js) && /body:\s*\{ reason: reason \}/.test(js));
ok("nothing auto-approves — both buttons are user clicks",
  !/autoApprove|auto_approve/i.test(js) &&
  /approveBtn\.addEventListener\("click"/.test(js) && /denyBtn\.addEventListener\("click"/.test(js));
ok("the card updates in place after the answer",
  /Approved</.test(js) && /Denied</.test(js));
ok("pending approvals are read from GET /api/harvey/approvals",
  /api\("\/api\/harvey\/approvals"\)/.test(js));

/* ── 4. usage ─────────────────────────────────────────────────────────── */
console.log("\nUSAGE");
ok("per-message footer shows the model and the measured cost",
  /setUsage/.test(js) && /shortModel\(u\.model\)/.test(js) && /cost\.toFixed\(4\)/.test(js));
ok("reads GET /api/harvey/usage?days=", /\/api\/harvey\/usage\?days=/.test(js));
ok("caps are saved through POST /api/harvey/usage/caps", /\/api\/harvey\/usage\/caps/.test(js));
ok("today and month are shown against their caps", /function spendCard/.test(js) && /dailyCapUsd/.test(js) && /monthlyCapUsd/.test(js));
ok("daily spend is drawn without a chart library",
  /function dailyBars/.test(js) && /class="bars"/.test(js) && !/chart\.js|d3|apexcharts|highcharts/i.test(both));
ok("per-model and per-job tables exist", /byModel/.test(js) && /byJob/.test(js));
ok("recent errors are listed", /recentErrors/.test(js));
ok("a missing cap says so instead of inventing one", /no cap reported/.test(js));

ok("no legacy fallback remains", !/legacyChat|legacyMode/.test(js));
ok("no scheduled view or API remains", !/view-scheduled|\/api\/harvey\/tasks/.test(both));

/* ── 6. conversations ─────────────────────────────────────────────────── */
console.log("\nCONVERSATIONS");
ok("lists GET /api/harvey/conversations", /api\("\/api\/harvey\/conversations"\)/.test(js));
ok("opens one by id", /"\/api\/harvey\/conversations\/" \+ encodeURIComponent\(id\)/.test(js));
ok("renames through /:id/title", /\/title"/.test(js) && /body: \{ title: title \}/.test(js));
ok("deletes through DELETE", /conversations\/"[\s\S]{0,120}method: "DELETE"/.test(js));
ok("a 404 falls back to a local list in this browser, and says so",
  /convsWired = false/.test(js) && /kept in this browser/.test(js));

/* ── 7. honesty: no fabricated data anywhere ──────────────────────────── */
console.log("\nHONESTY (repo policy)");
ok("no sample/demo/mock/fixture data arrays",
  !/\b(const|let|var)\s+(SAMPLE|DEMO|MOCK|FAKE|DUMMY|EXAMPLE|PLACEHOLDER|SEED)[A-Z_]*\s*=/.test(both),
  "a stand-in dataset would render as if it were real");
ok("no hardcoded dollar figures — every number is formatted from server data",
  !/\$\d[\d,]*\.\d+/.test(both.replace(/\$\d+\.\d+ in\b/g, "")),
  "found a literal money value in source");
ok("cost strings are built with toFixed from a returned number",
  /"\$" \+ .*toFixed\(/.test(js));
ok("the conversation list starts from the server or localStorage, never a literal",
  /state\.conversations = \(?(r\.data\.conversations|readLocalConvs)/.test(js) &&
  !/conversations:\s*\[\s*\{/.test(js));
ok("tasks/usage/models state all start empty",
  /models: \[\],/.test(js) && /conversations: \[\],/.test(js));
for (const phrase of [
  "No usage recorded yet",
  "No conversations yet",
  "No errors recorded"
]) ok(`honest empty state: "${phrase}"`, both.includes(phrase));
ok("a 404 on a subsystem names the endpoint that is missing",
  /returned 404/.test(js), "an operator should be told which endpoint is absent");
ok("dictation is disabled with a reason when the browser lacks it",
  /btn\.disabled = true;\s*\n\s*btn\.title = "Dictation needs/.test(js));
ok("an approval with no id cannot be answered and says why",
  /did not send an approval id/.test(js));

/* ── 8. auth ──────────────────────────────────────────────────────────── */
console.log("\nAUTH");
ok("sends the session cookie", /credentials: "same-origin"/.test(js));
ok("supports ?token= like the other pages", /get\("token"\)/.test(js) && /searchParams\.set\("token"/.test(js));
ok("401 shows a sign-in message rather than a blank screen",
  /res\.status === 401/.test(js) && /showAuthBanner/.test(js) && /session has expired/i.test(js));

/* ── 9. keyboard, theme, accessibility, responsive ────────────────────── */
console.log("\nKEYBOARD, THEME, A11Y");
ok("Cmd/Ctrl+K focuses the composer", /\(e\.key === "k" \|\| e\.key === "K"\)/.test(js));
ok("Cmd/Ctrl+Shift+O starts a new chat", /e\.shiftKey && \(e\.key === "O"/.test(js));
ok("Esc closes popovers", /e\.key === "Escape"/.test(js) && /closePop\(\)/.test(js));
ok("dark is the default and light is a real toggle",
  /data-theme="dark"/.test(html) && /setTheme\("light"\)|currentTheme\(\) === "dark" \? "light" : "dark"/.test(js));
ok("the theme uses the same key as every other page in this app",
  /THEME_KEY\s*=\s*"marco_crm_theme"/.test(js));
ok("controls are real <button>s, not clickable divs",
  (html.match(/<button/g) || []).length >= 12);
ok("aria-labels are present on icon-only controls",
  (html.match(/aria-label=/g) || []).length >= 12);
ok("focus rings are not removed", /:focus-visible\{outline:/.test(html.replace(/\s*\{/g, "{")));
ok("prefers-reduced-motion is respected", /@media\(prefers-reduced-motion:reduce\)/.test(html.replace(/@media\s+/g, "@media")));
ok("the sidebar collapses to an overlay on narrow screens",
  /@media\(max-width:860px\)/.test(html.replace(/@media\s+/g, "@media")) && /side-open/.test(js));
ok("output is escaped before it reaches innerHTML", /function esc\(/.test(js) && (js.match(/esc\(/g) || []).length > 40);

/* ── 10. the doc and the page agree ───────────────────────────────────── */
console.log("\nDOC AGREEMENT");
if (!existsSync(DOC_PATH)) {
  ok("docs/harvey-model-layer.md is present", false, "the contract this page is built against is missing");
} else {
  const doc = readFileSync(DOC_PATH, "utf8");
  const routes = [...doc.matchAll(/\/api\/harvey\/[a-z/:.-]+/g)].map((m) => m[0]);
  const families = [...new Set(routes.map((r) => r.split("/").slice(0, 4).join("/").replace(/:.*/, "")))];
  const missing = families.filter((f) => !js.includes(f.replace(/\/$/, "")));
  ok("every /api/harvey/* route family in the doc is used by the page",
    missing.length === 0, missing.join(", "));
}

/* ── 11. voice mode ───────────────────────────────────────────────────────
   Harvey used to have two sidebar tabs: this chat, and the voice-first orb at
   /operator. The orb tab is gone, so the composer button is now the ONLY way
   into voice from the app — which is why these checks care that it reaches the
   real screen. A button that opens nothing, or toasts "coming soon", would read
   as "Harvey cannot talk any more" and would be a straight regression. */
console.log("\nVOICE MODE");
const iVoice = html.indexOf('id="voiceBtn"');
const iMic = html.indexOf('id="micBtn"');
ok("the composer has a voice-mode button", iVoice > 0);
ok("it sits with the other composer controls, between the pill and send",
  iModelPill < iVoice && iVoice < iSend, `pill@${iModelPill} voice@${iVoice} send@${iSend}`);
ok("it is a separate control from dictation, not a renamed mic", iMic > 0 && iMic !== iVoice);
ok("it wears the same class as the other round composer buttons",
  /<button[^>]*class="cbtn"[^>]*id="voiceBtn"/.test(html) || /<button[^>]*id="voiceBtn"[^>]*class="cbtn"/.test(html),
  "a bespoke style here drifts from the mic and + buttons beside it");
ok("it says what it is to a screen reader and on hover",
  /id="voiceBtn"[^>]*aria-label="Voice mode"/.test(html) && /id="voiceBtn"[^>]*title="Voice mode/.test(html));
ok("it opens the existing /operator voice screen — not a second speech pipeline",
  /apiUrl\("\/operator"\)/.test(js),
  "the STT/TTS pipeline lives on that page; this must reuse it");
ok("no new speech recognition/synthesis is started for voice mode",
  !/webkitSpeechGrammar|SpeechSynthesisUtterance|new MediaRecorder/.test(js));
ok("it is not a stub", !/coming soon|not yet available|todo/i.test(both));
ok("the screen is embedded in an overlay on this page",
  /id="voiceOverlay"/.test(html) && /id="voiceFrame"/.test(html) && /<div id="voiceOverlay"[^>]*hidden/.test(html));
ok("the iframe is handed the microphone, or the orb hears nothing",
  /id="voiceFrame"[^>]*allow="microphone[^"]*"/.test(html));
ok("the overlay announces itself as a dialog", /role="dialog"[\s\S]{0,80}aria-label="Voice mode"/.test(html));
ok("it has a visible close button", /id="voiceClose"/.test(html) && /aria-label="Close voice mode"/.test(html));
ok("Esc closes it", /voiceModeIsOpen\(\)\) \{ closeVoiceMode\(\)/.test(js));
ok("Esc still works once focus is inside the iframe (it is same-origin)",
  /contentDocument\.addEventListener\("keydown"/.test(js));
ok("closing empties the iframe, which is what releases the mic",
  /frame\.src = "about:blank"/.test(js));
ok("closing hands focus back to the composer", /closeVoiceMode[\s\S]{0,700}\$\("input"\)\.focus\(\)/.test(js));
ok("dictation is stopped before voice mode takes the microphone",
  /stopDictation\(\)/.test(js) && /openVoiceMode/.test(js));
ok("a spoken navigation command from inside the overlay is passed up to the shell",
  /"app-navigate"/.test(js) && /window\.parent\.postMessage/.test(js),
  "otherwise \u201copen the CRM\u201d lands on this page and looks ignored");
ok("only the voice iframe's own messages are relayed",
  /e\.source !== frame\.contentWindow/.test(js), "any page could otherwise drive the shell");
ok("the overlay is themed from the same variables as the rest of the page",
  /\.overlay-panel\{[^}]*var\(--bg\)/.test(html.replace(/\s*\{/g, "{")) &&
  /\.overlay-bar\{[^}]*var\(--line\)/.test(html.replace(/\s*\{/g, "{")));

/* ── 12. the sidebar, and what is still reachable without it ──────────────
   Three tabs were collapsed into one: the orb tab and Harvey Jobs came out, and
   this chat became the home tab. Removing a tab must never mean removing the
   page — /operator is exactly what the voice button opens, and /jobs is still
   the only place a running job's steps can be read. */
console.log("\nSHELL SIDEBAR");
if (!existsSync(SHELL_PATH) || !existsSync(SERVER_PATH)) {
  ok("public/shell.html and src/server.ts are present", false);
} else {
  const shellSrc = readFileSync(SHELL_PATH, "utf8");
  const serverSrc = readFileSync(SERVER_PATH, "utf8");
  /* Only the live TABS array counts. Comments in it explain the tabs that were
     removed (and keep one commented out), and asserting over those would fail
     on the explanation rather than on the config. */
  const tabsBlock = (() => {
    const i = shellSrc.indexOf("var TABS = [");
    const j = shellSrc.indexOf("\n];", i);
    return i < 0 || j < i ? "" : shellSrc.slice(i, j).replace(/\/\*[\s\S]*?\*\//g, "");
  })();
  const entries = tabsBlock.split(/key: "/).slice(1).map((s) => 'key: "' + s);
  const entryFor = (key) => entries.find((e) => e.startsWith('key: "' + key + '"')) || "";
  ok("the TABS array was found", entries.length > 0);
  ok("there is no Harvey Jobs tab", !/key: "jobs"/.test(tabsBlock) && !/src: "\/jobs"/.test(tabsBlock));
  ok("no tab embeds /operator any more", !/src: "\/operator"/.test(tabsBlock));
  ok("exactly one tab is labelled Harvey",
    (tabsBlock.match(/label: "Harvey"/g) || []).length === 1,
    "two tabs called Harvey is what this change removed");
  ok("that tab is the chat surface at /harvey",
    /label: "Harvey"/.test(entryFor("harvey-chat")) && /src: "\/harvey"/.test(entryFor("harvey-chat")));
  ok("home: true is on it, so the app still opens on Harvey",
    /home: true/.test(entryFor("harvey-chat")) && (tabsBlock.match(/home: true/g) || []).length === 1);
  ok("it is the first tab in the sidebar", entries[0].startsWith('key: "harvey-chat"'));
  ok("it still sits above CRM", entries.findIndex((e) => e.startsWith('key: "crm"')) > 0);
  ok("the section separators follow the renamed key",
    /"harvey-chat": null/.test(shellSrc) && !/^\s*harvey:\s*null/m.test(shellSrc));
  ok('the retired "harvey" key still resolves, so voice nav is not silently dead',
    /TAB_ALIASES = \{ harvey: "harvey-chat" \}/.test(shellSrc) && /TAB_ALIASES\[key\]/.test(shellSrc),
    "every page posts app-navigate tab:harvey to get back here");
  ok("/operator is still served by src/server.ts",
    /app\.get\("\/operator"/.test(serverSrc) && existsSync(join(root, "public/operator.html")),
    "the voice button opens it — removing the route would break voice entirely");
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) {
  console.log("\nFailures:");
  fail.forEach((f) => console.log("  · " + f));
  process.exit(1);
}
