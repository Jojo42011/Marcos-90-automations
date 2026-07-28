/**
 * Harvey Browser Control — service worker.
 *
 * Polls the server for commands and runs them in a tab Harvey owns. The server
 * can't reach into a browser, so the browser asks; that also means a laptop
 * that sleeps or drops wifi just resumes on its own with no reconnect logic.
 *
 * Nothing runs unless the user has both paired (server URL + token) and
 * switched control ON. The OFF state still polls so the app can show the
 * extension is installed and reachable — it just receives no work.
 *
 * THE WORK TAB — why commands don't target the active tab.
 * They used to, and it made Harvey destroy himself: the tab the user is
 * looking at when they ask for something is the tab Harvey's own page is open
 * in, so "pull up that listing" navigated the shell away to Zillow and the
 * conversation was gone mid-task. Harvey now keeps a dedicated work tab,
 * opened in the background on first navigate, and every command targets that.
 * The shell tab is never a valid target — it is excluded explicitly, not just
 * by luck of which tab happens to be focused.
 */

/** How long the server may park our poll. Must stay under Chrome's 30s
 *  service-worker idle kill even with the keepalive as a safety net. */
const LONG_POLL_MS = 20000;
/** Backoff after an error or while unpaired — not the normal path, which
 *  parks on the server instead of sleeping on a timer. */
const IDLE_POLL_MS = 6000;

/** Service workers get killed, so the work tab id lives in storage, not here. */
const WORK_TAB_KEY = "workTabId";

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

/** Chrome refuses script injection on its own pages. */
function isInternalUrl(url) {
  return /^(chrome|edge|about|devtools|chrome-extension):/i.test(url || "");
}

/**
 * Is this one of the app's own pages — the shell Harvey is being talked to
 * from? Never a valid work tab: driving it navigates Harvey out of existence.
 */
function isAppTab(tab, serverUrl) {
  if (!tab || !tab.url || !serverUrl) return false;
  try {
    return new URL(tab.url).origin === new URL(serverUrl).origin;
  } catch (_) {
    return false;
  }
}

async function readWorkTabId() {
  const c = await chrome.storage.local.get([WORK_TAB_KEY]);
  return typeof c[WORK_TAB_KEY] === "number" ? c[WORK_TAB_KEY] : null;
}

async function writeWorkTabId(id) {
  if (id == null) await chrome.storage.local.remove(WORK_TAB_KEY);
  else await chrome.storage.local.set({ [WORK_TAB_KEY]: id });
}

/**
 * Harvey's tab, or null if he hasn't opened one / the user closed it.
 * Forgets the id on any of those, so the next navigate opens a fresh tab
 * instead of failing forever on a dead id.
 */
async function workTab(serverUrl) {
  const id = await readWorkTabId();
  if (id == null) return null;
  let tab = null;
  try {
    tab = await chrome.tabs.get(id);
  } catch (_) {
    await writeWorkTabId(null); // closed
    return null;
  }
  // If the user navigated Harvey's tab onto the app itself, stop treating it
  // as the work tab rather than driving the shell.
  if (isAppTab(tab, serverUrl)) {
    await writeWorkTabId(null);
    return null;
  }
  return tab;
}

/** Open Harvey a tab of his own, in the background so the shell keeps focus. */
async function openWorkTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await writeWorkTabId(tab.id);
  return tab;
}

/**
 * Target for a command that needs a page already open. If Harvey has no work
 * tab yet, adopt the tab the user is on — but only when it is a real site tab
 * and not the shell, so "read the page I'm looking at" keeps working without
 * ever letting the shell become the target.
 */
async function targetTab(serverUrl) {
  const existing = await workTab(serverUrl);
  if (existing) return existing;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && active.id != null && !isAppTab(active, serverUrl) && !isInternalUrl(active.url)) {
    await writeWorkTabId(active.id);
    return active;
  }
  return null;
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

/* ── The page-side implementations ─────────────────────────────────────────
   These are injected with chrome.scripting, so each one must be entirely
   self-contained: no closures over anything in this file, no shared helpers.
   That forces some duplication (the DOM-walking preamble appears in each),
   which is deliberate — a "tidier" shared helper silently becomes undefined
   inside the page and every action fails with a confusing ReferenceError.

   Everything below queries through a deep walk rather than plain
   document.querySelector, because real portals put their content inside web
   components and same-origin iframes. A selector that works when you paste it
   into DevTools (which searches the inspected root) would otherwise come back
   empty here, and it looks exactly like "the site changed". ── */

