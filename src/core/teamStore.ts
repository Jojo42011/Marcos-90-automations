import Database from "better-sqlite3";
import { dataPath } from "./tenantData.js";
/**
 * Team collaboration store for the Task Command Center — direct chat,
 * notifications (assignments / due-soon / messages), and lightweight presence.
 * File-backed (same pattern as pushStore): /data/team.json on Fly, ./data
 * locally. Identity comes from the authenticated account: member ids
 * (marco/wesley/carlos).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { getAssignedCommandTasks } from "./db.js";

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
  if (existsSync(dataPath(""))) return dataPath("team.json");
  return dataPath("team.json");
}

const PATH = resolvePath();
const MAX_CHATS = 5000;
const MAX_NOTIFICATIONS = 2000;

let state: PersistedTeam = { chats: [], notifications: [], dueNotified: [] };
const presence = new Map<string, number>(); // member id -> last-seen epoch ms
let loaded = false;

// One transactional store for team collaboration across account workers.
// Import existing files additively; never rewrite or remove the source files.
let shared: Database.Database | undefined;
function sharedDb(): Database.Database | undefined {
  if(process.env.ACCOUNT_ISOLATION !== "true")return undefined;
  if(shared)return shared;
  const root=dirname(process.env.SHARED_TASK_DB_PATH || dataPath("shared-tasks.db"));
  mkdirSync(root,{recursive:true});
  const db=new Database(join(root,"shared-team.db"));
  try {
  db.pragma("busy_timeout = 10000");db.pragma("journal_mode = WAL");db.pragma("synchronous = FULL");
  db.exec("CREATE TABLE IF NOT EXISTS team_state(id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS team_imports(source TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS team_presence(member TEXT PRIMARY KEY, seen INTEGER NOT NULL);");
  db.transaction(()=>{
    const row=db.prepare("SELECT body FROM team_state WHERE id=1").get() as {body:string}|undefined;
    const merged:PersistedTeam=row?JSON.parse(row.body):{chats:[],notifications:[],dueNotified:[]};
    const sources=[process.env.TEAM_JSON_PATH,join(root,"team.json")].filter((x):x is string=>!!x);
    const accounts=join(root,"accounts");
    if(existsSync(accounts))for(const entry of readdirSync(accounts,{withFileTypes:true}))if(entry.isDirectory())sources.push(join(accounts,entry.name,"team.json"));
    for(const source of sources){
      if(!existsSync(source)||db.prepare("SELECT 1 FROM team_imports WHERE source=?").get(source))continue;
      // Invalid files fail visibly instead of replacing retained records with emptiness.
      const raw=readFileSync(source,"utf8"), old=JSON.parse(raw) as Partial<PersistedTeam>;
      for(const key of ["chats","notifications"] as const){
        const ids=new Set(merged[key].map(x=>x.id));
        for(const item of old[key]||[])if(!ids.has(item.id)){(merged[key] as any[]).push(item);ids.add(item.id);}
      }
      merged.dueNotified=[...new Set([...merged.dueNotified,...(old.dueNotified||[])])];
      db.prepare("INSERT INTO team_imports(source,body) VALUES(?,?)").run(source,raw);
    }
    merged.chats.sort((a,b)=>a.at.localeCompare(b.at));merged.notifications.sort((a,b)=>a.at.localeCompare(b.at));
    db.prepare("INSERT OR REPLACE INTO team_state(id,body) VALUES(1,?)").run(JSON.stringify(merged));
  }).immediate();
  shared=db;
  } catch(error){db.close();throw error;}
  return shared;
}
function transaction<T>(fn:()=>T):T {
  const db=sharedDb()!;
  return db.transaction(()=>{loaded=false;return fn();}).immediate();
}

function persist(): void {
  const db=sharedDb();
  if(db){db.prepare("UPDATE team_state SET body=? WHERE id=1").run(JSON.stringify(state));return;}
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify(state), "utf8");
  } catch (err) {
    console.error("[team] persist failed:", err);
  }
}

function load(): void {
  const db=sharedDb();
  if(db){
    if(loaded && db.inTransaction)return;
    state=JSON.parse((db.prepare("SELECT body FROM team_state WHERE id=1").get() as {body:string}).body);loaded=true;return;
  }
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
  if(u){
    const db=sharedDb();
    if(db)db.prepare("INSERT OR REPLACE INTO team_presence(member,seen) VALUES(?,?)").run(u,Date.now());
    else presence.set(u,Date.now());
  }
}
export function getPresence(): Record<string, { lastSeen: string | null; online: boolean }> {
  const out: Record<string, { lastSeen: string | null; online: boolean }> = {};
  for (const m of ["marco", "wesley", "carlos"]) {
    const db=sharedDb();
    const t = db ? (db.prepare("SELECT seen FROM team_presence WHERE member=?").get(m) as {seen:number}|undefined)?.seen : presence.get(m);
    out[m] = { lastSeen: t ? new Date(t).toISOString() : null, online: !!t && Date.now() - t < 70000 };
  }
  return out;
}

/* ── Notifications ── */
export function addNotification(
  n: Omit<TeamNotification, "id" | "at">,
): TeamNotification {
  const db=sharedDb();if(db && !db.inTransaction)return transaction(()=>addNotification(n));
  load();
  const entry: TeamNotification = { ...n, user: norm(n.user), id: randomUUID(), at: nowIso() };
  state.notifications.push(entry);
  if (!sharedDb() && state.notifications.length > MAX_NOTIFICATIONS) {
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
  const db=sharedDb();if(db && !db.inTransaction)return transaction(()=>markNotificationsRead(user,ids));
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
  const db=sharedDb();if(db && !db.inTransaction)return transaction(()=>addChatMessage(from,to,text));
  load();
  const msg: TeamChatMessage = {
    id: randomUUID(),
    from: norm(from),
    to: norm(to),
    text: String(text || "").slice(0, 4000),
    at: nowIso(),
  };
  state.chats.push(msg);
  if (!sharedDb() && state.chats.length > MAX_CHATS) state.chats = state.chats.slice(-MAX_CHATS);
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
  const db=sharedDb();if(db && !db.inTransaction)return transaction(()=>markChatRead(me,withUser));
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
  const db=sharedDb();if(db && !db.inTransaction)return transaction(()=>dueSoonTick());
  load();
  const now = Date.now();
  const FIFTEEN = 15 * 60 * 1000;
  let changed = false;
  for (const t of getAssignedCommandTasks()) {
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
    if(!sharedDb())state.dueNotified = state.dueNotified.slice(-1000);
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
