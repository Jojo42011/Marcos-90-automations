import { canViewWorkspace, workspaceReadAllowed } from "./workspaceAccess.js";
import { recoverSharedTasks } from "./sharedTasks.js";
import { recoverMarcoCrm } from "./crmRecovery.js";
import { fork, ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import http, { IncomingMessage } from "node:http";
import net from "node:net";
import type { Request, Response, NextFunction } from "express";
import { getUsers } from "./users.js";
import { dataPath, isTenantGateway, tenantOwner } from "./tenantData.js";
import type { CRMUser } from "./types.js";

// Explicitly share model infrastructure, never the operator's business credentials.
const SHARED_ENV = /^(PATH|Path|SystemRoot|WINDIR|COMSPEC|PATHEXT|HOME|USERPROFILE|LOCALAPPDATA|TEMP|TMP|LANG|TZ|NODE_ENV|PLAYWRIGHT_BROWSERS_PATH|OPENROUTER_[A-Z_]+|ANTHROPIC_[A-Z_]+|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|ELEVENLABS_API_KEY|DEEPGRAM_API_KEY|COMPOSIO_API_KEY|HARVEY_(MODEL|PUBLIC_URL|SCHEDULE_MODEL|WORKER_ENABLED|BROWSER_ENABLED|BROWSER_EXECUTABLE|VAULT_KEY|PROMPT_CACHE|REQUEST_TIMEOUT_MS)|AETHON_(MODEL|MAX_TOKENS))$/;
export function tenantEnvironment(owner: string, parent = process.env): NodeJS.ProcessEnv {
  const root = join(dataPath(), "accounts", createHash("sha256").update(owner).digest("hex"));
  mkdirSync(root, { recursive: true });
  const marco = getUsers().filter(u => /^marco(?:\s|$)/i.test(u.name.trim()));
  if (marco.length === 1 && marco[0].id === owner) recoverMarcoCrm(dataPath(), root, parent.DB_JSON_PATH);
  const emptyEnv = join(root, ".empty-env");
  writeFileSync(emptyEnv, "");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) if (SHARED_ENV.test(key)) env[key] = value;
  // Identity is shared; business stores and in-memory state are not.
  env.SHARED_TASK_DB_PATH = parent.SHARED_TASK_DB_PATH || dataPath("shared-tasks.db");
  env.TENANT_MEMBER = getUsers().find(u => u.id === owner)?.name.trim().split(/\s+/)[0].toLowerCase() || owner;
  env.AUTH_DB_PATH = parent.AUTH_DB_PATH || dataPath("auth.db");
  env.USERS_JSON_PATH = parent.USERS_JSON_PATH || join(dirname(parent.DB_JSON_PATH || dataPath("db.json")), "users.json");
  // Work already has enforced owner keys. Keeping it preserves existing chats/connections.
  env.HARVEY_WORK_DIR = parent.HARVEY_WORK_DIR || dataPath("harvey-work");
  return { ...env, TENANT_OWNER_ID: owner, TENANT_DATA_ROOT: root, ACCOUNT_ISOLATION: "true",
    SITE_LOGIN_ENABLED: "1", PORT: "0", DOTENV_CONFIG_PATH: emptyEnv, HARVEY_EXEC_MODE: "off", HARVEY_BROWSER_MAX_SESSIONS: "1" };
}

type Worker = { child: ChildProcess; ready: Promise<number> };
const workers = new Map<string, Worker>();
function ensureWorker(owner: string): Promise<number> {
  const existing = workers.get(owner); if (existing) return existing.ready;
  const child = fork(resolve(__dirname, "../server.js"), [], {
    env: tenantEnvironment(owner), stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const ready = new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Account worker timed out")); }, 45000);
    child.once("error", err => { clearTimeout(timer); reject(err); });
    child.once("exit", () => { clearTimeout(timer); workers.delete(owner); reject(new Error("Account worker stopped")); });
    child.on("message", (message: any) => {
      if (message?.type === "tenant-ready" && Number.isInteger(message.port)) { clearTimeout(timer); resolvePort(message.port); }
    });
  });
  workers.set(owner, { child, ready });
  return ready;
}

