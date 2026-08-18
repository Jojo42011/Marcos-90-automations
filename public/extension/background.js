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

/**
 * A stable id for THIS browser, plus the name the operator gave it.
 *
 * Without an identity the server could only ever see "a browser", so two armed
 * machines raced for every command and neither the operator nor Harvey could
 * say which one had acted. The id is generated once and kept; the name is
 * whatever the human typed in the popup, and it is what priority matches on.
 */
async function identity() {
  const c = await chrome.storage.local.get(["deviceId", "deviceName"]);
  let id = c.deviceId;
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
    await chrome.storage.local.set({ deviceId: id });
  }
  return { deviceId: id, deviceName: (c.deviceName || "").trim() };
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

/**
 * Open Harvey a tab of his own — in a SEPARATE WINDOW, brought to the front.
 *
 * Two requirements pull against each other here, and a separate window is the
 * only arrangement that satisfies both:
 *
 *   - "Take me there." Opening a listing silently in a background tab meant
 *     the operator had to go hunting for it. When they ask Harvey to open
 *     something, they expect to see it.
 *   - "Keep listening." The Harvey shell holds the microphone and the STT
 *     socket. Browsers throttle timers in HIDDEN tabs hard (roughly one per
 *     minute), so if Harvey's page were simply activated in the same window,
 *     the shell would go hidden and voice would degrade — which is exactly the
 *     "he stops listening after a while" symptom.
 *
 * A separate window means the shell stays the active tab of ITS window, so it
 * stays visible and unthrottled, while the operator still gets the site put in
 * front of them. (If the new window fully covers the shell, Chrome's occlusion
 * tracking can still mark it hidden — hence the voice-side hardening too.)
 */
async function openWorkTab(url, focus) {
  const wantFocus = focus !== false;
  try {
    const win = await chrome.windows.create({ url, focused: wantFocus });
    const tab = win && win.tabs && win.tabs[0];
    if (tab && tab.id != null) {
      await writeWorkTabId(tab.id);
      return tab;
    }
  } catch (_) {
    // Window creation can fail (kiosk mode, policy). Fall back to a tab.
  }
  const tab = await chrome.tabs.create({ url, active: wantFocus });
  await writeWorkTabId(tab.id);
  return tab;
}

/** Put Harvey's tab in front of the operator. */
async function bringToFront(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
  } catch (_) {}
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

/**
 * Run a function in EVERY frame of the tab, not just the top one.
 *
 * This is what makes a cross-origin iframe readable at all. The in-page walk
 * can reach same-origin frames through `contentDocument`, but a cross-origin
 * one throws on access — and the old code simply returned the top frame's text
 * with no hint that a chunk of the page had been skipped. On a portal that
 * frames its listing detail, that is the entire answer going missing silently.
 *
 * Frames that fail to inject (a sandboxed or about:blank frame) are counted
 * rather than thrown, because one dead frame must not lose the other five.
 */
async function inAllFrames(tabId, fn, args) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: fn,
      args: args ? [args] : [],
      world: "MAIN",
    });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  return results
    .map((r) => r && r.result)
    .filter((r) => r && r.ok !== false);
}

/**
 * Read the whole tab: top frame first, then any child frame that has its own
 * text. Frames are labelled, because "the price is in a frame from
 * maps.example.com" is information the operator needs when a selector fails.
 */
