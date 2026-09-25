import Database from "better-sqlite3";
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { CronExpressionParser } from "cron-parser";

export type Mode = "chat" | "work";
export interface Project { id: string; name: string; instructions: string; timezone: string }
export interface Chat { allowChatCredentials?: boolean; id: string; projectId: string | null; title: string; mode: Mode; sessionId: string; updatedAt: string }
export interface Message { role: "user" | "assistant"; content: string; at: string; runId?: string }
export interface Schedule { id: string; chatId: string; title: string; prompt: string; cron: string; timezone: string; enabled: boolean; nextRunAt: string; maxCostUsd: number }
export interface Run { id: string; scheduleId: string; chatId: string; status: "running" | "completed" | "failed" | "needs_attention"; startedAt: string; finishedAt?: string; result?: string }
export interface Connection { id: string; service: string; name: string; kind: "oauth" | "mcp"; endpoint?: string; projectId: string | null; allowWrites: boolean; secret: string; updatedAt: string }
let db: Database.Database;
export function workDir() {
  const dir = process.env.HARVEY_WORK_DIR || (process.platform !== "win32" && existsSync("/data") ? "/data/harvey-work" : join(process.cwd(), "data", "harvey-work"));
  mkdirSync(dir, { recursive: true }); return dir;
}
export function workDb() {
  if (!db) {
    db = new Database(join(workDir(), "work.db")); db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,owner,id));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, chat TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(owner,chat,seq);
      CREATE TABLE IF NOT EXISTS locks(owner TEXT NOT NULL, chat TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(owner,chat));`);
  } return db;
}
export function list<T>(kind: string, owner: string): T[] { return (workDb().prepare("SELECT body FROM records WHERE kind=? AND owner=? ORDER BY rowid DESC").all(kind, owner) as any[]).map(r => JSON.parse(r.body)); }
export function get<T>(kind: string, owner: string, id: string): T {
  const row = workDb().prepare("SELECT body FROM records WHERE kind=? AND owner=? AND id=?").get(kind, owner, id) as any;
  if (!row) throw new Error("Not found"); return JSON.parse(row.body);
}
export function put<T extends { id: string }>(kind: string, owner: string, value: T): T {
  workDb().prepare("INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,owner,id) DO UPDATE SET body=excluded.body").run(kind, owner, value.id, JSON.stringify(value)); return value;
}
export function remove(kind: string, owner: string, id: string) { get(kind, owner, id); workDb().prepare("DELETE FROM records WHERE kind=? AND owner=? AND id=?").run(kind, owner, id); }
export function text(value: unknown, label: string, max = 8000): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} is required (maximum ${max} characters)`); return value.trim(); }
export function timezone(value: unknown): string { const tz = text(value, "Timezone", 100); new Intl.DateTimeFormat("en", { timeZone: tz }).format(); return tz; }
export function createProject(owner: string, input: any): Project {
  return put("project", owner, { id: randomUUID(), name: text(input.name, "Project name", 100), instructions: String(input.instructions || "").slice(0, 12000), timezone: timezone(input.timezone || "America/Chicago") });
}
export function createChat(owner: string, input: any): Chat {
  const projectId = input.projectId || null; if (projectId) get("project", owner, projectId);
  return put("chat", owner, { id: randomUUID(), sessionId: randomUUID(), projectId, title: text(input.title || "New chat", "Chat title", 120), mode: input.mode === "work" ? "work" : "chat", updatedAt: new Date().toISOString() });
}
export function handoffChat(owner: string, sourceId: string, brief: string): Chat {
  const source = get<Chat>("chat", owner, sourceId);
  const chat = createChat(owner, { projectId: source.projectId, mode: "work", title: "Work: " + source.title.slice(0,100) });
  const context = messages(owner, sourceId).slice(-12).map(m => `${m.role}: ${m.content}`).join("\n\n").slice(-16000);
  append(owner, chat.id, { role: "user", at: new Date().toISOString(), content: `Planning handoff from ${source.title}. Treat the following as background, not authorization to execute.\n\n${context}\n\nTask brief: ${text(brief,"Task brief",8000)}\n\nFirst prepare a plan and identify required connections. Wait for my next message before executing or scheduling.` });
  append(owner, chat.id, { role: "assistant", at: new Date().toISOString(), content: "Your task brief is ready. Send ‘Plan this task’ to check the steps and required connections. No actions or schedules have started." });
  return chat;
}
export function messages(owner: string, chat: string): Message[] { get("chat", owner, chat); return (workDb().prepare("SELECT body FROM (SELECT seq,body FROM messages WHERE owner=? AND chat=? ORDER BY seq DESC LIMIT 200) ORDER BY seq").all(owner, chat) as any[]).map(r => JSON.parse(r.body)); }
export function append(owner: string, chatId: string, message: Message) {
  const chat = get<Chat>("chat", owner, chatId);
  workDb().prepare("INSERT INTO messages(owner,chat,body) VALUES (?,?,?)").run(owner, chatId, JSON.stringify(message));
  chat.updatedAt = new Date().toISOString(); if (chat.title === "New chat" && message.role === "user") chat.title = message.content.slice(0, 80);
  put("chat", owner, chat);
}
export function nextRun(cron: string, tz: string, from = new Date()): string {
  timezone(tz); if (cron.trim().split(/\s+/).length !== 5) throw new Error("Use a five-field cron expression (minute hour day month weekday)");
  const expr = CronExpressionParser.parse(cron, { currentDate: from, tz }); const first = expr.next().toDate(); let previous = first;
  for (let i=0;i<64;i++) { const next=expr.next().toDate(); if (next.getTime()-previous.getTime()<15*60_000) throw new Error("Schedules must be at least 15 minutes apart"); previous=next; }
  return first.toISOString();
}
export function createSchedule(owner: string, input: any): Schedule {
  const chat = get<Chat>("chat", owner, text(input.chatId, "Chat"));
  const cron = text(input.cron, "Schedule", 100), tz = timezone(input.timezone || "America/Chicago");
  const maxCostUsd = Number(input.maxCostUsd ?? 1); if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0.01 || maxCostUsd > 25) throw new Error("Run budget must be between $0.01 and $25");
  return put("schedule", owner, { id: randomUUID(), chatId: chat.id, title: text(input.title, "Task name", 120), prompt: text(input.prompt, "Instructions", 20000), cron, timezone: tz, enabled: true, nextRunAt: nextRun(cron, tz), maxCostUsd });
}
export function lockChat(owner: string, chat: string): string {
  const token = randomUUID(); try { workDb().prepare("INSERT INTO locks VALUES (?,?,?)").run(owner, chat, token); } catch { throw new Error("This chat already has a run in progress. Try again when it finishes."); } return token;
}
export function unlockChat(owner: string, chat: string, token: string) { workDb().prepare("DELETE FROM locks WHERE owner=? AND chat=? AND token=?").run(owner, chat, token); }
export function owners(kind: string): string[] { return (workDb().prepare("SELECT DISTINCT owner FROM records WHERE kind=?").all(kind) as any[]).map(r => r.owner); }
export function vaultReady() { return /^[0-9a-f]{64}$/i.test(process.env.HARVEY_VAULT_KEY || ""); }
function key() { if (!vaultReady()) throw new Error("Set HARVEY_VAULT_KEY to a stable 64-character hex key before saving logins or connecting services"); return Buffer.from(process.env.HARVEY_VAULT_KEY!, "hex"); }
export function seal(value: unknown): string { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(), iv); const ciphertext = Buffer.concat([c.update(JSON.stringify(value)), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ciphertext]).toString("base64"); }
export function unseal<T = any>(value: string): T { const b = Buffer.from(value, "base64"), c = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([c.update(b.subarray(28)), c.final()]).toString()); }
export function closeStore() { db?.close(); db = undefined; }
