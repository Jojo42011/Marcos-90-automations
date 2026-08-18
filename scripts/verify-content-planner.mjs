#!/usr/bin/env node
/**
 * The Content Planner — editorial calendar, scratchpad backlog, dual drag
 * modes, team assignment and multi-timezone scheduling.
 *
 * WHAT THIS SUITE IS ACTUALLY GUARDING. Almost every feature here is one where
 * a plausible-looking screen can be wrong in a way nobody notices until a post
 * goes out on the wrong day:
 *
 *   - a wall clock stored without its zone silently drifts an hour twice a year
 *   - "same time, three days later" across a DST change is NOT +72h
 *   - 2:30 AM on a spring-forward date does not exist, and 1:30 AM on a
 *     fall-back date happens twice — both must be reported, not guessed
 *   - a Domino drag that ripples the wrong set of posts reschedules a month of
 *     content in one gesture
 *   - a Direct drag that ripples ANYTHING is the same bug in reverse
 *   - unscheduling must move an item, never delete it
 *   - the grid anchor must genuinely re-sort cards across midnight, not just
 *     relabel them
 *
 * So the API half asserts the arithmetic against real IANA rules, and the
 * browser half drives the actual page in Chromium — including synthetic HTML5
 * drag events through the real handlers, because "it renders" is not the claim.
 *
 * Usage: PW_CHROMIUM=/path/to/chrome node scripts/verify-content-planner.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "planner-"));
const PORT = 41730 + Math.floor(Math.random() * 200);
const TOKEN = "planner-verify-token";
const B = `http://127.0.0.1:${PORT}`;

let pass = 0; const fail = [];
const ok = (n, c, d) => {
  if (c) { pass++; console.log("  ok " + n); }
  else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); }
};

/* An offboarded CRM user, so the "(Inactive)" path is exercised for real. */
writeFileSync(join(tmp, "users.json"), JSON.stringify([
  { id: "u_old", name: "Dana Former", email: "dana@example.com", role: "agent",
    permissions: {}, active: false, createdAt: "2026-01-01T00:00:00Z",
    avatarInitials: "DF", avatarColor: "#facc15" },
]));

const srv = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT), DASHBOARD_TOKEN: TOKEN,
    DB_JSON_PATH: join(tmp, "db.json"),
    TASKS_JSON_PATH: join(tmp, "tasks.json"),
    USERS_JSON_PATH: join(tmp, "users.json"),
    TEAM_JSON_PATH: join(tmp, "team.json"),
    CONTENT_PLANNER_DB_PATH: join(tmp, "planner.db"),
    EMAIL_DB_PATH: join(tmp, "e.db"),
    TRANSACTIONS_DB_PATH: join(tmp, "x.db"),
    PLANNER_PRIMARY_TZ: "America/Chicago",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));

const until = async (fn, ms = 40000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
};
const booted = await until(async () => (await fetch(B + "/health")).ok);
if (!booted) { console.error("server never came up\n" + log.slice(-2500)); process.exit(1); }

const api = (p, init) => fetch(B + p + (p.includes("?") ? "&" : "?") + "token=" + TOKEN, init);
const jget = async (p) => (await api(p)).json();
const jsend = async (p, method, body) =>
  (await api(p, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) })).json();
const create = (body) => jsend("/api/planner/items", "POST", body);
const patch = (id, body) => jsend(`/api/planner/items/${id}`, "PATCH", body);

const CHI = "America/Chicago";
let boot = null;