async function readWholeTab(tabId, opts) {
  const parts = await inAllFrames(tabId, pageRead, opts || {});
  if (!Array.isArray(parts)) return parts;            // hard injection failure
  if (!parts.length) return { ok: false, error: "No frame in this tab could be read." };

  const top = parts.find((p) => p.isTopFrame) || parts[0];
  /* ANY frame with text counts. An earlier version required 40 characters to
     filter out chrome and ad frames, which silently dropped the exact case
     this exists for: a framed listing detail whose whole content is
     "$512,000 / HOA dues are $45 per month" — 36 characters. Noise is a far
     cheaper problem than a missing price, so the only things excluded are
     empty frames and ones whose text the top frame already contains. */
  const topText = (top.data || "");
  const others = parts.filter((p) => {
    if (p === top) return false;
    const t = (p.data || "").trim();
    if (!t) return false;
    return !topText.includes(t);
  });

  let data = top.data || "";
  for (const f of others) {
    data += `\n\n--- embedded frame: ${f.frameUrl} ---\n${f.data}`;
  }
  return {
    ...top,
    data,
    frames: parts.length,
    embeddedFrames: others.map((f) => f.frameUrl),
    /* Kept from the top frame: paging applies to the main document, and
       mixing offsets across frames would make nextOffset meaningless. */
    truncated: top.truncated,
    nextOffset: top.nextOffset,
    totalLength: top.totalLength,
  };
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

    /* Refuse credential and payment boxes outright. These are OUR rules, not
       browser restrictions — the reason says so, accurately, so nobody goes
       hunting for a Chrome setting that would "allow" it.

       Matched on the field's own metadata rather than the selector, because
       the selector is chosen by whoever asked: a caller aiming at a card
       number would simply target it by id. autocomplete is checked first
       since it is the one signal sites fill in correctly for browser
       autofill, then name/id/placeholder/label text as a fallback. */
    const meta = [
      el.getAttribute && el.getAttribute("autocomplete"),
      el.name, el.id,
      el.getAttribute && el.getAttribute("placeholder"),
      el.getAttribute && el.getAttribute("aria-label"),
    ].filter(Boolean).join(" ").toLowerCase();

    if (el.type === "password") {
      refused.push(sel + " — password field, refused by Harvey's own safety rule (not a browser limitation). The operator types this themselves.");
      continue;
    }
    if (/\bcc-number\b|\bcc-csc\b|\bcc-exp|card ?number|cardnum|creditcard|\bcvv\b|\bcvc\b|security ?code/.test(meta)) {
      refused.push(sel + " — payment card field, refused by Harvey's own safety rule. Card numbers and security codes are typed by the operator, never by Harvey.");
      continue;
    }
    if (/\bssn\b|social ?security|tax ?id|\bitin\b/.test(meta)) {
      refused.push(sel + " — Social Security / tax ID field, refused by Harvey's own safety rule.");
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

/**
 * Injected: read the page as text.
 *
 * REWRITTEN after an audit found three separate ways this lied:
 *
 *   1. With no selector it read `document.body.innerText` and nothing else, so
 *      a page whose content lives in a shadow root came back WITHOUT that
 *      content — and on a body that is mostly <script>, innerText handed back
 *      the SCRIPT SOURCE as if it were page copy. The README promised
 *      shadow-root support; only the selector path ever had it.
 *   2. Cross-origin iframes were invisible and unmentioned. That is handled a
 *      level up now by injecting into every frame; this function reports its
 *      own frame and says which one it is.
 *   3. It cut at 12,000 characters with no way to ask for the rest, so the end
 *      of a long page was unreachable — `truncated: true` and no next step.
 */
function pageRead(arg) {
  const opts = arg || {};
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME"]);

  /* Every element that HAS a shadow root, plus every ancestor of one. Computed
     once: the walk below then asks a Set instead of re-querying the subtree at
     each node, which turned an O(n) read into O(n^2) on the first attempt. */
  const onShadowPath = new Set();
  (function findHosts(root, depth) {
    if (!root || depth > 10) return;
    let all = [];
    try { all = root.querySelectorAll("*"); } catch (_) { return; }
    for (const el of all) {
      if (!el.shadowRoot) continue;
      findHosts(el.shadowRoot, depth + 1);
      let p = el;
      while (p && !onShadowPath.has(p)) {
        onShadowPath.add(p);
        const rn = p.getRootNode && p.getRootNode();
        p = p.parentElement || (rn && rn.host) || null;
      }
    }
  })(document, 0);

  function hidden(el) {
    try {
      const v = el.ownerDocument && el.ownerDocument.defaultView;
      if (!v) return false;
      const st = v.getComputedStyle(el);
      return st.display === "none" || st.visibility === "hidden";
    } catch (_) { return false; }
  }

  /* innerText is the right primitive — it honours visibility and layout — but
     it stops dead at a shadow boundary. So it is used for any subtree with no
     shadow root beneath it, and only the path down to a shadow host is walked
     by hand. */
  function textOf(node, depth) {
    if (!node || depth > 14) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (SKIP.has(node.tagName)) return "";
    if (hidden(node)) return "";

    if (!onShadowPath.has(node)) return node.innerText || node.textContent || "";

    let out = "";
    if (node.shadowRoot) {
      for (const c of node.shadowRoot.childNodes) out += textOf(c, depth + 1) + "\n";
    }
    for (const c of node.childNodes || []) out += textOf(c, depth + 1) + "\n";
    return out;
  }

  let root = document.body || document.documentElement;
  if (opts.selector) {
    const roots = [document]; const seen = new Set();
    (function walk(r, d) {
      if (!r || d > 8 || seen.has(r)) return; seen.add(r);
      let all = []; try { all = r.querySelectorAll("*"); } catch (_) { return; }
      for (const el of all) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, d + 1); }
        if (el.tagName === "IFRAME") { try { const doc = el.contentDocument; if (doc) { roots.push(doc); walk(doc, d + 1); } } catch (_) {} }
      }
    })(document, 0);
    root = null;
    for (const r of roots) { try { const f = r.querySelector(opts.selector); if (f) { root = f; break; } } catch (_) {} }
    if (!root) return { ok: false, error: "Nothing matched " + opts.selector, url: location.href };
  }

  const text = textOf(root, 0)
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  /* A login wall reads as a nearly empty page, and Harvey would otherwise
     report "the listing isn't there" when the real answer is "sign in". */
  let pw = null;
  try { pw = document.querySelector('input[type="password"]'); } catch (_) {}
  const loginish = pw && /sign in|log ?in|password|username|email/i.test(text.slice(0, 2000));

  const limit = Math.min(Math.max(Number(opts.limit) || 20000, 1000), 60000);
  const offset = Math.max(0, Number(opts.offset) || 0);
  const slice = text.slice(offset, offset + limit);
  const end = offset + slice.length;

  return {
    ok: true,
    data: slice,
    /* The caller can now actually GET the rest, which is the difference
       between "truncated" as information and as a dead end. */
    totalLength: text.length,
    offset,
    nextOffset: end < text.length ? end : null,
    truncated: end < text.length,
    title: document.title,
    url: location.href,
    frameUrl: location.href,
    isTopFrame: window === window.top,
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

/**
 * Injected: scroll, so lazy-loaded listings actually render before a read.
 *
 * REWRITTEN because the old one scrolled `window` and nothing else. Most
 * portals put their results in an inner pane with `overflow:auto`; the window
 * on those pages has nothing to scroll, so every call did nothing — and then
 * reported `ok: true, "scrolled to bottom"`. A false success is worse than a
 * failure here, because Harvey then reads the first fifteen rows and reports
 * them as the whole result set.
 *
 * Now it FINDS the thing that actually scrolls, scrolls that, and measures
 * whether anything changed — reporting honestly when nothing did.
 */
async function pageScroll(arg) {
  const opts = arg || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Candidate scrollers: the document, plus any element with real overflow.
     Ranked by scrollable distance — the results pane beats a stray 20px
     sidebar. A selector, when given, pins it. */
  function scrollers() {
    const out = [];
    const doc = document.scrollingElement || document.documentElement;
    if (doc && doc.scrollHeight > doc.clientHeight + 4) {
      out.push({ el: doc, slack: doc.scrollHeight - doc.clientHeight, why: "document" });
    }
    let all = [];
    try { all = document.querySelectorAll("*"); } catch (_) { all = []; }
    for (const el of all) {
      if (el === doc || el === document.body) continue;
      let st;
      try { st = getComputedStyle(el); } catch (_) { continue; }
      const oy = st.overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
      const slack = el.scrollHeight - el.clientHeight;
      if (slack > 40 && el.clientHeight > 80) out.push({ el, slack, why: "inner pane" });
    }
    out.sort((a, b) => b.slack - a.slack);
    return out;
  }

  let target = null;
  if (opts.selector) {
    try {
      const el = document.querySelector(opts.selector);
      if (el) target = { el, slack: el.scrollHeight - el.clientHeight, why: "selector" };
    } catch (_) { /* fall through to auto-detection */ }
    if (!target) return { ok: false, error: "Nothing matched " + opts.selector };
  } else {
    target = scrollers()[0] || null;
  }

  if (!target) {
    /* Honest: there was nothing to scroll. Previously this reported success. */
    return {
      ok: true, data: "Nothing on this page scrolls — it already fits the window.",
      scrolled: false, container: "none",
    };
  }

  const el = target.el;
  const isDoc = el === (document.scrollingElement || document.documentElement);
  const top = () => (isDoc ? (window.scrollY || el.scrollTop || 0) : el.scrollTop);
  const height = () => el.scrollHeight;
  const setTop = (v) => { if (isDoc) window.scrollTo({ top: v }); else el.scrollTop = v; };

  const startTop = top(), startHeight = height();

  if (opts.to === "top") {
    setTop(0); await sleep(350);
    return { ok: true, data: "scrolled to top", scrolled: top() !== startTop, container: target.why };
  }
  if (typeof opts.to === "number") {
    setTop(top() + opts.to); await sleep(350);
    return { ok: true, data: "scrolled " + opts.to + "px", scrolled: top() !== startTop, container: target.why };
  }

  /* Step to the bottom, pausing so infinite-scroll handlers fire. Stops when
     the content stops growing AND the position stops moving — one jump to the
     bottom loads nothing on most lazy pages. */
  let lastHeight = -1, lastTop = -1, steps = 0;
  const maxSteps = Math.min(Math.max(Number(opts.maxSteps) || 25, 1), 60);
  for (let i = 0; i < maxSteps; i++) {
    setTop(height());
    await sleep(Number(opts.pauseMs) || 450);
    steps++;
    const h = height(), t = top();
    if (h === lastHeight && t === lastTop) break;
    lastHeight = h; lastTop = t;
  }

  const grew = height() - startHeight;
  return {
    ok: true,
    data:
      `scrolled the ${target.why} in ${steps} step(s); ` +
      (grew > 0
        ? `content grew by ${grew}px (lazy content loaded) — read again to see it`
        : `content did not grow, so this looks like the whole list`),
    scrolled: top() !== startTop || grew > 0,
    grewBy: grew,
    steps,
    container: target.why,
    scrollHeight: height(),
  };
}

/**
 * Injected once per page: keep the last errors the page produced.
 *
 * Chrome gives an extension no way to read a page's console after the fact, so
 * the only honest options are to listen from the start or to admit there is
 * nothing to show. This listens from the start, and `console` says plainly
 * when nothing was recorded rather than implying the page was clean.
 */
async function installErrorRecorder(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: function () {
        if (window.__harveyErrorsInstalled) return;
        window.__harveyErrorsInstalled = true;
        window.__harveyErrors = [];
        const push = (s) => {
          try {
            window.__harveyErrors.push(new Date().toISOString().slice(11, 19) + "  " + String(s).slice(0, 400));
            if (window.__harveyErrors.length > 80) window.__harveyErrors.shift();
          } catch (_) {}
        };
        window.addEventListener("error", (e) => push("ERROR " + (e.message || "") + (e.filename ? " @ " + e.filename + ":" + e.lineno : "")));
        window.addEventListener("unhandledrejection", (e) => push("UNHANDLED PROMISE " + ((e.reason && e.reason.message) || e.reason || "")));
        const realErr = console.error;
        console.error = function () { push("console.error " + Array.from(arguments).join(" ")); return realErr.apply(console, arguments); };
        const realWarn = console.warn;
        console.warn = function () { push("console.warn " + Array.from(arguments).join(" ")); return realWarn.apply(console, arguments); };
      },
      args: [],
    });
  } catch (_) { /* a page that refuses injection simply has no recorder */ }
}

