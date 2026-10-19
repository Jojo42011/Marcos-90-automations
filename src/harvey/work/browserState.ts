import {closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync} from "fs";
import {randomUUID} from "crypto";

export interface TabState { urls: string[]; active: number; open: boolean; updatedAt: string }
export function restorableUrl(value: string): boolean {
  if(value === "about:blank") return true;
  try { const u=new URL(value); return ["http:","https:"].includes(u.protocol) && !u.username && !u.password; } catch {return false;}
}
export function readTabs(path:string): TabState | undefined {
  if(!existsSync(path))return;
  const v=JSON.parse(readFileSync(path,"utf8"));
  if(!v || !Array.isArray(v.urls) || v.urls.some((u:any)=>typeof u!=="string"||!restorableUrl(u)) || !Number.isInteger(v.active) || v.active<0 || v.active>=Math.max(1,v.urls.length) || typeof v.open!=="boolean")throw new Error("Saved tab state is invalid; original file retained");
  return v;
}
export function writeTabs(path:string,value:TabState) {
  const pending=path+"."+randomUUID()+".pending";
  let fd:number|undefined;
  try {fd=openSync(pending,"wx",0o600);writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(pending,path);}
  finally {if(fd!==undefined)closeSync(fd);if(existsSync(pending))unlinkSync(pending);}
}
export function resultText(result:any):string {return (result?.content||[]).filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");}
export function parseTabs(raw:string):TabState|undefined {
  // Tab mutations can repeat the list in both Result and Open tabs sections.
  const byIndex=new Map<number,RegExpMatchArray>();
  for(const row of raw.matchAll(/^- (\d+):( \(current\))? \[.*\]\((.*)\)(?: \[crashed\])?$/gm))byIndex.set(Number(row[1]),row);
  const rows=[...byIndex].sort(([a],[b])=>a-b).map(([,row])=>row);
  if(!rows.length)return;
  // Unsupported internal URLs are represented by a blank tab, never executed on restore.
  return {urls:rows.map(r=>restorableUrl(r[3])?r[3]:"about:blank"),active:Math.max(0,rows.findIndex(r=>!!r[2])),open:true,updatedAt:new Date().toISOString()};
}
export function browserRead(name:string,args:any):boolean {
  return ["browser_snapshot","browser_take_screenshot","browser_read_snapshot","browser_wait_for"].includes(name) || name==="browser_tabs"&&args?.action==="list";
}
export interface Recovery {kind:string; actionOutcome:"not_executed"|"unknown"; safeToRetry:boolean; guidance:string}
export function recoveryFor(message:string,preflight=false):Recovery {
  if(preflight || /strict mode violation|resolved to \d+ elements|ref.*not found|not found in the current page snapshot|target changed|Invalid browser target|does not match any elements|Unknown engine .+ while parsing selector|Unexpected token .+ while parsing css selector/i.test(message))return {kind:"target",actionOutcome:"not_executed",safeToRetry:true,guidance:"Use the fresh snapshot, narrow to a unique observed target, or inspect the correct tab/frame. Do not guess selectors."};
  if(/intercepts pointer events|not visible|not enabled|not stable/i.test(message))return {kind:"obstructed",actionOutcome:"unknown",safeToRetry:false,guidance:"Inspect the current page and any overlay, loading state or disabled control. Verify whether the action happened before choosing a different target or waiting for readiness."};
  if(/closed|crash|connection|transport/i.test(message))return {kind:"connection",actionOutcome:"unknown",safeToRetry:false,guidance:"Inspect browser status before retrying. An explicit browser_recover can reopen saved tabs and cookies; it never repeats the interrupted action."};
  return {kind:/timeout/i.test(message)?"timeout":"browser",actionOutcome:"unknown",safeToRetry:false,guidance:"Inspect the resulting page and selected tab. Check whether the action succeeded before retrying; use a distinct observed approach. Stop only for a confirmed authorization, MFA/CAPTCHA, service or budget blocker."};
}

/** Reject invalid navigation before touching the selected browser. Never retain raw URLs. */
export function navigationProblem(value:unknown) {
  let reason:string|undefined;
  if(typeof value!=='string'||!value.trim()||value.length>4000)reason='Navigation requires a complete HTTP(S) website URL.';
  else try{
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol))reason='Browser navigation cannot open this URL type; it accepts HTTP(S) websites, not local files, attachments, data or other schemes.';
    else if(url.username||url.password)reason='Navigation URL contains embedded credentials. Use the authorized website login form instead.';
  }catch{reason='Navigation URL is not a valid complete HTTP(S) website address.';}
  if(!reason)return;
  return {error:reason,diagnostic:{code:'invalid_navigation_url'},recovery:{kind:'arguments',actionOutcome:'not_executed' as const,safeToRetry:true,guidance:'No navigation ran; the current tab and login are unchanged. Inspect the selected page with browser_snapshot and use a current observed HTTP(S) link when navigation is needed. Read chat attachments with workspace tools, not browser navigation. Do not infer a failed login or restart it from this error.'}};
}
