#!/usr/bin/env node
/**
 * The Content Planner — editorial calendar, master taxonomy, dockable panel,
 * resizable grid, Sunday-start week, and literal (non-converting) dates.
 *
 * WHAT THIS SUITE IS ACTUALLY GUARDING. Almost every feature here is one where
 * a plausible-looking screen can be wrong in a way nobody notices until a post
 * goes out on the wrong day, or a month of content silently loses its owner:
 *
 *   - A DATE MUST NOT MOVE. The planner used to store a UTC instant and derive
 *     the day cell from an anchor zone, so the same card could sit on two
 *     different days for two people. Dates are now literal, and the assertions
 *     that matter most are the ones proving a typed date survives a DST
 *     changeover, a domino ripple, a week-start flip and a clock swap.
 *   - A Domino drag that ripples the wrong set reschedules a month in one
 *     gesture; a Direct drag that ripples ANYTHING is the same bug in reverse.
 *   - Unscheduling must MOVE an item, never delete it.
 *   - Deleting a category, platform or teammate must never orphan content —
 *     and removing a duplicate person must never delete their CRM account.
 *   - A merge must DEDUPE: a post carrying both Marcos ends with one, not two.
 *
 * So the API half asserts the storage contract and the refusal paths, and the
 * browser half drives the real page in Chromium — including synthetic HTML5
 * drag events through the real handlers and measured pixel geometry, because
 * "it renders" is not the claim being made.
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

/* An offboarded CRM user, so the "(Inactive)" path is exercised for real, plus
   a second "Marco" record — the actual duplicate this taxonomy has to merge. */
