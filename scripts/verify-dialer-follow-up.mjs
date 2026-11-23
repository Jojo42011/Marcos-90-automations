/**
 * Synthetic coverage: Dialer due-today / overdue buckets from CRM task dates,
 * appointment leave cold queue while CRM persists, status→stage, DM→Not Contacted.
 * Isolated fixtures only — no live providers or real contacts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const root = mkdtempSync(join(tmpdir(), "dialer-followup-"));
Object.assign(process.env, {
  TENANT_DATA_ROOT: root,
  TENANT_OWNER_ID: "marco",
  ACCOUNT_ISOLATION: "true",
  SHARED_DIALER_DB_PATH: join(root, "dialer.db"),
  TRACKER_DB_PATH: join(root, "tracker.db"),
  USERS_JSON_PATH: join(root, "users.json"),
  QUO_API_KEY: "",
  OPENPHONE_API_KEY: "",
  DOTENV_CONFIG_PATH: join(root, ".empty"),
});
writeFileSync(join(root, ".empty"), "");
writeFileSync(
  join(root, "users.json"),
  JSON.stringify([
    { id: "marco", name: "Marco", email: "marco@example.com", active: true, role: "agent" },
    { id: "wesley", name: "Wesley", email: "wesley@example.com", active: true, role: "agent" },
  ]),
);

const require = createRequire(import.meta.url);
const {
  centralDateKey,
  earliestFollowUpDueDate,
  followUpBucket,
} = require("../dist/src/dialer/followUpDue.js");
const { matchesQueue, queueSummaries } = require("../dist/src/dialer/queues.js");
const { dialerStore } = require("../dist/src/dialer/store.js");
const { syncDialer } = require("../dist/src/dialer/sync.js");
const { upsertLeadQuiet, getLeadById, updateLeadCrmFields } = require("../dist/src/core/db.js");
const { createTask } = require("../dist/src/core/tasks.js");
const { bumpTrackerFromDialerActivity } = require("../dist/src/core/trackerDialerBump.js");
const {
  getTrackerRecordByLead,
  getTrackerDb,
} = require("../dist/src/core/trackerStore.js");
const { stageTrackerFromPhoneCapture } = require("../dist/src/core/trackerEngagement.js");

const today = centralDateKey();
const yesterday = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return centralDateKey(d);
})();
const tomorrow = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return centralDateKey(d);
})();

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok", name);
  } catch (e) {
    failed += 1;
    console.error("FAIL", name, e.message);
  }
}

check("earliestFollowUpDueDate prefers open call/follow_up only", () => {
  const tasks = [
    { leadId: "a", type: "call", status: "pending", dueDate: tomorrow },
    { leadId: "a", type: "call", status: "pending", dueDate: yesterday },
    { leadId: "a", type: "appointment", status: "pending", dueDate: "2000-01-01" },
    { leadId: "a", type: "call", status: "completed", dueDate: "1999-01-01" },
    { leadId: "a", type: "follow_up", status: "cancelled", dueDate: "1998-01-01" },
    { leadId: "a", type: "call", status: "on_hold", dueDate: "1997-01-01" },
    { leadId: "b", type: "follow_up", status: "due_soon", dueDate: today },
  ];
  assert.equal(earliestFollowUpDueDate(tasks, "a"), yesterday);
  assert.equal(earliestFollowUpDueDate(tasks, "b"), today);
  assert.equal(earliestFollowUpDueDate(tasks, "missing"), "");
});

check("completed and canceled follow-ups alone yield no due date", () => {
  assert.equal(
    earliestFollowUpDueDate(
      [
        { leadId: "c", type: "call", status: "completed", dueDate: yesterday },
        { leadId: "c", type: "follow_up", status: "cancelled", dueDate: today },
      ],
      "c",
    ),
    "",
  );
});

check("followUpBucket: overdue wins over urgent; due today; urgent without date", () => {
  assert.equal(followUpBucket({ followUpDueDate: yesterday, crmCallQueue: "urgent" }, today), "overdue");
  assert.equal(followUpBucket({ followUpDueDate: today, crmCallQueue: "none" }, today), "due");
  assert.equal(followUpBucket({ followUpDueDate: "", crmCallQueue: "urgent" }, today), "due");
  assert.equal(followUpBucket({ followUpDueDate: tomorrow, crmCallQueue: "none" }, today), "");
  assert.equal(followUpBucket({ followUpDueDate: "", crmCallQueue: "none" }, today), "");
});

check("matchesQueue due vs overdue", () => {
  const overdue = {
    id: "1",
    phone: "5125550101",
    dnc: false,
    archived: false,
    followUpDueDate: yesterday,
    crmCallQueue: "urgent",
  };
  const due = {
    id: "2",
    phone: "5125550102",
    dnc: false,
    archived: false,
    followUpDueDate: today,
    crmCallQueue: "none",
  };
  assert.equal(matchesQueue(overdue, "overdue"), true);
  assert.equal(matchesQueue(overdue, "due"), false);
  assert.equal(matchesQueue(due, "due"), true);
  assert.equal(matchesQueue(due, "overdue"), false);
});

// Sync projects followUpDueDate from CRM tasks into Dialer contacts.
upsertLeadQuiet({
  id: "lead-due-dated",
  platform: "crm",
  userId: "due_dated",
  username: null,
  name: "Due Dated",
  phone: "5125550401",
  email: null,
  state: "new",
  source: "Manual",
  adCampaign: null,
  propertyInquired: null,
  address: null,
  criteria: null,
  brivityId: null,
  crmStatus: "new",
  crmStage: "new",
  crmPriority: "normal",
  crmIntent: "seller",
  crmCallQueue: "none",
  crmNotes: null,
  assignedUserId: "marco",
  assignedUserName: "Marco",
  tags: [],
});
upsertLeadQuiet({
  id: "lead-overdue-dated",
  platform: "crm",
  userId: "over_dated",
  username: null,
  name: "Overdue Dated",
  phone: "5125550402",
  email: null,
  state: "new",
  source: "Manual",
  adCampaign: null,
  propertyInquired: null,
  address: "9 Cold Lane",
  criteria: null,
  brivityId: null,
  crmStatus: "nurture",
  crmStage: "new",
  crmPriority: "normal",
  crmIntent: "seller",
  crmCallQueue: "urgent",
  crmNotes: null,
  assignedUserId: "marco",
  assignedUserName: "Marco",
  tags: [],
});
createTask({
  title: "Call due today",
  type: "call",
  priority: "normal",
  source: "manual",
  dueDate: today,
  leadId: "lead-due-dated",
  assignedUserId: "marco",
  status: "pending",
});
createTask({
  title: "Call overdue",
  type: "follow_up",
  priority: "normal",
  source: "manual",
  dueDate: yesterday,
  leadId: "lead-overdue-dated",
  assignedUserId: "marco",
  status: "pending",
});

await syncDialer();
const store = dialerStore();
const dueC = store.contacts().find((c) => c.crmId === "lead-due-dated");
const overC = store.contacts().find((c) => c.crmId === "lead-overdue-dated");

check("sync stamps followUpDueDate onto Dialer contacts", () => {
  assert(dueC);
  assert(overC);
  assert.equal(dueC.followUpDueDate, today);
  assert.equal(overC.followUpDueDate, yesterday);
  const summaries = queueSummaries(store.contacts());
  assert.equal(summaries.find((q) => q.id === "due").count >= 1, true);
  assert.equal(summaries.find((q) => q.id === "overdue").count >= 1, true);
  assert.equal(matchesQueue(dueC, "due"), true);
  assert.equal(matchesQueue(overC, "overdue"), true);
  assert.equal(matchesQueue(overC, "due"), false);
});

{
  // Session Appointment Set on Mojo Expired smart queue (not a physical list).
  upsertLeadQuiet({
    id: "lead-mojo-book",
    platform: "crm",
    userId: "mojobook",
    username: null,
    name: "Mojo Booked Seller",
    phone: "5125550410",
    email: null,
    state: "new",
    source: "Mojo",
    adCampaign: null,
    propertyInquired: null,
    address: "1 Expired Ave",
    criteria: null,
    brivityId: null,
    crmStatus: "nurture",
    crmStage: "new",
    crmPriority: "normal",
    crmIntent: "seller",
    crmCallQueue: "none",
    crmNotes: null,
    assignedUserId: "marco",
    assignedUserName: "Marco",
    tags: ["Expired"],
  });
  await syncDialer();
  let mojoBook = store.contacts().find((c) => c.crmId === "lead-mojo-book");
  assert(mojoBook);
  assert.equal(matchesQueue(mojoBook, "mojo", store.bookedAppointmentIds()), true);
  const session = store.start("marco", "Marco", "", "", undefined, "mojo");
  assert.equal(session.queueId, "mojo");
  assert(session.queue.includes(mojoBook.id));
  assert.equal(session.queue[session.position], mojoBook.id);
  const call = store.beginCall(session.id, "marco");
  assert.equal(call.contactId, mojoBook.id);
  store.finishCall(call.id, "marco", "appointment_set", "Booked listing appt");
  store.sessionAction(session.id, "marco", "end");
  await syncDialer(); // CRM re-sync keeps Mojo+Expired tags
  mojoBook = store.contacts().find((c) => c.crmId === "lead-mojo-book");
  const booked = store.bookedAppointmentIds();
  assert(booked.has(mojoBook.id), "must land in Appointments group");
  assert.equal(
    matchesQueue(mojoBook, "mojo", booked),
    false,
    "booked lead must leave Mojo Expired prospecting queue after reload/sync",
  );
  assert.equal(matchesQueue(mojoBook, "nurture", booked), false);
  assert.equal(matchesQueue(mojoBook, "new", booked), false);
  assert.equal(
    store
      .contacts()
      .filter((c) => matchesQueue(c, "mojo", booked))
      .some((c) => c.crmId === "lead-mojo-book"),
    false,
  );
  // Starting Mojo again must not requeue the booked contact.
  assert.throws(
    () => store.start("marco", "Marco", "", "", [mojoBook.id], "mojo"),
    /No callable contacts match this queue/,
  );
  // Explicit open follow-up keeps single-line Due/Overdue (and Everyone) available.
  createTask({
    title: "Post-booking follow-up call",
    type: "call",
    priority: "normal",
    source: "manual",
    dueDate: today,
    leadId: "lead-mojo-book",
    assignedUserId: "marco",
    status: "pending",
  });
  await syncDialer();
  mojoBook = store.contacts().find((c) => c.crmId === "lead-mojo-book");
  const bookedAfter = store.bookedAppointmentIds();
  assert(bookedAfter.has(mojoBook.id));
  assert.equal(mojoBook.followUpDueDate, today);
  assert.equal(matchesQueue(mojoBook, "mojo", bookedAfter), false, "still out of Mojo after refresh");
  assert.equal(matchesQueue(mojoBook, "due", bookedAfter), true, "Due today keeps explicit open task");
  assert.equal(matchesQueue(mojoBook, "everyone", bookedAfter), true);
  createTask({
    title: "Overdue post-booking follow-up",
    type: "follow_up",
    priority: "normal",
    source: "manual",
    dueDate: yesterday,
    leadId: "lead-mojo-book",
    assignedUserId: "marco",
    status: "pending",
  });
  await syncDialer();
  mojoBook = store.contacts().find((c) => c.crmId === "lead-mojo-book");
  assert.equal(mojoBook.followUpDueDate, yesterday);
  assert.equal(matchesQueue(mojoBook, "mojo", store.bookedAppointmentIds()), false);
  assert.equal(matchesQueue(mojoBook, "overdue", store.bookedAppointmentIds()), true);
  assert.equal(matchesQueue(mojoBook, "due", store.bookedAppointmentIds()), false);
  const crm = await getLeadById("lead-mojo-book");
  assert(crm, "CRM lead must persist");
  assert.equal(crm.phone, "5125550410");
  assert.equal(crm.address, "1 Expired Ave");
  assert.deepEqual(crm.tags, ["Expired"]);
  console.log("ok booked: out of Mojo, still in Due/Overdue with open task; CRM persists");
}

{
  // Completing the only open follow-up clears due/overdue after re-sync.
  const { updateTask, getTasks } = require("../dist/src/core/tasks.js");
  const open = getTasks().find((t) => t.leadId === "lead-due-dated" && t.status === "pending");
  assert(open);
  updateTask(open.id, { status: "completed", completedAt: new Date().toISOString() });
  await syncDialer();
  const cleared = store.contacts().find((c) => c.crmId === "lead-due-dated");
  assert.equal(cleared.followUpDueDate || "", "");
  assert.equal(matchesQueue(cleared, "due", store.bookedAppointmentIds()), false);
  console.log("ok completed follow-up clears due queue after sync");
}

{
  // Tenant scope: this worker only syncs its owner; foreign-owner Dialer rows keep their stamp.
  const foreign = {
    id: "crm:wesley:lead-foreign-due",
    ownerId: "wesley",
    crmId: "lead-foreign-due",
    name: "Wesley Due",
    phone: "5125550499",
    email: "",
    address: "",
    city: "",
    source: "Manual",
    assignedTo: "wesley",
    intent: "seller",
    dnc: false,
    archived: false,
    crmLinked: true,
    tags: [],
    crmStatus: "new",
    crmCallQueue: "none",
    followUpDueDate: "2099-01-01",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.put("contact", foreign);
  createTask({
    title: "Should not rewrite Wesley contact",
    type: "call",
    priority: "normal",
    source: "manual",
    dueDate: today,
    leadId: "lead-foreign-due",
    assignedUserId: "marco",
    status: "pending",
  });
  await syncDialer();
  assert.equal(store.get("contact", foreign.id).followUpDueDate, "2099-01-01");
  assert.equal(store.get("contact", foreign.id).ownerId, "wesley");
  console.log("ok tenant sync leaves other-owner Dialer contacts untouched");
}

check("status-to-stage: Dialer Talked advances seller New → Contacted", () => {
  upsertLeadQuiet({
    id: "lead-stage-map",
    platform: "crm",
    userId: "stage1",
    username: null,
    name: "Stage Map Seller",
    phone: "5125550403",
    email: null,
    state: "new",
    source: "Manual",
    adCampaign: null,
    propertyInquired: null,
    address: null,
    criteria: null,
    brivityId: null,
    crmStatus: "new",
    crmStage: "new",
    crmPriority: "normal",
    crmIntent: "seller",
    crmCallQueue: "none",
    crmNotes: null,
    assignedUserId: "marco",
    assignedUserName: "Marco",
    tags: [],
  });
  const r = bumpTrackerFromDialerActivity({
    leadId: "lead-stage-map",
    outcome: "Talked",
    source: "Dialer",
    leadIntent: "seller",
    leadName: "Stage Map Seller",
    leadPhone: "5125550403",
    createIfMissing: true,
  });
  assert.equal(r.applied, true, JSON.stringify(r));
  const rec = getTrackerRecordByLead("lead-stage-map");
  assert.equal(rec.sellerStage, "contacted");
  const appt = bumpTrackerFromDialerActivity({
    leadId: "lead-stage-map",
    outcome: "appointment_set",
    source: "Dialer",
    leadIntent: "seller",
  });
  assert.equal(appt.applied, true);
  assert.equal(getTrackerRecordByLead("lead-stage-map").sellerStage, "listing_appointment_set");
});

check("buyer DM phone intake → Tracker Not Contacted; later Talked → Contacted", () => {
  const created = stageTrackerFromPhoneCapture({
    id: "lead-dm-intake",
    name: "DM Intake Buyer",
    phone: "2105550199",
    crmIntent: "buyer",
  });
  assert.equal(created.created, true);
  let rec = getTrackerRecordByLead("lead-dm-intake");
  assert.equal(rec.buyerStage, "not_contacted");
  const talked = bumpTrackerFromDialerActivity({
    leadId: "lead-dm-intake",
    outcome: "Talked",
    source: "Dialer",
    leadIntent: "buyer",
  });
  assert.equal(talked.applied, true);
  rec = getTrackerRecordByLead("lead-dm-intake");
  assert.equal(rec.buyerStage, "contacted");
  const set = bumpTrackerFromDialerActivity({
    leadId: "lead-dm-intake",
    outcome: "Appointment Set",
    source: "Dialer",
    leadIntent: "buyer",
  });
  assert.equal(set.applied, true);
  assert.equal(getTrackerRecordByLead("lead-dm-intake").buyerStage, "appointment_set");
});

check("MLS expired auto-feed stays blocked; Mojo/CSV path remains", () => {
  const cma = require("node:fs").readFileSync(
    new URL("../src/core/cmaComps.ts", import.meta.url),
    "utf8",
  );
  assert.match(cma, /Expired, withdrawn and cancelled listings are not published on this feed/);
  const routes = require("node:fs").readFileSync(
    new URL("../src/dialer/routes.ts", import.meta.url),
    "utf8",
  );
  assert.match(routes, /Owner phone enrichment is not connected/);
  assert.match(routes, /automaticDialing: false/);
});

// The CRM status drives Dialer queues. A status-only save must preserve DNC
// and must never manufacture a stage event, including on a retried save.
{
  const id = "lead-due-dated";
  const lead = await getLeadById(id);
  upsertLeadQuiet({ ...lead, tags: ["do-not-call"] });
  const update = { leadId: id, crmStatus: "hot", crmStage: "appointment_set", stageActor: "Fixture agent" };
  await updateLeadCrmFields(update);
  await updateLeadCrmFields(update);
  await updateLeadCrmFields({ leadId: id, crmStatus: "watch" });
  const saved = await getLeadById(id);
  assert.equal(saved.crmStatus, "watch");
  assert.deepEqual(saved.tags, ["do-not-call"]);
  assert.equal(saved.stageChanges.length, 1);
  const [event] = saved.stageChanges;
  assert.equal(event.from, lead.crmStage);
  assert.equal(event.to, "appointment_set");
  assert.equal(event.actor, "Fixture agent");
  assert.ok(Number.isFinite(Date.parse(event.at)));
  await syncDialer();
  const mirrored = dialerStore().contacts().find(contact => contact.crmId === id);
  assert.equal(mirrored.crmStatus, "watch");
  assert.equal(mirrored.dnc, true);
  console.log("ok CRM status mirrors to Dialer, retains DNC, and records a stage change once");
}

dialerStore().db.close();
getTrackerDb().close();
rmSync(root, { recursive: true, force: true });

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("PASS: dialer follow-up due/overdue, appointment CRM persist, status→stage, DM Not Contacted, MLS blocked note");
