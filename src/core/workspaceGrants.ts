import { getSecurityState, setSecurityState } from "./authStore.js";
import { getUsers } from "./users.js";
const KEY="workspace-owner-ids-v1";
type Roles=Partial<Record<"marco"|"wesley"|"carlos",string>>;
/** Resolve historical names once, then retain immutable identities across renames. */
export function initializeWorkspaceGrants(): void {
  if(getSecurityState(KEY))return;
  if(process.env.TENANT_OWNER_ID)throw new Error("Workspace grants must be initialized by the gateway");
  const roles:Roles={};
  for(const name of ["marco","wesley","carlos"] as const){
    const candidates=getUsers().filter(u=>u.name.trim().split(/\s+/)[0].toLowerCase()===name);
    if(candidates.length>1)throw new Error(`Ambiguous ${name} workspace identity; no permissions changed`);
    if(candidates.length===1)roles[name]=candidates[0].id;
  }
  setSecurityState(KEY,JSON.stringify(roles));
}
export function workspaceRoles(): Roles {
  const raw=getSecurityState(KEY);
  return raw?JSON.parse(raw):{};
}
export function combinedWorkspaceUser(id:string):boolean {return workspaceRoles().carlos===id;}

export function workspaceMember(id:string):string {
  return Object.entries(workspaceRoles()).find(([,owner])=>owner===id)?.[0] || id;
}