/* ── Multiple tabs ─────────────────────────────────────────────────────────
   Claude in Chrome works across several tabs and collects the ones it opens
   into a colour-coded group you can drag your own tabs into. Harvey had ONE
   work tab, so "compare these three listings" meant loading them one at a
   time and losing each before reading the next.

   Harvey's tabs go in a group named "Harvey" so they are visibly his and can
   be closed in one action — and so a tab the operator drags in becomes
   something he can read, which is the part that makes cross-site work
   practical. The group is cosmetic on purpose: losing it (older Chrome, or a
   window that refuses grouping) must not stop the tabs working. ─────────── */

const TABS_KEY = "harveyTabIds";

async function listWorkTabs() {
  const { [TABS_KEY]: ids } = await chrome.storage.local.get([TABS_KEY]);
  const wanted = Array.isArray(ids) ? ids : [];
  const alive = [];
  for (const id of wanted) {
    try {
      const t = await chrome.tabs.get(id);
      if (t) alive.push({ id: t.id, url: t.url, title: t.title, active: t.active });
    } catch (_) { /* closed by the operator — drop it silently */ }
  }
  if (alive.length !== wanted.length) {
    await chrome.storage.local.set({ [TABS_KEY]: alive.map((t) => t.id) });
  }
  return alive;
}

