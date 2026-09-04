#!/usr/bin/env node
/**
 * The Completed Tasks list must scroll.
 *
 * REPORTED BY CARLOS: "i cant scroll down to see all of the completed tasks".
 * He was right, and it was not subtle — the completed list was simply cut off
 * at the fold with no way to reach anything below it.
 *
 * CAUSE. The Completed tabs render ONE long list into `#bars`, the same
 * container the kanban board uses for its side-by-side member columns. That
 * container is `overflow-x:auto; overflow-y:hidden` — correct for the board,
 * where each column scrolls internally and the whole thing pans sideways, and
 * exactly wrong for a single vertical list. Compounding it, the native
 * scrollbar is suppressed with `::-webkit-scrollbar{display:none}` because the
 * kanban drives an always-visible horizontal proxy bar instead — and
 * `display:none` kills the vertical bar too.
 *
 * So this asserts the real thing a person does: can you actually get to the
 * last completed task. A test that only checked `overflow-y` would pass on a
 * container that still cannot reach its own last row.
 *
 * Usage: PW_CHROMIUM=... node scripts/verify-completed-tasks-scroll.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 3996;
const B = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "donescroll-"));
let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

/* Carlos's actual situation: a stack of tasks all completed on one day, more
   than fits on screen. 25 is comfortably past the fold at any window size. */
