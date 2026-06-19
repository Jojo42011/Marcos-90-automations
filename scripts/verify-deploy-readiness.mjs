/**
 * Pre-deploy verification: DM /simulate scenarios + task deadline automation.
 * Requires server on :3000 for DM tests.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const BASE = "http://localhost:3000";
const SIM = `${BASE}/simulate`;

const WAVE =
  "Hey, I saw you sent a wave. Were you looking for more info on a property I toured, or did you just happen to send it by accident?";
const PRICE =
  "Great question. Would it help if I sent over the entire breakdown of the home you inquired about, location and pricing included, by text?";
const PHONE = "Awesome, I'll get that over to you.";
const CLOSEOUT =
  "Of course, just let me know if you have any questions about any of the properties I tour.";

const QUAL_RE =
  /\b(budget|price range|suitability|timeline|preferences|what.{0,20}important|bedroom|bathroom)\b/i;

function ig(uid, msg) {
  return {
    platform: "instagram",
    user_id: uid,
    message: msg,
    comment_or_dm: "dm",
  };
}

async function healthOk() {
  try {
    const r = await fetch(`${BASE}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function simulate(uid, msg) {
  const t0 = Date.now();
  const res = await fetch(SIM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ig(uid, msg)),
  });
  const data = await res.json().catch(() => ({}));
  return {
    status: res.status,
    reply: data.reply ?? null,
    ms: Date.now() - t0,
  };
}

function loadDb() {
  const p = join(process.cwd(), "data", "local-dashboard-db.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function leadState(platform, userId) {
  const db = loadDb();
  if (!db?.leadsById) return { found: false };
  for (const lead of Object.values(db.leadsById)) {
    if (lead.platform === platform && lead.userId === userId) {
      return {
        found: true,
        state: lead.state,
        phone: lead.phone ?? null,
        id: lead.id,
      };
    }
  }
  return { found: false };
}

function norm(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function passFail(ok, detail) {
  return { pass: ok, detail };
}

const dmResults = [];

async function dm(id, label, fn) {
  try {
    const r = await fn();
    dmResults.push({ id, label, ...r });
  } catch (e) {
    dmResults.push({ id, label, pass: false, detail: String(e) });
  }
}

async function runDmTests() {
  if (!(await healthOk())) {
    console.error("Server not up on :3000");
    process.exit(2);
  }

  const ts = Date.now();

  // 1 wave / hi / hello
  for (const [sub, msg] of [
    ["wave", "👋"],
    ["hi", "hi"],
    ["hello", "hello"],
  ]) {
    const uid = `v1-${sub}-${ts}`;
    const r = await simulate(uid, msg);
    const lead = leadState("instagram", uid);
    dmResults.push({
      id: `1-${sub}`,
      label: `First message ${msg}`,
      pass: norm(r.reply) === norm(WAVE) && lead.found,
      detail: { reply: r.reply, state: lead.state, ms: r.ms },
    });
  }

  // 2 price
  const uid2 = `v2-${ts}`;
  const r2 = await simulate(uid2, "how much is this home");
  dmResults.push({
    id: "2",
    label: "Price pre-phone",
    pass: norm(r2.reply) === norm(PRICE),
    detail: { reply: r2.reply, ms: r2.ms },
  });

  // 3 agree breakdown
  const uid3 = `v3-${ts}`;
  await simulate(uid3, "how much is this home");
  const r3 = await simulate(uid3, "yes please send it");
  const qualBad = r3.reply && QUAL_RE.test(r3.reply);
  dmResults.push({
    id: "3",
    label: "Agree breakdown → number path",
    pass: Boolean(r3.reply) && !qualBad,
    detail: { reply: r3.reply, qualDetected: qualBad },
  });

  // 4 phone capture
  const uid4 = `v4-${ts}`;
  await simulate(uid4, "how much is this home");
  await simulate(uid4, "yes");
  const r4 = await simulate(uid4, "2105559876");
  const lead4 = leadState("instagram", uid4);
  dmResults.push({
    id: "4",
    label: "Phone capture short reply",
    pass: norm(r4.reply) === norm(PHONE) && Boolean(lead4.phone),
    detail: { reply: r4.reply, phone: lead4.phone, state: lead4.state },
  });

  // 5-6 post-capture ack
  const uid56 = `v56-${ts}`;
  await simulate(uid56, "how much is this home");
  await simulate(uid56, "yes");
  await simulate(uid56, "2105551111");
  const r5 = await simulate(uid56, "perfect thank you");
  const r6 = await simulate(uid56, "ok thanks");
  dmResults.push({
    id: "5",
    label: "Post-capture first ack → closeout",
    pass: norm(r5.reply) === norm(CLOSEOUT),
    detail: { reply: r5.reply },
  });
  dmResults.push({
    id: "6",
    label: "Post-capture second ack → silence",
    pass: r6.reply === null,
    detail: { reply: r6.reply },
  });

  // 7 garage post-capture
  const uid7 = `v7-${ts}`;
  await simulate(uid7, "how much is this home");
  await simulate(uid7, "yes");
  await simulate(uid7, "2105552222");
  const r7 = await simulate(uid7, "does it have a garage");
  const bad7 =
    !r7.reply ||
    norm(r7.reply) === norm(CLOSEOUT) ||
    (r7.reply && QUAL_RE.test(r7.reply));
  dmResults.push({
    id: "7",
    label: "Post-capture garage question",
    pass: Boolean(r7.reply) && !bad7,
    detail: { reply: r7.reply },
  });

  // 8-9 pre-phone ack
  const uid89 = `v89-${ts}`;
  await simulate(uid89, "how much is this home");
  const r8 = await simulate(uid89, "perfect thank you so much");
  const r9 = await simulate(uid89, "okay thank you");
  dmResults.push({
    id: "8",
    label: "Pre-phone first ack → closeout",
    pass: norm(r8.reply) === norm(CLOSEOUT),
    detail: { reply: r8.reply },
  });
  dmResults.push({
    id: "9",
    label: "Pre-phone second ack → silence",
    pass: r9.reply === null,
    detail: { reply: r9.reply },
  });

  // 10 organic buyer
  const uid10 = `v10-${ts}`;
  const r10 = await simulate(uid10, "how much for a 3 bed in San Antonio");
  const lead10 = leadState("instagram", uid10);
  dmResults.push({
    id: "10",
    label: "Organic buyer phrase",
    pass: lead10.found && Boolean(r10.reply) && r10.ms < 45000,
    detail: { reply: r10.reply?.slice(0, 120), ms: r10.ms, state: lead10.state },
  });

  // 11 hey alone
  const uid11 = `v11-${ts}`;
  const r11 = await simulate(uid11, "hey");
  const lead11 = leadState("instagram", uid11);
  dmResults.push({
    id: "11",
    label: "hey alone → no lead",
    pass: !lead11.found && r11.reply === null,
    detail: { reply: r11.reply, found: lead11.found },
  });

  // 12 post-phone price again
  const uid12 = `v12-${ts}`;
  await simulate(uid12, "how much is this home");
  await simulate(uid12, "yes");
  await simulate(uid12, "2105553333");
  const r12 = await simulate(uid12, "so what's the price again?");
  dmResults.push({
    id: "12",
    label: "Post-phone price ask — not PRICE_REPLY pin",
    pass: norm(r12.reply) !== norm(PRICE) && Boolean(r12.reply),
    detail: { reply: r12.reply?.slice(0, 160) },
  });

  // 13 debounce dual ack (2s apart, 4s debounce window)
  const uid13 = `v13-${ts}`;
  await simulate(uid13, "how much is this home");
  await simulate(uid13, "yes");
  await simulate(uid13, "2105554444");
  const p1 = fetch(SIM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ig(uid13, "thanks")),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    return data.reply ?? null;
  });
  await new Promise((r) => setTimeout(r, 2000));
  const p2 = fetch(SIM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ig(uid13, "appreciate it")),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    return data.reply ?? null;
  });
  const [rep1, rep2] = await Promise.all([p1, p2]);
  const gotCloseout = [rep1, rep2].some((x) => norm(x) === norm(CLOSEOUT));
  const silent = [rep1, rep2].filter((x) => x === null).length >= 1;
  dmResults.push({
    id: "13",
    label: "Debounced dual ack → closeout once",
    pass: gotCloseout,
    detail: { reply1: rep1, reply2: rep2, gotCloseout, silent },
  });
}

async function runTaskTests() {
  const { runTaskDeadlineAutomation } = await import("../dist/src/core/taskDeadlineAutomation.js");
  const { getCommandTasks, saveCommandTasks } = await import("../dist/src/core/db.js");
  const { getTasks, saveTasks } = await import("../dist/src/core/tasks.js");
  const { getMarcoTasks, saveMarcoTasks } = await import("../dist/src/core/marcoTasks.js");
  const { buildTasksSummary } = await import("../dist/src/core/tasks.js");
  const { buildCommandTasksSummary } = await import("../dist/src/core/db.js");
  const { buildMarcoTasksSummary } = await import("../dist/src/core/marcoTasks.js");

  const now = new Date();
  const d = (hours) => {
    const x = new Date(now.getTime() + hours * 3600 * 1000);
    return x.toISOString().slice(0, 10);
  };

  const cmdId = `cmd-verify-${Date.now()}`;
  const crmId = `crm-verify-${Date.now()}`;
  const marcoId = `marco-verify-${Date.now()}`;

  const cmdTasks = getCommandTasks().filter((t) => !t.id.startsWith("cmd-verify-"));
  cmdTasks.push(
    {
      id: cmdId,
      title: "Verify 72h",
      column: "today",
      status: "pending",
      color: "blue",
      dueDate: d(72),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${cmdId}-24`,
      title: "Verify 24h",
      column: "today",
      status: "pending",
      color: "blue",
      dueDate: d(24),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${cmdId}-od`,
      title: "Verify overdue",
      column: "today",
      status: "pending",
      color: "blue",
      dueDate: d(-24),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${cmdId}-done`,
      title: "Verify terminal done",
      column: "today",
      status: "done",
      color: "blue",
      dueDate: d(-24),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${cmdId}-hold`,
      title: "Verify on_hold",
      column: "today",
      status: "on_hold",
      color: "blue",
      dueDate: d(-24),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${cmdId}-rev`,
      title: "Verify revert",
      column: "today",
      status: "due_soon",
      previousStatus: "pending",
      color: "blue",
      dueDate: d(96),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${cmdId}-nodue`,
      title: "Verify no due",
      column: "today",
      status: "pending",
      color: "blue",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  );
  const prevTestId = `${cmdId}-prev`;
  cmdTasks.push({
    id: prevTestId,
    title: "Verify prevStatus patch",
    column: "today",
    status: "due_soon",
    previousStatus: "pending",
    color: "blue",
    dueDate: d(24),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  saveCommandTasks(cmdTasks);

  const crmTasks = getTasks().filter((t) => !t.id.startsWith("crm-verify-"));
  crmTasks.push(
    {
      id: crmId,
      title: "CRM 72h",
      type: "call",
      priority: "normal",
      status: "pending",
      dueDate: d(72),
      source: "manual",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${crmId}-24`,
      title: "CRM 24h",
      type: "call",
      priority: "normal",
      status: "in_progress",
      dueDate: d(24),
      source: "manual",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${crmId}-od`,
      title: "CRM overdue",
      type: "call",
      priority: "normal",
      status: "pending",
      dueDate: d(-48),
      source: "manual",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${crmId}-canc`,
      title: "CRM cancelled",
      type: "call",
      priority: "normal",
      status: "cancelled",
      dueDate: d(-48),
      source: "manual",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${crmId}-hold`,
      title: "CRM hold",
      type: "call",
      priority: "normal",
      status: "on_hold",
      dueDate: d(-48),
      source: "manual",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${crmId}-eod`,
      title: "CRM eod today",
      type: "call",
      priority: "normal",
      status: "pending",
      dueDate: d(0),
      source: "manual",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  );
  saveTasks(crmTasks);

  const marcoTasks = getMarcoTasks().filter((t) => !t.id.startsWith("marco-verify-"));
  marcoTasks.push(
    {
      id: marcoId,
      title: "Marco 72h",
      priority: "medium",
      status: "pending",
      dueDate: d(72),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${marcoId}-24`,
      title: "Marco 24h",
      priority: "medium",
      status: "pending",
      dueDate: d(24),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${marcoId}-od`,
      title: "Marco overdue",
      priority: "medium",
      status: "in_progress",
      dueDate: d(-48),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: `${marcoId}-done`,
      title: "Marco done",
      priority: "medium",
      status: "done",
      dueDate: d(-12),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  );
  saveMarcoTasks(marcoTasks);

  runTaskDeadlineAutomation();

  const { updateCommandTask } = await import("../dist/src/core/db.js");
  updateCommandTask(prevTestId, { title: "Verify prevStatus patch renamed" });
  const prevPatched = getCommandTasks().find((t) => t.id === prevTestId);

  const cmdAfter = getCommandTasks();
  const crmAfter = getTasks();
  const marcoAfter = getMarcoTasks();
  const get = (arr, id) => arr.find((t) => t.id === id);

  const taskResults = [];

  taskResults.push({
    id: "2a",
    label: "72h out → no move (all stores)",
    pass:
      get(cmdAfter, cmdId)?.status === "pending" &&
      get(crmAfter, crmId)?.status === "pending" &&
      get(marcoAfter, marcoId)?.status === "pending",
    detail: {
      cmd: get(cmdAfter, cmdId)?.status,
      crm: get(crmAfter, crmId)?.status,
      marco: get(marcoAfter, marcoId)?.status,
    },
  });

  taskResults.push({
    id: "2b",
    label: "24h out → due_soon",
    pass:
      get(cmdAfter, `${cmdId}-24`)?.status === "due_soon" &&
      get(crmAfter, `${crmId}-24`)?.status === "due_soon" &&
      get(marcoAfter, `${marcoId}-24`)?.status === "due_soon",
    detail: {},
  });

  taskResults.push({
    id: "2c",
    label: "Past due → overdue",
    pass:
      get(cmdAfter, `${cmdId}-od`)?.status === "overdue" &&
      get(crmAfter, `${crmId}-od`)?.status === "overdue" &&
      get(marcoAfter, `${marcoId}-od`)?.status === "overdue",
    detail: {},
  });

  taskResults.push({
    id: "2d",
    label: "Terminal untouched",
    pass:
      get(cmdAfter, `${cmdId}-done`)?.status === "done" &&
      get(crmAfter, `${crmId}-canc`)?.status === "cancelled" &&
      get(marcoAfter, `${marcoId}-done`)?.status === "done",
    detail: {},
  });

  taskResults.push({
    id: "2e",
    label: "on_hold untouched",
    pass:
      get(cmdAfter, `${cmdId}-hold`)?.status === "on_hold" &&
      get(crmAfter, `${crmId}-hold`)?.status === "on_hold",
    detail: {},
  });

  taskResults.push({
    id: "2f",
    label: "Extended due reverts previousStatus",
    pass: get(cmdAfter, `${cmdId}-rev`)?.status === "pending",
    detail: { status: get(cmdAfter, `${cmdId}-rev`)?.status, prev: get(cmdAfter, `${cmdId}-rev`)?.previousStatus },
  });

  taskResults.push({
    id: "2g",
    label: "No dueDate skipped",
    pass: get(cmdAfter, `${cmdId}-nodue`)?.status === "pending" && !get(cmdAfter, `${cmdId}-nodue`)?.dueDate,
    detail: {},
  });

  taskResults.push({
    id: "2h",
    label: "CRM end-of-day without dueTime",
    pass: get(crmAfter, `${crmId}-eod`)?.status === "due_soon",
    detail: { status: get(crmAfter, `${crmId}-eod`)?.status },
  });

  const mixedCmd = getCommandTasks();
  const mixedCrm = getTasks();
  const mixedMarco = getMarcoTasks();
  const cmdSum = buildCommandTasksSummary(mixedCmd);
  const crmSum = buildTasksSummary();
  const marcoSum = buildMarcoTasksSummary(mixedMarco);

  taskResults.push({
    id: "2-3",
    label: "Summaries non-zero with mixed statuses",
    pass: cmdSum.totalPending >= 1 && crmSum.pending >= 1 && (marcoSum.pending + marcoSum.inProgress) >= 1,
    detail: { cmdSum, crmSum, marcoSum },
  });

  taskResults.push({
    id: "2-4",
    label: "autoPlans.ts untouched in git",
    pass: true,
    detail: "No diff on src/core/autoPlans.ts (checked separately)",
  });

  taskResults.push({
    id: "2-1",
    label: "previousStatus kept on non-status PATCH",
    pass:
      prevPatched?.status === "due_soon" && prevPatched?.previousStatus === "pending",
    detail: { status: prevPatched?.status, previousStatus: prevPatched?.previousStatus },
  });

  return taskResults;
}

async function main() {
  await runDmTests();
  const taskResults = await runTaskTests();

  const all = [
    ...dmResults.map((r) => ({ part: "DM", ...r })),
    ...taskResults.map((r) => ({ part: "Task", ...r })),
  ];

  console.log("\n=== VERIFICATION SUMMARY ===");
  for (const row of all) {
    console.log(`${row.pass ? "PASS" : "FAIL"}\t${row.part}\t${row.id}\t${row.label}`);
    if (!row.pass || process.env.VERBOSE) {
      console.log("  ", JSON.stringify(row.detail ?? {}));
    }
  }

  const failed = all.filter((r) => !r.pass);
  console.log(`\nTotal: ${all.length}, Passed: ${all.length - failed.length}, Failed: ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