async function rememberWorkTab(id) {
  const { [TABS_KEY]: ids } = await chrome.storage.local.get([TABS_KEY]);
  const next = Array.from(new Set([...(Array.isArray(ids) ? ids : []), id]));
  await chrome.storage.local.set({ [TABS_KEY]: next });
  await groupWorkTabs(next);
}

/** Colour-coded group, best-effort. Grouping is a nicety, not a dependency. */
async function groupWorkTabs(ids) {
  if (!chrome.tabs.group || !chrome.tabGroups) return;
  try {
    const groupId = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(groupId, { title: "Harvey", color: "cyan" });
  } catch (_) { /* older Chrome, or tabs across windows — not worth failing */ }
}

/**
 * Open a NEW tab Harvey can work in, alongside any he already has.
 * Returns the tab so the caller can act on it immediately.
 */
async function openAdditionalTab(url, focus) {
  const tab = await chrome.tabs.create({ url, active: Boolean(focus) });
  await rememberWorkTab(tab.id);
  return tab;
}

/** Close one of Harvey's tabs, or all of them. Never touches the operator's. */
async function closeWorkTabs(tabId) {
  const tabs = await listWorkTabs();
  const targets = tabId ? tabs.filter((t) => t.id === tabId) : tabs;
  if (!targets.length) return { ok: true, data: "No Harvey tabs were open." };
  for (const t of targets) { try { await chrome.tabs.remove(t.id); } catch (_) {} }
  const left = tabs.filter((t) => !targets.some((x) => x.id === t.id)).map((t) => t.id);
  await chrome.storage.local.set({ [TABS_KEY]: left });
  return { ok: true, data: `Closed ${targets.length} tab(s).`, closed: targets.map((t) => t.url) };
}

