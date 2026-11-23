import { Contact, phoneKey } from "./store.js";
import { followUpBucket } from "./followUpDue.js";

/** Same display mapping the CRM Dialer used for New / Nurture queues. */
const STATUS_DISP: Record<string, string> = {
  new: "new",
  hot: "hot",
  nurture: "nurture",
  watch: "watch",
  dead: "unqualified",
  unresponsive: "unqualified",
  not_contacted: "new",
  contacted: "nurture",
};

export type QueueId = "due" | "overdue" | "mojo" | "new" | "nurture" | "everyone";

export const QUEUE_DEFS: {
  id: QueueId;
  label: string;
  description: string;
}[] = [
  {
    id: "due",
    label: "Due today",
    description: "Open CRM call/follow-up due today (Central), or flagged urgent when not overdue. Manual one-line dial.",
  },
  {
    id: "overdue",
    label: "Overdue",
    description: "Open CRM call/follow-up past due (Central). Manual one-line dial.",
  },
  {
    id: "mojo",
    label: "Mojo expired",
    description: "Mojo / Mojo FL contacts tagged Expired or Canceled.",
  },
  {
    id: "new",
    label: "New leads",
    description: "CRM status maps to New.",
  },
  {
    id: "nurture",
    label: "Nurture",
    description: "CRM status maps to Nurture.",
  },
  {
    id: "everyone",
    label: "Everyone",
    description: "All callable contacts with a phone number.",
  },
];

export function statusDisp(crmStatus?: string | null): string {
  const key = String(crmStatus || "")
    .trim()
    .toLowerCase();
  return STATUS_DISP[key] || "nurture";
}

export function isMojoExpired(c: Pick<Contact, "source" | "tags">): boolean {
  const src = String(c.source || "").toLowerCase();
  const isMojo =
    /\bmojo\b/.test(src) ||
    src === "mojo" ||
    src.indexOf("mojo ") === 0 ||
    /mojo\s*fl/.test(src);
  const tags = (c.tags || []).map((t) => String(t).toLowerCase().trim());
  const expiredTag = tags.some(
    (t) =>
      t === "expired" ||
      t === "canceled" ||
      t === "cancelled" ||
      t.indexOf("expired") >= 0 ||
      /cancel+ed/.test(t),
  );
  const expiredSource = /expir|cancel/.test(src);
  return isMojo && (expiredTag || expiredSource || /\bexpired listing\b/.test(src));
}

export function isCallable(c: Contact): boolean {
  return !c.dnc && !c.archived && phoneKey(c.phone).length >= 10;
}

/**
 * Cold prospecting queues only. Booked Appointments-group contacts stay out of
 * these. Due today / Overdue remain available when an open qualifying follow-up
 * exists; Everyone stays callable (DNC/archive still apply).
 */
const PROSPECTING_QUEUES = new Set<QueueId>(["mojo", "new", "nurture"]);

export function isProspectingQueue(queueId: string): boolean {
  return PROSPECTING_QUEUES.has(queueId as QueueId);
}

/**
 * @param bookedIds contact ids in the team Appointments group (left prospecting).
 */
export function matchesQueue(
  c: Contact,
  queueId: string,
  bookedIds: ReadonlySet<string> = new Set(),
): boolean {
  if (!QUEUE_DEFS.some((q) => q.id === queueId)) return false;
  if (queueId === "everyone") return isCallable(c) || (!!phoneKey(c.phone) && !c.archived);
  if (isProspectingQueue(queueId) && bookedIds.has(c.id)) return false;
  if (!phoneKey(c.phone)) return false;
  if (queueId === "due") return followUpBucket(c) === "due";
  if (queueId === "overdue") return followUpBucket(c) === "overdue";
  if (queueId === "mojo") return isMojoExpired(c);
  if (queueId === "new") return statusDisp(c.crmStatus) === "new";
  if (queueId === "nurture") return statusDisp(c.crmStatus) === "nurture";
  return false;
}

export function parseQueueId(raw: unknown): QueueId | "" {
  const id = String(raw || "").trim();
  return QUEUE_DEFS.some((q) => q.id === id) ? (id as QueueId) : "";
}

export function queueContacts(
  contacts: Contact[],
  queueId: string,
  bookedIds: ReadonlySet<string> = new Set(),
): Contact[] {
  return contacts.filter((c) => matchesQueue(c, queueId, bookedIds));
}

export function queueSummaries(
  contacts: Contact[],
  bookedIds: ReadonlySet<string> = new Set(),
) {
  return QUEUE_DEFS.map((q) => ({
    ...q,
    count: queueContacts(contacts, q.id, bookedIds).filter(isCallable).length,
  }));
}
