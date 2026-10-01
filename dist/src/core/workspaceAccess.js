"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.memberName = void 0;
exports.canViewWorkspace = canViewWorkspace;
exports.workspaceReadAllowed = workspaceReadAllowed;
const users_js_1 = require("./users.js");
const memberName = (user) => user.name.trim().split(/\s+/)[0].toLowerCase();
exports.memberName = memberName;
function canViewWorkspace(actor, owner) {
    if (!actor?.active)
        return false;
    if (actor.id === owner)
        return true;
    const target = (0, users_js_1.getAccountUserById)(owner);
    return (0, exports.memberName)(actor) === "carlos" && !!target?.active && ["marco", "wesley"].includes((0, exports.memberName)(target));
}
// Cross-workspace access is deliberately read-only. In particular, never invoke
// callbacks, browser actions, integrations or agents through a GET side effect.
function workspaceReadAllowed(method, path) {
    if (method !== "GET" && method !== "HEAD")
        return false;
    if (!path.startsWith("/api/"))
        return !/oauth|callback/i.test(path);
    return /^\/api\/(settings\/(command|layout)|dashboard\/data|tasks(?:\/[^/]+)?|marco-tasks|crm-tasks|users|team\/roster|harvey\/(models|conversations(?:\/[^/]+)?|projects(?:\/[^/]+)?|work\/(status|logins|plugins|schedules|files\/[^/]+(?:\/[^/]+)?)))$/.test(path);
}