/** Injected: every searchable root — document, open shadow roots, same-origin
 *  iframe documents. Closed shadow roots are genuinely unreachable. */
function pageRoots() {
  const roots = [document];
  const seen = new Set();
  const walk = (root, depth) => {
    if (!root || depth > 8 || seen.has(root)) return;
    seen.add(root);
    let all = [];
    try { all = root.querySelectorAll("*"); } catch (_) { return; }
    for (const el of all) {
      if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, depth + 1); }
      if (el.tagName === "IFRAME") {
        // Cross-origin frames throw on access. That's a browser boundary, not
        // something to work around.
        try {
          const doc = el.contentDocument;
          if (doc) { roots.push(doc); walk(doc, depth + 1); }
        } catch (_) { /* cross-origin */ }
      }
    }
  };
  walk(document, 0);
  return roots;
}

function pageClick(arg) {
  const ROOTS = (function collect() {
    const roots = [document]; const seen = new Set();
    const walk = (r, d) => {
      if (!r || d > 8 || seen.has(r)) return; seen.add(r);
      let all = []; try { all = r.querySelectorAll("*"); } catch (_) { return; }
      for (const el of all) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, d + 1); }
        if (el.tagName === "IFRAME") { try { const doc = el.contentDocument; if (doc) { roots.push(doc); walk(doc, d + 1); } } catch (_) {} }
      }
    };
    walk(document, 0); return roots;
  })();
  const visible = (el) => {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const s = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };

  const { selector, text } = arg;
  let el = null;

  if (selector) {
    for (const r of ROOTS) {
      try { const found = r.querySelector(selector); if (found) { el = found; break; } } catch (_) {}
    }
  }

  if (!el && text) {
    // Click by visible label — how a person describes it ("the Save button"),
    // not a selector nobody knows. Scored rather than first-match: an exact
    // label must beat a longer one that merely contains the phrase, or
    // "Search" hits "Search all listings in this area" every time.
    const needle = String(text).toLowerCase().trim();
    const sel = 'a,button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],' +
                'input[type="submit"],input[type="button"],summary,[onclick],label';
    let best = null, bestScore = -1;
    for (const r of ROOTS) {
      let nodes = [];
      try { nodes = r.querySelectorAll(sel); } catch (_) { continue; }
      for (const c of nodes) {
        const label = (
          c.innerText || c.value || c.getAttribute("aria-label") ||
          c.getAttribute("title") || c.textContent || ""
        ).toLowerCase().replace(/\s+/g, " ").trim();
        if (!label) continue;
        let score = -1;
        if (label === needle) score = 100;
        else if (label.startsWith(needle)) score = 70;
        else if (label.includes(needle)) score = 40;
        else continue;
        if (visible(c)) score += 25;
        if (c.disabled) score -= 60;
        // Prefer the tightest match when several contain the phrase.
        score -= Math.min(20, Math.floor(label.length / 12));
        if (score > bestScore) { bestScore = score; best = c; }
      }
    }
    el = best;
  }

  if (!el) {
    return {
      ok: false,
      error: "Nothing on the page matched " + (selector ? selector : '"' + text + '"') +
        ". Read the page first to see the real labels, or the content may still be loading — wait for it, then retry.",
    };
  }
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
  const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60);
  el.click();
  return { ok: true, data: "clicked <" + el.tagName.toLowerCase() + ">" + (label ? ' "' + label + '"' : "") };
}

