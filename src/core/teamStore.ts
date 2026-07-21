/**
 * Team collaboration store for the Task Command Center — direct chat,
 * notifications (assignments / due-soon / messages), and lightweight presence.
 * File-backed (same pattern as pushStore): /data/team.json on Fly, ./data
 * locally. Identity model matches the task board: device-picked member ids
 * (marco/wesley/kendrick/carlos).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { getCommandTasks } from "./db.js";

export interface TeamChatMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  at: string;
  readAt?: string;
}

export type TeamNotificationType = "assignment" | "due_soon" | "message";

export interface TeamNotification {
  id: string;
  /** Member id this notification belongs to. */
  user: string;
  type: TeamNotificationType;
  title: string;
  body: string;
  /** Optional deep link within the task page (e.g. task id or chat peer). */
  taskId?: string;
  chatWith?: string;
  from?: string;
  at: string;
  readAt?: string;
}

interface PersistedTeam {
  chats: TeamChatMessage[];
  notifications: TeamNotification[];
  /** Reminder ledger — `${taskId}|${dueEpoch}` entries already notified. */
  dueNotified: string[];
}

function resolvePath(): string {
  const explicit = process.env.TEAM_JSON_PATH?.trim();
  if (explicit) return explicit;
  if (existsSync("/data")) return "/data/team.json";
  return join(process.cwd(), "data", "team.json");
}

const PATH = resolvePath();
const MAX_CHATS = 5000;
const MAX_NOTIFICATIONS = 2000;

let state: PersistedTeam = { chats: [], notifications: [], dueNotified: [] };
const presence = new Map<string, number>(); // member id -> last-seen epoch ms
let loaded = false;

function persist(): void {
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify(state), "utf8");
  } catch (err) {
    console.error("[team] persist failed:", err);
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(PATH)) return;
    const raw = readFileSync(PATH, "utf8");
    if (!raw.trim()) return;
    const data = JSON.parse(raw) as Partial<PersistedTeam>;
    state.chats = Array.isArray(data.chats) ? data.chats : [];
    state.notifications = Array.isArray(data.notifications) ? data.notifications : [];
    state.dueNotified = Array.isArray(data.dueNotified) ? data.dueNotified : [];
  } catch (err) {
    console.error("[team] load failed:", err);
  }
}

const nowIso = () => new Date().toISOString();
const norm = (s: unknown) => String(s || "").toLowerCase().trim();

/* ── Presence ── */
export function touchPresence(user: string): void {
  const u = norm(user);
  if (u) presence.set(u, Date.now());
}
export function getPresence(): Record<string, { lastSeen: string | null; online: boolean }> {
  const out: Record<string, { lastSeen: string | null; online: boolean }> = {};
  for (const m of ["marco", "wesley", "kendrick", "carlos"]) {
    const t = presence.get(m);
    out[m] = { lastSeen: t ? new Date(t).toISOString() : null, online: !!t && Date.now() - t < 70000 };
  }
  return out;
}

/* ── Notifications ── */
export function addNotification(
  n: Omit<TeamNotification, "id" | "at">,
): TeamNotification {
  load();
  const entry: TeamNotification = { ...n, user: norm(n.user), id: randomUUID(), at: nowIso() };
  state.notifications.push(entry);
  if (state.notifications.length > MAX_NOTIFICATIONS) {
    state.notifications = state.notifications.slice(-MAX_NOTIFICATIONS);
  }
  persist();
  return entry;
}

export function getNotifications(user: string, limit = 100): TeamNotification[] {
  load();
  const u = norm(user);
  return state.notifications.filter((n) => n.user === u).slice(-limit).reverse();
}

export function markNotificationsRead(user: string, ids?: string[]): number {
  load();
  const u = norm(user);
  const idSet = ids && ids.length ? new Set(ids) : null;
  let n = 0;
  state.notifications.forEach((x) => {
    if (x.user !== u || x.readAt) return;
    if (idSet && !idSet.has(x.id)) return;
    x.readAt = nowIso();
    n++;
  });
  if (n) persist();
  return n;
}

