import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const root = mkdtempSync(join(tmpdir(), "dialer-check-"));
Object.assign(process.env, {
  TENANT_DATA_ROOT: root,
  TENANT_OWNER_ID: "marco",
  ACCOUNT_ISOLATION: "true",
  SHARED_DIALER_DB_PATH: join(root, "dialer.db"),
  USERS_JSON_PATH: join(root, "users.json"),
  QUO_API_KEY: "",
  OPENPHONE_API_KEY: "",
  DOTENV_CONFIG_PATH: join(root, ".empty"),
});
writeFileSync(join(root, ".empty"), "");
writeFileSync(
  join(root, "users.json"),
  JSON.stringify(
    ["Marco", "Carlos", "Wesley"].map((name) => ({
      id: name.toLowerCase(),
      name,
      email: name + "@example.com",
      active: true,
      role: "agent",
    })),
  ),
);
const require = createRequire(import.meta.url),
  express = require("express");
const { dialerStore } = require("../dist/src/dialer/store.js"),
  { syncDialer } = require("../dist/src/dialer/sync.js"),
  { registerDialer } = require("../dist/src/dialer/routes.js"),
  { getAccountUserById, getUsers } = require("../dist/src/core/users.js"),
  { getLeadById } = require("../dist/src/core/db.js"),
  { getTasks, updateTask } = require("../dist/src/core/tasks.js");
const store = dialerStore(),
  actor = getAccountUserById("marco");