function pageFill(arg) {
  const ROOTS = (function collect() {
    const roots = [document]; const seen = new Set();
    const walk = (r, d) => {
      if (!r || d > 8 || seen.has(r)) return; seen.add(r);
      let all = []; try { all = r.querySelectorAll("*"); } catch (_) { return; }
      for (const el of all) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, d + 1); }
        if (el.tagName === "IFRAME") { try { const doc = el.contentDocument; if (doc) { roots.push(doc); walk(doc, d + 1); } } catch (_) {} }
      }
    };
    walk(document, 0); return roots;
  })();
  const find = (sel) => {
    for (const r of ROOTS) { try { const f = r.querySelector(sel); if (f) return f; } catch (_) {} }
    return null;
  };
  const fire = (el, names) => {
    for (const n of names) {
      try { el.dispatchEvent(new Event(n, { bubbles: true })); } catch (_) {}
    }
  };

  const filled = [];
  const refused = [];
  const missing = [];

  for (const [sel, rawValue] of Object.entries(arg.fields || {})) {
    const el = find(sel);
    if (!el) { missing.push(sel); continue; }
    const value = rawValue == null ? "" : String(rawValue);

    // Refuse credential boxes outright. This is OUR rule, not a browser
    // restriction — say so accurately in the reason so nobody goes hunting
    // for a Chrome setting that would "allow" it.
    if (el.type === "password") {
      refused.push(sel + " — password field, refused by Harvey's own safety rule (not a browser limitation). The operator types this themselves.");
      continue;
    }

    const tag = (el.tagName || "").toLowerCase();
    try {
      if (tag === "select") {
        // Match by value, then by visible option text — a person says
        // "set the state to Texas", not "set it to TX".
        const opts = Array.from(el.options || []);
        const want = value.toLowerCase().trim();
        const hit = opts.find((o) => o.value.toLowerCase() === want)
          || opts.find((o) => (o.text || "").toLowerCase().trim() === want)
          || opts.find((o) => (o.text || "").toLowerCase().includes(want));
        if (!hit) {
          refused.push(sel + ' — no option matching "' + value + '". Options: ' + opts.slice(0, 12).map((o) => o.text).join(", "));
          continue;
        }
        el.value = hit.value;
        fire(el, ["input", "change"]);
        filled.push(sel + " = " + hit.text);
        continue;
      }

      if (el.type === "checkbox" || el.type === "radio") {
        const on = !/^(false|0|no|off|unchecked|)$/i.test(value.trim());
        if (el.checked !== on) el.click();       // click, so framework handlers run
        filled.push(sel + " = " + (el.checked ? "checked" : "unchecked"));
        continue;
      }

      if (el.isContentEditable) {
        el.focus();
        el.textContent = value;
        fire(el, ["input", "change"]);
        filled.push(sel);
        continue;
      }

      // Text-like inputs. Use the native value setter so React/Vue see the
      // change — assigning .value directly is swallowed by their tracking.
      const win = el.ownerDocument.defaultView || window;
      const proto = tag === "textarea" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
      el.focus();
      if (setter) setter.call(el, value); else el.value = value;
      // keydown/keyup too: some autocompletes only react to key events.
      fire(el, ["input", "change", "keyup", "blur"]);
      filled.push(sel);
    } catch (e) {
      refused.push(sel + " — " + String((e && e.message) || e));
    }
  }

  return {
    ok: filled.length > 0,
    data: { filled, refused, missing },
  };
}

function pageRead(arg) {
  const sel = arg && arg.selector;
  let root = document.body;
  if (sel) {
    const ROOTS = (function collect() {
      const roots = [document]; const seen = new Set();
      const walk = (r, d) => {
        if (!r || d > 8 || seen.has(r)) return; seen.add(r);
        let all = []; try { all = r.querySelectorAll("*"); } catch (_) { return; }
        for (const el of all) {
          if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, d + 1); }
          if (el.tagName === "IFRAME") { try { const doc = el.contentDocument; if (doc) { roots.push(doc); walk(doc, d + 1); } } catch (_) {} }
        }
      };
      walk(document, 0); return roots;
    })();
    root = null;
    for (const r of ROOTS) { try { const f = r.querySelector(sel); if (f) { root = f; break; } } catch (_) {} }
    if (!root) return { ok: false, error: "Nothing matched " + sel };
  }
  let text = (root.innerText || root.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // A login wall reads as a nearly empty page, and Harvey would otherwise
  // report "the listing isn't there" when the real answer is "sign in".
  const pw = document.querySelector('input[type="password"]');
  const loginish = pw && /sign in|log ?in|password|username|email/i.test(text.slice(0, 2000));

  const truncated = text.length > 12000;
  return {
    ok: true,
    data: text.slice(0, 12000),
    truncated,
    title: document.title,
    url: location.href,
    needsLogin: Boolean(loginish),
  };
}

