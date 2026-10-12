import { spawn } from "node:child_process";
import { statSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const formats="mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mpeg";
const inputOptions=["-protocol_whitelist","file,pipe","-format_whitelist",formats];
class MediaError extends Error {
  constructor(public code:string,message:string,public detail="",public retryable=false){super(message);}
}
function command(binary:string,args:string[],signal?:AbortSignal,timeout=90_000):Promise<string>{
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="",reason="",killTimer:ReturnType<typeof setTimeout>|undefined;
    const stop=(why:string)=>{if(reason)return;reason=why;child.kill();killTimer=setTimeout(()=>child.kill("SIGKILL"),3000);killTimer.unref();};
    const abort=()=>stop("cancelled"),timer=setTimeout(()=>stop("timeout"),timeout);timer.unref();
    signal?.addEventListener("abort",abort,{once:true});
    const cleanup=()=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener("abort",abort);};
    child.stdout.on("data",b=>{stdout+=b;if(stdout.length>2_000_000)stop("output_limit");});
    child.stderr.on("data",b=>stderr=(stderr+b).slice(-5000));
    child.on("error",()=>{cleanup();reject(new MediaError("missing_binary",basename(binary)+" could not start. Check the worker installation."));});
    child.on("close",(code,killed)=>{cleanup();
      if(code===0&&!reason){resolve(stdout);return;}
      const detail=stderr.replace(/(?:[A-Z]:[\\/]|\/data\/)[^\s\n]+/gi,"[workspace file]").slice(-1800);
      const resource=reason==="timeout"||!!killed||/allocate memory|out of memory|resource temporarily unavailable/i.test(stderr);
      reject(new MediaError(reason|| (resource?"resource_limit":/decoder.*not found|no decoder|decoding requested/i.test(stderr)?"unsupported_track":"media_command_failed"),reason==="cancelled"?"Video operation cancelled.":"Video operation failed"+(killed?" (process signal "+killed+")":" (exit "+code+")"),detail,resource));
    });
  });
}
function rate(raw:any){const [a,b]=String(raw||"").split("/").map(Number);return Number.isFinite(a)&&Number.isFinite(b)&&b>0?a!/b!:0;}
export async function inspectVideoPath(path:string,signal?:AbortSignal,countFrames=false){
  if(!statSync(path).isFile()||statSync(path).size<64)throw new MediaError("incomplete_file","This file is empty or incomplete; use the original video, not a failed output.");
  const raw=await command(process.env.FFPROBE_PATH||"ffprobe",["-v","error",...inputOptions,"-threads","1",...(countFrames?["-count_frames"]:[]),"-show_entries","format=duration,format_name:stream=index,codec_name,codec_type,width,height,pix_fmt,color_transfer,color_primaries,color_space,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration:stream_side_data=rotation","-of","json",path],signal);
  const data=JSON.parse(raw),video=data.streams?.find((s:any)=>s.codec_type==="video");
  if(!video)throw new MediaError("no_video","No readable video stream was found.");
  const duration=Number(video.duration||data.format?.duration),fps=rate(video.avg_frame_rate)||rate(video.r_frame_rate);
  if(!Number.isFinite(duration)||duration<=0||!fps)throw new MediaError("unknown_timing","Video duration or frame rate could not be established; do not guess frame limits.");
  return {file:basename(path),size:statSync(path).size,durationSeconds:duration,format:data.format?.format_name,video:{index:video.index,codec:video.codec_name,width:video.width,height:video.height,pixelFormat:video.pix_fmt,fps,frames:Number(video.nb_read_frames||video.nb_frames)||null,transfer:video.color_transfer,rotation:video.side_data_list?.find((s:any)=>s.rotation!==undefined)?.rotation||0},audio:data.streams.filter((s:any)=>s.codec_type==="audio").map((s:any)=>({index:s.index,codec:s.codec_name})),note:"Timing is measured, not inferred from filename. Container and codec are different. Keep originals; create derived exports."};
}
export function videoFailure(error:unknown){
  const e=error instanceof MediaError?error:new MediaError("video_error",error instanceof Error?error.message:String(error));
  return {error:e.message,diagnostic:{code:e.code,message:e.message,detail:e.detail,retryable:e.retryable},recovery:"Inspect the original with inspect_video and use the measured streams/timing. Do not infer unsupported MOV/ProRes from a generic failure. Do not repeat equivalent edits or ask the user to trim manually while supported local recovery is available. Report the specific diagnostic if bounded recovery is exhausted."};
}
let editQueue:Promise<unknown>=Promise.resolve();
/** Bound decoder memory and serialize exports within each account worker. */
export function exportVideo(root:string,source:string,match:string|undefined,input:any,signal?:AbortSignal){
  const operation=editQueue.then(()=>exportOne(root,source,match,input,signal));editQueue=operation.catch(()=>{});return operation;
}
async function exportOne(root:string,source:string,match:string|undefined,input:any,signal?:AbortSignal){
  signal?.throwIfAborted();
  const info=await inspectVideoPath(source,signal),other=match?await inspectVideoPath(match,signal):undefined;
  const start=Number(input.startSeconds||0),requested=Number(input.durationSeconds),fps=Number(input.fps||30);
  if(!Number.isFinite(start)||start<0||start>=info.durationSeconds||!Number.isFinite(requested)||requested<=0||requested>3600||![24,25,30,60].includes(fps))throw new MediaError("invalid_edit","Use an existing start, duration up to 3600 seconds and fps 24, 25, 30 or 60.");
  const frames=Math.floor(Math.min(requested,info.durationSeconds-start,other?.durationSeconds??Infinity)*fps+1e-6),duration=frames/fps;
  if(frames<1)throw new MediaError("invalid_edit","The requested clip is shorter than one output frame.");
  const ffmpeg=process.env.FFMPEG_PATH||"ffmpeg";
  const decoders=await command(ffmpeg,["-hide_banner","-decoders"],signal);
  const supported=new Set([...decoders.matchAll(/^\s*A[\.A-Z]{5}\s+(\S+)/gm)].map(m=>m[1]));
  const audio=input.mute===true?undefined:info.audio.find((s:any)=>s.codec==="aac"&&supported.has("aac"))||info.audio.find((s:any)=>supported.has(s.codec));
  if(input.mute!==true&&info.audio.length&&!audio)throw new MediaError("unsupported_audio","No installed decoder supports this file's audio tracks. Video-only export is available with mute:true only if losing audio is authorized.",info.audio.map((s:any)=>s.codec).join(", "));
  const hdr=["arib-std-b67","smpte2084"].includes(info.video.transfer||"");
  const fingerprint=createHash("sha256").update(JSON.stringify([source,statSync(source).size,statSync(source).mtimeMs,start,frames,fps,audio?.index,hdr,"web-v2"])).digest("hex");
  const cache=join(root,".media");mkdirSync(cache,{recursive:true});const manifest=join(cache,fingerprint+".json");
  if(existsSync(manifest)){try{const saved=JSON.parse(readFileSync(manifest,"utf8"));if(basename(saved.file)===saved.file){const checked=await inspectVideoPath(join(root,saved.file),signal,true);if(checked.video.frames===frames)return {...saved,verified:true,reused:true};}}catch{signal?.throwIfAborted();}}
  const attempts:any[]=[];
  for(let attempt=0;attempt<2;attempt++){
    const name="edited-"+randomUUID()+".mp4",temporary=join(cache,name),output=join(root,name),edge=attempt?1280:1920;
    // Explicit first compatible audio stream avoids unsupported alternate Apple APAC tracks.
    const filters=[`scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,...(hdr?["zscale=t=linear:npl=100","format=gbrpf32le","tonemap=hable:desat=0","zscale=p=bt709:t=bt709:m=bt709:r=tv"]:[]),"setsar=1",`fps=${fps}`,"format=yuv420p"];
    const args=["-nostdin","-hide_banner","-loglevel","error",...inputOptions,"-threads","1","-ss",String(start),"-i",source,"-t",String(duration),"-map","0:"+info.video.index,...(audio?["-map","0:"+audio.index]:["-an"]),"-sn","-dn","-map_metadata","-1","-vf",filters.join(","),"-filter_threads","1","-c:v","libx264","-preset",attempt?"ultrafast":"veryfast","-crf","22","-threads","1","-frames:v",String(frames),...(audio?["-c:a","aac","-b:a","160k"]:[]),"-movflags","+faststart",temporary];
    try{
      await command(ffmpeg,args,signal,240_000);
      const checked=await inspectVideoPath(temporary,signal,true);
      if(checked.video.frames!==frames||Math.abs(checked.durationSeconds-duration)>0.12||checked.video.codec!=="h264"||checked.video.pixelFormat!=="yuv420p"||(audio&&!checked.audio.length))throw new MediaError("invalid_output","Export did not pass frame count, duration, audio or codec verification.");
      renameSync(temporary,output);
      const result={file:name,path:output,source:info.file,durationSeconds:duration,frames,fps,size:checked.size,video:checked.video,audio:checked.audio,verified:true,attempts:attempt+1,recoveryAttempts:attempts,selectedAudio:audio||null,ignoredAudio:info.audio.filter((s:any)=>s.index!==audio?.index),hdrToneMapped:hdr,note:"Original preserved. Export decoded and frame count checked. Only this derived H.264/AAC MP4 is ready for upload. Selection at the destination still requires site confirmation."};
      writeFileSync(manifest,JSON.stringify(result));return result;
    }catch(error){if(existsSync(temporary))unlinkSync(temporary);signal?.throwIfAborted();const failure=videoFailure(error);attempts.push(failure.diagnostic);if(attempt||!failure.diagnostic.retryable)return {...failure,attempts};}
  }
  throw new Error("Video recovery exhausted");
}
