"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWorkRouter = createWorkRouter;
exports.handleWorkChat = handleWorkChat;
const multer_1 = __importDefault(require("multer"));
const crypto_1 = require("crypto");
const files_js_1 = require("./files.js");
const express_1 = __importDefault(require("express"));
const store_js_1 = require("./store.js");
const connectors_js_1 = require("./connectors.js");
const browser_js_1 = require("./browser.js");
const runtime_js_1 = require("./runtime.js");
const error = (res, e) => res.status(e.message === "Not found" ? 404 : 400).json({ error: e.message || "Request failed" });
function createWorkRouter(authorize, owner) {
    const r = express_1.default.Router();
    r.use(express_1.default.json({ limit: "256kb" }));
    r.get("/work/oauth/callback", async (req, res) => {
        res.setHeader("Referrer-Policy", "no-referrer");
        try {
            const state = String(req.query.state || ""), cookie = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("harvey_oauth_state="))?.split("=")[1] || "";
            if (req.query.error)
                throw new Error("Service sign-in was cancelled. Return to Plugins to try again.");
            await (0, connectors_js_1.finishOAuth)(state, (0, store_js_1.text)(req.query.code, "Authorization code", 8000), cookie);
            res.clearCookie("harvey_oauth_state", { path: "/api/harvey/work/oauth" });
            res.redirect("/harvey?connected=1");
        }
        catch (e) {
            res.status(400).type("text/plain").send(e.message);
        }
    });
    r.use((req, res, next) => { if (!authorize(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    } next(); });
    const route = (method, path, fn) => r[method](path, async (req, res) => { try {
        await fn(req, res, owner(req));
    }
    catch (e) {
        error(res, e);
    } });
    r.post("/work/files/:chat", (req, res, next) => { try {
        (0, store_js_1.get)("chat", owner(req), String(req.params.chat));
        next();
    }
    catch (e) {
        error(res, e);
    } }, (0, multer_1.default)({ storage: multer_1.default.diskStorage({ destination: (req, _file, cb) => cb(null, (0, files_js_1.filesDir)(owner(req), String(req.params.chat))), filename: (_req, file, cb) => cb(null, (0, crypto_1.randomUUID)() + "-" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120)) }), limits: { fileSize: 250 * 1024 * 1024, files: 1 } }).single("file"), (req, res) => res.status(201).json({ file: req.file?.filename }));
    route("get", "/work/files/:chat", (q, res, o) => { (0, store_js_1.get)("chat", o, String(q.params.chat)); res.json({ files: (0, files_js_1.files)(o, String(q.params.chat)) }); });
    route("get", "/work/files/:chat/:name", (q, res, o) => { (0, store_js_1.get)("chat", o, String(q.params.chat)); res.download((0, files_js_1.filePath)(o, String(q.params.chat), String(q.params.name))); });
    route("get", "/work/status", (_q, res) => res.json({ browser: (0, browser_js_1.browserEnabled)(), worker: process.env.HARVEY_WORKER_ENABLED === "true", vault: (0, store_js_1.vaultReady)() }));
    route("get", "/projects", (_q, res, o) => res.json({ projects: (0, store_js_1.list)("project", o) }));
    route("post", "/projects", (q, res, o) => res.status(201).json((0, store_js_1.createProject)(o, q.body)));
    route("patch", "/projects/:id", (q, res, o) => { const p = (0, store_js_1.get)("project", o, String(q.params.id)); res.json((0, store_js_1.put)("project", o, { ...p, name: q.body.name === undefined ? p.name : (0, store_js_1.text)(q.body.name, "Name", 100), instructions: q.body.instructions === undefined ? p.instructions : String(q.body.instructions).slice(0, 12000), timezone: q.body.timezone === undefined ? p.timezone : (0, store_js_1.timezone)(q.body.timezone) })); });
    route("get", "/conversations", (_q, res, o) => res.json({ conversations: (0, store_js_1.list)("chat", o).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }));
    route("post", "/conversations", (q, res, o) => res.status(201).json((0, store_js_1.createChat)(o, q.body)));
    route("get", "/conversations/:id", (q, res, o) => res.json({ ...(0, store_js_1.get)("chat", o, String(q.params.id)), messages: (0, store_js_1.messages)(o, String(q.params.id)) }));
    route("post", "/conversations/:id/title", (q, res, o) => { const c = (0, store_js_1.get)("chat", o, String(q.params.id)); res.json((0, store_js_1.put)("chat", o, { ...c, title: (0, store_js_1.text)(q.body.title, "Title", 120) })); });
    route("patch", "/conversations/:id", (q, res, o) => { const c = (0, store_js_1.get)("chat", o, String(q.params.id)); if (q.body.projectId)
        (0, store_js_1.get)("project", o, q.body.projectId); res.json((0, store_js_1.put)("chat", o, { ...c, projectId: q.body.projectId === undefined ? c.projectId : q.body.projectId || null, mode: q.body.mode === undefined ? c.mode : q.body.mode === "work" ? "work" : "chat" })); });
    route("delete", "/conversations/:id", async (q, res, o) => {
        const id = String(q.params.id);
        (0, store_js_1.get)("chat", o, id);
        if ((0, store_js_1.workDb)().prepare("SELECT 1 FROM locks WHERE owner=? AND chat=?").get(o, id))
            throw new Error("Wait for this chat's running task to finish");
        for (const s of (0, store_js_1.list)("schedule", o).filter(s => s.chatId === id))
            (0, store_js_1.remove)("schedule", o, s.id);
        for (const run of (0, store_js_1.list)("run", o).filter(s => s.chatId === id))
            (0, store_js_1.remove)("run", o, run.id);
        (0, store_js_1.workDb)().prepare("DELETE FROM messages WHERE owner=? AND chat=?").run(o, id);
        (0, store_js_1.remove)("chat", o, id);
        await (0, browser_js_1.closeBrowser)(o, id);
        res.json({ ok: true });
    });
    route("get", "/work/plugins", (_q, res, o) => res.json({ catalog: (0, connectors_js_1.catalog)(), connections: (0, connectors_js_1.connections)(o).map(connectors_js_1.publicConnection) }));
    route("post", "/work/plugins/oauth", (q, res, o) => { const result = (0, connectors_js_1.startOAuth)(o, q.body.service, q.body.projectId || null, q.body.allowWrites === true); res.cookie("harvey_oauth_state", result.state, { httpOnly: true, sameSite: "lax", secure: q.secure, maxAge: 600000, path: "/api/harvey/work/oauth" }); res.json({ url: result.url }); });
    route("post", "/work/plugins/mcp", async (q, res, o) => res.status(201).json(await (0, connectors_js_1.addMcp)(o, q.body)));
    route("patch", "/work/plugins/:id", (q, res, o) => { const c = (0, store_js_1.get)("connection", o, String(q.params.id)); if (q.body.projectId)
        (0, store_js_1.get)("project", o, q.body.projectId); res.json((0, connectors_js_1.publicConnection)((0, store_js_1.put)("connection", o, { ...c, allowWrites: q.body.allowWrites === true, projectId: q.body.projectId === undefined ? c.projectId : q.body.projectId || null }))); });
    route("delete", "/work/plugins/:id", (q, res, o) => { (0, store_js_1.remove)("connection", o, String(q.params.id)); res.json({ ok: true }); });
    route("get", "/work/logins", (_q, res, o) => res.json({ logins: (0, browser_js_1.logins)(o) }));
    route("post", "/work/logins", (q, res, o) => { const { secret, ...login } = (0, browser_js_1.saveLogin)(o, q.body); res.status(201).json(login); });
    route("delete", "/work/logins/:id", (q, res, o) => { (0, store_js_1.remove)("login", o, String(q.params.id)); res.json({ ok: true }); });
    route("post", "/work/browser/:chat/snapshot", async (q, res, o) => { const c = (0, store_js_1.get)("chat", o, String(q.params.chat)); res.json(await (0, browser_js_1.browserCall)(o, c.id, "browser_snapshot", {})); });
    route("post", "/work/browser/:chat/close", async (q, res, o) => { (0, store_js_1.get)("chat", o, String(q.params.chat)); await (0, browser_js_1.closeBrowser)(o, String(q.params.chat)); res.json({ ok: true }); });
    route("get", "/work/schedules", (_q, res, o) => res.json({ schedules: (0, store_js_1.list)("schedule", o), runs: (0, store_js_1.list)("run", o).slice(0, 100) }));
    route("post", "/work/schedules", (q, res, o) => res.status(201).json((0, store_js_1.createSchedule)(o, q.body)));
    route("patch", "/work/schedules/:id", (q, res, o) => res.json((0, runtime_js_1.updateSchedule)(o, String(q.params.id), q.body)));
    route("post", "/work/schedules/:id/run", async (q, res, o) => { const run = await (0, runtime_js_1.runScheduled)(o, String(q.params.id), true); if (!run)
        throw new Error("This agent is already running"); res.json(run); });
    route("delete", "/work/schedules/:id", (q, res, o) => { (0, store_js_1.remove)("schedule", o, String(q.params.id)); res.json({ ok: true }); });
    r.use((e, _req, res, _next) => { res.status(e.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: e.code === "LIMIT_FILE_SIZE" ? "File exceeds the 250 MB limit" : "Upload failed" }); });
    return r;
}
async function handleWorkChat(req, res, owner) {
    let streaming = false;
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded)
        controller.abort(); });
    try {
        const message = (0, store_js_1.text)(req.body.message, "Message", 50000);
        const chat = req.body.conversationId ? (0, store_js_1.get)("chat", owner, String(req.body.conversationId)) : (0, store_js_1.createChat)(owner, req.body);
        const stream = req.body.stream === true;
        if (stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.flushHeaders();
            streaming = true;
        }
        const send = (event, data) => { if (!res.writableEnded && !res.destroyed)
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        if (stream)
            send("conversation", { conversationId: chat.id, sessionId: chat.sessionId });
        const heartbeat = stream ? setInterval(() => { if (!res.writableEnded && !res.destroyed)
            res.write(": heartbeat\n\n"); }, 15000) : null;
        try {
            const approvals = [];
            const result = await (0, runtime_js_1.runChat)(owner, chat, message, { signal: controller.signal, modelOverride: req.body.model && req.body.model !== "auto" ? String(req.body.model) : undefined, onToken: stream ? t => send("token", { text: t }) : undefined, onEvent: e => { if (e.type === "approval")
                    approvals.push(e.approval); if (stream)
                    send(e.type, e.type === "approval" ? e.approval : e); } });
            const data = { text: result.speech, conversationId: chat.id, sessionId: chat.sessionId, usage: { model: result.modelUsed || result.model, costUsd: result.costUsd || 0, promptTokens: result.promptTokens || 0, completionTokens: result.completionTokens || 0, cachedTokens: result.cachedTokens || 0 }, approvals, needsAttention: result.toolFailed || !!result.modelError || !!result.budgetRefused };
            if (stream) {
                send("done", data);
                res.end();
            }
            else
                res.json(data);
        }
        finally {
            if (heartbeat)
                clearInterval(heartbeat);
        }
    }
    catch (e) {
        if (res.destroyed)
            return;
        if (streaming) {
            res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
            res.end();
        }
        else
            error(res, e);
    }
}