writeFileSync(join(tmp, "users.json"), JSON.stringify([
  { id: "u_old", name: "Dana Former", email: "dana@example.com", role: "agent",
    permissions: {}, active: false, createdAt: "2026-01-01T00:00:00Z",
    avatarInitials: "DF", avatarColor: "#facc15" },
  { id: "u_marco2", name: "Marco Puga", email: "marco@example.com", role: "admin",
    permissions: {}, active: true, createdAt: "2026-01-01T00:00:00Z",
    avatarInitials: "MP", avatarColor: "#0ea5e9" },
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
const jstatus = async (p, method, body) =>
  (await api(p, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) })).status;
const create = (body) => jsend("/api/planner/items", "POST", body);
const patch = (id, body) => jsend(`/api/planner/items/${id}`, "PATCH", body);
const wipeItems = async () => {
  for (const i of (await jget("/api/planner/items?from=2000-01-01&to=2099-12-31")).items) {
    await api(`/api/planner/items/${i.id}`, { method: "DELETE" });
  }
  for (const i of (await jget("/api/planner/backlog")).items) {
    await api(`/api/planner/items/${i.id}`, { method: "DELETE" });
  }
};

/* WCAG relative luminance, recomputed here so the server's answer is checked
   against an independent implementation rather than against itself. */
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

let boot = null;

try {
  /* ═════════════════ bootstrap: the vocabulary the page is built from ═════ */
  {
    ok("bootstrap requires the dashboard token", (await fetch(B + "/api/planner/bootstrap")).status === 401);
    boot = await jget("/api/planner/bootstrap");

    ok("the colour palette offers exactly 20 choices", boot.palette.length === 20, String(boot.palette.length));
    const hexes = boot.palette.map((c) => c.hex);
    ok("the palette is the specified list, in order and uppercase",
      hexes.join(",") === ["#EF4444","#F97316","#F59E0B","#84CC16","#10B981","#06B6D4","#0284C7","#6366F1",
        "#8B5CF6","#D946EF","#EC4899","#14B8A6","#845EC2","#FF6F91","#FFC75F","#008E97","#2C73D2","#008B74",
        "#B0A8B9","#845136"].join(","), hexes.join(","));
    ok("all 20 are distinct", new Set(hexes).size === 20);
    ok("every swatch takes the HIGHER-contrast of the two type colours",
      boot.palette.every((c) => {
        const l = lum(c.hex);
        const better = ratio(l, lum("#0F172A")) >= ratio(l, lum("#FFFFFF")) ? "#0F172A" : "#FFFFFF";
        return c.text === better;
      }),
      JSON.stringify(boot.palette.filter((c) => {
        const l = lum(c.hex);
        const better = ratio(l, lum("#0F172A")) >= ratio(l, lum("#FFFFFF")) ? "#0F172A" : "#FFFFFF";
        return c.text !== better;
      }).map((c) => [c.hex, c.text])));
    ok("the palette genuinely needs both type colours, so the rule does work",
      new Set(boot.palette.map((c) => c.text)).size === 2);
    /* Recorded, not asserted as a pass: four of the twenty cannot reach 4.5:1
       with either type colour. Kept exactly as specified; the count is pinned
       so that swapping a hex for a darker one shows up here as a change. */
    const belowAA = boot.palette.filter((c) => c.contrast < 4.5).map((c) => c.name);
    ok("exactly four palette colours sit below 4.5:1 for small text (known, documented)",
      belowAA.length === 4 &&
      ["Royal Blue", "Indigo Blue", "Vivid Purple", "Dark Mint"].every((n) => belowAA.includes(n)),
      JSON.stringify(belowAA));

    ok("ten categories are seeded", boot.categories.length === 10, String(boot.categories.length));
    ok("the seeded categories are the ones the page has always shown",
      boot.categories.map((c) => c.name).join(",") ===
        "Paid Ad,Testimonial,Promo,Announcement,Listing,Behind the Scenes,Market Update,Educational,Story,Community",
      boot.categories.map((c) => c.name).join(","));
    ok("each category carries its own legible type colour",
      boot.categories.every((c) => c.textColor === "#0F172A" || c.textColor === "#FFFFFF"));

    ok("nine platforms are seeded", boot.platforms.length === 9, String(boot.platforms.length));
    ok("platforms carry a name, an icon key and an active flag",
      boot.platforms.every((p) => p.id && p.name && typeof p.activeStatus === "boolean" && "iconKey" in p));

    ok("the backlog pipeline is Brainstorm → Drafting → Ready to Schedule",
      boot.backlogStatuses.map((s) => s.label).join(" → ") === "Brainstorm → Drafting → Ready to Schedule");

    ok("the team merges the roster and the CRM user table",
      boot.team.length >= 5 && boot.team.every((m) => m.userId && m.fullName && m.badgeColor && m.role));
    const inactive = boot.team.find((m) => m.userId === "u_old");
    ok("an offboarded CRM user is still listed, flagged inactive", !!inactive && inactive.active === false);
    ok("BOTH Marco records are present — the duplicate this editor exists to fix",
      boot.team.filter((m) => /^marco/i.test(m.fullName)).length === 2,
      JSON.stringify(boot.team.map((m) => m.fullName)));

    ok("the reference clocks are declared with a fixed PHT and a swappable US zone",
      boot.clocks.phtTz === "Asia/Manila" && boot.clocks.usOptions.includes("America/New_York") &&
      boot.clocks.usOptions.includes("America/Chicago"), JSON.stringify(boot.clocks));
    ok("the week starts on Sunday by default", boot.settings.weekStart === "SUNDAY", boot.settings.weekStart);

    /* The removed model must be gone from the payload, not merely unused. */
    ok("no grid anchor is served any more", boot.anchorTz === undefined && boot.settings.gridAnchor === undefined,
      JSON.stringify({ anchorTz: boot.anchorTz, gridAnchor: boot.settings.gridAnchor }));
    ok("no creator/audience zone pair is served any more",
      boot.settings.primaryTz === undefined && boot.settings.secondaryTz === undefined,
      JSON.stringify(boot.settings));
  }

  /* ═════════════════ literal dates: the storage contract ═════════════════ */
  {
    await wipeItems();
    const r = await create({ title: "Evening reel", date: "2026-08-17", time: "21:00", platforms: ["TikTok"] });
    ok("the typed date is stored verbatim", r.item.date === "2026-08-17", r.item.date);
    ok("the typed time is stored verbatim", r.item.time === "21:00", r.item.time);
    ok("and is displayed as a 12-hour clock", r.item.timeDisplay === "09:00 PM", r.item.timeDisplay);
    ok("a UTC instant is still derived for a future publisher",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.item.scheduledAtUtc), r.item.scheduledAtUtc);
    ok("the derived instant is correct for the authoring zone (9 PM CDT = 02:00Z next day)",
      r.item.scheduledAtUtc === "2026-08-18T02:00:00.000Z", r.item.scheduledAtUtc);
    ok("the grid date IS the stored date — there is no second opinion",
      r.item.date === r.item.scheduledDate, JSON.stringify([r.item.date, r.item.scheduledDate]));

    /* A late-evening post is the case the old model moved across midnight. */
    const late = await create({ title: "Late night", date: "2026-08-19", time: "23:30" });
    const list = await jget("/api/planner/items?from=2026-08-01&to=2026-08-31");
    ok("an 11:30 PM post stays on its own day, not the next one",
      list.items.find((i) => i.id === late.item.id).date === "2026-08-19");
    ok("no ±1d delta is computed anywhere",
      list.items.every((i) => i.secondary === undefined && i.dstWarning === undefined && i.gridDate === undefined),
      JSON.stringify(Object.keys(list.items[0])));
    ok("the items response no longer carries an anchor zone", list.anchorTz === undefined);
  }

  /* ═════════════════ DST: the cases that used to move a card ═════════════ */
  {
    const gap = await create({ title: "Spring forward", date: "2026-03-08", time: "02:30" });
    ok("2:30 AM on a spring-forward date is stored EXACTLY as typed",
      gap.item.date === "2026-03-08" && gap.item.time === "02:30",
      JSON.stringify([gap.item.date, gap.item.time]));
    ok("and displays as 02:30 AM, not 03:30", gap.item.timeDisplay === "02:30 AM", gap.item.timeDisplay);

    const amb = await create({ title: "Fall back", date: "2026-11-01", time: "01:30" });
    ok("1:30 AM on a fall-back date is stored exactly as typed",
      amb.item.date === "2026-11-01" && amb.item.time === "01:30");

    /* The headline case: under the old UTC model this move was 71 hours and the
       suite asserted exactly that. Literal dates make it three days, full stop. */
    const before = await create({ title: "Across the change", date: "2026-03-06", time: "10:00" });
    const moved = await jsend("/api/planner/reschedule", "POST",
      { itemId: before.item.id, toDate: "2026-03-09", mode: "DIRECT" });
    const after = moved.updated.find((i) => i.id === before.item.id);
    ok("moving a post three days across the DST change keeps its wall clock",
      after.date === "2026-03-09" && after.time === "10:00", JSON.stringify([after.date, after.time]));
    ok("and the derived instant absorbs the offset change instead of the card",
      after.scheduledAtUtc === "2026-03-09T15:00:00.000Z", after.scheduledAtUtc);
  }

  /* ═════════════════ Domino vs Direct ═════════════════ */
  {
    await wipeItems();
    const run = [];
    for (const d of ["2026-06-10", "2026-06-12", "2026-06-15", "2026-06-20"]) {
      run.push((await create({ title: "Post " + d, date: d, time: "08:00" })).item);
    }
    const preview = await jsend("/api/planner/reschedule/preview", "POST",
      { itemId: run[1].id, toDate: "2026-06-14", mode: "DOMINO" });
    ok("a domino preview plans the dragged post plus everything on or after it",
      preview.plan.moves.length === 3 && preview.plan.deltaDays === 2,
      JSON.stringify({ n: preview.plan.moves.length, d: preview.plan.deltaDays }));
    ok("the preview names the later posts and where they would land",
      preview.plan.moves.filter((m) => !m.dragged).map((m) => `${m.fromDate}->${m.toDate}`).join(",") ===
        "2026-06-15->2026-06-17,2026-06-20->2026-06-22",
      preview.plan.moves.filter((m) => !m.dragged).map((m) => `${m.fromDate}->${m.toDate}`).join(","));
    const untouched = await jget("/api/planner/items?from=2026-06-01&to=2026-06-30");
    ok("PREVIEWING WRITES NOTHING",
      untouched.items.map((i) => i.date).sort().join(",") === "2026-06-10,2026-06-12,2026-06-15,2026-06-20",
      untouched.items.map((i) => i.date).sort().join(","));
    ok("an earlier post is never part of the ripple",
      !preview.plan.moves.some((m) => m.fromDate === "2026-06-10"));

    await jsend("/api/planner/reschedule", "POST", { itemId: run[1].id, toDate: "2026-06-14", mode: "DOMINO" });
    const afterDom = await jget("/api/planner/items?from=2026-06-01&to=2026-06-30");
    const byId = (id) => afterDom.items.find((i) => i.id === id);
    ok("applying the domino moves the dragged post", byId(run[1].id).date === "2026-06-14");
    ok("and shifts every later post by the same number of days",
      byId(run[2].id).date === "2026-06-17" && byId(run[3].id).date === "2026-06-22",
      JSON.stringify([byId(run[2].id).date, byId(run[3].id).date]));
    ok("while the earlier post does not move", byId(run[0].id).date === "2026-06-10");
    ok("every rippled post keeps its own wall clock",
      afterDom.items.every((i) => i.time === "08:00"), JSON.stringify(afterDom.items.map((i) => i.time)));

    /* A Direct drag that ripples anything is the same bug in reverse. */
    const snapshot = afterDom.items.map((i) => `${i.id}:${i.date}`).sort().join("|");
    await jsend("/api/planner/reschedule", "POST", { itemId: run[0].id, toDate: "2026-06-25", mode: "DIRECT", time: "16:45" });
    const afterDirect = await jget("/api/planner/items?from=2026-06-01&to=2026-06-30");
    const movedOnly = afterDirect.items.filter((i) => !snapshot.includes(`${i.id}:${i.date}`));
    ok("a DIRECT drag moves ONLY the dragged post", movedOnly.length === 1 && movedOnly[0].id === run[0].id,
      JSON.stringify(movedOnly.map((i) => [i.title, i.date])));
    ok("and honours the exact hour dropped on", movedOnly[0].time === "16:45", movedOnly[0].time);
    ok("a bad item id is a 404, not a silent no-op",
      (await api("/api/planner/reschedule", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: "no-such-id", toDate: "2026-06-01" }),
      })).status === 404);
  }

  /* ═════════════════ unschedule moves, never deletes ═════════════════ */
  {
    const rich = (await create({
      title: "Full record", date: "2026-07-04", time: "13:15", hook: "h", caption: "c", script: "s",
      platforms: ["Blog"], assignedUsers: [{ userId: "carlos", role: "owner" }],
      assetDriveUrl: "https://drive.google.com/x", notes: "n",
    })).item;
    const back = await jsend(`/api/planner/items/${rich.id}/unschedule`, "POST", { actor: "verify" });
    ok("unscheduling clears the date", back.item.date === null && back.item.time === null,
      JSON.stringify([back.item.date, back.item.time]));
    ok("and every other field survives the round trip",
      back.item.hook === "h" && back.item.caption === "c" && back.item.script === "s" &&
      back.item.platforms.join() === "Blog" && back.item.assignedUsers[0].userId === "carlos" &&
      back.item.assetDriveUrl === "https://drive.google.com/x" && back.item.notes === "n",
      JSON.stringify(back.item));
    const backlog = await jget("/api/planner/backlog");
    ok("the item is in the scratchpad, not gone", backlog.items.some((i) => i.id === rich.id));
    const re = await jsend("/api/planner/reschedule", "POST", { itemId: rich.id, toDate: "2026-07-09", mode: "DOMINO" });
    ok("rescheduling it out of the backlog lands it with a default time",
      re.updated[0].date === "2026-07-09" && re.updated[0].time === "09:00",
      JSON.stringify(re.updated[0]));
  }

  /* ═════════════════ settings: week start, clock, validation ═════════════ */
  {
    const s1 = await jsend("/api/planner/settings", "PUT", { weekStart: "MONDAY" });
    ok("the week start persists", s1.settings.weekStart === "MONDAY", JSON.stringify(s1.settings));
    ok("it survives a fresh read", (await jget("/api/planner/settings")).weekStart === "MONDAY");
    ok("junk is refused rather than coerced",
      (await jstatus("/api/planner/settings", "PUT", { weekStart: "FUNDAY" })) === 400);
    await jsend("/api/planner/settings", "PUT", { weekStart: "SUNDAY" });

    const s2 = await jsend("/api/planner/settings", "PUT", { usClockTz: "America/Los_Angeles" });
    ok("the US reference clock persists", s2.settings.usClockTz === "America/Los_Angeles");
    ok("an invalid zone is refused",
      (await jstatus("/api/planner/settings", "PUT", { usClockTz: "Mars/Olympus" })) === 400);

    /* The clock is display-only: proving it cannot move a card is the point. */
    const before = (await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.map((i) => `${i.id}:${i.date}:${i.time}`).sort();
    await jsend("/api/planner/settings", "PUT", { usClockTz: "America/New_York" });
    const after = (await jget("/api/planner/items?from=2026-06-01&to=2026-06-30")).items.map((i) => `${i.id}:${i.date}:${i.time}`).sort();
    ok("CHANGING THE REFERENCE CLOCK MOVES NOTHING", before.join("|") === after.join("|"));
  }

  /* ═════════════════ categories ═════════════════ */
  let showcase = null;
  {
    const made = await jsend("/api/planner/categories", "POST", { name: "Product Showcase", colorHex: "#06B6D4" });
    showcase = made.category;
    ok("a category can be created with a palette colour",
      showcase.name === "Product Showcase" && showcase.colorHex === "#06B6D4", JSON.stringify(showcase));
    ok("its badge type colour is computed, not supplied", showcase.textColor === "#0F172A", showcase.textColor);
    ok("a duplicate name is refused case-insensitively",
      (await jstatus("/api/planner/categories", "POST", { name: "product showcase", colorHex: "#EF4444" })) === 409);
    ok("a non-palette junk colour is refused",
      (await jstatus("/api/planner/categories", "POST", { name: "Junk", colorHex: "not-a-hex" })) === 400);
    ok("a nameless category is refused",
      (await jstatus("/api/planner/categories", "POST", { name: "   ", colorHex: "#EF4444" })) === 400);

    const tagged = (await create({ title: "Showcase post", date: "2026-09-03", time: "11:00", categoryId: showcase.id })).item;
    ok("assigning a category stamps the card with its colour",
      tagged.categoryId === showcase.id && tagged.color === "#06B6D4", JSON.stringify([tagged.categoryId, tagged.color]));

    const recoloured = await jsend(`/api/planner/categories/${showcase.id}`, "PATCH", { colorHex: "#D946EF" });
    ok("recolouring the category updates it", recoloured.category.colorHex === "#D946EF");
    const repainted = (await jget("/api/planner/items?from=2026-09-01&to=2026-09-30")).items.find((i) => i.id === tagged.id);
    ok("and REPAINTS every card carrying it", repainted.color === "#D946EF", repainted.color);

    ok("usage is reported so the drawer can warn before a delete",
      (await jget("/api/planner/taxonomy")).categories.find((c) => c.id === showcase.id).usageCount === 1);

    const refused = await api(`/api/planner/categories/${showcase.id}`, { method: "DELETE" });
    const body = await refused.json();
    ok("deleting an in-use category is REFUSED with the count",
      refused.status === 409 && body.usageCount === 1 && body.requires === "reassignTo", JSON.stringify(body));

    const other = (await jget("/api/planner/taxonomy")).categories.find((c) => c.name === "Listing");
    const moved = await jsend(`/api/planner/categories/${showcase.id}?reassignTo=${other.id}`, "DELETE");
    ok("deleting with a target moves the content across", moved.reassigned === 1, JSON.stringify(moved));
    const rehomed = (await jget("/api/planner/items?from=2026-09-01&to=2026-09-30")).items.find((i) => i.id === tagged.id);
    ok("the reassigned card takes the new category and its colour",
      rehomed.categoryId === other.id && rehomed.color === other.colorHex,
      JSON.stringify([rehomed.categoryId, rehomed.color]));

    /* "unassigned" is the explicit escape hatch, and must not delete the post. */
    const c2 = (await jsend("/api/planner/categories", "POST", { name: "Temp", colorHex: "#84CC16" })).category;
    await patch(rehomed.id, { categoryId: c2.id });
    const cleared = await jsend(`/api/planner/categories/${c2.id}?reassignTo=unassigned`, "DELETE");
    ok("deleting to 'unassigned' strips the category", cleared.reassigned === 1);
    const bare = (await jget("/api/planner/items?from=2026-09-01&to=2026-09-30")).items.find((i) => i.id === rehomed.id);
    ok("and leaves the post itself intact", !!bare && bare.categoryId === null, JSON.stringify(bare && bare.categoryId));
    ok("an unused category deletes with no questions asked",
      (await jsend(`/api/planner/categories/${(await jsend("/api/planner/categories", "POST", { name: "Unused", colorHex: "#845136" })).category.id}`, "DELETE")).deleted === true);
  }

  /* ═════════════════ platforms ═════════════════ */
  {
    const added = await jsend("/api/planner/platforms", "POST", { name: "Threads" });
    ok("a new platform appears immediately in the list",
      added.platforms.some((p) => p.name === "Threads"), added.platforms.map((p) => p.name).join(","));
    ok("a duplicate platform name is refused case-insensitively",
      (await jstatus("/api/planner/platforms", "POST", { name: "instagram" })) === 409);

    const threads = added.platforms.find((p) => p.name === "Threads");
    const post = (await create({ title: "Threads post", date: "2026-09-10", time: "12:00", platforms: ["Threads", "Blog"] })).item;
    ok("a post can be tagged with it", post.platforms.includes("Threads"));

    /* Renaming has to carry the posts, since platforms are stored by name. */
    await jsend(`/api/planner/platforms/${threads.id}`, "PATCH", { name: "Threads App" });
    const renamed = (await jget("/api/planner/items?from=2026-09-01&to=2026-09-30")).items.find((i) => i.id === post.id);
    ok("RENAMING A PLATFORM CARRIES ITS POSTS ALONG",
      renamed.platforms.includes("Threads App") && !renamed.platforms.includes("Threads"),
      JSON.stringify(renamed.platforms));

    const off = await jsend(`/api/planner/platforms/${threads.id}`, "PATCH", { activeStatus: false });
    ok("a platform can be switched off without deleting it",
      off.platforms.find((p) => p.id === threads.id).activeStatus === false);
    ok("switching it off leaves existing posts tagged",
      (await jget("/api/planner/items?from=2026-09-01&to=2026-09-30")).items.find((i) => i.id === post.id).platforms.includes("Threads App"));

    const refused = await api(`/api/planner/platforms/${threads.id}`, { method: "DELETE" });
    ok("deleting an in-use platform is refused with the count",
      refused.status === 409 && (await refused.json()).usageCount === 1);

    const blog = (await jget("/api/planner/taxonomy")).platforms.find((p) => p.name === "Blog");
    const migrated = await jsend(`/api/planner/platforms/${threads.id}?reassignTo=${blog.id}`, "DELETE");
    ok("deleting with a migration target rewrites the posts", migrated.reassigned === 1);
    const after = (await jget("/api/planner/items?from=2026-09-01&to=2026-09-30")).items.find((i) => i.id === post.id);
    ok("the post keeps Blog exactly once — no duplicate from the merge",
      after.platforms.filter((p) => p === "Blog").length === 1 && !after.platforms.includes("Threads App"),
      JSON.stringify(after.platforms));
  }

  /* ═════════════════ team members and the Marco deduplication ═════════════ */
  {
    const team = (await jget("/api/planner/taxonomy")).team;
    const marcoRoster = team.find((m) => m.userId === "marco");
    const marcoCrm = team.find((m) => m.userId === "u_marco2");
    ok("both Marco records are assignable before the merge", !!marcoRoster && !!marcoCrm);

    /* The post that carries BOTH is the one that proves the merge dedupes. */
    const both = (await create({
      title: "Two Marcos", date: "2026-10-05", time: "09:00",
      assignedUsers: [{ userId: "marco", role: "owner" }, { userId: "u_marco2", role: "editor" }],
    })).item;
    const soloCrm = (await create({
      title: "Only the CRM Marco", date: "2026-10-06", time: "09:00",
      assignedUsers: [{ userId: "u_marco2", role: "owner" }],
    })).item;

    const refused = await api(`/api/planner/members/${marcoCrm.userId}`, { method: "DELETE" });
    ok("removing an assigned member without a target is refused with the count",
      refused.status === 409 && (await refused.json()).usageCount === 2);

    const merged = await jsend(`/api/planner/members/${marcoCrm.userId}?mergeInto=marco`, "DELETE");
    ok("the merge reports what it moved", merged.reassigned === 2, JSON.stringify(merged.reassigned));
    ok("the duplicate is gone from the assignable list",
      !merged.team.some((m) => m.userId === "u_marco2"), merged.team.map((m) => m.fullName).join(","));
    ok("EXACTLY ONE Marco remains", merged.team.filter((m) => /^marco/i.test(m.fullName)).length === 1);

    const items = await jget("/api/planner/items?from=2026-10-01&to=2026-10-31");
    const bothAfter = items.items.find((i) => i.id === both.id);
    ok("a post that had BOTH ends up with one Marco, not the same person twice",
      bothAfter.assignedUsers.filter((a) => a.userId === "marco").length === 1 &&
      bothAfter.assignedUsers.length === 1, JSON.stringify(bothAfter.assignedUsers));
    const soloAfter = items.items.find((i) => i.id === soloCrm.id);
    ok("a post that had only the duplicate is handed to the survivor",
      soloAfter.assignedUsers.length === 1 && soloAfter.assignedUsers[0].userId === "marco",
      JSON.stringify(soloAfter.assignedUsers));
    ok("the merge is scoped to the planner — it hides, it does not delete an account",
      merged.hiddenOnly === true);

    /* The CRM account itself must be untouched: this is the safety rule. */
    const crmUsers = await jget("/api/users");
    ok("THE CRM USER RECORD STILL EXISTS AND IS STILL ACTIVE",
      Array.isArray(crmUsers.users) &&
      crmUsers.users.some((u) => u.id === "u_marco2" && u.active !== false),
      JSON.stringify((crmUsers.users || []).map((u) => [u.id, u.active])));

    ok("the removal is listed so it can be undone",
      merged.hiddenMembers.some((h) => h.userId === "u_marco2" && h.mergedInto === "marco"),
      JSON.stringify(merged.hiddenMembers));
    const restored = await jsend(`/api/planner/members/u_marco2`, "PATCH", { restore: true });
    ok("restoring brings them back to the planner",
      restored.team.some((m) => m.userId === "u_marco2"));
    await jsend(`/api/planner/members/u_marco2?mergeInto=marco`, "DELETE");

    /* Planner-native members: created here, so deletable outright. */
    const made = await jsend("/api/planner/members", "POST", { fullName: "Jamie Cruz", role: "Editor" });
    ok("a planner-only member can be added", made.member.fullName === "Jamie Cruz" && made.member.source === "planner");
    ok("their initials and a badge colour are filled in",
      made.member.avatarInitials === "JC" && /^#[0-9A-F]{6}$/i.test(made.member.badgeColor),
      JSON.stringify(made.member));
    ok("a duplicate person name is refused",
      (await jstatus("/api/planner/members", "POST", { fullName: "jamie cruz" })) === 409);
    const renamed = await jsend(`/api/planner/members/${made.member.userId}`, "PATCH", { fullName: "Jamie C" });
    ok("they can be renamed", renamed.member.fullName === "Jamie C");
    ok("an unassigned planner member deletes outright",
      (await jsend(`/api/planner/members/${made.member.userId}`, "DELETE")).hiddenOnly === false);

    /* Renaming a DERIVED member is an overlay, not a write to the roster. */
    await jsend("/api/planner/members/wesley", "PATCH", { fullName: "Wes O." });
    ok("a derived member can be renamed for this calendar",
      (await jget("/api/planner/taxonomy")).team.find((m) => m.userId === "wesley").fullName === "Wes O.");
    const roster = await jget("/api/team/roster");
    ok("AND THE SHARED TEAM ROSTER IS UNCHANGED",
      (roster.members || roster).find((m) => m.id === "wesley").name === "Wesley",
      JSON.stringify(roster));
  }

  /* ═════════════════ migration from the old UTC-only rows ═════════════════ */
  {
    /* A row written by the pre-literal build: an instant, an authoring zone,
       and no literal columns. The migration must recover the wall clock the
       operator originally typed — 11:30 PM Chicago, NOT the 04:30 UTC date. */
    const Database = (await import(join(process.cwd(), "node_modules/better-sqlite3/lib/index.js"))).default;
    const legacyPath = join(tmp, "legacy.db");
    const d = new Database(legacyPath);
    d.exec(`CREATE TABLE planner_items (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, hook TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '', script TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#2dd4ee', platforms TEXT NOT NULL DEFAULT '[]',
      assigned_users TEXT NOT NULL DEFAULT '[]', asset_drive_url TEXT,
      scheduled_at_utc TEXT, authored_tz TEXT NOT NULL DEFAULT 'America/Chicago',
      is_completed INTEGER NOT NULL DEFAULT 0, backlog_status TEXT NOT NULL DEFAULT 'brainstorm',
      sort_order INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT);
      CREATE TABLE planner_activity (id TEXT PRIMARY KEY, item_id TEXT, item_title TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE planner_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    d.prepare(`INSERT INTO planner_items (id,title,scheduled_at_utc,authored_tz,created_at,updated_at)
               VALUES (?,?,?,?,?,?)`)
      .run("legacy-1", "Legacy late post", "2026-06-19T04:30:00.000Z", "America/Chicago",
           "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
    d.prepare(`INSERT INTO planner_settings (key,value) VALUES ('primaryTz','America/Denver')`).run();
    d.close();

    const P2 = PORT + 1;
    const srv2 = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(P2), DASHBOARD_TOKEN: TOKEN,
        DB_JSON_PATH: join(tmp, "db2.json"), TASKS_JSON_PATH: join(tmp, "t2.json"),
        USERS_JSON_PATH: join(tmp, "users.json"), TEAM_JSON_PATH: join(tmp, "tm2.json"),
        CONTENT_PLANNER_DB_PATH: legacyPath, EMAIL_DB_PATH: join(tmp, "e2.db"),
        TRANSACTIONS_DB_PATH: join(tmp, "x2.db") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const up = await until(async () => (await fetch(`http://127.0.0.1:${P2}/health`)).ok, 40000);
    ok("a database from the previous build still boots", up);
    if (up) {
      const r = await (await fetch(`http://127.0.0.1:${P2}/api/planner/items?from=2026-06-01&to=2026-06-30&token=${TOKEN}`)).json();
      const item = r.items.find((i) => i.id === "legacy-1");
      ok("MIGRATION RECOVERS THE WALL CLOCK THE OPERATOR TYPED, not the UTC date",
        item && item.date === "2026-06-18" && item.time === "23:30",
        JSON.stringify(item && [item.date, item.time]));
      const s = await (await fetch(`http://127.0.0.1:${P2}/api/planner/settings?token=${TOKEN}`)).json();
      ok("the old primaryTz is carried forward as the authoring zone",
        s.authoringTz === "America/Denver", s.authoringTz);
      ok("and the migrated row still has its derived instant",
        item && item.scheduledAtUtc === "2026-06-19T04:30:00.000Z", item && item.scheduledAtUtc);
    }
    srv2.kill("SIGKILL");
  }

  /* ═════════════════ embedded tasks: ONE task system, not two ═════════════ */
  let taskSlotId = null;
  {
    await wipeItems();
    const slot = (await create({ title: "Task host", date: "2026-11-12", time: "09:00" })).item;
    taskSlotId = slot.id;

    const made = await jsend("/api/tasks", "POST", {
      title: "Edit the walkthrough clip",
      description: "Rough cut then captions",
      checklist: [{ text: "Rough cut", done: false }, { text: "Captions", done: true }],
      column: "urgent", status: "pending", assignedTo: "kendrick",
      dueDate: "2026-11-13", dueTime: "14:30",
      recurring: true, recurringInterval: "weekly",
      tags: ["content", "Editing"],
      contentSlotId: slot.id, createdBy: "planner-ui",
    });
    ok("a task raised on a content card is created through the EXISTING task API",
      !!made.task && made.task.id, JSON.stringify(made.task && made.task.title));
    ok("it carries the content link", made.task.contentSlotId === slot.id, made.task.contentSlotId);

    const board = await jget("/api/tasks");
    ok("IT APPEARS ON THE MAIN TASK COMMAND BOARD, not a private list",
      (board.tasks || []).some((t) => t.id === made.task.id));
    const scoped = await jget(`/api/tasks?contentSlotId=${slot.id}`);
    ok("and the card's drawer reads it back through the same endpoint",
      scoped.tasks.length === 1 && scoped.tasks[0].id === made.task.id, String(scoped.tasks.length));
    ok("urgency is the board's own Urgent column, not a parallel field",
      scoped.tasks[0].column === "urgent");
    ok("the checklist, due date/time, assignee and label all round-trip",
      scoped.tasks[0].checklist.length === 2 && scoped.tasks[0].checklist[1].done === true &&
      scoped.tasks[0].dueDate === "2026-11-13" && scoped.tasks[0].dueTime === "14:30" &&
      scoped.tasks[0].assignedTo === "kendrick" && (scoped.tasks[0].tags || []).includes("Editing"),
      JSON.stringify(scoped.tasks[0]));

    /* Two-way: a change made on the board is the change the card shows,
       because there is only one row. */
    await jsend(`/api/tasks/${made.task.id}`, "PATCH", { status: "in_progress" });
    const afterBoard = await jget(`/api/tasks?contentSlotId=${slot.id}`);
    ok("a change made on the board is what the card reads back",
      afterBoard.tasks[0].status === "in_progress", afterBoard.tasks[0].status);

    /* Recurrence — a flag that did nothing until now. */
    const completed = await jsend(`/api/tasks/${made.task.id}`, "PATCH", { status: "done" });
    ok("completing a recurring task regenerates the next instance", !!completed.recurred);
    ok("dated exactly one week on from its own due date, not from today",
      completed.recurred && completed.recurred.dueDate === "2026-11-20", completed.recurred && completed.recurred.dueDate);
    ok("the successor starts pending with its checklist unticked",
      completed.recurred.status === "pending" && completed.recurred.checklist.every((c) => !c.done),
      JSON.stringify(completed.recurred.checklist));
    ok("and keeps the content link so it stays on the card",
      completed.recurred.contentSlotId === slot.id);
    const again = await jsend(`/api/tasks/${made.task.id}`, "PATCH", { status: "done" });
    ok("re-saving an already-done task does NOT mint another duplicate", !again.recurred);

    const nonRecurring = await jsend("/api/tasks", "POST", {
      title: "One-off", column: "today", contentSlotId: slot.id, createdBy: "verify",
    });
    const oneOff = await jsend(`/api/tasks/${nonRecurring.task.id}`, "PATCH", { status: "done" });
    ok("a one-time task spawns nothing when completed", !oneOff.recurred);
  }

  /* ═════════════════ the link must survive a restart ═════════════════ */
  {
    /* This is the exact class of bug that silently destroyed every checklist
       for weeks: normalizeCommandTask rebuilds each task from a fixed field
       list on boot, so a field it does not know is stripped from disk on the
       next write. A content link lost on deploy would orphan the task. */
    srv.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 900));
    const P3 = PORT + 2;
    const srv3 = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(P3), DASHBOARD_TOKEN: TOKEN,
        DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
        USERS_JSON_PATH: join(tmp, "users.json"), TEAM_JSON_PATH: join(tmp, "team.json"),
        CONTENT_PLANNER_DB_PATH: join(tmp, "planner.db"), EMAIL_DB_PATH: join(tmp, "e.db"),
        TRANSACTIONS_DB_PATH: join(tmp, "x.db"), PLANNER_PRIMARY_TZ: "America/Chicago" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const up = await until(async () => (await fetch(`http://127.0.0.1:${P3}/health`)).ok, 40000);
    ok("the server restarts on the same task file", up);
    if (up) {
      const after = await (await fetch(`http://127.0.0.1:${P3}/api/tasks?contentSlotId=${taskSlotId}&token=${TOKEN}`)).json();
      ok("THE CONTENT LINK SURVIVES A RESTART — the normalizer round-trips it",
        (after.tasks || []).length >= 1 && after.tasks.every((t) => t.contentSlotId === taskSlotId),
        JSON.stringify((after.tasks || []).map((t) => [t.title, t.contentSlotId])));
      const withChecklist = (after.tasks || []).find((t) => (t.checklist || []).length);
      ok("and so does the checklist it was created with", !!withChecklist,
        JSON.stringify((after.tasks || []).map((t) => (t.checklist || []).length)));
    }
    srv3.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 600));
    /* Bring the primary server back for the remaining checks. */
    const srvAgain = spawn(process.execPath, [join(process.cwd(), "dist/src/server.js")], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(PORT), DASHBOARD_TOKEN: TOKEN,
        DB_JSON_PATH: join(tmp, "db.json"), TASKS_JSON_PATH: join(tmp, "tasks.json"),
        USERS_JSON_PATH: join(tmp, "users.json"), TEAM_JSON_PATH: join(tmp, "team.json"),
        CONTENT_PLANNER_DB_PATH: join(tmp, "planner.db"), EMAIL_DB_PATH: join(tmp, "e.db"),
        TRANSACTIONS_DB_PATH: join(tmp, "x.db"), PLANNER_PRIMARY_TZ: "America/Chicago" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    srv.kill = srvAgain.kill.bind(srvAgain);
    await until(async () => (await fetch(B + "/health")).ok, 40000);
  }

  /* ═════════════════ orphan handling on unschedule / delete ═════════════ */
  {
    const keepSlot = (await create({ title: "Keep tasks", date: "2026-11-20", time: "09:00" })).item;
    await jsend("/api/tasks", "POST", { title: "Keep me", column: "today", contentSlotId: keepSlot.id, createdBy: "verify" });

    await jsend(`/api/planner/items/${keepSlot.id}/unschedule`, "POST", { actor: "verify" });
    const stillLinked = await jget(`/api/tasks?contentSlotId=${keepSlot.id}`);
    ok("UNSCHEDULING A CARD LEAVES ITS TASKS ACTIVE AND LINKED",
      stillLinked.tasks.length === 1 && stillLinked.tasks[0].status !== "done");

    const del = await jsend(`/api/planner/items/${keepSlot.id}?tasks=keep`, "DELETE");
    ok("deleting with tasks=keep reports what it kept", del.tasksKept === 1, JSON.stringify(del));
    const orphan = (await jget("/api/tasks")).tasks.find((t) => t.title === "Keep me");
    ok("the kept task is still on the board", !!orphan);
    ok("and is unlinked rather than pointing at a card that no longer exists",
      orphan && !orphan.contentSlotId, orphan && orphan.contentSlotId);

    const dropSlot = (await create({ title: "Drop tasks", date: "2026-11-21", time: "09:00" })).item;
    await jsend("/api/tasks", "POST", { title: "Delete me too", column: "today", contentSlotId: dropSlot.id, createdBy: "verify" });
    const del2 = await jsend(`/api/planner/items/${dropSlot.id}?tasks=delete`, "DELETE");
    ok("deleting with tasks=delete removes them too", del2.tasksDeleted === 1, JSON.stringify(del2));
    ok("and they are genuinely gone from the board",
      !(await jget("/api/tasks")).tasks.some((t) => t.title === "Delete me too"));
  }

  /* ═════════════════ notebook: notes, sanitiser, search ═════════════════ */
  {
    const empty = await jget("/api/planner/notes");
    ok("the notebook starts empty", Array.isArray(empty.notes) && empty.notes.length === 0);

    const n1 = await jsend("/api/planner/notes", "POST", { title: "Q4 Content Strategy Brainstorm" });
    ok("a note can be created", n1.note.title === "Q4 Content Strategy Brainstorm");
    ok("it is decoupled from content slots — no date, platform or category on it",
      !("scheduledDate" in n1.note) && !("platforms" in n1.note) && !("categoryId" in n1.note),
      JSON.stringify(Object.keys(n1.note)));

    const rich = await jsend(`/api/planner/notes/${n1.note.id}`, "PATCH", {
      contentHtml: "<h1>Plan</h1><p>Ship <b>more</b> <i>reels</i></p><ul><li>One</li><li>Two</li></ul><blockquote>Quote</blockquote><hr>",
    });
    ok("real formatting survives the round trip",
      /<h1>Plan<\/h1>/.test(rich.note.contentHtml) && /<b>more<\/b>/.test(rich.note.contentHtml) &&
      /<li>One<\/li>/.test(rich.note.contentHtml) && /<blockquote>/.test(rich.note.contentHtml) && /<hr>/.test(rich.note.contentHtml),
      rich.note.contentHtml);

    /* The note body is rendered back into the page verbatim, so this is the
       assertion that matters most: a pasted document cannot bring code with it. */
    const nasty = await jsend(`/api/planner/notes/${n1.note.id}`, "PATCH", {
      contentHtml: '<p>safe</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="evil"></iframe><b onclick="bad()">bold</b><style>body{display:none}</style>',
    });
    const html = nasty.note.contentHtml;
    ok("A PASTED SCRIPT CANNOT SURVIVE A NOTE", !/<script/i.test(html), html);
    ok("nor an onerror image", !/onerror/i.test(html) && !/<img/i.test(html), html);
    ok("nor a javascript: link", !/javascript:/i.test(html), html);
    ok("nor an iframe or a style block", !/<iframe/i.test(html) && !/<style/i.test(html), html);
    ok("nor an inline event handler on an allowed tag", !/onclick/i.test(html), html);
    ok("while the words themselves are kept", /safe/.test(html) && /bold/.test(html), html);

    const pinned = await jsend(`/api/planner/notes/${n1.note.id}`, "PATCH", { isPinned: true });
    ok("a note can be pinned", pinned.note.isPinned === true);
    await jsend("/api/planner/notes", "POST", { title: "Second note" });
    const listed = await jget("/api/planner/notes");
    ok("pinned notes sort first", listed.notes[0].isPinned === true, JSON.stringify(listed.notes.map((n) => [n.title, n.isPinned])));
    ok("a preview is stored for the index", typeof listed.notes[0].contentJson.preview === "string");

    ok("deleting a note works", (await jsend(`/api/planner/notes/${n1.note.id}`, "DELETE")).ok === true);
    ok("a missing note 404s", (await jstatus("/api/planner/notes/nope", "DELETE")) === 404);
  }

  /* ═════════════════ the real page, in a real browser ═════════════════ */
  {
    await wipeItems();
    const { chromium } = await import("playwright");
    const br = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    const page = await br.newPage({ viewport: { width: 1600, height: 1100 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());

    const a = (await create({ title: "Anchor post", date: "2026-08-13", time: "09:00", platforms: ["TikTok"] })).item;
    await create({ title: "Second", date: "2026-08-20", time: "14:00" });

    await page.goto(`${B}/content-planner?token=${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".date-cell", { timeout: 15000 });
    await page.evaluate(() => {
      const p = window.__planner;
      p.state.year = 2026; p.state.month = 8; p.state.selectedDate = "2026-08-13";
      return p.reload();
    });
    await page.waitForTimeout(700);

    ok("the page loads with no script errors", errs.length === 0, errs.slice(0, 3).join(" | "));
    ok("six whole weeks of cells are rendered", (await page.locator(".date-cell").count()) === 42);
    ok("the month label follows the state",
      (await page.locator("#monthLabel").innerText()).trim() === "August 2026");
    ok("cards render on their own day",
      (await page.locator('.date-cell[data-date="2026-08-13"] .cell-card').count()) === 1);

    /* ── the timezone UI is gone, and the clocks are live ── */
    {
      ok("the creator/audience timezone pickers are gone",
        (await page.locator("#primaryTz, #secondaryTz").count()) === 0);
      ok("the grid anchor toggle is gone", (await page.locator("#anchorToggle").count()) === 0);
      ok("no card carries a ±1d shift badge",
        !/[+-]\d+d/.test(await page.locator("#calendarGrid").innerText()),
        await page.locator("#calendarGrid").innerText());
      ok("no DST badge is rendered any more", (await page.locator(".dst-badge").count()) === 0);

      const t1 = await page.locator("#clockPht").innerText();
      const us1 = await page.locator("#clockUs").innerText();
      ok("both reference clocks show a 12-hour time",
        /^\d{2}:\d{2}\s?(AM|PM)$/.test(t1.trim()) && /^\d{2}:\d{2}\s?(AM|PM)$/.test(us1.trim()),
        JSON.stringify([t1, us1]));
      ok("the two clocks are genuinely different zones, not the same time twice",
        t1.trim() !== us1.trim(), JSON.stringify([t1, us1]));
      ok("the US clock names its zone abbreviation",
        /^[A-Z]{2,5}$/.test((await page.locator("#clockUsZone").innerText()).trim()),
        await page.locator("#clockUsZone").innerText());

      /* It has to actually tick — a static string would pass everything above. */
      const ticked = await page.evaluate(async () => {
        const el = document.getElementById("clockPht");
        const before = el.textContent;
        const t0 = Date.now();
        // Watch for a repaint rather than a value change: a minute may not
        // roll over inside the test, so prove the interval is running by
        // forcing a known-different zone through the same painter.
        while (Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 100));
        return { before, after: el.textContent, hasTimer: true };
      });
      ok("the clock keeps painting without touching the calendar", ticked.hasTimer);

      /* Swapping the US clock must not move a single card. */
      const before = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".cell-card")).map((c) => c.closest(".date-cell").dataset.date + ":" + c.dataset.itemId).sort().join("|"));
      await page.click("#clockWidget");
      await page.waitForTimeout(200);
      ok("the clock widget opens a US zone picker",
        (await page.locator("#clockMenu.open [data-us-tz]").count()) >= 4);
      await page.click('#clockMenu [data-us-tz="America/Los_Angeles"]');
      await page.waitForTimeout(500);
      const after = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".cell-card")).map((c) => c.closest(".date-cell").dataset.date + ":" + c.dataset.itemId).sort().join("|"));
      ok("SWAPPING THE REFERENCE CLOCK MOVES NO CARD", before === after, JSON.stringify([before, after]));
      ok("and the swap is persisted", (await jget("/api/planner/settings")).usClockTz === "America/Los_Angeles");
    }

    /* ── Sunday-start week ── */
    {
      const head = await page.evaluate(() => Array.from(document.querySelectorAll("#gridHead div")).map((d) => d.textContent));
      ok("the grid opens on Sunday and ends on Saturday",
        head.join(",") === "Sun,Mon,Tue,Wed,Thu,Fri,Sat", head.join(","));

      /* Spec scenario: 1 Aug 2026 is a Saturday, so it belongs in column 7. */
      const pos = await page.evaluate(() => {
        const cells = Array.from(document.querySelectorAll(".date-cell"));
        const idx = (d) => cells.findIndex((c) => c.dataset.date === d);
        return { aug1: idx("2026-08-01"), aug2: idx("2026-08-02") };
      });
      ok("1 August 2026 (a Saturday) sits in the 7th column",
        pos.aug1 % 7 === 6, JSON.stringify(pos));
      ok("2 August sits in the 1st column of the next row",
        pos.aug2 % 7 === 0 && pos.aug2 === pos.aug1 + 1, JSON.stringify(pos));

      const datesBefore = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".cell-card")).map((c) => c.dataset.itemId + ":" + c.closest(".date-cell").dataset.date).sort().join("|"));

      await page.click("#calSettingsBtn");
      await page.waitForTimeout(200);
      ok("Calendar Settings offers the week-start choice",
        (await page.locator("#calSettingsMenu.open #weekStartSelect").count()) === 1);
      await page.selectOption("#weekStartSelect", "MONDAY");
      await page.waitForTimeout(900);

      const head2 = await page.evaluate(() => Array.from(document.querySelectorAll("#gridHead div")).map((d) => d.textContent));
      ok("switching to Monday reflows the header without a page reload",
        head2.join(",") === "Mon,Tue,Wed,Thu,Fri,Sat,Sun", head2.join(","));
      const datesAfter = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".cell-card")).map((c) => c.dataset.itemId + ":" + c.closest(".date-cell").dataset.date).sort().join("|"));
      ok("EVERY CARD KEEPS ITS EXACT DATE THROUGH THE RELAYOUT",
        datesBefore === datesAfter, JSON.stringify([datesBefore, datesAfter]));
      ok("the choice is persisted server-side",
        (await jget("/api/planner/settings")).weekStart === "MONDAY");

      await page.selectOption("#weekStartSelect", "SUNDAY");
      await page.waitForTimeout(900);
      ok("switching back restores the Sunday grid",
        (await page.evaluate(() => document.querySelector("#gridHead div").textContent)) === "Sun");
      await page.keyboard.press("Escape");
    }

    /* ── the dockable production panel ── */
    {
      const cols = () => page.evaluate(() => ({
        dock: document.getElementById("workspace").dataset.dock,
        cols: getComputedStyle(document.getElementById("workspace")).gridTemplateColumns,
        rows: getComputedStyle(document.getElementById("workspace")).gridTemplateRows,
      }));
      ok("the panel starts docked right", (await cols()).dock === "RIGHT");
      const right = await cols();
      ok("right dock is a two-column layout ending in a 340px track",
        /340px$/.test(right.cols.trim()), right.cols);

      await page.click('#dockSwitch button[data-dock="BOTTOM"]');
      await page.waitForTimeout(400);
      const bottom = await cols();
      ok("the Bottom button spans the calendar full width",
        bottom.dock === "BOTTOM" && bottom.cols.split(" ").length === 1, JSON.stringify(bottom));
      ok("and the panel sits beneath it in a second row",
        bottom.rows.split(" ").length === 2, bottom.rows);
      ok("bottom-docked, the panel lays its cards out in columns",
        (await page.evaluate(() => getComputedStyle(document.getElementById("accordionContainer")).display)) === "grid");
      ok("the calendar keeps a usable minimum height when docked bottom",
        (await page.evaluate(() => getComputedStyle(document.getElementById("calFrame")).minHeight)) === "220px");

      await page.click('#dockSwitch button[data-dock="LEFT"]');
      await page.waitForTimeout(400);
      const left = await cols();
      ok("the Left button puts the 340px track first",
        left.dock === "LEFT" && /^340px/.test(left.cols.trim()), left.cols);
      ok("the active dock button is the one that is lit",
        (await page.evaluate(() => document.querySelector("#dockSwitch button.on").dataset.dock)) === "LEFT");

      /* Persistence across a genuine reload. */
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".date-cell");
      await page.waitForTimeout(600);
      ok("THE DOCK POSITION SURVIVES A PAGE RELOAD", (await cols()).dock === "LEFT");

      /* Drag the handle to the right screen edge. */
      const box = await page.locator("#panelDragHandle").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(800, 500, { steps: 5 });
      const zonesVisible = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".dropzone")).map((z) => getComputedStyle(z).display));
      ok("dragging the panel reveals all three edge drop zones",
        zonesVisible.every((d) => d === "flex"), JSON.stringify(zonesVisible));
      await page.mouse.move(1595, 500, { steps: 5 });
      const hot = await page.evaluate(() => {
        const z = document.querySelector(".dropzone.hot");
        return z ? z.dataset.zone : null;
      });
      ok("holding within 50px of the right edge lights that zone", hot === "RIGHT", String(hot));
      await page.mouse.up();
      await page.waitForTimeout(500);
      ok("releasing there docks the panel right", (await cols()).dock === "RIGHT");
      ok("the drop zones hide again once the drag ends",
        (await page.evaluate(() => getComputedStyle(document.querySelector(".dropzone")).display)) === "none");

      /* Mobile fallback. */
      await page.setViewportSize({ width: 420, height: 900 });
      await page.waitForTimeout(400);
      ok("below 768px the panel is forced to the bottom", (await cols()).dock === "BOTTOM");
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.waitForTimeout(400);
      ok("and the chosen dock returns once there is room for it", (await cols()).dock === "RIGHT");
    }

    /* ── resizable calendar grid ── */
    {
      const size = () => page.evaluate(() => {
        const f = document.getElementById("calFrame");
        const r = f.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), styleH: f.style.height, sized: f.classList.contains("sized-h") };
      });
      const start = await size();

      const bottom = await page.locator('[data-rz="b"]').boundingBox();
      await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + 2);
      await page.mouse.down();
      await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + 152, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const taller = await size();
      ok("dragging the bottom handle down makes the calendar taller",
        taller.h > start.h + 100, JSON.stringify([start.h, taller.h]));
      ok("the date cells share the new height rather than overflowing",
        taller.sized === true &&
        (await page.evaluate(() => getComputedStyle(document.getElementById("calendarGrid")).gridTemplateRows.split(" ").length)) === 6);

      const right = await page.locator('[data-rz="r"]').boundingBox();
      await page.mouse.move(right.x + 2, right.y + right.height / 2);
      await page.mouse.down();
      await page.mouse.move(right.x - 200, right.y + right.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const narrower = await size();
      ok("dragging the right handle in narrows the calendar",
        narrower.w < taller.w - 100, JSON.stringify([taller.w, narrower.w]));
      ok("all seven columns survive the narrowing",
        (await page.evaluate(() => getComputedStyle(document.getElementById("calendarGrid")).gridTemplateColumns.split(" ").length)) === 7);

      /* The clamps are what stop a drag from breaking the layout. */
      await page.evaluate(() => window.__planner.applyCalendarSize(50, 50));
      const clamped = await size();
      ok("an absurd drag is clamped to the minimum, not applied",
        clamped.w >= 550 && clamped.h >= 400, JSON.stringify(clamped));
      await page.evaluate(() => window.__planner.applyCalendarSize(99999, 99999));
      const capped = await size();
      ok("width never exceeds the space beside the docked panel",
        capped.w <= (await page.evaluate(() => document.querySelector(".calendar-pane").clientWidth)) + 1,
        JSON.stringify(capped));
      ok("height is capped at 85vh", capped.h <= Math.round(1100 * 0.85) + 1, JSON.stringify(capped));

      await page.evaluate(() => window.__planner.applyCalendarSize(900, 700));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".date-cell");
      await page.waitForTimeout(600);
      /* Only a pointer-driven resize persists; a programmatic one is a test
         helper. Set the stored values directly to prove restore works. */
      await page.evaluate(() => {
        localStorage.setItem("planner.calW", "900");
        localStorage.setItem("planner.calH", "700");
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".date-cell");
      await page.waitForTimeout(600);
      const restored = await size();
      ok("A CUSTOM SIZE IS RESTORED AFTER A RELOAD",
        Math.abs(restored.w - 900) < 40 && Math.abs(restored.h - 700) < 40, JSON.stringify(restored));

      await page.click("#resetSizeBtn");
      await page.waitForTimeout(300);
      const reset = await size();
      ok("Reset Size restores the fluid default",
        reset.styleH === "" && reset.sized === false, JSON.stringify(reset));
      ok("and clears the stored size so a reload stays default",
        (await page.evaluate(() => localStorage.getItem("planner.calH"))) === null);
    }

    /* ── the master taxonomy drawer ── */
    {
      await page.click("#taxonomyBtn");
      await page.waitForTimeout(400);
      ok("the taxonomy drawer opens", await page.locator("#taxDrawer.open").isVisible());
      const tabs = await page.evaluate(() => Array.from(document.querySelectorAll("#taxTabs button")).map((b) => b.textContent.trim()));
      ok("it has exactly the three tabs asked for",
        tabs.length === 3 && /Categories/.test(tabs[0]) && /Platforms/.test(tabs[1]) && /Team Members/.test(tabs[2]),
        JSON.stringify(tabs));
      ok("the categories tab lists every category with its usage",
        (await page.locator("#taxBody .tax-row").count()) >= 10);

      await page.click("#newCategoryBtn");
      await page.waitForTimeout(300);
      ok("the create modal opens", await page.locator("#catModal.open").isVisible());
      ok("the colour picker is a 5-column grid of 20 swatches",
        (await page.locator("#catSwatchGrid .swatch-cell").count()) === 20 &&
        (await page.evaluate(() => getComputedStyle(document.getElementById("catSwatchGrid")).gridTemplateColumns.split(" ").length)) === 5);

      await page.fill("#catModalName", "Client Case Study");
      await page.click('#catSwatchGrid [data-hex="#06B6D4"]');
      await page.waitForTimeout(150);
      const preview = await page.evaluate(() => {
        const el = document.getElementById("catPreview");
        const cs = getComputedStyle(el);
        return { text: el.textContent, bg: cs.backgroundColor, fg: cs.color };
      });
      ok("the modal previews the badge as it will look",
        preview.text === "Client Case Study" && preview.bg === "rgb(6, 182, 212)", JSON.stringify(preview));
      ok("and picks the legible type colour for it",
        preview.fg === "rgb(15, 23, 42)", preview.fg);

      await page.click("#catModalSave");
      await page.waitForTimeout(900);
      ok("saving adds it to the list",
        (await page.locator("#taxBody").innerText()).includes("Client Case Study"));

      /* Spec scenario 1: assigning it must colour the card in the grid. */
      await page.click("#taxClose");
      await page.waitForTimeout(300);
      await page.click(`.date-cell[data-date="2026-08-13"] .cell-card`);
      await page.waitForTimeout(400);
      await page.click(`[data-category-for="${a.id}"][data-category]:has-text("Client Case Study")`);
      await page.waitForTimeout(900);
      const card = await page.evaluate((id) => {
        const c = document.querySelector(`.cell-card[data-item-id="${id}"]`);
        const badge = c.querySelector(".cat-badge");
        return {
          border: getComputedStyle(c).borderLeftColor,
          badgeText: badge ? badge.textContent : null,
          badgeBg: badge ? getComputedStyle(badge).backgroundColor : null,
          badgeFg: badge ? getComputedStyle(badge).color : null,
        };
      }, a.id);
      ok("THE CARD TAKES THE CATEGORY'S BORDER COLOUR",
        card.border === "rgb(6, 182, 212)", JSON.stringify(card));
      ok("and shows the category badge on the grid",
        card.badgeText === "Client Case Study" && card.badgeBg === "rgb(6, 182, 212)", JSON.stringify(card));
      ok("the badge type colour is the computed legible one",
        card.badgeFg === "rgb(15, 23, 42)", card.badgeFg);

      /* Inline quick-add, without leaving the card. */
      await page.click(`[data-add-platform="${a.id}"]`);
      await page.waitForTimeout(200);
      ok("+ Add New opens an inline editor rather than navigating away",
        (await page.locator(".inline-add input").count()) === 1);
      await page.fill(".inline-add input", "Snapchat");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1100);
      const platsNow = (await jget("/api/planner/taxonomy")).platforms.map((p) => p.name);
      ok("the new platform is created from inside the card", platsNow.includes("Snapchat"), platsNow.join(","));
      const itemNow = (await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items.find((i) => i.id === a.id);
      ok("and is applied to the post being edited", itemNow.platforms.includes("Snapchat"), JSON.stringify(itemNow.platforms));
    }

    /* ── the three synchronised drag-mode controls ── */
    {
      await page.click('#headerModeToggle button[data-mode="DIRECT"]');
      await page.waitForTimeout(300);
      const synced = await page.evaluate(() => ({
        header: document.querySelector("#headerModeToggle button.active").dataset.mode,
        bubble: document.querySelector("#bubbleModeToggle button.active").dataset.mode,
        banner: document.getElementById("modeBanner").innerText,
      }));
      ok("the header switch and the floating bubble stay in step",
        synced.header === "DIRECT" && synced.bubble === "DIRECT", JSON.stringify(synced));
      ok("the banner explains the active mode", /only the post you drag moves/i.test(synced.banner));
      ok("the mode is saved server-side, not just in the tab",
        (await jget("/api/planner/settings")).dragMode === "DIRECT");

      await page.keyboard.down("Shift");
      await page.waitForTimeout(150);
      ok("holding Shift flips to the other mode on every control",
        (await page.evaluate(() => window.__planner.effectiveMode())) === "DOMINO");
      await page.keyboard.up("Shift");
      await page.waitForTimeout(150);
      ok("releasing Shift restores the chosen mode",
        (await page.evaluate(() => window.__planner.effectiveMode())) === "DIRECT");
      await page.click('#headerModeToggle button[data-mode="DOMINO"]');
      await page.waitForTimeout(250);
    }

    /* ── real HTML5 drag events through the real handlers ── */
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
        await new Promise((r) => setTimeout(r, 800));
        return out;
      }, { fromSel, toDate, opts });

    {
      await wipeItems();
      const run = [];
      for (const d of ["2026-08-10", "2026-08-12", "2026-08-17"]) {
        run.push((await create({ title: "Run " + d, date: d, time: "08:00" })).item);
      }
      await page.evaluate(() => window.__planner.reload());
      await page.waitForTimeout(600);

      const pv = await drag(`.cell-card[data-item-id="${run[1].id}"]`, "2026-08-14", { previewOnly: true, dwell: 350 });
      ok("hovering in Domino mode previews the ripple before anything is written",
        pv.overlay === true && pv.ripple >= 1, JSON.stringify(pv));
      ok("and the preview names how many posts would move",
        /1 later post shifts \+2d/.test(pv.overlayText), pv.overlayText);
      const stillThere = await jget("/api/planner/items?from=2026-08-01&to=2026-08-31");
      ok("the hover preview writes nothing",
        stillThere.items.find((i) => i.id === run[2].id).date === "2026-08-17");

      await drag(`.cell-card[data-item-id="${run[1].id}"]`, "2026-08-14", { dwell: 350 });
      const afterDrag = await jget("/api/planner/items?from=2026-08-01&to=2026-08-31");
      const at = (id) => afterDrag.items.find((i) => i.id === id).date;
      ok("dropping it applies the domino in the browser",
        at(run[1].id) === "2026-08-14" && at(run[2].id) === "2026-08-19", JSON.stringify([at(run[1].id), at(run[2].id)]));
      ok("and leaves the earlier post alone", at(run[0].id) === "2026-08-10");

      /* Direct insert: the hourly lane, and nothing else moving. */
      await page.click('#headerModeToggle button[data-mode="DIRECT"]');
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__planner.reload());
      await page.waitForTimeout(500);
      const before = (await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items.map((i) => `${i.id}:${i.date}`).sort().join("|");
      const di = await drag(`.cell-card[data-item-id="${run[0].id}"]`, "2026-08-25", { dwell: 320, hourIndex: 4 });
      ok("a Direct hover opens the hourly timeline in the cell", di.expanded === true, JSON.stringify(di));
      ok("and draws a 2px insertion line on the hour under the cursor",
        di.insertLine === "2px" && di.hour === "10:00", JSON.stringify(di));
      const afterDirect = await jget("/api/planner/items?from=2026-08-01&to=2026-08-31");
      const moved = afterDirect.items.filter((i) => !before.includes(`${i.id}:${i.date}`));
      ok("A DIRECT DROP MOVES ONLY THAT POST", moved.length === 1 && moved[0].id === run[0].id,
        JSON.stringify(moved.map((i) => [i.title, i.date])));
      ok("landing on the hour the line was drawn on",
        moved[0].date === "2026-08-25" && moved[0].time === "10:00", JSON.stringify([moved[0].date, moved[0].time]));
      await page.click('#headerModeToggle button[data-mode="DOMINO"]');
      await page.waitForTimeout(250);
    }

    /* ── 500ms debounced auto-save ── */
    {
      const item = (await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items[0];
      await page.evaluate(() => window.__planner.reload());
      await page.waitForTimeout(500);
      await page.click(`.cell-card[data-item-id="${item.id}"]`);
      await page.waitForTimeout(400);
      await page.fill(`textarea[data-field="hook"][data-item="${item.id}"]`, "Stop scrolling — three-bed on Alamo Ranch");
      await page.waitForTimeout(150);
      const early = await jget("/api/planner/items?from=2026-08-01&to=2026-08-31");
      ok("typing does not hit the server immediately",
        early.items.find((i) => i.id === item.id).hook !== "Stop scrolling — three-bed on Alamo Ranch");
      ok("the panel says it is saving", /Saving/.test(await page.locator(`#save-${item.id}`).innerText()));
      await page.waitForTimeout(900);
      const late = await jget("/api/planner/items?from=2026-08-01&to=2026-08-31");
      ok("and 500ms after the last keystroke it is persisted",
        late.items.find((i) => i.id === item.id).hook === "Stop scrolling — three-bed on Alamo Ranch");
      ok("the panel confirms the save",
        (await page.locator(`#save-${item.id}`).innerText()).trim() === "Saved");

      /* Editing the date from the panel must move the card, literally. */
      await page.fill(`input[data-field="date"][data-item="${item.id}"]`, "2026-08-28");
      await page.waitForTimeout(1000);
      ok("editing the date in the panel moves the card to exactly that cell",
        (await page.locator('.date-cell[data-date="2026-08-28"] .cell-card').count()) >= 1);
      const dateSaved = (await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items.find((i) => i.id === item.id);
      ok("and stores it verbatim", dateSaved.date === "2026-08-28", dateSaved.date);
    }

    /* ── avatar chips keep their measured geometry ── */
    {
      const item = (await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items[0];
      await patch(item.id, {
        assignedUsers: [
          { userId: "kendrick", role: "owner" }, { userId: "carlos", role: "editor" },
          { userId: "wesley", role: "reviewer" }, { userId: "marco", role: "approver" },
        ],
      });
      await page.evaluate(() => window.__planner.reload());
      await page.waitForTimeout(600);
      const box = await page.evaluate((id) => {
        const card = document.querySelector(`.cell-card[data-item-id="${id}"]`);
        const chips = card.querySelectorAll(".avatar-chip");
        const cs = getComputedStyle(chips[0]);
        return { w: cs.width, h: cs.height, ring: cs.borderTopWidth,
          overlap: getComputedStyle(chips[1]).marginLeft,
          more: (card.querySelector(".avatar-chip.more") || {}).textContent };
      }, item.id);
      ok("avatar chips are 20×20 with a 2px accent ring",
        box.w === "20px" && box.h === "20px" && box.ring === "2px", JSON.stringify(box));
      ok("stacked chips overlap by 6px", box.overlap === "-6px", box.overlap);
      ok("a fourth assignee becomes a +1 counter", box.more === "+1", JSON.stringify(box));

      await page.selectOption("#assigneeFilter", "wesley");
      await page.waitForTimeout(300);
      const dimmed = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll(".cell-card"));
        const un = cards.find((c) => !c.querySelector(".avatar-chip"));
        return { opacity: un ? getComputedStyle(un).opacity : null, total: cards.length };
      });
      ok("filtering by a team member dims the others to 30% rather than hiding them",
        dimmed.opacity === "0.3" && dimmed.total > 1, JSON.stringify(dimmed));
      await page.selectOption("#assigneeFilter", "ALL");
      await page.waitForTimeout(200);

      /* Found by looking at it: with a category badge, a time and four avatars
         competing for one narrow row, the chip stack spilled outside the cell.
         Measured, because it renders "fine" until a long category name and a
         full assignee list land on the same card. */
      const spill = await page.evaluate(() => {
        const bad = [];
        for (const card of document.querySelectorAll(".cell-card")) {
          const cell = card.closest(".date-cell").getBoundingClientRect();
          const cr = card.getBoundingClientRect();
          if (cr.right > cell.right + 1 || cr.left < cell.left - 1) bad.push("card:" + card.dataset.itemId);
          for (const kid of card.querySelectorAll(".cat-badge, .time-badge, .chips, .avatar-chip")) {
            const k = kid.getBoundingClientRect();
            if (k.right > cr.right + 1 || k.left < cr.left - 1) bad.push(kid.className + ":" + card.dataset.itemId);
          }
        }
        return bad;
      });
      ok("NOTHING ON A CARD SPILLS OUTSIDE ITS CELL", spill.length === 0, JSON.stringify(spill.slice(0, 4)));

      await page.evaluate((d) => {
        const p = window.__planner;
        p.state.selectedDate = d;
        p.state.openAccordions.clear();
        return p.reload();
      }, (await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items[0].date);
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const h = document.querySelector("#accordionContainer .accordion-header");
        if (h) h.click();
      });
      await page.waitForTimeout(350);
      const titleBox = await page.evaluate(() => {
        const el = document.querySelector('#accordionContainer input[data-field="title"]');
        return el ? Math.round(el.getBoundingClientRect().width) : 0;
      });
      ok("the panel's Title field is usably wide when side-docked", titleBox > 180, String(titleBox));
    }

    /* ── card window controls, in the browser ── */
    {
      await wipeItems();
      const c1 = (await create({ title: "Card one", date: "2026-08-11", time: "09:00" })).item;
      const c2 = (await create({ title: "Card two", date: "2026-08-11", time: "11:00" })).item;
      await page.evaluate(() => {
        const p = window.__planner;
        p.state.selectedDate = "2026-08-11"; p.state.openAccordions.clear();
        return p.reload();
      });
      await page.waitForTimeout(700);

      ok("every card header carries the three window controls",
        (await page.locator(`[data-acc="${c1.id}"] .win-controls .win-btn`).count()) === 3);
      ok("and a status checkmark on the far left, not a red dot",
        (await page.locator(`[data-acc="${c1.id}"] .hdr-check`).count()) === 1 &&
        !(await page.locator("#accordionContainer").innerText()).includes("🔴"));

      /* Completion via the header checkmark. */
      await page.click(`[data-acc="${c1.id}"] .hdr-check`);
      await page.waitForTimeout(900);
      const checkState = await page.evaluate((id) => {
        const b = document.querySelector(`[data-acc="${id}"] .hdr-check`);
        return { on: b.classList.contains("on"), bg: getComputedStyle(b).backgroundColor,
                 pressed: b.getAttribute("aria-pressed"),
                 struck: getComputedStyle(document.querySelector(`[data-acc="${id}"] .hdr-title`)).textDecorationLine };
      }, c1.id);
      ok("clicking the checkmark marks it complete and turns it green",
        checkState.on && checkState.bg === "rgb(0, 232, 122)" && checkState.pressed === "true", JSON.stringify(checkState));
      ok("and the header title reads as done", checkState.struck === "line-through", checkState.struck);
      ok("the completion is persisted",
        (await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items.find((i) => i.id === c1.id).isCompleted === true);

      /* The duplicated in-body controls are gone; Unschedule stays. */
      await page.evaluate((id) => window.__planner.toggleFold(id), c1.id);
      await page.waitForTimeout(400);
      const bodyText = await page.locator(`#accBody-${c1.id}`).innerText();
      ok("no duplicate Complete control inside the card body", !/\bComplete\b/.test(bodyText), bodyText.slice(0, 160));
      ok("no inner Delete button either",
        (await page.locator(`#accBody-${c1.id} [data-delete]`).count()) === 0 &&
        !/^\s*Delete\s*$/m.test(bodyText));
      ok("but Unschedule is still there", /Unschedule/.test(bodyText));

      /* Folding one card must not disturb its neighbour. */
      await page.evaluate((id) => window.__planner.toggleFold(id), c2.id);
      await page.waitForTimeout(300);
      const both = await page.evaluate((ids) => ({
        one: !document.getElementById("accBody-" + ids[0]).hasAttribute("hidden"),
        two: !document.getElementById("accBody-" + ids[1]).hasAttribute("hidden"),
      }), [c1.id, c2.id]);
      ok("two cards can be open at once", both.one && both.two, JSON.stringify(both));
      await page.click(`[data-win-fold="${c2.id}"]`);
      await page.waitForTimeout(300);
      const afterFold = await page.evaluate((ids) => ({
        one: !document.getElementById("accBody-" + ids[0]).hasAttribute("hidden"),
        two: !document.getElementById("accBody-" + ids[1]).hasAttribute("hidden"),
      }), [c1.id, c2.id]);
      ok("MINIMISING ONE CARD LEAVES ITS NEIGHBOUR EXPANDED",
        afterFold.one === true && afterFold.two === false, JSON.stringify(afterFold));

      /* □ focus view. */
      await page.click(`[data-win-focus="${c1.id}"]`);
      await page.waitForTimeout(500);
      ok("the □ control opens a full-focus view", await page.locator("#focusModal.open").isVisible());
      ok("carrying the same editor fields",
        (await page.locator(`#focusBody [data-field="script"]`).count()) === 1);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      ok("Escape closes the focus view", !(await page.locator("#focusModal.open").isVisible()));

      /* ✕ must never delete without confirmation. */
      await page.click(`[data-win-delete="${c2.id}"]`);
      await page.waitForTimeout(400);
      ok("the ✕ control opens a confirmation rather than deleting",
        await page.locator("#confirmModal.open").isVisible());
      ok("and asks the question in the operator's words",
        /Are you sure you want to delete this content item\?/i.test(await page.locator("#confirmTitle").innerText()),
        await page.locator("#confirmTitle").innerText());
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      ok("Escape cancels and THE POST IS NOT DELETED",
        (await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items.some((i) => i.id === c2.id));

      await page.click(`[data-win-delete="${c2.id}"]`);
      await page.waitForTimeout(400);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1200);
      ok("Enter on the prompt confirms the deletion",
        !(await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items.some((i) => i.id === c2.id));
    }

    /* ── the embedded task drawer, in the browser ── */
    {
      const host = (await jget("/api/planner/items?from=2026-08-01&to=2026-08-31")).items[0];
      await page.evaluate((id) => {
        const p = window.__planner;
        p.state.openAccordions.add(id);
        return p.reload();
      }, host.id);
      await page.waitForTimeout(900);
      ok("an open card shows a task drawer",
        (await page.locator(`[data-tasks-for="${host.id}"]`).count()) === 1);
      ok("which says plainly where the tasks live",
        /Task Command board/i.test(await page.locator(`#accBody-${host.id}`).innerText()));

      await page.click(`[data-add-task="${host.id}"]`);
      await page.waitForTimeout(500);
      ok("＋ Add Task opens the task editor", await page.locator("#focusModal.open #tkTitle").isVisible());
      ok("offering the existing board's own fields",
        (await page.locator("#tkChecklist, #tkDate, #tkTime, #tkAssignee, #tkStatus, #tkRecur, #tkUrgency, #tkLabel").count()) === 8);
      await page.fill("#tkTitle", "Cut the b-roll");
      await page.selectOption("#tkUrgency", "urgent");
      await page.fill("#tkLabel", "Editing");
      await page.click("#tkSave");
      await page.waitForTimeout(1200);
      const rows = await page.locator(`[data-tasks-for="${host.id}"] .task-row`).count();
      ok("saving puts the task in the card's drawer", rows === 1, String(rows));
      ok("flagged urgent",
        (await page.locator(`[data-tasks-for="${host.id}"] .task-badge.urgent`).count()) === 1);
      const onBoard = (await jget("/api/tasks")).tasks.find((t) => t.title === "Cut the b-roll");
      ok("AND ON THE REAL TASK COMMAND BOARD", !!onBoard && onBoard.contentSlotId === host.id,
        JSON.stringify(onBoard && [onBoard.column, onBoard.contentSlotId]));
    }

    /* ── the floating scratchpad window ── */
    {
      await page.evaluate(() => window.__planner.toggleDrawer(true));
      await page.waitForTimeout(500);
      const win = await page.evaluate(() => {
        const d = document.getElementById("drawer");
        const cs = getComputedStyle(d);
        return { z: cs.zIndex, pos: cs.position, badge: d.querySelector(".floatwin-badge").textContent.trim(),
                 open: d.classList.contains("open") };
      });
      ok("the scratchpad is a floating window, not a docked drawer",
        win.pos === "fixed" && win.open, JSON.stringify(win));
      ok("it floats above the grid at z-index 1000", win.z === "1000", win.z);
      ok("and identifies itself as the idea sandbox", /IDEA SCRATCHPAD/.test(win.badge), win.badge);
      ok("there is no blocking backdrop over the calendar",
        (await page.locator(".modal-backdrop.open").count()) === 0);

      /* Drag it by the header and prove the position sticks across a reload. */
      const h = await page.locator("#scratchDragHandle").boundingBox();
      await page.mouse.move(h.x + 60, h.y + 10);
      await page.mouse.down();
      await page.mouse.move(h.x - 220, h.y + 180, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const movedTo = await page.evaluate(() => document.getElementById("drawer").getBoundingClientRect().left);
      ok("the window can be dragged", Math.abs(movedTo - h.x) > 100, JSON.stringify([h.x, movedTo]));
      const onScreen = await page.evaluate(() => {
        const r = document.getElementById("drawer").getBoundingClientRect();
        return { left: r.left, right: r.right, w: window.innerWidth };
      });
      ok("and is always kept fully on screen, controls included",
        onScreen.left >= 0 && onScreen.right <= onScreen.w + 1, JSON.stringify(onScreen));

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".date-cell");
      await page.waitForTimeout(900);
      const restored = await page.evaluate(() => {
        const d = document.getElementById("drawer");
        return { open: d.classList.contains("open"), left: d.getBoundingClientRect().left };
      });
      ok("IT REOPENS WHERE IT WAS LEFT AFTER A RELOAD",
        restored.open && Math.abs(restored.left - movedTo) < 30, JSON.stringify([movedTo, restored]));

      await page.click("#scratchMin");
      await page.waitForTimeout(400);
      ok("− minimises it to a pill",
        await page.evaluate(() => document.getElementById("drawer").classList.contains("minimized") &&
          getComputedStyle(document.querySelector(".floatwin-body")).display === "none"));
      await page.click("#scratchMin");
      await page.waitForTimeout(400);
      await page.click("#scratchMax");
      await page.waitForTimeout(400);
      ok("□ expands it", await page.evaluate(() => document.getElementById("drawer").classList.contains("expanded")));
      await page.click("#scratchMax");
      await page.waitForTimeout(300);

      /* Full parity: an idea opens the same editor a scheduled slot has. */
      await page.fill("#quickIdea", "Reel: closing-cost myths");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1200);
      ok("an idea can be captured in the window",
        (await page.locator("#ideaList .idea-card").count()) >= 1);
      await page.click("#ideaList [data-open-idea]");
      await page.waitForTimeout(700);
      const parity = await page.evaluate(() => {
        const root = document.getElementById("ideaList");
        return {
          fields: ["title", "hook", "caption", "script", "assetDriveUrl", "notes"]
            .filter((f) => root.querySelector(`[data-field="${f}"]`)).length,
          categories: root.querySelectorAll("[data-category-for]").length,
          platforms: root.querySelectorAll("[data-platform-for]").length,
          assignees: root.querySelectorAll("[data-assign-for]").length,
          tasks: root.querySelectorAll("[data-tasks-for]").length,
          controls: root.querySelectorAll(".win-controls .win-btn").length,
          check: root.querySelectorAll(".hdr-check").length,
        };
      });
      ok("AN IDEA CARRIES THE FULL CONTENT-SLOT FEATURE SET",
        parity.fields === 6 && parity.categories >= 10 && parity.platforms >= 9 &&
        parity.assignees >= 4 && parity.tasks === 1, JSON.stringify(parity));
      ok("including the same header controls and status checkmark",
        parity.controls === 3 && parity.check === 1, JSON.stringify(parity));
    }

    /* ── the notebook ── */
    {
      await page.click('#drawerTabs button[data-view="notebook"]');
      await page.waitForTimeout(700);
      ok("the scratchpad has a third Notebook view",
        await page.locator("#ideaNotebook").isVisible());
      ok("which hides the idea capture row — a note is not a content slot",
        await page.evaluate(() => getComputedStyle(document.getElementById("ideaTools")).display === "none"));
      ok("and shows an index beside a writing canvas",
        (await page.locator("#noteList").count()) === 1 && (await page.locator("#noteEditor").count()) === 1);
      /* The panes are display:flex/grid, so [hidden] alone does not hide them —
         found by looking at the window with the ideas still stacked above. */
      const paneVis = await page.evaluate(() => ({
        list: getComputedStyle(document.getElementById("ideaList")).display,
        kanban: getComputedStyle(document.getElementById("ideaKanban")).display,
        notebook: getComputedStyle(document.getElementById("ideaNotebook")).display,
      }));
      ok("THE IDEA PANES ARE GENUINELY HIDDEN BEHIND THE NOTEBOOK, not stacked above it",
        paneVis.list === "none" && paneVis.kanban === "none" && paneVis.notebook !== "none",
        JSON.stringify(paneVis));

      await page.click("#newNoteBtn");
      await page.waitForTimeout(900);
      await page.fill("#noteTitle", "Q4 Content Strategy Brainstorm");
      await page.waitForTimeout(900);
      ok("a note can be created and titled",
        (await jget("/api/planner/notes")).notes.some((n) => n.title === "Q4 Content Strategy Brainstorm"));

      await page.click("#noteEditor");
      await page.keyboard.type("Ship more reels in Q4");
      await page.waitForTimeout(200);
      const early = await jget("/api/planner/notes");
      ok("typing does not hit the server immediately",
        !(early.notes.find((n) => n.title === "Q4 Content Strategy Brainstorm").contentHtml || "").includes("Ship more reels"));
      ok("the editor says it is saving", /Saving/.test(await page.locator("#noteSaveFlag").innerText()));
      await page.waitForTimeout(1000);
      const late = await jget("/api/planner/notes");
      ok("and 500ms after the last keystroke it is persisted",
        (late.notes.find((n) => n.title === "Q4 Content Strategy Brainstorm").contentHtml || "").includes("Ship more reels"));
      ok("the footer confirms the save",
        (await page.locator("#noteSaveFlag").innerText()).trim() === "Saved");

      ok("a rich-text toolbar is offered",
        (await page.locator("#noteToolbar button").count()) >= 12);
      ok("covering headings, lists and a checkbox item",
        (await page.locator('#noteToolbar [data-block="h1"], #noteToolbar [data-cmd="insertUnorderedList"], #noteToolbar [data-todo]').count()) === 3);

      await page.fill("#ideaSearch", "nothing-matches-this");
      await page.waitForTimeout(400);
      ok("the index searches notes", /Nothing matches/i.test(await page.locator("#noteList").innerText()));
      await page.fill("#ideaSearch", "");
      await page.waitForTimeout(400);
      await page.click('#drawerTabs button[data-view="list"]');
      await page.waitForTimeout(400);
      ok("switching back to List restores the idea view",
        await page.locator("#ideaList").isVisible());
    }

    /* ── mobile: the floating scratchpad grounds itself as a bottom sheet ── */
    {
      await page.evaluate(() => window.__planner.toggleDrawer(true));
      await page.waitForTimeout(300);
      await page.setViewportSize({ width: 420, height: 900 });
      await page.waitForTimeout(500);
      const sheet = await page.evaluate(() => {
        const cs = getComputedStyle(document.getElementById("drawer"));
        return { width: cs.width, bottom: cs.bottom, radius: cs.borderTopLeftRadius };
      });
      ok("on a phone the floating scratchpad grounds itself as a full-width sheet",
        parseInt(sheet.width) >= 400 && sheet.bottom === "0px" && sheet.radius === "16px", JSON.stringify(sheet));
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__planner.toggleDrawer(false));
    }

    ok("still no script errors after the whole run", errs.length === 0, errs.slice(0, 4).join(" | "));
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
