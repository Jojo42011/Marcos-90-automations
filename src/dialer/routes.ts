import express, { Express, Request } from "express";
import {
  dialerStore,
  fail,
  text,
  uid,
  now,
  phoneKey,
  Contact,
  Session,
} from "./store.js";
import { syncDialer } from "./sync.js";
import {
  parseQueueId,
  queueContacts,
  queueSummaries,
} from "./queues.js";
import { getUsers, getDialerTeam, updateUser } from "../core/users.js";
import { tenantOwner } from "../core/tenantData.js";
import type { CRMUser } from "../core/types.js";
import {
  searchListings,
  listingCounts,
  lastSuccessfulSync,
} from "../core/listingsStore.js";
import { upsertLeadQuiet } from "../core/db.js";
import { FunnelStage } from "../core/state.js";
import {
  createTrackerRecord,
  getTrackerRecordByLead,
} from "../core/trackerStore.js";
export function registerDialer(
  app: Express,
  auth: (r: Request) => boolean,
  user: (r: Request) => CRMUser | null,
) {
  const register = (
    method: string,
    path: string,
    fn: (req: Request, actor: CRMUser) => any,
  ) =>
    app[method](
      "/api/dialer" + path,
      express.json({ limit: "8mb" }),
      async (req, res) => {
        try {
          if (!auth(req))
            return res
              .status(401)
              .json({ error: "Sign in to use the dialer." });
          const actor =
            user(req) || getUsers().find((u) => u.id === tenantOwner());
          if (!actor?.active)
            return res
              .status(403)
              .json({ error: "An active team identity is required." });
          res.json(await fn(req, actor));
        } catch (e) {
          const err = e as Error & {
            status?: number;
            contactId?: string;
            crmId?: string;
          };
          res.status(Number(err.status) || 500).json({
            error: err.message,
            ...(err.contactId ? { contactId: err.contactId } : {}),
            ...(err.crmId ? { crmId: err.crmId } : {}),
          });
        }
      },
    );
  const roster = () => getDialerTeam().map((u) => ({ id: u.id, name: u.name }));
  const assignee = (id: string) => {
    if (!roster().some((u) => u.id === id))
      fail("Choose an active team member.");
    return id;
  };
  register("get", "/overview", async (req, actor) => {
    await syncDialer();
    const s = dialerStore(),
      contacts = s.contacts(),
      sessions = s.all<Session>("session"),
      calls = s.all("call"),
      pending = s.db
        .prepare("SELECT COUNT(*) AS count FROM outbox WHERE done=0")
        .get() as any;
    return {
      actor: { id: actor.id, name: actor.name },
      members: roster(),
      lists: s
        .all("list")
        .map((l) => ({ ...l, count: s.members(l.id).length })),
      sessionCounts: Object.fromEntries(
        sessions.map((s) => [
          s.id,
          {
            attempts: calls.filter((c) => c.sessionId === s.id).length,
            reached: calls.filter(
              (c) =>
                c.sessionId === s.id &&
                ["talked", "appointment_set"].includes(c.outcome),
            ).length,
          },
        ]),
      ),
      recentCalls: calls.filter(
        (c) => Date.parse(c.startedAt) > Date.now() - 8 * 86400000,
      ),
      sessions: sessions
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .filter((s,i)=>s.status!=="ended"||i<100),
      calls: calls
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 500),
      appointments: s
        .all("appointment")
        .sort((a, b) => a.startAt.localeCompare(b.startAt)),
      totals: {
        contacts: contacts.length,
        callable: contacts.filter((c) => c.phone && !c.dnc).length,
        calls: calls.length,
        connected: calls.filter((c) =>
          ["talked", "appointment_set"].includes(c.outcome),
        ).length,
      },
      sync: s.all("sync"),
      pendingSync: pending.count,
      queues: queueSummaries(contacts),
      capabilities: {
        callMode: "external_phone",
        automaticDialing: false,
        numberPurchase: false,
        calendar: "CRM appointments",
        leadData: "Connected MLS, CRM smart queues, and imported files",
      },
      help: "GET /api/dialer/guide for operation schemas and provider limits.",
    };
  });
  register("get", "/guide", () => ({
    navigation: { tab: "dialer", url: "/dialer" },
    scope:
      "Shared authenticated team prospecting. CRM ownership and private chats remain separate.",
    operations: {
      contacts:
        "GET /contacts?q=&listId=&assignedTo=&duplicates=true&page=1; GET /contacts/:id includes shared notes and calls",
      import:
        "POST /import {csv,source,listId,apply:false} preview, then apply:true",
      lists:
        "POST /lists {name,kind:list|group}; POST /lists/:id/members {contactIds,remove?:true}",
      assign:
        "PATCH /contacts/:id {assignedTo,dnc}; POST /assign {contactIds,assignedTo}",
      notes: "POST /contacts/:id/notes {text}",
      session:
        "POST /sessions {listId?,queueId?,lineId?,contactIds?}; POST /sessions/:id/action {action:pause|resume|skip|end}; POST /sessions/:id/calls starts a manual attempt; POST /calls/:id/outcome {outcome:talked|no_answer|voicemail|wrong_number|do_not_call|appointment_set|interrupted,notes}",
      queues:
        "GET /queues returns Due today, Mojo expired, New, Nurture, Everyone with callable counts; GET /contacts?queue=due|mojo|new|nurture|everyone filters the same smart queues formerly in the CRM Dialer",
      contactsCreate:
        "POST /contacts {name,phone,source?,intent?,tags?,trackSide?:seller|buyer|both} creates a Dialer contact, quiet CRM lead, optional Tracker row",
      appointments:
        "POST /appointments {contactId,title,startAt,endAt,timeZone,assignedTo,location,notes,kind:appointment|follow_up}; PATCH /appointments/:id same fields or status:scheduled|completed|cancelled",
      numbers:
        "GET /numbers; POST /numbers/default {lineId} sets your CRM default; buying numbers stays in Quo",
      discovery:
        "GET /discovery?q=&city=&status=Expired uses connected MLS only; no homeowner phones are inferred",
      export: "GET /export?listId= returns CSV text",
    },
    limits:
      "Quo has no documented call initiation or number purchase endpoint. Never claim a call connected from opening a phone link. No external calendar invitations are sent. Dates must include timezone offset. All mutations use the signed-in actor.",
  }));
  register("get", "/queues", async () => {
    await syncDialer();
    return { queues: queueSummaries(dialerStore().contacts()) };
  });
  register("get", "/contacts", (req) => {
    const s = dialerStore();
    let rows = s.contacts();
    const q = text(req.query.q).toLowerCase(),
      listId = text(req.query.listId),
      assigned = text(req.query.assignedTo),
      queueId = parseQueueId(req.query.queue);
    if (req.query.queue && !queueId) fail("Choose a valid calling queue.");
    if (queueId) rows = queueContacts(rows, queueId);
    if (listId) {
      const ids = new Set(s.members(listId));
      rows = rows.filter((c) => ids.has(c.id));
    }
    if (q)
      rows = rows.filter((c) =>
        [c.name, c.phone, c.email, c.address, c.city, c.source]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    if (assigned) rows = rows.filter((c) => c.assignedTo === assigned);
    if (req.query.duplicates === "true") {
      const count = new Map<string, number>();
      for (const c of s.contacts()) {
        for (const k of [
          phoneKey(c.phone) && "p:" + phoneKey(c.phone),
          c.email && "e:" + c.email.toLowerCase(),
        ].filter(Boolean))
          count.set(k, (count.get(k) || 0) + 1);
      }
      rows = rows.filter(
        (c) =>
          (count.get("p:" + phoneKey(c.phone)) || 0) > 1 ||
          (count.get("e:" + c.email.toLowerCase()) || 0) > 1,
      );
    }
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1)),
      limit = 100;
    return {
      contacts: rows.slice((page - 1) * limit, page * limit),
      total: rows.length,
      page,
      limit,
    };
  });
  register("get", "/contacts/:id", (req) => {
    const s = dialerStore(),
      contact = s.get("contact", String(req.params.id));
    if (!contact) fail("Contact not found", 404);
    return {
      contact,
      notes: s.all("note").filter((n) => n.contactId === contact.id),
      calls: s
        .all("call")
        .filter((c) => c.contactId === contact.id)
        .slice(-50),
      appointments: s
        .all("appointment")
        .filter((a) => a.contactId === contact.id),
    };
  });
  register("post", "/import", (req, a) =>
    dialerStore().import(
      text(req.body.csv, 8000000),
      a.id,
      text(req.body.source) || "CSV import",
      text(req.body.listId),
      req.body.apply === true,
    ),
  );
  register("post", "/contacts", async (req, a) => {
    const name = text(req.body.name, 120);
    const phone = text(req.body.phone, 40);
    const source = text(req.body.source, 80) || "Manual";
    const intentRaw = text(req.body.intent || req.body.crmIntent, 40);
    const intent =
      intentRaw === "buyer" || intentRaw === "buyer_seller"
        ? intentRaw
        : "seller";
    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map((t: unknown) => text(t, 40)).filter(Boolean)
      : [];
    if (req.body.expired === true && !tags.some((t) => /expired/i.test(t)))
      tags.push("Expired");
    const existing = dialerStore()
      .contacts()
      .find((c) => c.ownerId === a.id && phoneKey(c.phone) === phoneKey(phone));
    if (existing) {
      const err: any = new Error("That phone number is already in your dialer.");
      err.status = 409;
      err.contactId = existing.id;
      err.crmId = existing.crmId;
      throw err;
    }
    const leadPhone = phoneKey(phone);
    const lead = upsertLeadQuiet({
      platform: "dialer",
      userId: "dialer:" + leadPhone,
      username: null,
      name,
      phone,
      email: text(req.body.email, 120) || null,
      state: FunnelStage.New,
      source,
      adCampaign: null,
      propertyInquired: null,
      address: text(req.body.address, 200) || null,
      criteria: null,
      brivityId: null,
      crmStatus: "new",
      crmStage: "new",
      crmPriority: "normal",
      crmIntent: intent === "buyer_seller" ? "buyer_seller" : intent,
      crmCallQueue: "urgent",
      crmNotes: null,
      assignedUserId: a.id,
      assignedUserName: a.name,
      tags,
    });
    const trackSide = text(req.body.trackSide, 20).toLowerCase();
    const sides =
      trackSide === "buyer"
        ? (["buyer"] as const)
        : trackSide === "both" || trackSide === "buyer_seller"
          ? (["buyer", "seller"] as const)
          : req.body.track === false
            ? []
            : (["seller"] as const);
    let tracker = getTrackerRecordByLead(lead.id);
    if (!tracker && sides.length) {
      tracker = createTrackerRecord({
        leadId: lead.id,
        name: lead.name || name,
        phone: lead.phone || phone,
        email: lead.email || undefined,
        source: lead.source || source,
        assignedTo: a.id,
        sides: [...sides],
      });
    }
    const contact = dialerStore().createContact(a.id, {
      name,
      phone,
      email: lead.email || "",
      source,
      intent,
      tags,
      crmCallQueue: "urgent",
      crmStatus: "new",
      crmId: lead.id,
      address: lead.address || "",
    });
    return { contact, leadId: lead.id, trackerId: tracker?.id || null };
  });
  register("post", "/lists", (req, a) => ({
    list: dialerStore().createList(
      a.id,
      text(req.body.name),
      text(req.body.kind),
    ),
  }));
  register("post", "/lists/:id/members", (req, a) => {
    const s = dialerStore(),
      ids = req.body.contactIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000)
      fail("Select 1–1,000 contacts.");
    s.tx(() => {
      if (req.body.remove === true) {
        if (!s.get("list", String(req.params.id))) fail("List not found", 404);
        for (const id of ids)
          s.db
            .prepare("DELETE FROM membership WHERE list_id=? AND contact_id=?")
            .run(req.params.id, id);
      } else s.addMembers(String(req.params.id), ids);
      s.audit(a.id, "list_members_changed", {
        listId: req.params.id,
        count: ids.length,
        removed: req.body.remove === true,
      });
    });
    return { ok: true };
  });
  register("patch", "/contacts/:id", (req, a) => {
    const s = dialerStore();
    return s.tx(() => {
      const c = s.get<Contact>("contact", String(req.params.id));
      if (!c) fail("Contact not found", 404);
      if (req.body.assignedTo) {
        c.assignedTo = assignee(text(req.body.assignedTo));
        s.queue(c.ownerId, {
          id: uid(),
          type: "assignment",
          assignedTo:c.assignedTo,
          contactId: c.id,
          actorId: a.id,
        });
      }
      if (typeof req.body.dnc === "boolean") {
        c.dnc = req.body.dnc;
        s.queue(c.ownerId, {
          id: uid(),
          type: "dnc",
          dnc:c.dnc,
          contactId: c.id,
          actorId: a.id,
        });
      }
      c.updatedAt = now();
      s.put("contact", c);
      s.audit(a.id, "contact_updated", {
        contactId: c.id,
        assignedTo: c.assignedTo,
        dnc: c.dnc,
      });
      return { contact: c };
    });
  });
  register("post", "/assign", (req, a) => {
    const s = dialerStore(),
      ids = req.body.contactIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000)
      fail("Select 1–1,000 contacts.");
    const assignedTo = assignee(text(req.body.assignedTo));
    s.tx(() => {
      for (const id of ids) {
        const c = s.get<Contact>("contact", id);
        if (!c) fail("Contact not found", 404);
        s.put("contact", { ...c, assignedTo, updatedAt: now() });
        s.queue(c.ownerId, {
          id: uid(),
          type: "assignment",
          assignedTo,
          contactId: id,
          actorId: a.id,
        });
      }
      s.audit(a.id, "contacts_assigned", { count: ids.length, assignedTo });
    });
    return { ok: true };
  });
  register("post", "/contacts/:id/notes", (req, a) => {
    const s = dialerStore(),
      c = s.get<Contact>("contact", String(req.params.id)),
      body = text(req.body.text, 4000);
    if (!c || !body) fail("A contact and note are required.");
    return s.tx(() => {
      const n = {
        id: uid(),
        contactId: c.id,
        text: body,
        actorId: a.id,
        actorName: a.name,
        at: now(),
      };
      s.put("note", n);
      s.queue(c.ownerId, {
        id: "note:" + n.id,
        type: "note",
        contactId: c.id,
        actorId: a.id,
        notes: body,
        at: n.at,
      });
      return { note: n };
    });
  });
  register("post", "/sessions", (req, a) => ({
    session: dialerStore().start(
      a.id,
      a.name,
      text(req.body.listId),
      text(req.body.lineId),
      Array.isArray(req.body.contactIds) ? req.body.contactIds : undefined,
      text(req.body.queueId) || undefined,
    ),
  }));
  register("post", "/sessions/:id/action", (req, a) => ({
    session: dialerStore().sessionAction(
      String(req.params.id),
      a.id,
      text(req.body.action),
    ),
  }));
  register("post", "/sessions/:id/calls", (req, a) => ({
    call: dialerStore().beginCall(String(req.params.id), a.id),
  }));
  register("post", "/calls/:id/outcome", (req, a) => ({
    call: dialerStore().finishCall(
      String(req.params.id),
      a.id,
      text(req.body.outcome),
      text(req.body.notes, 4000),
    ),
  }));
  register("post", "/appointments", (req, a) => {
    if (req.body.assignedTo) assignee(text(req.body.assignedTo));
    return { appointment: dialerStore().appointment(a.id, req.body) };
  });
  register("patch", "/appointments/:id", (req, a) => {
    if (req.body.assignedTo) assignee(text(req.body.assignedTo));
    return {
      appointment: dialerStore().appointment(
        a.id,
        req.body,
        String(req.params.id),
      ),
    };
  });
  register("get", "/numbers", (_req,actor) => {
    const sources = dialerStore().all("numbers"),
      numbers = [
        ...new Map(
          sources.flatMap((s) => s.numbers || []).map((n) => [n.id, n]),
        ).values(),
      ];
    return {
      numbers:numbers.map(n=>({...n,selectable:!!sources.find(s=>s.id===actor.id&&!s.error&&Date.now()-Date.parse(s.at)<600000)?.numbers?.some(x=>x.id===n.id)})),
      sources: sources.map((s) => ({
        ownerId: s.id,
        at: s.at,
        error: s.error,
      })),
      assignments: roster().map((u) => ({
        ...u,
        number:
          getDialerTeam().find((x) => x.id === u.id)?.quoPhoneNumber || null,
      })),
      purchaseSupported: false,
      manageUrl: "https://my.quo.com/",
    };
  });
  register("post", "/numbers/default", (req, a) => {
    if (tenantOwner())
      fail(
        "Set your default number through the main Command Center account service.",
        409,
      );
    const numbers = dialerStore()
        .all("numbers")
        .flatMap((s) => s.numbers || []),
      n = numbers.find((n) => n.id === text(req.body.lineId));
    if (!n) fail("Number is not available. Refresh numbers first.");
    updateUser(a.id, { quoPhoneNumberId: n.id, quoPhoneNumber: n.number });
    return { ok: true, number: n };
  });
  register("get", "/discovery", (req) => {
    const result = searchListings({
      q: text(req.query.q),
      city: text(req.query.city),
      status: text(req.query.status),
      limit: 200,
    });
    return {
      ...result,
      coverage: listingCounts(),
      lastSync: lastSuccessfulSync(),
      notice:
        "Connected MLS properties only. Listing agent contact information is not homeowner contact information. Owner phone enrichment is not connected.",
    };
  });
  register("get", "/export", (req) => {
    const s = dialerStore(),
      listId = text(req.query.listId),
      ids = listId ? new Set(s.members(listId)) : null;
    const safe = (x: any) => {
      let v = String(x ?? "");
      if (/^[=+@\-\t\r]/.test(v)) v = "'" + v;
      return '"' + v.replace(/"/g, '""') + '"';
    };
    const rows = s.contacts().filter((c) => !ids || ids.has(c.id));
    return {
      filename: "dialer-contacts.csv",
      csv: [
        ["Name", "Phone", "Email", "Address", "City", "Source", "Do not call"],
        ...rows.map((c) => [
          c.name,
          c.phone,
          c.email,
          c.address,
          c.city,
          c.source,
          c.dnc ? "Yes" : "No",
        ]),
      ]
        .map((r) => r.map(safe).join(","))
        .join("\r\n"),
      count: rows.length,
    };
  });
}
