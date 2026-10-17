import { readdirSync, statSync, mkdirSync, realpathSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "fs";
import { createHash, randomUUID } from 'crypto';
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
const digest=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
function textName(value:any):string {
  if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,139}$/.test(value)||! /\.(?:txt|md|csv|tsv|json|yaml|yml|xml|html)$/i.test(value))throw Error('Use a plain text filename in this chat, such as report.md, records.csv or plan.json; no directories');
  return value;
}
export function writeWorkspaceFile(owner:string,chat:string,input:any) {
  const name=textName(input.file);
  if(typeof input.content!=='string'||Buffer.byteLength(input.content)>2*1024*1024||input.content.includes('\0'))throw Error('Provide UTF-8 text content of at most 2 MiB; split large artifacts into files');
  if(/\.json$/i.test(name))try{JSON.parse(input.content);}catch{throw Error('Invalid JSON content; correct it before saving');}
  const path=join(filesDir(owner,chat),name),sha256=digest(input.content);
  if(existsSync(path)){
    if(statSync(filePath(owner,chat,name)).size>2*1024*1024)throw Error('Existing text file exceeds the artifact edit size; retain it and create a separate smaller file');
    const old=readFileSync(filePath(owner,chat,name));
    if(digest(old)===sha256)return {file:name,sha256,size:old.length,download:`/api/harvey/work/files/${chat}/${encodeURIComponent(name)}`,unchanged:true};
    if(input.expectedSha256!==digest(old))throw Error('File already exists with different content. Read it first and pass its expectedSha256 to replace it');
  }else if(input.expectedSha256)throw Error('File no longer exists; inspect the current workspace before replacing it');
  const pending=join(filesDir(owner,chat),'.text-'+randomUUID());
  try{writeFileSync(pending,input.content,{encoding:'utf8',flag:'wx',mode:0o600});renameSync(pending,path);}finally{if(existsSync(pending))unlinkSync(pending);}
  return {file:name,sha256,size:Buffer.byteLength(input.content),download:`/api/harvey/work/files/${chat}/${encodeURIComponent(name)}`,note:'Bytes saved. Read with workspace_read and check the requested content before reporting completion. Authored text is not independent evidence of external facts.'};
}
export function readWorkspaceFile(owner:string,chat:string,input:any) {
  const name=textName(input.file),path=filePath(owner,chat,name);
  if(statSync(path).size>2*1024*1024)throw Error('Text file exceeds 2 MiB; use a smaller artifact');
  const bytes=readFileSync(path);let content:string;
  try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('File is not valid UTF-8 text');}
  if(content.includes('\0'))throw Error('File contains binary data; use the appropriate media tool');
  const offset=input.offset??0,limit=input.limit??8000;
  if(!Number.isSafeInteger(offset)||offset<0||offset>content.length||!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('Use a valid character offset and limit from 1 to 10000');
  const end=Math.min(content.length,offset+limit);
  return {file:name,content:content.slice(offset,end),offset,nextOffset:end<content.length?end:null,totalCharacters:content.length,sha256:digest(bytes),truncated:offset>0||end<content.length,download:`/api/harvey/work/files/${chat}/${encodeURIComponent(name)}`};
}
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
  if(!/\]\((?:\/(?:workspace|data)\/harvey-work\/|(?:https?:\/\/[^/\s)]+)?\/api\/harvey\/work\/files\/)/.test(speech))return speech;
  const links=new Map<string,string>();
  const downloads=new Set<string>();
  for(const file of files(owner,chat)){links.set(file.path,file.download);links.set(file.path.replace(/^\/data\//,"/workspace/"),file.download);downloads.add(file.download);}
  return speech.replace(/\]\(([^)\s]+)\)/g,(whole,path)=>{
    if(links.has(path))return `](${links.get(path)})`;
    try{const url=new URL(path,'https://harvey.invalid');if(downloads.has(url.pathname))return `](${url.pathname})`;}catch{}
    return whole;
  });
}