const DAY = new Date().toISOString().slice(0, 10);
const N = 25;
const commandTasks = [];
for (let i = 0; i < N; i++) {
  commandTasks.push({
    id: "ct_" + i,
    title: (i === N - 1 ? "LAST COMPLETED TASK" : "Completed task number " + (i + 1)),
    description: "", checklist: [], column: "today", status: "done",
    color: "green", assignedTo: "carlos", createdBy: "marco",
    dueDate: DAY, completedAt: DAY + "T1" + (i % 10) + ":00:00.000Z",
    createdAt: DAY + "T09:00:00.000Z", updatedAt: DAY + "T1" + (i % 10) + ":00:00.000Z",
    recurring: false, sortOrder: i,
  });
}
writeFileSync(join(tmp, "db.json"), JSON.stringify({
  idCounter: 1, leadsById: {}, leadKeyToId: {}, conversationsByLeadId: {}, commandTasks,
}));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), SITE_LOGIN_ENABLED: "0",
    DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
    DATA_DIR: tmp, AUTH_DB_PATH: join(tmp, "auth.db") },
  stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch {} });
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
await until(async () => (await fetch(B + "/health")).ok);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  /* /team-tasks sits behind the "Who's logging in?" device gate, so sign in as
     Carlos — who is the person who reported this. */
  await page.goto(B + "/team-tasks", { waitUntil: "networkidle" });
  if (/\/who/.test(page.url())) {
    await page.getByText("Carlos", { exact: false }).first().click();
    await page.waitForURL(/team-tasks/, { timeout: 20000 });
  }
  await page.waitForTimeout(1000);
  ok("signed in and on the tasks board", /team-tasks/.test(page.url()), page.url());

  const served = await (await fetch(B + "/api/tasks")).json();
  ok("the fixture's completed tasks are actually served",
    (served.tasks || []).length >= N, String((served.tasks || []).length));

  await page.click('button[data-tab="done"]');
  await page.waitForTimeout(600);
  await page.waitForSelector("#bars .task, #bars .empty", { timeout: 8000 });

  const cards = await page.locator("#bars .task").count();
  ok("all " + N + " completed tasks are rendered into the list", cards >= N, String(cards));

  const m = await page.evaluate(() => {
    const b = document.getElementById("bars");
    const cs = getComputedStyle(b);
    return { scrollHeight: b.scrollHeight, clientHeight: b.clientHeight,
             overflowY: cs.overflowY, isList: b.classList.contains("list") };
  });
  ok("the container is in list mode", m.isList === true);
  ok("the content really is taller than the box (so this reproduces the report)",
    m.scrollHeight > m.clientHeight + 40, `${m.scrollHeight} vs ${m.clientHeight}`);
  ok("vertical overflow is no longer hidden", m.overflowY !== "hidden", m.overflowY);

  /* THE ASSERTION THAT MATTERS — and it has to be a REAL wheel over the list.
     `overflow-y:hidden` still permits PROGRAMMATIC scrolling: setting
     `el.scrollTop` moves a hidden-overflow box just fine, and so does
     scrollIntoView. Only user input is blocked. An earlier version of this
     suite checked scrollTop and scrollIntoViewIfNeeded, and both passed
     happily against the broken CSS — testing something Carlos cannot do while
     ignoring the thing he cannot. Playwright's mouse.wheel dispatches a
     genuine input event, so this fails when a person would be stuck. */
  const barsBox = await page.locator("#bars").boundingBox();
  await page.mouse.move(barsBox.x + barsBox.width / 2, barsBox.y + barsBox.height / 2);
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(300);
  const afterWheel = await page.evaluate(() => document.getElementById("bars").scrollTop);
  ok("a real mouse wheel over the list scrolls it", afterWheel > 0,
    "scrollTop stayed at " + afterWheel + " after a 1200px wheel");

  /* Keep wheeling until it stops moving — the bottom must be reachable by the
     same gesture, not only by script. */
  let prev = -1, cur = afterWheel, guard = 0;
  while (cur !== prev && guard++ < 40) {
    prev = cur;
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(120);
    cur = await page.evaluate(() => document.getElementById("bars").scrollTop);
  }
  ok("wheeling reaches the very bottom of the list",
    cur >= m.scrollHeight - m.clientHeight - 4, `${cur} of ${m.scrollHeight - m.clientHeight}`);

  /* And the human question: is the last completed task now on screen. */
  const last = page.locator("#bars .task").last();
  const box = await last.boundingBox();
  const bb = await page.locator("#bars").boundingBox();
  ok("the LAST completed task is visible after wheeling there",
    box && bb && box.y >= bb.y - 4 && box.y + box.height <= bb.y + bb.height + 4,
    JSON.stringify({ cardTop: box && Math.round(box.y), cardBottom: box && Math.round(box.y + box.height),
                     listTop: bb && Math.round(bb.y), listBottom: bb && Math.round(bb.y + bb.height) }));
  ok("and it really is the one we put last", /LAST COMPLETED TASK/.test(await last.innerText()));

  /* The code comment claims the horizontal proxy bar hides itself here; verify
     that rather than trusting it, so list mode leaves no dead strip. */
  ok("the board's horizontal scrollbar proxy is hidden in list mode",
    await page.evaluate(() => getComputedStyle(document.getElementById("barsScroll")).display) === "none");

  /* The kanban must keep panning sideways — that is what the hidden overflow
     was for, and this fix must not cost it. */
  await page.click('button[data-tab="active"]');
  await page.waitForTimeout(600);
  const board = await page.evaluate(() => {
    const b = document.getElementById("bars");
    const cs = getComputedStyle(b);
    return { isList: b.classList.contains("list"), overflowX: cs.overflowX, overflowY: cs.overflowY };
  });
  ok("back on the board, list mode is off", board.isList === false);
  ok("the board still pans horizontally", board.overflowX === "auto" || board.overflowX === "scroll", board.overflowX);
  ok("and its vertical overflow is hidden again, as the columns expect",
    board.overflowY === "hidden", board.overflowY);

  ok("no page errors", errs.length === 0, errs.join("; "));
  if (process.env.SHOT) {
    await page.click('button[data-tab="done"]');
    await page.waitForTimeout(500);
    await page.evaluate(() => { document.getElementById("bars").scrollTop = 99999; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: process.env.SHOT });
  }
} finally { await browser.close(); srv.kill("SIGKILL"); }

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error(fail.map((f) => " - " + f).join("\n")); if (log) console.error(log.slice(-800)); process.exit(1); }
