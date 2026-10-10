"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accountReference = accountReference;
exports.parseAccountReference = parseAccountReference;
exports.scopeRecords = scopeRecords;
exports.decodeReferences = decodeReferences;
exports.combinedRead = combinedRead;
exports.businessPath = businessPath;
exports.combineValues = combineValues;
const workspaceAccess_js_1 = require("./workspaceAccess.js");
// References are presentation-only. Original record IDs and files are never rewritten.
function accountReference(owner, id) {
    return `acct.${Buffer.from(owner).toString("base64url")}.${Buffer.from(id).toString("base64url")}`;
}
function parseAccountReference(value) {
    const match = /^acct\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match)
        return null;
    const owner = Buffer.from(match[1], "base64url").toString(), id = Buffer.from(match[2], "base64url").toString();
    if (accountReference(owner, id) !== value)
        throw new Error("Invalid account reference");
    return { owner, id };
}
const idKeys = new Set(["id", "leadId", "contactId", "dealId", "transactionId", "recordId", "documentId", "docId", "taskId", "templateId", "planId", "enrollmentId"]);
const sharedKeys = new Set(["users", "commandTasksSummary", "commandTasks"]);
function scopeRecords(value, owner, key = "") {
    if (sharedKeys.has(key))
        return value;
    if (Array.isArray(value))
        return value.map(v => scopeRecords(v, owner, key));
    if (value && typeof value === "object") {
        const result = Object.fromEntries(Object.entries(value).filter(([k]) => k !== "passwordHash").map(([k, v]) => [k, scopeRecords(v, owner, k)]));
        if (typeof value.id === "string" || typeof value.id === "number")
            Object.assign(result, { accountOwnerId: owner.id, accountOwnerName: owner.name });
        return result;
    }
    return (typeof value === "string" || typeof value === "number") && value !== "" && idKeys.has(key) ? accountReference(owner.id, String(value)) : value;
}
function decodeReferences(value, actor, owners) {
    if (typeof value === "string") {
        const ref = parseAccountReference(value);
        if (!ref)
            return value;
        if (!(0, workspaceAccess_js_1.canViewWorkspace)(actor, ref.owner))
            throw new Error("Account unavailable");
        owners.add(ref.owner);
        return ref.id;
    }
    if (Array.isArray(value))
        return value.map(v => decodeReferences(v, actor, owners));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeReferences(v, actor, owners)]));
    return value;
}
function combinedRead(method, path) {
    return method === "POST" && path === "/api/leads/filter" || method === "GET" && new Set([
        "/api/dashboard/data", "/api/deals", "/api/transactions", "/api/tracker/records", "/api/tracker/counts",
        "/api/crm-tasks", "/api/marco-tasks", "/api/tag-templates", "/api/crm/notifications", "/api/crm/lead-metrics",
        "/api/finance/projection", "/api/finance/alerts", "/api/auto-plans", "/api/auto-plan-triggers", "/api/notes", "/api/notes/search", "/api/scheduled", "/api/email/recent", "/api/email/replies", "/api/email/active-drips-detail", "/api/deadlines/upcoming", "/api/deadlines/overdue", "/api/documents/unsigned", "/api/documents/needs-review",
        "/api/finance/commissions", "/api/finance/expenses", "/api/finance/gci", "/api/finance/expense-summary",
        "/api/harvey/conversations", "/api/harvey/projects", "/api/harvey/work/schedules"
    ]).has(path);
}
function businessPath(path) {
    return /^\/api\/(?:dashboard\/data|crm(?:\/|-tasks)|leads(?:\/|$)|deals(?:\/|$)|transactions(?:\/|$)|tracker\/(?:records|counts)|marco-tasks|tag-templates|finance\/|lead\/|auto-plans(?:\/|$)|auto-plan-triggers|notes(?:\/|$)|scheduled(?:\/|$)|email\/(?:recent|replies|active-drips-detail|detail|lead)|deadlines\/|documents\/)/.test(path);
}
/** Additive counters and record collections; shared task summaries are supplied once separately. */
function combineValues(values) {
    const defined = values.filter(v => v !== undefined && v !== null);
    if (!defined.length)
        return null;
    const first = defined[0];
    if (Array.isArray(first))
        return defined.flat();
    if (typeof first === "number")
        return defined.reduce((sum, v) => sum + v, 0);
    if (typeof first === "object")
        return Object.fromEntries([...new Set(defined.flatMap(v => Object.keys(v)))].map(k => [k, combineValues(defined.map(v => v[k]))]));
    return first;
}
