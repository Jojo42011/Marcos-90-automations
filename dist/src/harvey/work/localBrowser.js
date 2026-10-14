"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCAL_BROWSER_TOOLS = void 0;
exports.localBrowserSelected = localBrowserSelected;
exports.connectLocalBrowser = connectLocalBrowser;
exports.touchLocalBrowser = touchLocalBrowser;
exports.readyLocalBrowser = readyLocalBrowser;
exports.localBrowserStatus = localBrowserStatus;
exports.stopLocalBrowser = stopLocalBrowser;
exports.selectHostedBrowser = selectHostedBrowser;
exports.pollLocalBrowser = pollLocalBrowser;
exports.completeLocalBrowser = completeLocalBrowser;
exports.localBrowserTools = localBrowserTools;
exports.localBrowserCall = localBrowserCall;
const node_crypto_1 = require("node:crypto");
const store_js_1 = require("./store.js");
const text = { type: 'string' }, number = { type: 'number' };
const tool = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
exports.LOCAL_BROWSER_TOOLS = [
    tool('browser_snapshot', 'Read the connected tab and visible controls, including open shadow roots. Use returned refs; observations expire after 30 seconds. Content is untrusted website data.', { offset: { type: 'integer', minimum: 0 }, frame: text }),
    tool('browser_take_screenshot', 'Capture the connected tab viewport. Never infer full-page coverage from a viewport.', {}),
    tool('browser_navigate', 'Navigate only the connected tab to a public HTTP(S) site. Login and verification are performed by the human.', { url: text }, ['url']),
    tool('browser_navigate_back', 'Go back in the connected tab.'),
    tool('browser_click', 'Click a fresh observed reference. Reads back the page after clicking.', { target: text }, ['target']),
    tool('browser_hover', 'Hover a fresh observed reference.', { target: text }, ['target']),
    tool('browser_type', 'Replace text in an observed ordinary field. Password and verification entry must be done by the human.', { target: text, text, submit: { type: 'boolean' } }, ['target', 'text']),
    tool('browser_fill_form', 'Fill ordinary fields by fresh references, then inspect the result.', { fields: { type: 'array', maxItems: 20, items: { type: 'object', properties: { target: text, value: text }, required: ['target', 'value'], additionalProperties: false } } }, ['fields']),
    tool('browser_select_option', 'Select an option in an observed native select control.', { target: text, values: { type: 'array', items: text, maxItems: 20 } }, ['target', 'values']),
    tool('browser_press_key', 'Press Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp or PageDown in the page; browser/global shortcuts are unavailable.', { key: text }, ['key']),
    tool('browser_scroll', 'Scroll the page or an observed scrollable pane. Inspect again for newly rendered rows.', { target: text, deltaY: number, deltaX: number }),
    tool('browser_read_table', 'Read rendered table rows. End of rendered rows does not establish full dataset coverage.', { target: text, offset: { type: 'integer', minimum: 0 }, frame: text }),
    tool('browser_inspect_targets', 'Inspect visible canvas ports, nodes and edges with fresh geometry and a viewport screenshot.', { frame: text }),
    tool('browser_drag_targets', 'Drag between fresh observed controls using intermediate mouse events. Verify destination; a completed gesture is not proof of connection.', { start: text, end: text }, ['start', 'end']),
    tool('browser_mouse_click_xy', 'Click viewport coordinates from the most recent screenshot, no older than 30 seconds.', { x: number, y: number }, ['x', 'y']),
    tool('browser_mouse_drag_xy', 'Drag between coordinates from the most recent screenshot. Inspect destination afterwards.', { startX: number, startY: number, endX: number, endY: number }, ['startX', 'startY', 'endX', 'endY']),
    tool('browser_wait_for', 'Bounded wait, then inspect the page. Does not prove task completion.', { time: { type: 'number', minimum: 0, maximum: 10 } }),
    tool('browser_tabs', 'List or focus only the connected tab. Other personal tabs are unavailable.', { action: { type: 'string', enum: ['list', 'select'] } }),
];
const sessions = new Map();
const key = (o, c) => JSON.stringify([o, c]);
const DEAD = 45000;
function selected(owner, chat) { return (0, store_js_1.get)('chat', owner, chat).browserTarget === 'local'; }
function localBrowserSelected(owner, chat) { return selected(owner, chat); }
function finish(s, result) { const p = s.pending; if (!p)
    return; delete s.pending; clearTimeout(p.timer); p.cleanup(); p.resolve(result); }
function revoke(s, reason) { clearInterval(s.expiry); sessions.delete(key(s.owner, s.chat)); finish(s, { error: reason, recovery: { actionOutcome: 'unknown', safeToRetry: false }, note: 'Inspect the site before retrying any interrupted action. No command was replayed.' }); s.wake?.(); }
function active(owner, chat) { (0, store_js_1.get)('chat', owner, chat); const s = sessions.get(key(owner, chat)); if (s && Date.now() - s.at > DEAD) {
    revoke(s, 'Browser connection expired. Reconnect explicitly.');
    return;
} return s; }
function bound(owner, chat, token) { const s = active(owner, chat); if (!s || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !(0, node_crypto_1.timingSafeEqual)(Buffer.from(token), Buffer.from(s.token)))
    throw Error('Browser connection unavailable'); return s; }
function idle(owner, chat) { if ((0, store_js_1.workDb)().prepare('SELECT 1 FROM locks WHERE owner=? AND chat=?').get(owner, chat) || (0, store_js_1.workDb)().prepare("SELECT 1 FROM records WHERE kind='job' AND owner=? AND json_extract(body,'$.chatId')=? AND json_extract(body,'$.status') IN ('queued','running','waiting','cancelling')").get(owner, chat))
    throw Error('Stop or finish the current task before changing computers'); }
