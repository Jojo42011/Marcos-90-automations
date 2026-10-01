"use strict";
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
const workspaceAccess_js_1 = require("./workspaceAccess.js");
const sharedTasks_js_1 = require("./sharedTasks.js");
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_http_1 = __importDefault(require("node:http"));
const node_net_1 = __importDefault(require("node:net"));
const users_js_1 = require("./users.js");
const tenantData_js_1 = require("./tenantData.js");
// Explicitly share model infrastructure, never the operator's business credentials.
const SHARED_ENV = /^(PATH|Path|SystemRoot|WINDIR|COMSPEC|PATHEXT|HOME|USERPROFILE|LOCALAPPDATA|TEMP|TMP|LANG|TZ|NODE_ENV|PLAYWRIGHT_BROWSERS_PATH|OPENROUTER_[A-Z_]+|ANTHROPIC_[A-Z_]+|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|ELEVENLABS_API_KEY|DEEPGRAM_API_KEY|COMPOSIO_API_KEY|HARVEY_(MODEL|PUBLIC_URL|SCHEDULE_MODEL|WORKER_ENABLED|BROWSER_ENABLED|BROWSER_EXECUTABLE|VAULT_KEY|PROMPT_CACHE|REQUEST_TIMEOUT_MS)|AETHON_(MODEL|MAX_TOKENS))$/;
function tenantEnvironment(owner, parent = process.env) {
    const root = (0, node_path_1.join)((0, tenantData_js_1.dataPath)(), "accounts", (0, node_crypto_1.createHash)("sha256").update(owner).digest("hex"));
    (0, node_fs_1.mkdirSync)(root, { recursive: true });
    const emptyEnv = (0, node_path_1.join)(root, ".empty-env");
    (0, node_fs_1.writeFileSync)(emptyEnv, "");
    const env = {};
    for (const [key, value] of Object.entries(parent))
        if (SHARED_ENV.test(key))
            env[key] = value;
    // Identity is shared; business stores and in-memory state are not.
    env.SHARED_TASK_DB_PATH = parent.SHARED_TASK_DB_PATH || (0, tenantData_js_1.dataPath)("shared-tasks.db");
    env.TENANT_MEMBER = (0, users_js_1.getUsers)().find(u => u.id === owner)?.name.trim().split(/\s+/)[0].toLowerCase() || owner;
    env.AUTH_DB_PATH = parent.AUTH_DB_PATH || (0, tenantData_js_1.dataPath)("auth.db");
    env.USERS_JSON_PATH = parent.USERS_JSON_PATH || (0, node_path_1.join)((0, node_path_1.dirname)(parent.DB_JSON_PATH || (0, tenantData_js_1.dataPath)("db.json")), "users.json");
    // Work already has enforced owner keys. Keeping it preserves existing chats/connections.
    env.HARVEY_WORK_DIR = parent.HARVEY_WORK_DIR || (0, tenantData_js_1.dataPath)("harvey-work");
    return { ...env, TENANT_OWNER_ID: owner, TENANT_DATA_ROOT: root, ACCOUNT_ISOLATION: "true",
        SITE_LOGIN_ENABLED: "1", PORT: "0", DOTENV_CONFIG_PATH: emptyEnv, HARVEY_EXEC_MODE: "off", HARVEY_BROWSER_MAX_SESSIONS: "1" };
}
const workers = new Map();
function ensureWorker(owner) {
    const existing = workers.get(owner);
    if (existing)
        return existing.ready;
    const child = (0, node_child_process_1.fork)((0, node_path_1.resolve)(__dirname, "../server.js"), [], {
        env: tenantEnvironment(owner), stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const ready = new Promise((resolvePort, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error("Account worker timed out")); }, 45000);
        child.once("error", err => { clearTimeout(timer); reject(err); });
        child.once("exit", () => { clearTimeout(timer); workers.delete(owner); reject(new Error("Account worker stopped")); });
        child.on("message", (message) => {
            if (message?.type === "tenant-ready" && Number.isInteger(message.port)) {
                clearTimeout(timer);
                resolvePort(message.port);
            }
        });
    });
    workers.set(owner, { child, ready });
    return ready;
}
function startTenantWorkers() {
    if (!(0, tenantData_js_1.isTenantGateway)())
        return;
    (0, sharedTasks_js_1.recoverSharedTasks)();
    const refresh = () => {
        const active = new Set((0, users_js_1.getUsers)().filter(u => u.active).map(u => u.id));
        for (const [id, worker] of workers)
            if (!active.has(id))
                worker.child.kill();
        for (const id of active)
            void ensureWorker(id).catch(err => console.error("[accounts]", err.message));
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
    return /^\/api\/(?:dm\/(?:inbound-report|conversations|stats|conversation\/[^/]+)|comment-agent\/(?:status|dry-run|follow-ups)|zernio\/status)$/.test(path);
}
const identityPath = (p) => /^\/api\/auth\/(?:login|logout|me|change-password|login-history|audit-log|team(?:\/[^/]+(?:\/reset-password)?)?)$/.test(p)
    || ["/login", "/login.html", "/change-password", "/change-password.html", "/health", "/favicon.ico"].includes(p)
    || p.startsWith("/login-assets/") || p.startsWith("/assets/");
function accountMiddleware(sessionUser, internal, machine = () => false) {
    return async (req, res, next) => {
        if (process.env.ACCOUNT_ISOLATION !== "true")
            return next();
        res.setHeader("Cache-Control", "no-store");
        const user = sessionUser(req);
        if ((0, tenantData_js_1.tenantOwner)()) {
            // The child listens only on loopback, but still validates identity on every request.
            if (!internal(req) && !(0, workspaceAccess_js_1.canViewWorkspace)(user, (0, tenantData_js_1.tenantOwner)())) {
                res.status(403).json({ error: "Account mismatch" });
                return;
            }
            if (user && user.id !== (0, tenantData_js_1.tenantOwner)() && !(0, workspaceAccess_js_1.workspaceReadAllowed)(req.method, req.path)) {
                res.status(403).json({ error: "This workspace is read-only. Return to your workspace to create or assign tasks." });
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
            if (user && ["marco", "wesley", "carlos"].includes(user.name.trim().split(/\s+/)[0].toLowerCase()) || machine(req) || internal(req))
                return next();
            res.status(401).json({ error: "Sign in to view the shared automation console" });
            return;
        }
        if (identityPath(req.path))
            return next();
        if (user && req.path === "/api/account/workspaces" && req.method === "GET") {
            res.json({ workspaces: (0, users_js_1.getUsers)().filter(u => (0, workspaceAccess_js_1.canViewWorkspace)(user, u.id)).map(u => ({ id: u.id, name: u.name, readOnly: u.id !== user.id })) });
            return;
        }
        if (user && req.path === "/api/account/workspace" && req.method === "POST") {
            const target = String(req.query.id || user.id);
            if (!(0, workspaceAccess_js_1.canViewWorkspace)(user, target)) {
                res.status(403).json({ error: "Workspace unavailable" });
                return;
            }
            res.cookie("mp_workspace", target, { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/" });
            res.json({ ok: true });
            return;
        }
        if (!user) {
            res.status(401).json({ error: "Sign in to an individual account. Shared tokens and unscoped integrations are unavailable." });
            return;
        }
        try {
            const selected = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("mp_workspace="))?.slice(13);
            // Task Command is a shared service. Always use the signed-in actor for
            // task reads and writes, even while viewing another account's CRM.
            const sharedTasks = /^\/api\/tasks(?:\/|$)/.test(req.path);
            const workspace = selected && (0, workspaceAccess_js_1.canViewWorkspace)(user, selected) ? selected : user.id;
            const owner = sharedTasks ? user.id : workspace;
            if (owner !== user.id && !(0, workspaceAccess_js_1.workspaceReadAllowed)(req.method, req.path)) {
                res.status(403).json({ error: "This workspace is read-only. Return to your workspace to make changes." });
                return;
            }
            res.cookie("mp_workspace_id", workspace, { sameSite: "lax", secure: req.secure, path: "/" });
            const port = await ensureWorker(owner);
            const upstream = node_http_1.default.request({ host: "127.0.0.1", port, path: req.originalUrl, method: req.method,
                headers: { ...req.headers, "x-forwarded-proto": req.protocol } }, incoming => {
                res.writeHead(incoming.statusCode || 502, { ...incoming.headers, "cache-control": "no-store" });
                incoming.pipe(res);
            });
            upstream.on("error", () => { if (!res.headersSent)
                res.status(502).json({ error: "Account worker unavailable; request was not retried" });
            else
                res.destroy(); });
            req.on("aborted", () => upstream.destroy());
            res.on("close", () => { if (!res.writableEnded)
                upstream.destroy(); });
            req.pipe(upstream);
        }
        catch {
            res.status(503).json({ error: "Account is starting; try again shortly" });
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
