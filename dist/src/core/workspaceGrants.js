"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeWorkspaceGrants = initializeWorkspaceGrants;
exports.workspaceRoles = workspaceRoles;
exports.combinedWorkspaceUser = combinedWorkspaceUser;
exports.workspaceMember = workspaceMember;
const authStore_js_1 = require("./authStore.js");
const users_js_1 = require("./users.js");
const KEY = "workspace-owner-ids-v1";
/** Resolve historical names once, then retain immutable identities across renames. */
function initializeWorkspaceGrants() {
    if ((0, authStore_js_1.getSecurityState)(KEY))
        return;
    if (process.env.TENANT_OWNER_ID)
        throw new Error("Workspace grants must be initialized by the gateway");
    const roles = {};
    for (const name of ["marco", "wesley", "carlos"]) {
        const candidates = (0, users_js_1.getUsers)().filter(u => u.name.trim().split(/\s+/)[0].toLowerCase() === name);
        if (candidates.length > 1)
            throw new Error(`Ambiguous ${name} workspace identity; no permissions changed`);
        if (candidates.length === 1)
            roles[name] = candidates[0].id;
    }
    (0, authStore_js_1.setSecurityState)(KEY, JSON.stringify(roles));
}
function workspaceRoles() {
    const raw = (0, authStore_js_1.getSecurityState)(KEY);
    return raw ? JSON.parse(raw) : {};
}
function combinedWorkspaceUser(id) { return workspaceRoles().carlos === id; }
function workspaceMember(id) {
    return Object.entries(workspaceRoles()).find(([, owner]) => owner === id)?.[0] || id;
}
