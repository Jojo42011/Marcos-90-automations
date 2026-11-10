import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { dataPath } from "../core/tenantData.js";
import { parseCsv } from "../core/transactionImport.js";
import { isCallable, matchesQueue, parseQueueId } from "./queues.js";
export type Contact = {
  id: string;
  ownerId: string;
  crmId: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  source: string;
  assignedTo: string;
  intent: string;
  dnc: boolean;
  archived?: boolean;
  crmLinked?: boolean;
  latitude?: number;
  longitude?: number;
  /** Mirrored from CRM so smart queues can filter without a live CRM read. */
  tags?: string[];
  crmStatus?: string;
  crmCallQueue?: string;
  createdAt: string;
  updatedAt: string;
};
export type Session = {
  id: string;
  actorId: string;
  actorName: string;
  listId: string;
  /** Smart queue id when the session was started from Due today / Mojo / etc. */
  queueId?: string;
  lineId: string;
  queue: string[];
  position: number;
  status: "active" | "paused" | "ended";
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  activeSeconds: number;
  activeSince: string | null;
  currentCall?: string;
};
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export const phoneKey = (v: unknown) =>
  String(v || "")
    .replace(/\D/g, "")
    .replace(/^1(?=\d{10}$)/, "");
export const fail = (message: string, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
export const text = (v: unknown, max = 200) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
export class DialerStore {
  db: Database.Database;
  constructor(
    file = process.env.SHARED_DIALER_DB_PATH ||
      join(
        dirname(process.env.SHARED_TASK_DB_PATH || dataPath("shared-tasks.db")),
        "shared-dialer.db",
      ),
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("busy_timeout = 10000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS membership(list_id TEXT NOT NULL,contact_id TEXT NOT NULL,PRIMARY KEY(list_id,contact_id)); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,owner TEXT NOT NULL,body TEXT NOT NULL,done INTEGER DEFAULT 0,error TEXT); CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);`,
    );
  }
  all<T = any>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT body FROM records WHERE kind=?")
        .all(kind) as any[]
    ).map((r) => JSON.parse(r.body));
  }
  get<T = any>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT body FROM records WHERE kind=? AND id=?")
      .get(kind, id) as any;
    return r ? JSON.parse(r.body) : undefined;
  }
  put(kind: string, r: any) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, r.id, JSON.stringify(r));
    return r;
  }
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  audit(actor: string, action: string, body: any) {
    this.db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?)")
      .run(uid(), actor, action, now(), JSON.stringify(body));
  }
  queue(owner: string, event: any) {
    this.db
      .prepare("INSERT OR IGNORE INTO outbox(id,owner,body) VALUES(?,?,?)")
      .run(event.id, owner, JSON.stringify(event));
  }
  members(id: string): string[] {
    return (
      this.db
        .prepare("SELECT contact_id FROM membership WHERE list_id=?")
        .all(id) as any[]
    ).map((r) => r.contact_id);
  }
  addMembers(id: string, ids: string[]) {
    if (!this.get("list", id)) fail("Calling list not found", 404);
    for (const cid of ids) {
      if (!this.get("contact", cid)) fail("Contact not found", 404);
      this.db
        .prepare("INSERT OR IGNORE INTO membership VALUES(?,?)")
        .run(id, cid);
    }
  }
  contacts() {
    return this.all<Contact>("contact").filter((c) => !c.archived);
  }
  import(
    csv: string,
    actor: string,
    source: string,
    listId: string,
    apply: boolean,
  ) {
    const rows = parseCsv(csv);
    if (rows.length < 2)
      fail("The CSV needs a header and at least one contact.");
    if (rows.length > 10001) fail("Import up to 10,000 rows at a time.");
    const headers = rows[0].map((h) => h.toLowerCase().trim());
    const field = (r: string[], keys: string[]) => {
      const i = headers.findIndex((h) => keys.includes(h));
      return i < 0 ? "" : text(r[i], 1000);
    };
    return this.tx(() => {
      if (listId && !this.get("list", listId))
        fail("Calling list not found", 404);
      const existing = this.contacts();
      const phones = new Set(
        existing.map((c) => phoneKey(c.phone)).filter(Boolean),
      );
      const emails = new Set(
        existing.map((c) => c.email.toLowerCase()).filter(Boolean),
      );
      const preview: any[] = [];
      let created = 0,
        duplicates = 0,
        invalid = 0;
      const ids: string[] = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r.some((v) => v.trim())) continue;
        const phone = field(r, [
            "phone",
            "phone number",
            "phone 1",
            "mobile",
            "cell",
            "primary phone",
          ]),
          pk = phoneKey(phone),
          email = field(r, ["email", "email address"]).toLowerCase();
        const name =
          field(r, ["name", "full name", "contact name", "owner name"]) ||
          [field(r, ["first name"]), field(r, ["last name"])]
            .filter(Boolean)
            .join(" ");
        const action =
          !name ||
          (!pk && !email) ||
          (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
          (pk && !(pk.length >= 10 && pk.length <= 15))
            ? "invalid"
            : (pk && phones.has(pk)) || (email && emails.has(email))
              ? "duplicate"
              : "create";
        preview.push({ row: i + 1, name, phone, email, action });
        if (action === "invalid") {
          invalid++;
          continue;
        }
        if (action === "duplicate") {
          duplicates++;
          continue;
        }
        if (pk) phones.add(pk);
        if (email) emails.add(email);
        created++;
        if (apply) {
          const id = uid(),
            lat = Number(field(r, ["latitude", "lat"])),
            lon = Number(field(r, ["longitude", "lng", "lon"]));
          const c: Contact = {
            id,
            ownerId: actor,
            crmId: "dialer_" + id,
            name,
            phone,
            email,
            address: field(r, [
              "address",
              "property address",
              "street address",
            ]),
            city: field(r, ["city", "property city"]),
            source: source || "CSV import",
            assignedTo: actor,
            intent: "seller",
            dnc: /^(true|yes|1)$/i.test(field(r, ["dnc", "do not call"])),
            createdAt: now(),
            updatedAt: now(),
          };
          if (
            field(r, ["latitude", "lat"]) &&
            field(r, ["longitude", "lng", "lon"]) &&
            Math.abs(lat) <= 90 &&
            Math.abs(lon) <= 180
          ) {
            c.latitude = lat;
            c.longitude = lon;
          }
          this.put("contact", c);
          ids.push(id);
        }
      }
      if (apply) {
        if (listId) this.addMembers(listId, ids);
        this.audit(actor, "import", { created, duplicates, invalid, source });
      }
      return {
        created,
        duplicates,
        invalid,
        total: preview.length,
        sample: preview.slice(0, 10),
        applied: apply,
      };
    });
  }
  createList(actor: string, name: string, kind: string) {
    if (!name) fail("Name your list.");
    return this.tx(() => {
      const r = {
        id: uid(),
        name,
        kind: kind === "group" ? "group" : "list",
        createdBy: actor,
        createdAt: now(),
      };
      this.put("list", r);
      this.audit(actor, "list_created", r);
      return r;
    });
  }
  start(
    actorId: string,
    actorName: string,
    listId: string,
    lineId: string,
    ids?: string[],
    queueId?: string,
  ) {
    return this.tx(() => {
      if (
        this.all<Session>("session").some(
          (s) => s.actorId === actorId && s.status !== "ended",
        )
      )
        fail("End your existing session before starting another.", 409);
      const smartQueue = parseQueueId(queueId);
      if (queueId && !smartQueue) fail("Choose a valid calling queue.");
      const members = listId ? new Set(this.members(listId)) : null;
      if (listId && !this.get("list", listId)) fail("List not found", 404);
      const chosen = ids ? new Set(ids) : null;
      const queue = this.contacts()
        .filter(
          (c) =>
            isCallable(c) &&
            (!smartQueue || matchesQueue(c, smartQueue)) &&
            (!members || members.has(c.id)) &&
            (!chosen || chosen.has(c.id)),
        )
        .map((c) => c.id);
      if (!queue.length)
        fail(
          smartQueue
            ? "No callable contacts match this queue."
            : "No callable contacts match this list.",
        );
      const s: Session = {
        id: uid(),
        actorId,
        actorName,
        listId: listId || "",
        queueId: smartQueue || undefined,
        lineId,
        queue,
        position: 0,
        status: "active",
        startedAt: now(),
        updatedAt: now(),
        activeSeconds: 0,
        activeSince: now(),
      };
      this.put("session", s);
      this.audit(actorId, "session_started", {
        sessionId: s.id,
        total: queue.length,
        queueId: smartQueue || undefined,
        listId: listId || undefined,
      });
      return s;
    });
  }
  createContact(
    actorId: string,
    input: {
      name: string;
      phone: string;
      email?: string;
      source?: string;
      intent?: string;
      tags?: string[];
      crmCallQueue?: string;
      crmStatus?: string;
      crmId?: string;
      address?: string;
      city?: string;
    },
  ) {
    return this.tx(() => {
      const name = text(input.name, 120);
      const phone = text(input.phone, 40);
      const pk = phoneKey(phone);
      if (!name) fail("Name your contact.");
      if (!(pk.length >= 10 && pk.length <= 15))
        fail("Enter a valid phone number.");
      if (
        this.contacts().some(
          (c) => c.ownerId === actorId && phoneKey(c.phone) === pk,
        )
      )
        fail("That phone number is already in your dialer.", 409);
      const id = uid();
      const tags = Array.isArray(input.tags)
        ? input.tags.map((t) => text(t, 40)).filter(Boolean).slice(0, 20)
        : [];
      const c: Contact = {
        id,
        ownerId: actorId,
        crmId: text(input.crmId, 80) || "dialer_" + id,
        name,
        phone,
        email: text(input.email, 120).toLowerCase(),
        address: text(input.address, 200),
        city: text(input.city, 80),
        source: text(input.source, 80) || "Manual",
        assignedTo: actorId,
        intent: text(input.intent, 40) || "seller",
        dnc: false,
        crmLinked: !!input.crmId,
        tags,
        crmStatus: text(input.crmStatus, 40) || "new",
        crmCallQueue: text(input.crmCallQueue, 40) || "urgent",
        createdAt: now(),
        updatedAt: now(),
      };
      this.put("contact", c);
      this.audit(actorId, "contact_created", { contactId: c.id, crmId: c.crmId });
      return c;
    });
  }
  session(id: string, actor: string) {
    const s = this.get<Session>("session", id);
    if (!s) fail("Session not found", 404);
    if (s.actorId !== actor)
      fail("Only the session owner can control it.", 403);
    return s;
  }
  sessionAction(id: string, actor: string, action: string) {
    return this.tx(() => {
      const s = this.session(id, actor);
      if (s.status === "ended") fail("This session has ended.", 409);
      if (s.currentCall)
        fail("Save a call outcome before changing the session.", 409);
      if (!["pause", "resume", "end", "skip"].includes(action))
        fail("Unknown session action.");
      if (s.activeSince)
        s.activeSeconds += Math.max(
          0,
          Math.round((Date.now() - Date.parse(s.activeSince)) / 1000),
        );
      s.activeSince = null;
      if (action === "resume") {
        s.status = "active";
        s.activeSince = now();
      }
      if (action === "pause") s.status = "paused";
      if (action === "end") {
        s.status = "ended";
        s.endedAt = now();
      }
      if (action === "skip") {
        s.position++;
        if (s.status === "active") s.activeSince = now();
      }
      s.updatedAt = now();
      this.put("session", s);
      return s;
    });
  }
  beginCall(id: string, actor: string) {
    return this.tx(() => {
      const s = this.session(id, actor);
      if (s.status !== "active")
        fail("Resume the session before calling.", 409);
      if (s.currentCall) return this.get("call", s.currentCall);
      const c = this.get<Contact>("contact", s.queue[s.position]);
      if (!c) fail("The queue is complete. End this session.");
      if (c.dnc || c.archived || phoneKey(c.phone).length < 10)
        fail("This contact is not callable. Skip to the next contact.", 409);
      if(this.contacts().some(x=>x.dnc&&phoneKey(x.phone)===phoneKey(c.phone)))fail("This phone number is marked do not call.",409);
      if (this.all("call").some((x) => (x.contactId === c.id || phoneKey(x.phone)===phoneKey(c.phone)) && !x.endedAt))
        fail("Another team member is already working this contact.", 409);
      const call = {
        id: uid(),
        sessionId: id,
        actorId: actor,
        contactId: c.id,
        lineId: s.lineId,
        startedAt: now(),
        outcome: null,
        phone: c.phone,
      };
      this.put("call", call);
      s.currentCall = call.id;
      s.updatedAt = now();
      this.put("session", s);
      return call;
    });
  }
  finishCall(id: string, actor: string, outcome: string, notes: string) {
    return this.tx(() => {
      const call = this.get("call", id);
      if (!call) fail("Call not found", 404);
      const s = this.session(call.sessionId, actor);
      if (call.endedAt) return call;
      if (
        ![
          "talked",
          "no_answer",
          "voicemail",
          "wrong_number",
          "do_not_call",
          "appointment_set",
          "interrupted",
        ].includes(outcome)
      )
        fail("Choose a call outcome.");
      if (s.currentCall !== id) fail("This call is no longer current.", 409);
      const c = this.get<Contact>("contact", call.contactId)!;
      call.outcome = outcome;
      call.notes = notes;
      call.endedAt = now();
      call.elapsedSeconds = Math.max(
        0,
        Math.round((Date.now() - Date.parse(call.startedAt)) / 1000),
      );
      this.put("call", call);
      if (outcome === "do_not_call") {
        c.dnc = true;
        c.updatedAt = now();
        this.put("contact", c);
      }
      delete s.currentCall;
      s.position++;
      s.updatedAt = now();
      this.put("session", s);
      this.queue(c.ownerId, {
        id: "call:" + id,
        type: "call",
        contactId: c.id,
        outcome,
        notes,
        at: call.endedAt,
        actorId: actor,
        elapsedSeconds: call.elapsedSeconds,
      });
      this.audit(actor, "call_logged", {
        callId: id,
        contactId: c.id,
        outcome,
      });
      return call;
    });
  }
  appointment(actor: string, b: any, existingId?: string) {
    return this.tx(() => {
      const old = existingId ? this.get("appointment", existingId) : null;
      if (existingId && !old) fail("Appointment not found", 404);
      if (old && b.contactId && b.contactId !== old.contactId)
        fail("An existing appointment cannot be moved to a different contact.");
      const c = this.get<Contact>(
        "contact",
        text(b.contactId || old?.contactId),
      );
      if (!c || c.archived) fail("Select a contact.");
      const startAt = text(b.startAt || old?.startAt),
        endAt = text(b.endAt || old?.endAt),
        start = Date.parse(startAt),
        end = Date.parse(endAt),
        timeZone = text(b.timeZone || old?.timeZone || "America/Chicago");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
      } catch {
        fail("Invalid timezone.");
      }
      if (
        !/(Z|[+-]\d{2}:\d{2})$/.test(startAt) ||
        !/(Z|[+-]\d{2}:\d{2})$/.test(endAt) ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > 86400000
      )
        fail("Choose a valid start and end time (up to 24 hours).");
      const status = text(b.status || old?.status || "scheduled");
      if (!["scheduled", "completed", "cancelled"].includes(status))
        fail("Invalid appointment status.");
      const assignedTo = text(b.assignedTo || old?.assignedTo || actor);
      if (
        status === "scheduled" &&
        this.all("appointment").some(
          (a) =>
            a.id !== existingId &&
            a.status === "scheduled" &&
            a.assignedTo === assignedTo &&
            Date.parse(a.startAt) < end &&
            Date.parse(a.endAt) > start,
        )
      )
        fail("This agent already has an appointment during that time.", 409);
      const a = {
        ...old,
        id: existingId || uid(),
        contactId: c.id,
        ownerId: c.ownerId,
        title: text(b.title || old?.title || "Property appointment"),
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        timeZone,
        assignedTo,
        location: text(b.location ?? old?.location, 500),
        notes: text(b.notes ?? old?.notes, 2000),
        kind: text(b.kind || old?.kind || "appointment"),
        status,
        createdBy: old?.createdBy || actor,
        createdAt: old?.createdAt || now(),
        updatedAt: now(),
      };
      this.put("appointment", a);
      this.queue(c.ownerId, {
        id: "appointment:" + a.id + ":" + uid(),
        type: "appointment",
        appointmentId: a.id,
        contactId: c.id,
        actorId: actor,
      });
      this.audit(actor, "appointment_saved", {
        appointmentId: a.id,
        contactId: c.id,
      });
      return a;
    });
  }
}
let singleton: DialerStore;
export const dialerStore = () => singleton || (singleton = new DialerStore());
