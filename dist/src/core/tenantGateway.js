"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tenantEnvironment = tenantEnvironment;
exports.startTenantWorkers = startTenantWorkers;
exports.isSharedInbound = isSharedInbound;
exports.isSharedAutomationConsole = isSharedAutomationConsole;
exports.accountMiddleware = accountMiddleware;
exports.accountUpgrade = accountUpgrade;
const accountInbound_js_1 = require("./accountInbound.js");
const accountIntegrations_js_1 = require("./accountIntegrations.js");
const workspaceGrants_js_1 = require("./workspaceGrants.js");
const publicLinks_js_1 = require("./publicLinks.js");
const accountProxy_js_1 = require("./accountProxy.js");
const accountPreferences_js_1 = require("./accountPreferences.js");
const accountBridge_js_1 = require("./accountBridge.js");
const crmApiSurface_js_1 = require("./crmApiSurface.js");
const chatRelay_js_1 = require("../harvey/work/chatRelay.js");
const sharedKnowledge_js_1 = require("./sharedKnowledge.js");
const knowledgeStore_js_1 = require("./knowledgeStore.js");
const workspaceAccess_js_1 = require("./workspaceAccess.js");
const sharedTasks_js_1 = require("./sharedTasks.js");
const crmRecovery_js_1 = require("./crmRecovery.js");
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_http_1 = __importDefault(require("node:http"));
const node_net_1 = __importDefault(require("node:net"));
const users_js_1 = require("./users.js");
const tenantData_js_1 = require("./tenantData.js");
// Share model infrastructure and the requested team MLS feed; other business credentials remain isolated.
const SHARED_ENV = /^(PUBLIC_BASE_URL|PATH|Path|SystemRoot|WINDIR|COMSPEC|PATHEXT|HOME|USERPROFILE|LOCALAPPDATA|TEMP|TMP|LANG|TZ|NODE_ENV|PLAYWRIGHT_BROWSERS_PATH|OPENROUTER_[A-Z_]+|ANTHROPIC_[A-Z_]+|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|ELEVENLABS_API_KEY|DEEPGRAM_API_KEY|COMPOSIO_API_KEY|SIMPLYRETS_[A-Z_]+|HARVEY_(MODEL|PUBLIC_URL|SCHEDULE_MODEL|WORKER_ENABLED|BROWSER_ENABLED|BROWSER_EXECUTABLE|VAULT_KEY|PROMPT_CACHE|REQUEST_TIMEOUT_MS)|AETHON_(MODEL|MAX_TOKENS))$/;
function tenantEnvironment(owner, parent = process.env) {
    const root = (0, node_path_1.join)((0, tenantData_js_1.dataPath)(), "accounts", (0, node_crypto_1.createHash)("sha256").update(owner).digest("hex"));
    (0, node_fs_1.mkdirSync)(root, { recursive: true });
    const marco = (0, users_js_1.getUsers)().filter(u => u.id === (0, workspaceGrants_js_1.workspaceRoles)().marco);
    if (marco.length === 1 && marco[0].id === owner)
        (0, crmRecovery_js_1.recoverMarcoCrm)((0, tenantData_js_1.dataPath)(), root, parent.DB_JSON_PATH);
    const emptyEnv = (0, node_path_1.join)(root, ".empty-env");
    (0, node_fs_1.writeFileSync)(emptyEnv, "");
    const env = {};
    for (const [key, value] of Object.entries(parent))
        if (SHARED_ENV.test(key))
            env[key] = value;
    // Identity is shared; business stores and in-memory state are not.
    env.SHARED_KNOWLEDGE_DB_PATH = parent.SHARED_KNOWLEDGE_DB_PATH || (0, tenantData_js_1.dataPath)("shared-knowledge.db");
    env.LISTINGS_DB_PATH = parent.LISTINGS_DB_PATH || (0, tenantData_js_1.dataPath)("listings.db");
    env.SHARED_TASK_DB_PATH = parent.SHARED_TASK_DB_PATH || (0, tenantData_js_1.dataPath)("shared-tasks.db");
    env.TENANT_MEMBER = (0, workspaceGrants_js_1.workspaceMember)(owner);
    env.AUTH_DB_PATH = parent.AUTH_DB_PATH || (0, tenantData_js_1.dataPath)("auth.db");
    env.USERS_JSON_PATH = parent.USERS_JSON_PATH || (0, node_path_1.join)((0, node_path_1.dirname)(parent.DB_JSON_PATH || (0, tenantData_js_1.dataPath)("db.json")), "users.json");
    // Work already has enforced owner keys. Keeping it preserves existing chats/connections.
    env.HARVEY_WORK_DIR = parent.HARVEY_WORK_DIR || (0, tenantData_js_1.dataPath)("harvey-work");
    return { ...env, ...(0, accountIntegrations_js_1.accountIntegrationEnvironment)(owner), TENANT_OWNER_ID: owner, TENANT_DATA_ROOT: root, ACCOUNT_ISOLATION: "true",
        SITE_LOGIN_ENABLED: "1", PORT: "0", DOTENV_CONFIG_PATH: emptyEnv, HARVEY_EXEC_MODE: "off", HARVEY_BROWSER_MAX_SESSIONS: "3" };
}
const workers = new Map();
function ensureWorker(owner) {
    const existing = workers.get(owner);
    if (existing)
        return existing.ready;
    const child = (0, node_child_process_1.fork)((0, node_path_1.resolve)(__dirname, "../server.js"), [], {
        env: tenantEnvironment(owner), stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const bridgeToken = (0, accountBridge_js_1.issueAccountBridge)(owner);
    const ready = new Promise((resolvePort, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error("Account worker timed out")); }, 45000);
        child.once("error", err => { clearTimeout(timer); reject(err); });
        child.once("exit", () => { clearTimeout(timer); workers.delete(owner); reject(new Error("Account worker stopped")); });
        child.on("message", (message) => {
            if (message?.type === "tenant-ready" && Number.isInteger(message.port)) {
                clearTimeout(timer);
                child.send({ type: "account-bridge", token: bridgeToken, url: (0, crmApiSurface_js_1.getInternalBaseUrl)() }, () => resolvePort(message.port));
            }
        });
    });
    workers.set(owner, { child, ready });
    return ready;
}
function startTenantWorkers() {
    if (!(0, tenantData_js_1.isTenantGateway)())
        return;
    process.env.SHARED_KNOWLEDGE_DB_PATH ||= (0, tenantData_js_1.dataPath)("shared-knowledge.db");
    (0, sharedKnowledge_js_1.importSharedKnowledge)((0, tenantData_js_1.dataPath)());
    (0, knowledgeStore_js_1.listDocs)();
    (0, sharedTasks_js_1.recoverSharedTasks)();
    require("./teamStore.js").prepareSharedTeamStore();
    require("../harvey/work/store.js").workDb();
    let syncing = false;
    const refresh = () => {
        const active = new Set((0, users_js_1.getUsers)().filter(u => u.active).map(u => u.id));
        for (const [id, worker] of workers)
            if (!active.has(id))
                worker.child.kill();
        for (const id of active)
            void ensureWorker(id).catch(err => console.error("[accounts]", err.message));
        if (!syncing) {
            syncing = true;
            void (async () => {
                const owners = (0, users_js_1.getUsers)().filter(u => u.active && u.id === (0, workspaceGrants_js_1.workspaceRoles)().marco);
                if (owners.length !== 1)
                    return;
                await ensureWorker(owners[0].id);
                const { sharedSocialSnapshot } = await Promise.resolve().then(() => __importStar(require("./db.js")));
                const rows = sharedSocialSnapshot();
                for (let offset = 0; offset < rows.length; offset += 100)
                    workers.get(owners[0].id)?.child.send({ type: "shared-social", rows: rows.slice(offset, offset + 100) });
            })().catch(error => console.error("[social-handoff]", error)).finally(() => { syncing = false; });
        }
    };
    refresh();
    setInterval(refresh, 30000).unref();
    const shutdown = () => {
        for (const worker of workers.values())
            worker.child.kill();
        process.exit(0);
    };
    for (const signal of ["SIGTERM", "SIGINT"])
        process.once(signal, shutdown);
    process.on("message", message => { if (message === "shutdown")
        shutdown(); });
}
function isSharedInbound(method, path) {
    return method === "POST" && ["/api/zernio/webhook", "/webhook"].includes(path)
        || method === "OPTIONS" && path === "/webhook";
}
function isSharedAutomationConsole(path) {
    return /^\/api\/(?:dm\/(?:queue|inbound-report|conversations|stats|conversation\/[^/]+)|comment-agent\/(?:status|dry-run|follow-ups)|zernio\/status|llm\/health)$/.test(path);
}
const identityPath = (p) => /^\/api\/auth\/(?:login|logout|me|change-password|login-history|audit-log|team(?:\/[^/]+(?:\/reset-password)?)?)$/.test(p)
    || ["/login", "/login.html", "/change-password", "/change-password.html", "/health", "/favicon.ico"].includes(p)
    || p.startsWith("/login-assets/") || p.startsWith("/assets/");
