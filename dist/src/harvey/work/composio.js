"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.composioReady = composioReady;
exports.composioUser = composioUser;
exports.composioSession = composioSession;
exports.managedConnections = managedConnections;
exports.managedCatalog = managedCatalog;
exports.connectManaged = connectManaged;
exports.disconnectManaged = disconnectManaged;
exports.managedTools = managedTools;
exports.executeManaged = executeManaged;
const crypto_1 = require("crypto");
const store_js_1 = require("./store.js");
const SDK = new Function("return import('@composio/core')");
let clientPromise;
const sessions = new Map();
const META = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_WAIT_FOR_CONNECTIONS"]);
const FEATURED = ["gmail", "googledrive", "googlecalendar", "googlesheets", "outlook", "onedrive", "slack", "notion", "github", "linear", "dropbox", "box", "hubspot", "salesforce", "airtable", "trello", "asana", "discord", "youtube", "microsoft_teams"];
function composioReady() { return !!process.env.COMPOSIO_API_KEY?.trim(); }
function composioUser(owner, project) { return "harvey_" + (0, crypto_1.createHash)("sha256").update(JSON.stringify([owner, project])).digest("hex"); }
async function client() {
    if (!composioReady())
        throw new Error("Managed connections are not configured yet");
    return clientPromise ||= SDK().then(({ Composio }) => new Composio({ apiKey: process.env.COMPOSIO_API_KEY }));
}
async function guarded(work) { try {
    return await work();
}
catch (e) {
    const message = String(e.message || "Connection request failed").split(process.env.COMPOSIO_API_KEY || "\0").join("[redacted]");
    throw new Error(message.slice(0, 500));
} }
async function composioSession(owner, project) {
    if (project)
        (0, store_js_1.get)("project", owner, project);
    const key = composioUser(owner, project);
    if (!sessions.has(key))
        sessions.set(key, guarded(async () => {
            const c = await client(), saved = (0, store_js_1.list)("composio_session", owner).find(s => s.id === key);
            if (saved)
                return c.sessions.use(saved.sessionId);
            const s = await c.sessions.create(key, { manageConnections: { callbackUrl: new URL("/harvey?plugins=1&project=" + encodeURIComponent(project || ""), process.env.HARVEY_PUBLIC_URL || "http://localhost:3000").href } });
            (0, store_js_1.put)("composio_session", owner, { id: key, sessionId: s.sessionId, projectId: project });
            return s;
        }).catch(e => { sessions.delete(key); throw e; }));
    return sessions.get(key);
}
// Existing project connections remain usable; new sign-ins belong to the owner.
function scopes(owner) {
    const projects = new Set((0, store_js_1.list)("project", owner).map(p => p.id));
    return [null, ...new Set((0, store_js_1.list)("composio_session", owner).map(s => s.projectId).filter(p => p && projects.has(p)))];
}
async function managedConnections(owner) {
    if (!composioReady())
        return [];
    const all = [];
    for (const project of scopes(owner)) {
        const session = await composioSession(owner, project);
        let cursor;
        do {
            const page = await session.toolkits({ isConnected: true, limit: 50, ...(cursor ? { cursor } : {}) });
            all.push(...page.items.filter((t) => t.connection?.isActive).map((t) => ({ ...t, scope: composioUser(owner, project) })));
            cursor = page.nextCursor || page.cursor; // SDK returns nextCursor; tolerate older cursor response.
            if (!page.items.length)
                break;
        } while (cursor);
    }
    return all;
}
async function managedCatalog(owner, project, search = "", cursor) {
    if (project)
        (0, store_js_1.get)("project", owner, project);
    if (!composioReady())
        return { enabled: false, items: [], connected: [] };
    return guarded(async () => {
        const session = await composioSession(owner, null);
        const [catalog, connected] = await Promise.all([session.toolkits(search ? { search: search.slice(0, 100), limit: 30, cursor } : { toolkits: FEATURED, limit: 30 }), managedConnections(owner)]);
        return { enabled: true, items: catalog.items, cursor: catalog.cursor, connected };
    });
}
async function connectManaged(owner, project, slug) {
    if (!/^[a-z0-9_-]{1,80}$/.test(slug))
        throw new Error("Invalid service");
    return guarded(async () => { if (project)
        (0, store_js_1.get)("project", owner, project); const s = await composioSession(owner, null); const connection = await s.authorize(slug, { callbackUrl: new URL("/harvey?plugins=1&project=" + encodeURIComponent(project || ""), process.env.HARVEY_PUBLIC_URL || "http://localhost:3000").href }); return { url: connection.redirectUrl }; });
}
async function disconnectManaged(owner, project, slug, scope) {
    if (project)
        (0, store_js_1.get)("project", owner, project);
    return guarded(async () => {
        const matches = (await managedConnections(owner)).filter(t => t.slug === slug && (!scope || t.scope === scope));
        if (!matches.length)
            throw new Error("No connected account found");
        for (const found of matches)
            await (await client()).connectedAccounts.delete(found.connection.connectedAccount.id);
        sessions.clear();
        return { ok: true };
    });
}
async function managedTools(owner, project) {
    if (project)
        (0, store_js_1.get)("project", owner, project);
    if (!composioReady())
        return [];
    return guarded(async () => { const session = await composioSession(owner, null); return (await session.tools()).filter((t) => META.has(t.function?.name)).map((t) => ({ name: t.function.name, description: t.function.description, input_schema: { ...t.function.parameters, properties: { ...t.function.parameters.properties, harvey_connection_scope: { type: "string", description: "Use the scope from the connected apps list for this service. Omit for new sign-ins.", enum: scopes(owner).map(p => composioUser(owner, p)) } } } })); });
}
async function executeManaged(owner, project, name, input) {
    if (project)
        (0, store_js_1.get)("project", owner, project);
    if (!META.has(name))
        throw new Error("Unsupported managed tool");
    const args = { ...input };
    const scope = args.harvey_connection_scope;
    delete args.harvey_connection_scope;
    delete args.session_id;
    delete args.user_id;
    const allowed = scopes(owner);
    let selected = null;
    if (scope) {
        const index = allowed.findIndex(p => composioUser(owner, p) === scope);
        if (index < 0)
            throw new Error("Unknown connection scope");
        selected = allowed[index];
    }
    else if (name !== "COMPOSIO_MANAGE_CONNECTIONS") {
        const connected = await managedConnections(owner);
        if (connected.length)
            selected = allowed.find(p => composioUser(owner, p) === connected[0].scope) || null;
    }
    return guarded(async () => { const session = await composioSession(owner, selected); const result = await session.execute(name, args); if (result.error)
        throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error)); return result.data; });
}
