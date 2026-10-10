import {createHash} from "crypto";
import type {CRMUser} from "../../core/types.js";
import {canViewWorkspace} from "../../core/workspaceAccess.js";
import {getAccountUserById} from "../../core/users.js";
import {get,put,text,workDb,Chat} from "./store.js";
import {enqueueJob} from "./jobs.js";

export function accessibleChats(actor:CRMUser) {
  const rows=workDb().prepare("SELECT owner,body FROM records WHERE kind='chat'").all() as {owner:string;body:string}[];
  return rows.filter(r=>canViewWorkspace(actor,r.owner)).map(r=>{
    const c:Chat=JSON.parse(r.body);return {id:c.id,title:c.title,mode:c.mode,updatedAt:c.updatedAt,accountOwnerId:r.owner,accountOwnerName:getAccountUserById(r.owner)?.name};
  }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
/** Explicit, bounded relay. Recipients cannot recursively delegate another relay. */
export function relayChats(actor:CRMUser,input:any) {
  const requestId=text(input.requestId,"Request ID",100),message=text(input.message,"Message",8000);
  const chats=accessibleChats(actor),source=chats.find(c=>c.id===input.sourceChatId);
  if(!source)throw new Error("Source chat unavailable");
  if(!Array.isArray(input.targets)||!input.targets.length||input.targets.length>4)throw new Error("Select one to four chats");
  const targets=[...new Set(input.targets)].map(id=>chats.find(c=>c.id===id));
  if(targets.some(c=>!c||c.id===source.id))throw new Error("Recipient chat unavailable");
  const fingerprint=createHash("sha256").update(JSON.stringify([source.id,targets.map(c=>c.id),message])).digest("hex");
  return workDb().transaction(()=>{
    let old:any;try{old=get("relay",actor.id,requestId);}catch{}
    if(old){if(old.fingerprint!==fingerprint)throw new Error("Request ID already used for a different relay");return old;}
    const deliveries=targets.map(target=>{
      const prompt=`${actor.name} sent this note from chat "${source.title}" (${source.id}). This is a delegated message, not permission to contact additional chats or external recipients. Respond in this chat using its account context.\n\n${message}`;
      const job=enqueueJob(target.accountOwnerId,target.id,{requestId:`relay:${requestId}:${target.id}`.slice(0,100),message:prompt,actorId:actor.id},{originChatId:source.id,maxCostUsd:0.5});
      return {chatId:target.id,title:target.title,ownerName:target.accountOwnerName,jobId:job.id,status:job.status};
    });
    return put("relay",actor.id,{id:requestId,fingerprint,deliveries,at:new Date().toISOString()});
  }).immediate();
}