const app = express();
app.use((req, res, next) => {
  res.cookie("mp_account_id", "marco");
  res.cookie("mp_workspace_id", "marco");
  next();
});
registerDialer(
  app,
  (r) => r.headers["x-denied"] !== "yes",
  () => actor,
);
app.get("/api/account/preferences", (_, r) =>
  r.json({
    preferences: {
      theme: "dark",
      accent: "#23796b",
      density: "comfortable",
      fontSize: 14,
      reducedMotion: false,
    },
  }),
);
app.get("/api/auth/me", (_, r) => r.json({ user: actor }));
app.use(express.static(resolve("public")));
app.get("/dialer", (_, r) => r.sendFile(resolve("public/dialer.html")));
const server = app.listen(
  process.argv.includes("--serve") ? 43707 : 0,
  "127.0.0.1",
);
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + server.address().port + "/api/dialer";
async function api(path, body, method = body ? "POST" : "GET", status = 200) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  assert.equal(res.status, status, JSON.stringify(data));
  return data;
}
try {
  assert.equal(
    (await fetch(base + "/overview", { headers: { "x-denied": "yes" } }))
      .status,
    401,
  );
  assert.equal(getUsers().length, 1);
  assert.equal((await api("/overview")).members.length, 3);
  const list = (await api("/lists", { name: "Expired listings", kind: "list" }))
    .list;
  const csv =
    "Name,Phone,Email,Address,City,Latitude,Longitude\nOlivia Carter,5125550101,olivia@example.com,1842 Cedar Lane,Austin,30.26,-97.74\nMarcus Reed,5125550102,marcus@example.com,2719 Maple Ridge,Austin,30.28,-97.73\nDuplicate,5125550101,,Same,Austin,,\nBad email,,bademail,,,";
  const preview = await api("/import", { csv, apply: false });
  assert.equal(preview.created, 2);
  assert.equal(preview.duplicates, 1);
  assert.equal(preview.invalid, 1);
  assert.equal(store.contacts().length, 0);
  await api("/import", { csv, apply: true, listId: list.id });
  assert.equal(store.members(list.id).length, 2);
  assert.equal((await api("/import", { csv, apply: true })).created, 0);
  await syncDialer();
  const contacts = store.contacts(),
    c = contacts[0];
  assert(await getLeadById(c.crmId));
  await api("/assign", { contactIds: [c.id], assignedTo: "wesley" });
  await syncDialer();
  assert.equal((await getLeadById(c.crmId)).assignedUserId, "wesley");
  const session = (await api("/sessions", { listId: list.id })).session;
  await api("/sessions", {}, "POST", 409);
  assert.throws(
    () => store.sessionAction(session.id, "carlos", "end"),
    /owner/,
  );
  const call = (await api("/sessions/" + session.id + "/calls", {})).call;
  assert.equal(
    (await api("/sessions/" + session.id + "/calls", {})).call.id,
    call.id,
  );
  const competing = store.start("carlos", "Carlos", list.id, "");
  assert.throws(
    () => store.beginCall(competing.id, "carlos"),
    /already working/,
  );
  await api(
    "/sessions/" + session.id + "/action",
    { action: "skip" },
    "POST",
    409,
  );
  await api("/calls/" + call.id + "/outcome", {
    outcome: "do_not_call",
    notes: "Requested removal",
  });
  await api("/calls/" + call.id + "/outcome", { outcome: "do_not_call" });
  await syncDialer();
  await syncDialer();
  let lead = await getLeadById(c.crmId);
  assert(lead.tags.includes("do-not-call"));
  assert.equal(
    lead.activity.filter((a) => a.meta?.DialerEvent === "call:" + call.id)
      .length,
    1,
  );
  await api("/contacts/" + c.id, { dnc: false }, "PATCH");
  await syncDialer();
  assert(!(await getLeadById(c.crmId)).tags.includes("do-not-call"));
  const a = (
    await api("/appointments", {
      contactId: c.id,
      title: "Listing consultation",
      startAt: "2026-11-11T15:00:00-06:00",
      endAt: "2026-11-11T15:30:00-06:00",
      timeZone: "America/Chicago",
      assignedTo: "marco",
    })
  ).appointment;
  await api(
    "/appointments",
    {
      contactId: c.id,
      startAt: a.startAt,
      endAt: a.endAt,
      assignedTo: "marco",
    },
    "POST",
    409,
  );
  await api(
    "/appointments",
    { contactId: c.id, startAt: "2026-11-12T15:00", endAt: "2026-11-12T15:30" },
    "POST",
    400,
  );
  await syncDialer();
  await syncDialer();
  assert.equal(getTasks().length, 1);
  assert.equal(getTasks()[0].dueTime, "15:00");
  updateTask(getTasks()[0].id, {
    status: "completed",
    appointmentStatus: "completed",
  });
  await syncDialer();
  assert.equal(store.get("appointment", a.id).status, "completed");
  await api(
    "/appointments/" + a.id,
    { contactId: contacts[1].id },
    "PATCH",
    400,
  );
  await api("/sessions/" + session.id + "/action", { action: "end" });
  if(!process.argv.includes('--serve')){
    store.import('Name,Phone\nOther owner,5125550199','wesley','Private owner fixture','',true);
    const foreign=store.contacts().find(c=>c.ownerId==='wesley');
    store.queue('wesley',{id:'foreign-note',type:'note',contactId:foreign.id,notes:'Other worker only',actorId:'marco'});
    await syncDialer();assert.equal(await getLeadById(foreign.crmId),null);
    assert.equal(store.db.prepare('SELECT done FROM outbox WHERE id=?').get('foreign-note').done,0);
    const {createTask}=require('../dist/src/core/tasks.js');
    const task=createTask({title:'CRM-created appointment',type:'appointment',dueDate:'2026-11-14',dueTime:'10:00',leadId:c.crmId,assignedUserId:'marco',status:'pending'});
    await syncDialer();const mirrored=store.all('appointment').find(x=>x.crmTaskId===task.id);assert(mirrored);
    await api('/appointments/'+encodeURIComponent(mirrored.id),{title:'Updated from Dialer'},'PATCH');await syncDialer();assert.equal(getTasks().length,2);assert.equal(getTasks().find(t=>t.id===task.id).title,'Updated from Dialer');
  }
  const metrics = await api("/overview");
  assert.equal(metrics.sessionCounts[session.id].attempts, 1);
  assert.equal(metrics.totals.connected, 0);
  assert((await api("/export")).csv.includes("Olivia"));
  assert.equal((await api("/numbers")).purchaseSupported, false);
  assert((await api("/guide")).operations.session.includes("/sessions"));
  console.log(
    "PASS: auth, shared roster/private CRM, CSV preview/dedup, assignment, exclusive sessions, call replay, DNC and activity sync, timezone/conflicts, CRM task replay/completion, metrics, exports, Harvey guide.",
  );
  if (process.argv.includes("--serve")) {
    const names = [
      "Sophia Bennett",
      "James Wilson",
      "Emma Brooks",
      "Daniel Hayes",
      "Rachel Green",
      "Chris Walker",
      "Alex Morgan",
      "Mia Sullivan",
      "Noah Williams",
      "Ava Robinson",
    ];
    store.import(
      "Name,Phone,Address,City\n" +
        names
          .map(
            (n, i) =>
              n +
              ",512555" +
              String(110 + i).padStart(4, "0") +
              "," +
              (1400 + i * 17) +
              " Lakeview Drive,Austin",
          )
          .join("\n"),
      "marco",
      "Neighborhood",
      list.id,
      true,
    );
    store.createList("marco", "Past conversations", "group");
    store.createList("marco", "Austin homeowners", "list");
    for (let day = 0; day < 7; day++)
      for (let i = 0; i < [12, 18, 15, 26, 22, 34, 24][day]; i++) {
        const d = new Date();
        d.setDate(d.getDate() - 6 + day);
        store.put("call", {
          id: "sample-" + day + "-" + i,
          actorId: "marco",
          sessionId: "sample-session-" + day,
          contactId: c.id,
          startedAt: d.toISOString(),
          endedAt: d.toISOString(),
          outcome: i % 3 ? "no_answer" : "talked",
        });
      }
    store.put("sync", { id: "carlos", at: new Date().toISOString() });
    store.put("sync", { id: "wesley", at: new Date().toISOString() });
    store.start("marco", "Marco", list.id, "");
    await syncDialer();
    console.log("SAMPLE DATA preview at http://127.0.0.1:43707/dialer");
  } else {
    server.close();
    store.db.close();
  }
} catch (e) {
  server.close();
  console.error(e);
  process.exitCode = 1;
}