/**
 * Adopt whatever the operator is looking at, so "read the tab I'm on" works
 * and a dragged-in tab becomes Harvey's to read. Refuses the Harvey shell
 * itself — he must never mistake his own UI for the page in question.
 */
async function adoptCurrentTab(serverUrl) {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) return { ok: false, error: "No active tab." };
  if (isAppTab(t, serverUrl)) {
    return { ok: false, error: "That's Harvey's own page — switch to the site you mean and ask again." };
  }
  if (isInternalUrl(t.url)) {
    return { ok: false, error: "That's a browser internal page; Chrome does not allow acting on it." };
  }
  await rememberWorkTab(t.id);
  return { ok: true, data: `Working on "${t.title}".`, tabId: t.id, url: t.url };
}

/* ── Safety envelope ───────────────────────────────────────────────────────
   Matched to what Claude in Chrome enforces, because the operator asked for
   the same limits and these are the ones that exist for a reason:

     · adult and piracy sites are blocked outright
     · financial sites need explicit per-site permission before Harvey acts
     · sensitive fields — card numbers, CVV, SSN, passwords — are never typed
     · CAPTCHAs are never solved or bypassed

   These are THIS extension's rules, enforced in the extension rather than on
   the server, so a compromised or spoofed server still cannot talk Harvey
   into typing a card number. That is the whole point of putting them here.
   ─────────────────────────────────────────────────────────────────────── */

