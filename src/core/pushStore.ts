/**
 * Web Push for the Task Command Center — always-on reminders that reach a
 * phone even when the app is fully closed.
 *
 * - VAPID keypair is auto-generated on first boot and persisted next to the
 *   main DB (so it survives restarts). Override with VAPID_PUBLIC_KEY /
 *   VAPID_PRIVATE_KEY env vars in production if you want a fixed pair.
 * - Browser push subscriptions are stored per "person" (marco/wesley/…).
 * - A scheduler tick scans command tasks with a due time and delivers the
 *   selected early reminders (e.g. 10/5 min) plus one at the due moment,
 *   deduped via a persisted ledger.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import webpush from "web-push";
import { getCommandTasks } from "./db.js";
import type { CommandTask } from "./types.js";

interface PushKeys {
  p256dh: string;
  auth: string;
}
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: PushKeys;
  /** Which teammate this device is logged in as (marco/wesley/kendrick/carlos/everyone). */
  person: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedPush {
  vapid?: { publicKey: string; privateKey: string };
  subscriptions: PushSubscriptionRecord[];
  /** Reminder keys already delivered — `${taskId}|${dueEpoch}|${offset}`. */
  sent: string[];
}

// Paired visibility — mirror of the board's TASK_GROUPS. A subscriber logged in
// as P is notified for tasks assigned to anyone in GROUPS[P].
const GROUPS: Record<string, string[]> = {
  marco: ["marco", "carlos"],
  carlos: ["marco", "carlos"],
  wesley: ["wesley", "kendrick"],
  kendrick: ["wesley", "kendrick"],
};

function resolvePushPath(): string {
  const explicit = process.env.PUSH_JSON_PATH?.trim();
  if (explicit) return explicit;
  const flyDefault = "/data/push.json";
  if (existsSync("/data")) return flyDefault;
  return join(process.cwd(), "data", "push.json");
}

const PUSH_PATH = resolvePushPath();

let state: PersistedPush = { subscriptions: [], sent: [] };
let vapidPublicKey = "";
let vapidPrivateKey = "";
let started = false;

function persist(): void {
  try {
    mkdirSync(dirname(PUSH_PATH), { recursive: true });
    writeFileSync(PUSH_PATH, JSON.stringify(state), "utf8");
  } catch (err) {
    console.error("[push] persist failed:", err);
  }
}

function load(): void {
  try {
    if (!existsSync(PUSH_PATH)) return;
    const raw = readFileSync(PUSH_PATH, "utf8");
    if (!raw.trim()) return;
    const data = JSON.parse(raw) as Partial<PersistedPush>;
    state.subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    state.sent = Array.isArray(data.sent) ? data.sent : [];
    if (data.vapid?.publicKey && data.vapid?.privateKey) {
      state.vapid = data.vapid;
    }
  } catch (err) {
    console.error("[push] load failed:", err);
  }
}

/** Set up VAPID from env → persisted file → freshly generated (in that order). */
function ensureVapid(): void {
  const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPub && envPriv) {
    vapidPublicKey = envPub;
    vapidPrivateKey = envPriv;
  } else if (state.vapid?.publicKey && state.vapid?.privateKey) {
    vapidPublicKey = state.vapid.publicKey;
    vapidPrivateKey = state.vapid.privateKey;
  } else {
    const keys = webpush.generateVAPIDKeys();
    vapidPublicKey = keys.publicKey;
    vapidPrivateKey = keys.privateKey;
    state.vapid = { publicKey: vapidPublicKey, privateKey: vapidPrivateKey };
    persist();
    console.log("[push] generated a new VAPID keypair");
  }
  const contact = process.env.VAPID_CONTACT?.trim() || "mailto:notifications@marcopuga.local";
  webpush.setVapidDetails(contact, vapidPublicKey, vapidPrivateKey);
}

export function getVapidPublicKey(): string {
  if (!vapidPublicKey) initPush();
  return vapidPublicKey;
}

export function addSubscription(
  sub: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } },
  person: string,
): boolean {
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
  const p256dh = typeof sub.keys?.p256dh === "string" ? sub.keys.p256dh : "";
  const auth = typeof sub.keys?.auth === "string" ? sub.keys.auth : "";
  if (!endpoint || !p256dh || !auth) return false;
  const now = new Date().toISOString();
  const existing = state.subscriptions.find((s) => s.endpoint === endpoint);
  if (existing) {
    existing.keys = { p256dh, auth };
    existing.person = person || existing.person || "everyone";
    existing.updatedAt = now;
  } else {
    state.subscriptions.push({
      endpoint,
      keys: { p256dh, auth },
      person: person || "everyone",
      createdAt: now,
      updatedAt: now,
    });
  }
  persist();
  return true;
}

