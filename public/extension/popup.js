/* Popup: pair with the server, and arm/disarm control. */

const $ = (id) => document.getElementById(id);

/* Never overwrite a field being edited. Repaint happens on load and after
   every toggle, and it used to rewrite these three inputs from storage — so a
   token typed but not yet saved was replaced with the stored (empty) value
   mid-keystroke. Same fix as the side panel; see the comment there. */
const dirty = new Set();
const FIELDS = ["deviceName", "serverUrl", "token"];

function fillForm(cfg, force) {
  for (const id of FIELDS) {
    const field = $(id);
    if (!force && (document.activeElement === field || dirty.has(id))) continue;
    field.value = cfg[id] || "";
  }
}

FIELDS.forEach((id) => $(id).addEventListener("input", () => dirty.add(id)));

function paint(cfg, live) {
  fillForm(cfg, false);
  $("enabled").checked = cfg.enabled === true;
  $("swHint").textContent = cfg.enabled
    ? "On — Harvey works in his own tab, not the one you're reading"
    : "Off — nothing can run";

  // Inverted on purpose: the checkbox reads "let Harvey switch it back on",
  // so ticked = allowed = lock off. Storing the lock rather than the
  // permission keeps the safe state as the default for anyone who never
  // opens this row.
  $("armLock").checked = cfg.armLock !== true;
  $("lockHint").textContent = cfg.armLock === true
    ? "Locked — only you can switch it on, from here"
    : 'Allowed — "turn the browser back on" works';

  const dot = $("dot");
  dot.className = "dot";
  if (!cfg.serverUrl || !cfg.token) {
    $("statusText").textContent = "Not paired";
  } else if (live && live.ok === false) {
    dot.classList.add("err");
    $("statusText").textContent = live.why;
  } else if (cfg.enabled) {
    dot.classList.add("on");
    $("statusText").textContent = "Paired · armed";
  } else {
    $("statusText").textContent = "Paired · standby";
  }
  if (live && live.page && live.page.url) {
    $("page").textContent = "Harvey's tab: " + live.page.url;
  } else if (live && live.ok) {
    $("page").textContent = "Harvey has no tab open yet";
  }
}

/**
 * Ask the server whether it can see us, so pairing failures are visible here
 * rather than only showing up as Harvey saying "not connected".
 *
 * Every failure used to read "Can't reach the server", which was wrong and
 * actively misleading: a 401 means the server answered perfectly well and the
 * token is the problem, and a 404 means the URL has a page path on the end.
 * Each of those has a different fix, so each gets its own message.
 */
async function checkServer(cfg) {
  if (!cfg.serverUrl || !cfg.token) return null;
  try {
    const res = await fetch(normalizeServer(cfg.serverUrl) + "/api/browser/status", {
      headers: { "X-Browser-Token": cfg.token },
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
    return { ok: true, page: d.page };
  } catch (_) {
    return { ok: false, why: "Can't reach the server" };
  }
}

/**
 * Keep only the origin. People paste whatever is in their address bar — which
 * is a page like `/shell`, not the API root — and every request then 404s with
 * nothing on screen explaining why.
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

async function refresh() {
  const cfg = await chrome.storage.local.get(["serverUrl", "token", "enabled", "armLock", "deviceName"]);
  paint(cfg, await checkServer(cfg));
}

$("armLock").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ armLock: !e.target.checked });
  chrome.runtime.sendMessage({ type: "harvey:poll-now" }, () => refresh());
});

$("save").addEventListener("click", async () => {
  const serverUrl = normalizeServer($("serverUrl").value);
  const token = $("token").value.trim();
  /* The name is how Harvey addresses this machine and how priority is
     decided, so it is saved with the pairing rather than hidden in settings. */
  const deviceName = $("deviceName").value.trim();
  if (!serverUrl || !token) {
    $("statusText").textContent = !serverUrl ? "Enter the server address first" : "Enter your pairing token first";
    return;
  }
  await chrome.storage.local.set({ serverUrl, token, deviceName });
  dirty.clear();
  fillForm({ serverUrl, token, deviceName }, true);   // show what was actually saved
  $("save").textContent = "Saved";
  setTimeout(() => { $("save").textContent = "Save & pair"; }, 1400);
  chrome.runtime.sendMessage({ type: "harvey:poll-now" }, () => refresh());
});

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  // Poll immediately so flipping the switch takes effect now, not on the
  // next idle tick.
  chrome.runtime.sendMessage({ type: "harvey:poll-now" }, () => refresh());
});

refresh();
