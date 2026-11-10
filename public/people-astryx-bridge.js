/* The Astryx pilot shares the CRM's authenticated data and existing specialist actions. */

(function () {
  const view = document.createElement("section");
  view.id = "view-people-astryx";
  view.className = "view";
  view.style.cssText =
    "position:fixed;inset:var(--topbar) 0 0 var(--rail);overflow:hidden";

  const frame = document.createElement("iframe");
  frame.title = "People and contact profiles";
  frame.style.cssText =
    "width:100%;height:calc(100dvh - var(--topbar,50px));border:0;display:block";

  view.append(frame);
  document.getElementById("view-people").parentElement.append(view);

  let route = { page: "people", id: null },
    dirty = false;

  function snapshot() {
    return {
      route,
      leads: LIVE_DATA ? LEADS : [],
      people: LIVE_DATA ? PEOPLE : [],
      dataReady: LIVE_DATA,
      dataError: DEMO_REASON || "",
      search: SEARCH,
      statusOptions: STATUS_OPTIONS.map((p) => ({
        value: p[0],
        label: p[1].toLowerCase().replace(/^./, (c) => c.toUpperCase()),
      })),
      stageOptions: stageOptionsFlat().map((p) => ({
        value: p[0],
        label: p[1],
      })),
      theme: document.documentElement.dataset.theme || "light",
      accent:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim() || "#b91c1c",
    };
  }

  function notify() {
    frame.contentWindow?.postMessage(
      { type: "crm-people-update" },
      location.origin,
    );
  }

  function show(next) {
    route = next;
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("on"));
    view.classList.add("on");
    if (!frame.getAttribute("src")) frame.src = "/people-astryx.html";
    notify();
  }

  const oldPeople = openPeopleSection,
    oldLead = openLead,
    oldApply = applyLive;

  openPeopleSection = function (section) {
    if (dirty && !confirm("Discard the unsaved contact draft?")) return;
    dirty = false;
    if (["all", "client", "active_client"].includes(section || "all")) {
      oldPeople("all");
      show({ page: "people", bucket: section || "all", id: null });
    } else oldPeople(section);
  };

  openLead = function (id) {
    if (dirty && !confirm("Discard the unsaved contact draft?")) return;
    dirty = false;
    oldLead(id);
    show({ page: "profile", id });
  };

  applyLive = async function () {
    const result = await oldApply.apply(this, arguments);
    notify();
    return result;
  };

  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "style"],
  });

  new MutationObserver(notify).observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  window.CommandPeople = {
    snapshot,
    openLead,
    openPeople: () => openPeopleSection("all"),
    url: crmApi,
    refresh: () => loadLive({ force: true }),
    dirty: (value) => {
      dirty = value;
    },

    action: (action, id) => {
      if (action === "import") {
        document.getElementById("leadImportBtn")?.click();
        return;
      }
      const lead = LEADS.find((l) => l.id === id);
      if (!lead) return;
      switch (action) {
        case "appointment":
          openAppointmentModal(lead);
          break;

        case "task":
          openTaskModal(lead);
          break;

        case "assign":
          document.getElementById("ldAssignBtn")?.click();
          break;

        case "import":
          document.getElementById("leadImportBtn")?.click();
          break;

        case "tools":
          oldLead(id);
          break;

        case "messages":
          document.querySelector('.rail [data-view="messages"]')?.click();
          {
            const i = CONVOS.findIndex((c) => c.leadId === id);
            if (i >= 0) openThread(i);
          }
          break;
      }
    },
  };

  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
})();
