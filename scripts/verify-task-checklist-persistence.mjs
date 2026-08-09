#!/usr/bin/env node
/**
 * Verifies the Task Command checklist survives the db.json disk round trip.
 *
 * The bug: normalizeCommandTask (the load-path normalizer in core/db.ts)
 * predated the checklist/dueTime/reminderMinutes/sortOrder fields and rebuilt
 * every task WITHOUT them on boot. The next persistToFile() then wrote the
 * stripped tasks back to disk, so one server restart permanently deleted every
 * checklist — seen by the team as "checklists disappear when the page
 * refreshes". This suite drives the REAL compiled store across separate node
 * processes (each fresh process re-runs loadFromFile, exactly like a deploy).
 *
 * Run after `npm run build`:  node scripts/verify-task-checklist-persistence.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "task-ck-verify-"));
const dbPath = join(tmp, "db.json");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; console.error(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

/** Run a snippet in a FRESH node process against the compiled store. */
function inFreshProcess(script) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, DB_JSON_PATH: dbPath, TASKS_JSON_PATH: join(tmp, "tasks.json") },
    encoding: "utf8",
  });
  const line = out.trim().split("\n").pop();
  return JSON.parse(line);
}

const CHECKLIST = [
  { id: "ck_keep", text: "Call the title company", done: false, taskId: "task_linked_1" },
  { id: "ck_done", text: "Send the disclosure", done: true },
  { text: "", done: false }, // junk: empty text must be dropped, not kept as a blank row
];

try {
  // ── Process A: create a task with every at-risk field, persist ────────────
  const created = inFreshProcess(`
    const db = await import(${JSON.stringify(new URL("../dist/src/core/db.js", import.meta.url).href)});
    const t = db.createCommandTask({
      title: "Round-trip fixture",
      description: "notes",
      checklist: ${JSON.stringify(CHECKLIST.slice(0, 2))},
      column: "today",
      status: "pending",
      color: "blue",
      assignedTo: "carlos",
      createdBy: "marco",
      dueDate: "2026-08-12",
      dueTime: "14:30",
      reminderMinutes: [10, 5],
      sortOrder: 3,
    });
    console.log(JSON.stringify({ id: t.id }));
  `);
  check("task created and persisted", typeof created.id === "string" && created.id.length > 0);

  // Seed one raw-junk task straight into the file too, so the loader is
  // exercised against hand-edited/legacy data, not only its own output.
  const onDisk = JSON.parse(readFileSync(dbPath, "utf8"));
  onDisk.commandTasks.push({
    title: "Legacy junk fixture",
    column: "today",
    status: "pending",
    color: "blue",
    checklist: CHECKLIST, // includes the blank row
    dueTime: "not-a-time",
    reminderMinutes: [15, "x", -5, 9999],
    sortOrder: "not-a-number",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  writeFileSync(dbPath, JSON.stringify(onDisk), "utf8");

  // ── Process B: fresh boot (loadFromFile runs) — the restart that used to lose everything
  const reloaded = inFreshProcess(`
    const db = await import(${JSON.stringify(new URL("../dist/src/core/db.js", import.meta.url).href)});
    console.log(JSON.stringify(db.getCommandTasks()));
  `);
  const main = reloaded.find((t) => t.title === "Round-trip fixture");
  const junk = reloaded.find((t) => t.title === "Legacy junk fixture");

  check("task survives restart", !!main);
  check("checklist survives restart", Array.isArray(main?.checklist) && main.checklist.length === 2,
    `got ${JSON.stringify(main?.checklist)}`);
  check("checklist item ids preserved", main?.checklist?.[0]?.id === "ck_keep");
  check("checklist done flags preserved", main?.checklist?.[0]?.done === false && main?.checklist?.[1]?.done === true);
  check("tracker link (taskId) preserved", main?.checklist?.[0]?.taskId === "task_linked_1");
  check("dueTime survives restart", main?.dueTime === "14:30", `got ${main?.dueTime}`);
  check("reminderMinutes survive restart", JSON.stringify(main?.reminderMinutes) === "[10,5]",
    `got ${JSON.stringify(main?.reminderMinutes)}`);
  check("sortOrder survives restart", main?.sortOrder === 3, `got ${main?.sortOrder}`);

  check("legacy junk task still loads", !!junk);
  check("blank checklist row dropped", junk?.checklist?.length === 2,
    `got ${JSON.stringify(junk?.checklist)}`);
  check("invalid dueTime dropped", junk?.dueTime === undefined, `got ${junk?.dueTime}`);
  check("reminderMinutes filtered to valid entries", JSON.stringify(junk?.reminderMinutes) === "[15]",
    `got ${JSON.stringify(junk?.reminderMinutes)}`);
  check("non-numeric sortOrder dropped", junk?.sortOrder === undefined, `got ${junk?.sortOrder}`);

  // ── Process C: write an unrelated field after the reload, then reload AGAIN.
  // This is the bake-in path: pre-fix, the post-restart persist wrote the
  // stripped tasks to disk, so the loss was permanent even if the code was
  // later fixed. The checklist must still be on disk after that persist.
  inFreshProcess(`
    const db = await import(${JSON.stringify(new URL("../dist/src/core/db.js", import.meta.url).href)});
    const t = db.getCommandTasks().find((x) => x.title === "Round-trip fixture");
    db.updateCommandTask(t.id, { status: "in_progress" });
    console.log(JSON.stringify({ ok: true }));
  `);
  const afterWrite = inFreshProcess(`
    const db = await import(${JSON.stringify(new URL("../dist/src/core/db.js", import.meta.url).href)});
    console.log(JSON.stringify(db.getCommandTasks().find((x) => x.title === "Round-trip fixture")));
  `);
  check("unrelated update did not strip the checklist on disk",
    afterWrite?.checklist?.length === 2 && afterWrite?.status === "in_progress",
    `got ${JSON.stringify({ checklist: afterWrite?.checklist, status: afterWrite?.status })}`);
  check("dueTime/reminders/sortOrder also survive the second round trip",
    afterWrite?.dueTime === "14:30" && JSON.stringify(afterWrite?.reminderMinutes) === "[10,5]" && afterWrite?.sortOrder === 3);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
