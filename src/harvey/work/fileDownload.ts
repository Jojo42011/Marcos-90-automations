import https from "node:https";
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { rename, unlink, statfs, chmod } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { publicIpv4 } from "../../videoKnowledge/media.js";
import { MAX_WORKSPACE_FILE_BYTES } from "./uploadFiles.js";
export async function publicDownload(raw:string,signal:AbortSignal,redirects=0):Promise<{stream:Readable;size?:number;mime:string}>{
  const url=new URL(raw);
  if(url.protocol!=="https:"||url.username||url.password||(url.port&&url.port!=="443")||redirects>4)throw new Error("Use a public HTTPS download URL without embedded credentials");
  const addresses=await lookup(url.hostname,{family:4,all:true});signal.throwIfAborted();
  if(!addresses.length||addresses.some(a=>!publicIpv4(a.address)))throw new Error("Download address must be public");
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{signal,headers:{"Accept-Encoding":"identity"},family:4,lookup:(_host,_options,callback)=>callback(null,addresses[0]!.address,4)},response=>{
      if([301,302,303,307,308].includes(response.statusCode||0)&&response.headers.location){response.destroy();publicDownload(new URL(response.headers.location,url).href,signal,redirects+1).then(resolve,reject);return;}
      if(response.statusCode!==200){response.destroy();reject(new Error("Download returned HTTP "+response.statusCode+". Refresh the connector download link if it expired; website sign-in pages are not file downloads."));return;}
      const mime=String(response.headers['content-type']||'application/octet-stream').split(';')[0]!;
      if(mime==='text/html'){response.destroy();reject(new Error("Download returned an HTML page, not file bytes. Obtain a direct download link through the authorized connector."));return;}
      resolve({stream:response,mime,size:response.headers['content-length']?Number(response.headers['content-length']):undefined});
    });request.on('error',reject);
  });
}
/** Stream to a private temporary file; publish only after length/hash validation. */
export async function downloadFile(root:string,input:{url:string;filename:string;expectedSize?:number},signal?:AbortSignal,open=publicDownload){
  const name=input.filename;
  if(typeof name!=="string"||basename(name)!==name||name.startsWith('.')||!/^[a-zA-Z0-9 _.-]{1,140}$/.test(name))throw new Error("Choose a plain filename with the original extension");
  if(input.expectedSize!==undefined&&(!Number.isSafeInteger(input.expectedSize)||input.expectedSize<=0||input.expectedSize>MAX_WORKSPACE_FILE_BYTES))throw new Error("Expected size must be 1 byte to 1 GiB");
  const deadline=AbortSignal.timeout(8*60_000),combined=signal?AbortSignal.any([signal,deadline]):deadline;
  combined.throwIfAborted();
  const space=await statfs(root);if(space.bavail*space.bsize<(input.expectedSize||MAX_WORKSPACE_FILE_BYTES)+256*1024*1024)throw new Error("Insufficient workspace disk space for this download");
  const id=randomUUID(),part=join(root,'.download-'+id),file=join(root,id+'-'+name);
  let bytes=0;const hash=createHash('sha256');
  try{
    const response=await open(input.url,combined);
    if(response.size!==undefined&&(!Number.isSafeInteger(response.size)||response.size<=0||response.size>MAX_WORKSPACE_FILE_BYTES)){response.stream.destroy();throw new Error("Download exceeds 1 GiB or has an invalid length");}
    await pipeline(response.stream,new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>MAX_WORKSPACE_FILE_BYTES){callback(new Error("Download exceeds 1 GiB"));return;}hash.update(chunk);callback(null,chunk);}}),createWriteStream(part,{flags:'wx',mode:0o600}),{signal:combined});
    if(!bytes||(response.size!==undefined&&response.size!==bytes)||(input.expectedSize!==undefined&&input.expectedSize!==bytes))throw new Error("Downloaded byte count does not match the expected file; incomplete bytes were discarded");
    await chmod(part,0o644);await rename(part,file);
    return {name:basename(file),path:file,size:bytes,sha256:hash.digest('hex'),mime:response.mime,verified:true,note:"File bytes are now in this chat workspace. Select them with browser_file_upload after opening the site's chooser; verify the site finishes receiving them."};
  }catch(error){await unlink(part).catch(()=>{});throw error;}
}
