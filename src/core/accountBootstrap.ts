import { createHash } from "node:crypto";
import { createUser, getUsers, saveUsers, updateUser } from "./users.js";
import { hashPassword, getSecurityState, setSecurityState } from "./authStore.js";
import { ROLE_PERMISSIONS } from "./types.js";

/** Provision missing testing accounts once; never reset a person's existing password. */
export function bootstrapAccounts(): void {
  const marker = "isolated-accounts-2026-09-30";
  if (getSecurityState(marker)) return;
  // Retired roster identity, matched without retaining its display name in the application.
  const retired = "260670134225f2a24b59121739fec73584b0ddb6b49c39e31bd1df5483ac144d";
  saveUsers(getUsers().filter(u => createHash("sha256").update(u.name.trim().split(/\s+/)[0].toLowerCase()).digest("hex") !== retired));
  for (const name of ["Marco", "Wesley", "Carlos"]) {
    const existing = getUsers().find(u => u.name.trim().split(/\s+/)[0].toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!existing.passwordHash && existing.active) updateUser(existing.id, { passwordHash: hashPassword("1234"), mustChangePassword: false });
      continue;
    }
    const role = name === "Marco" ? "admin" : "agent";
    createUser({ name, email: `${name.toLowerCase()}@example.com`, role,
      permissions: { ...ROLE_PERMISSIONS[role] }, active: true, avatarInitials: name.slice(0,2), avatarColor: "#0e7490",
      passwordHash: hashPassword("1234"), mustChangePassword: false });
  }
  setSecurityState(marker, "done");
}
