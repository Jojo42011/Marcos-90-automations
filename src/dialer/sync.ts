import { dialerStore, now, Contact } from "./store.js";
import { tenantOwner, isTenantGateway } from "../core/tenantData.js";
import { getUsers, getDialerTeam } from "../core/users.js";
import {
  listAllLeads,
  getLeadById,
  upsertLeadQuiet,
  appendLeadActivity,
} from "../core/db.js";
import { getTasks, createTask, updateTask } from "../core/tasks.js";
import { FunnelStage } from "../core/state.js";
import { bumpTrackerFromDialerActivity } from "../core/trackerDialerBump.js";
import {
  isQuoConfigured,
  listPhoneNumbers,
} from "../integrations/quo/index.js";
let running: Promise<void> | null = null,
  lastNumbers = 0;
export function syncDialer() {
  if (isTenantGateway()) return Promise.resolve();
  if (running) return running;
  running = sync().finally(() => (running = null));
  return running;
}
async function sync() {
  const store = dialerStore(),
    owner = tenantOwner() || getUsers().find((u) => u.active)?.id || "local";
  // Only this worker writes its own CRM. Other workers drain their own durable outbox.
  const owns = (id: string) => !tenantOwner() || id === owner;
  const localBefore = await listAllLeads(),
    localIds = new Set(localBefore.map((l) => l.id));
  for (const c of store
    .contacts()
    .filter((c) => owns(c.ownerId) && c.crmId.startsWith("dialer_"))) {
    if (!localIds.has(c.crmId) && !c.crmLinked) {
      upsertLeadQuiet({
        id: c.crmId,
        platform: "dialer",
        userId: c.id,
        username: null,
        name: c.name,
        phone: c.phone || null,
        email: c.email || null,
        state: FunnelStage.New,
        source: c.source,
        adCampaign: null,
        propertyInquired: c.address || null,
        address: c.address,
        criteria: null,
        brivityId: null,
        crmStatus: "new",
        crmStage: "new",
        crmPriority: "normal",
        crmIntent: "seller",
        crmCallQueue: "none",
        crmNotes: null,
        assignedUserId: c.assignedTo,
        assignedUserName: getDialerTeam().find((u) => u.id === c.assignedTo)
          ?.name,
        tags: c.dnc ? ["do-not-call"] : [],
      });
    }
  }
  const events = store.db
    .prepare("SELECT * FROM outbox WHERE done=0"+(tenantOwner()?" AND owner=?":"")+" ORDER BY rowid LIMIT 1000")
    .all(...(tenantOwner()?[owner]:[])) as any[];
  for (const row of events.filter((r) => owns(r.owner))) {
    try {
      const event = JSON.parse(row.body),
        c = store.get<Contact>("contact", event.contactId);
      if (!c) throw new Error("Contact no longer exists");
      const lead = await getLeadById(c.crmId);
      if (!lead) throw new Error("CRM contact is unavailable");
      if (event.type === "call" || event.type === "note") {
        if (
          !(lead.activity || []).some((a) => a.meta?.DialerEvent === event.id)
        )
          await appendLeadActivity(lead.id, [
            {
              type: event.type === "call" ? "call" : "note",
              description:
                event.type === "call"
                  ? "Dialer: " + event.outcome.replace(/_/g, " ")
                  : "Dialer note",
              notes: event.notes,
              timestamp: event.at || now(),
              author:
                getDialerTeam().find((u) => u.id === event.actorId)?.name ||
                "Team member",
              meta: {
                Source: "Dialer",
                Outcome: event.outcome || "",
                DialerEvent: event.id,
                Duration: String(event.elapsedSeconds || 0),
              },
            },
          ]);
        if (event.type === "call")
          bumpTrackerFromDialerActivity({
            leadId: lead.id,
            leadIntent: lead.crmIntent,
            leadName: lead.name,
            leadPhone: lead.phone,
            leadEmail: lead.email,
            leadSource: lead.source,
            leadAssignedTo: lead.assignedUserId,
            outcome: event.outcome,
            source: "Dialer",
          });
        if (event.outcome === "do_not_call") {
          const fresh = await getLeadById(lead.id);
          if (fresh && !fresh.tags?.includes("do-not-call"))
            upsertLeadQuiet({
              ...fresh,
              tags: [...(fresh.tags || []), "do-not-call"],
            });
        }
      }
      if (event.type === "dnc")
        upsertLeadQuiet({
          ...lead,
          tags: [
            ...(lead.tags || []).filter((t) => !/^(do.not.call|dnc)$/i.test(t)),
            ...(event.dnc ? ["do-not-call"] : []),
          ],
        });
      if (event.type === "assignment")
        upsertLeadQuiet({
          ...lead,
          assignedUserId: event.assignedTo,
          assignedUserName: getDialerTeam().find((u) => u.id === event.assignedTo)
            ?.name,
        });
      if (event.type === "appointment") {
        const a = store.get("appointment", event.appointmentId);
        if (!a) throw new Error("Appointment missing");
        const marker = "[Dialer appointment: " + a.id + "]",
          old = getTasks().find((t) => t.id===a.crmTaskId || t.description?.includes(marker));
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: a.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).formatToParts(new Date(a.startAt));
        const part = (k: string) => parts.find((p) => p.type === k)?.value;
        const fields: any = {
          title: a.title,
          description: marker + "\n" + a.notes + "\nTimezone: " + a.timeZone,
          type: a.kind === "follow_up" ? "follow_up" : "appointment",
          priority: "normal",
          status:
            a.status === "completed"
              ? "completed"
              : a.status === "cancelled"
                ? "cancelled"
                : "pending",
          dueDate: part("year") + "-" + part("month") + "-" + part("day"),
          dueTime: part("hour") + ":" + part("minute"),
          leadId: lead.id,
          leadName: lead.name || "",
          assignedUserId: a.assignedTo,
          assignedUserName: getDialerTeam().find((u) => u.id === a.assignedTo)
            ?.name,
          source: "dial_session",
          location: a.location,
          appointmentStatus: a.status,
        };
        const task = old ? updateTask(old.id, fields) : createTask(fields);
        if (a.status === "scheduled" && a.kind === "appointment")
          bumpTrackerFromDialerActivity({
            leadId: lead.id,
            leadIntent: lead.crmIntent,
            leadName: lead.name,
            leadPhone: lead.phone,
            leadEmail: lead.email,
            leadSource: lead.source,
            leadAssignedTo: lead.assignedUserId,
            outcome: "appointment_set",
            source: "Dialer",
          });
        store.put("appointment", {
          ...a,
          crmTaskId: task.id,
          crmTaskUpdatedAt: task.updatedAt,
        });
      }
      store.db
        .prepare("UPDATE outbox SET done=1,error=NULL WHERE id=?")
        .run(row.id);
    } catch (e) {
      store.db
        .prepare("UPDATE outbox SET error=? WHERE id=?")
        .run((e as Error).message, row.id);
    }
  }
  const leads = await listAllLeads();
  store.tx(() => {
    const known = store.all<Contact>("contact").filter((c) => owns(c.ownerId));
    const byCrm = new Map(known.map((c) => [c.crmId, c]));
    for (const lead of leads) {
      const old = byCrm.get(lead.id),
        id = old?.id || "crm:" + owner + ":" + lead.id;
      const tags = lead.tags || [];
      store.put("contact", {
        ...old,
        id,
        ownerId: old?.ownerId || owner,
        crmId: lead.id,
        name: lead.name || lead.username || lead.phone || "Unnamed contact",
        phone: lead.phone || "",
        email: lead.email || "",
        address: lead.address || lead.propertyInquired || "",
        city: old?.city || "",
        source: lead.source || lead.platform,
        assignedTo: lead.assignedUserId || old?.assignedTo || owner,
        intent: lead.crmIntent || "seller",
        dnc: tags.some((t) => /^(do.not.call|dnc)$/i.test(t)),
        archived: false,
        crmLinked: true,
        createdAt: old?.createdAt || lead.createdAt,
        updatedAt: lead.updatedAt,
      });
    }
    const ids = new Set(leads.map((l) => l.id));
    for (const old of known)
      if (!ids.has(old.crmId) && old.crmLinked)
        store.put("contact", { ...old, archived: true });
    store.put("sync", { id: owner, at: now(), contacts: leads.length });
  });
  // Mirror dated CRM appointments/follow-ups, including subsequent edits and completion.
  const contacts = store.contacts().filter((c) => owns(c.ownerId)),
    appointments = store.all("appointment");
  for (const task of getTasks().filter(
    (t) =>
      ["appointment", "follow_up"].includes(t.type) &&
      t.leadId &&
      t.dueDate &&
      t.dueTime,
  )) {
    const c = contacts.find((c) => c.crmId === task.leadId);
    if (!c) continue;
    const old = appointments.find((a) => a.crmTaskId === task.id);
    if (old?.crmTaskUpdatedAt === task.updatedAt) continue;
    const timeZone = old?.timeZone || "America/Chicago";
    const startAt = localTimeToIso(task.dueDate, task.dueTime!, timeZone);
    if (!startAt) continue;
    const duration = old
      ? Math.max(60000, Date.parse(old.endAt) - Date.parse(old.startAt))
      : 1800000;
    const status = ["completed", "cancelled"].includes(task.status)
      ? task.status
      : task.appointmentStatus || "scheduled";
    store.put("appointment", {
      ...old,
      id: old?.id || "crm-task:" + owner + ":" + task.id,
      contactId: c.id,
      ownerId: c.ownerId,
      title: task.title,
      startAt,
      endAt: new Date(Date.parse(startAt) + duration).toISOString(),
      timeZone,
      assignedTo: task.assignedUserId || owner,
      location: task.location || "",
      notes:
        task.description
          ?.replace(/\[Dialer appointment: [^\]]+\]\n?/, "")
          .replace(/\nTimezone:.*$/, "") || "",
      kind: task.type === "follow_up" ? "follow_up" : "appointment",
      status,
      createdBy: old?.createdBy || owner,
      createdAt: old?.createdAt || task.createdAt,
      updatedAt: now(),
      crmTaskId: task.id,
      crmTaskUpdatedAt: task.updatedAt,
    });
  }
  if (isQuoConfigured() && Date.now() - lastNumbers > 300000) {
    try {
      const numbers = await listPhoneNumbers();
      store.put("numbers", {
        id: owner,
        numbers: numbers.map((n) => ({
          id: n.id,
          number: n.number,
          label: n.name || n.formattedNumber || n.number,
        })),
        at: now(),
        error: null,
      });
      lastNumbers = Date.now();
    } catch (e) {
      store.put("numbers", {
        ...(store.get("numbers", owner) || {}),
        id: owner,
        error: (e as Error).message,
        at: now(),
      });
      lastNumbers = Date.now() - 240000;
    }
  }
}
export function startDialerSync() {
  if (isTenantGateway()) return;
  void syncDialer().catch((e) => console.error("[dialer sync]", e.message));
  setInterval(
    () =>
      void syncDialer().catch((e) => console.error("[dialer sync]", e.message)),
    30000,
  ).unref();
}

/** CRM task dates are wall-clock values. Keep their zone when projecting into the shared calendar. */
function localTimeToIso(
  day: string,
  time: string,
  zone: string,
): string | null {
  const desired = Date.parse(day + "T" + time.slice(0, 5) + ":00Z");
  if (!Number.isFinite(desired)) return null;
  let instant = desired;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const p = (k: string) => parts.find((p) => p.type === k)?.value;
    const represented = Date.parse(
      p("year") +
        "-" +
        p("month") +
        "-" +
        p("day") +
        "T" +
        p("hour") +
        ":" +
        p("minute") +
        ":00Z",
    );
    instant += desired - represented;
  }
  return new Date(instant).toISOString();
}
