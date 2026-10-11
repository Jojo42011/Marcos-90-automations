import { existsSync, readFileSync } from "node:fs";
import { atomicJson } from "./atomicJson.js";
import { dataPath } from "./tenantData.js";
export interface DmJob { id:string; event:any; status:"pending"|"processing"|"done"|"failed"; attempts:number; nextAt:number; reply?:string; error?:string; }
let rows: DmJob[] | undefined;
const file = () => dataPath("inbound-dm-queue.json");
function load(): DmJob[] {
  if (!rows) {
    const data = existsSync(file()) ? JSON.parse(readFileSync(file(),"utf8")) : [];
    if (!Array.isArray(data)) throw new Error("Invalid DM queue; preserved for recovery");
    rows = data.map(row => ({...row,status:row.status === "processing" ? "pending" : row.status}));
  }
  return rows!;
}
function persist() { atomicJson(file(), load()); }
export function enqueueDm(event:any): boolean {
  const jobs=load(); if(jobs.some(j=>j.id===event.eventId))return false;
  const job:DmJob={id:event.eventId,event,status:"pending",attempts:0,nextAt:Date.now()};
  jobs.push(job);
  try { persist(); } catch(error) { jobs.pop(); throw error; }
  return true;
}
export function saveDmReply(job:DmJob,reply:string):void {
  job.reply=reply; persist();
}
export async function drainDmQueue(process:(job:DmJob)=>Promise<void>):Promise<void> {
  // Claim synchronously before yielding. New arrivals can still join the existing debounce window.
  {
    const due=load().filter(j=>j.status==="pending"&&j.nextAt<=Date.now()).slice(0,32);
    if (!due.length) return;
    for(const job of due){job.status="processing";job.attempts++;}
    try { persist(); } catch(error) { for(const job of due){job.status="pending";job.attempts--;} throw error; }
    // Existing debounce and per-conversation serialization remain in the pipeline.
    await Promise.all(due.map(async job=>{
      try { await process(job); job.status="done"; job.error=undefined; }
      catch(error) { job.error=error instanceof Error?error.message:String(error);job.status=job.attempts>=5?"failed":"pending";job.nextAt=Date.now()+Math.min(300000,10000*2**job.attempts); }
      persist();
    }));
  }
}

export function dmQueueStatus() {
  const jobs=load();
  return {counts:Object.fromEntries(["pending","processing","done","failed"].map(status=>[status,jobs.filter(j=>j.status===status).length])),
    failed:jobs.filter(j=>j.status==="failed").map(({id,attempts,error})=>({id,attempts,error}))};
}
