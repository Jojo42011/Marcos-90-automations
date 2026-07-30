/**
 * Harvey background-job watcher — shared by every chat surface.
 *
 * WHY SHARED. Harvey escalates long work to a background job and replies with an
 * id. Without a handoff back, a job that finishes in 100 seconds is
 * indistinguishable from one that hung: the operator watches a static reply and
 * reasonably concludes it is stuck. That was a real report.
 *
 * This lived inline in hull-chat.html first. Porting it to jarvis.html by copy
 * meant three implementations of the same polling and markdown rules, which is
 * precisely the failure that hid produced files for a week (two CSV mappings,
 * one of which wrote to the wrong store). One file, used everywhere.
 *
 *   HarveyJobWatch.init({ mount, scrollDown, withToken, onResult, dark })
 *   HarveyJobWatch.watchReply(replyText)   // finds a job_… id and follows it
 *   HarveyJobWatch.watch(jobId)
 *
 * `mount` returns the element to render the card into, so each page keeps its own
 * bubble markup and theme. Everything else is here.
 */
(function (global) {
  "use strict";

  var JOB_ID_RE = /\bjob_[a-z0-9]{6,}_[a-z0-9]{4,}\b/i;
  /** Artefacts of a script run, not deliverables. */
  var INTERNAL_RE = /\/(script\.(js|py)|guard\.cjs|sitecustomize\.py|output\.txt)$/;
  var POLL_MS = 3000;
  /** ~20 minutes. Long on purpose: giving up early and leaving a "still
   *  working" card is the exact failure this exists to fix. */
  var MAX_POLLS = 400;

  var cfg = {
    mount: null,
    scrollDown: function () {},
    withToken: function (u) { return u; },
    onResult: null,
  };
  var watching = {};

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ── markdown ───────────────────────────────────────────────
     Escaped FIRST, then a known set of tags reintroduced, so a lead's note
     containing "<script>" renders as text. Headings and tables matter most:
     Harvey's reports are largely tables, and raw pipes were the whole
     "it looks codey" complaint. */
  function mdInline(t) {
    return esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function isTableSep(l) {
    return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.indexOf("-") >= 0;
  }
  function splitRow(l) {
    return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
  }
  function renderMarkdown(src) {
    var lines = String(src == null ? "" : src).replace(/\r\n/g, "\n").split("\n");
    var html = "", i = 0, listOpen = null;
    function closeList() { if (listOpen) { html += "</" + listOpen + ">"; listOpen = null; } }

    while (i < lines.length) {
      var l = lines[i];
      if (/^\s*```/.test(l)) {
        closeList(); i++;
        var buf = [];
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += '<pre class="hjw-pre">' + esc(buf.join("\n")) + "</pre>";
        continue;
      }
      if (!l.trim()) { closeList(); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { closeList(); html += '<hr class="hjw-hr">'; i++; continue; }

      var h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) {
        closeList();
        html += '<div class="hjw-h hjw-h' + Math.min(h[1].length, 4) + '">' + mdInline(h[2]) + "</div>";
        i++; continue;
      }
      if (l.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        closeList();
        var head = splitRow(l); i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        html += '<div class="hjw-twrap"><table class="hjw-t"><thead><tr>' +
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
        if (listOpen !== want) { closeList(); listOpen = want; html += "<" + want + ' class="hjw-list">'; }
        html += "<li>" + mdInline((li || ol)[1]) + "</li>"; i++; continue;
      }
      if (/^\s*>\s?/.test(l)) {
        closeList();
        html += '<blockquote class="hjw-q">' + mdInline(l.replace(/^\s*>\s?/, "")) + "</blockquote>";
        i++; continue;
      }
      closeList();
      var para = [l]; i++;
      while (i < lines.length && lines[i].trim()
             && !/^\s*(#|[-*+]\s|\d+[.)]\s|>|```|\|)/.test(lines[i])
             && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) { para.push(lines[i]); i++; }
      html += '<p class="hjw-p">' + mdInline(para.join(" ")) + "</p>";
    }
    closeList();
    return html;
  }

  /* ── tool names in operator language ── */
  var TOOL_LABELS = {
    search_tracker: "searching the tracker", get_tracker_summary: "reading the tracker",
    get_tracker_record: "reading a record", get_tracker_pipelines: "checking the pipelines",
    get_lead: "reading a lead", get_lead_summary: "reviewing the leads",
    write_file: "writing the file", edit_file: "editing the file", read_file: "reading a file",
    list_files: "looking through files", get_social_analytics: "pulling social analytics",
    get_task_board: "reading the task board", create_task: "creating a task",
    get_lead_nurture_overview: "reviewing lead scores", gmail_send: "sending an email",
    send_sms: "sending a text", run_script: "running a script to compute it",
    get_command_settings: "checking settings", memory_store: "making a note",
  };
  function prettyTool(t) {
    return t ? (TOOL_LABELS[t] || String(t).replace(/_/g, " ")) : "working";
  }

  /* ── files a job produced ──
     Prefer the recorded fields; fall back to the tool OUTPUT, since a step's
     `input` is truncated server-side and JSON.parse-ing it throws for exactly
     the writes big enough to matter. */
  function filesFromJob(job) {
    var seen = [];
    function add(f) {
      if (f && seen.indexOf(f) < 0 && !INTERNAL_RE.test(f)) seen.push(f);
    }
    (job.steps || []).forEach(function (st) {
      if (st.kind !== "tool") return;
      if (st.files && st.files.length) { st.files.forEach(add); return; }
      if (st.file) { add(st.file); return; }
      var m = /"path"\s*:\s*"([^"]+)"/.exec(String(st.output || ""));
      if (m) add(m[1]);
    });
    return seen;
  }

  function fileRow(path) {
    var dl = cfg.withToken("/api/harvey/workspace/download?path=" + encodeURIComponent(path));
    return '<div class="hjw-file"><span class="hjw-fn">' + esc(path.split("/").pop()) + "</span>" +
      '<a class="hjw-dl" href="' + dl + '" download>Download</a>' +
      '<a class="hjw-dl" href="' + dl + '&inline=1" target="_blank" rel="noopener">Open</a></div>';
  }

  function injectCss() {
    if (document.getElementById("hjw-css")) return;
    var st = document.createElement("style");
    st.id = "hjw-css";
    /* Styled against currentColor and translucent white so it sits in a dark
       console or a light panel without either page having to know about it. */
    st.textContent = [
      ".hjw-card{border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:13px 15px;",
      "  background:rgba(255,255,255,.035);font-size:14px;line-height:1.6;text-align:left}",
      ".hjw-spin{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle;",
      "  border:2px solid rgba(127,227,227,.25);border-top-color:#7fe3e3;animation:hjwsp .8s linear infinite}",
      "@keyframes hjwsp{to{transform:rotate(360deg)}}",
      ".hjw-done{color:#6ee7b7;font-weight:700;font-size:12.5px;letter-spacing:.02em;margin-bottom:9px}",
      ".hjw-bad{color:#ff8ea0;font-weight:700;font-size:12.5px;margin-bottom:7px}",
      ".hjw-err{color:#ff8ea0}",
      ".hjw-h{font-weight:700;line-height:1.3;margin:15px 0 8px}",
      ".hjw-h:first-child{margin-top:0}",
      ".hjw-h1{font-size:18px}.hjw-h2{font-size:16px}.hjw-h3{font-size:14.5px}",
      ".hjw-h4{font-size:12px;text-transform:uppercase;letter-spacing:.05em;opacity:.7}",
      ".hjw-p{margin:0 0 9px}.hjw-p:last-child{margin-bottom:0}",
      ".hjw-list{margin:0 0 10px 22px}.hjw-list li{margin-bottom:4px}",
      ".hjw-hr{border:0;border-top:1px solid rgba(255,255,255,.12);margin:14px 0}",
      ".hjw-q{border-left:3px solid rgba(127,227,227,.5);padding:2px 0 2px 12px;margin:0 0 10px;opacity:.85}",
      ".hjw-card code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;",
      "  background:rgba(255,255,255,.07);border-radius:4px;padding:1px 5px}",
      ".hjw-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;",
      "  background:rgba(255,255,255,.05);border-radius:10px;padding:11px;overflow-x:auto;margin:0 0 10px}",
      ".hjw-twrap{overflow-x:auto;margin:0 0 12px;border:1px solid rgba(255,255,255,.12);border-radius:10px}",
      ".hjw-t{border-collapse:collapse;width:100%;font-size:13px}",
      ".hjw-t th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;opacity:.65;",
      "  background:rgba(255,255,255,.05);padding:8px 11px;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.12)}",
      ".hjw-t td{padding:8px 11px;border-bottom:1px solid rgba(255,255,255,.08);vertical-align:top}",
      ".hjw-t tr:last-child td{border-bottom:0}",
      ".hjw-files{margin-top:13px;display:flex;flex-direction:column;gap:7px}",
      ".hjw-file{display:flex;align-items:center;gap:9px;border:1px solid rgba(255,255,255,.12);",
      "  border-radius:10px;padding:9px 11px;background:rgba(255,255,255,.035)}",
      ".hjw-fn{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".hjw-dl{flex:0 0 auto;font-size:11.5px;font-weight:700;color:#7fe3e3;text-decoration:none;",
      "  border:1px solid rgba(127,227,227,.35);border-radius:7px;padding:4px 9px}",
      ".hjw-dl:hover{background:rgba(127,227,227,.12)}",
      /* A light host page needs darker hairlines to stay legible. */
      "body.hjw-light .hjw-card,body.hjw-light .hjw-file,body.hjw-light .hjw-twrap{border-color:rgba(0,0,0,.12);background:rgba(0,0,0,.02)}",
      "body.hjw-light .hjw-t th{background:rgba(0,0,0,.04);border-bottom-color:rgba(0,0,0,.12)}",
      "body.hjw-light .hjw-t td{border-bottom-color:rgba(0,0,0,.07)}",
      "body.hjw-light .hjw-dl{color:#0f766e;border-color:rgba(15,118,110,.35)}",
      "body.hjw-light .hjw-done{color:#047857}",
    ].join("\n");
    document.head.appendChild(st);
  }

  /**
   * A card for a page with no transcript.
   *
   * `/operator` is voice-only — an orb and a status pill, nowhere to put a chat
   * bubble — and `/jarvis` has no text composer either. Both can still START a
   * job by voice, which means both could leave the operator with no idea it had
   * finished: the same defect, on a surface where the chat-bubble fix does not
   * apply. So the same watcher renders as a floating notice instead.
   */
  function floatingMount() {
    var host = document.getElementById("hjw-float");
    if (!host) {
      host = document.createElement("div");
      host.id = "hjw-float";
      document.body.appendChild(host);
      if (!document.getElementById("hjw-float-css")) {
        var st = document.createElement("style");
        st.id = "hjw-float-css";
        st.textContent = [
          "#hjw-float{position:fixed;right:18px;bottom:18px;z-index:9998;width:min(440px,calc(100vw - 36px));",
          "  max-height:min(70vh,720px);overflow-y:auto;display:flex;flex-direction:column;gap:10px}",
          "#hjw-float .hjw-card{background:rgba(16,22,28,.94);backdrop-filter:blur(10px);",
          "  box-shadow:0 12px 40px rgba(0,0,0,.45);position:relative;padding-right:34px}",
          "#hjw-float .hjw-x{position:absolute;top:8px;right:8px;width:22px;height:22px;border:0;",
          "  background:none;color:currentColor;opacity:.5;font-size:14px;line-height:1;cursor:pointer;",
          "  border-radius:6px}",
          "#hjw-float .hjw-x:hover{opacity:1;background:rgba(255,255,255,.10)}",
        ].join("\n");
        document.head.appendChild(st);
      }
    }
    var card = document.createElement("div");
    var x = document.createElement("button");
    x.className = "hjw-x"; x.type = "button"; x.title = "Dismiss"; x.textContent = "✕";
    x.onclick = function () { card.remove(); };
    card.appendChild(x);
    host.appendChild(card);
    /* The dismiss button is re-attached after each innerHTML rewrite, since the
       watcher owns the card's contents. */
    var mo = new MutationObserver(function () {
      if (!card.querySelector(".hjw-x")) card.appendChild(x);
    });
    mo.observe(card, { childList: true });
    return card;
  }

  function init(options) {
    options = options || {};
    if (options.mount === "floating") cfg.mount = floatingMount;
    else if (typeof options.mount === "function") cfg.mount = options.mount;
    if (typeof options.scrollDown === "function") cfg.scrollDown = options.scrollDown;
    if (typeof options.withToken === "function") cfg.withToken = options.withToken;
    if (typeof options.onResult === "function") cfg.onResult = options.onResult;
    if (options.dark === false) document.body.classList.add("hjw-light");
    injectCss();
  }

  /** Follow a job to its end, updating one card in place. */
  function watch(id) {
    if (!id || watching[id]) return;
    /* Default to the floating card rather than doing nothing: a page that loaded
       this file clearly wants job feedback, and silence is the bug. */
    if (!cfg.mount) { injectCss(); cfg.mount = floatingMount; }
    watching[id] = true;
    injectCss();

    var card = cfg.mount();
    if (!card) { delete watching[id]; return; }
    card.classList.add("hjw-card");

    function working(t, steps) {
      card.innerHTML = '<span class="hjw-spin"></span><strong>Working on it</strong> · ' + esc(t) +
        (steps ? ' <span style="opacity:.6">· step ' + steps + "</span>" : "");
      cfg.scrollDown();
    }
    working("starting…", 0);

    var polls = 0;
    function tick() {
      if (polls++ >= MAX_POLLS) {
        card.innerHTML = '<span class="hjw-err">This job has been running over 20 minutes — I have stopped ' +
          'watching it here. It may still be going: check <a href="/jobs" target="_blank" rel="noopener">Jobs</a>.</span>';
        delete watching[id];
        cfg.scrollDown();
        return;
      }
      fetch(cfg.withToken("/api/harvey/jobs/" + encodeURIComponent(id)))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var job = (data && data.job) || data;
          if (!job || !job.status) { setTimeout(tick, POLL_MS); return; }

          if (job.status === "running" || job.status === "queued") {
            var steps = (job.steps || []).length;
            var last = null;
            for (var i = (job.steps || []).length - 1; i >= 0; i--) {
              if (job.steps[i].kind === "tool") { last = job.steps[i]; break; }
            }
            working(last ? prettyTool(last.tool) : "getting started", steps);
            setTimeout(tick, POLL_MS);
            return;
          }

          var files = filesFromJob(job);
          var fileHtml = files.length ? '<div class="hjw-files">' + files.map(fileRow).join("") + "</div>" : "";
          if (job.status === "done") {
            card.innerHTML = '<div class="hjw-done">✓ Done' +
              (job.toolCalls ? " · " + job.toolCalls + " tool call" + (job.toolCalls === 1 ? "" : "s") : "") +
              "</div>" + renderMarkdown(job.result || "(finished with no report)") + fileHtml;
            if (cfg.onResult) cfg.onResult(job.result || "(job finished)", job);
          } else {
            card.innerHTML = '<div class="hjw-bad">' +
              (job.status === "cancelled" ? "Stopped" : job.status === "interrupted" ? "Interrupted" : "Didn’t finish") +
              '</div><span class="hjw-err">' + esc(job.error || "No reason recorded.") + "</span>" + fileHtml;
          }
          delete watching[id];
          cfg.scrollDown();
        })
        .catch(function () { setTimeout(tick, POLL_MS); });   // a blip must not kill the watch
    }
    setTimeout(tick, POLL_MS);
  }

  /** Pull a job id out of Harvey's reply and follow it. Returns the id or null. */
  function watchReply(text) {
    var m = String(text || "").match(JOB_ID_RE);
    if (!m) return null;
    watch(m[0]);
    return m[0];
  }

  global.HarveyJobWatch = {
    init: init,
    floatingMount: floatingMount,
    watch: watch,
    watchReply: watchReply,
    renderMarkdown: renderMarkdown,
    prettyTool: prettyTool,
    JOB_ID_RE: JOB_ID_RE,
  };
})(window);
