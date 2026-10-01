import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { dataPath } from "./tenantData.js";
import type { CommandTask } from "./types.js";
import { getUsers } from "./users.js";

let connection: Database.Database | undefined;
export const sharedTasksEnabled = () => process.env.ACCOUNT_ISOLATION === "true";
export const taskActor = () => process.env.TENANT_MEMBER || "";
const member = (value: unknown) => String(value || "").trim().toLowerCase().split(/\s+/)[0];
const currentMembers = new Set(["marco","wesley","carlos"]);
// The same retired-identity fingerprint used by account provisioning. Original
// source files and revision history remain available for recovery.
const retiredIdentity = "260670134225f2a24b59121739fec73584b0ddb6b49c39e31bd1df5483ac144d";
function currentTask(task: CommandTask): CommandTask {
  const clean = (value: string) => value.replace(/\b[a-z]+\b/gi, word =>
    createHash("sha256").update(word.toLowerCase()).digest("hex") === retiredIdentity ? (word === word.toLowerCase() ? "carlos" : "Carlos") : word);
  return {...task,
    assignedTo: currentMembers.has(member(task.assignedTo)) ? member(task.assignedTo) : "carlos",
    createdBy: task.createdBy ? clean(task.createdBy) : task.createdBy,
    title: clean(task.title), description: task.description ? clean(task.description) : task.description,
    checklist: task.checklist?.map(item=>({...item,text:clean(item.text)})), tags:task.tags?.map(clean)};
}
function db() {
  if (!connection) {
    const file = process.env.SHARED_TASK_DB_PATH || dataPath("shared-tasks.db");
    mkdirSync(dirname(file), { recursive: true });
    connection = new Database(file);
    connection.pragma("journal_mode = WAL"); connection.pragma("busy_timeout = 10000"); connection.pragma("synchronous = FULL");
    connection.exec(`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS imports(source TEXT NOT NULL, original_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(source, original_id));
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL);`);
  }
  return connection;
}
function visible(task: CommandTask) {
  const actor = taskActor();
  return !process.env.TENANT_OWNER_ID || actor === "carlos" || member(task.assignedTo) === actor || member(task.createdBy) === actor;
}
function editable(task: CommandTask) {
  const actor=taskActor();
  return !process.env.TENANT_OWNER_ID || member(task.assignedTo)===actor || member(task.createdBy)===actor;
}
export function sharedTaskList(): CommandTask[] {
  return (db().prepare("SELECT body FROM tasks WHERE deleted=0").all() as {body:string}[]).map(r => JSON.parse(r.body)).filter(visible);
}
function history(task: CommandTask, action: string) {
  db().prepare("INSERT INTO history(task_id,body,action,at) VALUES(?,?,?,?)").run(task.id, JSON.stringify(task), action, new Date().toISOString());
}
export function sharedTaskCreate(task: CommandTask) {
  db().transaction(() => {
    db().prepare("INSERT INTO tasks(id,body) VALUES(?,?)").run(task.id, JSON.stringify(task)); history(task,"create");
  })(); return task;
}
export function sharedTaskUpdate(id: string, updates: Partial<CommandTask>, expected?: CommandTask): CommandTask | null {
  return db().transaction(() => {
    const row = db().prepare("SELECT body FROM tasks WHERE id=? AND deleted=0").get(id) as {body:string} | undefined;
    if (!row) return null;
    const old: CommandTask = JSON.parse(row.body); if (!editable(old)) return null;
    // Deadline workers may only change the status of the snapshot they evaluated.
    if (expected && (old.status !== expected.status || old.dueDate !== expected.dueDate || old.updatedAt !== expected.updatedAt)) return null;
    const next = {...old,...updates,id:old.id,createdBy:old.createdBy,createdAt:old.createdAt,updatedAt:new Date().toISOString()};
    if (next.status === "done" && !next.completedAt) next.completedAt = new Date().toISOString();
    db().prepare("UPDATE tasks SET body=? WHERE id=?").run(JSON.stringify(next),id); history(next,"update"); return next;
  })();
}
export function sharedTaskDelete(id: string): boolean {
  return db().transaction(() => {
    const row = db().prepare("SELECT body FROM tasks WHERE id=? AND deleted=0").get(id) as {body:string} | undefined;
    if (!row) return false; const task = JSON.parse(row.body); if (!editable(task)) return false;
    db().prepare("UPDATE tasks SET deleted=1 WHERE id=?").run(id); history(task,"delete"); return true;
  })();
}

