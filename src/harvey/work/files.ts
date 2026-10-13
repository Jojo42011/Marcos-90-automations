import { readdirSync, statSync, mkdirSync, realpathSync } from "fs";
import { join, basename, sep, resolve } from "path";
import { uploadFile } from "./uploadFiles.js";
import { exportVideo, inspectVideoPath, videoFailure } from "./video.js";
import { browserDirectory } from "./browser.js";
export function filesDir(owner: string, chat: string) { const dir = join(browserDirectory(owner,chat),"files");mkdirSync(dir,{recursive:true});return dir; }
export function filePath(owner: string, chat: string, name: string) {
  if(!name || basename(name)!==name || name.startsWith("."))throw new Error("Use a file name from this chat's workspace");
  const root=realpathSync(filesDir(owner,chat)),p=realpathSync(join(root,name));if(!p.startsWith(root+sep))throw new Error("File is outside this chat");return p;
}
export function files(owner: string, chat: string) {const dir=filesDir(owner,chat);return readdirSync(dir).filter(n=>!n.startsWith(".")&&statSync(join(dir,n)).isFile()).map(name=>({name,size:statSync(join(dir,name)).size,path:join(dir,name),download:`/api/harvey/work/files/${chat}/${encodeURIComponent(name)}`}));}
function mediaPath(owner:string,chat:string,raw:string){
  const root=realpathSync(filesDir(owner,chat)),p=realpathSync(resolve(root,raw));
  if(!p.startsWith(root+sep)||!statSync(p).isFile())throw new Error("Video must be a file in this chat workspace");
  return p;
}
export async function inspectVideo(owner:string,chat:string,input:any,signal?:AbortSignal){
  try{return await inspectVideoPath(mediaPath(owner,chat,String(input.file||"")),signal);}
  catch(error){signal?.throwIfAborted();return videoFailure(error);}
}
export async function editVideo(owner:string,chat:string,input:any,signal?:AbortSignal){
  try{const result=await exportVideo(filesDir(owner,chat),mediaPath(owner,chat,String(input.file||"")),input.matchFile?mediaPath(owner,chat,String(input.matchFile)):undefined,input,signal);return "file" in result?{...result,download:`/api/harvey/work/files/${chat}/${result.file}`}:result;}
  catch(error){signal?.throwIfAborted();return videoFailure(error);}
}

export function workspaceFiles(owner:string,chat:string,input:any={}) {
  if(input.file)return uploadFile(filesDir(owner,chat),input.file,input.filename);
  const diagnostics=/^(?:page-.*\.(?:yml|jpeg|png)|console-.*\.log)$/;
  const all=files(owner,chat).filter(f=>input.includeDiagnostics===true||!diagnostics.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name));
  const offset=Number.isSafeInteger(input.offset)&&input.offset>=0?input.offset:0;
  const limit=20;
  return {files:all.slice(offset,offset+limit),total:all.length,nextOffset:offset+limit<all.length?offset+limit:null,note:"Only real local files are listed. Diagnostic screenshots/logs are hidden by default. Use file to inspect or filename to prepare a non-destructive upload alias."};
}

/** Correct only links to files actually present in this chat; never publish disk paths. */
export function publicFileLinks(owner:string,chat:string,speech:string){
  if(!/\]\(\/(?:workspace|data)\/harvey-work\//.test(speech))return speech;
  const links=new Map<string,string>();
  for(const file of files(owner,chat)){links.set(file.path,file.download);links.set(file.path.replace(/^\/data\//,"/workspace/"),file.download);}
  return speech.replace(/\]\(([^)\s]+)\)/g,(whole,path)=>links.has(path)?`](${links.get(path)})`:whole);
}
