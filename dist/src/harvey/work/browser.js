"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.browserEnabled = browserEnabled;
exports.browserDirectory = browserDirectory;
exports.closeBrowser = closeBrowser;
exports.closeBrowsers = closeBrowsers;
exports.browserTools = browserTools;
exports.browserMetrics = browserMetrics;
exports.browserPreview = browserPreview;
exports.validateActionReferences = validateActionReferences;
exports.browserCall = browserCall;
exports.saveLogin = saveLogin;
exports.logins = logins;
exports.fillSavedLogin = fillSavedLogin;
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const store_js_1 = require("./store.js");
const browserState_js_1 = require("./browserState.js");
const browserArguments_js_1 = require("./browserArguments.js");
const uploadFiles_js_1 = require("./uploadFiles.js");
const ALLOWED = new Set(["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type", "browser_fill_form", "browser_press_key", "browser_select_option", "browser_hover", "browser_drag", "browser_tabs", "browser_wait_for", "browser_handle_dialog", "browser_file_upload", "browser_take_screenshot", "browser_close", "browser_mouse_click_xy", "browser_mouse_drag_xy", "browser_mouse_wheel"]);
const TARGETED = new Set(["browser_click", "browser_type", "browser_fill_form", "browser_select_option", "browser_hover", "browser_drag"]);
const EXTRA_TOOLS = [
    { name: "browser_read_snapshot", description: "Read another bounded page of the most recent full snapshot without recapturing it. Use snapshotId and nextOffset returned by the previous result. For a new state or a specific region use browser_snapshot with target/depth instead.", inputSchema: { type: "object", properties: { snapshotId: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["snapshotId", "offset"] } },
    { name: "browser_recover", description: "Restart this chat's unresponsive hosted browser and restore saved tabs/cookies. Only after observing a connection or browser crash. Never replays a click, form submission or other action; unsaved page state can be lost. Inspect the restored page before continuing.", inputSchema: { type: "object", properties: {} } }
];
const sessions = new Map();
let shuttingDown = false;
let shutdownRegistered = false;
function registerShutdown() {
    if (shutdownRegistered)
        return;
    shutdownRegistered = true;
    for (const sig of ["SIGTERM", "SIGINT"])
        process.once(sig, () => {
            shuttingDown = true;
            const end = setTimeout(() => process.exit(0), 8000);
            end.unref();
            void closeBrowsers().finally(() => process.exit(0));
        });
}
function browserEnabled() { return process.env.HARVEY_BROWSER_ENABLED === "true"; }
function browserDirectory(owner, chat) { const key = (0, crypto_1.createHash)("sha256").update(owner + ":" + chat).digest("hex"); const dir = (0, path_1.join)((0, store_js_1.workDir)(), "browsers", key); (0, fs_1.mkdirSync)(dir, { recursive: true }); return dir; }
function tabsPath(owner, chat) { return (0, path_1.join)(browserDirectory(owner, chat), "tabs.json"); }
async function call(s, name, args = {}, timeout = 15000, signal) {
    s.metrics.calls++;
    const result = await s.client.callTool({ name, arguments: args }, undefined, { timeout, signal });
    // This MCP version puts implicit action snapshots in local files. Return their
    // actual observations to the model without paying for another browser call.
    const dir = browserDirectory(s.owner, s.chat), files = (0, fs_1.realpathSync)((0, path_1.join)(dir, "files"));
    for (const content of result.content || [])
        if (content.type === "text")
            content.text = content.text.replace(/(### Snapshot\r?\n)- \[Snapshot\]\((files\/page-[\w.-]+\.yml)\)/g, (_match, header, file) => {
                try {
                    const path = (0, fs_1.realpathSync)((0, path_1.resolve)(dir, file));
                    if (!path.startsWith(files + path_1.sep) || (0, fs_1.statSync)(path).size > 2 * 1024 * 1024)
                        throw new Error("Snapshot outside bounded workspace");
                    return header + "```yaml\n" + (0, fs_1.readFileSync)(path, "utf8") + "\n```";
                }
                catch {
                    return header + "Snapshot content unavailable. Request a focused browser_snapshot before acting or claiming page contents.";
                }
            });
    return result;
}
function checked(r) { if (r.isError)
    throw new Error((0, browserState_js_1.resultText)(r).slice(0, 2000)); return r; }
function remember(s, r, full = false, persistTabs = true) {
    const raw = (0, browserState_js_1.resultText)(r);
    if (full || /### Snapshot/.test(raw))
        s.snapshot = { id: (0, crypto_1.randomUUID)(), raw, at: Date.now() };
    if (!persistTabs)
        return;
    const tabs = (0, browserState_js_1.parseTabs)(raw);
    if (tabs)
        s.tabs = tabs;
    else {
        const url = raw.match(/^- Page URL: (.+)$/m)?.[1];
        if (url && (0, browserState_js_1.restorableUrl)(url)) {
            s.tabs ||= { urls: [], active: 0, open: true, updatedAt: "" };
            s.tabs.urls[s.tabs.active] = url;
        }
    }
    if (s.tabs) {
        s.tabs.open = true;
        s.tabs.updatedAt = new Date().toISOString();
        (0, browserState_js_1.writeTabs)(s.tabsPath, s.tabs);
    }
}
function pageSlice(s, offset = 0) {
    const snap = s.snapshot;
    if (!snap)
        throw new Error("Inspect browser_snapshot first");
    if (!Number.isInteger(offset) || offset < 0 || offset > snap.raw.length)
        throw new Error("Invalid snapshot offset");
    const end = Math.min(snap.raw.length, offset + 6500);
    return { content: [{ type: "text", text: snap.raw.slice(offset, end) }], snapshotId: snap.id, offset, nextOffset: end < snap.raw.length ? end : null, totalCharacters: snap.raw.length, truncated: end < snap.raw.length || offset > 0, note: end < snap.raw.length ? "Partial page. Use browser_read_snapshot for remaining text, or browser_snapshot target/depth for a complete focused region." : undefined };
}
function normalized(s, result) {
    const image = (result.content || []).find((c) => c.type === "image");
    const raw = (0, browserState_js_1.resultText)(result);
    const output = raw.length > 7000 && s.snapshot?.raw === raw ? pageSlice(s) : { content: (result.content || []).filter((c) => c.type === "text") };
    if (image) {
        if (image.data.length > 8 * 1024 * 1024)
            throw new Error("Screenshot too large; request a viewport or focused screenshot");
        output._image = { media_type: image.mimeType, data: image.data };
    }
    if (s.saveWarning)
        output.persistenceWarning = s.saveWarning;
    if (s.restoreWarning)
        output.restoreWarning = s.restoreWarning;
    return output;
}
async function session(owner, chat) {
    if (!browserEnabled())
        throw new Error("Harvey's hosted browser is not enabled");
    if (shuttingDown)
        throw new Error("Browser worker is shutting down; retry after restart");
    registerShutdown();
    const key = owner + ":" + chat;
    if (!sessions.has(key)) {
        if (sessions.size >= Number(process.env.HARVEY_BROWSER_MAX_SESSIONS || 3))
            throw new Error("All browser slots are occupied. Existing tabs have been preserved. Close an unused chat browser explicitly before opening another.");
        const promise = (async () => {
            const dir = browserDirectory(owner, chat), files = (0, path_1.join)(dir, "files");
            (0, fs_1.mkdirSync)(files, { recursive: true });
            const unprivileged = process.platform !== "win32" && process.getuid?.() === 0;
            if (unprivileged) {
                (0, fs_1.chownSync)(dir, 1001, 1001);
                (0, fs_1.chownSync)(files, 1001, 1001);
            }
            const config = { capabilities: ["storage", "vision"], browser: { browserName: "chromium", userDataDir: (0, path_1.join)(dir, "profile"), launchOptions: { headless: true, ...(process.env.HARVEY_BROWSER_EXECUTABLE ? { executablePath: process.env.HARVEY_BROWSER_EXECUTABLE } : {}) } }, timeouts: { action: 5000, navigation: 30000, idle: 0 }, outputDir: files, saveSession: false, imageResponses: "allow" };
            const configPath = (0, path_1.join)(dir, "config.json");
            (0, fs_1.writeFileSync)(configPath, JSON.stringify(config));
            const client = new index_js_1.Client({ name: "harvey-browser", version: "1.1.0" });
            const env = {};
            for (const name of ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "PLAYWRIGHT_BROWSERS_PATH"])
                if (process.env[name])
                    env[name] = process.env[name];
            env.HOME = dir;
            const transport = new stdio_js_1.StdioClientTransport({ command: process.execPath, args: [(0, path_1.join)(__dirname, "browserWorker.js"), "--config", configPath], cwd: dir, env, stderr: "pipe" });
            let startupError = "";
            transport.stderr?.on("data", b => { startupError = (startupError + String(b)).slice(-2000); });
            try {
                await client.connect(transport, { timeout: 15000 });
                const tools = (await client.listTools({}, { timeout: 15000 })).tools.filter(t => ALLOWED.has(t.name));
                const s = { owner, chat, client, tools: [...tools, ...EXTRA_TOOLS], statePath: (0, path_1.join)(dir, "auth-state.json"), tabsPath: (0, path_1.join)(dir, "tabs.json"), lastUsed: Date.now(), savedAt: 0, busy: 0, chain: Promise.resolve(), dirty: false, metrics: { calls: 0, preflights: 0, checkpoints: 0, previewCalls: 0 } };
                if ((0, fs_1.existsSync)(s.statePath)) {
                    // The unprivileged MCP process must be able to read the retained mode-0600 checkpoint.
                    if (unprivileged)
                        (0, fs_1.chownSync)(s.statePath, 1001, 1001);
                    checked(await call(s, "browser_set_storage_state", { filename: s.statePath }, 30000));
                }
                const retained = (0, browserState_js_1.readTabs)(s.tabsPath);
                if (retained?.open && retained.urls.length) {
                    s.tabs = retained;
                    // Every restoration is a GET navigation, never a replay of form input or submissions.
                    for (let i = 0; i < retained.urls.length; i++) {
                        try {
                            checked(await call(s, i ? "browser_tabs" : "browser_navigate", i ? { action: "new", url: retained.urls[i] } : { url: retained.urls[i] }, 35000));
                        }
                        catch {
                            s.restoreWarning = "One or more saved pages could not reload. Inspect tabs and current authentication; no previous action was replayed.";
                        }
                    }
                    try {
                        checked(await call(s, "browser_tabs", { action: "select", index: retained.active }));
                    }
                    catch {
                        s.restoreWarning = "Saved active tab unavailable; inspect the open tabs.";
                    }
                }
                return s;
            }
            catch (e) {
                await client.close().catch(() => { });
                throw new Error(`Browser startup failed: ${e.message}${startupError ? ". " + startupError : ""}`);
            }
        })().catch(e => { sessions.delete(key); throw e; });
        sessions.set(key, promise);
    }
    const s = await sessions.get(key);
    s.lastUsed = Date.now();
    return s;
}
async function checkpoint(s, force = false) {
    if (!force && !s.dirty)
        return;
    const pending = s.statePath + ".pending";
    try {
        const tabResult = checked(await call(s, "browser_tabs", { action: "list" }));
        const tabs = (0, browserState_js_1.parseTabs)((0, browserState_js_1.resultText)(tabResult));
        if (tabs) {
            s.tabs = tabs;
            (0, browserState_js_1.writeTabs)(s.tabsPath, tabs);
        }
        checked(await call(s, "browser_storage_state", { filename: pending }, 15000));
        (0, fs_1.chmodSync)(pending, 0o600);
        (0, fs_1.renameSync)(pending, s.statePath);
        s.savedAt = Date.now();
        s.dirty = false;
        s.saveWarning = undefined;
        s.metrics.checkpoints++;
    }
    catch {
        s.saveWarning = "Browser action may have succeeded, but its latest session state could not be saved. Previous saved state is intact. Verify the page; do not repeat the action because of this warning.";
    }
}
function deferCheckpoint(s) {
    if (s.saveTimer || s.closing)
        return;
    s.saveTimer = setTimeout(() => { s.saveTimer = undefined; if (!s.failed && !s.closing)
        void observedAction(s, "session checkpoint", () => checkpoint(s)).catch(() => { }); }, 1500);
    s.saveTimer.unref();
}
async function observedAction(s, name, fn) {
    if (s.closing)
        throw new Error("Browser is closing");
    s.busy++;
    s.previewAbort?.abort();
    const next = s.chain.catch(() => { }).then(async () => { await s.preview?.catch(() => { }); s.action = name; s.failed = false; try {
        return await fn();
    }
    catch (e) {
        s.failed = true;
        throw e;
    } });
    s.chain = next;
    try {
        return await next;
    }
    finally {
        s.busy--;
    }
}
async function closeSession(s, explicit = false) {
    s.closing = true;
    s.previewAbort?.abort();
    if (s.saveTimer)
        clearTimeout(s.saveTimer);
    await s.chain.catch(() => { });
    await s.preview?.catch(() => { });
    try {
        if (!s.failed)
            await checkpoint(s, true);
        if (explicit)
            (0, browserState_js_1.writeTabs)(s.tabsPath, { urls: s.tabs?.urls || [], active: s.tabs?.active || 0, open: false, updatedAt: new Date().toISOString() });
    }
    finally {
        await s.client.close();
    }
}
async function closeBrowser(owner, chat) { const key = owner + ":" + chat, pending = sessions.get(key); if (pending) {
    const s = await pending.catch(() => null);
    if (s)
        await closeSession(s, true);
    sessions.delete(key);
}
else {
    const path = tabsPath(owner, chat), saved = (0, browserState_js_1.readTabs)(path);
    if (saved)
        (0, browserState_js_1.writeTabs)(path, { ...saved, open: false });
} }
async function closeBrowsers() { await Promise.all([...sessions].map(async ([key, pending]) => { try {
    const s = await pending.catch(() => null);
    if (s)
        await closeSession(s);
}
finally {
    sessions.delete(key);
} })); }
// Closing a laptop only disconnects the UI. There is deliberately no idle tab eviction.
// Periodically capture cookie changes and client-side tab navigation while the model is idle.
const maintenance = setInterval(() => { for (const pending of sessions.values())
    void pending.then(s => { if (!s.busy && !s.closing && !s.failed) {
        s.dirty = true;
        void observedAction(s, "session checkpoint", () => checkpoint(s)).catch(() => { });
    } }).catch(() => { }); }, 30000);
maintenance.unref();
async function browserTools(owner, chat, name) { const tools = (await session(owner, chat)).tools.map(t => t.name !== "browser_file_upload" ? t : { ...t, description: "Upload local workspace files into the currently opened file chooser. Click Choose files first, then use paths from workspace_files. Native OS interaction is unnecessary. Missing paths do not cancel; cancel:true explicitly cancels.", inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 }, cancel: { type: "boolean" } } } }); if (name) {
    const t = tools.find(t => t.name === name);
    if (!t)
        throw new Error("Unsupported browser tool");
    return [t];
} return tools.map(t => ({ name: t.name, description: t.description?.slice(0, 180), schema: "Request computer action=tools with this tool name for its complete input schema." })); }
async function browserMetrics(owner, chat) { const s = await sessions.get(owner + ":" + chat); return s ? { ...s.metrics } : undefined; }
async function browserPreview(owner, chat) {
    if (!browserEnabled())
        return { state: "disabled" };
    let pending = sessions.get(owner + ":" + chat);
    if (!pending) {
        if (shuttingDown)
            return { state: "closed" };
        try {
            if (!(0, browserState_js_1.readTabs)(tabsPath(owner, chat))?.open)
                return { state: "closed" };
            pending = session(owner, chat);
        }
        catch {
            return { state: "unavailable" };
        }
    }
    let s;
    try {
        s = await pending;
    }
    catch {
        return { state: "unavailable" };
    }
    if (s.closing)
        return { state: "closed" };
    if (!s.busy && !s.preview && (!s.frame || Date.now() - Date.parse(s.frame.capturedAt) > 4000)) {
        const abort = new AbortController();
        s.previewAbort = abort;
        s.preview = (async () => {
            try {
                s.metrics.previewCalls++;
                const shot = checked(await call(s, "browser_take_screenshot", { type: "jpeg" }, 2500, abort.signal));
                const image = (shot.content || []).find((c) => c.type === "image");
                if (!image || image.data.length > 6 * 1024 * 1024)
                    return;
                let url = s.tabs?.urls[s.tabs.active] || "";
                try {
                    const u = new URL(url);
                    u.username = "";
                    u.password = "";
                    u.search = "";
                    u.hash = "";
                    url = u.toString();
                }
                catch {
                    url = "";
                }
                s.frame = { image: "data:" + image.mimeType + ";base64," + image.data, capturedAt: new Date().toISOString(), url, title: "Browser" };
            }
            catch { /* Preview is disposable; never block or fail an action because of it. */ }
            finally {
                s.preview = undefined;
                s.previewAbort = undefined;
            }
        })();
    }
    // Return immediately. A slow preview cannot hold the next action for a full screenshot timeout.
    return { state: s.busy ? "working" : s.failed ? "needs_attention" : "ready", action: s.action, frame: s.frame, persistenceWarning: s.saveWarning, restoreWarning: s.restoreWarning };
}
function validateActionReferences(snapshot, args) {
    const fields = Array.isArray(args?.fields) ? args.fields : [];
    const refs = [args?.ref, args?.startRef, args?.endRef, ...fields.map((f) => f.ref)].filter(Boolean);
    const targets = [args?.target, args?.startTarget, args?.endTarget, ...fields.map((f) => f.target)].filter(Boolean);
    for (const ref of refs)
        if (typeof ref !== "string" || !snapshot.includes(`[ref=${ref}]`))
            throw new Error("Browser target changed. Inspect a fresh snapshot and use its current reference or a unique selector.");
    for (const target of targets) {
        if (typeof target !== "string" || target.length > 2000)
            throw new Error("Invalid browser target");
        if (snapshot.includes(`[ref=${target}]`))
            continue;
        if (/^[\w-]+$/.test(target) && !/^(input|textarea|select|button)$/.test(target))
            throw new Error("Browser target changed or is no longer visible. Inspect a fresh snapshot before trying a different action.");
    }
}
async function browserCall(owner, chat, name, args, signal) {
    signal?.throwIfAborted();
    args = { ...(args || {}) };
    if (name === "browser_recover") {
        const key = owner + ":" + chat, pending = sessions.get(key);
        if (pending) {
            const s = await pending.catch(() => null);
            if (s) {
                s.closing = true;
                if (s.saveTimer)
                    clearTimeout(s.saveTimer);
                s.previewAbort?.abort();
                await s.chain.catch(() => { });
                await s.client.close().catch(() => { });
            }
            sessions.delete(key);
        }
        const s = await session(owner, chat);
        return observedAction(s, name, async () => { const r = checked(await call(s, "browser_snapshot", {}, 15000, signal)); remember(s, r, true); return { ...normalized(s, r), recovered: true, note: "Restored saved tabs and cookies; inspect authentication and effects of the interrupted action before continuing." }; });
    }
    if (name === "browser_read_snapshot") {
        const s = await session(owner, chat);
        if (s.snapshot?.id !== args.snapshotId)
            throw new Error("Snapshot changed; request a fresh focused snapshot");
        return pageSlice(s, args.offset);
    }
    if (!ALLOWED.has(name))
        throw new Error("Unsupported browser action");
    if (name === "browser_navigate" || name === "browser_tabs" && args.url) {
        const url = new URL((0, store_js_1.text)(args.url, "URL", 4000));
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
            throw new Error("Use an HTTP(S) URL without embedded credentials");
    }
    const filesDir = (0, path_1.join)(browserDirectory(owner, chat), "files");
    if (name === "browser_file_upload")
        args = (0, uploadFiles_js_1.uploadArguments)(filesDir, args);
    if (name === "browser_take_screenshot" || name === "browser_snapshot")
        delete args.filename;
    if (name === "browser_take_screenshot") {
        args.type = "jpeg";
        args.fullPage = false;
    }
    if (name === "browser_close") {
        await closeBrowser(owner, chat);
        return { content: [{ type: "text", text: "Browser closed; saved login retained. Tabs will not reopen until requested." }] };
    }
    const s = await session(owner, chat);
    const schema = s.tools.find(t => t.name === name)?.inputSchema;
    try {
        args = (0, browserArguments_js_1.browserArguments)(schema, args);
    }
    catch (error) {
        return { error: error.message, recovery: { kind: "arguments", actionOutcome: "not_executed", safeToRetry: true, guidance: "No page action ran. Correct the arguments using this installed schema; do not retry guessed shapes or ask the user to perform the action." }, inputSchema: schema };
    }
    return observedAction(s, name, async () => {
        signal?.throwIfAborted();
        let preflight = true;
        try {
            if (TARGETED.has(name)) {
                // MCP itself resolves the live target and enforces uniqueness/actionability.
                // Reuse a fresh observed tree instead of duplicating it on every click.
                if (!s.snapshot || Date.now() - s.snapshot.at > 10000) {
                    s.metrics.preflights++;
                    remember(s, checked(await call(s, "browser_snapshot", {}, 15000, signal)), true);
                }
                try {
                    validateActionReferences(s.snapshot.raw, args);
                }
                catch {
                    s.metrics.preflights++;
                    remember(s, checked(await call(s, "browser_snapshot", {}, 15000, signal)), true);
                    validateActionReferences(s.snapshot.raw, args);
                }
            }
            if (name === "browser_mouse_click_xy" || name === "browser_mouse_drag_xy")
                if (!s.visionAt || Date.now() - s.visionAt > 30000)
                    throw new Error("Capture a fresh viewport screenshot before coordinate targeting");
            preflight = false;
            const result = checked(await call(s, name, args, name === "browser_navigate" || name === "browser_wait_for" || name === "browser_tabs" && args.action === "new" ? 35000 : name === "browser_file_upload" ? 120000 : 15000, signal));
            if (!(0, browserState_js_1.browserRead)(name, args)) {
                s.visionAt = undefined;
                s.snapshot = undefined;
                s.dirty = true;
            }
            if (name === "browser_take_screenshot")
                s.visionAt = Date.now();
            try {
                remember(s, result, name === "browser_snapshot");
            }
            catch {
                s.saveWarning = "The action returned successfully but tab state could not be saved. Inspect the page before repeating any action.";
            }
            s.lastUsed = Date.now();
            if (s.dirty) {
                if (!s.savedAt || args.submit || name === "browser_press_key" && /enter/i.test(args.key || ""))
                    await checkpoint(s);
                else
                    deferCheckpoint(s);
            }
            return normalized(s, result);
        }
        catch (e) {
            s.failed = true;
            const message = e.message;
            let recovery = (0, browserState_js_1.recoveryFor)(message, preflight);
            s.visionAt = undefined;
            // A batch may have changed earlier fields before a later target failed.
            if (!preflight && name === "browser_fill_form" && recovery.safeToRetry)
                recovery = { kind: "partial_form", actionOutcome: "unknown", safeToRetry: false, guidance: "Some fields may already be filled. Inspect the fresh form and fill only the remaining fields; do not blindly replay the batch or submit." };
            if (name === "browser_file_upload")
                recovery = { ...recovery, guidance: "Inspect the page for selected files or progress before repeating an upload. If no chooser is visible and no file was selected, click the observed Choose files control, then use browser_file_upload with paths from workspace_files. A native chooser is supported. " + recovery.guidance };
            let observation;
            // A crashed browser can respawn as a blank page. Do not replace retained
            // tabs with that diagnostic page before browser_recover can restore them.
            if (!signal?.aborted)
                try {
                    const fresh = checked(await call(s, "browser_snapshot", {}, 8000));
                    remember(s, fresh, true, false);
                    observation = pageSlice(s);
                    // Snapshot reads have no external effect to replay. If a focused read
                    // fails but a whole-page read succeeds, return the fresh observation.
                    // Keep failed writes uncertain even when their diagnostic read succeeds.
                    if (name === "browser_snapshot") {
                        s.failed = false;
                        return { ...normalized(s, fresh), recovered: true, note: "The requested snapshot failed; this is a fresh whole-page observation instead. Choose targets from this result; the original target was not verified." };
                    }
                }
                catch { }
            if (!preflight)
                s.dirty = true;
            return { error: message, recovery, observation, inputSchema: schema, note: "Use this installed schema to correct the next call. For a failed targeted snapshot, read the whole page with browser_snapshot arguments {} before choosing a fresh target; do not guess more references." };
        }
    });
}
function saveLogin(owner, input) {
    if (input.projectId)
        (0, store_js_1.get)("project", owner, input.projectId);
    const url = new URL((0, store_js_1.text)(input.url, "Login URL", 2000));
    if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Use an HTTPS login URL");
    if (typeof input.password !== "string" || !input.password.length || input.password.length > 2000)
        throw new Error("Password is required (maximum 2000 characters)");
    return (0, store_js_1.put)("login", owner, { id: (0, crypto_1.randomUUID)(), name: (0, store_js_1.text)(input.name, "Login name", 100), projectId: input.projectId || null, url: url.toString(), secret: (0, store_js_1.seal)({ username: (0, store_js_1.text)(input.username, "Username", 500), password: input.password }) });
}
function logins(owner, projectId) { return (0, store_js_1.list)("login", owner).filter(c => projectId === undefined || !c.projectId || c.projectId === projectId).map(({ secret, ...c }) => c); }
async function fillSavedLogin(owner, chat, projectId, input, signal) {
    const login = (0, store_js_1.get)("login", owner, (0, store_js_1.text)(input.loginId, "Login"));
    if (login.projectId && login.projectId !== projectId)
        throw new Error("Login belongs to another project");
    // Check the current page's URL from the browser itself, never the model's claim.
    const s = await session(owner, chat);
    return observedAction(s, "browser_fill_form", async () => {
        const snap = checked(await call(s, "browser_snapshot", {}, 15000, signal));
        const snapshot = (snap.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        const pageUrl = snapshot.match(/- Page URL: (https?:\/\/[^\s]+)/)?.[1];
        if (!pageUrl || new URL(pageUrl).origin !== new URL(login.url).origin)
            throw new Error("Navigate to the saved login's exact origin before using it");
        const credentials = (0, store_js_1.unseal)(login.secret);
        // One fill call minimizes the gap between verifying the destination and typing.
        const targetKey = s.tools.find(t => t.name === "browser_fill_form")?.inputSchema?.properties?.fields?.items?.properties?.target ? "target" : "ref";
        const filled = await call(s, "browser_fill_form", { fields: [
                { name: "Username", type: "textbox", [targetKey]: (0, store_js_1.text)(input.usernameRef, "Username field reference", 100), value: credentials.username },
                { name: "Password", type: "textbox", [targetKey]: (0, store_js_1.text)(input.passwordRef, "Password field reference", 100), value: credentials.password },
            ] }, 15000, signal);
        if (filled.isError)
            throw new Error("The saved login could not be filled. Inspect fresh field references and try again.");
        s.dirty = true;
        s.snapshot = undefined;
        s.visionAt = undefined;
        try {
            remember(s, filled);
        }
        catch {
            s.saveWarning = "Login fields were filled, but tab state could not be saved. Inspect the page before repeating.";
        }
        await checkpoint(s);
        return { filled: true, persistenceWarning: s.saveWarning, note: "Saved login filled. Inspect the page, then submit if requested. MFA or CAPTCHA may need the user's help." };
    });
}