try {
  /* ───────── bootstrap: the vocabulary the page is built from ───────── */
  {
    ok("bootstrap requires the dashboard token", (await fetch(B + "/api/planner/bootstrap")).status === 401);
    boot = await jget("/api/planner/bootstrap");
    ok("the palette has ten colours", boot.palette.length === 10, String(boot.palette.length));
    const yellow = boot.palette.find((c) => c.hex === "#facc15");
    const deepBlue = boot.palette.find((c) => c.hex === "#1d4ed8");
    ok("a light swatch gets black type", yellow && yellow.text === "#000000", JSON.stringify(yellow));
    ok("a dark swatch gets white type", deepBlue && deepBlue.text === "#ffffff", JSON.stringify(deepBlue));
    ok("the palette spans both type colours, so the rule is doing work",
      new Set(boot.palette.map((c) => c.text)).size === 2,
      JSON.stringify(boot.palette.map((c) => [c.hex, c.text])));
    ok("every swatch clears 4.5:1 against its own type", boot.palette.every((c) => c.contrast >= 4.5),
      JSON.stringify(boot.palette.map((c) => [c.name, c.contrast])));
    ok("nine platforms are taggable", boot.platforms.length === 9 &&
      ["Instagram", "TikTok", "YouTube", "Facebook", "LinkedIn", "X", "Pinterest", "Blog", "Newsletter"]
        .every((p) => boot.platforms.includes(p)), JSON.stringify(boot.platforms));
    ok("the backlog pipeline is Brainstorm → Drafting → Ready to Schedule",
      boot.backlogStatuses.map((s) => s.label).join(" → ") === "Brainstorm → Drafting → Ready to Schedule",
      JSON.stringify(boot.backlogStatuses));
    ok("the team comes from the CRM roster with accent colours and roles",
      boot.team.length >= 4 && boot.team.every((m) => m.userId && m.fullName && m.accentColor && m.role),
      JSON.stringify(boot.team.slice(0, 2)));
    const inactive = boot.team.find((m) => m.userId === "u_old");
    ok("an offboarded CRM user is still listed, flagged inactive", !!inactive && inactive.active === false,
      JSON.stringify(inactive));
  }

  /* ───────── timezone storage and dual display ───────── */
  let dualId = null;
  {
    await jsend("/api/planner/settings", "PUT", { primaryTz: CHI, secondaryTz: "Asia/Manila", gridAnchor: "primary" });
    const r = await create({ title: "Evening reel", date: "2026-08-17", time: "21:00", authoredTz: CHI, platforms: ["TikTok"] });
    dualId = r.item.id;
    ok("a scheduled time is stored as a UTC instant",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.item.scheduledAtUtc), r.item.scheduledAtUtc);
    ok("9 PM Chicago is stored as 02:00 UTC the next day",
      r.item.scheduledAtUtc === "2026-08-18T02:00:00.000Z", r.item.scheduledAtUtc);
    ok("the card carries the creator's time", r.item.primary.time === "09:00 PM", JSON.stringify(r.item.primary));
    ok("and the audience's time", r.item.secondary.time === "10:00 AM", JSON.stringify(r.item.secondary));
    ok("crossing midnight is badged +1d", r.item.secondary.deltaLabel === "+1d", r.item.secondary.deltaLabel);
    ok("the grid cell follows the creator's date while anchored to them",
      r.item.gridDate === "2026-08-17", r.item.gridDate);
  }

  /* ───────── the grid anchor genuinely re-sorts ───────── */
  {
    await jsend("/api/planner/settings", "PUT", { gridAnchor: "secondary" });
    const list = await jget("/api/planner/items?from=2026-08-01&to=2026-08-31");
    const item = list.items.find((i) => i.id === dualId);
    ok("flipping the grid anchor moves the card into the audience's day",
      item && item.gridDate === "2026-08-18", item && item.gridDate);
    ok("the anchor zone is reported back to the page", list.anchorTz === "Asia/Manila", list.anchorTz);
    await jsend("/api/planner/settings", "PUT", { gridAnchor: "primary", secondaryTz: "America/New_York" });
  }

  /* ───────── DST: the two cases that cannot be guessed ───────── */
  {
    const gap = await create({ title: "Spring forward", date: "2026-03-08", time: "02:30", authoredTz: CHI });
    ok("a wall clock that does not exist is flagged", gap.dstWarning === "nonexistent", gap.dstWarning);
    ok("and is stored at the time the clock jumps to",
      gap.item.primary.time === "03:30 AM", JSON.stringify(gap.item.primary));

    const amb = await create({ title: "Fall back", date: "2026-11-01", time: "01:30", authoredTz: CHI });
    ok("a wall clock that happens twice is flagged", amb.dstWarning === "ambiguous", amb.dstWarning);
    ok("and is stored as the first occurrence (CDT, 06:30Z)",
      amb.item.scheduledAtUtc === "2026-11-01T06:30:00.000Z", amb.item.scheduledAtUtc);

    await api(`/api/planner/items/${gap.item.id}?actor=verify`, { method: "DELETE" });
    await api(`/api/planner/items/${amb.item.id}?actor=verify`, { method: "DELETE" });
  }

  /* ───────── Domino vs Direct ───────── */
  let a = null, b = null, c = null;
  {
    await api(`/api/planner/items/${dualId}?actor=verify`, { method: "DELETE" });
    a = (await create({ title: "Post A", date: "2026-06-10", time: "10:00", authoredTz: CHI })).item;
    b = (await create({ title: "Post B", date: "2026-06-12", time: "14:00", authoredTz: CHI })).item;
    c = (await create({ title: "Post C", date: "2026-06-15", time: "16:00", authoredTz: CHI })).item;

    const preview = await jsend("/api/planner/reschedule/preview", "POST",
      { itemId: a.id, toDate: "2026-06-13", mode: "DOMINO" });
    ok("the domino preview reports the delta", preview.plan.deltaDays === 3, String(preview.plan.deltaDays));
    ok("the preview lists the dragged post plus every later one",
      preview.plan.moves.length === 3, JSON.stringify(preview.plan.moves.map((m) => m.title)));
    const after = await jget("/api/planner/items?from=2026-06-01&to=2026-06-30");
    ok("a preview writes nothing",
      after.items.find((i) => i.id === b.id).gridDate === "2026-06-12",
      after.items.find((i) => i.id === b.id).gridDate);

    const applied = await jsend("/api/planner/reschedule", "POST", { itemId: a.id, toDate: "2026-06-13", mode: "DOMINO" });
    const byId = Object.fromEntries((await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.map((i) => [i.id, i]));
    ok("domino: the dragged post lands on the target", byId[a.id].gridDate === "2026-06-13", byId[a.id].gridDate);
    ok("domino: every later post shifts by the same delta",
      byId[b.id].gridDate === "2026-06-15" && byId[c.id].gridDate === "2026-06-18",
      `${byId[b.id].gridDate} / ${byId[c.id].gridDate}`);
    ok("domino: the shifted posts keep their own times",
      byId[b.id].primary.time === "02:00 PM" && byId[c.id].primary.time === "04:00 PM",
      `${byId[b.id].primary.time} / ${byId[c.id].primary.time}`);
    ok("the applied plan is echoed back with the ripple", applied.plan.moves.length === 3);
  }

  {
    const before = Object.fromEntries((await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.map((i) => [i.id, i.gridDate]));
    await jsend("/api/planner/reschedule", "POST", { itemId: c.id, toDate: "2026-06-25", mode: "DIRECT", time: "07:30" });
    const after = Object.fromEntries((await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.map((i) => [i.id, i]));
    ok("direct: only the dragged post moves",
      after[c.id].gridDate === "2026-06-25" &&
      after[a.id].gridDate === before[a.id] && after[b.id].gridDate === before[b.id],
      JSON.stringify({ a: after[a.id].gridDate, b: after[b.id].gridDate, c: after[c.id].gridDate }));
    ok("direct: the drop hour from the timeline is honoured",
      after[c.id].primary.time === "07:30 AM", after[c.id].primary.time);
  }

  /* ───────── a domino shift across a DST boundary keeps the wall clock ───────── */
  {
    const d = (await create({ title: "Pre-DST", date: "2026-03-06", time: "10:00", authoredTz: CHI })).item;
    await jsend("/api/planner/reschedule", "POST", { itemId: d.id, toDate: "2026-03-09", mode: "DIRECT" });
    const moved = (await jget("/api/planner/items?from=2026-03-01&to=2026-03-31")).items.find((i) => i.id === d.id);
    ok("moving across a spring-forward keeps 10:00 as 10:00, not 09:00",
      moved.primary.time === "10:00 AM", moved.primary.time);
    ok("which means the stored UTC instant shifted by 71 hours, not 72",
      Date.parse(moved.scheduledAtUtc) - Date.parse(d.scheduledAtUtc) === 71 * 3600000,
      String((Date.parse(moved.scheduledAtUtc) - Date.parse(d.scheduledAtUtc)) / 3600000) + "h");
    await api(`/api/planner/items/${d.id}?actor=verify`, { method: "DELETE" });
  }

  /* ───────── scratchpad backlog ───────── */
  let ideaId = null;
  {
    const r = await create({ title: "Client testimonial ad", date: null, backlogStatus: "brainstorm" });
    ideaId = r.item.id;
    ok("an idea captured with no date has no scheduled instant", r.item.scheduledAtUtc === null);
    const backlog = await jget("/api/planner/backlog");
    ok("it lands in the scratchpad", backlog.items.some((i) => i.id === ideaId), String(backlog.count));
    ok("the backlog is grouped into the three pipeline columns", backlog.columns.length === 3);
    const inMonth = await jget("/api/planner/items?from=2026-01-01&to=2027-12-31");
    ok("an unscheduled idea never appears on the grid", !inMonth.items.some((i) => i.id === ideaId));

    await patch(ideaId, { backlogStatus: "ready" });
    const moved = await jget("/api/planner/backlog");
    ok("an idea can move along the pipeline",
      moved.columns.find((col) => col.id === "ready").items.some((i) => i.id === ideaId));

    await jsend("/api/planner/reschedule", "POST", { itemId: ideaId, toDate: "2026-06-20", mode: "DOMINO" });
    const scheduled = (await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.find((i) => i.id === ideaId);
    ok("dragging an idea onto a day schedules it", !!scheduled && scheduled.gridDate === "2026-06-20");
    const emptied = await jget("/api/planner/backlog");
    ok("and it leaves the scratchpad", !emptied.items.some((i) => i.id === ideaId));

    await patch(ideaId, { hook: "Hear it from the client", caption: "#satisfied" });
    await jsend(`/api/planner/items/${ideaId}/unschedule`, "POST", {});
    const back = await jget("/api/planner/backlog");
    const returned = back.items.find((i) => i.id === ideaId);
    ok("reverse-dragging it back unschedules rather than deletes", !!returned);
    ok("and every field survives the round trip",
      returned && returned.hook === "Hear it from the client" && returned.caption === "#satisfied",
      JSON.stringify(returned && { h: returned.hook, c: returned.caption }));
  }

  /* ───────── assignment, badges, notifications ───────── */
  {
    const before = (await jget("/api/team/notifications?user=kendrick")).notifications.length;
    await patch(a.id, {
      assignedUsers: [{ userId: "kendrick", role: "owner" }, { userId: "harvey_missing", role: "editor" }],
      actor: "marco",
    });
    const item = (await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.find((i) => i.id === a.id);
    ok("assignees are stored as {userId, role} pairs",
      item.assignedUsers.length === 2 && item.assignedUsers[0].role === "owner",
      JSON.stringify(item.assignedUsers));
    const notes = await jget("/api/team/notifications?user=kendrick");
    ok("assigning someone raises a real notification on their board",
      notes.notifications.length === before + 1 && /content calendar/i.test(notes.notifications[0].body),
      JSON.stringify(notes.notifications[0] || {}));
    const activity = await jget("/api/planner/activity");
    ok("the assignment is written to the CRM activity log",
      activity.activity.some((e) => e.kind === "assigned" && /Kendrick/.test(e.message)),
      JSON.stringify(activity.activity.slice(0, 2)));

    await patch(a.id, { assignedUsers: [{ userId: "kendrick", role: "owner" }], actor: "marco" });
    const after = await jget("/api/planner/activity");
    ok("removing an assignee is logged too", after.activity.some((e) => e.kind === "unassigned"));
  }

  /* ───────── completion, media link, deletion ───────── */
  {
    await patch(b.id, { isCompleted: true, assetDriveUrl: "https://drive.google.com/drive/folders/abc" });
    const item = (await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.find((i) => i.id === b.id);
    ok("an item can be marked complete", item.isCompleted === true);
    ok("a media drive link is stored verbatim", item.assetDriveUrl === "https://drive.google.com/drive/folders/abc");
    const counts = (await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).counts;
    ok("counts track scheduled / backlog / complete", counts.completed >= 1 && counts.backlog >= 1, JSON.stringify(counts));
  }

  {
    ok("an unknown timezone is refused, not silently ignored",
      (await api("/api/planner/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryTz: "Mars/Olympus" }),
      })).status === 400);
    ok("a bad date range is refused", (await api("/api/planner/items?from=nope&to=nope")).status === 400);
    ok("rescheduling a missing item 404s",
      (await api("/api/planner/reschedule", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: "no-such-id", toDate: "2026-06-01" }),
      })).status === 404);
  }

  /* ═══════════════════ the real page, in a real browser ═══════════════════ */
  {
    const { chromium } = await import("playwright");
    const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    const page = await br.newPage({ viewport: { width: 1600, height: 1100 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
    await page.goto(`${B}/content-planner?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".date-cell", { timeout: 15000 });
    await page.evaluate(() => {
      const p = window.__planner;
      p.state.year = 2026; p.state.month = 6; p.state.selectedDate = "2026-06-13";
      return p.reload();
    });
    await page.waitForTimeout(700);

    ok("the page loads with no script errors", errs.length === 0, errs.slice(0, 3).join(" | "));
    ok("six whole weeks of cells are rendered", (await page.locator(".date-cell").count()) === 42);
    ok("the month label follows the state",
      (await page.locator("#monthLabel").innerText()).trim() === "June 2026",
      await page.locator("#monthLabel").innerText());
    ok("cards render on their day",
      (await page.locator('.date-cell[data-date="2026-06-13"] .cell-card').count()) === 1);

    /* overflow: a fourth card on one day must collapse into "+1 more" */
    {
      for (const t of ["Overflow 1", "Overflow 2", "Overflow 3", "Overflow 4"]) {
        await create({ title: t, date: "2026-06-22", time: "09:00", authoredTz: CHI });
      }
      await page.evaluate(() => window.__planner.reload());
      await page.waitForTimeout(500);
      ok("a cell shows at most three cards",
        (await page.locator('.date-cell[data-date="2026-06-22"] .cell-card').count()) === 3);
      ok("and the rest collapse into a +N more link",
        (await page.locator('.date-cell[data-date="2026-06-22"] .more-link').innerText()) === "+1 more");
      await page.click('.date-cell[data-date="2026-06-22"] .more-link');
      await page.waitForTimeout(250);
      ok("clicking it opens that day in the detail panel",
        (await page.locator("#accordionContainer .accordion-item").count()) === 4);
    }

    /* the empty state names the day it will create for */
    {
      await page.click('.date-cell[data-date="2026-06-24"]');
      await page.waitForTimeout(250);
      const txt = await page.locator("#accordionContainer").innerText();
      ok("an empty day offers to create the first item for that date",
        /Create first content item for 2026-06-24/i.test(txt), txt.slice(0, 120));
    }

    /* avatar chips: 20px, 2px accent ring, -6px stack, +N counter */
    {
      await patch(a.id, {
        assignedUsers: [
          { userId: "kendrick", role: "owner" },
          { userId: "carlos", role: "editor" },
          { userId: "wesley", role: "reviewer" },
          { userId: "marco", role: "approver" },
        ],
        actor: "verify",
      });
      await page.evaluate(() => window.__planner.reload());
      await page.waitForTimeout(500);
      const box = await page.evaluate(() => {
        const chip = document.querySelector('.date-cell[data-date="2026-06-13"] .avatar-chip');
        const second = document.querySelectorAll('.date-cell[data-date="2026-06-13"] .avatar-chip')[1];
        const cs = getComputedStyle(chip);
        return {
          w: cs.width, h: cs.height, ring: cs.borderTopWidth,
          overlap: getComputedStyle(second).marginLeft,
          count: document.querySelectorAll('.date-cell[data-date="2026-06-13"] .avatar-chip').length,
          more: (document.querySelector('.date-cell[data-date="2026-06-13"] .avatar-chip.more') || {}).textContent,
        };
      });
      ok("avatar chips are 20×20 with a 2px accent ring",
        box.w === "20px" && box.h === "20px" && box.ring === "2px", JSON.stringify(box));
      ok("stacked chips overlap by 6px", box.overlap === "-6px", box.overlap);
      ok("a fourth assignee becomes a +1 counter", box.more === "+1", JSON.stringify(box));
    }

    /* the team filter dims rather than hides */
    {
      await page.selectOption("#assigneeFilter", "wesley");
      await page.waitForTimeout(200);
      const dimmed = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll(".cell-card"));
        const unassigned = cards.find((c) => !c.querySelector(".avatar-chip"));
        return { opacity: unassigned ? getComputedStyle(unassigned).opacity : null, still: cards.length };
      });
      ok("filtering by a team member dims the others to 30%",
        dimmed.opacity === "0.3", JSON.stringify(dimmed));
      ok("dimmed cards are still on the grid, not removed", dimmed.still > 1, String(dimmed.still));
      await page.selectOption("#assigneeFilter", "ALL");
    }

    /* 500ms debounced auto-save */
    {
      await page.click('.date-cell[data-date="2026-06-13"] .cell-card');
      await page.waitForTimeout(300);
      await page.fill(`textarea[data-field="hook"][data-item="${a.id}"]`, "Stop scrolling — three-bed on Alamo Ranch");
      await page.waitForTimeout(150);
      const early = await jget("/api/planner/items?from=2026-06-01&to=2026-06-30");
      ok("typing does not hit the server immediately",
        early.items.find((i) => i.id === a.id).hook !== "Stop scrolling — three-bed on Alamo Ranch");
      ok("the panel says it is saving",
        /Saving/.test(await page.locator(`#save-${a.id}`).innerText()));
      await page.waitForTimeout(900);
      const late = await jget("/api/planner/items?from=2026-06-01&to=2026-06-30");
      ok("and 500ms after the last keystroke it is persisted",
        late.items.find((i) => i.id === a.id).hook === "Stop scrolling — three-bed on Alamo Ranch",
        late.items.find((i) => i.id === a.id).hook);
      ok("the panel confirms the save",
        (await page.locator(`#save-${a.id}`).innerText()).trim() === "Saved");
    }

    /* completion strikes the title through */
    {
      // Just click it. Pre-setting .checked is wrong: a checkbox's activation
      // behaviour toggles it again, so the handler would read back `false`.
      await page.evaluate((id) => {
        document.querySelector(`.cell-card [data-complete-for="${id}"]`).click();
      }, a.id);
      await page.waitForTimeout(300);
      const deco = await page.evaluate((id) => {
        const card = document.querySelector(`.cell-card[data-item-id="${id}"]`);
        const title = card && card.querySelector(".card-title");
        return {
          cls: card ? card.className : null,
          line: title ? getComputedStyle(title).textDecorationLine : null,
        };
      }, a.id);
      ok("a completed card is struck through", deco.line === "line-through", JSON.stringify(deco));
      await patch(a.id, { isCompleted: false });
      await page.evaluate(() => window.__planner.reload());
    }

    /* the media drive button opens in a new tab */
    {
      await patch(a.id, { assetDriveUrl: "https://drive.google.com/drive/folders/xyz" });
      await page.evaluate(() => window.__planner.reload());
      await page.waitForTimeout(400);
      await page.click('.date-cell[data-date="2026-06-13"] .cell-card');
      await page.waitForTimeout(300);
      const link = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("#accordionContainer a")).find((x) => /Open media drive/i.test(x.textContent));
        return el ? { href: el.getAttribute("href"), target: el.getAttribute("target"), rel: el.getAttribute("rel") } : null;
      });
      ok("the media drive link opens in a new tab",
        link && link.href === "https://drive.google.com/drive/folders/xyz" && link.target === "_blank" && /noopener/.test(link.rel),
        JSON.stringify(link));
    }

    /* the three synchronised drag-mode controls */
    {
      await page.click('#headerModeToggle button[data-mode="DIRECT"]');
      await page.waitForTimeout(250);
      const synced = await page.evaluate(() => ({
        header: document.querySelector("#headerModeToggle button.active").dataset.mode,
        bubble: document.querySelector("#bubbleModeToggle button.active").dataset.mode,
        banner: document.getElementById("modeBanner").innerText,
      }));
      ok("the header switch and the floating bubble stay in step",
        synced.header === "DIRECT" && synced.bubble === "DIRECT", JSON.stringify(synced));
      ok("the banner explains the active mode", /only the post you drag moves/i.test(synced.banner), synced.banner);
      const persisted = await jget("/api/planner/settings");
      ok("the mode is saved server-side, not just in the tab", persisted.dragMode === "DIRECT", persisted.dragMode);

      await page.keyboard.down("Shift");
      await page.waitForTimeout(120);
      const held = await page.evaluate(() => ({
        eff: window.__planner.effectiveMode(),
        header: document.querySelector("#headerModeToggle button.active").dataset.mode,
        bubble: document.querySelector("#bubbleModeToggle button.active").dataset.mode,
      }));
      ok("holding Shift flips to the other mode on every control",
        held.eff === "DOMINO" && held.header === "DOMINO" && held.bubble === "DOMINO", JSON.stringify(held));
      await page.keyboard.up("Shift");
      await page.waitForTimeout(120);
      ok("releasing Shift restores the chosen mode",
        (await page.evaluate(() => window.__planner.effectiveMode())) === "DIRECT");
      await page.click('#headerModeToggle button[data-mode="DOMINO"]');
      await page.waitForTimeout(200);
    }

    /* real HTML5 drag events through the real handlers */
    const drag = async (fromSel, toDate, opts = {}) =>
      page.evaluate(async ({ fromSel, toDate, opts }) => {
        const src = document.querySelector(fromSel);
        const cell = document.querySelector(`.date-cell[data-date="${toDate}"]`);
        if (!src || !cell) return { error: "missing " + (src ? "cell" : "card") };
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        cell.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, opts.dwell || 40));
        const out = { expanded: cell.classList.contains("expanded"), over: cell.classList.contains("drag-over") };
        if (opts.hourIndex != null) {
          const slot = cell.querySelectorAll(".hour-slot")[opts.hourIndex];
          if (slot) {
            slot.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
            out.insertLine = getComputedStyle(slot).borderTopWidth;
            out.hour = slot.dataset.hour;
          }
        }
        if (opts.previewOnly) {
          out.ripple = document.querySelectorAll(".date-cell.ripple-preview").length;
          out.overlay = document.getElementById("rippleOverlay").classList.contains("show");
          out.overlayText = document.getElementById("rippleTitle").textContent;
          src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
          return out;
        }
        cell.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 700));
        return out;
      }, { fromSel, toDate, opts });

    {
      /* a clean three-post run to drag around */
      for (const id of (await jget("/api/planner/items?from=2026-01-01&to=2027-12-31")).items.map((i) => i.id)) {
        await api(`/api/planner/items/${id}?actor=verify`, { method: "DELETE" });
      }
      const p1 = (await create({ title: "Drag me", date: "2026-06-10", time: "10:00", authoredTz: CHI })).item;
      const p2 = (await create({ title: "Downstream", date: "2026-06-12", time: "11:00", authoredTz: CHI })).item;
      await page.evaluate(() => window.__planner.reload());
      await page.waitForTimeout(500);

      const preview = await drag(`.cell-card[data-item-id="${p1.id}"]`, "2026-06-14", { previewOnly: true, dwell: 500 });
      ok("hovering a day in Domino mode highlights the ripple",
        preview.ripple >= 1 && preview.overlay === true, JSON.stringify(preview));
      ok("the preview names how many posts would move",
        /1 later post shifts \+4d/.test(preview.overlayText), preview.overlayText);
      const untouched = (await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.find((i) => i.id === p2.id);
      ok("hovering alone changes nothing", untouched.gridDate === "2026-06-12", untouched.gridDate);

      await drag(`.cell-card[data-item-id="${p1.id}"]`, "2026-06-14");
      const after = Object.fromEntries((await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.map((i) => [i.id, i.gridDate]));
      ok("dropping in Domino mode moves the card and its downstream",
        after[p1.id] === "2026-06-14" && after[p2.id] === "2026-06-16", JSON.stringify(after));

      await page.click('#headerModeToggle button[data-mode="DIRECT"]');
      await page.waitForTimeout(200);
      const direct = await drag(`.cell-card[data-item-id="${p1.id}"]`, "2026-06-20", { dwell: 320, hourIndex: 8 });
      ok("in Direct mode the cell opens an hourly timeline", direct.expanded === true, JSON.stringify(direct));
      ok("the insertion line is 2px", direct.insertLine === "2px", direct.insertLine);
      const afterDirect = Object.fromEntries((await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.map((i) => [i.id, i]));
      ok("dropping on an hour sets that hour",
        afterDirect[p1.id].primary.time === "02:00 PM", afterDirect[p1.id].primary.time);
      ok("and nothing downstream moved", afterDirect[p2.id].gridDate === "2026-06-16", afterDirect[p2.id].gridDate);
      await page.click('#headerModeToggle button[data-mode="DOMINO"]');
    }

    /* the scratchpad drawer */
    {
      await page.click("#scratchBtn");
      await page.waitForTimeout(400);
      ok("the scratchpad drawer opens", await page.locator("#drawer.open").count() === 1);
      ok("the quick-capture field takes focus",
        await page.evaluate(() => document.activeElement && document.activeElement.id === "quickIdea"));

      await page.fill("#quickIdea", "Neighbourhood market minute");
      await page.press("#quickIdea", "Enter");
      await page.waitForTimeout(700);
      ok("typing an idea captures it with no date",
        (await jget("/api/planner/backlog")).items.some((i) => i.title === "Neighbourhood market minute"));
      ok("the header count follows the backlog",
        (await page.locator("#scratchCount").innerText()).trim() === String((await jget("/api/planner/backlog")).count));

      await page.fill("#quickIdea", "Open house recap");
      await page.press("#quickIdea", "Enter");
      await page.waitForTimeout(700);
      await page.fill("#ideaSearch", "market");
      await page.waitForTimeout(250);
      ok("search filters the scratchpad", (await page.locator("#ideaList .idea-card").count()) === 1);
      await page.fill("#ideaSearch", "");
      await page.waitForTimeout(200);

      await page.click('#drawerTabs button[data-view="kanban"]');
      await page.waitForTimeout(250);
      ok("the kanban view shows the three pipeline columns",
        (await page.locator(".kanban-col").count()) === 3);
      const colTitles = await page.locator(".kanban-col h4").allInnerTexts();
      ok("named Brainstorm, Drafting and Ready to Schedule",
        /brainstorm/i.test(colTitles[0]) && /drafting/i.test(colTitles[1]) && /ready to schedule/i.test(colTitles[2]),
        JSON.stringify(colTitles));
      await page.click('#drawerTabs button[data-view="list"]');
      await page.waitForTimeout(250);

      /* drag an idea from the drawer onto a day */
      const ideaEl = await page.locator("#ideaList .idea-card").first().getAttribute("data-idea-id");
      await page.evaluate(async (ideaEl) => {
        const src = document.querySelector(`.idea-card[data-idea-id="${ideaEl}"]`);
        const cell = document.querySelector('.date-cell[data-date="2026-06-26"]');
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        cell.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
        cell.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 800));
      }, ideaEl);
      await page.waitForTimeout(600);
      const nowScheduled = (await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.find((i) => i.id === ideaEl);
      ok("dragging an idea from the drawer onto a day schedules it",
        !!nowScheduled && nowScheduled.gridDate === "2026-06-26", nowScheduled && nowScheduled.gridDate);

      /* reverse-drag a scheduled card back onto the drawer */
      await page.evaluate(async (id) => {
        const src = document.querySelector(`.cell-card[data-item-id="${id}"]`);
        const drawer = document.getElementById("drawer");
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        drawer.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
        drawer.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 800));
      }, ideaEl);
      await page.waitForTimeout(600);
      ok("reverse-dragging a card onto the drawer unschedules it",
        (await jget("/api/planner/backlog")).items.some((i) => i.id === ideaEl));
      await page.click("#drawerClose");
    }

    /* the grid anchor toggle, from the page */
    {
      const late = (await create({ title: "Late night", date: "2026-06-18", time: "23:30", authoredTz: CHI })).item;
      await jsend("/api/planner/settings", "PUT", { secondaryTz: "Asia/Manila" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".date-cell");
      await page.evaluate(() => {
        const p = window.__planner;
        p.state.year = 2026; p.state.month = 6;
        return p.reload();
      });
      await page.waitForTimeout(600);
      ok("a card crossing midnight in the audience zone is badged",
        /\+1d/.test(await page.locator(`.cell-card[data-item-id="${late.id}"] .time-badge`).innerText()),
        await page.locator(`.cell-card[data-item-id="${late.id}"] .time-badge`).innerText());
      ok("it sits on the creator's day while anchored to the creator",
        (await page.locator(`.date-cell[data-date="2026-06-18"] .cell-card[data-item-id="${late.id}"]`).count()) === 1);
      await page.click("#anchorToggle");
      await page.waitForTimeout(900);
      ok("flipping the anchor re-sorts it into the audience's day",
        (await page.locator(`.date-cell[data-date="2026-06-19"] .cell-card[data-item-id="${late.id}"]`).count()) === 1);
      ok("and the button says which zone the grid is anchored to",
        /Manila/.test(await page.locator("#anchorToggle").innerText()),
        await page.locator("#anchorToggle").innerText());
      await page.click("#anchorToggle");
      await page.waitForTimeout(700);
    }

    /* mobile: the drawer becomes a bottom sheet */
    {
      await page.setViewportSize({ width: 420, height: 900 });
      await page.waitForTimeout(300);
      const sheet = await page.evaluate(() => {
        const d = document.getElementById("drawer");
        const cs = getComputedStyle(d);
        return { width: cs.width, bottom: cs.bottom, radius: cs.borderTopLeftRadius, height: cs.height };
      });
      ok("on a phone the scratchpad is a full-width bottom sheet",
        parseInt(sheet.width) >= 400 && sheet.bottom === "0px" && sheet.radius === "16px", JSON.stringify(sheet));
      await page.setViewportSize({ width: 1600, height: 1100 });
    }

    ok("still no script errors after the whole run", errs.length === 0, errs.slice(0, 3).join(" | "));
    await br.close();
  }
} catch (err) {
  fail.push("suite threw: " + (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
  console.error(err);
} finally {
  srv.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.error(" ✗ " + f)); process.exit(1); }
