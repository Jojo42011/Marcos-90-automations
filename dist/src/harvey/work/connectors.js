"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERVICES = void 0;
exports.callbackUrl = callbackUrl;
exports.catalog = catalog;
exports.publicConnection = publicConnection;
exports.connections = connections;
exports.startOAuth = startOAuth;
exports.finishOAuth = finishOAuth;
exports.connectorRequest = connectorRequest;
exports.validateMcpUrl = validateMcpUrl;
exports.addMcp = addMcp;
exports.mcpTools = mcpTools;
const crypto_1 = require("crypto");
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const store_js_1 = require("./store.js");
const google = { family: "GOOGLE", authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", pkce: true };
const microsoft = { family: "MICROSOFT", authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", pkce: true, base: "https://graph.microsoft.com/v1.0/" };
exports.SERVICES = [
    { ...google, id: "google-drive", name: "Google Drive", scopes: "https://www.googleapis.com/auth/drive", base: "https://www.googleapis.com/drive/v3/", examples: "GET files?q=...&fields=files(id,name,mimeType), GET files/{id}?alt=media, GET files/{id}/export?mimeType=text/plain, POST files (metadata). Binary uploads are not supported by this JSON tool; use the browser." },
    { ...google, id: "gmail", name: "Gmail", scopes: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send", base: "https://gmail.googleapis.com/gmail/v1/", examples: "GET users/me/messages?q=..., GET users/me/messages/{id}, POST users/me/messages/send with {raw:base64urlRFC822}" },
    { ...google, id: "google-calendar", name: "Google Calendar", scopes: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly", base: "https://www.googleapis.com/calendar/v3/", examples: "GET users/me/calendarList, GET calendars/primary/events, POST calendars/primary/events" },
    { ...google, id: "google-sheets", name: "Google Sheets", scopes: "https://www.googleapis.com/auth/spreadsheets", base: "https://sheets.googleapis.com/v4/", examples: "GET spreadsheets/{id}, GET spreadsheets/{id}/values/{range}, PUT spreadsheets/{id}/values/{range}?valueInputOption=USER_ENTERED" },
    { ...microsoft, id: "onedrive", name: "OneDrive", scopes: "offline_access User.Read Files.ReadWrite", examples: "GET me/drive/root/children, GET me/drive/items/{id}, POST me/drive/root/children" },
    { ...microsoft, id: "outlook", name: "Outlook Mail", scopes: "offline_access User.Read Mail.ReadWrite Mail.Send", examples: "GET me/messages, GET me/mailFolders, POST me/sendMail" },
    { ...microsoft, id: "outlook-calendar", name: "Outlook Calendar", scopes: "offline_access User.Read Calendars.ReadWrite", examples: "GET me/events, GET me/calendars, POST me/events" },
    { id: "github", name: "GitHub", family: "GITHUB", authorize: "https://github.com/login/oauth/authorize", token: "https://github.com/login/oauth/access_token", scopes: "repo read:user", base: "https://api.github.com/", pkce: true, examples: "GET user, GET user/repos, GET repos/{owner}/{repo}/issues, POST repos/{owner}/{repo}/issues" },
    { id: "slack", name: "Slack", family: "SLACK", authorize: "https://slack.com/oauth/v2/authorize", token: "https://slack.com/api/oauth.v2.access", scopes: "channels:read,channels:history,chat:write,users:read", base: "https://slack.com/api/", examples: "GET conversations.list, GET conversations.history?channel=..., POST chat.postMessage" },
    { id: "notion", name: "Notion", family: "NOTION", authorize: "https://api.notion.com/v1/oauth/authorize", token: "https://api.notion.com/v1/oauth/token", scopes: "", base: "https://api.notion.com/v1/", basic: true, headers: { "Notion-Version": "2022-06-28" }, examples: "POST search with {query}, GET pages/{id}, GET blocks/{id}/children, PATCH blocks/{id}/children" },
];
function service(id) { const s = exports.SERVICES.find(s => s.id === id); if (!s)
    throw new Error("Unknown service"); return s; }
function credentials(s) { return { clientId: process.env[`HARVEY_${s.family}_CLIENT_ID`], clientSecret: process.env[`HARVEY_${s.family}_CLIENT_SECRET`] }; }
function callbackUrl() { const base = process.env.HARVEY_PUBLIC_URL; if (!base)
    throw new Error("Set HARVEY_PUBLIC_URL to the app's public URL"); return new URL("/api/harvey/work/oauth/callback", base).toString(); }
function catalog() { return exports.SERVICES.map(s => ({ id: s.id, name: s.name, ready: !!(credentials(s).clientId && credentials(s).clientSecret && process.env.HARVEY_PUBLIC_URL && (0, store_js_1.vaultReady)()), setup: `HARVEY_${s.family}_CLIENT_ID and HARVEY_${s.family}_CLIENT_SECRET`, examples: s.examples })); }
function publicConnection(c) { const { secret, ...visible } = c; return visible; }
function connections(owner, projectId) { return (0, store_js_1.list)("connection", owner).filter(c => projectId === undefined || !c.projectId || c.projectId === projectId); }
function startOAuth(owner, serviceId, projectId, allowWrites) {
    const s = service(serviceId), keys = credentials(s);
    if (!keys.clientId || !keys.clientSecret || !(0, store_js_1.vaultReady)())
        throw new Error("This service needs its app credentials and Harvey vault key configured first");
    if (projectId)
        (0, store_js_1.get)("project", owner, projectId);
    const state = (0, crypto_1.randomBytes)(32).toString("hex"), verifier = (0, crypto_1.randomBytes)(32).toString("base64url");
    (0, store_js_1.put)("oauth_state", "system", { id: state, owner, serviceId, projectId, allowWrites, verifier, expires: Date.now() + 600000 });
    const url = new URL(s.authorize);
    url.searchParams.set("client_id", keys.clientId);
    url.searchParams.set("redirect_uri", callbackUrl());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    if (s.scopes)
        url.searchParams.set("scope", s.scopes);
    if (s.pkce) {
        url.searchParams.set("code_challenge", (0, crypto_1.createHash)("sha256").update(verifier).digest("base64url"));
        url.searchParams.set("code_challenge_method", "S256");
    }
    if (s.family === "GOOGLE") {
        url.searchParams.set("access_type", "offline");
        url.searchParams.set("prompt", "consent");
    }
    if (s.family === "NOTION")
        url.searchParams.set("owner", "user");
    return { state, url: url.toString() };
}
async function exchange(s, params) {
    const keys = credentials(s), headers = { Accept: "application/json" };
    let body;
    if (s.basic) {
        headers.Authorization = "Basic " + Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString("base64");
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(params);
    }
    else {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams({ ...params, client_id: keys.clientId, client_secret: keys.clientSecret }).toString();
    }
    const r = await fetch(s.token, { method: "POST", headers, body, signal: AbortSignal.timeout(30000), redirect: "error" });
    const data = await r.json();
    if (!r.ok || data.error || !data.access_token)
        throw new Error(`${s.name} authorization failed. Reconnect the service.`);
    return { ...data, expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null };
}
async function finishOAuth(state, code, cookie) {
    if (!state || state !== cookie)
        throw new Error("Sign-in state did not match. Start again from Plugins.");
    const pending = (0, store_js_1.get)("oauth_state", "system", state);
    (0, store_js_1.remove)("oauth_state", "system", state);
    if (pending.expires < Date.now())
        throw new Error("Sign-in expired. Start again.");
    const s = service(pending.serviceId);
    const tokens = await exchange(s, { grant_type: "authorization_code", code, redirect_uri: callbackUrl(), ...(s.pkce ? { code_verifier: pending.verifier } : {}) });
    return (0, store_js_1.put)("connection", pending.owner, { id: (0, crypto_1.randomUUID)(), service: s.id, name: s.name, kind: "oauth", projectId: pending.projectId, allowWrites: pending.allowWrites, secret: (0, store_js_1.seal)(tokens), updatedAt: new Date().toISOString() });
}
const refreshes = new Map();
async function accessToken(owner, c) {
    let tokens = (0, store_js_1.unseal)(c.secret);
    if (tokens.expiresAt && tokens.expiresAt < Date.now() + 60000) {
        if (!tokens.refresh_token)
            throw new Error("Login expired. Reconnect this service in Plugins.");
        const key = owner + c.id;
        if (!refreshes.has(key))
            refreshes.set(key, (async () => { const fresh = await exchange(service(c.service), { grant_type: "refresh_token", refresh_token: tokens.refresh_token }); const merged = { ...tokens, ...fresh }; const current = (0, store_js_1.get)("connection", owner, c.id); (0, store_js_1.put)("connection", owner, { ...current, secret: (0, store_js_1.seal)(merged) }); return merged; })().finally(() => refreshes.delete(key)));
        tokens = await refreshes.get(key);
    }
    return tokens.access_token;
}
async function connectorRequest(owner, projectId, input) {
    const c = (0, store_js_1.get)("connection", owner, (0, store_js_1.text)(input.connectionId, "Connection"));
    if (c.projectId && c.projectId !== projectId)
        throw new Error("Connection belongs to another project");
    if (c.kind !== "oauth")
        throw new Error("Use plugin_call for MCP connectors");
    const s = service(c.service), method = String(input.method || "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
        throw new Error("Unsupported method");
    const endpoint = (0, store_js_1.text)(input.path, "API path", 2000);
    const url = new URL(endpoint, s.base);
    if (!url.toString().startsWith(s.base) || url.username || url.password)
        throw new Error("API path must stay within this service");
    // RPC services can write through GET. Only known read methods bypass write consent.
    const read = s.id === "slack" ? /^(conversations\.(list|history|replies|info)|users\.(list|info)|auth\.test)$/.test(url.pathname.split("/").pop()) : method === "GET" || (s.id === "notion" && method === "POST" && url.pathname === "/v1/search");
    if (!read && !c.allowWrites)
        throw new Error("This connection is read-only. Enable actions in Plugins first.");
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${await accessToken(owner, c)}`, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Harvey", ...s.headers }, ...(method !== "GET" && input.body !== undefined ? { body: JSON.stringify(input.body) } : {}), redirect: "error", signal: AbortSignal.timeout(45000) });
    const body = (await r.text()).slice(0, 60000);
    if (!r.ok)
        throw new Error(`${s.name} returned ${r.status}: ${body.slice(0, 300)}`);
    if (s.id === "slack") {
        let result;
        try {
            result = JSON.parse(body);
        }
        catch { }
        if (result?.ok === false)
            throw new Error(`Slack: ${String(result.error || "request failed")}`);
    }
    return { status: r.status, body };
}
function validateMcpUrl(value) { const u = new URL((0, store_js_1.text)(value, "MCP URL", 2000)); if (u.protocol !== "https:" || u.username || u.password)
    throw new Error("Use an HTTPS MCP endpoint without credentials in the URL"); return u.toString(); }
async function withMcp(c, fn) {
    const token = (0, store_js_1.unseal)(c.secret).token;
    const client = new index_js_1.Client({ name: "harvey", version: "1.0.0" });
    const transport = new streamableHttp_js_1.StreamableHTTPClientTransport(new URL(c.endpoint), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(60000), redirect: "error" } });
    try {
        await client.connect(transport);
        return await fn(client);
    }
    finally {
        await client.close().catch(() => { });
    }
}
async function addMcp(owner, input) {
    if (input.projectId)
        (0, store_js_1.get)("project", owner, input.projectId);
    const c = { id: (0, crypto_1.randomUUID)(), kind: "mcp", service: "custom", name: (0, store_js_1.text)(input.name, "Connector name", 100), endpoint: validateMcpUrl(input.endpoint), projectId: input.projectId || null, allowWrites: input.allowWrites === true, secret: (0, store_js_1.seal)({ token: String(input.token || "") }), updatedAt: new Date().toISOString() };
    await withMcp(c, client => client.listTools());
    return publicConnection((0, store_js_1.put)("connection", owner, c));
}
async function mcpTools(owner, projectId, id, name, args) {
    const c = (0, store_js_1.get)("connection", owner, id);
    if (c.kind !== "mcp" || (c.projectId && c.projectId !== projectId))
        throw new Error("Connector unavailable in this project");
    return withMcp(c, async (client) => {
        const all = [];
        let cursor;
        do {
            const page = await client.listTools({ cursor });
            all.push(...page.tools);
            cursor = page.nextCursor;
        } while (cursor && all.length < 500);
        if (!name)
            return { tools: all };
        if (!all.some(t => t.name === name))
            throw new Error("Unknown connector tool");
        // Server-provided annotations are hints, not authority to execute arbitrary tools.
        if (!c.allowWrites)
            throw new Error("Enable actions on this custom connector in Plugins before running its tools");
        const result = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 60000 });
        if (result.isError)
            throw new Error(JSON.stringify(result.content).slice(0, 2000));
        return result;
    });
}