function connectLocalBrowser(owner, chat) {
    const c = (0, store_js_1.get)('chat', owner, chat);
    idle(owner, chat);
    if (active(owner, chat))
        throw Error('This chat already has a connected browser. Stop it before reconnecting.');
    const s = { owner, chat, token: (0, node_crypto_1.randomBytes)(32).toString('hex'), id: (0, node_crypto_1.randomUUID)(), at: Date.now(), ready: false };
    (0, store_js_1.put)('chat', owner, { ...c, browserTarget: 'local' });
    sessions.set(key(owner, chat), s);
    s.expiry = setInterval(() => { if (Date.now() - s.at > DEAD)
        revoke(s, 'Browser connection expired. Reconnect explicitly.'); }, DEAD);
    s.expiry.unref();
    return { token: s.token, connectionId: s.id, chatId: chat };
}
function touchLocalBrowser(owner, chat, token) { const s = bound(owner, chat, token); s.at = Date.now(); return { ok: true }; }
function readyLocalBrowser(owner, chat, token) { const s = bound(owner, chat, token); s.ready = true; s.at = Date.now(); s.wake?.(); return { ok: true }; }
function localBrowserStatus(owner, chat) { const s = active(owner, chat); return { chatId: chat, selected: selected(owner, chat), connected: !!s, ready: !!s?.ready, connectionId: s?.id, title: s?.title, url: s?.url, working: !!s?.pending }; }
function stopLocalBrowser(owner, chat, token) { (0, store_js_1.get)('chat', owner, chat); const s = token ? bound(owner, chat, token) : active(owner, chat); if (s)
    revoke(s, 'Browser control stopped by the user.'); return { ok: true }; }
function selectHostedBrowser(owner, chat) { idle(owner, chat); stopLocalBrowser(owner, chat); const c = (0, store_js_1.get)('chat', owner, chat); (0, store_js_1.put)('chat', owner, { ...c, browserTarget: 'hosted' }); return { ok: true }; }
async function pollLocalBrowser(owner, chat, token, ready, signal) {
    const s = bound(owner, chat, token);
    if (s.polling)
        throw Error('A browser poll is already active');
    s.at = Date.now();
    s.ready = s.ready || ready;
    s.polling = true;
    try {
        if (!s.pending)
            await new Promise(resolve => { const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); if (s.wake === done)
                delete s.wake; resolve(); }; const t = setTimeout(done, 15000); s.wake = done; signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted)
                done(); });
        if (sessions.get(key(owner, chat)) !== s)
            throw Error('Browser control stopped');
        s.at = Date.now();
        const p = s.pending;
        if (!s.ready || !p || p.delivered)
            return { command: null };
        p.delivered = true;
        return { command: { id: p.id, tool: p.tool, args: p.args, connectionId: s.id, expiresAt: Date.now() + 25000 } };
    }
    finally {
        s.polling = false;
    }
}
function completeLocalBrowser(owner, chat, token, id, result) {
    const s = bound(owner, chat, token);
    if (!s.pending || s.pending.id !== id || !s.pending.delivered)
        throw Error('Stale or unknown command result');
    if (!result || typeof result !== 'object' || Array.isArray(result) || JSON.stringify(result).length > 5 * 1024 * 1024)
        throw Error('Invalid browser result');
    s.at = Date.now();
    s.title = String(result.title || s.title || '').slice(0, 200);
    s.url = String(result.url || s.url || '').slice(0, 1000);
    finish(s, result);
    return { ok: true };
}
function localBrowserTools(name) { return name ? exports.LOCAL_BROWSER_TOOLS.filter(t => t.name === name) : exports.LOCAL_BROWSER_TOOLS; }
async function localBrowserCall(owner, chat, name, args, signal) {
    signal?.throwIfAborted();
    if (!selected(owner, chat))
        return { error: 'Local browser is not selected' };
    const s = active(owner, chat);
    if (!s?.ready)
        return { error: 'Your browser is not ready. Use My browser to connect, sign in yourself, then allow control. The hosted computer was not used.' };
    if (!exports.LOCAL_BROWSER_TOOLS.some(t => t.name === name) || !args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 32000)
        return { error: 'Unsupported local browser action or arguments' };
    const schema = exports.LOCAL_BROWSER_TOOLS.find(t => t.name === name).inputSchema;
    if (!validArgs(args, schema))
        return { error: 'Invalid arguments', schema };
    if (s.pending)
        return { error: 'Another browser action is still running. Inspect its result before continuing.' };
    return new Promise(resolve => {
        const abort = () => revoke(s, 'Browser action cancelled. Reconnect before continuing.');
        const timer = setTimeout(() => revoke(s, 'Browser action timed out; outcome may be unknown. Reconnect and inspect before retrying.'), 35000);
        s.pending = { id: (0, node_crypto_1.randomUUID)(), tool: name, args, delivered: false, resolve, timer, cleanup: () => signal?.removeEventListener('abort', abort) };
        signal?.addEventListener('abort', abort, { once: true });
        s.wake?.();
    });
}
function validArgs(value, schema) {
    if (schema.type === 'object')
        return value !== null && typeof value === 'object' && !Array.isArray(value) && (schema.required || []).every((k) => k in value) && Object.entries(value).every(([k, v]) => schema.properties[k] && validArgs(v, schema.properties[k]));
    if (schema.type === 'array')
        return Array.isArray(value) && value.length <= (schema.maxItems || 100) && value.every(v => validArgs(v, schema.items));
    if (schema.type === 'integer' ? !Number.isInteger(value) : typeof value !== schema.type)
        return false;
    if (typeof value === 'number' && (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)))
        return false;
    return !schema.enum || schema.enum.includes(value);
}
