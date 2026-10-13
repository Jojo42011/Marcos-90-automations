import { accessSync, constants, realpathSync, statSync, openSync, readSync, closeSync, linkSync, existsSync, mkdirSync } from "fs";
import { basename, extname, join, resolve, sep } from "path";
import { randomUUID } from "crypto";
export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024 * 1024;
export function uploadFile(root: string, raw: unknown, filename?: string) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Choose a file from workspace_files");
  const base=realpathSync(root), lexical=resolve(root,raw);
  if(!lexical.startsWith(base+sep))throw new Error("Upload files must belong to this chat's browser workspace");
  const path=realpathSync(lexical);
  if(!path.startsWith(base+sep))throw new Error("Upload file resolves outside this chat workspace");
  const info=statSync(path);if(!info.isFile()||info.size===0||info.size>MAX_WORKSPACE_FILE_BYTES)throw new Error("Upload requires a nonempty regular file of at most 1 GiB");
  accessSync(path,constants.R_OK);
  const head=Buffer.alloc(32),fd=openSync(path,"r");try{readSync(fd,head,0,head.length,0);}finally{closeSync(fd);}
  let mime="application/octet-stream",extension="";
  if(head.toString("ascii",4,8)==="ftyp"){extension=head.toString("ascii",8,12)==="qt  "?".mov":".mp4";mime=extension===".mov"?"video/quicktime":"video/mp4";}
  else if(head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){extension=".png";mime="image/png";}
  else if(head[0]===255&&head[1]===216&&head[2]===255){extension=".jpg";mime="image/jpeg";}
  else if(head.toString("ascii",0,4)==="RIFF"&&head.toString("ascii",8,12)==="WEBP"){extension=".webp";mime="image/webp";}
  let uploadPath=path;
  // Retain the original download. Hard links give extensionless browser downloads a
  // useful upload name without copying hundreds of MB or rewriting the media.
  if(filename || (!extname(path)&&extension)){
    const name=filename||basename(path)+extension;
    if(basename(name)!==name||name.startsWith(".")||!/^[a-zA-Z0-9 _.-]{1,140}$/.test(name))throw new Error("Use a plain upload filename, not a path");
    if(extension&&![extension, ...(extension===".jpg"?[".jpeg"]:[])].includes(extname(name).toLowerCase()))throw new Error("Upload filename extension must match detected file content: "+extension);
    const folder=join(base,".uploads");mkdirSync(folder,{recursive:true});
    if(realpathSync(folder)!==folder)throw new Error("Upload alias directory must not be a symbolic link");
    uploadPath=join(folder,name);
    if(existsSync(uploadPath)){
      const old=statSync(uploadPath);if(old.ino!==info.ino||old.dev!==info.dev)uploadPath=join(folder,randomUUID()+"-"+name);
    }
    if(!existsSync(uploadPath))linkSync(path,uploadPath);
  }
  return {path:uploadPath,originalPath:path,name:basename(uploadPath),size:info.size,mime,detectedExtension:extension||null};
}
export function uploadArguments(root:string,input:any){
  if(input.cancel===true){if(input.paths?.length||input.files?.length)throw new Error("Choose upload paths or cancel, not both");return {paths:[]};}
  if(input.paths!==undefined&&input.files!==undefined)throw new Error("Use paths only, not both paths and files");
  const paths=input.paths??input.files;
  if(!Array.isArray(paths)||paths.length<1||paths.length>20)throw new Error("browser_file_upload requires paths: [absolute workspace file paths]. Missing paths never cancels the chooser; use cancel:true explicitly to cancel.");
  return {paths:paths.map((p:unknown)=>uploadFile(root,p).path)};
}
