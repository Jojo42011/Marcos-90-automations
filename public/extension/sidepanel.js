/**
 * Harvey side panel — talk to Harvey next to whatever you're looking at.
 *
 * WHY A SIDE PANEL AND NOT A POPUP. A popup dies the moment you click the
 * page, which is the exact moment you want to ask about the page. The panel
 * stays open beside the tab, so "what do you make of this listing" is one
 * question in a conversation rather than a trip back to the shell.
 *
 * It talks to `/api/browser/chat` using the SAME pairing token the extension
 * already holds — one secret, not two — and the server scopes every browser
 * action Harvey takes to that token's account, so two people using Harvey at
 * the same time drive their own browsers and hold their own threads.
 *
 * The pairing form lives here too (it used to be the popup's whole job) so
 * setup and use are one surface. popup.html stays as the options page for
 * anyone who reaches settings that way.
 */

const $ = (id) => document.getElementById(id);

/* Conversation is kept per browser in storage rather than in a variable: the
   panel is torn down and rebuilt whenever it is closed and reopened, and
   losing the thread on every close is what makes a chat feel disposable. */
const LOG_KEY = "panelLog";
const MAX_LOG = 60;

let busy = false;

function normalizeServer(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : "https://" + s).origin;
  } catch (_) {
    return s.replace(/\/+$/, "");
  }
}

async function cfg() {
  return chrome.storage.local.get([
    "serverUrl", "token", "enabled", "armLock", "deviceName", "deviceId",
  ]);
}

/* ── Transcript ─────────────────────────────────────────────────────────── */

function bubble(role, text, opts = {}) {
  const el = document.createElement("div");
  el.className = "msg " + role + (opts.error ? " err" : "");
  if (role === "harvey") {
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = "Harvey";
    el.appendChild(name);
    const body = document.createElement("div");
    body.textContent = text;
    el.appendChild(body);
  } else {
    el.textContent = text;
  }
  if (opts.thinking) el.classList.add("thinking");
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}

async function loadLog() {
  const c = await chrome.storage.local.get([LOG_KEY]);
  const log = Array.isArray(c[LOG_KEY]) ? c[LOG_KEY] : [];
  $("log").textContent = "";
  for (const m of log) bubble(m.role, m.text);
  if (!log.length) {
    bubble("sys", "Ask Harvey anything. He can also open pages and pull data in this browser when control is switched on.");
  }
}