/* ── Chat ── */
export function addChatMessage(from: string, to: string, text: string): TeamChatMessage {
  load();
  const msg: TeamChatMessage = {
    id: randomUUID(),
    from: norm(from),
    to: norm(to),
    text: String(text || "").slice(0, 4000),
    at: nowIso(),
  };
  state.chats.push(msg);
  if (state.chats.length > MAX_CHATS) state.chats = state.chats.slice(-MAX_CHATS);
  persist();
  addNotification({
    user: msg.to,
    type: "message",
    title: "New message",
    body: msg.text.slice(0, 140),
    from: msg.from,
    chatWith: msg.from,
  });
  return msg;
}

export function getChat(me: string, withUser: string, limit = 200): TeamChatMessage[] {
  load();
  const a = norm(me), b = norm(withUser);
  return state.chats
    .filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a))
    .slice(-limit);
}

/** Mark everything the peer sent me as read; returns count. */
export function markChatRead(me: string, withUser: string): number {
  load();
  const a = norm(me), b = norm(withUser);
  let n = 0;
  state.chats.forEach((m) => {
    if (m.from === b && m.to === a && !m.readAt) { m.readAt = nowIso(); n++; }
  });
  // Message notifications from this peer are implicitly handled too.
  state.notifications.forEach((x) => {
    if (x.user === a && x.type === "message" && x.from === b && !x.readAt) x.readAt = nowIso();
  });
  if (n) persist();
  return n;
}

/** Unread message counts for `user`, keyed by sender. */
export function chatUnreadCounts(user: string): Record<string, number> {
  load();
  const u = norm(user);
  const out: Record<string, number> = {};
  state.chats.forEach((m) => {
    if (m.to === u && !m.readAt) out[m.from] = (out[m.from] || 0) + 1;
  });
  return out;
}

/* ── Due-soon (15 min) scheduler ── */
function taskDueEpoch(t: { dueDate?: string; dueTime?: string }): number | null {
  if (!t.dueDate || !t.dueTime) return null;
  const md = /^(\d{4})-(\d{2})-(\d{2})/.exec(t.dueDate);
  const mt = /^(\d{2}):(\d{2})$/.exec(t.dueTime);
  if (!md || !mt) return null;
  const d = new Date(+md[1], +md[2] - 1, +md[3], +mt[1], +mt[2], 0, 0);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function dueSoonTick(): void {
  load();
  const now = Date.now();
  const FIFTEEN = 15 * 60 * 1000;
  let changed = false;
  for (const t of getCommandTasks()) {
    if (!t || t.status === "done" || t.status === "on_hold") continue;
    const due = taskDueEpoch(t);
    if (due == null) continue;
    const key = `${t.id}|${due}`;
    if (state.dueNotified.includes(key)) continue;
    const delta = due - now;
    if (delta <= FIFTEEN && delta > -60000) {
      addNotification({
        user: t.assignedTo || "marco",
        type: "due_soon",
        title: "Task due in 15 minutes",
        body: t.title,
        taskId: t.id,
      });
      state.dueNotified.push(key);
      changed = true;
    } else if (delta <= -60000) {
      state.dueNotified.push(key); // past due — don't fire late
      changed = true;
    }
  }
  if (changed) {
    state.dueNotified = state.dueNotified.slice(-1000);
    persist();
  }
}

let started = false;
export function initTeamStore(): void {
  if (started) return;
  started = true;
  load();
  const timer = setInterval(() => {
    try { dueSoonTick(); } catch (err) { console.error("[team] due-soon tick:", err); }
  }, 60 * 1000);
  if (timer.unref) timer.unref();
  console.log(`[team] store initialized — ${state.chats.length} msgs, ${state.notifications.length} notifications`);
}
