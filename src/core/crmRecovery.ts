import { existsSync, readFileSync, writeFileSync, mkdirSync, linkSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

/** Restore the original operator's CRM only before its isolated worker starts.
 * Never replace an existing account store, or import task ownership implicitly. */
export function recoverMarcoCrm(root: string, target: string, explicitSource?: string): void {
  if (["db.json", "local-dashboard-db.json"].some(f => existsSync(join(target, f)))) return;
  const source = explicitSource || ["db.json", "local-dashboard-db.json"].map(f => join(root, f)).find(existsSync);
  if (!source || !existsSync(source)) return;
  const raw = readFileSync(source, "utf8"), data = JSON.parse(raw);
  if (!data.leadsById || !Object.keys(data.leadsById).length) return;
  if (typeof data.leadsById !== "object" || Array.isArray(data.leadsById)) throw new Error("Invalid retained CRM store");
  const digest = createHash("sha256").update(raw).digest("hex");
  const backup = join(root, "crm-recovery-backups"); mkdirSync(backup, {recursive:true});
  const backupFile = join(backup, digest + ".json");
  if (!existsSync(backupFile)) writeFileSync(backupFile, raw, {flag:"wx",mode:0o600});
  if (readFileSync(backupFile,"utf8") !== raw) throw new Error("CRM recovery backup verification failed");
  mkdirSync(target,{recursive:true});
  const restored = {idCounter:data.idCounter,leadsById:data.leadsById,leadKeyToId:data.leadKeyToId || {},conversationsByLeadId:data.conversationsByLeadId || {},commandTasks:[]};
  const pending=join(target,"crm-recovery-"+digest+".pending");
  if (!existsSync(pending)) writeFileSync(pending,JSON.stringify(restored),{flag:"wx",mode:0o600});
  if (readFileSync(pending,"utf8") !== JSON.stringify(restored)) throw new Error("CRM recovery staging verification failed");
  // Atomic publication without overwriting a file created concurrently.
  linkSync(pending,join(target,"db.json")); unlinkSync(pending);
  writeFileSync(join(target,"crm-recovery-receipt.json"),JSON.stringify({sourceDigest:digest,leads:Object.keys(data.leadsById).length,at:new Date().toISOString()}),{flag:"wx",mode:0o600});
  console.log("[crm-recovery] Restored original CRM to Marco workspace",Object.keys(data.leadsById).length);
}
