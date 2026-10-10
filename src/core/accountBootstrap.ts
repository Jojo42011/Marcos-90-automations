import { createUser, getUsers, backupAccountIdentities, updateUser } from "./users.js";
import { hashPassword, getSecurityState, setSecurityState } from "./authStore.js";
import { ROLE_PERMISSIONS } from "./types.js";

/** One-time requested login repair; preserve IDs, business records and other users. */
export function bootstrapAccounts(): void {
  const marker = "team-access-logins-2026-10-10";
  if (getSecurityState(marker)) return;
  const users = getUsers();
  for (const name of ["marco", "wesley", "carlos"]) {
    const candidates = users.filter(u => u.name.trim().split(/\s+/)[0].toLowerCase() === name);
    if (candidates.length > 1 || users.some(u => u.email.toLowerCase() === `${name}@example.com` && u.id !== candidates[0]?.id))
      throw new Error(`Ambiguous ${name} identity; account repair stopped without changes`);
  }
  backupAccountIdentities();
  for (const name of ["Marco", "Wesley", "Carlos"]) {
    const existing = getUsers().find(u => u.name.trim().split(/\s+/)[0].toLowerCase() === name.toLowerCase());
    if (existing) {
      updateUser(existing.id, { email: `${name.toLowerCase()}@example.com`, passwordHash: hashPassword("1234"), mustChangePassword: false, active: true });
      continue;
    }
    const role = name === "Marco" ? "admin" : "agent";
    createUser({ name, email: `${name.toLowerCase()}@example.com`, role,
      permissions: { ...ROLE_PERMISSIONS[role] }, active: true, avatarInitials: name.slice(0,2), avatarColor: "#0e7490",
      passwordHash: hashPassword("1234"), mustChangePassword: false });
  }
  setSecurityState(marker, "done");
}