/** Read retained sources once per record; never overwrite edits or resurrect explicit deletions. */
export function recoverSharedTasks(root = dataPath()) {
  const sources = [process.env.DB_JSON_PATH, join(root,"db.json"), join(root,"local-dashboard-db.json")].filter((s): s is string => !!s);
  const accounts = join(root,"accounts");
  if (existsSync(accounts)) for (const entry of readdirSync(accounts,{withFileTypes:true})) if(entry.isDirectory()) {
    sources.push(join(accounts,entry.name,"db.json"),join(accounts,entry.name,"local-dashboard-db.json"));
  }
  let imported=0, inspected=0;
  for (const source of new Set(sources)) {
    if (!existsSync(source)) continue;
    const raw = JSON.parse(readFileSync(source,"utf8"));
    if (raw.commandTasks !== undefined && !Array.isArray(raw.commandTasks)) throw new Error("Invalid retained task store: "+source);
    db().transaction(() => {
      for (const task of raw.commandTasks || []) {
        if (!task || typeof task.id !== "string" || typeof task.title !== "string") throw new Error("Invalid retained task record: "+source);
        inspected++;
        if (db().prepare("SELECT 1 FROM imports WHERE source=? AND original_id=?").get(source,task.id)) continue;
        let id=task.id;
        const existing=db().prepare("SELECT body FROM tasks WHERE id=?").get(id) as {body:string}|undefined;
        if(existing && existing.body !== JSON.stringify(task)) id=createHash("sha256").update(source+":"+task.id).digest("hex");
        if(!db().prepare("SELECT 1 FROM tasks WHERE id=?").get(id)) {
          const restored={...task,id}; db().prepare("INSERT INTO tasks(id,body) VALUES(?,?)").run(id,JSON.stringify(restored)); history(restored,"restore"); imported++;
        }
        db().prepare("INSERT INTO imports(source,original_id,task_id) VALUES(?,?,?)").run(source,task.id,id);
      }
    })();
  }
  let reassigned=0;
  db().transaction(() => {
    for (const row of db().prepare("SELECT id,body FROM tasks").all() as {id:string;body:string}[]) {
      const old:CommandTask=JSON.parse(row.body), task=currentTask(old);
      if(JSON.stringify(old)===JSON.stringify(task)) continue;
      db().prepare("UPDATE tasks SET body=? WHERE id=?").run(JSON.stringify(task),row.id);
      history(task,"restore-owner"); if(old.assignedTo!==task.assignedTo)reassigned++;
    }
  })();
  const total=(db().prepare("SELECT count(*) AS count FROM tasks WHERE deleted=0").get() as {count:number}).count;
  // Restore the older personal/CRM task pages too, without importing CRM contacts.
  let personalImported=0;
  const users=getUsers().filter(u=>u.active);
  for(const filename of ["marco-tasks.json","tasks.json"]) {
    const source=join(root,filename); if(!existsSync(source)) continue;
    const tasks=JSON.parse(readFileSync(source,"utf8"));
    if(!Array.isArray(tasks)) throw new Error("Invalid retained task list: "+source);
    for(const task of tasks) {
      if(!task || typeof task.id!=="string") throw new Error("Invalid retained task ID: "+source);
      if(db().prepare("SELECT 1 FROM imports WHERE source=? AND original_id=?").get(source,task.id)) continue;
      const assigned=task.assignedUserId || task.assignedUserName || task.assignedTo || "marco";
      const owner=users.find(u=>u.id===assigned || member(u.name)===member(assigned)) || users.find(u=>member(u.name)==="marco");
      if(!owner) throw new Error("Cannot restore tasks without a destination account");
      const dir=join(root,"accounts",createHash("sha256").update(owner.id).digest("hex")); mkdirSync(dir,{recursive:true});
      const target=join(dir,filename), current=existsSync(target)?JSON.parse(readFileSync(target,"utf8")):[];
      if(!Array.isArray(current)) throw new Error("Invalid destination task list: "+target);
      if(!current.some((t:any)=>t.id===task.id)) {
        current.push(task);writeFileSync(target+".recovery",JSON.stringify(current,null,2));renameSync(target+".recovery",target);personalImported++;
      }
      db().prepare("INSERT INTO imports(source,original_id,task_id) VALUES(?,?,?)").run(source,task.id,target+":"+task.id);
    }
  }
  console.log(`[tasks-recovery] inspected=${inspected} imported=${imported} retained=${total} personalImported=${personalImported} reassigned=${reassigned}`);
  return {inspected,imported,total,personalImported,reassigned};
}