export function removeSubscription(endpoint: string): boolean {
  const before = state.subscriptions.length;
  state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
  if (state.subscriptions.length !== before) {
    persist();
    return true;
  }
  return false;
}

/** Persons who should be notified for a task assigned to `assignedTo`. */
function viewersFor(assignedTo: string | undefined): Set<string> {
  const who = new Set<string>(["everyone"]);
  const a = (assignedTo || "").toLowerCase();
  for (const [person, members] of Object.entries(GROUPS)) {
    if (members.includes(a)) who.add(person);
  }
  if (a) who.add(a);
  return who;
}

function taskDueEpoch(task: CommandTask): number | null {
  if (!task.dueDate || !task.dueTime) return null;
  const md = /^(\d{4})-(\d{2})-(\d{2})/.exec(task.dueDate);
  const mt = /^(\d{2}):(\d{2})$/.exec(task.dueTime);
  if (!md || !mt) return null;
  const d = new Date(
    Number(md[1]),
    Number(md[2]) - 1,
    Number(md[3]),
    Number(mt[1]),
    Number(mt[2]),
    0,
    0,
  );
  return isNaN(d.getTime()) ? null : d.getTime();
}

function time12(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return "";
  let h = Number(m[1]);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

async function deliver(record: PushSubscriptionRecord, payload: object): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: record.endpoint, keys: record.keys },
      JSON.stringify(payload),
    );
  } catch (err: unknown) {
    const status = (err as { statusCode?: number })?.statusCode;
    // 404/410 = subscription is dead; drop it so we stop trying.
    if (status === 404 || status === 410) {
      removeSubscription(record.endpoint);
      console.log("[push] pruned expired subscription");
    } else {
      console.error("[push] send failed:", status || err);
    }
  }
}

let ledger = new Set<string>();

function markSent(key: string): void {
  ledger.add(key);
  // Cap the persisted ledger so it can't grow without bound.
  state.sent = Array.from(ledger).slice(-1000);
  persist();
}

/** One scheduler pass: fire any reminders whose moment has arrived. */
export async function runReminderTick(now = Date.now()): Promise<void> {
  if (!state.subscriptions.length) return;
  const WINDOW = 95 * 1000; // tolerate the tick interval + jitter
  const tasks = getCommandTasks();

  for (const t of tasks) {
    if (!t || t.status === "done" || t.status === "on_hold") continue;
    const dueEpoch = taskDueEpoch(t);
    if (dueEpoch == null) continue;

    const offsets = Array.isArray(t.reminderMinutes) ? t.reminderMinutes.slice() : [];
    if (!offsets.includes(0)) offsets.push(0);

    const viewers = viewersFor(t.assignedTo);
    const targets = state.subscriptions.filter((s) => viewers.has(s.person));
    if (!targets.length) continue;

    for (const off of offsets) {
      const target = dueEpoch - off * 60000;
      const key = `${t.id}|${dueEpoch}|${off}`;
      if (ledger.has(key)) continue;
      if (now >= target && now < target + WINDOW) {
        const timeLabel = time12(t.dueTime || "");
        const payload = {
          title: off === 0 ? "⏰ Task due now" : `⏰ Task due in ${off} min`,
          body: t.title + (timeLabel ? ` — due ${timeLabel}` : ""),
          taskId: t.id,
          url: "/tasks",
        };
        await Promise.all(targets.map((s) => deliver(s, payload)));
        markSent(key);
      } else if (now >= target + WINDOW) {
        // Missed while everything was offline — mark handled so it won't pop late.
        markSent(key);
      }
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function initPush(): void {
  if (started) return;
  started = true;
  load();
  ledger = new Set(state.sent);
  ensureVapid();
  // Scan every 30s. Reminders are minute-granular so this is plenty precise.
  timer = setInterval(() => {
    runReminderTick().catch((err) => console.error("[push] tick error:", err));
  }, 30 * 1000);
  if (timer.unref) timer.unref();
  console.log(
    `[push] initialized — ${state.subscriptions.length} subscription(s), scheduler every 30s`,
  );
}
