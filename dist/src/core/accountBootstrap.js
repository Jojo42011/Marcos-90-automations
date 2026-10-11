"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapAccounts = bootstrapAccounts;
const users_js_1 = require("./users.js");
const authStore_js_1 = require("./authStore.js");
const workspaceGrants_js_1 = require("./workspaceGrants.js");
/** Never reset existing logins during startup or re-enable a disabled account. */
function bootstrapAccounts() {
    const password = process.env.ACCOUNT_BOOTSTRAP_PASSWORD;
    if (password && password.length < 12)
        throw new Error("ACCOUNT_BOOTSTRAP_PASSWORD must contain at least 12 characters");
    if (password) {
        const unconfigured = (0, users_js_1.getUsers)().filter(u => u.active && !u.passwordHash);
        if (unconfigured.length)
            (0, users_js_1.backupAccountIdentities)();
        for (const user of unconfigured)
            (0, users_js_1.updateUser)(user.id, { passwordHash: (0, authStore_js_1.hashPassword)(password), mustChangePassword: true });
    }
    (0, workspaceGrants_js_1.initializeWorkspaceGrants)();
}
