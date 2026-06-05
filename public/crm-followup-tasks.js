/**
 * Follow-up Plans tab + Tasks tab for Marco CRM dashboard.
 * Loaded after dashboard.html inline script (uses shared globals).
 */
(function () {
  "use strict";

  const CRM_TASK_TYPE_ICON = {
    call: "📞",
    text: "💬",
    email: "✉️",
    appointment: "📅",
    follow_up: "🔄",
    other: "⭐",
  };

  let crmTasksCache = [];
  let crmTasksLoaded = false;
  let crmTasksView = "list";
  let crmTasksFilterStat = "";
  let crmTasksFilters = {
    q: "",
    type: "",
    priority: "",
    status: "",
    assignedUserId: "",
    due: "",
    source: "",
  };
  let crmTasksSelected = new Set();
  let crmTaskEditor = null;
  let crmTaskDetailId = null;
  let crmTasksCalendarMonth = new Date();

  let crmFollowupFilterPlan = "";
  let crmFollowupFilterStatus = "";
  let crmFollowupFilterDue = "";
  let crmFollowupSearch = "";
  let crmFollowupInlinePlanId = null;

  function tasksApiUrl(path) {
    const u = new URL(path || "/api/tasks", window.location.origin);
    if (typeof token !== "undefined" && token) u.searchParams.set("token", token);
    return u.toString();
  }

  function enrollmentApiUrl(leadId, planId, action) {
    const u = new URL(
      "/api/auto-plans/enrollment/" + encodeURIComponent(leadId) + "/" + encodeURIComponent(planId) + "/" + action,
      window.location.origin,
    );
    if (typeof token !== "undefined" && token) u.searchParams.set("token", token);
    return u.toString();
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function dateKey(iso) {
    if (!iso) return "";
    const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  function daysPastDue(dueDate) {
    const t = todayKey();
    const dk = dateKey(dueDate);
    if (!dk || dk >= t) return 0;
    const a = new Date(dk + "T12:00:00").getTime();
    const b = new Date(t + "T12:00:00").getTime();
    return Math.round((b - a) / 86400000);
  }

  function dueDateClass(dueDate) {
    const dk = dateKey(dueDate);
    const t = todayKey();
    if (dk < t) return "overdue";
    if (dk === t) return "today";
    return "future";
  }

  function planStepTypeLabel(t) {
    if (t === "email") return "Email";
    if (t === "text") return "Text";
    if (t === "task") return "Task";
    return "Step";
  }

  function crmNextEnrollmentStep(plan, enr) {
    if (!plan || !plan.steps) return null;
    const completed = new Set(enr.completedSteps || []);
    const enrolledMs = new Date(enr.enrolledAt).getTime();
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (completed.has(step.id)) continue;
      const dueMs = enrolledMs + (Number(step.dayOffset) || 0) * 86400000;
      return {
        step,
        stepNum: completed.size + 1,
        total: plan.steps.length,
        dueMs,
        dueIso: new Date(dueMs).toISOString(),
      };
    }
    return null;
  }

  function crmPlanEarliestDue(plan, leads) {
    let earliest = null;
    for (const lead of leads) {
      for (const enr of lead.autoPlanEnrollments || []) {
        if (enr.planId !== plan.id || enr.status !== "active") continue;
        const n = crmNextEnrollmentStep(plan, enr);
        if (!n) continue;
        if (!earliest || n.dueMs < earliest.dueMs) earliest = n;
      }
    }
    return earliest;
  }

  function crmBuildEnrollmentRows(allLeads, plans) {
    const rows = [];
    for (const lead of allLeads) {
      for (const enr of lead.autoPlanEnrollments || []) {
        const plan = plans.find((p) => p.id === enr.planId);
        if (!plan) continue;
        rows.push({ lead, enr, plan });
      }
    }
    return rows;
  }

  function crmFollowupEnrolledCount(allLeads) {
    const activePlanIds = new Set(
      (typeof crmActiveAutoPlans === "function" ? crmActiveAutoPlans() : crmAutoPlans.filter((p) => p.active)).map(
        (p) => p.id,
      ),
    );
    const ids = new Set();
    for (const lead of allLeads) {
      for (const enr of lead.autoPlanEnrollments || []) {
        if (enr.status === "active" && activePlanIds.has(enr.planId)) ids.add(lead.id);
      }
    }
    return ids.size;
  }

  async function crmLoadTasks(force) {
    if (crmTasksLoaded && !force) return crmTasksCache;
    try {
      const res = await fetch(tasksApiUrl("/api/tasks"));
      const body = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(body.tasks)) {
        crmTasksCache = body.tasks;
        crmTasksLoaded = true;
        if (body.summary && crmCache) crmCache.tasksSummary = body.summary;
      }
    } catch (e) {
      /* keep cache */
    }
    return crmTasksCache;
  }

  function crmTasksSummaryFromCache() {
    if (crmCache && crmCache.tasksSummary) return crmCache.tasksSummary;
    const today = todayKey();
    let dueToday = 0;
    let overdue = 0;
    let pending = 0;
    let completedToday = 0;
    for (const t of crmTasksCache) {
      const dk = dateKey(t.dueDate);
      if (t.status === "pending" || t.status === "in_progress") {
        pending++;
        if (dk === today) dueToday++;
        else if (dk < today) overdue++;
      }
      if (t.status === "completed" && t.completedAt && dateKey(t.completedAt) === today) completedToday++;
    }
    return { dueToday, overdue, pending, completedToday };
  }

  function crmUpdateTasksSidebarCount() {
    const el = document.getElementById("crm-count-tasks");
    if (!el) return;
    const s = crmTasksSummaryFromCache();
    const n = (s.pending || 0) + (s.overdue || 0);
    el.textContent = String(n);
    el.classList.toggle("crm-count-hot", n > 0);
  }

  function crmUpdateFollowupSidebarCount(allLeads) {
    const el = document.getElementById("crm-count-followup");
    if (el) el.textContent = String(crmFollowupEnrolledCount(allLeads || []));
  }

  function crmCollectTaskAlerts() {
    const dismissed = typeof crmGetDismissedAlerts === "function" ? crmGetDismissedAlerts() : new Set();
    const out = [];
    const today = todayKey();
    for (const t of crmTasksCache) {
      if (t.status === "completed" || t.status === "cancelled") continue;
      const dk = dateKey(t.dueDate);
      if (dk > today) continue;
      const key = "task:" + t.id;
      if (dismissed.has(key)) continue;
      const leadName = t.leadName || "lead";
      const overdueDays = daysPastDue(t.dueDate);
      const isOverdue = dk < today;
      out.push({
        key,
        type: isOverdue ? "task_overdue" : "task_today",
        leadId: t.leadId,
        taskId: t.id,
        name: leadName,
        message: isOverdue
          ? `📋 ${t.title} for ${leadName} is overdue — ${overdueDays} day${overdueDays === 1 ? "" : "s"} past due`
          : `📋 ${t.title} for ${leadName} is due today`,
        icon: "📋",
        timestamp: t.dueDate,
        urgency: isOverdue ? "overdue" : "today",
      });
    }
    return out;
  }

  window.crmCollectTaskAlerts = crmCollectTaskAlerts;

  function crmBindTaskAlertActions(scope) {
    const root = scope || document;
    root.querySelectorAll(".crm-alert-task-complete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-task-complete");
        if (id) void crmCompleteTask(id);
      });
    });
    root.querySelectorAll(".crm-alert-task-view").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-task-view");
        if (id) {
          crmSection = "tasks";
          crmTaskDetailId = id;
          if (crmCache) renderCrm(crmCache);
        }
      });
    });
  }
  window.crmBindTaskAlertActions = crmBindTaskAlertActions;

  async function crmCompleteTask(id) {
    try {
      const res = await fetch(tasksApiUrl("/api/tasks/" + encodeURIComponent(id) + "/complete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          completedBy: crmCurrentUser ? crmCurrentUser.name : "CRM",
        }),
      });
      if (!res.ok) throw new Error("Complete failed");
      await crmLoadTasks(true);
      await loadCrm();
      crmToast("Task completed.", "success");
      if (crmCache) renderCrm(crmCache);
    } catch (e) {
      crmToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  function crmPriorityBadge(p) {
    const map = {
      urgent: ["Urgent", "urgent"],
      high: ["High", "high"],
      normal: ["Normal", "normal"],
      low: ["Low", "low"],
    };
    const [lab, cls] = map[p] || map.normal;
    return `<span class="crm-task-pri crm-task-pri-${cls}">${lab}</span>`;
  }

  function crmTaskStatusBadge(s) {
    const lab = { pending: "Pending", in_progress: "In Progress", completed: "Completed", cancelled: "Cancelled" }[s] || s;
    return `<span class="crm-task-status crm-task-status-${s}">${lab}</span>`;
  }

  function crmOpenTaskModal(task) {
    crmTaskEditor = task
      ? { ...task }
      : {
          title: "",
          type: "call",
          priority: "normal",
          status: "pending",
          dueDate: todayKey(),
          dueTime: "",
          leadId: "",
          leadName: "",
          assignedUserId: crmCurrentUser ? crmCurrentUser.id : "",
          assignedUserName: crmCurrentUser ? crmCurrentUser.name : "",
          description: "",
          reminderMinutes: undefined,
          source: "manual",
        };
    const m = document.getElementById("crm-task-modal");
    if (!m) return;
    const b = crmTaskEditor;
    document.getElementById("crm-task-modal-title").textContent = task ? "Edit Task" : "Add Task";
    document.getElementById("crm-task-title").value = b.title || "";
    document.getElementById("crm-task-type").value = b.type || "call";
    document.getElementById("crm-task-priority").value = b.priority || "normal";
    document.getElementById("crm-task-due-date").value = b.dueDate || todayKey();
    document.getElementById("crm-task-due-time").value = b.dueTime || "";
    document.getElementById("crm-task-desc").value = b.description || "";
    const leadSel = document.getElementById("crm-task-lead");
    const leads = (crmCache && crmCache.leads) || [];
    leadSel.innerHTML =
      `<option value="">— No lead —</option>` +
      leads
        .map((l) => {
          const label = (l.name || l.username || l.phone || "Lead").trim();
          return `<option value="${escapeHtml(l.id)}" ${b.leadId === l.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
        })
        .join("");
    const assignSel = document.getElementById("crm-task-assigned");
    assignSel.innerHTML =
      `<option value="">— Unassigned —</option>` +
      (crmUsers || [])
        .filter((u) => u.active)
        .map(
          (u) =>
            `<option value="${escapeHtml(u.id)}" data-name="${escapeHtml(u.name)}" ${b.assignedUserId === u.id ? "selected" : ""}>${escapeHtml(u.name)}</option>`,
        )
        .join("");
    const rem = document.getElementById("crm-task-reminder");
    const rm = b.reminderMinutes;
    rem.value = rm === 15 ? "15" : rm === 30 ? "30" : rm === 60 ? "60" : rm === 1440 ? "1440" : "";
    m.classList.add("open");
    m.setAttribute("aria-hidden", "false");
  }

  function crmCloseTaskModal() {
    crmTaskEditor = null;
    const m = document.getElementById("crm-task-modal");
    if (m) {
      m.classList.remove("open");
      m.setAttribute("aria-hidden", "true");
    }
  }

  async function crmSaveTaskModal() {
    const b = crmTaskEditor;
    if (!b) return;
    const title = document.getElementById("crm-task-title")?.value?.trim() || "";
    const dueDate = document.getElementById("crm-task-due-date")?.value || "";
    if (!title || !dueDate) {
      crmToast("Title and due date required.", "error");
      return;
    }
    const leadId = document.getElementById("crm-task-lead")?.value || "";
    const leadRow = leadId ? crmLeadById(leadId) : null;
    const assignSel = document.getElementById("crm-task-assigned");
    const assignedUserId = assignSel?.value || "";
    const opt = assignSel && assignSel.selectedIndex >= 0 ? assignSel.options[assignSel.selectedIndex] : null;
    const remVal = document.getElementById("crm-task-reminder")?.value || "";
    const reminderMinutes = remVal ? Number(remVal) : undefined;
    const payload = {
      title,
      type: document.getElementById("crm-task-type")?.value || "other",
      priority: document.getElementById("crm-task-priority")?.value || "normal",
      dueDate,
      dueTime: document.getElementById("crm-task-due-time")?.value || undefined,
      description: document.getElementById("crm-task-desc")?.value || undefined,
      leadId: leadId || undefined,
      leadName: leadRow ? leadRow.name || leadRow.username || leadRow.phone : undefined,
      assignedUserId: assignedUserId || undefined,
      assignedUserName: opt ? opt.getAttribute("data-name") || opt.textContent : undefined,
      reminderMinutes,
      source: b.source || "manual",
      status: b.status || "pending",
    };
    try {
      const url = b.id
        ? tasksApiUrl("/api/tasks/" + encodeURIComponent(b.id))
        : tasksApiUrl("/api/tasks");
      const res = await fetch(url, {
        method: b.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Save failed");
      crmCloseTaskModal();
      await crmLoadTasks(true);
      await loadCrm();
      crmToast("Task saved.", "success");
      if (crmCache) renderCrm(crmCache);
    } catch (e) {
      crmToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  function crmFilteredTasksList() {
    let list = [...crmTasksCache];
    const today = todayKey();
    const f = crmTasksFilters;
    if (crmTasksFilterStat === "dueToday") list = list.filter((t) => dateKey(t.dueDate) === today && t.status !== "completed" && t.status !== "cancelled");
    else if (crmTasksFilterStat === "overdue") list = list.filter((t) => dateKey(t.dueDate) < today && t.status !== "completed" && t.status !== "cancelled");
    else if (crmTasksFilterStat === "pending") list = list.filter((t) => t.status === "pending" || t.status === "in_progress");
    else if (crmTasksFilterStat === "completedToday") {
      list = list.filter((t) => t.status === "completed" && t.completedAt && dateKey(t.completedAt) === today);
    }
    if (f.q) {
      const q = f.q.toLowerCase();
      list = list.filter((t) => (t.title || "").toLowerCase().includes(q) || (t.leadName || "").toLowerCase().includes(q));
    }
    if (f.type) list = list.filter((t) => t.type === f.type);
    if (f.priority) list = list.filter((t) => t.priority === f.priority);
    if (f.status) list = list.filter((t) => t.status === f.status);
    if (f.assignedUserId) list = list.filter((t) => t.assignedUserId === f.assignedUserId);
    if (f.source) list = list.filter((t) => t.source === f.source);
    if (f.due === "today") list = list.filter((t) => dateKey(t.dueDate) === today);
    else if (f.due === "week") {
      const end = new Date();
      end.setDate(end.getDate() + 7);
      const endK = end.toISOString().slice(0, 10);
      list = list.filter((t) => {
        const dk = dateKey(t.dueDate);
        return dk >= today && dk <= endK;
      });
    } else if (f.due === "month") {
      const m = today.slice(0, 7);
      list = list.filter((t) => dateKey(t.dueDate).startsWith(m));
    } else if (f.due === "overdue") list = list.filter((t) => dateKey(t.dueDate) < today && t.status !== "completed" && t.status !== "cancelled");
    return list.sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
  }

  function crmPaintTasksSection(content, allLeads) {
    const s = crmTasksSummaryFromCache();
    const filtered = crmFilteredTasksList();
    content.innerHTML = `
      <div class="crm-tasks-header">
        <div>
          <div class="crm-section-head">Tasks</div>
        </div>
        <button type="button" class="crm-btn-primary" id="crm-task-add">+ Add Task</button>
      </div>
      <div class="crm-tasks-stats">
        <button type="button" class="crm-tasks-stat amber ${crmTasksFilterStat === "dueToday" ? "active" : ""}" data-task-stat="dueToday"><span class="n">${s.dueToday}</span><span class="l">Due Today</span></button>
        <button type="button" class="crm-tasks-stat red ${crmTasksFilterStat === "overdue" ? "active" : ""}" data-task-stat="overdue"><span class="n">${s.overdue}</span><span class="l">Overdue</span></button>
        <button type="button" class="crm-tasks-stat blue ${crmTasksFilterStat === "pending" ? "active" : ""}" data-task-stat="pending"><span class="n">${s.pending}</span><span class="l">Pending Total</span></button>
        <button type="button" class="crm-tasks-stat green ${crmTasksFilterStat === "completedToday" ? "active" : ""}" data-task-stat="completedToday"><span class="n">${s.completedToday}</span><span class="l">Completed Today</span></button>
      </div>
      <div class="crm-tasks-toolbar">
        <div class="crm-tasks-view-toggle">
          <button type="button" class="crm-light-btn ${crmTasksView === "list" ? "active" : ""}" data-tasks-view="list">List</button>
          <button type="button" class="crm-light-btn ${crmTasksView === "board" ? "active" : ""}" data-tasks-view="board">Board</button>
          <button type="button" class="crm-light-btn ${crmTasksView === "calendar" ? "active" : ""}" data-tasks-view="calendar">Calendar</button>
        </div>
        <input type="search" class="crm-input crm-tasks-search" id="crm-tasks-search" placeholder="Search title or lead…" value="${escapeHtml(crmTasksFilters.q)}" />
        <select class="crm-select" id="crm-tasks-f-type"><option value="">All types</option>${["call","text","email","appointment","follow_up","other"].map((t) => `<option value="${t}" ${crmTasksFilters.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
        <select class="crm-select" id="crm-tasks-f-pri"><option value="">All priorities</option>${["urgent","high","normal","low"].map((p) => `<option value="${p}" ${crmTasksFilters.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select>
        <select class="crm-select" id="crm-tasks-f-status"><option value="">All statuses</option>${["pending","in_progress","completed","cancelled"].map((st) => `<option value="${st}" ${crmTasksFilters.status === st ? "selected" : ""}>${st}</option>`).join("")}</select>
        <select class="crm-select" id="crm-tasks-f-assigned"><option value="">All assigned</option>${(crmUsers || []).filter((u) => u.active).map((u) => `<option value="${escapeHtml(u.id)}" ${crmTasksFilters.assignedUserId === u.id ? "selected" : ""}>${escapeHtml(u.name)}</option>`).join("")}</select>
        <select class="crm-select" id="crm-tasks-f-due"><option value="">Any due</option><option value="today" ${crmTasksFilters.due === "today" ? "selected" : ""}>Today</option><option value="week" ${crmTasksFilters.due === "week" ? "selected" : ""}>This week</option><option value="month" ${crmTasksFilters.due === "month" ? "selected" : ""}>This month</option><option value="overdue" ${crmTasksFilters.due === "overdue" ? "selected" : ""}>Overdue</option></select>
        <select class="crm-select" id="crm-tasks-f-source"><option value="">All sources</option><option value="manual" ${crmTasksFilters.source === "manual" ? "selected" : ""}>Manual</option><option value="auto_plan" ${crmTasksFilters.source === "auto_plan" ? "selected" : ""}>Auto Plan</option><option value="dial_session" ${crmTasksFilters.source === "dial_session" ? "selected" : ""}>Dial Session</option><option value="automation" ${crmTasksFilters.source === "automation" ? "selected" : ""}>Automation</option></select>
      </div>
      <div id="crm-tasks-bulk" class="crm-tasks-bulk" style="display:${crmTasksSelected.size ? "flex" : "none"}">
        <span>${crmTasksSelected.size} selected</span>
        <button type="button" class="crm-light-btn" id="crm-tasks-bulk-complete">Complete All</button>
        <button type="button" class="crm-light-btn" id="crm-tasks-bulk-delete">Delete All</button>
        <select class="crm-select" id="crm-tasks-bulk-reassign"><option value="">Reassign…</option>${(crmUsers || []).filter((u) => u.active).map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join("")}</select>
        <select class="crm-select" id="crm-tasks-bulk-pri"><option value="">Priority…</option>${["urgent","high","normal","low"].map((p) => `<option value="${p}">${p}</option>`).join("")}</select>
      </div>
      <div id="crm-tasks-body"></div>`;

    const body = content.querySelector("#crm-tasks-body");
    if (crmTasksView === "board") crmRenderTasksBoard(body, filtered);
    else if (crmTasksView === "calendar") crmRenderTasksCalendar(body, filtered);
    else crmRenderTasksList(body, filtered);

    content.querySelector("#crm-task-add")?.addEventListener("click", () => crmOpenTaskModal(null));
    content.querySelectorAll("[data-task-stat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.getAttribute("data-task-stat") || "";
        crmTasksFilterStat = crmTasksFilterStat === k ? "" : k;
        renderCrm(crmCache);
      });
    });
    content.querySelectorAll("[data-tasks-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        crmTasksView = btn.getAttribute("data-tasks-view") || "list";
        renderCrm(crmCache);
      });
    });
    const bindFilter = (id, key) => {
      content.querySelector(id)?.addEventListener("change", (e) => {
        crmTasksFilters[key] = e.target.value;
        renderCrm(crmCache);
      });
    };
    bindFilter("#crm-tasks-f-type", "type");
    bindFilter("#crm-tasks-f-pri", "priority");
    bindFilter("#crm-tasks-f-status", "status");
    bindFilter("#crm-tasks-f-assigned", "assignedUserId");
    bindFilter("#crm-tasks-f-due", "due");
    bindFilter("#crm-tasks-f-source", "source");
    content.querySelector("#crm-tasks-search")?.addEventListener("input", (e) => {
      crmTasksFilters.q = e.target.value;
      renderCrm(crmCache);
    });
    content.querySelector("#crm-tasks-bulk-complete")?.addEventListener("click", () => void crmBulkCompleteTasks());
    content.querySelector("#crm-tasks-bulk-delete")?.addEventListener("click", () => void crmBulkDeleteTasks());
    content.querySelector("#crm-tasks-bulk-reassign")?.addEventListener("change", (e) => {
      if (e.target.value) void crmBulkReassignTasks(e.target.value);
      e.target.value = "";
    });
    content.querySelector("#crm-tasks-bulk-pri")?.addEventListener("change", (e) => {
      if (e.target.value) void crmBulkPriorityTasks(e.target.value);
      e.target.value = "";
    });

    if (crmTaskDetailId) crmOpenTaskDetailPanel(crmTaskDetailId);
  }

  function crmRenderTasksList(body, list) {
    const rows = list
      .map((t) => {
        const icon = CRM_TASK_TYPE_ICON[t.type] || "⭐";
        const dc = dueDateClass(t.dueDate);
        const sel = crmTasksSelected.has(t.id) ? " checked" : "";
        const leadCell = t.leadId
          ? `<button type="button" class="crm-link-btn" data-task-lead="${escapeHtml(t.leadId)}">${escapeHtml(t.leadName || "Lead")}</button>`
          : "—";
        return `<tr class="crm-task-row" data-task-id="${escapeHtml(t.id)}">
          <td onclick="event.stopPropagation()"><input type="checkbox" class="crm-task-check" data-task-check="${escapeHtml(t.id)}"${sel} /></td>
          <td>${icon}</td>
          <td><button type="button" class="crm-link-btn" data-task-open="${escapeHtml(t.id)}">${escapeHtml(t.title)}</button></td>
          <td onclick="event.stopPropagation()">${leadCell}</td>
          <td>${crmPriorityBadge(t.priority)}</td>
          <td><span class="crm-task-due ${dc}">${escapeHtml(fmtDate(t.dueDate))}</span></td>
          <td>${t.assignedUserName ? escapeHtml(t.assignedUserName) : "—"}</td>
          <td>${crmTaskStatusBadge(t.status)}</td>
          <td onclick="event.stopPropagation()">
            ${t.status !== "completed" ? `<button type="button" class="crm-light-btn" data-task-complete="${escapeHtml(t.id)}">✓</button>` : ""}
            <button type="button" class="crm-light-btn" data-task-edit="${escapeHtml(t.id)}">✏️</button>
            <button type="button" class="crm-light-btn" data-task-del="${escapeHtml(t.id)}">🗑️</button>
          </td>
        </tr>`;
      })
      .join("");
    body.innerHTML = `<div class="crm-table-wrap"><table class="crm-table crm-tasks-table"><thead><tr>
      <th></th><th></th><th>Task</th><th>Lead</th><th>Priority</th><th>Due</th><th>Assigned</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody>${rows || '<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--muted);">No tasks match filters.</td></tr>'}</tbody></table></div>`;
    crmBindTasksTable(body);
  }

  function crmRenderTasksBoard(body, list) {
    const cols = ["pending", "in_progress", "completed", "cancelled"];
    const html = cols
      .map((st) => {
        const cards = list
          .filter((t) => t.status === st)
          .map(
            (t) => `<div class="crm-task-card" draggable="true" data-task-card="${escapeHtml(t.id)}">
              <div class="crm-task-card-title">${escapeHtml(t.title)}</div>
              <div class="crm-task-card-meta">${CRM_TASK_TYPE_ICON[t.type] || "⭐"} ${t.leadName ? escapeHtml(t.leadName) : ""} ${crmPriorityBadge(t.priority)}</div>
              <div class="crm-task-due ${dueDateClass(t.dueDate)}">${escapeHtml(fmtDate(t.dueDate))}</div>
            </div>`,
          )
          .join("");
        return `<div class="crm-task-col" data-task-col="${st}">
          <div class="crm-task-col-head">${st.replace("_", " ")} <span>${list.filter((t) => t.status === st).length}</span></div>
          <div class="crm-task-col-body">${cards}</div>
          <button type="button" class="crm-light-btn crm-task-col-add" data-task-add-col="${st}">+ Add Task</button>
        </div>`;
      })
      .join("");
    body.innerHTML = `<div class="crm-task-board">${html}</div>`;
    body.querySelectorAll("[data-task-card]").forEach((card) => {
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", card.getAttribute("data-task-card") || "");
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      card.addEventListener("click", () => {
        const id = card.getAttribute("data-task-card");
        if (id) {
          crmTaskDetailId = id;
          crmOpenTaskDetailPanel(id);
        }
      });
    });
    body.querySelectorAll(".crm-task-col").forEach((col) => {
      col.addEventListener("dragover", (e) => {
        e.preventDefault();
        col.classList.add("drag-over");
      });
      col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("drag-over");
        const id = e.dataTransfer.getData("text/plain");
        const st = col.getAttribute("data-task-col");
        if (!id || !st) return;
        try {
          await fetch(tasksApiUrl("/api/tasks/" + encodeURIComponent(id)), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: st }),
          });
          await crmLoadTasks(true);
          renderCrm(crmCache);
        } catch (err) {
          crmToast("Could not update task.", "error");
        }
      });
    });
    body.querySelectorAll("[data-task-add-col]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const st = btn.getAttribute("data-task-add-col");
        crmOpenTaskModal({ status: st || "pending" });
      });
    });
  }

  function crmRenderTasksCalendar(body, list) {
    const y = crmTasksCalendarMonth.getFullYear();
    const m = crmTasksCalendarMonth.getMonth();
    const first = new Date(y, m, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = todayKey();
    let cells = "";
    for (let i = 0; i < startPad; i++) cells += `<div class="crm-cal-cell empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dk = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dayTasks = list.filter((t) => dateKey(t.dueDate) === dk);
      const chips = dayTasks
        .slice(0, 3)
        .map(
          (t) =>
            `<span class="crm-cal-chip pri-${t.priority}" data-cal-task="${escapeHtml(t.id)}" title="${escapeHtml(t.title)}">${escapeHtml(t.title.slice(0, 12))}</span>`,
        )
        .join("");
      const more = dayTasks.length > 3 ? `<span class="crm-cal-more">+${dayTasks.length - 3}</span>` : "";
      cells += `<div class="crm-cal-cell ${dk === today ? "today" : ""}" data-cal-day="${dk}">
        <div class="crm-cal-day-num">${d}</div>${chips}${more}</div>`;
    }
    body.innerHTML = `<div class="crm-cal-wrap">
      <div class="crm-cal-nav">
        <button type="button" class="crm-light-btn" id="crm-cal-prev">←</button>
        <span>${first.toLocaleString("default", { month: "long", year: "numeric" })}</span>
        <button type="button" class="crm-light-btn" id="crm-cal-next">→</button>
      </div>
      <div class="crm-cal-grid"><div class="crm-cal-dow">Sun</div><div class="crm-cal-dow">Mon</div><div class="crm-cal-dow">Tue</div><div class="crm-cal-dow">Wed</div><div class="crm-cal-dow">Thu</div><div class="crm-cal-dow">Fri</div><div class="crm-cal-dow">Sat</div>${cells}</div>
      <div class="crm-cal-sidebar" id="crm-cal-sidebar"><p class="crm-muted">Click a day to see tasks.</p></div>
    </div>`;
    body.querySelector("#crm-cal-prev")?.addEventListener("click", () => {
      crmTasksCalendarMonth = new Date(y, m - 1, 1);
      renderCrm(crmCache);
    });
    body.querySelector("#crm-cal-next")?.addEventListener("click", () => {
      crmTasksCalendarMonth = new Date(y, m + 1, 1);
      renderCrm(crmCache);
    });
    body.querySelectorAll("[data-cal-day]").forEach((cell) => {
      cell.addEventListener("click", () => {
        const dk = cell.getAttribute("data-cal-day");
        const dayTasks = list.filter((t) => dateKey(t.dueDate) === dk);
        const side = body.querySelector("#crm-cal-sidebar");
        if (!side) return;
        side.innerHTML = `<h4>${escapeHtml(dk)}</h4>${dayTasks.map((t) => `<div class="crm-cal-side-item"><button type="button" class="crm-link-btn" data-task-open="${escapeHtml(t.id)}">${escapeHtml(t.title)}</button> ${crmPriorityBadge(t.priority)}</div>`).join("") || "<p class='crm-muted'>No tasks</p>"}`;
        side.querySelectorAll("[data-task-open]").forEach((btn) => {
          btn.addEventListener("click", () => {
            crmTaskDetailId = btn.getAttribute("data-task-open");
            crmOpenTaskDetailPanel(crmTaskDetailId);
          });
        });
      });
    });
    body.querySelectorAll("[data-cal-task]").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        crmTaskDetailId = chip.getAttribute("data-cal-task");
        crmOpenTaskDetailPanel(crmTaskDetailId);
      });
    });
  }

  function crmBindTasksTable(scope) {
    scope.querySelectorAll(".crm-task-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.getAttribute("data-task-check");
        if (!id) return;
        if (cb.checked) crmTasksSelected.add(id);
        else crmTasksSelected.delete(id);
        renderCrm(crmCache);
      });
    });
    scope.querySelectorAll("[data-task-open]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        crmTaskDetailId = btn.getAttribute("data-task-open");
        crmOpenTaskDetailPanel(crmTaskDetailId);
      });
    });
    scope.querySelectorAll("[data-task-lead]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-task-lead");
        if (id) crmOpenLeadDrawer(id);
      });
    });
    scope.querySelectorAll("[data-task-complete]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void crmCompleteTask(btn.getAttribute("data-task-complete"));
      });
    });
    scope.querySelectorAll("[data-task-edit]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = crmTasksCache.find((x) => x.id === btn.getAttribute("data-task-edit"));
        if (t) crmOpenTaskModal(t);
      });
    });
    scope.querySelectorAll("[data-task-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void crmDeleteTask(btn.getAttribute("data-task-del"));
      });
    });
    scope.querySelectorAll(".crm-task-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        const id = tr.getAttribute("data-task-id");
        if (id) {
          crmTaskDetailId = id;
          crmOpenTaskDetailPanel(id);
        }
      });
    });
  }

  async function crmDeleteTask(id) {
    if (!id) return;
    if (!crmCan("canDeleteTasks")) {
      crmToast("You do not have permission to delete tasks.", "error");
      return;
    }
    if (!confirm("Delete this task?")) return;
    try {
      const u = new URL(tasksApiUrl("/api/tasks/" + encodeURIComponent(id)));
      if (crmCurrentUser) u.searchParams.set("userId", crmCurrentUser.id);
      const res = await fetch(u.toString(), { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      await crmLoadTasks(true);
      await loadCrm();
      crmToast("Task deleted.", "success");
      if (crmCache) renderCrm(crmCache);
    } catch (e) {
      crmToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  async function crmBulkCompleteTasks() {
    for (const id of crmTasksSelected) await crmCompleteTask(id);
    crmTasksSelected.clear();
  }

  async function crmBulkDeleteTasks() {
    if (!crmCan("canDeleteTasks")) {
      crmToast("You do not have permission to delete tasks.", "error");
      return;
    }
    if (!confirm("Delete selected tasks?")) return;
    for (const id of crmTasksSelected) await crmDeleteTask(id);
    crmTasksSelected.clear();
  }

  async function crmBulkReassignTasks(userId) {
    const u = (crmUsers || []).find((x) => x.id === userId);
    for (const id of crmTasksSelected) {
      await fetch(tasksApiUrl("/api/tasks/" + encodeURIComponent(id)), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedUserId: userId, assignedUserName: u ? u.name : "" }),
      });
    }
    crmTasksSelected.clear();
    await crmLoadTasks(true);
    renderCrm(crmCache);
  }

  async function crmBulkPriorityTasks(pri) {
    for (const id of crmTasksSelected) {
      await fetch(tasksApiUrl("/api/tasks/" + encodeURIComponent(id)), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: pri }),
      });
    }
    crmTasksSelected.clear();
    await crmLoadTasks(true);
    renderCrm(crmCache);
  }

  function crmOpenTaskDetailPanel(id) {
    const t = crmTasksCache.find((x) => x.id === id);
    const panel = document.getElementById("crm-task-detail");
    if (!t || !panel) return;
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    panel.innerHTML = `
      <div class="crm-task-detail-head">
        <h3>${escapeHtml(t.title)}</h3>
        <button type="button" class="crm-drawer-close" id="crm-task-detail-close">×</button>
      </div>
      <div class="crm-task-detail-body">
        <p>${crmTaskStatusBadge(t.status)} ${crmPriorityBadge(t.priority)}</p>
        <p><b>Due:</b> <span class="crm-task-due ${dueDateClass(t.dueDate)}">${escapeHtml(fmtDate(t.dueDate))}</span></p>
        <p><b>Type:</b> ${escapeHtml(t.type)} · <b>Source:</b> ${escapeHtml(t.source || "manual")}</p>
        ${t.leadId ? `<p><b>Lead:</b> <button type="button" class="crm-link-btn" id="crm-task-detail-lead">${escapeHtml(t.leadName || "View lead")}</button></p>` : ""}
        <p>${escapeHtml(t.description || "")}</p>
        <div class="crm-task-detail-actions">
          ${t.status !== "completed" ? `<button type="button" class="crm-btn-primary" id="crm-task-detail-complete">Complete</button>` : ""}
          <button type="button" class="crm-light-btn" id="crm-task-detail-edit">Edit</button>
        </div>
        <div class="crm-muted" style="margin-top:1rem;font-size:0.72rem;">Activity log and comments coming soon.</div>
      </div>`;
    panel.querySelector("#crm-task-detail-close")?.addEventListener("click", () => {
      panel.classList.remove("open");
      crmTaskDetailId = null;
    });
    panel.querySelector("#crm-task-detail-complete")?.addEventListener("click", () => void crmCompleteTask(t.id));
    panel.querySelector("#crm-task-detail-edit")?.addEventListener("click", () => crmOpenTaskModal(t));
    panel.querySelector("#crm-task-detail-lead")?.addEventListener("click", () => {
      if (t.leadId) crmOpenLeadDrawer(t.leadId);
    });
  }

  function crmDrawerTasksHtml(row) {
    const tasks = crmTasksCache.filter((t) => t.leadId === row.id);
    if (!tasks.length)
      return `<p class="crm-muted">No tasks linked.</p><button type="button" class="crm-light-btn" id="pf-task-add">+ Add Task</button>`;
    const rows = tasks
      .map(
        (t) => `<div class="crm-drawer-task-row">
          <span>${CRM_TASK_TYPE_ICON[t.type] || "⭐"} ${escapeHtml(t.title)}</span>
          <span class="crm-task-due ${dueDateClass(t.dueDate)}">${escapeHtml(fmtDate(t.dueDate))}</span>
          <button type="button" class="crm-light-btn" data-pf-task-complete="${escapeHtml(t.id)}">✓</button>
          <button type="button" class="crm-light-btn" data-pf-task-edit="${escapeHtml(t.id)}">Edit</button>
        </div>`,
      )
      .join("");
    return `${rows}<button type="button" class="crm-light-btn" id="pf-task-add" style="margin-top:0.5rem;">+ Add Task</button>`;
  }

  function crmBindDrawerTasks(row) {
    const wrap = document.getElementById("pf-tasks");
    if (!wrap) return;
    wrap.querySelector("#pf-task-add")?.addEventListener("click", () => {
      crmOpenTaskModal({
        leadId: row.id,
        leadName: row.name || row.username || row.phone,
        status: "pending",
        source: "manual",
      });
    });
    wrap.querySelectorAll("[data-pf-task-complete]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void crmCompleteTask(btn.getAttribute("data-pf-task-complete"));
      });
    });
    wrap.querySelectorAll("[data-pf-task-edit]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = crmTasksCache.find((x) => x.id === btn.getAttribute("data-pf-task-edit"));
        if (t) crmOpenTaskModal(t);
      });
    });
  }

  window.crmDrawerTasksHtml = crmDrawerTasksHtml;
  window.crmBindDrawerTasks = crmBindDrawerTasks;

  async function crmRenderFollowupSection(content, allLeads) {
    await loadAutoPlans();
    const plans = typeof crmActiveAutoPlans === "function" ? crmActiveAutoPlans() : crmAutoPlans.filter((p) => p.active);
    let rows = crmBuildEnrollmentRows(allLeads, crmAutoPlans);
    const enrolledLeadCount = crmFollowupEnrolledCount(allLeads);

    if (crmFollowupFilterPlan) rows = rows.filter((r) => r.enr.planId === crmFollowupFilterPlan);
    if (crmFollowupFilterStatus) rows = rows.filter((r) => r.enr.status === crmFollowupFilterStatus);
    if (crmFollowupSearch) {
      const q = crmFollowupSearch.toLowerCase();
      rows = rows.filter((r) => {
        const name = (r.lead.name || r.lead.username || r.lead.phone || "").toLowerCase();
        return name.includes(q);
      });
    }
    if (crmFollowupFilterDue) {
      const today = todayKey();
      rows = rows.filter((r) => {
        const n = crmNextEnrollmentStep(r.plan, r.enr);
        if (!n) return crmFollowupFilterDue === "upcoming" ? false : false;
        const dk = dateKey(n.dueIso);
        if (crmFollowupFilterDue === "today") return dk === today;
        if (crmFollowupFilterDue === "overdue") return dk < today;
        if (crmFollowupFilterDue === "upcoming") return dk > today;
        return true;
      });
    }

    const planCards = plans
      .map((p) => {
        const enrolled = crmEnrolledLeadCount(p.id);
        const earliest = crmPlanEarliestDue(p, allLeads);
        const tagBadge = p.tag
          ? (() => {
              const tpl = crmTagTemplateByName(p.tag);
              const fg = tpl ? crmTagContrastText(tpl.color) : "#fff";
              const bg = tpl ? tpl.color : "#6b7280";
              return `<span class="crm-tag-badge" style="background:${bg};color:${fg};">${escapeHtml(p.tag)}</span>`;
            })()
          : "";
        return `<div class="crm-fu-plan-card">
          <div class="crm-fu-plan-name">${escapeHtml(p.name)} ${tagBadge}</div>
          <div class="crm-fu-plan-meta"><span>${enrolled} enrolled</span><span>${(p.steps || []).length} steps</span></div>
          <div class="crm-fu-plan-next">${earliest ? "Next: " + escapeHtml(fmtDate(earliest.dueIso)) : "No due steps"}</div>
          <div class="crm-fu-plan-actions">
            <button type="button" class="crm-light-btn" data-fu-edit-plan="${escapeHtml(p.id)}">Edit Plan</button>
            <button type="button" class="crm-light-btn" data-fu-view-enrolled="${escapeHtml(p.id)}">View Enrolled</button>
          </div>
        </div>`;
      })
      .join("");

    const inlineEditor =
      crmFollowupInlinePlanId && crmPlanBuilder
        ? `<div class="crm-fu-inline-editor" id="crm-fu-inline-editor"></div>`
        : "";

    const tableRows = rows
      .map(({ lead, enr, plan }) => {
        const name = lead.name || lead.username || lead.phone || "Lead";
        const n = crmNextEnrollmentStep(plan, enr);
        const curStep = n
          ? `Step ${n.stepNum} of ${n.total} — Day ${n.step.dayOffset} ${planStepTypeLabel(n.step.type)}`
          : enr.status === "completed"
            ? "Completed"
            : "—";
        let nextAction = "—";
        let nextDate = "—";
        let dateCls = "";
        if (n) {
          const t = n.step.type;
          if (t === "email") nextAction = `${n.step.subject || "Email"} on ${fmtDate(n.dueIso)}`;
          else if (t === "text") nextAction = `Text on ${fmtDate(n.dueIso)}`;
          else nextAction = `${n.step.content || "Task"} on ${fmtDate(n.dueIso)}`;
          nextDate = fmtDate(n.dueIso);
          dateCls = dueDateClass(n.dueIso);
        }
        const statusCls = enr.status === "active" ? "active" : enr.status === "paused" ? "paused" : "completed";
        return `<tr class="crm-fu-row" data-fu-lead="${escapeHtml(lead.id)}">
          <td><button type="button" class="crm-link-btn" data-fu-open-lead="${escapeHtml(lead.id)}">${escapeHtml(name)}</button></td>
          <td>${escapeHtml(plan.name)}</td>
          <td>${plan.tag ? escapeHtml(plan.tag) : "—"}</td>
          <td>${fmtDate(enr.enrolledAt)}</td>
          <td>${escapeHtml(curStep)}</td>
          <td>${escapeHtml(nextAction)}</td>
          <td><span class="crm-fu-due ${dateCls}">${escapeHtml(nextDate)}</span></td>
          <td><span class="crm-fu-status ${statusCls}">${escapeHtml(enr.status)}</span></td>
          <td onclick="event.stopPropagation()">
            ${enr.status === "paused" ? `<button type="button" class="crm-light-btn" data-fu-resume="${escapeHtml(lead.id)}:${escapeHtml(enr.planId)}">Resume</button>` : enr.status === "active" ? `<button type="button" class="crm-light-btn" data-fu-pause="${escapeHtml(lead.id)}:${escapeHtml(enr.planId)}">Pause</button>` : ""}
            ${enr.status !== "completed" ? `<button type="button" class="crm-light-btn" data-fu-skip="${escapeHtml(lead.id)}:${escapeHtml(enr.planId)}">Skip Step</button>` : ""}
            <button type="button" class="crm-light-btn" data-fu-unenroll="${escapeHtml(lead.id)}:${escapeHtml(enr.planId)}">Unenroll</button>
          </td>
        </tr>`;
      })
      .join("");

    const emptyState =
      rows.length === 0
        ? `<div class="crm-fu-empty">
            <p>No leads enrolled in any Auto Plan yet</p>
            <button type="button" class="crm-light-btn" id="crm-fu-browse-plans">Browse Plans</button>
            <button type="button" class="crm-btn-primary" id="crm-fu-enroll-first">Enroll Your First Lead</button>
          </div>`
        : "";

    content.innerHTML = `
      <div class="crm-fu-header">
        <div>
          <div class="crm-section-head">Follow-up Plans</div>
          <div class="crm-section-sub">${enrolledLeadCount} lead${enrolledLeadCount === 1 ? "" : "s"} enrolled in at least one active plan</div>
        </div>
        <div class="crm-fu-header-actions">
          <button type="button" class="crm-light-btn" id="crm-fu-manage-plans">Manage Plans</button>
          <button type="button" class="crm-btn-primary" id="crm-fu-enroll-lead">+ Enroll Lead</button>
        </div>
      </div>
      <div class="crm-fu-plan-strip">${planCards || '<p class="crm-muted">No active auto plans.</p>'}</div>
      ${inlineEditor}
      <div class="crm-fu-filters">
        <select class="crm-select" id="crm-fu-f-plan"><option value="">All plans</option>${crmAutoPlans.map((p) => `<option value="${escapeHtml(p.id)}" ${crmFollowupFilterPlan === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select>
        <select class="crm-select" id="crm-fu-f-status"><option value="">All statuses</option><option value="active" ${crmFollowupFilterStatus === "active" ? "selected" : ""}>Active</option><option value="paused" ${crmFollowupFilterStatus === "paused" ? "selected" : ""}>Paused</option><option value="completed" ${crmFollowupFilterStatus === "completed" ? "selected" : ""}>Completed</option></select>
        <select class="crm-select" id="crm-fu-f-due"><option value="">All next actions</option><option value="today" ${crmFollowupFilterDue === "today" ? "selected" : ""}>Due Today</option><option value="overdue" ${crmFollowupFilterDue === "overdue" ? "selected" : ""}>Overdue</option><option value="upcoming" ${crmFollowupFilterDue === "upcoming" ? "selected" : ""}>Upcoming</option></select>
        <input type="search" class="crm-input" id="crm-fu-search" placeholder="Search lead name…" value="${escapeHtml(crmFollowupSearch)}" />
      </div>
      ${emptyState}
      <div class="crm-table-wrap" style="${rows.length ? "" : "display:none"}"><table class="crm-table"><thead><tr>
        <th>Lead Name</th><th>Plan</th><th>Tag</th><th>Enrolled</th><th>Current Step</th><th>Next Action</th><th>Next Date</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody>${tableRows}</tbody></table></div>`;

    content.querySelector("#crm-fu-manage-plans")?.addEventListener("click", () => {
      crmSection = "plans";
      renderCrm(crmCache);
    });
    content.querySelector("#crm-fu-browse-plans")?.addEventListener("click", () => {
      crmSection = "plans";
      renderCrm(crmCache);
    });
    content.querySelector("#crm-fu-enroll-first")?.addEventListener("click", () => crmOpenEnrollPickerModal());
    content.querySelector("#crm-fu-enroll-lead")?.addEventListener("click", () => crmOpenEnrollPickerModal());
    content.querySelector("#crm-fu-f-plan")?.addEventListener("change", (e) => {
      crmFollowupFilterPlan = e.target.value;
      renderCrm(crmCache);
    });
    content.querySelector("#crm-fu-f-status")?.addEventListener("change", (e) => {
      crmFollowupFilterStatus = e.target.value;
      renderCrm(crmCache);
    });
    content.querySelector("#crm-fu-f-due")?.addEventListener("change", (e) => {
      crmFollowupFilterDue = e.target.value;
      renderCrm(crmCache);
    });
    content.querySelector("#crm-fu-search")?.addEventListener("input", (e) => {
      crmFollowupSearch = e.target.value;
      renderCrm(crmCache);
    });
    content.querySelectorAll("[data-fu-edit-plan]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-fu-edit-plan");
        const plan = crmAutoPlans.find((p) => p.id === id);
        if (!plan) return;
        crmFollowupInlinePlanId = id;
        crmPlanBuilder = JSON.parse(JSON.stringify(plan));
        renderCrm(crmCache);
      });
    });
    content.querySelectorAll("[data-fu-view-enrolled]").forEach((btn) => {
      btn.addEventListener("click", () => {
        crmFollowupFilterPlan = btn.getAttribute("data-fu-view-enrolled") || "";
        renderCrm(crmCache);
      });
    });
    content.querySelectorAll("[data-fu-open-lead]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        crmOpenLeadDrawer(btn.getAttribute("data-fu-open-lead"));
      });
    });
    content.querySelectorAll(".crm-fu-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        const id = tr.getAttribute("data-fu-lead");
        if (id) crmOpenLeadDrawer(id);
      });
    });
    crmBindFollowupEnrollmentActions(content);

    if (crmFollowupInlinePlanId && crmPlanBuilder) {
      const ed = content.querySelector("#crm-fu-inline-editor");
      if (ed) crmRenderFollowupInlineEditor(ed);
    }
  }

  function crmRenderFollowupInlineEditor(ed) {
    const b = crmPlanBuilder;
    const tagOpts = (typeof crmTagTemplates !== "undefined" ? crmTagTemplates : [])
      .map((t) => `<option value="${escapeHtml(t.name)}" ${b.tag === t.name ? "selected" : ""}>${escapeHtml(t.name)}</option>`)
      .join("");
    const stepsHtml = (b.steps || []).map((s, i) => crmPlanStepHtml(s, i)).join("");
    ed.innerHTML = `
      <div class="crm-plan-builder">
        <div class="crm-plan-builder-row">
          <div class="crm-form-field" style="flex:1;"><label>Plan name</label><input id="crm-fu-plan-name" type="text" value="${escapeHtml(b.name || "")}" /></div>
          <div class="crm-form-field"><label>Tag</label><select id="crm-fu-plan-tag"><option value="">—</option>${tagOpts}</select></div>
          <label class="crm-switch"><input type="checkbox" id="crm-fu-plan-active" ${b.active ? "checked" : ""} /><span class="crm-switch-slider"></span></label>
        </div>
        <div id="crm-plan-steps" class="crm-plan-steps">${stepsHtml}</div>
        <button type="button" class="crm-light-btn" id="crm-fu-plan-add-step">+ Add Step</button>
        <div class="crm-plan-builder-foot">
          <button type="button" class="crm-light-btn" id="crm-fu-plan-cancel">Cancel</button>
          <button type="button" class="crm-btn-primary" id="crm-fu-plan-save">Save Plan</button>
        </div>
      </div>`;
    ed.querySelector("#crm-fu-plan-cancel")?.addEventListener("click", () => {
      crmFollowupInlinePlanId = null;
      crmPlanBuilder = null;
      renderCrm(crmCache);
    });
    ed.querySelector("#crm-fu-plan-add-step")?.addEventListener("click", () => {
      b.steps = b.steps || [];
      b.steps.push({ id: crmStepGenId(), type: "text", dayOffset: 0, content: "", assignedTo: "Marco Puga" });
      renderCrm(crmCache);
    });
    ed.querySelector("#crm-fu-plan-save")?.addEventListener("click", async () => {
      b.name = ed.querySelector("#crm-fu-plan-name")?.value || "";
      b.tag = ed.querySelector("#crm-fu-plan-tag")?.value || "";
      b.active = !!ed.querySelector("#crm-fu-plan-active")?.checked;
      crmReadPlanStepsFromDom(ed);
      try {
        const res = await fetch(autoPlansApiUrl("/api/auto-plans/" + encodeURIComponent(b.id)), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: b.name, tag: b.tag, active: b.active, steps: b.steps }),
        });
        if (!res.ok) throw new Error("Save failed");
        await loadAutoPlans();
        crmFollowupInlinePlanId = null;
        crmPlanBuilder = null;
        crmToast("Plan saved.", "success");
        renderCrm(crmCache);
      } catch (e) {
        crmToast(e instanceof Error ? e.message : String(e), "error");
      }
    });
    crmBindPlanStepControls(ed);
  }

  function crmBindFollowupEnrollmentActions(scope) {
    scope.querySelectorAll("[data-fu-pause]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const [lid, pid] = (btn.getAttribute("data-fu-pause") || "").split(":");
        void crmEnrollmentAction(lid, pid, "pause");
      });
    });
    scope.querySelectorAll("[data-fu-resume]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const [lid, pid] = (btn.getAttribute("data-fu-resume") || "").split(":");
        void crmEnrollmentAction(lid, pid, "resume");
      });
    });
    scope.querySelectorAll("[data-fu-skip]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const [lid, pid] = (btn.getAttribute("data-fu-skip") || "").split(":");
        void crmEnrollmentAction(lid, pid, "skip-step");
      });
    });
    scope.querySelectorAll("[data-fu-unenroll]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const [lid, pid] = (btn.getAttribute("data-fu-unenroll") || "").split(":");
        if (!confirm("Remove this lead from the plan?")) return;
        void crmUnenrollLead(lid, pid);
      });
    });
  }

  async function crmEnrollmentAction(leadId, planId, action) {
    try {
      const res = await fetch(enrollmentApiUrl(leadId, planId, action), { method: "POST" });
      if (!res.ok) throw new Error("Action failed");
      await loadCrm();
      crmToast("Enrollment updated.", "success");
      if (crmCache) renderCrm(crmCache);
    } catch (e) {
      crmToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  function crmOpenEnrollPickerModal() {
    const m = document.getElementById("crm-enroll-modal");
    if (!m) return;
    const leads = (crmCache && crmCache.leads) || [];
    const plans = typeof crmActiveAutoPlans === "function" ? crmActiveAutoPlans() : [];
    document.getElementById("crm-enroll-lead-select").innerHTML = leads
      .map((l) => {
        const label = (l.name || l.username || l.phone || "Lead").trim();
        return `<option value="${escapeHtml(l.id)}">${escapeHtml(label)}</option>`;
      })
      .join("");
    document.getElementById("crm-enroll-plan-select").innerHTML = plans
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
      .join("");
    m.classList.add("open");
    m.setAttribute("aria-hidden", "false");
  }

  function crmCloseEnrollPickerModal() {
    const m = document.getElementById("crm-enroll-modal");
    if (m) {
      m.classList.remove("open");
      m.setAttribute("aria-hidden", "true");
    }
  }

  const notifiedReminders = new Set();

  function crmCheckTaskReminders() {
    const now = Date.now();
    for (const t of crmTasksCache) {
      if (!t.reminderMinutes || t.status === "completed" || t.status === "cancelled") continue;
      const due = new Date((t.dueDate || "") + (t.dueTime ? "T" + t.dueTime : "T09:00:00")).getTime();
      const remindAt = due - t.reminderMinutes * 60000;
      if (remindAt > now || due < now - 3600000) continue;
      const key = t.id + ":" + remindAt;
      if (notifiedReminders.has(key)) continue;
      if (remindAt <= now && remindAt > now - 3600000) {
        notifiedReminders.add(key);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("Task reminder", { body: t.title + (t.leadName ? " — " + t.leadName : "") });
        }
      }
    }
  }

  function crmInitTaskNotifications() {
    if (window.__crmTaskNotifInit) return;
    window.__crmTaskNotifInit = true;
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    setInterval(crmCheckTaskReminders, 60000);
    crmCheckTaskReminders();
  }

  window.crmRenderFollowupSection = crmRenderFollowupSection;
  window.crmRenderTasksSection = async function (content, allLeads) {
    await crmLoadTasks();
    crmUpdateTasksSidebarCount();
    crmPaintTasksSection(content, allLeads);
  };

  window.crmUpdateTasksSidebarCount = crmUpdateTasksSidebarCount;
  window.crmUpdateFollowupSidebarCount = crmUpdateFollowupSidebarCount;
  window.crmLoadTasks = crmLoadTasks;
  window.crmInitTaskNotifications = crmInitTaskNotifications;
  window.crmOpenTaskModal = crmOpenTaskModal;
  window.crmCloseTaskModal = crmCloseTaskModal;
  window.crmSaveTaskModal = crmSaveTaskModal;
  window.crmOpenEnrollPickerModal = crmOpenEnrollPickerModal;
  window.crmCloseEnrollPickerModal = crmCloseEnrollPickerModal;

  function crmBindTaskModalsOnce() {
    if (window.__crmTaskModalsBound) return;
    window.__crmTaskModalsBound = true;
    document.getElementById("crm-task-modal-close")?.addEventListener("click", crmCloseTaskModal);
    document.getElementById("crm-task-modal-discard")?.addEventListener("click", crmCloseTaskModal);
    document.getElementById("crm-task-modal-save")?.addEventListener("click", () => void crmSaveTaskModal());
    document.getElementById("crm-task-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "crm-task-modal") crmCloseTaskModal();
    });
    document.getElementById("crm-enroll-modal-close")?.addEventListener("click", crmCloseEnrollPickerModal);
    document.getElementById("crm-enroll-modal-discard")?.addEventListener("click", crmCloseEnrollPickerModal);
    document.getElementById("crm-enroll-confirm")?.addEventListener("click", async () => {
      const lid = document.getElementById("crm-enroll-lead-select")?.value;
      const pid = document.getElementById("crm-enroll-plan-select")?.value;
      if (lid && pid) {
        await crmEnrollLead(lid, pid);
        crmCloseEnrollPickerModal();
        if (crmSection === "followup" && crmCache) renderCrm(crmCache);
      }
    });
    document.getElementById("crm-enroll-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "crm-enroll-modal") crmCloseEnrollPickerModal();
    });
  }
  window.crmBindTaskModalsOnce = crmBindTaskModalsOnce;
})();