function accountMiddleware(sessionUser, internal, machine = () => false) {
    return async (req, res, next) => {
        if (process.env.ACCOUNT_ISOLATION !== "true")
            return next();
        res.setHeader("Cache-Control", "no-store");
        const user = sessionUser(req) || (0, accountBridge_js_1.accountBridgeUser)(req);
        if ((0, tenantData_js_1.tenantOwner)() && req.method === "POST" && Object.values(accountInbound_js_1.ACCOUNT_INBOUND).includes(req.path))
            return next();
        if ((0, tenantData_js_1.tenantOwner)() && req.method === "GET" && req.path === "/api/email/gmail-oauth/callback")
            return next();
        const inbound = req.method === "POST" && req.path.match(/^\/api\/account-inbound\/([^/]+)\/(quo|mojo|website|twilio)$/);
        const callback = req.method === "GET" && req.path === "/api/email/gmail-oauth/callback" && typeof req.query.state === "string" && req.query.state.includes(".");
        if (!(0, tenantData_js_1.tenantOwner)() && (inbound || callback)) {
            try {
                const owner = inbound ? decodeURIComponent(inbound[1]) : Buffer.from(String(req.query.state).split(".")[0], "base64url").toString();
                if (!(0, users_js_1.getUsers)().some(u => u.id === owner && u.active)) {
                    res.sendStatus(404);
                    return;
                }
                const port = await ensureWorker(owner);
                const query = new URL(req.originalUrl, "http://local").search;
                const target = inbound ? accountInbound_js_1.ACCOUNT_INBOUND[inbound[2]] + query : req.originalUrl;
                const headers = { ...req.headers, "x-forwarded-proto": req.protocol, "x-original-inbound-path": req.originalUrl };
                delete headers["cookie"];
                delete headers["authorization"];
                delete headers["x-account-bridge"];
                delete headers["x-account-actor"];
                const upstream = node_http_1.default.request({ host: "127.0.0.1", port, path: target, method: req.method, headers }, incoming => {
                    res.writeHead(incoming.statusCode || 502, incoming.headers);
                    incoming.pipe(res);
                });
                upstream.on("error", () => { if (!res.headersSent)
                    res.sendStatus(502);
                else
                    res.destroy(); });
                req.on("aborted", () => upstream.destroy());
                res.on("close", () => { if (!res.writableEnded)
                    upstream.destroy(); });
                req.pipe(upstream);
            }
            catch {
                if (!res.headersSent)
                    res.sendStatus(503);
            }
            return;
        }
        if (req.method === "GET" && /^\/l\/[^/]+$/.test(req.path))
            return next();
        if (req.method === "GET" && (0, publicLinks_js_1.publicResource)(req.path)) {
            const owner = (0, publicLinks_js_1.verifyPublicLink)(req.originalUrl);
            if (owner !== undefined) {
                if ((0, tenantData_js_1.tenantOwner)() || !owner)
                    return next();
                if (!(0, users_js_1.getUsers)().some(u => u.id === owner && u.active)) {
                    res.sendStatus(404);
                    return;
                }
                try {
                    const port = await ensureWorker(owner);
                    const upstream = node_http_1.default.get({ host: "127.0.0.1", port, path: req.originalUrl }, incoming => {
                        res.writeHead(incoming.statusCode || 502, incoming.headers);
                        incoming.pipe(res);
                    });
                    upstream.on("error", () => { if (!res.headersSent)
                        res.sendStatus(502);
                    else
                        res.destroy(); });
                    res.on("close", () => upstream.destroy());
                }
                catch {
                    res.sendStatus(503);
                }
                return;
            }
            // Previously issued root-store links keep their original contract. Never scan tenant stores.
            if (!(0, tenantData_js_1.tenantOwner)() && !req.query.owner && !req.query.signature)
                return next();
            res.sendStatus(404);
            return;
        }
        if ((0, tenantData_js_1.tenantOwner)()) {
            // The child listens only on loopback, but still validates identity on every request.
            if (!internal(req) && !(0, workspaceAccess_js_1.canViewWorkspace)(user, (0, tenantData_js_1.tenantOwner)())) {
                res.status(403).json({ error: "Account mismatch" });
                return;
            }
            if (req.path.startsWith("/api/auth/") || (req.path.startsWith("/api/users") && req.method !== "GET")) {
                res.status(403).json({ error: "Account administration requires the sign-in service" });
                return;
            }
            return next();
        }
        if (user) {
            res.cookie("mp_account", user.name.trim().split(/\s+/)[0].toLowerCase(), { sameSite: "lax", secure: req.secure, path: "/" });
            res.cookie("mp_account_id", user.id, { sameSite: "lax", secure: req.secure, path: "/" });
        }
        // Inbound automation is a shared application service, never a dashboard
        // tenant. Zernio verifies its raw-body signature in the route; ManyChat's
        // existing public webhook contract stays unchanged.
        if (isSharedInbound(req.method, req.path))
            return next();
        if (isSharedAutomationConsole(req.path)) {
            if (user && Object.values((0, workspaceGrants_js_1.workspaceRoles)()).includes(user.id) || machine(req) || internal(req))
                return next();
            res.status(401).json({ error: "Sign in to view the shared automation console" });
            return;
        }
        if (identityPath(req.path))
            return next();
        if (user && req.path === "/api/users" && req.method === "GET") {
            res.json({ users: (0, users_js_1.getUsers)().filter(u => (0, workspaceAccess_js_1.canViewWorkspace)(user, u.id)).map(({ passwordHash, ...safe }) => safe) });
            return;
        }
        if (user && req.path === "/api/account/chats" && req.method === "GET") {
            res.json({ chats: (0, chatRelay_js_1.accessibleChats)(user) });
            return;
        }
        if (user && req.path === "/api/account/chat-relay" && req.method === "POST") {
            try {
                res.json((0, chatRelay_js_1.relayChats)(user, await (0, accountProxy_js_1.readAccountJson)(req)));
            }
            catch (e) {
                res.status(400).json({ error: e.message });
            }
            return;
        }
        if (user && req.path === "/api/account/integrations") {
            try {
                if (req.method === "GET")
                    res.json({ configured: (0, accountIntegrations_js_1.integrationStatus)(user.id) });
                else if (req.method === "PUT") {
                    (0, accountIntegrations_js_1.saveIntegrationSettings)(user.id, await (0, accountProxy_js_1.readAccountJson)(req));
                    res.json({ saved: true, restartRequired: true });
                }
                else
                    res.sendStatus(405);
            }
            catch (error) {
                res.status(400).json({ error: error.message });
            }
            return;
        }
        if (user && req.path === "/api/account/preferences") {
            try {
                if (req.method === "GET")
                    res.json({ preferences: (0, accountPreferences_js_1.accountPreferences)(user.id) });
                else if (req.method === "PUT")
                    res.json({ preferences: (0, accountPreferences_js_1.saveAccountPreferences)(user.id, await (0, accountProxy_js_1.readAccountJson)(req)) });
                else
                    res.status(405).json({ error: "Method not allowed" });
            }
            catch (e) {
                res.status(400).json({ error: e.message });
            }
            return;
        }
        if (user && req.path === "/api/account/workspaces" && req.method === "GET") {
            res.json({ workspaces: (0, users_js_1.getUsers)().filter(u => (0, workspaceAccess_js_1.canViewWorkspace)(user, u.id)).map(u => ({ id: u.id, name: u.name, readOnly: false })) });
            return;
        }
        if (!user) {
            res.status(401).json({ error: "Sign in to an individual account. Shared tokens and unscoped integrations are unavailable." });
            return;
        }
        try {
            res.cookie("mp_workspace_id", user.id, { sameSite: "lax", secure: req.secure, path: "/" });
            await (0, accountProxy_js_1.proxyAccount)(req, res, user, ensureWorker);
        }
        catch (e) {
            if (!res.headersSent)
                res.status(Number(e.status) || 400).json({ error: e.message });
        }
    };
}
function accountUpgrade(req, socket, head, user) {
    if (!(0, tenantData_js_1.isTenantGateway)())
        return false;
    if (!user || user.mustChangePassword) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return true;
    }
    void ensureWorker(user.id).then(port => {
        if (socket.destroyed)
            return;
        const upstream = node_net_1.default.connect(port, "127.0.0.1", () => {
            upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + Object.entries(req.headers)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\r\n") + "\r\n\r\n");
            if (head.length)
                upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        socket.on("close", () => upstream.destroy());
    }).catch(() => socket.destroy());
    return true;
}
