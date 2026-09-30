"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapAccounts = bootstrapAccounts;
const node_crypto_1 = require("node:crypto");
const users_js_1 = require("./users.js");
const authStore_js_1 = require("./authStore.js");
const types_js_1 = require("./types.js");
/** Provision missing testing accounts once; never reset a person's existing password. */
function bootstrapAccounts() {
    const marker = "isolated-accounts-2026-09-30";
    if ((0, authStore_js_1.getSecurityState)(marker))
        return;
    // Retired roster identity, matched without retaining its display name in the application.
    const retired = "260670134225f2a24b59121739fec73584b0ddb6b49c39e31bd1df5483ac144d";
    (0, users_js_1.saveUsers)((0, users_js_1.getUsers)().filter(u => (0, node_crypto_1.createHash)("sha256").update(u.name.trim().split(/\s+/)[0].toLowerCase()).digest("hex") !== retired));
    for (const name of ["Marco", "Wesley", "Carlos"]) {
        const existing = (0, users_js_1.getUsers)().find(u => u.name.trim().split(/\s+/)[0].toLowerCase() === name.toLowerCase());
        if (existing) {
            if (!existing.passwordHash && existing.active)
                (0, users_js_1.updateUser)(existing.id, { passwordHash: (0, authStore_js_1.hashPassword)("1234"), mustChangePassword: false });
            continue;
        }
        const role = name === "Marco" ? "admin" : "agent";
        (0, users_js_1.createUser)({ name, email: `${name.toLowerCase()}@example.com`, role,
            permissions: { ...types_js_1.ROLE_PERMISSIONS[role] }, active: true, avatarInitials: name.slice(0, 2), avatarColor: "#0e7490",
            passwordHash: (0, authStore_js_1.hashPassword)("1234"), mustChangePassword: false });
    }
    (0, authStore_js_1.setSecurityState)(marker, "done");
}
