import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import type { KnowledgeDoc } from "./knowledgeStore.js";

let connection: Database.Database;
export const sharedKnowledgeEnabled = () => !!process.env.SHARED_KNOWLEDGE_DB_PATH;
function db() {
  if (!connection) {
    const path = process.env.SHARED_KNOWLEDGE_DB_PATH;
    if (!path) throw new Error("Shared knowledge path missing");
    mkdirSync(dirname(path), {recursive:true}); connection = new Database(path);
    connection.pragma("busy_timeout = 10000"); connection.pragma("journal_mode = WAL"); connection.pragma("synchronous = FULL");
    connection.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(source TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(source,id));
      CREATE TABLE IF NOT EXISTS aliases(id TEXT PRIMARY KEY, canonical TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);`);
  }
  return connection;
}
export function claimSharedKnowledgeSeed(){return db().prepare("INSERT OR IGNORE INTO metadata VALUES('seeded')").run().changes>0;}
export function sharedDocumentId(id:string){return (db().prepare("SELECT canonical FROM aliases WHERE id=?").get(id) as {canonical:string}|undefined)?.canonical||id;}
export function sharedDocuments(): KnowledgeDoc[] {
  return (db().prepare("SELECT body FROM documents").all() as {body:string}[]).map(r=>JSON.parse(r.body));
}
/** Apply only this operation's changes, never replace another worker's document list. */
export function persistSharedDocuments(before: KnowledgeDoc[], after: KnowledgeDoc[]) {
  db().transaction(()=>{
    const previous = new Map(before.map(d=>[d.id,JSON.stringify(d)]));
    const next = new Map(after.map(d=>[d.id,JSON.stringify(d)]));
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      if (previous.get(id) === next.get(id)) continue;
      const existing = db().prepare("SELECT body FROM documents WHERE id=?").get(id) as {body:string}|undefined;
      if(previous.has(id) && existing?.body!==previous.get(id))throw Object.assign(new Error("This document changed in another account. Reload it before saving your edit."),{status:409});
      if (existing) db().prepare("INSERT INTO revisions(id,body,at) VALUES(?,?,?)").run(id,existing.body,new Date().toISOString());
      if (next.has(id)) db().prepare("INSERT INTO documents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(id,next.get(id));
      else db().prepare("DELETE FROM documents WHERE id=?").run(id);
    }
  }).immediate();
}
/** Additive, resumable import. Retained JSON sources are never changed or deleted. */
export function importSharedKnowledge(root: string) {
  const sources = [process.env.KNOWLEDGE_JSON_PATH, join(root,"knowledge.json")].filter(Boolean) as string[];
  const accounts=join(root,"accounts");
  if(existsSync(accounts)) for(const entry of readdirSync(accounts,{withFileTypes:true})) if(entry.isDirectory()) sources.push(join(accounts,entry.name,"knowledge.json"));
  for(const source of new Set(sources)) {
    if(!existsSync(source))continue;
    const data=JSON.parse(readFileSync(source,"utf8"));
    if(!Array.isArray(data.docs))throw new Error("Invalid retained knowledge store: "+source);
    db().transaction(()=>{
      for(const doc of data.docs as KnowledgeDoc[]) {
        if(!doc.id || typeof doc.body!=="string" || typeof doc.title!=="string")throw new Error("Invalid retained knowledge document");
        if(db().prepare("SELECT 1 FROM imports WHERE source=? AND id=?").get(source,doc.id))continue;
        if(doc.builtIn){
          const same=db().prepare("SELECT id FROM documents WHERE json_extract(body,'$.builtIn')=1 AND json_extract(body,'$.title')=? AND json_extract(body,'$.body')=? AND json_extract(body,'$.category')=?").get(doc.title,doc.body,doc.category) as {id:string}|undefined;
          if(same){
            if(same.id!==doc.id && !db().prepare("SELECT 1 FROM documents WHERE id=?").get(doc.id))db().prepare("INSERT OR IGNORE INTO aliases VALUES(?,?)").run(doc.id,same.id);
            db().prepare("INSERT INTO imports VALUES(?,?)").run(source,doc.id);continue;
          }
        }
        let id=doc.id;
        const existing=db().prepare("SELECT body FROM documents WHERE id=?").get(id) as {body:string}|undefined;
        if(existing && existing.body!==JSON.stringify(doc)) id=createHash("sha256").update(source+":"+id).digest("hex");
        db().prepare("INSERT OR IGNORE INTO documents VALUES(?,?)").run(id,JSON.stringify({...doc,id}));
        db().prepare("INSERT INTO imports VALUES(?,?)").run(source,doc.id);
      }
    }).immediate();
  }
}