function pageExtract(arg) {
  const ROOTS = (function collect() {
    const roots = [document]; const seen = new Set();
    const walk = (r, d) => {
      if (!r || d > 8 || seen.has(r)) return; seen.add(r);
      let all = []; try { all = r.querySelectorAll("*"); } catch (_) { return; }
      for (const el of all) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, d + 1); }
        if (el.tagName === "IFRAME") { try { const doc = el.contentDocument; if (doc) { roots.push(doc); walk(doc, d + 1); } } catch (_) {} }
      }
    };
    walk(document, 0); return roots;
  })();

  const valueOf = (n, attr) => {
    if (attr) {
      // Properties beat attributes for href/src so relative URLs come back
      // absolute — a relative href is useless to something outside the page.
      if (attr === "href" && n.href) return String(n.href);
      if (attr === "src" && n.src) return String(n.src);
      return n.getAttribute(attr);
    }
    if (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT") return (n.value || "").trim();
    if (n.tagName === "IMG") return n.getAttribute("alt") || n.src || "";
    if (n.tagName === "META") return n.getAttribute("content") || "";
    return (n.innerText || n.textContent || "").replace(/\s+/g, " ").trim();
  };

  const out = {};
  const notFound = [];
  for (const [name, rawSel] of Object.entries(arg.schema || {})) {
    // "a.listing @href" pulls the attribute instead of the text.
    const m = String(rawSel).match(/^(.*?)\s*@([\w:-]+)\s*$/);
    const sel = (m ? m[1] : String(rawSel)).trim();
    const attr = m ? m[2] : null;

    let nodes = [];
    for (const r of ROOTS) {
      try {
        const found = r.querySelectorAll(sel);
        if (found && found.length) { nodes = Array.from(found); break; }
      } catch (_) { /* invalid selector for this root */ }
    }
    if (!nodes.length) { out[name] = null; notFound.push(name); continue; }
    const vals = nodes.map((n) => valueOf(n, attr)).filter((v) => v != null && String(v).length);
    out[name] = nodes.length === 1 ? (vals[0] ?? null) : vals;
  }
  return { ok: true, data: out, notFound, url: location.href };
}

/**
 * Injected: pull the page's own structured data.
 *
 * Listing portals publish schema.org JSON-LD for search engines, and that
 * block is far more stable than any CSS class — class names churn with every
 * redesign, the JSON-LD does not. Try this before guessing selectors.
 */
function pageStructured() {
  const out = { jsonLd: [], openGraph: {}, title: document.title, url: location.href };
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    try {
      const parsed = JSON.parse(s.textContent || "");
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && typeof item === "object") {
          // @graph is how many CMSes wrap several entities in one block.
          const graph = item["@graph"];
          if (Array.isArray(graph)) out.jsonLd.push(...graph);
          else out.jsonLd.push(item);
        }
      }
    } catch (_) { /* a malformed block shouldn't lose the good ones */ }
  }
  for (const m of document.querySelectorAll('meta[property^="og:"],meta[name^="og:"],meta[name="description"],meta[property^="product:"]')) {
    const key = m.getAttribute("property") || m.getAttribute("name");
    const val = m.getAttribute("content");
    if (key && val) out.openGraph[key] = val;
  }
  // Cap it: some sites embed enormous graphs and the model only needs the shape.
  const json = JSON.stringify(out.jsonLd);
  if (json.length > 40000) {
    out.jsonLd = out.jsonLd.slice(0, 5);
    out.note = "JSON-LD was very large; showing the first few entities.";
  }
  const found = out.jsonLd.length > 0 || Object.keys(out.openGraph).length > 0;
  return {
    ok: true,
    data: out,
    note: found ? undefined : "This page publishes no JSON-LD or OpenGraph data — fall back to reading it and extracting with selectors.",
  };
}

/** Injected: is the element/text there yet? Polled from the worker side. */
function pagePresent(arg) {
  const ROOTS = (function collect() {
    const roots = [document]; const seen = new Set();
    const walk = (r, d) => {
      if (!r || d > 8 || seen.has(r)) return; seen.add(r);
      let all = []; try { all = r.querySelectorAll("*"); } catch (_) { return; }
      for (const el of all) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, d + 1); }
        if (el.tagName === "IFRAME") { try { const doc = el.contentDocument; if (doc) { roots.push(doc); walk(doc, d + 1); } } catch (_) {} }
      }
    };
    walk(document, 0); return roots;
  })();
  if (arg.selector) {
    for (const r of ROOTS) {
      try { if (r.querySelector(arg.selector)) return true; } catch (_) {}
    }
    return false;
  }
  if (arg.text) {
    const needle = String(arg.text).toLowerCase();
    return (document.body.innerText || "").toLowerCase().includes(needle);
  }
  return document.readyState === "complete";
}