export function startTenantWorkers(): void {
  if (!isTenantGateway()) return;
  recoverSharedTasks();
  const refresh = () => {
    const active = new Set(getUsers().filter(u => u.active).map(u => u.id));
    for (const [id, worker] of workers) if (!active.has(id)) worker.child.kill();
    for (const id of active) void ensureWorker(id).catch(err => console.error("[accounts]", err.message));
  };
  refresh(); setInterval(refresh, 30000).unref();
  const shutdown = () => {
    for (const worker of workers.values()) worker.child.kill(); process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
  process.on("message", message => { if (message === "shutdown") shutdown(); });
}

export function isSharedInbound(method: string, path: string): boolean {
  return method === "POST" && ["/api/zernio/webhook","/webhook"].includes(path)
    || method === "OPTIONS" && path === "/webhook";
}
export function isSharedAutomationConsole(path: string): boolean {
  return /^\/api\/(?:dm\/(?:inbound-report|conversations|stats|conversation\/[^/]+)|comment-agent\/(?:status|dry-run|follow-ups)|zernio\/status|llm\/health)$/.test(path);
}

const identityPath = (p: string) => /^\/api\/auth\/(?:login|logout|me|change-password|login-history|audit-log|team(?:\/[^/]+(?:\/reset-password)?)?)$/.test(p)
  || ["/login", "/login.html", "/change-password", "/change-password.html", "/health", "/favicon.ico"].includes(p)
  || p.startsWith("/login-assets/") || p.startsWith("/assets/");

export function accountMiddleware(sessionUser: (req: Request) => CRMUser | null, internal: (req: Request) => boolean, machine: (req: Request) => boolean = () => false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.ACCOUNT_ISOLATION !== "true") return next();
    res.setHeader("Cache-Control", "no-store");
    const user = sessionUser(req);
    if (tenantOwner()) {
      // The child listens only on loopback, but still validates identity on every request.
      if (!internal(req) && !canViewWorkspace(user, tenantOwner())) { res.status(403).json({ error: "Account mismatch" }); return; }
      if (user && user.id !== tenantOwner() && !workspaceReadAllowed(req.method, req.path)) { res.status(403).json({error:"This workspace is read-only. Return to your workspace to create or assign tasks."}); return; }
      if (req.path.startsWith("/api/auth/") || (req.path.startsWith("/api/users") && req.method !== "GET")) {
        res.status(403).json({ error: "Account administration requires the sign-in service" }); return;
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
    if (isSharedInbound(req.method, req.path)) return next();
    if (isSharedAutomationConsole(req.path)) {
      if (user && ["marco","wesley","carlos"].includes(user.name.trim().split(/\s+/)[0].toLowerCase()) || machine(req) || internal(req)) return next();
      res.status(401).json({error:"Sign in to view the shared automation console"}); return;
    }
    if (identityPath(req.path)) return next();
    if (user && req.path === "/api/account/workspaces" && req.method === "GET") {
      res.json({workspaces:getUsers().filter(u => canViewWorkspace(user,u.id)).map(u => ({id:u.id,name:u.name,readOnly:u.id!==user.id}))}); return;
    }
    if (user && req.path === "/api/account/workspace" && req.method === "POST") {
      const target=String(req.query.id || user.id);
      if (!canViewWorkspace(user,target)) {res.status(403).json({error:"Workspace unavailable"});return;}
      res.cookie("mp_workspace",target,{httpOnly:true,sameSite:"strict",secure:req.secure,path:"/"}); res.json({ok:true}); return;
    }
    if (!user) { res.status(401).json({ error: "Sign in to an individual account. Shared tokens and unscoped integrations are unavailable." }); return; }
    try {
      const selected=(req.headers.cookie || "").split(";").map(s=>s.trim()).find(s=>s.startsWith("mp_workspace="))?.slice(13);
      // Task Command is a shared service. Always use the signed-in actor for
      // task reads and writes, even while viewing another account's CRM.
      const sharedTasks = /^\/api\/tasks(?:\/|$)/.test(req.path);
      const workspace=selected && canViewWorkspace(user,selected) ? selected : user.id;
      const owner=sharedTasks ? user.id : workspace;
      if (owner !== user.id && !workspaceReadAllowed(req.method,req.path)) {res.status(403).json({error:"This workspace is read-only. Return to your workspace to make changes."});return;}
      res.cookie("mp_workspace_id",workspace,{sameSite:"lax",secure:req.secure,path:"/"});
      const port = await ensureWorker(owner);
      const upstream = http.request({ host: "127.0.0.1", port, path: req.originalUrl, method: req.method,
        headers: { ...req.headers, "x-forwarded-proto": req.protocol } }, incoming => {
        res.writeHead(incoming.statusCode || 502, { ...incoming.headers, "cache-control": "no-store" }); incoming.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.status(502).json({ error: "Account worker unavailable; request was not retried" }); else res.destroy(); });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
      req.pipe(upstream);
    } catch { res.status(503).json({ error: "Account is starting; try again shortly" }); }
  };
}

export function accountUpgrade(req: IncomingMessage, socket: any, head: Buffer, user: CRMUser | null): boolean {
  if (!isTenantGateway()) return false;
  if (!user || user.mustChangePassword) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return true; }
  void ensureWorker(user.id).then(port => {
    if (socket.destroyed) return;
    const upstream = net.connect(port, "127.0.0.1", () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + Object.entries(req.headers)
        .map(([k,v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
  }).catch(() => socket.destroy());
  return true;
}
