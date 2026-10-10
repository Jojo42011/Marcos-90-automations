"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAccountJson = readAccountJson;
exports.proxyAccount = proxyAccount;
const node_http_1 = __importDefault(require("node:http"));
const users_js_1 = require("./users.js");
const workspaceAccess_js_1 = require("./workspaceAccess.js");
const accountFederation_js_1 = require("./accountFederation.js");
const store_js_1 = require("../harvey/work/store.js");
const accountBridge_js_1 = require("./accountBridge.js");
async function readAccountJson(req) {
    if (!String(req.headers["content-type"] || "").includes("application/json") || ["GET", "HEAD"].includes(req.method))
        return undefined;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024)
            throw new Error("Request exceeds 32 MB");
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString();
    return raw ? JSON.parse(raw) : {};
}
function headers(req, body, owner) {
    const result = { ...req.headers, "x-forwarded-proto": req.protocol };
    delete result["x-account-owner"];
    delete result["x-internal-call"];
    delete result["x-account-bridge"];
    delete result["x-account-actor"];
    const actor = (0, accountBridge_js_1.accountBridgeUser)(req);
    if (owner && actor) {
        result["x-account-bridge"] = (0, accountBridge_js_1.accountBridgeToken)(owner);
        result["x-account-actor"] = actor.id;
    }
    if (body) {
        delete result["transfer-encoding"];
        result["content-length"] = String(body.length);
    }
    return result;
}
function jsonRequest(req, port, path, body, owner) {
    return new Promise((resolve, reject) => {
        const upstream = node_http_1.default.request({ host: "127.0.0.1", port, path, method: req.method, headers: headers(req, body, owner) }, incoming => {
            const chunks = [];
            let size = 0;
            incoming.on("data", chunk => { size += chunk.length; if (size > 100 * 1024 * 1024)
                upstream.destroy(new Error("Account response too large"));
            else
                chunks.push(chunk); });
            incoming.on("error", reject);
            incoming.on("end", () => {
                try {
                    if ((incoming.statusCode || 500) >= 400)
                        throw new Error(`Account service returned ${incoming.statusCode}; combined results withheld`);
                    resolve(JSON.parse(Buffer.concat(chunks).toString()));
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        upstream.setTimeout(60000, () => upstream.destroy(new Error("Account service timed out")));
        upstream.on("error", reject);
        upstream.end(body);
    });
}
function workOwner(path, body, actor) {
    const match = path.match(/^\/api\/harvey\/(conversations|projects|work\/(?:chats|files|browser|jobs|schedules))\/([^/]+)/);
    const kind = match ? ({ conversations: "chat", projects: "project", "work/chats": "chat", "work/files": "chat", "work/browser": "chat", "work/jobs": "job", "work/schedules": "schedule" }[match[1]]) : undefined;
    const id = match ? decodeURIComponent(match[2]) : path === "/api/harvey/chat" ? body?.conversationId : body?.chatId || body?.projectId;
    if (!id)
        return;
    const rows = (0, store_js_1.workDb)().prepare("SELECT owner FROM records WHERE kind=? AND id=?").all(kind || (body?.projectId && !body?.chatId && !body?.conversationId ? "project" : "chat"), id);
    const allowed = rows.filter(r => (0, workspaceAccess_js_1.canViewWorkspace)(actor, r.owner));
    if (allowed.length !== 1)
        throw Object.assign(new Error("Chat or project unavailable"), { status: 404 });
    return allowed[0].owner;
}
async function proxyAccount(req, res, actor, ensureWorker) {
    const combined = (0, workspaceAccess_js_1.memberName)(actor) === "carlos";
    const originalBody = await readAccountJson(req), owners = new Set();
    const bodyValue = (0, accountFederation_js_1.decodeReferences)(originalBody, actor, owners);
    const url = new URL(req.originalUrl, "http://account.local");
    url.pathname = url.pathname.split("/").map(part => encodeURIComponent((0, accountFederation_js_1.decodeReferences)(decodeURIComponent(part), actor, owners))).join("/");
    for (const [key, value] of url.searchParams)
        url.searchParams.set(key, (0, accountFederation_js_1.decodeReferences)(value, actor, owners));
    const explicit = req.headers["x-account-owner"];
    if (explicit) {
        if (typeof explicit !== "string" || !(0, workspaceAccess_js_1.canViewWorkspace)(actor, explicit))
            throw new Error("Account unavailable");
        owners.add(explicit);
    }
    if (bodyValue?.accountOwnerId) {
        if (!(0, workspaceAccess_js_1.canViewWorkspace)(actor, bodyValue.accountOwnerId))
            throw new Error("Account unavailable");
        owners.add(bodyValue.accountOwnerId);
        delete bodyValue.accountOwnerId;
        delete bodyValue.accountOwnerName;
    }
    const personal = /^\/api\/(?:tasks(?:\/|$)|team(?:\/|$)|settings\/|account\/|knowledge(?:\/|$))/.test(req.path);
    if (personal && owners.size)
        throw new Error("This action uses the signed-in account");
    if (req.path.startsWith("/api/harvey/")) {
        const owner = workOwner(req.path, bodyValue, actor);
        if (owner)
            owners.add(owner);
    }
    if (owners.size > 1)
        throw new Error("Select records belonging to one account for this action");
    const owner = [...owners][0] || actor.id;
    const path = url.pathname + url.search, body = bodyValue === undefined ? undefined : Buffer.from(JSON.stringify(bodyValue));
    if (combined && !owners.size && (0, accountFederation_js_1.combinedRead)(req.method, req.path)) {
        const accounts = (0, users_js_1.getUsers)().filter(u => (0, workspaceAccess_js_1.canViewWorkspace)(actor, u.id));
        const results = await Promise.all(accounts.map(async (u) => {
            const data = await jsonRequest(req, await ensureWorker(u.id), path, body, u.id);
            if (req.path.startsWith("/api/harvey/")) {
                for (const key of ["conversations", "projects", "schedules", "runs"])
                    if (Array.isArray(data[key]))
                        data[key] = data[key].map((r) => ({ ...r, accountOwnerId: u.id, accountOwnerName: u.name }));
                return data;
            }
            const scoped = (0, accountFederation_js_1.scopeRecords)(data, u);
            if (req.path === "/api/crm/lead-metrics")
                scoped.metrics = Object.fromEntries(Object.entries(scoped.metrics || {}).map(([id, value]) => [(0, accountFederation_js_1.accountReference)(u.id, id), value]));
            return scoped;
        }));
        const result = (0, accountFederation_js_1.combineValues)(results);
        if (req.path === "/api/dashboard/data") {
            result.commandTasksSummary = results[accounts.findIndex(u => u.id === actor.id)].commandTasksSummary;
            result.accountSummaries = accounts.map((u, i) => ({ ownerId: u.id, name: u.name, totals: results[i].totals }));
            result.users = accounts.map(({ passwordHash, ...safe }) => safe);
            result.leads.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
        }
        if (result.conversations)
            result.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (req.path === "/api/finance/gci") {
            const months = new Map();
            for (const month of result.monthlyTrend) {
                const old = months.get(month.month) || { month: month.month, gross: 0, net: 0 };
                old.gross += month.gross;
                old.net += month.net;
                months.set(month.month, old);
            }
            result.monthlyTrend = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
        }
        if (req.path === "/api/finance/expense-summary") {
            result.biggestThisWeek = results.map(r => r.biggestThisWeek).filter(Boolean).sort((a, b) => b.amount - a.amount)[0] || null;
            for (const [key, count, rate] of [["costPerLeadBySource", "leads", "costPerLead"], ["costPerClosedBySource", "closings", "costPerClose"]])
                for (const value of Object.values(result[key] || {}))
                    value[rate] = value[count] > 0 ? Math.round(value.spend / value[count] * 100) / 100 : null;
        }
        if (req.path === "/api/finance/projection") {
            const avg = result.deals.length ? result.deals.reduce((sum, d) => sum + d.stageWeightPct, 0) / result.deals.length : 0;
            result.confidence = avg >= 75 ? "high" : avg >= 50 ? "medium" : "low";
        }
        res.json(result);
        return;
    }
    const target = (0, users_js_1.getUsers)().find(u => u.id === owner);
    if (!target || !(0, workspaceAccess_js_1.canViewWorkspace)(actor, owner))
        throw new Error("Account unavailable");
    const port = await ensureWorker(owner);
    const upstream = node_http_1.default.request({ host: "127.0.0.1", port, path, method: req.method, headers: headers(req, body, owner) }, incoming => {
        if ((combined && (0, accountFederation_js_1.businessPath)(req.path) || req.path.startsWith("/api/harvey/")) && String(incoming.headers["content-type"]).includes("application/json")) {
            const chunks = [];
            incoming.on("data", c => chunks.push(c));
            incoming.on("error", () => res.destroy());
            incoming.on("end", () => { try {
                const data = JSON.parse(Buffer.concat(chunks).toString());
                res.status(incoming.statusCode || 502).json(req.path.startsWith("/api/harvey/") ? { ...data, accountOwnerId: target.id, accountOwnerName: target.name } : (0, accountFederation_js_1.scopeRecords)(data, target));
            }
            catch {
                if (!res.headersSent)
                    res.status(502).json({ error: "Invalid account response" });
            } });
        }
        else {
            res.writeHead(incoming.statusCode || 502, { ...incoming.headers, "cache-control": "no-store" });
            incoming.pipe(res);
        }
    });
    upstream.on("error", () => { if (!res.headersSent)
        res.status(502).json({ error: "Account service unavailable; request was not retried" });
    else
        res.destroy(); });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => { if (!res.writableEnded)
        upstream.destroy(); });
    if (body)
        upstream.end(body);
    else
        req.pipe(upstream);
}