/**
 * Take a picture of Harvey's tab.
 *
 * Two things make this less trivial than it sounds:
 *
 * 1. captureVisibleTab only ever captures the ACTIVE tab of a window, and
 *    Harvey's tab is deliberately in the background. So it is brought forward
 *    for the capture and the operator's tab is put straight back. That is a
 *    brief visible flicker — unavoidable with this API, and worth naming
 *    rather than pretending the capture is invisible.
 * 2. A raw screenshot is far too big to hand a model. It is re-encoded down to
 *    a sane width as JPEG; a 1920px PNG is megabytes, which would be slow,
 *    expensive, and past the image size limit.
 */
async function captureTab(tab, opts) {
  const maxWidth = Math.min(Math.max(Number(opts && opts.maxWidth) || 1000, 320), 1568);
  let previous = null;
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active && active.id !== tab.id) previous = active.id;
  } catch (_) {}

  let dataUrl;
  try {
    if (previous != null) {
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(300);   // let the compositor actually paint it
    }
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
  } finally {
    // Always hand focus back, even if the capture threw — leaving the operator
    // staring at Harvey's tab would be worse than failing the command.
    if (previous != null) {
      try { await chrome.tabs.update(previous, { active: true }); } catch (_) {}
    }
  }
  if (!dataUrl) return { ok: false, error: "Chrome returned no image for this tab." };

  const blob = await (await fetch(dataUrl)).blob();
  let media = "image/jpeg";
  let bytes;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
    bytes = new Uint8Array(await out.arrayBuffer());
    bmp.close();
  } catch (_) {
    // OffscreenCanvas missing or the decode failed — send Chrome's own JPEG.
    bytes = new Uint8Array(await blob.arrayBuffer());
  }

  // Chunked: spreading a few hundred thousand bytes into String.fromCharCode
  // overflows the argument stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  const b64 = btoa(binary);

  const t = await chrome.tabs.get(tab.id);
  return {
    ok: true,
    data: { url: t.url, title: t.title, kb: Math.round(b64.length / 1024) },
    image: { media_type: media, data: b64 },
  };
}

/** Injected: scroll, so lazy-loaded listings actually render before a read. */
async function pageScroll(arg) {
  const to = arg && arg.to;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (to === "top") { window.scrollTo({ top: 0 }); await sleep(400); return { ok: true, data: "scrolled to top" }; }
  if (typeof to === "number") { window.scrollBy({ top: to }); await sleep(400); return { ok: true, data: "scrolled " + to + "px" }; }
  // Default: walk to the bottom in steps, pausing so infinite-scroll handlers
  // fire. One jump to the bottom loads nothing on most lazy pages.
  let last = -1;
  for (let i = 0; i < 12; i++) {
    window.scrollTo({ top: document.body.scrollHeight });
    await sleep(450);
    const h = document.body.scrollHeight;
    if (h === last) break;
    last = h;
  }
  return { ok: true, data: "scrolled to bottom; page height " + document.body.scrollHeight };
}

