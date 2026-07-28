/* Popup: pair with the server, and arm/disarm control. */

const $ = (id) => document.getElementById(id);

function paint(cfg, live) {
  $("serverUrl").value = cfg.serverUrl || "";
  $("token").value = cfg.token || "";
  $("enabled").checked = cfg.enabled === true;
  $("swHint").textContent = cfg.enabled
    ? "On — Harvey can act in your active tab"
    : "Off — nothing can run";

  const dot = $("dot");
  dot.className = "dot";
  if (!cfg.serverUrl || !cfg.token) {
    $("statusText").textContent = "Not paired";
  } else if (live && live.reachable === false) {
    dot.classList.add("err");
    $("statusText").textContent = "Can't reach the server";
  } else if (cfg.enabled) {
    dot.classList.add("on");
    $("statusText").textContent = "Paired · armed";
  } else {
    $("statusText").textContent = "Paired · standby";
  }
  if (live && live.page && live.page.url) {
    $("page").textContent = "Active tab: " + live.page.url;
  }
}

/** Ask the server whether it can see us, so pairing failures are visible here
 *  rather than only showing up as Harvey saying "not connected". */
async function checkServer(cfg) {
  if (!cfg.serverUrl || !cfg.token) return null;
  try {
    const res = await fetch(cfg.serverUrl.replace(/\/+$/, "") + "/api/browser/status", {
      headers: { "X-Browser-Token": cfg.token },
    });
    if (!res.ok) return { reachable: false };
    const d = await res.json();
    return { reachable: true, page: d.page };
  } catch (_) {
    return { reachable: false };
  }
}

async function refresh() {
  const cfg = await chrome.storage.local.get(["serverUrl", "token", "enabled"]);
  paint(cfg, await checkServer(cfg));
}

$("save").addEventListener("click", async () => {
  const serverUrl = $("serverUrl").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  await chrome.storage.local.set({ serverUrl, token });
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
