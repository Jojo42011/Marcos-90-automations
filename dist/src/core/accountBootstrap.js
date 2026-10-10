"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapAccounts = bootstrapAccounts;
const users_js_1 = require("./users.js");
const authStore_js_1 = require("./authStore.js");
const types_js_1 = require("./types.js");
/** One-time requested login repair; preserve IDs, business records and other users. */
function bootstrapAccounts() {
    const marker = "team-access-logins-2026-10-10";
    if ((0, authStore_js_1.getSecurityState)(marker))
        return;
    const users = (0, users_js_1.getUsers)();
    for (const name of ["marco", "wesley", "carlos"]) {
        const candidates = users.filter(u => u.name.trim().split(/\s+/)[0].toLowerCase() === name);
        if (candidates.length > 1 || users.some(u => u.email.toLowerCase() === `${name}@example.com` && u.id !== candidates[0]?.id))
            throw new Error(`Ambiguous ${name} identity; account repair stopped without changes`);
    }
    (0, users_js_1.backupAccountIdentities)();
    for (const name of ["Marco", "Wesley", "Carlos"]) {
        const existing = (0, users_js_1.getUsers)().find(u => u.name.trim().split(/\s+/)[0].toLowerCase() === name.toLowerCase());
        if (existing) {
            (0, users_js_1.updateUser)(existing.id, { email: `${name.toLowerCase()}@example.com`, passwordHash: (0, authStore_js_1.hashPassword)("1234"), mustChangePassword: false, active: true });
            continue;
        }
        const role = name === "Marco" ? "admin" : "agent";
        (0, users_js_1.createUser)({ name, email: `${name.toLowerCase()}@example.com`, role,
            permissions: { ...types_js_1.ROLE_PERMISSIONS[role] }, active: true, avatarInitials: name.slice(0, 2), avatarColor: "#0e7490",
            passwordHash: (0, authStore_js_1.hashPassword)("1234"), mustChangePassword: false });
    }
    (0, authStore_js_1.setSecurityState)(marker, "done");
}