async function execute(cmd, serverUrl) {
  try {
    // Doesn't touch a page at all, so it needs no tab — and must not fail
    // just because Harvey hasn't opened one yet.
    if (cmd.action === "wait") {
      await sleep(Math.min(cmd.timeoutMs || 1500, 10000));
      return { ok: true, data: "waited" };
    }

    // Navigate is the one action that can create the work tab. Reusing it when
    // it's alive keeps Harvey on one tab instead of littering the window.
    if (cmd.action === "navigate") {
      if (!cmd.url) return { ok: false, error: "navigate needs a url" };
      let tab = await workTab(serverUrl);
      if (tab && tab.id != null) {
        await chrome.tabs.update(tab.id, { url: cmd.url });
      } else {
        tab = await openWorkTab(cmd.url);
      }
      await waitForLoad(tab.id, cmd.timeoutMs || 20000);
      // status:"complete" fires when the document loaded, which on a
      // single-page app is long before the listing exists. If the caller named
      // something to wait for, wait for that instead of guessing; otherwise
      // give the first render a brief settle.
      if (cmd.selector || cmd.text) {
        await waitForPresence(tab.id, { selector: cmd.selector, text: cmd.text }, cmd.timeoutMs || 15000);
      } else {
        await settle(tab.id, 1500);
      }
      const t = await chrome.tabs.get(tab.id);
      return { ok: true, data: "navigated", url: t.url, title: t.title };
    }

    const tab = await targetTab(serverUrl);
    if (!tab || tab.id == null) {
      return {
        ok: false,
        error: "No page open to act on yet. Ask Harvey to open a site first — he'll do it in his own tab, then this will act on that page.",
      };
    }

    // Chrome refuses injection on its own pages; say so clearly rather than
    // surfacing an opaque platform error.
    if (isInternalUrl(tab.url)) {
      return { ok: false, error: "Can't act on a browser internal page (" + (tab.url || "").split("/")[0] + "). Ask Harvey to open a normal site first." };
    }

    switch (cmd.action) {
      case "click": {
        const r = await inPage(tab.id, pageClick, { selector: cmd.selector, text: cmd.text });
        // A click often starts a navigation; give it a moment to settle so the
        // next read doesn't catch the old page.
        if (r && r.ok) await settle(tab.id, 1200);
        return r;
      }
      case "fill":
        return await inPage(tab.id, pageFill, { fields: cmd.fields || {} });
      case "read":
        return await inPage(tab.id, pageRead, { selector: cmd.selector });
      case "extract":
        return await inPage(tab.id, pageExtract, { schema: cmd.schema || {} });
      case "structured":
        return await inPage(tab.id, pageStructured, {});
      case "screenshot":
        return await captureTab(tab, { maxWidth: cmd.maxWidth });
      case "scroll":
        return await inPage(tab.id, pageScroll, { to: cmd.to });
      case "waitFor": {
        const found = await waitForPresence(tab.id, { selector: cmd.selector, text: cmd.text }, cmd.timeoutMs || 15000);
        return found
          ? { ok: true, data: "present" }
          : { ok: false, error: "Still not on the page after " + Math.round((cmd.timeoutMs || 15000) / 1000) + "s: " + (cmd.selector || cmd.text) };
      }
      case "focus": {
        // Hand the keyboard back to the human — the login-wall path.
        await chrome.tabs.update(tab.id, { active: true });
        try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
        return { ok: true, data: "Harvey's tab is now in front of the operator." };
      }
      default:
        return { ok: false, error: "Unknown action: " + cmd.action };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Poll the page until the element/text shows up.
 *
 * Single-page apps are the whole reason this exists: the tab reports
 * "complete" as soon as the shell HTML lands, and the actual listing arrives
 * from XHR a second or two later. Reading at "complete" returned a spinner,
 * which Harvey faithfully reported as the page's content.
 */
async function waitForPresence(tabId, what, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, timeoutMs || 15000);
  while (Date.now() < deadline) {
    try {
      const hit = await inPage(tabId, pagePresent, { selector: what.selector, text: what.text });
      if (hit === true) return true;
    } catch (_) { /* mid-navigation the frame can be gone; just retry */ }
    await sleep(300);
  }
  return false;
}

/** Let a just-loaded or just-clicked page finish its first render. */
async function settle(tabId, ms) {
  await sleep(Math.min(ms || 1000, 4000));
  try {
    await inPage(tabId, () => document.readyState, {});
  } catch (_) { /* navigating; the next action will re-target anyway */ }
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(t); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const t = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Keep the service worker alive across a parked long poll.
 *
 * Chrome kills an MV3 worker after 30s idle, and an in-flight fetch does NOT
 * count as activity — a 20s hold plus a slow response was landing right on
 * that edge. Calling any extension API resets the timer, so a cheap call on a
 * short interval carries us through the wait. This is the documented pattern,
 * used narrowly (only while a poll is parked) rather than to pin the worker up
 * forever.
 */
function startKeepalive() {
  return setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch (_) {}
  }, 15000);
}

async function pollOnce() {
  const cfg = await config();
  const { serverUrl, token, enabled } = cfg;
  if (!serverUrl || !token) { await setBadge("off"); return IDLE_POLL_MS; }

  // Report the tab Harvey is driving, not the one the user happens to be
  // looking at — otherwise the app claims he's on whatever the human just
  // clicked over to, and he acts somewhere else entirely.
  let tabInfo = {};
  try {
    const tab = await workTab(serverUrl);
    if (tab) tabInfo = { url: tab.url, title: tab.title };
  } catch (_) {}

  const { armLock } = await chrome.storage.local.get(["armLock"]);

  let commands = [];
  const ka = startKeepalive();
  try {
    const res = await fetch(serverUrl + "/api/browser/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Ask the server to hold the request until there's work. Dispatch used
      // to wait for the next 2s tick; every step of a multi-step task paid it.
      body: JSON.stringify({ token, enabled, page: tabInfo, waitMs: LONG_POLL_MS, armLock: armLock === true }),
    });
    if (!res.ok) { await setBadge("err"); return IDLE_POLL_MS; }
    const body = await res.json();

    // The server may ask us to switch OFF at any time. It may ask us to switch
    // ON only because the operator asked for that — and never past the local
    // lock, which is the human's override.
    if (body.disarm) {
      await chrome.storage.local.set({ enabled: false });
      await setBadge("off");
      return 0; // report the new state immediately so the server can clear it
    }
    if (body.arm && armLock !== true) {
      await chrome.storage.local.set({ enabled: true });
      await setBadge("on");
      return 0;
    }
    commands = body.commands || [];
  } catch (_) {
    await setBadge("err");
    return IDLE_POLL_MS;
  } finally {
    clearInterval(ka);
  }

  await setBadge(enabled ? "on" : "off");

  for (const cmd of commands) {
    const guard = startKeepalive();   // a slow page must not get the worker killed
    let result;
    try {
      result = await execute(cmd, serverUrl);
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    } finally {
      clearInterval(guard);
    }
    let page = {};
    try {
      const tab = await workTab(serverUrl);
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
          image: result.image,
          // Side-signals the page noticed. needsLogin is the important one:
          // without it a login wall reaches Harvey as a short, content-free
          // page and he reports "the listing isn't there".
          meta: (result.needsLogin != null || result.truncated != null || result.notFound != null)
            ? { needsLogin: result.needsLogin, truncated: result.truncated, notFound: result.notFound }
            : undefined,
        }),
      });
    } catch (_) {}
  }

  // With a long poll there's nothing to wait for — go straight back to
  // parking, so the next command dispatches the instant it's queued.
  //
  // This applies while switched OFF too. A disarmed extension used to idle on
  // a 6s timer, which made "Harvey, turn the browser back on" take up to six
  // seconds to do anything — the one moment the operator is watching for a
  // reaction. Parking instead means the arm directive arrives immediately, and
  // a disarmed extension still receives no commands.
  return 0;
}

