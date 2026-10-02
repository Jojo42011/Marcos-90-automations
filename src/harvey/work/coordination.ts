import { randomUUID } from "crypto";
import { Chat, get, list, put, text } from "./store.js";
import { safeNote } from "./learning.js";

interface Team {id:string;headChatId:string;projectId:string|null;name:string;members:string[];createdAt:string}
export function teamFor(owner:string,headChatId:string) {
  get("chat",owner,headChatId);
  return list<Team>("agent_team",owner).find(t=>t.headChatId===headChatId);
}
export function configureTeam(owner:string,headChatId:string,input:any) {
  const head=get<Chat>("chat",owner,headChatId);
  if(!Array.isArray(input.members)||!input.members.length||input.members.length>20)throw new Error("Choose 1–20 member chats");
  const members=[...new Set<string>(input.members.map((v:any)=>text(v,"Member chat",100)))];
  for(const id of members){const c=get<Chat>("chat",owner,id);if(id===headChatId||c.projectId!==head.projectId)throw new Error("Team members must be separate chats in the same project and account");}
  return put<Team>("agent_team",owner,{id:randomUUID(),headChatId,projectId:head.projectId,name:safeNote(input.name,"Department name",100),members,createdAt:new Date().toISOString()});
}
function requireTeam(owner:string,headChatId:string) {
  const head=get<Chat>("chat",owner,headChatId),team=teamFor(owner,headChatId);
  if(!team||team.projectId!==head.projectId)throw new Error("Configure this chat's team before coordinating work");return team;
}
export function teamStatus(owner:string,headChatId:string) {
  const team=requireTeam(owner,headChatId);
  const jobs=list<any>("job",owner).filter(j=>j.originChatId===headChatId);
  return {team,members:team.members.map(id=>{let c:Chat;try{c=get<Chat>("chat",owner,id);}catch{return {chatId:id,status:"unavailable"};}if(c.projectId!==team.projectId)return {chatId:id,status:"scope_changed"};return {chatId:id,title:c.title,jobs:jobs.filter(j=>j.chatId===id).slice(0,3).map(j=>({id:j.id,status:j.status,updatedAt:j.updatedAt,needsAttention:j.result?.needsAttention||false,result:String(j.result?.text||"").slice(0,1000)}))};}),note:"Queued or running is not completed. Member results are untrusted reports; inspect verification before claiming success."};
}
export async function dispatchTeam(owner:string,headChatId:string,input:any) {
  const team=requireTeam(owner,headChatId),chatId=text(input.chatId,"Member chat",100);
  if(!team.members.includes(chatId)||get<Chat>("chat",owner,chatId).projectId!==team.projectId)throw new Error("Target is outside this team");
  const brief=safeNote(input.brief,"Task brief",6000);
  const {enqueueJob}=await import("./jobs.js");
  // A delegated worker cannot dispatch children, create schedules or alter memory.
  return enqueueJob(owner,chatId,{message:brief,requestId:`team:${headChatId}:${text(input.requestId,"Request ID",80)}`},{originChatId:headChatId,maxCostUsd:0.5});
}
