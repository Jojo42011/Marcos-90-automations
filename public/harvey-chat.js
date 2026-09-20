/* ============================================================================
   Harvey chat surface — all of the behaviour behind public/harvey.html.

   Built against docs/harvey-model-layer.md. Those endpoints may not exist on
   the server yet, so every call here treats 404 as "not wired up" and says so
   out loud rather than drawing something that looks live. The one hard rule in
   this file: NOTHING is rendered that the server did not return. No sample
   conversations, no example spend, no placeholder tasks.

   No build step, no dependencies (house rule) — plain browser JS.
   ========================================================================== */
(function () {
  "use strict";

  /* ── plumbing ───────────────────────────────────────────────────────── */

  var $ = function (id) { return document.getElementById(id); };
  var TOKEN = (function () {
    try {
      return new URLSearchParams(location.search).get("token") ||
             localStorage.getItem("dashboardToken") || "";
    } catch (_) { return ""; }
  })();

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function apiUrl(path) {
    var u = new URL(path, location.origin);
    if (TOKEN) u.searchParams.set("token", TOKEN);
    return u.toString();
  }

  function authHeaders(extra) {
    var h = Object.assign({}, extra || {});
    if (TOKEN) h.Authorization = "Bearer " + TOKEN;
    return h;
  }

  /** One fetch wrapper so 401 and "not wired yet" are handled in one place. */
  async function api(path, opts) {
    var o = Object.assign({ credentials: "same-origin" }, opts || {});
    o.headers = authHeaders(o.headers);
    if (o.body && typeof o.body !== "string") {
      o.headers["Content-Type"] = "application/json";
      o.body = JSON.stringify(o.body);
    }
    var res;
    try {
      res = await fetch(apiUrl(path), o);
    } catch (e) {
      return { ok: false, status: 0, data: null, error: "Could not reach the server." };
    }
    if (res.status === 401) { showAuthBanner(); return { ok: false, status: 401, data: null, error: "Not signed in." }; }
    var text = await res.text().catch(function () { return ""; });
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    return {
      ok: res.ok,
      status: res.status,
      data: data,
      error: (data && (data.error || data.message)) || (res.ok ? "" : "Request failed (" + res.status + ")")
    };
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 3200);
  }

  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }
  function firstNum() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v == null) continue;
      var n = typeof v === "string" ? parseFloat(v) : v;
      if (typeof n === "number" && isFinite(n)) return n;
    }
    return null;
  }
  function money(v, places) {
    var n = num(v);
    if (n == null) return "—";
    return "$" + n.toFixed(places == null ? 2 : places);
  }
  /** Sub-dollar amounts need the extra places; larger ones read as noise. */
  function costText(v) {
    var n = firstNum(v);
    if (n == null) return "—";
    return "$" + n.toFixed(n >= 1 ? 2 : 4);
  }
  function count(v) {
    var n = num(v);
    return n == null ? "—" : n.toLocaleString();
  }
  function dateText(v) {
    if (!v) return "—";
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function shortModel(id) {
    if (!id) return "";
    var s = String(id);
    var slash = s.lastIndexOf("/");
    if (slash >= 0) s = s.slice(slash + 1);
    return s;
  }

  /* ── markdown ───────────────────────────────────────────────────────────
     Small block renderer: headings, lists, tables, quotes, rules, fenced code
     (with a language label and a copy button) and inline code/bold/links.
     Everything is escaped on the way in. */

  function mdInline(t) {
    return esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }
  function isTableSep(l) { return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.indexOf("-") >= 0; }
  function splitRow(l) {
    return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
  }

  function renderMarkdown(src) {
    var lines = String(src == null ? "" : src).replace(/\r\n/g, "\n").split("\n");
    var html = "", i = 0, listOpen = null;
    function closeList() { if (listOpen) { html += "</" + listOpen + ">"; listOpen = null; } }

    while (i < lines.length) {
      var l = lines[i];

      var fence = /^\s*```(.*)$/.exec(l);
      if (fence) {
        closeList();
        var lang = (fence[1] || "").trim();
        i++;
        var buf = [];
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += '<div class="code"><div class="code-bar"><span>' + esc(lang || "code") + '</span>' +
          '<span class="grow"></span><button type="button" class="copy-btn" data-copy-code>Copy</button></div>' +
          "<pre><code>" + esc(buf.join("\n")) + "</code></pre></div>";
        continue;
      }
      if (!l.trim()) { closeList(); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { closeList(); html += "<hr>"; i++; continue; }

      var h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) {
        closeList();
        var lvl = Math.min(h[1].length, 4);
        html += "<h" + lvl + ">" + mdInline(h[2]) + "</h" + lvl + ">";
        i++; continue;
      }
      if (l.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        closeList();
        var head = splitRow(l); i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        html += '<div class="table-wrap"><table><thead><tr>' +
          head.map(function (c) { return "<th>" + mdInline(c) + "</th>"; }).join("") +
          "</tr></thead><tbody>" +
          rows.map(function (r) {
            return "<tr>" + head.map(function (_, n) { return "<td>" + mdInline(r[n] == null ? "" : r[n]) + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table></div>";
        continue;
      }
      var li = /^\s*[-*+]\s+(.*)$/.exec(l);
      var ol = /^\s*\d+[.)]\s+(.*)$/.exec(l);
      if (li || ol) {
        var want = li ? "ul" : "ol";
        if (listOpen !== want) { closeList(); listOpen = want; html += "<" + want + ">"; }
        html += "<li>" + mdInline((li || ol)[1]) + "</li>"; i++; continue;
      }
      if (/^\s*>\s?/.test(l)) {
        closeList();
        html += "<blockquote>" + mdInline(l.replace(/^\s*>\s?/, "")) + "</blockquote>";
        i++; continue;
      }
      closeList();
      var para = [l]; i++;
      while (i < lines.length && lines[i].trim() &&
             !/^\s*(#|[-*+]\s|\d+[.)]\s|>|```|\|)/.test(lines[i]) &&
             !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) { para.push(lines[i]); i++; }
      html += "<p>" + mdInline(para.join(" ")) + "</p>";
    }
    closeList();
    return html;
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-copy-code]") : null;
    if (!btn) return;
    var pre = btn.closest(".code").querySelector("code");
    var text = pre ? pre.textContent : "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy"; }, 1400);
      }).catch(function () { toast("The browser blocked clipboard access."); });
    } else {
      toast("This browser does not allow copying from script.");
    }
  });

  /* ── state ──────────────────────────────────────────────────────────── */

  var MODEL_KEY = "harvey_model";
  var THEME_KEY = "marco_crm_theme";
  var LOCAL_CONVS_KEY = "harvey_local_conversations";

  var state = {
    sessionId: "",
    conversationId: null,
    selectedModel: "auto",
    models: [],           // normalized ModelInfo[], only ever from the server
    routing: null,
    provider: null,
    budget: null,
    modelsWired: null,    // null = unknown, false = endpoint 404s
    convsWired: null,
    tasksWired: null,
    usageWired: null,
    legacyMode: false,    // true once /api/harvey/chat has answered 404
    busy: false,
    abort: null,
    conversations: [],
    convFilter: "",
    view: "chat"
  };

  try {
    state.sessionId = sessionStorage.getItem("harvey_session_id") || "";
    if (!state.sessionId) {
      state.sessionId = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("harvey_session_id", state.sessionId);
    }
    state.selectedModel = localStorage.getItem(MODEL_KEY) || "auto";
  } catch (_) {
    state.sessionId = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /* ── banners ────────────────────────────────────────────────────────── */

  function showAuthBanner() {
    var b = $("authBanner");
    b.className = "banner bad";
    b.innerHTML = 'Your session has expired. <b>Sign in again</b> to keep talking to Harvey — ' +
      '<a href="/who?next=%2Fharvey" target="_top">go to sign-in</a>.';
    b.hidden = false;
  }

  function showLegacyBanner() {
    var b = $("legacyBanner");
    b.className = "banner";
    b.innerHTML = '<b>Backend not wired yet</b> — running on the legacy chat endpoint ' +
      '(<code>/api/jarvis/chat</code>). Replies still work; model choice, streamed tool activity, ' +
      'approvals and per-message cost do not exist on that path.';
    b.hidden = false;
  }

  /* ── theme ──────────────────────────────────────────────────────────── */

  function currentTheme() { return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(THEME_KEY, t); } catch (_) {}
    var icon = $("themeIcon");
    icon.innerHTML = t === "light"
      ? '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/>'
      : '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  }

  /* ── popovers ───────────────────────────────────────────────────────── */

  var openPop = null;
  function placePop(pop, anchor, align) {
    pop.style.position = "fixed";
    pop.hidden = false;
    var a = anchor.getBoundingClientRect();
    var p = pop.getBoundingClientRect();
    var left = align === "left" ? a.left : a.right - p.width;
    left = Math.max(10, Math.min(left, window.innerWidth - p.width - 10));
    var top = a.top - p.height - 10;
    if (top < 10) top = Math.min(a.bottom + 10, window.innerHeight - p.height - 10);
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(Math.max(10, top)) + "px";
  }
  function closePop() {
    if (!openPop) return;
    openPop.pop.hidden = true;
    if (openPop.anchor) openPop.anchor.setAttribute("aria-expanded", "false");
    openPop = null;
  }
  function togglePop(pop, anchor, align) {
    if (openPop && openPop.pop === pop) { closePop(); return; }
    closePop();
    placePop(pop, anchor, align);
    if (anchor) anchor.setAttribute("aria-expanded", "true");
    openPop = { pop: pop, anchor: anchor };
  }
  document.addEventListener("mousedown", function (e) {
    if (!openPop) return;
    if (openPop.pop.contains(e.target) || (openPop.anchor && openPop.anchor.contains(e.target))) return;
    closePop();
  });
  window.addEventListener("resize", closePop);

  /* ── models ─────────────────────────────────────────────────────────── */

  /* Frontier labs first, then the open-weight and value labs the catalog spans
     (Alibaba's Qwen, DeepSeek, Zhipu's GLM, MiniMax), then everything else. */
  var FAMILY_ORDER = ["Anthropic", "OpenAI", "Google", "xAI", "Meta", "Qwen", "DeepSeek", "Zhipu", "MiniMax", "Other"];

  function familyOf(m, id) {
    var raw = String(m.family || m.provider || m.vendor || (String(id).indexOf("/") > 0 ? String(id).split("/")[0] : "")).toLowerCase();
    if (/anthropic|claude/.test(raw)) return "Anthropic";
    if (/openai|gpt|^o[0-9]/.test(raw)) return "OpenAI";
    if (/google|gemini/.test(raw)) return "Google";
    if (/^x-?ai$|xai|grok/.test(raw)) return "xAI";
    if (/^meta$|llama|muse/.test(raw)) return "Meta";
    if (/qwen|alibaba/.test(raw)) return "Qwen";
    if (/deepseek/.test(raw)) return "DeepSeek";
    if (/zhipu|^z-ai$|glm/.test(raw)) return "Zhipu";
    if (/minimax/.test(raw)) return "MiniMax";
    if (!raw) {
      var lid = String(id).toLowerCase();
      if (lid.indexOf("claude") >= 0) return "Anthropic";
      if (lid.indexOf("gpt") === 0 || lid.indexOf("o1") === 0 || lid.indexOf("o3") === 0) return "OpenAI";
      if (lid.indexOf("gemini") >= 0) return "Google";
    }
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Other";
  }

  /* The catalog shape isn't pinned down in the contract beyond "ModelInfo[]",
     so read the spellings a provider plausibly uses and show only the fields
     that actually came back. A missing price prints nothing, never a guess. */
  function normModel(m) {
    if (typeof m === "string") m = { id: m };
    var id = m.id || m.model || m.slug || m.name || "";
    var perM = m.pricePerMillion || m.pricePerM || {};
    var pricing = m.pricing || {};
    /* `inputPerM` / `outputPerM` are what the server actually sends (pinned in
       src/hull/providers/types.ts). They are FIRST because reading them last is
       how every model in the picker came to say "no price reported". */
    var inPerM = firstNum(m.inputPerM, m.inputPricePerMTokens, m.inputPerMTokens, m.promptPricePerM, m.inputPricePerM,
      perM.in, perM.input, pricing.inputPerMTokens, pricing.inPerM);
    var outPerM = firstNum(m.outputPerM, m.outputPricePerMTokens, m.outputPerMTokens, m.completionPricePerM, m.outputPricePerM,
      perM.out, perM.output, pricing.outputPerMTokens, pricing.outPerM);
    /* OpenRouter-style pricing is per single token ("0.000003"), so scale it
       into the per-million figures the picker shows. */
    if (inPerM == null) { var pt = firstNum(pricing.prompt, pricing.input, m.promptPrice); if (pt != null) inPerM = pt * 1e6; }
    if (outPerM == null) { var ct = firstNum(pricing.completion, pricing.output, m.completionPrice); if (ct != null) outPerM = ct * 1e6; }
    return {
      id: id,
      label: m.label || m.name || m.title || id,
      family: familyOf(m, id),
      tier: m.tier || m.class || m.speed || "",
      inPerM: inPerM,
      outPerM: outPerM,
      context: firstNum(m.contextTokens, m.contextWindow, m.context, m.maxInputTokens),
      vision: !!(m.supportsVision || m.vision || (m.capabilities && m.capabilities.vision)),
      note: m.note || m.description || ""
    };
  }

  function modelById(id) {
    for (var i = 0; i < state.models.length; i++) if (state.models[i].id === id) return state.models[i];
    return null;
  }

  function priceText(m) {
    if (m.inPerM == null && m.outPerM == null) return "";
    var bits = [];
    /* Sub-dollar models differ from each other by cents, and that difference is
       the whole reason someone picks one, so two fixed decimals is not enough
       resolution to tell them apart. Formatted from server data either way. */
    var fmt = function (n) { return n < 1 ? ("$" + n.toFixed(2).replace(/0$/, "")) : ("$" + n.toFixed(2)); };
    if (m.inPerM != null) bits.push(fmt(m.inPerM) + " in");
    if (m.outPerM != null) bits.push(fmt(m.outPerM) + " out");
    return bits.join(" · ") + " / 1M";
  }

  function paintModelPill() {
    var label = "Auto";
    if (state.selectedModel && state.selectedModel !== "auto") {
      var m = modelById(state.selectedModel);
      label = m ? m.label : shortModel(state.selectedModel);
    }
    $("modelPillLabel").textContent = label;
    var pill = $("modelPill");
    if (state.legacyMode) {
      pill.disabled = true;
      pill.title = "The legacy chat endpoint does not take a model — this picker starts working when /api/harvey/chat exists.";
    } else {
      pill.disabled = false;
      pill.title = "Model for the next message";
    }
  }

  function selectModel(id) {
    state.selectedModel = id;
    try { localStorage.setItem(MODEL_KEY, id); } catch (_) {}
    paintModelPill();
  }

  function buildModelMenu() {
    var menu = $("modelMenu");
    var html = "";
    var autoSel = state.selectedModel === "auto";
    html += '<button type="button" class="pop-item" role="option" data-model="auto" aria-selected="' + (autoSel ? "true" : "false") + '">' +
      '<span class="pi-main"><span class="pi-label">Auto</span>' +
      '<span class="pi-sub">Harvey routes each job to the model it picks</span></span>' +
      checkSvg() + "</button>";

    if (state.modelsWired === false) {
      html += '<div class="pop-sep"></div><div class="pop-note">No model catalog yet — <code>GET /api/harvey/models</code> returned 404, so Auto is the only honest choice until the server exposes it.</div>';
    } else if (!state.models.length) {
      html += '<div class="pop-sep"></div><div class="pop-note">The server returned no models. Nothing to pick from.</div>';
    } else {
      var groups = {};
      state.models.forEach(function (m) { (groups[m.family] = groups[m.family] || []).push(m); });
      var names = Object.keys(groups).sort(function (a, b) {
        var ai = FAMILY_ORDER.indexOf(a), bi = FAMILY_ORDER.indexOf(b);
        if (ai < 0) ai = FAMILY_ORDER.length; if (bi < 0) bi = FAMILY_ORDER.length;
        return ai - bi || a.localeCompare(b);
      });
      names.forEach(function (fam) {
        html += '<div class="pop-group">' + esc(fam) + "</div>";
        groups[fam].forEach(function (m) {
          var sel = state.selectedModel === m.id;
          html += '<button type="button" class="pop-item" role="option" data-model="' + esc(m.id) + '" aria-selected="' + (sel ? "true" : "false") + '">' +
            '<span class="pi-main"><span class="pi-label">' + esc(m.label) +
            (m.tier ? ' <span class="tier">' + esc(m.tier) + "</span>" : "") + "</span>" +
            (priceText(m) ? '<span class="pi-sub">' + esc(priceText(m)) + "</span>" : '<span class="pi-sub">no price reported</span>') +
            "</span>" + checkSvg() + "</button>";
        });
      });
    }
    menu.innerHTML = html;
  }

  function checkSvg() {
    return '<svg class="pi-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  }

  async function loadModels() {
    var r = await api("/api/harvey/models");
    if (r.status === 404) { state.modelsWired = false; paintProviderPill(); return; }
    if (!r.ok || !r.data) { state.modelsWired = false; paintProviderPill(); return; }
    state.modelsWired = true;
    state.models = (r.data.models || []).map(normModel).filter(function (m) { return m.id; });
    state.routing = r.data.routing || null;
    state.provider = r.data.provider || null;
    state.budget = r.data.budget || null;
    paintProviderPill();
    paintModelPill();
    paintSpendCount();
  }

  function paintProviderPill() {
    var pill = $("providerPill");
    if (state.modelsWired === false) {
      pill.hidden = false;
      pill.className = "pill-status";
      pill.innerHTML = '<span class="dot"></span>Model layer not wired yet';
      pill.title = "GET /api/harvey/models returned 404.";
      return;
    }
    if (!state.provider) { pill.hidden = true; return; }
    var primary = state.provider.primary;
    pill.hidden = false;
    if (!primary) {
      pill.className = "pill-status bad";
      pill.innerHTML = '<span class="dot"></span>No provider key configured';
      pill.title = "Neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set on the server.";
      return;
    }
    var st = state.budget && state.budget.state;
    pill.className = "pill-status " + (st === "over" ? "bad" : st === "near" ? "warn" : "ok");
    pill.innerHTML = '<span class="dot"></span>' + esc(primary);
    pill.title = st === "over" ? "Over the spend cap — calls are being refused."
      : st === "near" ? "Near the spend cap — cheap jobs are degrading to the cheapest model."
      : "Primary provider: " + primary;
  }

  function paintSpendCount() {
    var el = $("navSpend");
    var b = state.budget;
    var spent = b ? num(b.spentTodayUsd) : null;
    el.textContent = spent == null ? "" : money(spent);
  }

  /* ── conversations ──────────────────────────────────────────────────── */

  function readLocalConvs() {
    try { return JSON.parse(localStorage.getItem(LOCAL_CONVS_KEY) || "[]") || []; } catch (_) { return []; }
  }
  function writeLocalConvs(list) {
    try { localStorage.setItem(LOCAL_CONVS_KEY, JSON.stringify(list.slice(0, 60))); } catch (_) {}
  }
  function localConvUpsert(id, patch) {
    var list = readLocalConvs();
    var found = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { found = list[i]; break; }
    if (!found) { found = { id: id, title: "", updatedAt: new Date().toISOString(), messages: [] }; list.unshift(found); }
    Object.assign(found, patch || {});
    found.updatedAt = new Date().toISOString();
    list.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    writeLocalConvs(list);
    return found;
  }
  function localConvAppend(id, msg) {
    var list = readLocalConvs();
    var conv = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { conv = list[i]; break; }
    if (!conv) { conv = { id: id, title: "", updatedAt: "", messages: [] }; list.unshift(conv); }
    conv.messages.push(msg);
    if (conv.messages.length > 200) conv.messages = conv.messages.slice(-200);
    if (!conv.title && msg.role === "user") conv.title = msg.content.slice(0, 60);
    conv.updatedAt = new Date().toISOString();
    list.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    writeLocalConvs(list);
  }

  async function loadConversations() {
    if (state.convsWired === false) { state.conversations = readLocalConvs(); paintConversations(); return; }
    var r = await api("/api/harvey/conversations");
    if (r.status === 404) {
      state.convsWired = false;
      state.conversations = readLocalConvs();
      paintConversations();
      return;
    }
    if (!r.ok || !r.data) { paintConversations(); return; }
    state.convsWired = true;
    state.conversations = r.data.conversations || [];
    paintConversations();
  }

  function paintConversations() {
    var wrap = $("convList");
    var q = state.convFilter.trim().toLowerCase();
    var list = state.conversations.filter(function (c) {
      return !q || String(c.title || "").toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) {
      wrap.innerHTML = '<div class="side-empty">' +
        (state.conversations.length ? "Nothing matches that search."
          : state.convsWired === false
            ? "No conversations yet. They are kept in this browser until the server exposes /api/harvey/conversations."
            : "No conversations yet.") +
        "</div>";
      return;
    }
    wrap.innerHTML = list.map(function (c) {
      var title = c.title || "Untitled";
      var active = c.id === state.conversationId ? " active" : "";
      return '<div class="conv' + active + '" data-conv="' + esc(c.id) + '">' +
        '<button type="button" class="title" title="' + esc(title) + '">' + esc(title) + "</button>" +
        '<button type="button" class="conv-act" data-rename="' + esc(c.id) + '" aria-label="Rename this conversation" title="Rename">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>' +
        '<button type="button" class="conv-act" data-delete="' + esc(c.id) + '" aria-label="Delete this conversation" title="Delete">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg></button>' +
        "</div>";
    }).join("");
  }

  async function openConversation(id) {
    if (state.busy) { toast("Harvey is still answering — wait for that to finish."); return; }
    showView("chat");
    if (state.convsWired === false) {
      var conv = readLocalConvs().filter(function (c) { return c.id === id; })[0];
      if (!conv) { toast("That conversation is no longer in this browser."); return; }
      state.conversationId = id;
      renderConversation(conv.messages || []);
      paintConversations();
      return;
    }
    var r = await api("/api/harvey/conversations/" + encodeURIComponent(id));
    if (r.status === 404) { toast("That conversation is gone."); loadConversations(); return; }
    if (!r.ok || !r.data) { toast(r.error || "Could not open that conversation."); return; }
    state.conversationId = id;
    renderConversation(r.data.messages || []);
    paintConversations();
  }

  function renderConversation(messages) {
    clearThread();
    messages.forEach(function (m) {
      if (m.role === "user") { addUserMessage(m.content || ""); return; }
      var ui = addAssistantMessage();
      ui.setText(m.content || "");
      ui.finish();
      if (m.model || num(m.costUsd) != null) ui.setUsage({ model: m.model, costUsd: m.costUsd, substituted: m.substituted });
    });
    scrollToBottom(true);
  }

  async function renameConversation(id) {
    var current = (state.conversations.filter(function (c) { return c.id === id; })[0] || {}).title || "";
    var title = window.prompt("Rename this conversation", current);
    if (title == null) return;
    title = title.trim();
    if (!title) return;
    if (state.convsWired === false) {
      localConvUpsert(id, { title: title });
      state.conversations = readLocalConvs();
      paintConversations();
      return;
    }
    var r = await api("/api/harvey/conversations/" + encodeURIComponent(id) + "/title", { method: "POST", body: { title: title } });
    if (!r.ok) { toast(r.error || "Could not rename that."); return; }
    loadConversations();
  }

  async function deleteConversation(id) {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    if (state.convsWired === false) {
      writeLocalConvs(readLocalConvs().filter(function (c) { return c.id !== id; }));
      state.conversations = readLocalConvs();
      if (state.conversationId === id) newChat();
      paintConversations();
      return;
    }
    var r = await api("/api/harvey/conversations/" + encodeURIComponent(id), { method: "DELETE" });
    if (!r.ok) { toast(r.error || "Could not delete that."); return; }
    if (state.conversationId === id) newChat();
    loadConversations();
  }

  /* ── thread rendering ───────────────────────────────────────────────── */

  var thread, threadScroll;

  function clearThread() {
    Array.prototype.slice.call(thread.querySelectorAll(".msg, .empty")).forEach(function (el) { el.remove(); });
  }

  function nearBottom() {
    return threadScroll.scrollHeight - threadScroll.scrollTop - threadScroll.clientHeight < 140;
  }
  function scrollToBottom(force) {
    if (force || nearBottom()) threadScroll.scrollTop = threadScroll.scrollHeight;
  }

  var SUGGESTIONS = [
    "What needs my attention today?",
    "Schedule a daily 7am pipeline report",
    "Which leads went quiet?",
    "What did you spend on me this week?"
  ];

  function showEmptyState() {
    clearThread();
    var el = document.createElement("div");
    el.className = "empty";
    el.innerHTML = '<div class="orb-lg" aria-hidden="true"></div>' +
      "<h1>" + esc(greeting()) + "</h1>" +
      "<p>Ask a question, hand off a job, or tell me when to run something.</p>" +
      '<div class="chips">' + SUGGESTIONS.map(function (s) {
        return '<button type="button" class="chip">' + esc(s) + "</button>";
      }).join("") + "</div>";
    thread.appendChild(el);
    el.querySelectorAll(".chip").forEach(function (chip) {
      chip.addEventListener("click", function () { send(chip.textContent); });
    });
  }

  function greeting() {
    var name = displayName();
    return name ? "Where should we start, " + name + "?" : "Where should we start?";
  }

  function displayName() {
    try {
      var id = window.TeamSession ? TeamSession.currentUser() : "";
      if (!id) return "";
      return id.charAt(0).toUpperCase() + id.slice(1);
    } catch (_) { return ""; }
  }

  function addUserMessage(text) {
    var el = document.createElement("div");
    el.className = "msg user";
    var b = document.createElement("div");
    b.className = "bubble";
    b.textContent = text;
    el.appendChild(b);
    thread.appendChild(el);
    scrollToBottom(true);
  }

  function addAssistantMessage() {
    var el = document.createElement("div");
    el.className = "msg ai";
    el.innerHTML =
      '<div class="tools"></div>' +
      '<div class="body"><span class="thinking" aria-label="Harvey is thinking"><i></i><i></i><i></i></span></div>' +
      '<div class="approvals"></div>' +
      '<div class="msg-meta" hidden></div>' +
      '<div class="msg-actions"><button type="button" class="copy-msg">Copy</button></div>';
    thread.appendChild(el);
    scrollToBottom(true);

    var body = el.querySelector(".body");
    var toolsWrap = el.querySelector(".tools");
    var approvalsWrap = el.querySelector(".approvals");
    var metaWrap = el.querySelector(".msg-meta");
    var text = "";
    var frame = null;
    var toolRows = {};

    function paint(withCaret) {
      body.innerHTML = renderMarkdown(text) + (withCaret ? '<span class="caret" aria-hidden="true"></span>' : "");
      scrollToBottom();
    }

    el.querySelector(".copy-msg").addEventListener("click", function () {
      if (!navigator.clipboard) { toast("This browser does not allow copying from script."); return; }
      navigator.clipboard.writeText(text).then(function () { toast("Copied."); }).catch(function () {});
    });

    return {
      el: el,
      get text() { return text; },
      append: function (chunk) {
        if (!chunk) return;
        text += chunk;
        if (frame) return;
        frame = requestAnimationFrame(function () { frame = null; paint(true); });
      },
      setText: function (t) { text = t || ""; paint(false); },
      finish: function () {
        if (frame) { cancelAnimationFrame(frame); frame = null; }
        if (!text) { body.innerHTML = '<span class="err-line">Harvey returned nothing.</span>'; return; }
        paint(false);
      },
      error: function (msg) {
        if (frame) { cancelAnimationFrame(frame); frame = null; }
        var line = '<div class="err-line">' + esc(msg || "Something went wrong.") + "</div>";
        body.innerHTML = text ? renderMarkdown(text) + line : line;
        scrollToBottom();
      },
      tool: function (t) {
        var name = t && t.name ? String(t.name) : "tool";
        var key = name + (t && t.id ? ":" + t.id : "");
        var row = toolRows[key];
        if (!row) {
          row = document.createElement("span");
          row.className = "tool-row";
          toolRows[key] = row;
          toolsWrap.appendChild(row);
        }
        var status = (t && t.status) || "running";
        row.className = "tool-row " + (status === "done" ? "done" : status === "error" ? "error" : "");
        var mark = status === "running"
          ? '<span class="spin" aria-hidden="true"></span>'
          : status === "done"
            ? '<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
            : '<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        row.innerHTML = mark + '<span class="tname">' + esc(name) + "</span>";
        row.setAttribute("title", name + " — " + status);
        scrollToBottom();
      },
      approval: function (a) {
        approvalsWrap.appendChild(approvalCard(a));
        scrollToBottom();
      },
      setUsage: function (u) {
        if (!u) return;
        var bits = [];
        if (u.model) bits.push(shortModel(u.model));
        var cost = num(firstNum(u.costUsd, u.cost));
        if (cost != null) bits.push("$" + cost.toFixed(4));
        var pt = num(u.promptTokens), ct = num(u.completionTokens);
        if (pt != null || ct != null) bits.push(count(pt || 0) + " in / " + count(ct || 0) + " out tokens");
        /* The provider ran something other than the pick. Say so on the line
           itself: the whole reason this is a bug worth reporting is that the
           only clue was a different name here, with nothing calling it out. */
        if (u.substituted && u.substituted.asked && u.substituted.ran) {
          bits.push("\u26a0 asked for " + shortModel(u.substituted.asked));
        }
        if (!bits.length) return;
        metaWrap.textContent = bits.join(" · ");
        if (u.contextPlan) {
          var cp = u.contextPlan;
          metaWrap.title = "Context plan — budget " + (cp.budgetTokens || cp.budget || "?") +
            " tokens, estimate " + (cp.estimateTokens || cp.estimate || "?") +
            (cp.dropped ? ", dropped: " + cp.dropped : "");
        }
        if (u.substituted && u.substituted.asked) {
          metaWrap.title = shortModel(u.substituted.asked) + " could not run this request, so " +
            shortModel(u.substituted.ran) + " answered instead. The usual cause is the OpenRouter key's " +
            "per-request token limit on a free-tier balance: add credits and the picked model runs.";
        }
        metaWrap.hidden = false;
      },
      note: function (msg) {
        metaWrap.textContent = msg;
        metaWrap.hidden = false;
      }
    };
  }

  /* ── approvals ──────────────────────────────────────────────────────── */

  function approvalCard(a) {
    var card = document.createElement("div");
    card.className = "approval";
    var risk = String(a.risk || "").toLowerCase();
    var riskClass = risk === "high" ? "high" : risk === "low" ? "low" : "medium";
    card.innerHTML =
      '<div class="ahead"><span class="atool">' + esc(a.tool || "tool") + "</span>" +
      (a.risk ? '<span class="risk ' + riskClass + '">' + esc(a.risk) + " risk</span>" : "") +
      "</div>" +
      '<div class="asum">' + esc(a.summary || "Harvey wants to run this. No summary was provided.") + "</div>" +
      '<div class="arow">' +
      '<button type="button" class="btn primary" data-approve>Approve</button>' +
      '<button type="button" class="btn danger" data-deny>Deny</button>' +
      '<span class="aout"></span>' +
      "</div>";

    var out = card.querySelector(".aout");
    var approveBtn = card.querySelector("[data-approve]");
    var denyBtn = card.querySelector("[data-deny]");

    if (!a.id) {
      approveBtn.disabled = true;
      denyBtn.disabled = true;
      approveBtn.title = denyBtn.title = "The server did not send an approval id, so this cannot be answered from here.";
      out.textContent = "no id — answer this from the server";
      return card;
    }

    function lock() { approveBtn.disabled = true; denyBtn.disabled = true; }

    approveBtn.addEventListener("click", async function () {
      lock();
      out.textContent = "approving…";
      var r = await api("/api/harvey/approvals/" + encodeURIComponent(a.id) + "/approve", { method: "POST" });
      if (r.status === 404) { out.textContent = "the approvals endpoint is not wired up yet (404)"; return; }
      if (!r.ok) { out.textContent = r.error || "approve failed"; approveBtn.disabled = false; denyBtn.disabled = false; return; }
      card.querySelector(".arow").innerHTML = '<span class="tag ok">Approved</span><span class="aout"></span>';
      var res = r.data && r.data.result;
      if (res) card.querySelector(".aout").textContent = typeof res === "string" ? res : JSON.stringify(res).slice(0, 220);
      loadPendingApprovals();
    });

    denyBtn.addEventListener("click", async function () {
      var reason = window.prompt("Why deny this? (optional — Harvey is told)", "");
      if (reason === null) return;
      lock();
      out.textContent = "denying…";
      var r = await api("/api/harvey/approvals/" + encodeURIComponent(a.id) + "/deny", { method: "POST", body: { reason: reason } });
      if (r.status === 404) { out.textContent = "the approvals endpoint is not wired up yet (404)"; return; }
      if (!r.ok) { out.textContent = r.error || "deny failed"; approveBtn.disabled = false; denyBtn.disabled = false; return; }
      card.querySelector(".arow").innerHTML = '<span class="tag bad">Denied</span>';
      loadPendingApprovals();
    });

    return card;
  }

  var pendingWrap = null;
  async function loadPendingApprovals() {
    var r = await api("/api/harvey/approvals");
    if (!pendingWrap) return;
    if (r.status === 404 || !r.ok || !r.data) { pendingWrap.innerHTML = ""; return; }
    var pending = r.data.pending || [];
    if (!pending.length) { pendingWrap.innerHTML = ""; return; }
    pendingWrap.innerHTML = '<div class="side-label" style="padding-left:0">Waiting for your approval</div>';
    pending.forEach(function (a) { pendingWrap.appendChild(approvalCard(a)); });
  }

  /* ── sending ────────────────────────────────────────────────────────── */

  function setBusy(v) {
    state.busy = v;
    var btn = $("sendBtn");
    btn.classList.toggle("stop", v);
    if (v) {
      btn.disabled = false;
      btn.setAttribute("aria-label", "Stop generating");
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
    } else {
      btn.disabled = $("input").value.trim() === "";
      btn.setAttribute("aria-label", "Send message");
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    }
  }

  async function send(text) {
    text = String(text || "").trim();
    if (!text || state.busy) return;
    showView("chat");
    var emptyEl = thread.querySelector(".empty");
    if (emptyEl) emptyEl.remove();

    addUserMessage(text);
    $("input").value = "";
    autosize();
    setBusy(true);

    var ui = addAssistantMessage();
    state.abort = new AbortController();

    try {
      if (state.legacyMode) await legacyChat(text, ui);
      else await harveyChat(text, ui);
    } catch (e) {
      if (e && e.name === "AbortError") ui.note("Stopped.");
      else ui.error(e && e.message ? e.message : "Something went wrong.");
    } finally {
      state.abort = null;
      setBusy(false);
      ui.finish();
      $("input").focus();
    }

    if (state.convsWired === false) {
      if (!state.conversationId) state.conversationId = "local_" + Date.now().toString(36);
      localConvAppend(state.conversationId, { role: "user", content: text, at: new Date().toISOString() });
      localConvAppend(state.conversationId, { role: "assistant", content: ui.text, at: new Date().toISOString() });
      state.conversations = readLocalConvs();
      paintConversations();
    } else {
      loadConversations();
    }
    loadPendingApprovals();
    if (state.modelsWired) loadModels();
  }

  async function harveyChat(text, ui) {
    var body = {
      message: text,
      sessionId: state.sessionId,
      stream: true
    };
    if (state.conversationId) body.conversationId = state.conversationId;
    if (state.selectedModel && state.selectedModel !== "auto") body.model = state.selectedModel;

    var res;
    try {
      res = await fetch(apiUrl("/api/harvey/chat"), {
        method: "POST",
        credentials: "same-origin",
        headers: authHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
        body: JSON.stringify(body),
        signal: state.abort ? state.abort.signal : undefined
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new Error("Could not reach the server.");
    }

    if (res.status === 404) {
      /* The model layer isn't deployed yet. Fall back to the endpoint that is
         actually there, and say so instead of pretending. */
      state.legacyMode = true;
      showLegacyBanner();
      paintModelPill();
      return legacyChat(text, ui);
    }
    if (res.status === 401) { showAuthBanner(); throw new Error("Not signed in — sign in again to keep talking to Harvey."); }
    if (!res.ok) {
      var errText = await res.text().catch(function () { return ""; });
      var errJson = null;
      try { errJson = JSON.parse(errText); } catch (_) {}
      throw new Error((errJson && (errJson.error || errJson.message)) || ("Harvey refused that (" + res.status + ")."));
    }

    var ct = String(res.headers.get("content-type") || "");
    if (ct.indexOf("text/event-stream") < 0 || !res.body || !res.body.getReader) {
      /* Asked for a stream, got JSON (or a browser with no streaming body).
         The non-stream shape is part of the same contract. */
      var raw = await res.text().catch(function () { return ""; });
      var data = null;
      try { data = JSON.parse(raw); } catch (_) {}
      if (!data) throw new Error("Harvey sent a reply this page could not read.");
      applyNonStream(data, ui);
      return;
    }

    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      var idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        handleSseBlock(buf.slice(0, idx), ui);
        buf = buf.slice(idx + 2);
      }
    }
    if (buf.trim()) handleSseBlock(buf, ui);
  }

  function handleSseBlock(block, ui) {
    var name = "";
    var dataLines = [];
    block.split("\n").forEach(function (line) {
      if (/^event:/.test(line)) name = line.slice(6).trim();
      else if (/^data:/.test(line)) dataLines.push(line.slice(5).replace(/^ /, ""));
    });
    if (!dataLines.length && !name) return;
    var raw = dataLines.join("\n");
    if (raw === "[DONE]") return;
    var d = null;
    try { d = raw ? JSON.parse(raw) : {}; } catch (_) { d = { text: raw }; }
    if (!name && d && d.type) name = String(d.type);

    switch (name) {
      case "token":
        ui.append(d.text != null ? d.text : (d.delta || ""));
        break;
      case "tool":
        ui.tool(d);
        break;
      case "approval":
        ui.approval(d);
        break;
      case "usage":
        ui.setUsage(d);
        break;
      case "done":
        if (d.sessionId) state.sessionId = d.sessionId;
        if (d.conversationId) state.conversationId = d.conversationId;
        if (d.text && !ui.text) ui.setText(d.text);
        try { sessionStorage.setItem("harvey_session_id", state.sessionId); } catch (_) {}
        break;
      case "error":
        ui.error(d.message || d.error || "Harvey hit an error.");
        break;
      default:
        /* An unnamed data-only frame is treated as a token — that is the one
           safe reading; anything else would be inventing meaning. */
        if (!name && d && typeof d.text === "string") ui.append(d.text);
        break;
    }
  }

  function applyNonStream(data, ui) {
    if (data.sessionId) state.sessionId = data.sessionId;
    if (data.conversationId) state.conversationId = data.conversationId;
    (data.approvals || []).forEach(function (a) { ui.approval(a); });
    ui.setText(data.text || data.speech || data.reply || "");
    if (data.usage) ui.setUsage(Object.assign({}, data.usage, { contextPlan: data.contextPlan }));
  }

  /** The endpoint that exists today. No models, no cost, no approval events. */
  async function legacyChat(text, ui) {
    var res;
    try {
      res = await fetch(apiUrl("/api/jarvis/chat"), {
        method: "POST",
        credentials: "same-origin",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ message: text, sessionId: state.sessionId, full: true }),
        signal: state.abort ? state.abort.signal : undefined
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new Error("Could not reach the server.");
    }
    if (res.status === 401) { showAuthBanner(); throw new Error("Not signed in — sign in again to keep talking to Harvey."); }
    var data = await res.json().catch(function () { return null; });
    if (!res.ok || !data) throw new Error((data && data.error) || ("The legacy chat endpoint failed (" + res.status + ")."));
    ui.setText(data.speech || data.reply || data.text || data.message || "");
    ui.note("legacy endpoint · no model or cost reported");
  }

  function newChat() {
    if (state.abort) { try { state.abort.abort(); } catch (_) {} }
    state.conversationId = null;
    state.sessionId = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem("harvey_session_id", state.sessionId); } catch (_) {}
    showView("chat");
    showEmptyState();
    paintConversations();
    $("input").focus();
  }

  /* ── views ──────────────────────────────────────────────────────────── */

  var VIEW_TITLES = { chat: "Harvey", scheduled: "Scheduled", usage: "Usage", models: "Explore models" };

  function showView(view) {
    state.view = view;
    ["chat", "scheduled", "usage", "models"].forEach(function (v) {
      $("view-" + v).hidden = v !== view;
    });
    $("viewTitle").textContent = VIEW_TITLES[view] || "Harvey";
    document.querySelectorAll(".nav-item[data-view]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === view);
    });
    if (window.innerWidth <= 860) closeSidebarOverlay();
    if (view === "scheduled") loadTasks();
    if (view === "usage") loadUsage();
    if (view === "models") renderModelsView();
  }

  /* ── scheduled tasks ────────────────────────────────────────────────── */

  var DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  /** Best-effort plain English for the common shapes; the raw cron is always
      shown next to it, so a wrong guess can never hide the real schedule. */
  function cronText(cron) {
    if (!cron) return "";
    var p = String(cron).trim().split(/\s+/);
    if (p.length < 5) return "";
    var m = p[0], h = p[1], dom = p[2], mon = p[3], dow = p[4];
    if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return "";
    var time = new Date(2000, 0, 1, parseInt(h, 10), parseInt(m, 10))
      .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (dom === "*" && mon === "*" && dow === "*") return "every day at " + time;
    if (dom === "*" && mon === "*" && dow === "1-5") return "every weekday at " + time;
    if (dom === "*" && mon === "*" && /^\d$/.test(dow)) return "every " + DOW[parseInt(dow, 10) % 7] + " at " + time;
    if (mon === "*" && dow === "*" && /^\d+$/.test(dom)) return "day " + dom + " of every month at " + time;
    return "";
  }

  function looksLikeCron(s) {
    var p = String(s || "").trim().split(/\s+/);
    if (p.length !== 5) return false;
    return p.every(function (f) { return /^[\d*\/,\-]+$/.test(f); });
  }

  async function loadTasks() {
    var sub = $("tasksSub");
    var list = $("taskList");
    var r = await api("/api/harvey/tasks");
    if (r.status === 404) {
      state.tasksWired = false;
      sub.textContent = "";
      list.innerHTML = '<div class="empty-note">Scheduled tasks are not wired up on the server yet — <code>GET /api/harvey/tasks</code> returned 404. Nothing is running on a clock.</div>';
      setTaskFormEnabled(false, "The server has no /api/harvey/tasks endpoint yet, so this form has nowhere to save to.");
      $("navTaskCount").textContent = "";
      return;
    }
    if (!r.ok || !r.data) {
      sub.textContent = "";
      list.innerHTML = '<div class="empty-note">' + esc(r.error || "Could not load tasks.") + "</div>";
      return;
    }
    state.tasksWired = true;
    setTaskFormEnabled(true, "");
    var tasks = r.data.tasks || [];
    $("navTaskCount").textContent = tasks.length ? String(tasks.length) : "";
    sub.textContent = tasks.length === 1 ? "1 task" : tasks.length + " tasks";
    if (!tasks.length) {
      list.innerHTML = '<div class="empty-note">No scheduled tasks yet.</div>';
      return;
    }
    list.innerHTML = tasks.map(taskRowHtml).join("");
  }

  function taskRowHtml(t) {
    var enabled = t.enabled !== false;
    var human = cronText(t.cron);
    var meta = [];
    if (human) meta.push(human);
    if (t.cron) meta.push(t.cron);
    if (t.timezone) meta.push(t.timezone);
    var next = t.nextRunAt ? "next " + dateText(t.nextRunAt) : "no next run reported";
    var last = t.lastRunAt
      ? "last " + dateText(t.lastRunAt) + (t.lastStatus ? " · " + t.lastStatus : "")
      : "never run";
    var statusTag = t.lastStatus
      ? '<span class="tag ' + (/ok|success|done/i.test(t.lastStatus) ? "ok" : /fail|error/i.test(t.lastStatus) ? "bad" : "") + '">' + esc(t.lastStatus) + "</span>"
      : "";
    return '<div class="task-row" data-task="' + esc(t.id) + '">' +
      '<div class="task-main">' +
      '<div class="t">' + esc(t.title || "Untitled task") + (enabled ? "" : ' <span class="tag off">paused</span>') + "</div>" +
      '<div class="m">' + esc(meta.join(" · ")) + "</div>" +
      '<div class="m">' + esc(next) + " · " + esc(last) + "</div>" +
      (t.prompt ? '<div class="p">' + esc(t.prompt) + "</div>" : "") +
      "</div>" +
      '<div class="task-acts">' + statusTag +
      '<button type="button" class="switch" role="switch" aria-checked="' + (enabled ? "true" : "false") +
      '" data-toggle="' + esc(t.id) + '" aria-label="' + (enabled ? "Pause" : "Enable") + ' this task"></button>' +
      '<button type="button" class="btn sm" data-run="' + esc(t.id) + '">Run now</button>' +
      '<button type="button" class="btn sm danger" data-deltask="' + esc(t.id) + '">Delete</button>' +
      "</div></div>";
  }

  function setTaskFormEnabled(on, why) {
    ["tfTitle", "tfPrompt", "tfWhen", "taskFormSave"].forEach(function (id) {
      var el = $(id);
      el.disabled = !on;
      el.title = on ? "" : why;
    });
    $("taskFormMsg").textContent = on ? "" : why;
  }

  async function taskPatch(id, patch) {
    var r = await api("/api/harvey/tasks/" + encodeURIComponent(id), { method: "PATCH", body: patch });
    if (!r.ok) { toast(r.error || "Could not update that task."); return false; }
    loadTasks();
    return true;
  }

  /* ── usage ──────────────────────────────────────────────────────────── */

  async function loadUsage() {
    var body = $("usageBody");
    var r = await api("/api/harvey/usage?days=30");
    if (r.status === 404) {
      state.usageWired = false;
      body.innerHTML = '<div class="panel"><h2>Not wired up yet</h2><div class="sub">' +
        '<code>GET /api/harvey/usage</code> returned 404, so there is no spend to show. ' +
        "Nothing here is estimated — this page only ever shows what the server measured.</div></div>";
      return;
    }
    if (!r.ok || !r.data) {
      body.innerHTML = '<div class="panel"><div class="empty-note">' + esc(r.error || "Could not load usage.") + "</div></div>";
      return;
    }
    state.usageWired = true;
    var d = r.data;
    var caps = d.caps || (state.budget || {});
    var dailyCap = firstNum(caps.dailyCapUsd, d.dailyCapUsd, state.budget && state.budget.dailyCapUsd);
    var monthlyCap = firstNum(caps.monthlyCapUsd, d.monthlyCapUsd, state.budget && state.budget.monthlyCapUsd);
    var todayCost = firstNum(d.today && (d.today.costUsd != null ? d.today.costUsd : d.today.cost), state.budget && state.budget.spentTodayUsd);
    var monthCost = firstNum(d.month && (d.month.costUsd != null ? d.month.costUsd : d.month.cost), state.budget && state.budget.spentMonthUsd);

    var html = "";
    html += '<div class="grid-2">' +
      spendCard("Today", todayCost, dailyCap, d.today) +
      spendCard("This month", monthCost, monthlyCap, d.month) +
      "</div>";

    html += '<div class="panel"><h2>Daily spend</h2><div class="sub">Measured cost per day, most recent on the right.</div>' +
      dailyBars(d.daily || []) + "</div>";

    html += '<div class="panel"><h2>By model</h2>' + simpleTable(
      ["Model", "Calls", "Tokens", "Cost"],
      (d.byModel || []).map(function (row) {
        return [shortModel(row.model), count(row.calls), count(row.tokens), costText(firstNum(row.costUsd, row.cost))];
      }),
      "No model usage recorded yet."
    ) + "</div>";

    html += '<div class="panel"><h2>By job</h2>' + simpleTable(
      ["Job", "Calls", "Cost"],
      (d.byJob || []).map(function (row) { return [row.job, count(row.calls), costText(firstNum(row.costUsd, row.cost))]; }),
      "No job usage recorded yet."
    ) + "</div>";

    var errs = d.recentErrors || [];
    html += '<div class="panel"><h2>Recent errors</h2>' + (errs.length
      ? '<table class="data"><thead><tr><th>When</th><th>Model</th><th>Job</th><th>Error</th></tr></thead><tbody>' +
        errs.map(function (e) {
          return "<tr><td>" + esc(dateText(e.at)) + "</td><td>" + esc(shortModel(e.model)) + "</td><td>" +
            esc(e.job || "") + '</td><td>' + esc(e.error || "") + "</td></tr>";
        }).join("") + "</tbody></table>"
      : '<div class="empty-note">No errors recorded.</div>') + "</div>";

    html += '<div class="panel"><h2>Spend caps</h2><div class="sub">Enforced before the call is made, so an over-cap request is refused rather than billed.</div>' +
      '<form id="capsForm" class="inline-form">' +
      '<div class="field"><label for="capDaily">Daily cap (USD)</label><input id="capDaily" type="number" step="0.01" min="0" value="' +
      (dailyCap == null ? "" : esc(dailyCap)) + '" /></div>' +
      '<div class="field"><label for="capMonthly">Monthly cap (USD)</label><input id="capMonthly" type="number" step="0.01" min="0" value="' +
      (monthlyCap == null ? "" : esc(monthlyCap)) + '" /></div>' +
      '<button type="submit" class="btn primary">Save caps</button>' +
      "</form></div>";

    body.innerHTML = html;

    var capsForm = $("capsForm");
    if (capsForm) {
      capsForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        var payload = {};
        var dv = parseFloat($("capDaily").value); if (isFinite(dv)) payload.dailyCapUsd = dv;
        var mv = parseFloat($("capMonthly").value); if (isFinite(mv)) payload.monthlyCapUsd = mv;
        var res = await api("/api/harvey/usage/caps", { method: "POST", body: payload });
        if (res.status === 404) { toast("The caps endpoint is not wired up yet."); return; }
        if (!res.ok) { toast(res.error || "Could not save the caps."); return; }
        toast("Caps saved.");
        loadModels();
        loadUsage();
      });
    }
  }

  function spendCard(label, cost, cap, detail) {
    var pct = (cost != null && cap) ? Math.min(100, (cost / cap) * 100) : null;
    var cls = pct == null ? "" : pct >= 100 ? "over" : pct >= 80 ? "near" : "";
    var calls = detail ? num(detail.calls) : null;
    return '<div class="panel"><div class="sub" style="margin:0 0 6px">' + esc(label) + "</div>" +
      '<div class="stat">' + (cost == null ? "—" : money(cost, cost < 1 ? 4 : 2)) +
      (cap ? "<small>of " + esc(money(cap)) + " cap</small>" : "<small>no cap reported</small>") + "</div>" +
      (pct == null ? "" : '<div class="meter ' + cls + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>') +
      (calls == null ? "" : '<div class="sub" style="margin:10px 0 0">' + calls + (calls === 1 ? " call" : " calls") + "</div>") +
      "</div>";
  }

  function dailyBars(daily) {
    if (!daily.length) return '<div class="empty-note">No usage recorded yet.</div>';
    var max = 0;
    daily.forEach(function (d) { var c = firstNum(d.costUsd, d.cost) || 0; if (c > max) max = c; });
    var bars = daily.map(function (d) {
      var c = firstNum(d.costUsd, d.cost) || 0;
      var h = max > 0 ? Math.max(2, (c / max) * 100) : 2;
      return '<div class="bar' + (c ? "" : " zero") + '" style="height:' + h.toFixed(1) +
        '%" title="' + esc(d.date + " · " + money(c, 4) + (d.calls != null ? " · " + d.calls + " calls" : "")) + '"></div>';
    }).join("");
    return '<div class="bars">' + bars + "</div>" +
      '<div class="axis"><span>' + esc(daily[0].date || "") + "</span><span>peak " + esc(money(max, 4)) +
      "</span><span>" + esc(daily[daily.length - 1].date || "") + "</span></div>";
  }

  function simpleTable(headers, rows, emptyMsg) {
    if (!rows.length) return '<div class="empty-note">' + esc(emptyMsg) + "</div>";
    return '<table class="data"><thead><tr>' +
      headers.map(function (h, i) { return '<th class="' + (i ? "num" : "") + '">' + esc(h) + "</th>"; }).join("") +
      "</tr></thead><tbody>" +
      rows.map(function (r) {
        return "<tr>" + r.map(function (c, i) {
          return '<td class="' + (i ? "num" : "") + '">' + esc(c == null ? "—" : c) + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table>";
  }

  /* ── models view ────────────────────────────────────────────────────── */

  var JOB_NOTES = {
    chat_fast: "pleasantries, one-liners, no tools",
    chat_deep: "normal operator chat with tools",
    agent: "background jobs and cron tasks",
    summarize: "conversation folding",
    extract: "memory extraction",
    classify: "short routing decisions",
    vision: "anything with an image",
    schedule: "sentence → cron"
  };

  async function renderModelsView() {
    var body = $("modelsBody");
    if (state.modelsWired === null) await loadModels();
    if (state.modelsWired === false) {
      body.innerHTML = '<div class="panel"><h2>Not wired up yet</h2><div class="sub">' +
        '<code>GET /api/harvey/models</code> returned 404. Until the server exposes the catalog, ' +
        'the composer can only offer <b>Auto</b> — there is no honest list to choose from.</div></div>';
      return;
    }

    var html = "";
    var p = state.provider || {};
    html += '<div class="panel"><h2>Providers</h2><div class="sub">Keys live only as server secrets. This page never sees one.</div>' +
      '<table class="data"><tbody>' +
      "<tr><td>OpenRouter</td><td>" + (p.openrouter ? "configured" : "not configured") + "</td></tr>" +
      "<tr><td>Anthropic (direct)</td><td>" + (p.anthropic ? "configured" : "not configured") + "</td></tr>" +
      "<tr><td>Primary</td><td>" + esc(p.primary || "none — Harvey cannot reach a model") + "</td></tr>" +
      "</tbody></table></div>";

    var routing = state.routing || {};
    var jobs = Object.keys(routing);
    html += '<div class="panel"><h2>Job routing</h2><div class="sub">Which model each kind of work goes to. An override here is stored on the server.</div>';
    if (!jobs.length) {
      html += '<div class="empty-note">The server reported no routing table.</div>';
    } else {
      html += '<table class="data"><thead><tr><th>Job</th><th>Model</th><th>Fallbacks</th><th>Source</th><th></th></tr></thead><tbody>' +
        jobs.map(function (job) {
          var r = routing[job] || {};
          var opts = state.models.map(function (m) {
            return '<option value="' + esc(m.id) + '"' + (m.id === r.model ? " selected" : "") + ">" + esc(m.label) + "</option>";
          }).join("");
          return "<tr><td><b>" + esc(job) + "</b>" + (JOB_NOTES[job] ? '<div class="sub" style="margin:2px 0 0">' + esc(JOB_NOTES[job]) + "</div>" : "") + "</td>" +
            '<td><select data-route-job="' + esc(job) + '" aria-label="Model for ' + esc(job) + '">' +
            '<option value="">— pick a model —</option>' + opts + "</select></td>" +
            "<td>" + esc((r.fallbacks || []).map(shortModel).join(", ") || "none") + "</td>" +
            "<td>" + esc(r.source || "") + "</td>" +
            '<td class="num"><button type="button" class="btn sm" data-route-reset="' + esc(job) + '">Reset</button></td></tr>';
        }).join("") + "</tbody></table>";
    }
    html += "</div>";

    html += '<div class="panel"><h2>Catalog</h2><div class="sub">' +
      (state.models.length ? state.models.length + " models the configured keys can reach." : "") + "</div>" +
      (state.models.length
        ? '<table class="data"><thead><tr><th>Model</th><th>Family</th><th>Tier</th><th class="num">Context</th><th class="num">$/1M in</th><th class="num">$/1M out</th></tr></thead><tbody>' +
          state.models.map(function (m) {
            return "<tr><td><b>" + esc(m.label) + '</b><div class="sub" style="margin:2px 0 0">' + esc(m.id) + "</div></td>" +
              "<td>" + esc(m.family) + "</td><td>" + esc(m.tier || "—") + "</td>" +
              '<td class="num">' + (m.context == null ? "—" : m.context.toLocaleString()) + "</td>" +
              '<td class="num">' + (m.inPerM == null ? "—" : "$" + m.inPerM.toFixed(2)) + "</td>" +
              '<td class="num">' + (m.outPerM == null ? "—" : "$" + m.outPerM.toFixed(2)) + "</td></tr>";
          }).join("") + "</tbody></table>"
        : '<div class="empty-note">The server returned an empty catalog.</div>') +
      "</div>";

    body.innerHTML = html;
  }

  /* ── composer behaviour ─────────────────────────────────────────────── */

  function autosize() {
    var input = $("input");
    input.style.height = "auto";
    input.style.height = Math.min(200, input.scrollHeight) + "px";
  }

  function closeSidebarOverlay() {
    $("app").classList.remove("side-open");
    $("scrim").classList.remove("on");
  }
  function toggleSidebar() {
    var app = $("app");
    if (window.innerWidth <= 860) {
      var on = app.classList.toggle("side-open");
      $("scrim").classList.toggle("on", on);
    } else {
      app.classList.toggle("side-hidden");
    }
  }

  /* ── dictation (real, when the browser has it) ──────────────────────── */

  /** Set by wireMic so voice mode can take the microphone back cleanly. */
  var stopDictation = function () {};

  function wireMic() {
    var btn = $("micBtn");
    var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) {
      btn.disabled = true;
      btn.title = "Dictation needs a browser with speech recognition (Chrome or Edge). Typing still works.";
      return;
    }
    var rec = new Rec();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";
    var base = "";
    var live = false;

    rec.onresult = function (e) {
      var out = "";
      for (var i = e.resultIndex; i < e.results.length; i++) out += e.results[i][0].transcript;
      $("input").value = (base ? base + " " : "") + out;
      autosize();
      $("sendBtn").disabled = $("input").value.trim() === "";
    };
    rec.onend = function () { live = false; btn.classList.remove("rec"); btn.title = "Dictate a message"; };
    rec.onerror = function (e) {
      live = false; btn.classList.remove("rec");
      toast(e && e.error === "not-allowed" ? "Microphone access was blocked." : "Dictation stopped.");
    };

    btn.addEventListener("click", function () {
      if (live) { try { rec.stop(); } catch (_) {} return; }
      base = $("input").value.trim();
      try { rec.start(); live = true; btn.classList.add("rec"); btn.title = "Stop dictating"; }
      catch (_) { toast("Dictation could not start."); }
    });

    stopDictation = function () { if (live) { try { rec.stop(); } catch (_) {} } };
  }

  /* ── voice mode ─────────────────────────────────────────────────────────
     Talking to Harvey out loud is the orb screen at /operator, opened over this
     page in an iframe. That screen already owns the whole spoken pipeline — mic
     capture, STT, Harvey's brain, streaming TTS — and a second implementation
     here would be two things competing for one microphone. So this is a door
     onto the working one, not a copy of it.

     The iframe carries no src until it is opened and is navigated to
     about:blank on close: that is what actually releases the microphone and
     cuts off a reply that is still being spoken. Closing also hands focus back
     to the composer. */

  var voiceReturnFocus = null;

  function voiceModeIsOpen() {
    var overlay = $("voiceOverlay");
    return !!overlay && !overlay.hidden;
  }

  function openVoiceMode() {
    var overlay = $("voiceOverlay"), frame = $("voiceFrame");
    if (!overlay || !frame || voiceModeIsOpen()) return;
    stopDictation();
    closePop();
    voiceReturnFocus = document.activeElement;
    frame.src = apiUrl("/operator");
    overlay.hidden = false;
    $("voiceClose").focus();
  }

  function closeVoiceMode() {
    var overlay = $("voiceOverlay"), frame = $("voiceFrame");
    if (!voiceModeIsOpen()) return;
    overlay.hidden = true;
    frame.src = "about:blank";
    frame.removeAttribute("src");
    var back = voiceReturnFocus;
    voiceReturnFocus = null;
    if (state.view !== "chat") showView("chat");
    if (back && back !== document.body && typeof back.focus === "function") back.focus();
    else $("input").focus();
  }

  function wireVoiceMode() {
    var btn = $("voiceBtn"), overlay = $("voiceOverlay"), frame = $("voiceFrame");
    if (!btn || !overlay || !frame) return;
    btn.addEventListener("click", openVoiceMode);
    $("voiceFullPage").href = apiUrl("/operator");
    overlay.addEventListener("click", function (e) {
      if (e.target.closest("[data-voice-close]")) closeVoiceMode();
    });

    /* /operator is same-origin, so Esc can be honoured while focus is inside it
       — without this, Esc stops working the moment the orb is clicked. */
    frame.addEventListener("load", function () {
      try {
        frame.contentDocument.addEventListener("keydown", function (e) {
          if (e.key === "Escape") closeVoiceMode();
        });
      } catch (_) { /* nothing to do: the close button is always visible */ }
    });

    /* Voice can navigate the app ("open the CRM"), and from in here the orb's
       postMessage lands on this page instead of the shell. Pass it along and
       step out of the way, or the spoken command appears to be ignored. */
    window.addEventListener("message", function (e) {
      var d = e.data || {};
      if (!d || d.type !== "app-navigate" || !d.tab) return;
      if (frame.contentWindow && e.source !== frame.contentWindow) return;
      closeVoiceMode();
      if (window.parent !== window) window.parent.postMessage({ type: "app-navigate", tab: String(d.tab) }, "*");
    });
  }

  /* ── the + menu ─────────────────────────────────────────────────────── */

  function buildPlusMenu() {
    $("plusMenu").innerHTML =
      '<button type="button" class="pop-item" role="menuitem" data-plus="file">' +
      '<span class="pi-main"><span class="pi-label">Add a text file</span>' +
      '<span class="pi-sub">its contents are pasted into this message</span></span></button>' +
      '<button type="button" class="pop-item" role="menuitem" data-plus="schedule">' +
      '<span class="pi-main"><span class="pi-label">Schedule this instead</span>' +
      '<span class="pi-sub">opens Scheduled with this text as the prompt</span></span></button>';
  }

  function pickTextFile() {
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".txt,.md,.csv,.json,.log,text/*";
    inp.addEventListener("change", function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        var box = $("input");
        var body = String(r.result || "");
        box.value = (box.value ? box.value + "\n\n" : "") + "```\n" + body.slice(0, 20000) + "\n```";
        autosize();
        $("sendBtn").disabled = box.value.trim() === "";
        box.focus();
        if (body.length > 20000) toast("File was long — the first 20,000 characters were added.");
      };
      r.readAsText(f);
    });
    inp.click();
  }

  /* ── settings popover ───────────────────────────────────────────────── */

  var settingsPop = null;
  function openSettings(anchor) {
    if (!settingsPop) {
      settingsPop = document.createElement("div");
      settingsPop.className = "popover";
      settingsPop.setAttribute("role", "menu");
      settingsPop.setAttribute("aria-label", "Settings");
      settingsPop.hidden = true;
      document.body.appendChild(settingsPop);
    }
    settingsPop.innerHTML =
      '<div class="pop-group">Appearance</div>' +
      '<button type="button" class="pop-item" data-set="theme"><span class="pi-main"><span class="pi-label">' +
      (currentTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme") + "</span></span></button>" +
      '<div class="pop-group">Harvey</div>' +
      '<button type="button" class="pop-item" data-set="usage"><span class="pi-main"><span class="pi-label">Usage &amp; spend caps</span></span></button>' +
      '<button type="button" class="pop-item" data-set="models"><span class="pi-main"><span class="pi-label">Models &amp; routing</span></span></button>' +
      '<div class="pop-sep"></div>' +
      '<div class="pop-note">' + (state.legacyMode
        ? "Chat is running on the legacy endpoint — the model layer is not deployed."
        : state.modelsWired === false
          ? "The model layer endpoints are not on this server yet."
          : "Model layer: " + esc((state.provider && state.provider.primary) || "no provider key")) + "</div>";
    togglePop(settingsPop, anchor, "left");
  }

  /* ── identity ───────────────────────────────────────────────────────── */

  async function paintIdentity() {
    var id = "";
    try { id = window.TeamSession ? TeamSession.currentUser() : ""; } catch (_) {}
    var nameEl = $("userName"), avEl = $("userAv");
    if (!id) {
      nameEl.textContent = "Not signed in";
      avEl.textContent = "?";
      return;
    }
    nameEl.textContent = id.charAt(0).toUpperCase() + id.slice(1);
    avEl.textContent = id.charAt(0).toUpperCase();
    var r = await api("/api/team/roster");
    if (!r.ok || !r.data || !r.data.members) return;
    r.data.members.forEach(function (m) {
      if (m.id !== id) return;
      nameEl.textContent = m.name + (m.role ? " · " + m.role : "");
      avEl.textContent = String(m.name || "?").charAt(0);
      if (m.color) avEl.style.background = m.color, avEl.style.color = "#fff";
    });
  }

  /* ── wiring ─────────────────────────────────────────────────────────── */

  function init() {
    thread = $("thread");
    threadScroll = $("threadScroll");

    pendingWrap = document.createElement("div");
    pendingWrap.id = "pendingApprovals";
    thread.appendChild(pendingWrap);

    setTheme(currentTheme());
    buildPlusMenu();
    buildModelMenu();
    paintModelPill();
    showEmptyState();
    wireMic();
    wireVoiceMode();
    paintIdentity();

    /* sidebar */
    document.querySelectorAll(".nav-item[data-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var v = btn.getAttribute("data-view");
        if (v === "chat") newChat(); else showView(v);
      });
    });
    $("newChatIcon").addEventListener("click", newChat);
    $("sidebarToggle").addEventListener("click", toggleSidebar);
    $("scrim").addEventListener("click", closeSidebarOverlay);
    $("themeBtn").addEventListener("click", function () { setTheme(currentTheme() === "dark" ? "light" : "dark"); });
    $("settingsBtn").addEventListener("click", function () { openSettings($("settingsBtn")); });
    $("userChip").addEventListener("click", function () {
      if (window.TeamSession) window.top.location.href = TeamSession.signInUrl("/shell");
    });

    $("searchToggle").addEventListener("click", function () {
      var wrap = $("searchWrap");
      wrap.hidden = !wrap.hidden;
      if (!wrap.hidden) $("searchInput").focus();
      else { state.convFilter = ""; $("searchInput").value = ""; paintConversations(); }
    });
    $("searchInput").addEventListener("input", function () {
      state.convFilter = $("searchInput").value;
      paintConversations();
    });

    $("convList").addEventListener("click", function (e) {
      var ren = e.target.closest("[data-rename]");
      if (ren) { renameConversation(ren.getAttribute("data-rename")); return; }
      var del = e.target.closest("[data-delete]");
      if (del) { deleteConversation(del.getAttribute("data-delete")); return; }
      var row = e.target.closest("[data-conv]");
      if (row) openConversation(row.getAttribute("data-conv"));
    });

    /* composer */
    var input = $("input");
    input.addEventListener("input", function () {
      autosize();
      if (!state.busy) $("sendBtn").disabled = input.value.trim() === "";
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); }
    });
    $("composer").addEventListener("submit", function (e) {
      e.preventDefault();
      if (state.busy) { if (state.abort) { try { state.abort.abort(); } catch (_) {} } return; }
      send(input.value);
    });

    $("modelPill").addEventListener("click", function () {
      buildModelMenu();
      togglePop($("modelMenu"), $("modelPill"), "right");
    });
    $("modelMenu").addEventListener("click", function (e) {
      var item = e.target.closest("[data-model]");
      if (!item) return;
      selectModel(item.getAttribute("data-model"));
      closePop();
    });

    $("plusBtn").addEventListener("click", function () { togglePop($("plusMenu"), $("plusBtn"), "left"); });
    $("plusMenu").addEventListener("click", function (e) {
      var item = e.target.closest("[data-plus]");
      if (!item) return;
      closePop();
      if (item.getAttribute("data-plus") === "file") { pickTextFile(); return; }
      var text = $("input").value.trim();
      showView("scheduled");
      if (text) { $("tfPrompt").value = text; $("tfTitle").focus(); }
    });

    document.addEventListener("click", function (e) {
      var item = e.target.closest ? e.target.closest("[data-set]") : null;
      if (!item) return;
      var what = item.getAttribute("data-set");
      closePop();
      if (what === "theme") setTheme(currentTheme() === "dark" ? "light" : "dark");
      if (what === "usage") showView("usage");
      if (what === "models") showView("models");
    });

    /* scheduled view */
    $("taskList").addEventListener("click", async function (e) {
      var tog = e.target.closest("[data-toggle]");
      if (tog) {
        var on = tog.getAttribute("aria-checked") === "true";
        tog.setAttribute("aria-checked", on ? "false" : "true");
        var okd = await taskPatch(tog.getAttribute("data-toggle"), { enabled: !on });
        if (!okd) tog.setAttribute("aria-checked", on ? "true" : "false");
        return;
      }
      var run = e.target.closest("[data-run]");
      if (run) {
        run.disabled = true;
        run.textContent = "Running…";
        var rr = await api("/api/harvey/tasks/" + encodeURIComponent(run.getAttribute("data-run")) + "/run", { method: "POST" });
        run.disabled = false;
        run.textContent = "Run now";
        toast(rr.ok ? "Started. The result lands on the task when it finishes." : (rr.error || "Could not start that run."));
        if (rr.ok) setTimeout(loadTasks, 1500);
        return;
      }
      var del = e.target.closest("[data-deltask]");
      if (del) {
        if (!window.confirm("Delete this scheduled task?")) return;
        var dr = await api("/api/harvey/tasks/" + encodeURIComponent(del.getAttribute("data-deltask")), { method: "DELETE" });
        if (!dr.ok) { toast(dr.error || "Could not delete that task."); return; }
        loadTasks();
      }
    });

    $("taskForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var title = $("tfTitle").value.trim();
      var prompt = $("tfPrompt").value.trim();
      var when = $("tfWhen").value.trim();
      if (!title || !prompt || !when) return;
      var payload = { title: title, prompt: prompt };
      if (looksLikeCron(when)) payload.cron = when; else payload.when = when;
      $("taskFormSave").disabled = true;
      var r = await api("/api/harvey/tasks", { method: "POST", body: payload });
      $("taskFormSave").disabled = false;
      if (r.status === 404) { toast("The tasks endpoint is not wired up yet."); return; }
      if (!r.ok) { $("taskFormMsg").textContent = r.error || "Could not create that task."; return; }
      $("taskFormMsg").textContent = "";
      $("tfTitle").value = ""; $("tfPrompt").value = ""; $("tfWhen").value = "";
      loadTasks();
      toast("Task created.");
    });

    /* models view: routing overrides */
    $("modelsBody").addEventListener("change", async function (e) {
      var sel = e.target.closest("[data-route-job]");
      if (!sel || !sel.value) return;
      var r = await api("/api/harvey/models/route", { method: "POST", body: { job: sel.getAttribute("data-route-job"), model: sel.value } });
      if (!r.ok) { toast(r.error || "Could not set that route."); return; }
      if (r.data && r.data.routing) state.routing = r.data.routing;
      toast("Routing updated.");
      renderModelsView();
    });
    $("modelsBody").addEventListener("click", async function (e) {
      var btn = e.target.closest("[data-route-reset]");
      if (!btn) return;
      var r = await api("/api/harvey/models/route/" + encodeURIComponent(btn.getAttribute("data-route-reset")), { method: "DELETE" });
      if (!r.ok) { toast(r.error || "Could not reset that route."); return; }
      if (r.data && r.data.routing) state.routing = r.data.routing;
      toast("Routing reset to the default.");
      renderModelsView();
    });

    /* keyboard */
    document.addEventListener("keydown", function (e) {
      var mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        if (voiceModeIsOpen()) { closeVoiceMode(); return; }
        closePop(); closeSidebarOverlay(); return;
      }
      if (mod && e.shiftKey && (e.key === "O" || e.key === "o")) { e.preventDefault(); newChat(); return; }
      if (mod && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        showView("chat");
        $("input").focus();
        return;
      }
      if (mod && e.key === "\\") { e.preventDefault(); toggleSidebar(); }
    });

    /* first load */
    loadModels().then(function () { loadConversations(); loadPendingApprovals(); });
    $("input").focus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
