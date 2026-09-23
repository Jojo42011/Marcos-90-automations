import { readdirSync, statSync, mkdirSync, realpathSync } from "fs";
import { join, basename, sep } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { browserDirectory } from "./browser.js";
export function filesDir(owner: string, chat: string) { const dir = join(browserDirectory(owner,chat),"files");mkdirSync(dir,{recursive:true});return dir; }
export function filePath(owner: string, chat: string, name: string) {
  if(!name || basename(name)!==name || name.startsWith("."))throw new Error("Use a file name from this chat's workspace");
  const root=realpathSync(filesDir(owner,chat)),p=realpathSync(join(root,name));if(!p.startsWith(root+sep))throw new Error("File is outside this chat");return p;
}
export function files(owner: string, chat: string) {const dir=filesDir(owner,chat);return readdirSync(dir).filter(n=>!n.startsWith(".")&&statSync(join(dir,n)).isFile()).map(name=>({name,size:statSync(join(dir,name)).size,path:join(dir,name)}));}
export async function editVideo(owner: string, chat: string, input: any) {
  const source=filePath(owner,chat,String(input.file||""));
  const start=Number(input.startSeconds||0),duration=Number(input.durationSeconds);
  if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0||duration>3600)throw new Error("Choose a nonnegative start and a duration up to one hour");
  const name=`edited-${randomUUID()}.mp4`,output=join(filesDir(owner,chat),name);
  const args=["-nostdin","-hide_banner","-loglevel","error","-protocol_whitelist","file,pipe","-format_whitelist","mov,matroska,webm,avi,mpegts,mpeg","-ss",String(start),"-i",source,"-t",String(duration),"-map","0:v:0","-map","0:a?","-c:v","libx264","-preset","fast","-crf","22","-threads","2"];
  if(input.mute===true)args.push("-an");else args.push("-c:a","aac");
  args.push("-movflags","+faststart",output);
  await new Promise<void>((resolve,reject)=>{const child=spawn(process.env.FFMPEG_PATH||"ffmpeg",args,{windowsHide:true,stdio:["ignore","ignore","pipe"]});let stderr="";const timer=setTimeout(()=>{child.kill();reject(new Error("Video edit timed out after ten minutes"));},600000);child.stderr.on("data",b=>{stderr=(stderr+b).slice(-2000);});child.on("error",()=>{clearTimeout(timer);reject(new Error("FFmpeg is not installed on this worker"));});child.on("close",code=>{clearTimeout(timer);code===0?resolve():reject(new Error("Video edit failed: "+stderr));});});
  return {file:name,path:output,download:`/api/harvey/work/files/${chat}/${name}`,note:"Trim/transcode completed. Review the output before publishing."};
}
