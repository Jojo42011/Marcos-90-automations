import {createDoc,searchDocs,getDoc} from "../../core/knowledgeStore.js";
import {sourceMessage,safeNote} from "./learning.js";
import {getAccountUserById} from "../../core/users.js";
export function saveTeamTraining(owner:string,chatId:string,actorId:string,input:any){
  const source=sourceMessage(owner,chatId,Number(input.sourceSeq));
  const quote=safeNote(input.sourceQuote,"Source quote",600);
  if(source.role!=="user"||source.runId||source.origin||source.actorId && source.actorId!==actorId||!source.content.includes(quote))throw new Error("Team training needs a direct teaching quote from the current user");
  return createDoc({title:safeNote(input.title,"Training title",150),body:safeNote(input.value,"Training",4000),category:"Harvey training",tags:["harvey","team-training"],updatedBy:getAccountUserById(actorId)?.name||actorId});
}
export function sharedTrainingContext(query:string){
  return searchDocs(query,5).map(hit=>({title:hit.title,excerpt:hit.excerpt}));
}