async function loop() {
  if (polling) return;
  polling = true;
  try {
    // A plain interval would stack up if a command outlives the tick, so each
    // cycle schedules the next only once it's finished.
    for (;;) {
      let wait = IDLE_POLL_MS;
      try { wait = await pollOnce(); } catch (_) {}
      if (wait > 0) await sleep(wait);
    }
  } finally {
    // Reaching here means the loop died. Clear the flag so the alarm below can
    // restart it instead of seeing polling===true forever and doing nothing.
    polling = false;
  }
}

/**
 * Watchdog. The loop lives in a service worker Chrome can terminate at any
 * time — and when it does, every pending setTimeout dies with it and polling
 * silently stops. Nothing tells the user; the extension just goes deaf until
 * some unrelated event happens to wake it. An alarm survives termination and
 * wakes the worker, so this is what actually makes the extension reliable.
 *
 * 30s is Chrome's minimum period, which is also the worker's idle timeout, so
 * the worst case is one missed window rather than an indefinitely dead poller.
 */
const WATCHDOG_ALARM = "harvey-poll-watchdog";
chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === WATCHDOG_ALARM) loop(); });

chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  loop();
});
loop();

// The user closing Harvey's tab is a normal way to end a browsing session, so
// drop the id immediately rather than waiting for the next command to fail on
// it. The next navigate opens a fresh tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  readWorkTabId().then((id) => { if (id === tabId) writeWorkTabId(null); }).catch(() => {});
});

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