async function appendLog(role, text) {
  const c = await chrome.storage.local.get([LOG_KEY]);
  const log = Array.isArray(c[LOG_KEY]) ? c[LOG_KEY] : [];
  log.push({ role, text });
  while (log.length > MAX_LOG) log.shift();
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

/* ── Pairing / status ───────────────────────────────────────────────────── */

async function checkServer(c) {
  if (!c.serverUrl || !c.token) return null;
  try {
    const res = await fetch(normalizeServer(c.serverUrl) + "/api/browser/status", {
      headers: { "X-Browser-Token": c.token },
    });
    if (res.status === 404) return { ok: false, why: "Wrong server address" };
    if (res.status === 401) {
      const d = await res.json().catch(() => ({}));
      return d.configured === false
        ? { ok: false, why: "Server has no pairing token set" }
        : { ok: false, why: "Pairing token doesn't match" };
    }
    if (!res.ok) return { ok: false, why: "Server error (" + res.status + ")" };
    const d = await res.json();
    return { ok: true, page: d.page, account: d.account };
  } catch (_) {
    return { ok: false, why: "Can't reach the server" };
  }
}

/* ── The form vs. the status repaint ──────────────────────────────────────
 * These are deliberately separate now.
 *
 * They used to be one function, and it ate what you were typing: the status
 * repaint runs on load, when Setup is opened, and on a 15s timer, and each
 * run rewrote the inputs from storage. A token you were halfway through
 * typing had never been saved, so "from storage" meant EMPTY — the field
 * cleared itself under your hands and you had to beat the timer to pair.
 *
 * So the form is only ever filled when it is safe to do so: not while a field
 * has focus, and not while it holds edits you haven't saved. `force` is for
 * after a save, where the stored value IS the truth and should be shown (the
 * server URL gets normalized on the way in, and you should see what was
 * actually kept).
 */
const dirty = new Set();
const FIELDS = ["deviceName", "serverUrl", "token"];

function fillForm(c, force) {
  for (const id of FIELDS) {
    const field = $(id);
    if (!force && (document.activeElement === field || dirty.has(id))) continue;
    field.value = c[id] || "";
  }
}

FIELDS.forEach((id) => $(id).addEventListener("input", () => dirty.add(id)));

function paint(c, live) {
  fillForm(c, false);
  $("enabled").checked = c.enabled === true;
  $("swHint").textContent = c.enabled
    ? "On — Harvey works in his own tab, not the one you're reading"
    : "Off — he can still talk, but cannot act in this browser";

  // Inverted on purpose: the checkbox reads "let Harvey switch it back on",
  // so ticked = allowed = lock off.
  $("armLock").checked = c.armLock !== true;
  $("lockHint").textContent = c.armLock === true
    ? "Locked — only you can switch it on, from here"
    : 'Allowed — "turn the browser back on" works';

  const dot = $("dot");
  dot.className = "dot";
  if (!c.serverUrl || !c.token) {
    $("statusText").textContent = "Not paired";
    $("who").textContent = "not paired";
  } else if (live && live.ok === false) {
    dot.classList.add("err");
    $("statusText").textContent = live.why;
    $("who").textContent = live.why;
  } else if (c.enabled) {
    dot.classList.add("on");
    $("statusText").textContent = "Paired · armed";
    $("who").textContent = live && live.account ? live.account.name + " · armed" : "armed";
  } else {
    $("statusText").textContent = "Paired · standby";
    $("who").textContent = live && live.account ? live.account.name + " · standby" : "standby";
  }
  if (live && live.page && live.page.url) {
    $("page").textContent = "Harvey's tab: " + live.page.url;
  } else if (live && live.ok) {
    $("page").textContent = "Harvey has no tab open yet";
  }
}

async function refresh() {
  const c = await cfg();
  paint(c, await checkServer(c));
  // Unpaired is the one state where setup matters more than the chat.
  if (!c.serverUrl || !c.token) $("setup").hidden = false;
}

/* ── Sending ────────────────────────────────────────────────────────────── */

async function send(text) {
  if (busy || !text.trim()) return;
  const c = await cfg();
  if (!c.serverUrl || !c.token) {
    bubble("sys", "Pair this browser first — open Setup above.", { error: true });
    $("setup").hidden = false;
    return;
  }

  busy = true;
  $("send").disabled = true;
  bubble("user", text);
  void appendLog("user", text);
  const pendingEl = bubble("harvey", "thinking…", { thinking: true });

  try {
    const res = await fetch(normalizeServer(c.serverUrl) + "/api/browser/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Browser-Token": c.token },
      body: JSON.stringify({ message: text, deviceId: c.deviceId || "panel" }),
    });
    if (res.status === 401) throw new Error("Pairing token doesn't match — check Setup.");
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || "Server error (" + res.status + ")");
    }
    const d = await res.json();
    const speech = (d.speech || "").trim() || "(no answer)";
    pendingEl.remove();
    bubble("harvey", speech);
    void appendLog("harvey", speech);
  } catch (err) {
    pendingEl.remove();
    /* Say what actually went wrong. "Something went wrong" on a pairing
       failure sends people looking at the wrong thing entirely. */
    const msg = err && err.message ? err.message : String(err);
    bubble("sys", /fetch|network|Failed to fetch/i.test(msg) ? "Can't reach the server." : msg, { error: true });
  } finally {
    busy = false;
    $("send").disabled = false;
    $("input").focus();
  }
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("input").value;
  $("input").value = "";
  $("input").style.height = "auto";
  void send(v);
});

// Enter sends, Shift+Enter is a newline — the convention everywhere else.
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("form").requestSubmit();
  }
});

$("input").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
});

$("toggleSetup").addEventListener("click", () => {
  $("setup").hidden = !$("setup").hidden;
  if (!$("setup").hidden) void refresh();
});

$("clear").addEventListener("click", async () => {
  await chrome.storage.local.remove(LOG_KEY);
  await loadLog();
});

$("save").addEventListener("click", async () => {
  const serverUrl = normalizeServer($("serverUrl").value);
  const token = $("token").value.trim();
  const deviceName = $("deviceName").value.trim();
  if (!serverUrl || !token) {
    /* Saying nothing and storing a half-pairing is how you end up staring at
       "Not paired" with no idea which field is missing. */
    $("statusText").textContent = !serverUrl ? "Enter the server address first" : "Enter your pairing token first";
    return;
  }
  await chrome.storage.local.set({ serverUrl, token, deviceName });
  /* Saved, so the stored values are now the truth: clear the edit flags and
     show what was actually kept (the URL is normalized to its origin). */
  dirty.clear();
  fillForm({ serverUrl, token, deviceName }, true);
  $("save").textContent = "Saved";
  setTimeout(() => { $("save").textContent = "Save & pair"; }, 1400);
  chrome.runtime.sendMessage({ type: "harvey:poll-now" }, () => refresh());
});

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  chrome.runtime.sendMessage({ type: "harvey:poll-now" }, () => refresh());
});

$("armLock").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ armLock: !e.target.checked });
  chrome.runtime.sendMessage({ type: "harvey:poll-now" }, () => refresh());
});

void loadLog();
void refresh();
// The armed state can change from the server side (Harvey disarming himself,
// another tab pairing), so the header shouldn't go stale while the panel sits open.
setInterval(refresh, 15000);
