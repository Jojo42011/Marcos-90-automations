import { getUsers, updateUser, backupAccountIdentities } from "./users.js";
import { hashPassword } from "./authStore.js";
import { initializeWorkspaceGrants } from "./workspaceGrants.js";

/** Never reset existing logins during startup or re-enable a disabled account. */
export function bootstrapAccounts(): void {
  const password=process.env.ACCOUNT_BOOTSTRAP_PASSWORD;
  if(password && password.length<12)throw new Error("ACCOUNT_BOOTSTRAP_PASSWORD must contain at least 12 characters");
  if(password) {
    const unconfigured=getUsers().filter(u=>u.active && !u.passwordHash);
    if(unconfigured.length)backupAccountIdentities();
    for(const user of unconfigured)updateUser(user.id,{passwordHash:hashPassword(password),mustChangePassword:true});
  }
  initializeWorkspaceGrants();
}
