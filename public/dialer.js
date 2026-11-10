(() => {
  "use strict";
  const $ = (s) => document.querySelector(s),
    esc = (x) =>
      String(x ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      ),
    fmt = (n) => Number(n || 0).toLocaleString(),
    date = (x) =>
      new Date(x).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    time = (x) =>
      new Date(x).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    dur = (s) => Math.floor(s / 60) + "m " + Math.floor(s % 60) + "s";
  const paths = {
    home: '<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z"/>',
    contacts:
      '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M19 15a5 5 0 0 1 3 4"/>',
    sessions:
      '<path d="M22 16v4a2 2 0 0 1-2 2C10 22 2 14 2 4a2 2 0 0 1 2-2h4l2 6-3 2c2 4 3 5 7 7l2-3z"/>',
    calendar:
      '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>',
    sources:
      '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    numbers:
      '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
    refresh:
      '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  };
  const icon = (k) =>
    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    paths[k] +
    "</svg>";
  const titles = {
    home: "Home",
    contacts: "Contacts",
    sessions: "Sessions",
    calendar: "Calendar",
    sources: "Lead sources",
    numbers: "Numbers",
  };
  let overview,
    numberData = { numbers: [] },
    view = "home",
    listId = "",
    page = 1,
    q = "",
    assigned = "",
    duplicates = false,
    expiredOnly = false,
    contactRows = [],
    contactTotal = 0,
    selected = new Set(),
    activeContact = null,
    notes = "",
    noteDrafts = new Map(),
    weekOffset = 0,
    map = null,
    refreshing = false,
    requestSerial = 0;
  const member = (id) =>
      overview?.members.find((u) => u.id === id)?.name || "Unassigned",
    mySession = () =>
      overview?.sessions.find(
        (s) => s.actorId === overview.actor.id && s.status !== "ended",
      );
  async function api(path, body, method) {
    const r = await fetch("/api/dialer" + path, {
      method: method || (body ? "POST" : "GET"),
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error || "Request failed. Try again.");
    return d;
  }
  function toast(message) {
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    setTimeout(() => ($("#toast").hidden = true), 5000);
  }
  function error(e) {
    $("#notice").hidden = false;
    $("#notice").className = "notice error";
    $("#notice").textContent = e.message || String(e);
  }
  function download(name, data, type = "text/csv") {
    const u = URL.createObjectURL(new Blob([data], { type })),
      a = document.createElement("a");
    a.href = u;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }
  function nav() {
    view = new URLSearchParams(location.search).get("view") || "home";
    if (!titles[view]) view = "home";
    listId = new URLSearchParams(location.search).get("list") || "";
    $("#nav").innerHTML = Object.keys(titles)
      .map(
        (k) =>
          '<a href="?view=' +
          k +
          '" data-nav="' +
          k +
          '" class="' +
          (view === k ? "on" : "") +
          '"' +
          (view === k ? ' aria-current="page"' : "") +
          ">" +
          icon(k) +
          titles[k] +
          "</a>",
      )
      .join("");
    $("#pageTitle").textContent = listId
      ? overview?.lists.find((l) => l.id === listId)?.name || "Contacts"
      : titles[view];
    $("#sectionLabel").textContent =
      view === "contacts"
        ? "Shared contacts and calling lists"
        : view === "sessions"
          ? "Team calling activity"
          : "Team prospecting";
    if (overview) {
      for (const kind of ["list", "group"])
        $("#" + (kind === "list" ? "sideLists" : "sideGroups")).innerHTML =
          overview.lists
            .filter((l) => l.kind === kind)
            .map(
              (l) =>
                '<a class="' +
                (listId === l.id ? "on" : "") +
                '" data-list="' +
                esc(l.id) +
                '" href="?view=contacts&list=' +
                encodeURIComponent(l.id) +
                '"><span>' +
                esc(l.name) +
                "</span><small>" +
                fmt(l.count) +
                "</small></a>",
            )
            .join("") ||
          '<small style="padding:7px 10px">No ' +
            (kind === "list" ? "lists" : "groups") +
            " yet</small>";
      $("#startButton").textContent = mySession()
        ? "Resume session"
        : "Start session";
    }
  }
  function go(v, list = "") {
    saveNotes();
    const u = new URL(location.href);
    u.searchParams.set("view", v);
    if (list) u.searchParams.set("list", list);
    else u.searchParams.delete("list");
    history.pushState({}, "", u);
    page = 1;
    selected.clear();
    nav();
    render().catch(error);
  }
  function saveNotes() {
    if ($("#callNotes") && activeContact) {
      notes = $("#callNotes").value;
      noteDrafts.set(activeContact.id, notes);
    }
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    saveNotes();
    try {
      overview = await api("/overview");
      $("#notice").hidden = true;
      const stale = overview.members.filter(
        (u) =>
          !overview.sync.some(
            (s) => s.id === u.id && Date.now() - Date.parse(s.at) < 120000,
          ),
      );
      $("#syncStatus").textContent = stale.length
        ? "Waiting for " + stale.map((u) => u.name.split(" ")[0]).join(", ")
        : "Team data synced";
      if (overview.pendingSync || stale.length) {
        $("#notice").className = "notice";
        $("#notice").hidden = false;
        $("#notice").textContent = overview.pendingSync
          ? overview.pendingSync +
            " changes waiting to sync to CRM. They are saved and will retry automatically."
          : "Some team accounts have not synced yet. Totals currently reflect the accounts that have reported.";
      }
      nav();
      await render();
    } catch (e) {
      error(e);
    } finally {
      refreshing = false;
    }
  }
  function stats() {
    return (
      '<div class="stats">' +
      [
        [overview.totals.contacts, "Shared contacts"],
        [overview.totals.callable, "With a callable number"],
        [overview.totals.calls, "Logged call attempts"],
        [overview.totals.connected, "Reached a person"],
      ]
        .map(
          ([v, l]) =>
            '<div class="stat"><strong>' +
            fmt(v) +
            "</strong><span>" +
            l +
            "</span></div>",
        )
        .join("") +
      "</div>"
    );
  }
  function sessionTable(rows) {
    return (
      '<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Started</th><th>List</th><th>Attempts</th><th>Reached</th><th>Active time</th><th>Status</th></tr></thead><tbody>' +
      rows
        .map((s) => {
          const counts = overview.sessionCounts[s.id] || {
            attempts: 0,
            reached: 0,
          };
          return (
            "<tr><td><strong>" +
            esc(s.actorName) +
            "</strong></td><td>" +
            date(s.startedAt) +
            "<small>" +
            time(s.startedAt) +
            "</small></td><td>" +
            esc(
              overview.lists.find((l) => l.id === s.listId)?.name ||
                "All contacts",
            ) +
            "</td><td>" +
            counts.attempts +
            "</td><td>" +
            counts.reached +
            "</td><td>" +
            dur(
              s.activeSeconds +
                (s.activeSince
                  ? (Date.now() - Date.parse(s.activeSince)) / 1000
                  : 0),
            ) +
            '</td><td><span class="badge ' +
            (s.status === "active" ? "good" : "") +
            '">' +
            esc(s.status) +
            "</span></td></tr>"
          );
        })
        .join("") +
      "</tbody></table></div>"
    );
  }
  function home() {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - 6 + i);
      return { d, key: d.toLocaleDateString(), count: 0 };
    });
    for (const c of overview.recentCalls) {
      const d = days.find(
        (d) => d.key === new Date(c.startedAt).toLocaleDateString(),
      );
      if (d) d.count++;
    }
    const max = Math.max(1, ...days.map((d) => d.count));
    const upcoming = overview.appointments
        .filter(
          (a) => a.status === "scheduled" && Date.parse(a.endAt) > Date.now(),
        )
        .slice(0, 4),
      s = mySession();
    $("#workspace").innerHTML =
      stats() +
      '<div class="home-grid"><section class="panel"><div class="panel-header"><div><h2>Calling activity</h2><p>Logged attempts over the last 7 days</p></div><a href="?view=sessions" data-nav="sessions">View sessions</a></div><div class="chart" role="img" aria-label="' +
      esc(
        days.map((d) => date(d.d) + ": " + d.count + " attempts").join("; "),
      ) +
      '">' +
      days
        .map(
          (d) =>
            '<div class="chart-col"><span>' +
            d.count +
            '</span><div class="bar" style="height:' +
            Math.max(2, (d.count / max) * 125) +
            'px"></div></div>',
        )
        .join("") +
      '</div><div class="chart-labels">' +
      days
        .map(
          (d) =>
            "<span>" +
            d.d.toLocaleDateString(undefined, { weekday: "short" }) +
            "</span>",
        )
        .join("") +
      '</div></section><section class="panel"><div class="panel-header"><div><h2>Coming up</h2><p>Appointments and follow-up calls</p></div><a href="?view=calendar" data-nav="calendar">Calendar</a></div>' +
      (upcoming.length
        ? upcoming
            .map(
              (a) =>
                '<div class="appointment-item"><div class="appointment-time">' +
                time(a.startAt) +
                '<small style="display:block">' +
                date(a.startAt) +
                '</small></div><div><button class="contact-link" data-appointment="' +
                esc(a.id) +
                '"><strong>' +
                esc(a.title) +
                "</strong></button><p>" +
                esc(member(a.assignedTo)) +
                "</p></div></div>",
            )
            .join("")
        : '<div class="empty"><p>No upcoming appointments. Book one directly from a contact or a calling session.</p><button data-action="book">Book appointment</button></div>') +
      '</section><section class="panel full-width"><div class="panel-header"><div><h2>Recent sessions</h2><p>Shared team activity, with outcomes recorded by the caller</p></div><button data-action="start">' +
      (s ? "Continue your session" : "Start a session") +
      "</button></div>" +
      (overview.sessions.length
        ? sessionTable(overview.sessions.slice(0, 6))
        : '<div class="empty"><h2>Your next conversation starts here</h2><p>Import a lead file or choose a calling list, then start your first session.</p><button data-action="import">Import leads</button></div>') +
      "</section></div>";
  }
  async function contacts() {
    const serial = ++requestSerial;
    const p = new URLSearchParams({
        q,
        listId,
        assignedTo: assigned,
        duplicates: String(duplicates),
        page: String(page),
      }),
      d = await api("/contacts?" + p);
    if (serial !== requestSerial || view !== "contacts") return;
    contactRows = d.contacts;
    contactTotal = d.total;
    const s = mySession();
    if (s && s.queue[s.position]) {
      const c = await api(
        "/contacts/" + encodeURIComponent(s.queue[s.position]),
      );
      if (serial !== requestSerial) return;
      activeContact = c.contact;
      notes = noteDrafts.get(activeContact.id) || "";
    } else activeContact = null;
    $("#workspace").innerHTML =
      '<div class="contacts-layout ' +
      (!s ? "no-session" : "") +
      '"><section class="panel contacts-panel"><form id="searchForm" class="toolbar"><input id="search" name="q" type="search" aria-label="Search contacts" placeholder="Search name, phone, address…" value="' +
      esc(q) +
      '"><select id="assigned" aria-label="Filter by agent"><option value="">All agents</option>' +
      overview.members
        .map(
          (u) =>
            '<option value="' +
            esc(u.id) +
            '"' +
            (assigned === u.id ? " selected" : "") +
            ">" +
            esc(u.name) +
            "</option>",
        )
        .join("") +
      '</select><button type="submit">Search</button><button type="button" data-action="duplicates" aria-pressed="' +
      duplicates +
      '">' +
      (duplicates ? "All contacts" : "Find duplicates") +
      '</button><button type="button" data-action="new-list">New list</button><button type="button" data-action="new-group">New group</button><button type="button" data-action="map">Map</button><button type="button" data-action="export">Export</button></form><div id="bulk"></div><div class="table-wrap"><table><thead><tr><th><input class="check" id="selectAll" type="checkbox" aria-label="Select this page"></th><th>Contact</th><th>Property</th><th>Phone</th><th>Agent</th><th>Status</th></tr></thead><tbody>' +
      contactRows
        .map(
          (c) =>
            '<tr class="' +
            (selected.has(c.id) ? "selected-row" : "") +
            '"><td><input class="check" type="checkbox" data-select="' +
            esc(c.id) +
            '" aria-label="Select ' +
            esc(c.name) +
            '"' +
            (selected.has(c.id) ? " checked" : "") +
            '></td><td><button class="contact-link" data-contact="' +
            esc(c.id) +
            '"><strong>' +
            esc(c.name) +
            "</strong></button><small>" +
            esc(c.source) +
            "</small></td><td>" +
            esc(c.address || "No address") +
            "<small>" +
            esc(c.city) +
            "</small></td><td>" +
            esc(c.phone || "No number") +
            "</td><td>" +
            esc(member(c.assignedTo)) +
            '</td><td><span class="badge ' +
            (c.dnc ? "danger" : "") +
            '">' +
            (c.dnc ? "Do not call" : c.phone ? "Ready" : "No phone") +
            "</span></td></tr>",
        )
        .join("") +
      "</tbody></table>" +
      (contactRows.length
        ? ""
        : '<div class="empty"><h2>No matching contacts</h2><p>Try another search or import leads into this list.</p></div>') +
      '</div><div class="pager"><span>' +
      fmt(d.total) +
      " contacts" +
      (duplicates ? " with matching phone or email" : "") +
      '</span><div><button data-action="prev" ' +
      (page === 1 ? "disabled" : "") +
      ">Previous</button><span>Page " +
      page +
      '</span><button data-action="next" ' +
      (page * 100 >= d.total ? "disabled" : "") +
      ">Next</button></div></div></section>" +
      (s ? sessionPanel(s) : "") +
      "</div>";
    bulk();
  }
  function bulk() {
    const el = $("#bulk");
    if (el)
      el.innerHTML = selected.size
        ? '<div class="bulk"><span>' +
          selected.size +
          ' selected</span><button data-action="add-list">Add to list / group</button><button data-action="assign">Assign</button>' +
          (listId
            ? '<button data-action="remove-list">Remove from list</button>'
            : "") +
          '<button data-action="start-selected">Start session</button></div>'
        : "";
  }
  function sessionPanel(s) {
    const c = activeContact,
      call = overview.calls.find((c) => c.id === s.currentCall),
      line = numberData.numbers.find((n) => n.id === s.lineId);
    return (
      '<aside class="panel session-panel"><div class="session-heading"><strong>Your session</strong><span class="badge good">' +
      esc(s.status) +
      "</span></div><small>" +
      Math.min(s.position + 1, s.queue.length) +
      " of " +
      s.queue.length +
      ' contacts</small><div class="progress"><i style="width:' +
      Math.min(100, (s.position / s.queue.length) * 100) +
      '%"></i></div>' +
      (c
        ? '<div class="contact-avatar">' +
          esc(
            c.name
              .split(/\s+/)
              .map((n) => n[0])
              .slice(0, 2)
              .join(""),
          ) +
          "</div><h2>" +
          esc(c.name) +
          '</h2><p class="address">' +
          esc(c.address || "No property address") +
          '</p><span class="phone">' +
          esc(c.phone) +
          "</span><small>Selected line: " +
          esc(line?.label || "Default phone app") +
          '</small><label>Call notes<textarea id="callNotes" placeholder="Motivation, timeline, next step…">' +
          esc(notes) +
          "</textarea></label>" +
          (call
            ? '<label>Outcome<select id="outcome"><option value="">Choose an outcome</option><option value="talked">Talked</option><option value="no_answer">No answer</option><option value="voicemail">Left voicemail</option><option value="wrong_number">Wrong number</option><option value="do_not_call">Do not call</option><option value="appointment_set">Appointment set</option><option value="interrupted">Interrupted / not placed</option></select></label><div class="session-actions"><button class="primary wide" data-action="save-outcome">Save outcome & next</button>'
            : '<div class="session-actions"><button class="primary wide" data-action="call" ' +
              (s.status !== "active" || c.dnc ? "disabled" : "") +
              ">Open phone & log attempt</button>") +
          '<button data-action="book-current">Book appointment</button><button data-contact="' +
          esc(c.id) +
          '">Contact details</button></div><p class="hint">Calls open in your phone app. Choose the same line there. This timer records time spent, not confirmed talk time.</p>'
        : '<div class="empty"><h2>Queue complete</h2><p>End this session to save your team summary.</p></div>') +
      '<div class="session-foot"><button data-session-action="' +
      (s.status === "paused" ? "resume" : "pause") +
      '" ' +
      (call ? "disabled" : "") +
      ">" +
      (s.status === "paused" ? "Resume" : "Pause") +
      '</button><button data-session-action="skip" ' +
      (call || !c ? "disabled" : "") +
      '>Skip</button><button data-session-action="end" ' +
      (call ? "disabled" : "") +
      ">End session</button></div></aside>"
    );
  }
  function sessions() {
    const rows = assigned
      ? overview.sessions.filter((s) => s.actorId === assigned)
      : overview.sessions;
    $("#workspace").innerHTML =
      stats() +
      '<section class="panel"><div class="panel-header"><div><h2>Session history</h2><p>Active time excludes pauses. Reached counts come from saved outcomes.</p></div><select id="sessionAgent" aria-label="Filter sessions by agent"><option value="">All agents</option>' +
      overview.members
        .map(
          (u) =>
            '<option value="' +
            esc(u.id) +
            '"' +
            (u.id === assigned ? " selected" : "") +
            ">" +
            esc(u.name) +
            "</option>",
        )
        .join("") +
      "</select></div>" +
      (rows.length
        ? sessionTable(rows)
        : '<div class="empty">No sessions for this agent yet.</div>') +
      "</section>";
  }
  function calendar() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(
      start.getDate() - ((start.getDay() + 6) % 7) + weekOffset * 7,
    );
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
    $("#workspace").innerHTML =
      '<div class="toolbar"><h2 style="margin-right:auto">' +
      date(days[0]) +
      " – " +
      date(days[6]) +
      '</h2><span class="muted">' +
      esc(Intl.DateTimeFormat().resolvedOptions().timeZone) +
      '</span><button data-action="week-prev">Previous</button><button data-action="week-today">Today</button><button data-action="week-next">Next</button><button class="primary" data-action="book">Book appointment</button></div><div class="week">' +
      days
        .map(
          (d) =>
            '<section class="day ' +
            (d.toDateString() === new Date().toDateString() ? "today" : "") +
            '"><div class="day-head"><span>' +
            d.toLocaleDateString(undefined, { weekday: "short" }) +
            "</span><strong>" +
            d.getDate() +
            "</strong></div>" +
            overview.appointments
              .filter(
                (a) =>
                  new Date(a.startAt).toDateString() === d.toDateString() &&
                  a.status !== "cancelled",
              )
              .map(
                (a) =>
                  '<button class="calendar-event" data-appointment="' +
                  esc(a.id) +
                  '">' +
                  time(a.startAt) +
                  "<strong>" +
                  esc(a.title) +
                  "</strong><small>" +
                  esc(member(a.assignedTo)) +
                  "<br>" +
                  esc(a.status) +
                  "</small></button>",
              )
              .join("") +
            "</section>",
        )
        .join("") +
      '</div><p class="source-caption">Appointments save to the CRM calendar. Download a calendar file to add one to your external calendar; invitations are not sent automatically.</p>';
  }
  async function sources() {
    const d = await api(
      "/discovery?" +
        new URLSearchParams({
          q,
          city: "",
          status: expiredOnly ? "Expired" : "",
        }),
    );
    if (view !== "sources") return;
    $("#workspace").innerHTML =
      '<div class="source-grid"><section class="panel"><div class="panel-header"><h2>Expired listings</h2><span class="badge">Connected MLS</span></div><p>Review expired properties available in your existing MLS feed. Import a licensed contact file when you have homeowner numbers.</p><button data-action="expired">View expired properties</button></section><section class="panel"><div class="panel-header"><h2>Neighborhood search</h2><span class="badge">Your existing data</span></div><p>Find properties by street, city, or neighborhood. Calling lists use imported and CRM contact data; no paid enrichment is enabled.</p><button data-action="import">Import neighborhood contacts</button></section></div><section class="panel"><div class="panel-header"><div><h2>' +
      (expiredOnly ? "Expired properties" : "Property search") +
      "</h2><p>" +
      fmt(d.total) +
      ' matches in the connected feed</p></div><button data-action="all-properties">All statuses</button></div><form id="sourceSearch" class="toolbar"><input name="q" aria-label="Search MLS properties" placeholder="Street, city, subdivision or MLS…" value="' +
      esc(q) +
      '"><button>Search properties</button></form><div class="table-wrap"><table><thead><tr><th>Property</th><th>MLS</th><th>Status</th><th>Price</th><th>Updated</th></tr></thead><tbody>' +
      d.listings
        .map(
          (l) =>
            "<tr><td><strong>" +
            esc(l.street) +
            "</strong><small>" +
            esc(l.city) +
            "</small></td><td>" +
            esc(l.mlsNumber) +
            '</td><td><span class="badge">' +
            esc(l.status) +
            "</span></td><td>" +
            (l.listPrice
              ? Number(l.listPrice).toLocaleString(undefined, {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 0,
                })
              : "—") +
            "</td><td>" +
            date(l.syncedAt) +
            "</td></tr>",
        )
        .join("") +
      "</tbody></table>" +
      (d.listings.length
        ? ""
        : '<div class="empty"><h2>No properties in this result</h2><p>The connected feed may not include expired listings in this area. You can still import your own licensed lead files.</p></div>') +
      '</div><p class="source-caption">' +
      esc(d.notice) +
      " Showing up to 200 matching properties.</p></section>";
  }
  async function numbers() {
    numberData = await api("/numbers");
    if (view !== "numbers") return;
    $("#workspace").innerHTML =
      '<section class="panel"><div class="panel-header"><div><h2>Team phone numbers</h2><p>Numbers discovered from the connected Quo workspace</p></div><a href="https://my.quo.com/" target="_blank" rel="noopener">Manage numbers in Quo</a></div><div class="table-wrap"><table><thead><tr><th>Number</th><th>Label</th><th>CRM default for</th><th></th></tr></thead><tbody>' +
      numberData.numbers
        .map(
          (n) =>
            '<tr><td class="number">' +
            esc(n.number) +
            "</td><td>" +
            esc(n.label) +
            "</td><td>" +
            esc(
              numberData.assignments
                .filter((a) => a.number === n.number)
                .map((a) => a.name)
                .join(", ") || "Not selected",
            ) +
            '</td><td><button data-default-line="' +
            esc(n.id) +
            '"'+(n.selectable?'':' disabled')+'>'+(n.selectable?'Use as my default':'Connect this line in your account')+'</button></td></tr>',
        )
        .join("") +
      "</tbody></table>" +
      (numberData.numbers.length
        ? ""
        : '<div class="empty">No numbers have synced yet. Check your Quo connection in the CRM.</div>') +
      '</div><p class="source-caption">Purchase additional numbers in Quo. Its published API does not provide a number-purchase endpoint. After adding a number, it appears here on the next sync. Caller reputation scores are not provided by the connected API.</p>' +
      numberData.sources
        .filter((s) => s.error)
        .map((s) => '<p class="form-error">' + esc(s.error) + "</p>")
        .join("") +
      "</section>";
  }
  async function render() {
    if (!overview) return;
    if (view === "home") home();
    else if (view === "contacts") {
      if (!numberData.numbers.length) numberData = await api("/numbers");
      await contacts();
    } else if (view === "sessions") sessions();
    else if (view === "calendar") calendar();
    else if (view === "sources") await sources();
    else await numbers();
  }
  function modal(title, body, onSubmit) {
    const d = $("#dialog");
    d.innerHTML =
      '<div class="dialog-head"><h2 id="dialogTitle">' +
      esc(title) +
      '</h2><button type="button" data-action="close" aria-label="Close dialog">×</button></div>' +
      body +
      '<p class="form-error" id="formError" role="alert"></p>';
    d.showModal();
    const f = d.querySelector("form");
    if (f && onSubmit)
      f.onsubmit = async (e) => {
        e.preventDefault();
        const b = e.submitter;
        const label = b?.textContent;
        if (b) {
          b.disabled = true;
          b.textContent = "Saving�";
        }
        try {
          await onSubmit(new FormData(f));
        } catch (err) {
          $("#formError").textContent = err.message;
          $("#formError").setAttribute("tabindex", "-1");
          $("#formError").focus();
        } finally {
          if (b) {
            b.disabled = false;
            if (b.textContent === "Saving�") b.textContent = label;
          }
        }
      };
  }
  const options = (rows, sel = "") =>
    rows
      .map(
        (x) =>
          '<option value="' +
          esc(x.id) +
          '"' +
          (x.id === sel ? " selected" : "") +
          ">" +
          esc(x.name || x.label) +
          "</option>",
      )
      .join("");
  function newList(kind) {
    modal(
      kind === "group" ? "New group" : "New calling list",
      '<form><label class="detail-grid">Name<input name="name" required maxlength="200" placeholder="e.g. Stone Oak sellers…"></label><div class="form-actions"><button class="primary">Create ' +
        kind +
        "</button></div></form>",
      async (f) => {
        const d = await api("/lists", { name: f.get("name"), kind });
        $("#dialog").close();
        await refresh();
        go("contacts", d.list.id);
      },
    );
  }
  async function start(selectedOnly = false) {
    const s = mySession();
    if (s) {
      go("contacts", s.listId);
      return;
    }
    numberData = await api("/numbers");
    modal(
      "Start a calling session",
      '<p class="form-info">Work through a list, log outcomes, and book appointments. Calls open in your connected phone app; automatic dialing is not available through Quo.</p><form class="detail-grid"><label class="wide">Calling list<select name="listId"><option value="">' +
        (selectedOnly
          ? selected.size + " selected contacts"
          : "All callable contacts") +
        "</option>" +
        options(overview.lists, listId) +
        '</select></label><label class="wide">Phone line<select name="lineId"><option value="">Default phone app</option>' +
        options(numberData.numbers) +
        '</select></label><div class="form-actions wide"><button class="primary">Start session</button></div></form>',
      async (f) => {
        await api("/sessions", {
          listId: f.get("listId"),
          lineId: f.get("lineId"),
          ...(selectedOnly ? { contactIds: [...selected] } : {}),
        });
        $("#dialog").close();
        notes = "";
        await refresh();
        go("contacts");
      },
    );
  }
  function importFile() {
    let csv = "",
      previewed = "";
    modal(
      "Import leads",
      '<p class="form-info">CSV files from Mojo or your own spreadsheets. Matching phone numbers and emails are skipped; original CRM records are preserved.</p><form><div class="dropzone"><label for="importFile">Choose a CSV lead file</label><p><input id="importFile" name="file" type="file" accept=".csv,text/csv" required></p></div><div class="detail-grid"><label>Source<input name="source" value="CSV import" required></label><label>Add to list<select name="listId"><option value="">No list</option>' +
        options(overview.lists, listId) +
        '</select></label></div><div id="importPreview"></div><div class="form-actions"><button id="importGo" class="primary">Review import</button></div></form>',
      async (f) => {
        const file = f.get("file");
        if (file.size > 8000000) throw Error("Choose a CSV smaller than 8 MB.");
        csv = await file.text();
        const signature = csv + "|" + f.get("source") + "|" + f.get("listId"),
          apply = signature === previewed;
        const d = await api("/import", {
          csv,
          source: f.get("source"),
          listId: f.get("listId"),
          apply,
        });
        if (apply) {
          $("#dialog").close();
          toast(
            d.created +
              " contacts imported; " +
              d.duplicates +
              " duplicates skipped.",
          );
          await refresh();
          go("contacts", String(f.get("listId")));
        } else {
          previewed = signature;
          $("#importPreview").innerHTML =
            '<div class="import-result"><strong>' +
            d.created +
            " new contacts</strong> · " +
            d.duplicates +
            " duplicates skipped · " +
            d.invalid +
            ' invalid rows<div class="table-wrap"><table><tbody>' +
            d.sample
              .map(
                (r) =>
                  "<tr><td>" +
                  esc(r.name) +
                  "</td><td>" +
                  esc(r.phone) +
                  "</td><td>" +
                  esc(r.action) +
                  "</td></tr>",
              )
              .join("") +
            "</tbody></table></div></div>";
          $("#importGo").textContent = "Import " + d.created + " contacts";
        }
      },
    );
  }
  async function contactDetail(id) {
    const d = await api("/contacts/" + encodeURIComponent(id)),
      c = d.contact;
    modal(
      c.name,
      '<p class="form-info">' +
        esc(c.phone || "No phone") +
        "<br>" +
        esc(c.address || "No address") +
        "<br>Assigned to " +
        esc(member(c.assignedTo)) +
        '</p><div class="foot-actions"><button data-book-contact="' +
        esc(c.id) +
        '">Book appointment</button><button data-dnc="' +
        esc(c.id) +
        '" ' +
        (c.dnc ? "disabled" : "") +
        ">" +
        (c.dnc ? "Do not call" : "Mark do not call") +
        '</button></div><form><label style="display:grid;gap:8px;margin-top:22px">Add a shared note<textarea name="note" required maxlength="4000" placeholder="Context for the next conversation…"></textarea></label><div class="form-actions"><button class="primary">Save note</button></div></form><h3>Recent notes</h3>' +
        d.notes
          .slice(-10)
          .reverse()
          .map(
            (n) =>
              '<div class="note">' +
              esc(n.text) +
              "<small>" +
              esc(n.actorName) +
              " · " +
              date(n.at) +
              "</small></div>",
          )
          .join("") +
        '<h3 style="margin-top:24px">Call history</h3>' +
        d.calls
          .slice(-8)
          .reverse()
          .map(
            (c) =>
              '<div class="note">' +
              esc((c.outcome || "In progress").replace(/_/g, " ")) +
              "<small>" +
              date(c.startedAt) +
              " · " +
              esc(member(c.actorId)) +
              "</small></div>",
          )
          .join(""),
      async (f) => {
        await api("/contacts/" + encodeURIComponent(id) + "/notes", {
          text: f.get("note"),
        });
        $("#dialog").close();
        toast("Note saved. CRM sync is queued.");
      },
    );
  }
  function localInput(iso) {
    const d = iso ? new Date(iso) : new Date(Date.now() + 3600000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }
  async function book(contactId = "", appointmentId = "") {
    const a = appointmentId
      ? overview.appointments.find((a) => a.id === appointmentId)
      : null;
    if (a) contactId = a.contactId;
    let contact = contactId
      ? (await api("/contacts/" + encodeURIComponent(contactId))).contact
      : null;
    const choices = contact ? [contact] : (await api("/contacts")).contacts;
    modal(
      a ? "Appointment details" : "Book an appointment",
      '<p class="form-info">Saved to the shared dialer and contact’s CRM calendar. Times below use ' +
        esc(Intl.DateTimeFormat().resolvedOptions().timeZone) +
        '.</p><form class="detail-grid"><label class="wide">Contact<select name="contactId" required>' +
        options(choices, contactId) +
        "</select></label>" +
        (!contact
          ? '<label class="wide">Find another contact<input id="bookingSearch" type="search" placeholder="Search by name or phone…" autocomplete="off"><button type="button" data-action="booking-search">Find contacts</button></label>'
          : "") +
        '<label class="wide">Title<input name="title" required value="' +
        esc(a?.title || "Property appointment") +
        '"></label><label>Start<input name="startAt" type="datetime-local" required value="' +
        localInput(a?.startAt) +
        '"></label><label>End<input name="endAt" type="datetime-local" required value="' +
        localInput(a?.endAt || new Date(Date.now() + 5400000).toISOString()) +
        '"></label><label>Agent<select name="assignedTo">' +
        options(overview.members, a?.assignedTo || overview.actor.id) +
        '</select></label><label>Type<select name="kind"><option value="appointment">Appointment</option><option value="follow_up" ' +
        (a?.kind === "follow_up" ? "selected" : "") +
        '>Follow-up call</option></select></label><label class="wide">Location<input name="location" value="' +
        esc(a?.location || contact?.address || "") +
        '"></label><label class="wide">Notes<textarea name="notes">' +
        esc(a?.notes || "") +
        "</textarea></label>" +
        (a
          ? '<label>Status<select name="status">' +
            ["scheduled", "completed", "cancelled"]
              .map(
                (s) =>
                  "<option " +
                  (a.status === s ? "selected" : "") +
                  ">" +
                  s +
                  "</option>",
              )
              .join("") +
            "</select>"
          : "") +
        '<div class="form-actions wide">' +
        (a
          ? '<button type="button" data-ics="' +
            esc(a.id) +
            '">Calendar file</button>'
          : "") +
        '<button class="primary">Save appointment</button></div></form>',
      async (f) => {
        const body = Object.fromEntries(f);
        body.startAt = new Date(body.startAt).toISOString();
        body.endAt = new Date(body.endAt).toISOString();
        body.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        await api(
          "/appointments" + (a ? "/" + a.id : ""),
          body,
          a ? "PATCH" : "POST",
        );
        $("#dialog").close();
        toast("Appointment saved.");
        await refresh();
      },
    );
  }
  function ics(id) {
    const a = overview.appointments.find((a) => a.id === id),
      stamp = (x) =>
        new Date(x)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}/, ""),
      safe = (x) =>
        String(x || "")
          .replace(/\\/g, "\\\\")
          .replace(/\r?\n/g, "\\n")
          .replace(/[,;]/g, (x) => "\\" + x);
    download(
      "appointment.ics",
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Command Center//Dialer//EN",
        "BEGIN:VEVENT",
        "UID:" + a.id + "@command-center",
        "DTSTAMP:" + stamp(new Date()),
        "DTSTART:" + stamp(a.startAt),
        "DTEND:" + stamp(a.endAt),
        "SUMMARY:" + safe(a.title),
        "LOCATION:" + safe(a.location),
        "DESCRIPTION:" + safe(a.notes),
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
      "text/calendar",
    );
  }
  function chooseBulk(action) {
    modal(
      action === "assign" ? "Assign selected contacts" : "Add to list or group",
      '<form><label class="detail-grid">' +
        (action === "assign" ? "Agent" : "List or group") +
        '<select name="id" required>' +
        options(action === "assign" ? overview.members : overview.lists) +
        '</select></label><div class="form-actions"><button class="primary">Save selection</button></div></form>',
      async (f) => {
        if (action === "assign")
          await api("/assign", {
            contactIds: [...selected],
            assignedTo: f.get("id"),
          });
        else
          await api("/lists/" + encodeURIComponent(f.get("id")) + "/members", {
            contactIds: [...selected],
          });
        $("#dialog").close();
        selected.clear();
        toast("Contacts updated.");
        await refresh();
      },
    );
  }
  function showMap() {
    const rows = contactRows.filter(
      (c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude),
    );
    modal(
      "Map view",
      '<p class="map-note">' +
        rows.length +
        " of " +
        contactRows.length +
        ' contacts on this page have coordinates. Import latitude and longitude columns to place contacts accurately.</p><div id="map"></div>',
    );
    map = L.map("map").setView([29.4241, -98.4936], 10);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const bounds = [];
    for (const c of rows) {
      const p = [c.latitude, c.longitude];
      bounds.push(p);
      L.circleMarker(p, { radius: 7, color: "#267e71", fillOpacity: 0.8 })
        .addTo(map)
        .bindPopup("<strong>" + esc(c.name) + "</strong><br>" + esc(c.address));
    }
    if (bounds.length)
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  }
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("button,a");
    if (
      !el ||
      ((e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) && el.tagName === "A")
    )
      return;
    try {
      if (el.dataset.nav) {
        e.preventDefault();
        go(el.dataset.nav);
        return;
      }
      if (el.dataset.list) {
        e.preventDefault();
        go("contacts", el.dataset.list);
        return;
      }
      if (el.dataset.contact) {
        await contactDetail(el.dataset.contact);
        return;
      }
      if (el.dataset.appointment) {
        await book("", el.dataset.appointment);
        return;
      }
      if (el.dataset.bookContact) {
        $("#dialog").close();
        await book(el.dataset.bookContact);
        return;
      }
      if (el.dataset.ics) {
        ics(el.dataset.ics);
        return;
      }
      if (el.dataset.dnc) {
        await api(
          "/contacts/" + encodeURIComponent(el.dataset.dnc),
          { dnc: true },
          "PATCH",
        );
        $("#dialog").close();
        toast("Contact marked do not call.");
        await refresh();
        return;
      }
      if (el.dataset.defaultLine) {
        el.disabled = true;
        await api("/numbers/default", { lineId: el.dataset.defaultLine });
        toast("Your CRM default number was updated.");
        await numbers();
        return;
      }
      if (el.dataset.sessionAction) {
        saveNotes();
        el.disabled = true;
        await api("/sessions/" + mySession().id + "/action", {
          action: el.dataset.sessionAction,
        });
        await refresh();
        return;
      }
      const action = el.dataset.action;
      if (!action) return;
      if (action === "close") {
        $("#dialog").close();
        if (map) {
          map.remove();
          map = null;
        }
        return;
      }
      if (action === "refresh") return await refresh();
      if (action === "new-list") return newList("list");
      if (action === "new-group") return newList("group");
      if (action === "start" || action === "start-selected")
        return await start(action === "start-selected");
      if (action === "import") return importFile();
      if (action === "book") return await book();
      if (action === "book-current") return await book(activeContact?.id);
      if (action === "assign" || action === "add-list")
        return chooseBulk(action);
      if (action === "map") return showMap();
      if (action === "remove-list") {
        await api("/lists/" + encodeURIComponent(listId) + "/members", {
          contactIds: [...selected],
          remove: true,
        });
        selected.clear();
        await refresh();
        return;
      }
      if (action === "duplicates") {
        duplicates = !duplicates;
        page = 1;
        return await render();
      }
      if (action === "prev" || action === "next") {
        page += action === "next" ? 1 : -1;
        return await render();
      }
      if (action === "export") {
        const d = await api("/export?listId=" + encodeURIComponent(listId));
        download(d.filename, d.csv);
        return;
      }
      if (action.startsWith("week-")) {
        weekOffset =
          action === "week-today"
            ? 0
            : weekOffset + (action === "week-next" ? 1 : -1);
        return calendar();
      }
      if (action === "expired" || action === "all-properties") {
        expiredOnly = action === "expired";
        return await sources();
      }
      if (action === "booking-search") {
        const d = await api(
          "/contacts?q=" + encodeURIComponent($("#bookingSearch").value),
        );
        $("#dialog select[name=contactId]").innerHTML = options(d.contacts);
        return;
      }
      if (action === "call") {
        el.disabled = true;
        saveNotes();
        const d = await api("/sessions/" + mySession().id + "/calls", {});
        location.href = "tel:" + d.call.phone.replace(/[^+\d]/g, "");
        await refresh();
        return;
      }
      if (action === "save-outcome") {
        const outcome = $("#outcome").value;
        if (!outcome)
          throw Error("Choose an outcome before moving to the next contact.");
        saveNotes();
        el.disabled = true;
        await api("/calls/" + mySession().currentCall + "/outcome", {
          outcome,
          notes,
        });
        notes = "";
        noteDrafts.delete(activeContact.id);
        if ($("#callNotes")) $("#callNotes").value = "";
        await refresh();
        return;
      }
    } catch (err) {
      if ($("#dialog").open) $("#formError").textContent = err.message;
      else error(err);
      el.disabled = false;
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.dataset.select) {
      e.target.checked
        ? selected.add(e.target.dataset.select)
        : selected.delete(e.target.dataset.select);
      bulk();
    }
    if (e.target.id === "selectAll") {
      for (const c of contactRows)
        e.target.checked ? selected.add(c.id) : selected.delete(c.id);
      document
        .querySelectorAll("[data-select]")
        .forEach((x) => (x.checked = e.target.checked));
      bulk();
    }
    if (e.target.id === "sessionAgent") {
      assigned = e.target.value;
      sessions();
    }
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id === "searchForm") {
      e.preventDefault();
      q = $("#search").value;
      assigned = $("#assigned").value;
      page = 1;
      contacts().catch(error);
    }
    if (e.target.id === "sourceSearch") {
      e.preventDefault();
      q = new FormData(e.target).get("q");
      sources().catch(error);
    }
  });
  window.addEventListener("popstate", () => {
    nav();
    render().catch(error);
  });
  window.addEventListener("beforeunload", (e) => {
    saveNotes();
    if (notes || [...noteDrafts.values()].some(Boolean)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  $("#refreshIcon").innerHTML = icon("refresh");
  nav();
  refresh();
  setInterval(() => {
    if (
      !document.hidden &&
      !$("#dialog").open &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
    )
      refresh();
  }, 30000);
})();
