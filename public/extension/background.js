/**
 * Harvey Browser Control — service worker.
 *
 * Polls the server for commands and runs them in the active tab. The server
 * can't reach into a browser, so the browser asks; that also means a laptop
 * that sleeps or drops wifi just resumes on its own with no reconnect logic.
 *
 * Nothing runs unless the user has both paired (server URL + token) and
 * switched control ON. The OFF state still polls so the app can show the
 * extension is installed and reachable — it just receives no work.
 */

const POLL_MS = 2000;
const IDLE_POLL_MS = 6000; // slower when switched off; nothing can arrive anyway

let polling = false;

/**
 * Keep only the origin. People paste the page they're looking at
 * (".../shell"), not the API root, and every request then 404s. Duplicated in
 * popup.js on purpose — the popup and the worker are separate contexts and
 * this manifest doesn't load modules.
 */
function normalizeServer(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : "https://" + s).origin;
  } catch (_) {
    return s.replace(/\/+$/, "");
  }
}

async function config() {
  const c = await chrome.storage.local.get(["serverUrl", "token", "enabled"]);
  return {
    serverUrl: normalizeServer(c.serverUrl),
    token: c.token || "",
    enabled: c.enabled === true,
  };
}

async function setBadge(state) {
  // Green = armed, grey = paired but off, red = can't reach the server.
  const map = { on: ["ON", "#10b981"], off: ["", "#94a3b8"], err: ["!", "#dc2626"] };
  const [text, color] = map[state] || map.off;
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {}
}

/** The tab commands act on: whatever the user is looking at. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

/** Run a function inside the page. Content-script work happens here. */
async function inPage(tabId, fn, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args: args ? [args] : [],
    world: "MAIN",
  });
  return res?.result;
}

/* ── The page-side implementations. These are injected, so they must be
      self-contained: no closures over anything in this file. ── */

function pageClick(arg) {
  const { selector, text } = arg;
  let el = null;
  if (selector) el = document.querySelector(selector);
  if (!el && text) {
    // Click by visible label — how a person would describe it ("the Save
    // button"), rather than requiring a selector nobody knows.
    const needle = String(text).toLowerCase().trim();
    const candidates = document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"]');
    for (const c of candidates) {
      const label = (c.innerText || c.value || c.getAttribute("aria-label") || "").toLowerCase().trim();
      if (label && (label === needle || label.includes(needle))) { el = c; break; }
    }
  }
  if (!el) return { ok: false, error: "Nothing matched " + (selector || '"' + text + '"') };
  el.scrollIntoView({ block: "center" });
  el.click();
  return { ok: true, data: "clicked " + (el.tagName.toLowerCase()) };
}

function pageFill(arg) {
  const filled = [];
  const missing = [];
  for (const [sel, value] of Object.entries(arg.fields || {})) {
    const el = document.querySelector(sel);
    if (!el) { missing.push(sel); continue; }
    // Refuse password fields outright. "Fill in this form" must never become
    // a way to type into a credential box.
    if (el.type === "password") { missing.push(sel + " (password field — refused)"); continue; }
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    // Use the native setter so React/Vue-style frameworks see the change.
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filled.push(sel);
  }
  return { ok: filled.length > 0 || missing.length === 0, data: { filled, missing } };
}

function pageRead(arg) {
  const sel = arg && arg.selector;
  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return { ok: false, error: "Nothing matched " + sel };
  const text = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  // Cap it — a full portal page can be enormous and the model only needs
  // enough to work with.
  return { ok: true, data: text.slice(0, 12000) };
}

function pageExtract(arg) {
  const out = {};
  for (const [name, sel] of Object.entries(arg.schema || {})) {
    const nodes = document.querySelectorAll(sel);
    if (!nodes.length) { out[name] = null; continue; }
    out[name] = nodes.length === 1
      ? (nodes[0].innerText || nodes[0].value || "").trim()
      : Array.from(nodes).map((n) => (n.innerText || n.value || "").trim()).filter(Boolean);
  }
  return { ok: true, data: out };
}

async function execute(cmd) {
  const tab = await activeTab();
  if (!tab || !tab.id) return { ok: false, error: "No active tab to work in." };

  // Chrome refuses injection on its own pages; say so clearly rather than
  // surfacing an opaque platform error.
  if (/^(chrome|edge|about|devtools):/i.test(tab.url || "")) {
    return { ok: false, error: "Can't act on a browser internal page (" + (tab.url || "").split("/")[0] + "). Switch to a normal site tab." };
  }

  try {
    switch (cmd.action) {
      case "navigate": {
        if (!cmd.url) return { ok: false, error: "navigate needs a url" };
        await chrome.tabs.update(tab.id, { url: cmd.url });
        await waitForLoad(tab.id, cmd.timeoutMs || 20000);
        const t = await chrome.tabs.get(tab.id);
        return { ok: true, data: "navigated", url: t.url, title: t.title };
      }
      case "click": {
        const r = await inPage(tab.id, pageClick, { selector: cmd.selector, text: cmd.text });
        // A click often starts a navigation; give it a moment to settle so the
        // next read doesn't catch the old page.
        await sleep(600);
        return r;
      }
      case "fill":
        return await inPage(tab.id, pageFill, { fields: cmd.fields || {} });
      case "read":
        return await inPage(tab.id, pageRead, { selector: cmd.selector });
      case "extract":
        return await inPage(tab.id, pageExtract, { schema: cmd.schema || {} });
      case "wait":
        await sleep(Math.min(cmd.timeoutMs || 1500, 10000));
        return { ok: true, data: "waited" };
      default:
        return { ok: false, error: "Unknown action: " + cmd.action };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(t); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const t = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function pollOnce() {
  const { serverUrl, token, enabled } = await config();
  if (!serverUrl || !token) { await setBadge("off"); return IDLE_POLL_MS; }

  let tabInfo = {};
  try {
    const tab = await activeTab();
    if (tab) tabInfo = { url: tab.url, title: tab.title };
  } catch (_) {}

  let commands = [];
  try {
    const res = await fetch(serverUrl + "/api/browser/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, enabled, page: tabInfo }),
    });
    if (!res.ok) { await setBadge("err"); return IDLE_POLL_MS; }
    const body = await res.json();
    commands = body.commands || [];
  } catch (_) {
    await setBadge("err");
    return IDLE_POLL_MS;
  }

  await setBadge(enabled ? "on" : "off");

  for (const cmd of commands) {
    const result = await execute(cmd);
    let page = {};
    try {
      const tab = await activeTab();
      if (tab) page = { url: tab.url, title: tab.title };
    } catch (_) {}
    try {
      await fetch(serverUrl + "/api/browser/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          id: cmd.id,
          ok: !!result.ok,
          data: result.data,
          error: result.error,
          url: result.url || page.url,
          title: result.title || page.title,
        }),
      });
    } catch (_) {}
  }

  return enabled ? POLL_MS : IDLE_POLL_MS;
}

async function loop() {
  if (polling) return;
  polling = true;
  // A plain interval would stack up if a command outlives the tick, so each
  // cycle schedules the next only once it's finished.
  for (;;) {
    let wait = IDLE_POLL_MS;
    try { wait = await pollOnce(); } catch (_) {}
    await sleep(wait);
  }
}

chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(loop);
loop();

// The popup asks for live status and can trigger an immediate poll after the
// user flips the switch, so ON feels instant instead of up-to-6s later.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "harvey:ping") {
    config().then((c) => reply({ ok: true, ...c }));
    return true;
  }
  if (msg && msg.type === "harvey:poll-now") {
    pollOnce().then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
    return true;
  }
  return false;
});
