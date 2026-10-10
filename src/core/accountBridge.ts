import {randomBytes,timingSafeEqual} from "crypto";
import type {IncomingMessage} from "http";
import {getAccountUserById} from "./users.js";
import {canViewWorkspace} from "./workspaceAccess.js";
const tokens=new Map<string,string>();
let gatewayUrl="",childToken="";
export function issueAccountBridge(owner:string){const token=randomBytes(32).toString("hex");tokens.set(owner,token);return token;}
export function accountBridgeToken(owner:string){return tokens.get(owner);}
process.on("message",(message:any)=>{
  if(process.env.TENANT_OWNER_ID && message?.type==="account-bridge") {
    childToken=message.token;gatewayUrl=message.url;tokens.set(process.env.TENANT_OWNER_ID,childToken);
  }
});
export function accountBridgeUser(req:IncomingMessage|{headers:Record<string,unknown>;socket?:{remoteAddress?:string}}){
  const address=req.socket?.remoteAddress;
  if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(address))return null;
  const value=req.headers["x-account-bridge"];
  if(typeof value!=="string" || !/^[a-f0-9]{64}$/.test(value))return null;
  for(const [owner,token] of tokens)if(timingSafeEqual(Buffer.from(value),Buffer.from(token))){
    const forwarded=process.env.TENANT_OWNER_ID && req.headers["x-account-actor"];
    const user=getAccountUserById(typeof forwarded==="string"?forwarded:owner);
    return user?.active&&!user.mustChangePassword&&canViewWorkspace(user,owner)?user:null;
  }
  return null;
}
export async function accountBridgeFetch(path:string,options:RequestInit={}){
  if(!gatewayUrl || !childToken)throw new Error("Team CRM bridge is not ready");
  if(!path.startsWith("/api/")||path.startsWith("//"))throw new Error("Invalid CRM path");
  return fetch(gatewayUrl+path,{...options,redirect:"error",headers:{...options.headers,"x-account-bridge":childToken}});
}