const BLOCKED_HOSTS = [
  /(^|\.)pornhub\.com$/i, /(^|\.)xvideos\.com$/i, /(^|\.)xhamster\.com$/i,
  /(^|\.)onlyfans\.com$/i, /(^|\.)redtube\.com$/i, /(^|\.)youporn\.com$/i,
  /(^|\.)thepiratebay/i, /(^|\.)1337x\./i, /(^|\.)rarbg\./i, /(^|\.)nyaa\./i,
  /(^|\.)fmovies\./i, /(^|\.)123movies/i, /(^|\.)sci-hub\./i,
];

/** Sites where a wrong click moves money. Allowed, but only once per site. */
const FINANCIAL_HOSTS = [
  /(^|\.)chase\.com$/i, /(^|\.)bankofamerica\.com$/i, /(^|\.)wellsfargo\.com$/i,
  /(^|\.)citi\.com$/i, /(^|\.)capitalone\.com$/i, /(^|\.)usbank\.com$/i,
  /(^|\.)schwab\.com$/i, /(^|\.)fidelity\.com$/i, /(^|\.)vanguard\.com$/i,
  /(^|\.)robinhood\.com$/i, /(^|\.)coinbase\.com$/i, /(^|\.)paypal\.com$/i,
  /(^|\.)venmo\.com$/i, /(^|\.)stripe\.com$/i, /(^|\.)irs\.gov$/i,
  /(^|\.)ally\.com$/i, /(^|\.)discover\.com$/i, /(^|\.)amex\.com$/i,
  /(^|\.)navyfederal\.org$/i, /(^|\.)titlecompany/i, /(^|\.)qualiaapp\.com$/i,
];

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ""; }
}
function isBlockedSite(url) {
  const h = hostOf(url);
  return h ? BLOCKED_HOSTS.some((re) => re.test(h)) : false;
}
function isFinancialSite(url) {
  const h = hostOf(url);
  return h ? FINANCIAL_HOSTS.some((re) => re.test(h)) : false;
}

/** Per-site grants live in storage so they survive the service worker dying. */
async function siteAllowed(url) {
  const h = hostOf(url);
  if (!h) return false;
  const { siteGrants } = await chrome.storage.local.get(["siteGrants"]);
  return Boolean(siteGrants && siteGrants[h]);
}
async function grantSite(url) {
  const h = hostOf(url);
  if (!h) return false;
  const { siteGrants } = await chrome.storage.local.get(["siteGrants"]);
  const next = { ...(siteGrants || {}) };
  next[h] = new Date().toISOString();
  await chrome.storage.local.set({ siteGrants: next });
  return true;
}

/**
 * The gate every action passes through. Reading is allowed on a financial site
 * — looking at a payoff statement is the normal case — but anything that
 * CHANGES the page needs the operator to have said yes to that host first.
 */
const MUTATING = new Set(["click", "fill", "navigate"]);
async function guard(action, url) {
  if (isBlockedSite(url)) {
    return { blocked: true, reason:
      `Harvey will not operate on ${hostOf(url)} — adult and piracy sites are blocked outright, the same rule Claude in Chrome applies. This is not a setting.` };
  }
  if (isFinancialSite(url) && MUTATING.has(action) && !(await siteAllowed(url))) {
    return { blocked: true, needsGrant: hostOf(url), reason:
      `${hostOf(url)} is a financial site. Harvey can read it, but clicking, typing or navigating there needs your explicit permission first — open the Harvey panel and allow this site. Reading it is already allowed.` };
  }
  return { blocked: false };
}

/** Injected: the errors the recorder has collected on this page. */
function harveyReadErrors() {
  return (window.__harveyErrors || []).slice(-40);
}

/** Injected: does this page look like a CAPTCHA? Never solved, only reported. */
function pageCaptcha() {
  const sel = [
    "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", ".g-recaptcha",
    "#cf-challenge-running", "iframe[title*='challenge']", "[data-sitekey]",
  ];
  for (const s of sel) { try { if (document.querySelector(s)) return true; } catch (_) {} }
  return /are you a robot|verify you are human|complete the captcha/i.test(
    (document.body && document.body.innerText || "").slice(0, 3000));
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
      /* Checked against the DESTINATION, before a tab is opened — a blocked
         site must never be loaded at all, not loaded and then refused. */
      const navGate = await guard("navigate", cmd.url);
      if (navGate.blocked) return { ok: false, error: navGate.reason, needsGrant: navGate.needsGrant || null };
      // Show the operator what was opened unless explicitly told not to.
      // Silently loading a listing somewhere off-screen is the wrong default:
      // they asked for it, they want to see it.
      const wantFocus = cmd.focus !== false;
      let tab = await workTab(serverUrl);
      if (tab && tab.id != null) {
        await chrome.tabs.update(tab.id, { url: cmd.url });
        if (wantFocus) await bringToFront(tab);
      } else {
        tab = await openWorkTab(cmd.url, wantFocus);
      }
      await waitForLoad(tab.id, cmd.timeoutMs || 20000);
      /* Start recording page errors immediately: a console read after the
         fact is useless if nothing was listening while the page ran. */
      await installErrorRecorder(tab.id);
      // status:"complete" fires when the document loaded, which on a
      // single-page app is long before the listing exists. If the caller named
      // something to wait for, wait for that instead of guessing; otherwise
      // give the first render a brief settle.
      let found = null;
      if (cmd.selector || cmd.text) {
        found = await waitForPresence(tab.id, { selector: cmd.selector, text: cmd.text }, cmd.timeoutMs || 15000);
      } else {
        await settle(tab.id, 1500);
      }
      const t = await chrome.tabs.get(tab.id);

      // Confirm the page is really there. Chrome happily reports a load as
      // "complete" when what loaded is its own error page, and reporting that
      // as a successful navigation is how Harvey ends up describing a site he
      // never actually reached.
      try {
        await inPage(tab.id, () => document.readyState, {});
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (/error page/i.test(msg)) {
          return { ok: false, error: "That address didn't load — the browser is showing an error page. Check the URL, or the site may be down or refusing the connection.", url: t.url, title: t.title };
        }
        return { ok: false, error: "Couldn't reach the page after navigating: " + msg, url: t.url, title: t.title };
      }

      if (found === false) {
        // Not a failure — the page loaded — but Harvey must not assume the
        // thing he was waiting for is on screen.
        return {
          ok: true,
          data: "navigated, but " + (cmd.selector || '"' + cmd.text + '"') + " never appeared — the page may still be loading, or it isn't what you expected",
          found: false,
          url: t.url,
          title: t.title,
        };
      }

      // A page that LOADED can still be a wall, not the site. Zillow and
      // friends front automated visits with a bot check ("Press & Hold",
      // "Access denied", a captcha) — document loads fine, title looks
      // plausible, and reporting ok here is exactly how Harvey ends up telling
      // the operator he pulled up a site that never actually appeared. The
      // check reads only the visible top of the page; a real listing that
      // merely mentions the word "captcha" in a paragraph won't trip it.
      try {
        const peek = await inPage(tab.id, () => ({
          title: document.title || "",
          top: (document.body && document.body.innerText || "").slice(0, 600),
        }), {});
        const wall = /press\s*&\s*hold|access to this page has been denied|verify you are (a )?human|are you a (ro)?bot|pardon our interruption|unusual traffic|checking your browser|just a moment/i;
        if (peek && (wall.test(peek.title) || wall.test(peek.top))) {
          return {
            ok: false,
            blocked: true,
            error: "The site loaded a BOT CHECK instead of its content (" + (peek.title || t.url) + "). The site was NOT pulled up. The operator can complete the check themselves in Harvey's window — it is on screen — and then ask again.",
            url: t.url,
            title: t.title,
          };
        }
      } catch (_) {
        // Peek failing is not a navigation failure; fall through to the
        // ordinary success report rather than inventing an error.
      }

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

    /* Every page-touching action is checked against the page actually in front
       of Harvey. Reading a financial site is fine; changing one is not, until
       the operator has allowed that host. */
    const gate = await guard(cmd.action, tab.url || "");
    if (gate.blocked) return { ok: false, error: gate.reason, needsGrant: gate.needsGrant || null };

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
        /* Every frame, not just the top one — see readWholeTab. */
        return await readWholeTab(tab.id, {
          selector: cmd.selector, offset: cmd.offset, limit: cmd.limit,
        });
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
      case "tabs": {
        const list = await listWorkTabs();
        return { ok: true, data: list.length
          ? list.map((t) => `${t.id}: ${t.title} — ${t.url}`).join("\n")
          : "Harvey has no tabs open.", tabs: list };
      }
      case "open_tab": {
        if (!cmd.url) return { ok: false, error: "open_tab needs a url" };
        const g = await guard("navigate", cmd.url);
        if (g.blocked) return { ok: false, error: g.reason, needsGrant: g.needsGrant || null };
        const t = await openAdditionalTab(cmd.url, cmd.focus !== false);
        await waitForLoad(t.id, cmd.timeoutMs || 20000);
        await installErrorRecorder(t.id);
        await settle(t.id, 700);
        const fresh = await chrome.tabs.get(t.id);
        return { ok: true, data: `Opened "${fresh.title}" in a new tab.`, tabId: t.id, url: fresh.url };
      }
      case "close_tab":
        return await closeWorkTabs(cmd.tabId);
      case "use_current_tab":
        return await adoptCurrentTab(serverUrl);
      case "console": {
        /* Claude in Chrome can see console output and page errors; Harvey
           could not, so "the form didn't submit" had no diagnosis available.
           Errors are captured from the moment a page is opened. */
        const errs = await inPage(tab.id, harveyReadErrors, {});
        return { ok: true, data: (errs && errs.length)
          ? errs.join("\n")
          : "No page errors recorded since Harvey opened this tab.", count: (errs || []).length };
      }
      case "captcha": {
        const hit = await inPage(tab.id, pageCaptcha, {});
        return { ok: true, data: hit
          ? "This page is showing a CAPTCHA. Harvey does not solve or bypass CAPTCHAs — bring the tab up and complete it yourself, then ask him to carry on."
          : "No CAPTCHA on this page.", captcha: Boolean(hit) };
      }
      case "focus": {
        // Hand the keyboard back to the human — the login-wall path.
        await bringToFront(tab);
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
  const who = await identity();

  let commands = [];
  const ka = startKeepalive();
  try {
    const res = await fetch(serverUrl + "/api/browser/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Ask the server to hold the request until there's work. Dispatch used
      // to wait for the next 2s tick; every step of a multi-step task paid it.
      body: JSON.stringify({ token, enabled, page: tabInfo, waitMs: LONG_POLL_MS, armLock: armLock === true,
                             deviceId: who.deviceId, deviceName: who.deviceName }),
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
          /* Side-signals the page noticed. needsLogin is the important one:
             without it a login wall reaches Harvey as a short, content-free
             page and he reports "the listing isn't there".

             Built from an explicit list rather than spreading `result`, so a
             page cannot inject arbitrary keys into what Harvey reads back —
             but the list has to include everything the caller must act on.
             nextOffset in particular: without it a truncated read is a dead
             end again, which is the bug this round set out to fix. Note that
             fill's filled/refused/missing live inside `data`, not here. */
          meta: (function () {
            const keys = [
              "needsLogin", "truncated", "notFound",
              "nextOffset", "offset", "totalLength",
              "frames", "embeddedFrames",
              "scrolled", "grewBy", "steps", "container", "scrollHeight",
              "captcha", "count", "tabId",
            ];
            const m = {};
            for (const k of keys) if (result[k] != null) m[k] = result[k];
            return Object.keys(m).length ? m : undefined;
          })(),
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

/**
 * Clicking the toolbar icon opens the side panel.
 *
 * This replaces the old popup as the default click target: a popup closes the
 * instant you click the page, which is exactly when you want to ask Harvey
 * about the page you're on. The panel stays put beside the tab.
 *
 * Set on install AND on startup because the preference lives with the
 * extension's registration, not with a tab, and a browser restart is the case
 * where a missing behavior would silently do nothing on click. Guarded in
 * case the API is missing — an older Chrome should still poll and act, just
 * without the panel, rather than the whole worker dying on a bad call.
 */
function enableSidePanelOnClick() {
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
      .catch((e) => console.warn("[harvey] side panel behavior:", e?.message || e));
  } catch (e) {
    console.warn("[harvey] side panel unavailable:", e?.message || e);
  }
}

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelOnClick();
  loop();
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  enableSidePanelOnClick();
  loop();
});
enableSidePanelOnClick();
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
