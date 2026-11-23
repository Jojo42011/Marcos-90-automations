import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";

import { createRoot } from "react-dom/client";

import { Theme } from "@astryxdesign/core/theme";

import {
  Layout,
  LayoutHeader,
  LayoutContent,
  VStack,
  HStack,
  StackItem,
  Section,
} from "@astryxdesign/core/Layout";

import { Text, Heading } from "@astryxdesign/core/Text";

import { MoreMenu } from "@astryxdesign/core/MoreMenu";

import { Button } from "@astryxdesign/core/Button";

import { Avatar } from "@astryxdesign/core/Avatar";

import { Table } from "@astryxdesign/core/Table";


import { TextInput } from "@astryxdesign/core/TextInput";

import { DateInput } from "@astryxdesign/core/DateInput";

import { TimeInput } from "@astryxdesign/core/TimeInput";

import { TextArea } from "@astryxdesign/core/TextArea";

import { Selector } from "@astryxdesign/core/Selector";

import { TabList, Tab } from "@astryxdesign/core/TabList";

import {
  MetadataList,
  MetadataListItem,
} from "@astryxdesign/core/MetadataList";

import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";

import { Divider } from "@astryxdesign/core/Divider";

import { Collapsible } from "@astryxdesign/core/Collapsible";

import { useMediaQuery } from "@astryxdesign/core/hooks";

import { commandTheme } from "../shared/theme";

import "@astryxdesign/core/reset.css";

import "@astryxdesign/core/astryx.css";

type Row = Record<string, any>;

const bridge = (window.parent as any).CommandPeople;

const label = (s: any) => {
  const value = String(s || "Not set").replaceAll("_", " ");
  return (value === value.toUpperCase() ? value.toLowerCase() : value).replace(
    /^./,
    (c) => c.toUpperCase(),
  );
};

const stageText = (row: Row, options: {value:string,label:string}[]) =>
  options.find(o=>o.value === (row.crmStage || row.stage))?.label || label(row.crmStage || row.stage || row.stageLabel);

const date = (s: any) =>
  s && !isNaN(Date.parse(s))
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(s))
    : "Not recorded";

async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(bridge?.url(path) || path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const d = await r.json().catch(() => ({
    error: "Unexpected response. Please refresh and try again.",
  }));

  if (!r.ok) throw Error(d.error || "This request could not be completed.");
  return d;
}

type ScheduleFacts = { task?: Row; appointment?: Row };
type DeskFacts = { phoneFlagsReady?: boolean; schedules?: Map<string, ScheduleFacts>; metrics?: Record<string, Row> };

const centralClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function centralNow(instant = new Date()) {
  const parts = Object.fromEntries(centralClock.formatToParts(instant).map(p => [p.type,p.value]));
  return parts.year + "-" + parts.month + "-" + parts.day + "T" + parts.hour + ":" + parts.minute;
}
function scheduleKey(t: Row, endOfDay = false) {
  return t.dueDate + "T" + (t.dueTime || (endOfDay ? "23:59" : "00:00"));
}
function dueAt(task: Row) {
  return new Date(task.dueDate + "T" + (task.dueTime || "00:00"));
}

function useDeskFacts(ready: boolean) {
  const path = bridge?.url("/api/crm-tasks");
  const [result, setResult] = useState<{path: string; facts: DeskFacts}>();
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!ready || !path) return;
    let active = true;
    async function load() {
      const [tasks, metrics] = await Promise.allSettled([
        api("/api/crm-tasks"), api("/api/crm/lead-metrics"),
      ]);
      if (!active) return;
      const facts: DeskFacts = {};
      if (metrics.status === "fulfilled") {
        facts.metrics = metrics.value.metrics;
        facts.phoneFlagsReady = metrics.value.phoneFlagsReady === true;
      }
      if (tasks.status === "fulfilled" && Array.isArray(tasks.value.tasks)) {
        facts.schedules = new Map();
        for (const t of tasks.value.tasks) {
          if (!t.leadId || !t.dueDate || !Number.isFinite(+dueAt(t)) ||
              !["pending", "in_progress", "due_soon", "overdue"].includes(t.status)) continue;
          const key = t.type === "appointment" ? "appointment" : "task";
          if (key === "appointment" && (["cancelled", "completed"].includes(t.appointmentStatus) ||
              scheduleKey(t,true) < centralNow())) continue;
          const factsForLead = facts.schedules.get(t.leadId) || {};
          if (!factsForLead[key] || +dueAt(t) < +dueAt(factsForLead[key]!)) factsForLead[key] = t;
          facts.schedules.set(t.leadId, factsForLead);
        }
      }
      setResult({ path, facts });
    }
    void load();
    return () => { active = false; };
  }, [path, ready, revision]);
  return { ...(ready && result?.path === path ? result?.facts : {}), refresh };
}

function dueCue(task: Row) {
  const due = dueAt(task);
  const now = centralNow();
  const overdue = task.dueDate < now.slice(0,10);
  const day = task.dueDate === now.slice(0,10) ? "Today" :
    due.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return [overdue && "Overdue", day, task.dueTime && task.dueTime + " CT"].filter(Boolean).join(" · ");
}

function scheduleText(task: Row | undefined, loaded: boolean) {
  return task ? [task.title || label(task.type), dueCue(task)].join(" · ") : loaded ? "None scheduled" : "Unavailable";
}

const channels: Record<string, string> = {
  call: "Call", call_made: "Call", email_sent: "Email sent", email_logged: "Email logged",
  text_sent: "Text sent", text_received: "Text received", text_logged: "Text logged",
};
function lastTouch(row: Row, metrics?: Row) {
  const touches: {at: string; title: string}[] = [];
  for (const a of row.activity || []) {
    if (channels[a.type]) touches.push({at: a.timestamp,
      title: [channels[a.type], a.meta?.Outcome ? label(a.meta.Outcome) : a.subType].filter(Boolean).join(" · ")});
  }
  for (const m of row._msgs || []) {
    if (!m.text || !["user","assistant"].includes(m.role)) continue;
    const channel = ({ instagram: "Instagram DM", tiktok: "TikTok DM", sms: "SMS", email: "Email" } as Record<string,string>)[row.channel] || "Message";
    touches.push({at: m.at, title: channel + (m.role === "user" ? " received" : " sent")});
  }
  if (metrics?.lastSmsAt) touches.push({at: metrics.lastSmsAt, title: metrics.lastSmsDirection === "inbound" ? "SMS received" : "SMS sent"});
  return touches.filter(t => Number.isFinite(Date.parse(t.at))).sort((a,b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

function blockedNumber(r: Row, metrics?: Row) {
  return Boolean(r.tags?.some((tag: string) => /^(do.not.call|dnc)$/i.test(tag)) || metrics?.primaryPhoneDnc || metrics?.phoneAllDnc);
}

function ContactActions({row, facts}: {row: Row; facts: DeskFacts}) {
  const blocked = blockedNumber(row, facts.metrics?.[row.id]);
  return <HStack gap={1} wrap="wrap" vAlign="center">
    {blocked ? <Text type="supporting">Do not call</Text> : null}
    {["call","text"].map(action => <Button key={action} size="sm" variant="secondary"
      label={label(action)} tooltip={blocked ? "Do not call" : !facts.phoneFlagsReady ? "Phone flags unavailable" : label(action) + " · " + row.name}
      isDisabled={!row.phone || !facts.phoneFlagsReady || blocked} onClick={() => bridge.action(action, row.id)} />)}
  </HStack>;
}

function Fact({title, value}: {title: string; value: string}) {
  return <VStack gap={1}><Text type="supporting" color="secondary">{title}</Text><Text weight="semibold">{value}</Text></VStack>;
}

function Qualification({lead, record}: {lead: Row; record: Row}) {
  const c = lead.criteria || {};
  const intent = lead.crmIntent;
  const money = (n: unknown) => n != null && n !== "" && Number.isFinite(Number(n)) ?
    Number(n).toLocaleString("en-US", {style:"currency", currency:"USD", maximumFractionDigits:0}) : undefined;
  const sections = [
    { show: ["buyer","buyer_seller"].includes(intent), title: "Buyer qualification", values: [
      ["Budget cap",money(c.priceCap)],["Areas",c.area],["Timeline",c.timeline],
      ["Financing",record.financing && label(record.financing)],["Bedrooms",c.beds],
      ["Bathrooms",c.baths],["Recorded property views",record.propertyViews],
      ["Property inquiry",lead.propertyInquired],
    ] },
    { show: ["seller","buyer_seller"].includes(intent), title: "Seller property", values: [
      ["Property",lead.deal?.address || lead.propertyInquired],["Listing status",record.listing?.status || (lead.listingStatus && label(lead.listingStatus))],
      ["List price",money(record.listing?.listPrice)],["Deal value",money(lead.deal?.value)],["Target close",lead.deal?.closeDate],
      ["Property type",record.listing?.propertyType],["Deal notes",lead.deal?.notes],
    ] },
  ];
  return <>{sections.filter(section => section.show).map(section => {
    const fields = section.values.filter(([,v]) => v != null && v !== "");
    return <Section key={section.title}><VStack gap={3}><Heading level={2}>{section.title}</Heading>
      {fields.length ? <HStack gap={6} wrap="wrap">{fields.map(([k,v]) => <Fact key={k} title={k} value={String(v)} />)}</HStack> :
        <Text color="secondary">No details recorded.</Text>}</VStack></Section>;
  })}</>;
}

function useSnapshot() {
  const [state, setState] = useState(
    () =>
      bridge?.snapshot() || {
        leads: [],
        people: [],
        route: { page: "people" },
        theme: "light",
        accent: "#b91c1c",
      },
  );

  useEffect(() => {
    const update = (e?: MessageEvent) => {
      if (
        e &&
        (e.source !== window.parent ||
          e.origin !== location.origin ||
          e.data?.type !== "crm-people-update")
      )
        return;
      setState(bridge.snapshot());
    };
    window.addEventListener("message", update);
    const timer = setInterval(() => update(), 15000);
    return () => {
      window.removeEventListener("message", update);
      clearInterval(timer);
    };
  }, []);
  return state;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Section variant="muted" padding={4}>
      <Text role="status">{children}</Text>
    </Section>
  );
}

// In-memory view state survives opening a profile; nothing is stored across accounts.
const peopleView = {query:'',source:'all',status:'all',sort:'az',page:1,filters:false,scope:'all'};
function People({ snapshot }: { snapshot: any }) {
  const [bucket, setBucket] = useState(snapshot.route.bucket || "all"),
    [query, setQuery] = useState(peopleView.query),
    [source, setSource] = useState(peopleView.source),
    [status, setStatus] = useState(peopleView.status),
    [sort, setSort] = useState(peopleView.sort),
    [page, setPage] = useState(1),
    [filters, setFilters] = useState(peopleView.filters),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  useEffect(()=>{Object.assign(peopleView,{query,source,status,sort,page,filters});},[query,source,status,sort,page,filters]);
  const [scope, setScope] = useState(peopleView.scope);
  useEffect(() => { peopleView.scope = scope; }, [scope]);
  const narrow = useMediaQuery("(max-width: 700px)");
  const followUps = useDeskFacts(snapshot.dataReady);

  const all = useMemo(() => {
    const leads = new Map(snapshot.leads.map((l: Row) => [l.id, l]));
    return snapshot.people.map((p: Row) => ({
      ...(leads.get(p.id) as Row),
      ...p,
    }));
  }, [snapshot.people, snapshot.leads]);

  const categories = [
    ["all", "All People"],
    ["client", "Clients"],
    ["active_client", "Active Clients"],
  ];

  const inBucket = (r: Row, b: string) => {
    const archived =
      ["archived", "trashed", "dead", "unresponsive"].includes(r.crmStatus) ||
      r.cat === "archived";
    const past =
      ["closed", "sale_closed", "past_client"].includes(r.stage) ||
      r.crmStatus === "past_client";
    const client = past || r.cat === "client";
    return b === "archived"
      ? archived
      : !archived &&
          (b === "all" || (b === "client" ? client : client && !past));
  };
  const today = centralNow().slice(0,10);
  const inScope = (r: Row) => {
    if (scope === "mine") return Boolean(snapshot.viewerId && r.assignedUserId === snapshot.viewerId);
    if (scope === "new") return r.crmStatus === "new";
    if (scope === "due" || scope === "overdue") {
      const due = followUps.schedules?.get(r.id)?.task?.dueDate;
      return Boolean(due && (scope === "due" ? due === today : due < today));
    }
    return true;
  };
  const rows = all
    .filter(
      (r: Row) =>
        inBucket(r, bucket) && inScope(r) &&
        (source === "all" || r.source === source) &&
        (status === "all" || r.status === status) &&
        [r.name, r.email, r.phone, r.address, r.source].some((v) =>
          String(v || "")
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    )
    .sort((a: Row, b: Row) =>
      sort === "recent"
        ? String(b.lastActivity || "").localeCompare(
            String(a.lastActivity || ""),
          )
        : String(a.name || "").localeCompare(String(b.name || ""), undefined, {
            sensitivity: "base",
            numeric: true,
          }) * (sort === "za" ? -1 : 1),
    );

  const pages = Math.max(1, Math.ceil(rows.length / 25)),
    current = Math.min(page, pages);

  useEffect(() => setPage(1), [bucket, query, source, status, sort, scope]);

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      await bridge.refresh();
      followUps.refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const [calling, setCalling] = useState(false);
  const callInDialer = async () => {
    setCalling(true);
    try {
      const name =
        categories.find((c) => c[0] === bucket)?.[1] || "Archived people";
      await bridge.callInDialer(
        rows.map((r: Row) => r.id),
        query || scope !== "all" || source !== "all" || status !== "all"
          ? name + " · filtered"
          : name,
      );
    } finally {
      setCalling(false);
    }
  };

  const [editing, setEditing] = useState<Row | null>(null);
  const [statusValue, setStatusValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const editStatus = (r: Row) => {
    setSaveError(""); setStatusValue(r.crmStatus || ""); setEditing(r);
  };
  const saveStatus = async () => {
    if (!editing || saving) return;
    const patch: Row = {};
    if (statusValue && statusValue !== editing.crmStatus) patch.crmStatus = statusValue;
    setSaving(true);
    try {
      if (Object.keys(patch).length) await api("/api/crm/lead/" + encodeURIComponent(editing.id), "PATCH", patch);
      await bridge.refresh(); setEditing(null);
    } catch (e: any) { setSaveError(e.message); } finally { setSaving(false); }
  };
  const [changingStage, setChangingStage] = useState("");
  const saveStage = async (r: Row, value: string) => {
    if (changingStage || value === (r.crmStage || r.stage)) return;
    setChangingStage(r.id);
    setError("");
    try {
      await api("/api/crm/lead/" + encodeURIComponent(r.id), "PATCH", { crmStage: value });
      await bridge.refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setChangingStage("");
    }
  };
  const columns = [
    { key:"name", header:"Person", renderCell:(r: Row) => <VStack gap={1}>
      <HStack><Button variant="ghost" label={r.name || "Unnamed contact"} onClick={() => bridge.openLead(r.id)} /></HStack>
      <Text type="supporting">{[r.crmIntent && label(r.crmIntent),r.source].filter(Boolean).join(" · ") || "Source not recorded"}</Text>
      <Text type="supporting" color="secondary">{r.assignedUserName || "Unassigned"}</Text></VStack> },
    { key:"stage", header:"Stage", renderCell:(r: Row) => <VStack gap={1}>
      <HStack><Selector label={"Stage for " + r.name} isLabelHidden variant="ghost"
        isDisabled={Boolean(changingStage)} value={r.crmStage || r.stage || ""}
        options={withCurrent(snapshot.stageOptions, r.crmStage || r.stage || "")}
        onChange={value => saveStage(r,value)} /></HStack>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button size="sm" variant="ghost" label={snapshot.statusOptions.find((o: Row) => o.value === r.crmStatus)?.label || label(r.crmStatus || r.status)}
          tooltip={"Edit status for " + r.name} onClick={() => editStatus(r)} />
        {r.latestStageChange?.to === (r.crmStage || r.stage) && Number.isFinite(Date.parse(r.latestStageChange.at)) ?
          <Text type="supporting" color="secondary">Since {new Date(r.latestStageChange.at).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</Text> : null}
      </HStack></VStack> },
    { key:"touch", header:"Last touch", renderCell:(r: Row) => {
      const touch = lastTouch(r,followUps.metrics?.[r.id]);
      return <VStack gap={1}><Text>{touch?.title || (followUps.metrics ? "No recorded touch" : "Unavailable")}</Text>
        {touch && <Text type="supporting" color="secondary">{date(touch.at)}</Text>}</VStack>;
    }},
    { key:"next", header:"Next step", renderCell:(r: Row) => {
      const schedule = followUps.schedules?.get(r.id);
      const next = [schedule?.task,schedule?.appointment].filter((t): t is Row => Boolean(t)).sort((a,b)=>+dueAt(a)-+dueAt(b))[0];
      return <VStack gap={1}><Text weight="semibold">{next?.title || (followUps.schedules ? "None scheduled" : "Unavailable")}</Text>
        {next && <Text type="supporting" color="secondary">{dueCue(next)}</Text>}</VStack>;
    }},
    { key:"actions", header:"", renderCell:(r: Row) => {
      const dnc = blockedNumber(r, followUps.metrics?.[r.id]);
      const disabled = dnc || !r.phone || !followUps.phoneFlagsReady;
      return <HStack gap={2} vAlign="center">
        {dnc && <Text type="supporting">Do not call</Text>}
        <MoreMenu size="sm" label={"Actions for " + r.name} items={[
          {label:"Call", isDisabled:disabled, onClick:() => bridge.action("call",r.id)},
          {label:"Text", isDisabled:disabled, onClick:() => bridge.action("text",r.id)},
          {label:"Messages", onClick:() => bridge.action("messages",r.id)},
        ]} />
      </HStack>;
    } },
  ];

  return (
    <>
    <Layout
      padding={4}
      header={
        <LayoutHeader hasDivider>
          <VStack gap={3}>
            <HStack hAlign="between" vAlign="center" wrap="wrap">
              <VStack gap={2}>
                <Heading level={1}>
                  {categories.find((c) => c[0] === bucket)?.[1] ||
                    "Archived people"}
                </Heading>
                <Text color="secondary">
                  {rows.length.toLocaleString()} {rows.length===1?'person':'people'}
                  {query || scope !== "all" || source !== "all" || status !== "all"
                    ? " matching your filters"
                    : " in your workspace"}
                </Text>
              </VStack>

            </HStack>
            <HStack gap={2} vAlign="end" wrap="wrap">
              <Selector label="People category" isLabelHidden value={bucket} onChange={setBucket}
                options={[...categories, ["archived", "Archived people"]].map(([value, name]) => ({
                  value, label: name + " (" + all.filter((r: Row) => inBucket(r, value)).length + ")"
                }))} />
              <TextInput label="Search people" isLabelHidden placeholder="Search people"
                value={query} onChange={setQuery} hasClear />
              <Selector
                label="Sort people"
                isLabelHidden
                variant="secondary"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "az", label: "Name · A–Z" },
                  { value: "za", label: "Name · Z–A" },
                  { value: "recent", label: "Recent activity" },
                ]}
              />
              <Button
                label={filters ? "Hide filters" : "Filters"}
                onClick={() => setFilters(!filters)}
              />
              <HStack gap={2} wrap="wrap">
                <Button
                  label={busy ? "Refreshing…" : "Refresh"}
                  isDisabled={busy}
                  onClick={refresh}
                />
                <Button
                  label="Call in Dialer"
                  isLoading={calling}
                  isDisabled={!rows.length}
                  tooltip="Open these people as a Dialer calling list"
                  onClick={callInDialer}
                />
                <Button
                  label="Import people"
                  variant="primary"
                  onClick={() => bridge.action("import", snapshot.leads[0]?.id)}
                />
              </HStack>
            </HStack>
            <TabList value={scope} onChange={setScope}>
              <Tab value="all" label="All" />
              {snapshot.viewerId && <Tab value="mine" label="My leads" />}
              <Tab value="due" label="Due today" />
              <Tab value="overdue" label="Overdue" />
              <Tab value="new" label="New" />
            </TabList>
            {filters ? (
              <HStack gap={4} wrap="wrap">
                <Selector
                  label="Source"
                  value={source}
                  onChange={setSource}
                  hasSearch
                  options={[
                    { value: "all", label: "All sources" },
                    ...[
                      ...new Set<string>(
                        all.map((r: Row) => r.source).filter(Boolean),
                      ),
                    ]
                      .sort()
                      .map((s) => ({ value: s, label: s })),
                  ]}
                />
                <Selector
                  label="Status"
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: "all", label: "All statuses" },
                    ...[
                      ...new Set<string>(
                        all.map((r: Row) => r.status).filter(Boolean),
                      ),
                    ]
                      .sort()
                      .map((s) => ({ value: s, label: label(s) })),
                  ]}
                />
                <Button
                  label="Clear filters"
                  variant="ghost"
                  onClick={() => {
                    setSource("all");
                    setStatus("all");
                    setQuery("");
                  }}
                />
              </HStack>
            ) : null}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <VStack gap={6}>
            {!snapshot.dataReady ? (
              <Notice>
                {snapshot.dataError
                  ? "Your contacts could not load. Use Refresh to try again."
                  : "Loading your contacts…"}
              </Notice>
            ) : null}
            {(scope === "due" || scope === "overdue") && !followUps.schedules && <Notice>Task dates are unavailable. Use Refresh to retry.</Notice>}
            {error ? <Notice>{error}</Notice> : null}
            {narrow ? rows.slice((current - 1) * 25, current * 25).map((r: Row) => (
              <VStack key={r.id} gap={3}>
                <HStack hAlign="between" vAlign="start" wrap="wrap">{columns[0].renderCell(r)}{columns[1].renderCell(r)}</HStack>
                <HStack gap={6} wrap="wrap">
                  <VStack gap={1}><Text type="supporting" color="secondary">Next step</Text>{columns[3].renderCell(r)}</VStack>
                  <VStack gap={1}><Text type="supporting" color="secondary">Last touch</Text>{columns[2].renderCell(r)}</VStack>
                </HStack>
                {columns[4].renderCell(r)}<Divider />
              </VStack>
            )) : (<Table
              data={rows.slice((current - 1) * 25, current * 25)}
              columns={columns}
              idKey="id"
              density="spacious"
              dividers="rows"
              hasHover
              rowCount={rows.length}
              rowIndexStart={(current - 1) * 25 + 1}
            />)}
            <HStack hAlign="between" vAlign="center">
              <Text type="supporting" color="secondary">
                {rows.length
                  ? `${(current - 1) * 25 + 1}–${Math.min(current * 25, rows.length)} of ${rows.length}`
                  : "No matching people"}
              </Text>
              <HStack gap={3}>
                <Button
                  label="Previous"
                  isDisabled={current <= 1}
                  onClick={() => setPage(current - 1)}
                />
                <Text type="supporting">
                  Page {current} of {pages}
                </Text>
                <Button
                  label="Next"
                  isDisabled={current >= pages}
                  onClick={() => setPage(current + 1)}
                />
              </HStack>
            </HStack>
          </VStack>
        </LayoutContent>
      }
    />
    {editing && <Dialog isOpen onOpenChange={open => { if (!open && !saving) setEditing(null); }} purpose="form" width="28rem">
      <DialogHeader title={"Edit status · " + editing.name} />
      <VStack gap={4} padding={4}>
        <Selector label="Status" value={statusValue} onChange={setStatusValue} options={withCurrent(snapshot.statusOptions, statusValue)} />
        {saveError && <Notice>{saveError}</Notice>}
        <HStack gap={2}><Button label="Cancel" isDisabled={saving} onClick={()=>setEditing(null)} />
          <Button label="Save status" variant="primary" isDisabled={saving} onClick={saveStatus} /></HStack>
      </VStack>
    </Dialog>}</>
  );
}

function Profile({ lead, snapshot }: { lead: Row; snapshot: any }) {
  const id = lead.id,
    base = "/api/crm/lead/" + encodeURIComponent(id);

  const [record, setRecord] = useState<Row>({}),
    [items, setItems] = useState<Row[]>([]),
    [brief, setBrief] = useState<Row | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [tab, setTab] = useState("activity"),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState(false),
    [form, setForm] = useState<Row>({}),
    [activityFilter, setActivityFilter] = useState("history"),
    [schedule, setSchedule] = useState("");

  const followUps = useDeskFacts(snapshot.dataReady);

  const revision = useRef(0);
  const [historyError, setHistoryError] = useState(false);
  const [visibleCount, setVisibleCount] = useState(30);
  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++revision.current;
    const current = () => !signal?.aborted && revision.current === generation;
    setError("");
    setHistoryError(false);
    setLoading(true);
    await Promise.all([
      api(base + "/record").then(result => {
        if (current()) setRecord(result.record || {});
      }).catch(() => {
        if (current()) setError("Contact details could not load.");
      }),
      api(base + "/timeline").then(result => {
        if (current()) setItems(result.items || []);
      }).catch(() => {
        if (current()) setHistoryError(true);
      }).finally(() => {
        if (current()) setLoading(false);
      }),
      api(base + "/brief").then(result => {
        if (current()) setBrief(result);
      }).catch(() => {
        if (current()) setNotice("The contact brief could not load.");
      }),
    ]);
  }, [base]);

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => { c.abort(); revision.current++; };
  }, [load]);

  useEffect(() => {
    bridge.dirty(Boolean(draft || edit || schedule));
    return () => bridge.dirty(false);
  }, [draft, edit, schedule]);

  const change = (key: string, value: string) =>
    setForm((p) => ({ ...p, [key]: value }));

  const openEdit = () => {
    setForm({
      name: lead.name || "",
      source: lead.source || "",
      crmIntent: lead.crmIntent || lead.intent || "buyer",
      crmStatus: lead.crmStatus || "new",
      crmStage: lead.crmStage || lead.stage || "new_lead",
      tags: (lead.tags || []).join(", "),
    });
    setEdit(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("Enter a name before saving.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(base, "PATCH", {
        ...form,
        tags: form.tags
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean),
      });
      setEdit(false);
      await bridge.refresh();
      await load();
      setNotice("Contact updated.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(base + "/notes", "POST", {
        body: draft.trim(),
        hiddenFromViewers: true,
      });
      setDraft("");
      setNotice("Note saved to this contact.");
      await load();
      await bridge.refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    setBusy(true);
    setError("");
    try {
      setBrief(await api(base + "/brief", "POST"));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const latest = lastTouch(lead, followUps.metrics?.[id]);
  const scheduled = followUps.schedules?.get(id);
  const showing = record.showing;
  const upcomingShowing = showing && showing.confirmationStatus !== "cancelled" && Date.parse(showing.scheduledAt) >= Date.now() &&
    (!scheduled?.appointment || centralNow(new Date(showing.scheduledAt)) < scheduleKey(scheduled.appointment));
  const shown = items.filter(
    (i) => activityFilter === "history" ? ["call","email","text","note","stage"].includes(i.category) : activityFilter === "all" || i.category === activityFilter,
  );

  const contact = (
    <VStack gap={6}>
      <Section>
        <VStack gap={5}>
          <HStack hAlign="between" vAlign="center">
            <Heading level={2}>Contact details</Heading>
            <Button
              label="Edit"
              size="sm"
              variant="ghost"
              onClick={() => setTab("details")}
            />
          </HStack>
          <MetadataList>
            <MetadataListItem label="Phone">
              <Text>{lead.phone || "Not collected"}</Text>
            </MetadataListItem>
            <MetadataListItem label="Email">
              <Text>{lead.email || "Not collected"}</Text>
            </MetadataListItem>
            <MetadataListItem label="Address">
              <Text>{lead.address || "Not provided"}</Text>
            </MetadataListItem>
            <MetadataListItem label="Source">
              <Text>{lead.source || "Unknown"}</Text>
            </MetadataListItem>
            <MetadataListItem label="Assigned to">
              <Text>{lead.assignedUserName || "Unassigned"}</Text>
            </MetadataListItem>
          </MetadataList>
          <Button
            label="Manage assignment"
            variant="ghost"
            onClick={() => bridge.action("assign", id)}
          />
        </VStack>
      </Section>
      <Section>
        <VStack gap={5}>
          <HStack hAlign="between">
            <Heading level={2}>Pipeline</Heading>
            <Button
              label="Update"
              size="sm"
              variant="ghost"
              onClick={openEdit}
            />
          </HStack>
          <MetadataList>
            <MetadataListItem label="Stage">
              <Text>
                {stageText(lead, snapshot.stageOptions)}
              </Text>
            </MetadataListItem>
            <MetadataListItem label="Status">
              <Text>{label(lead.crmStatus || lead.statusDisp)}</Text>
            </MetadataListItem>
            <MetadataListItem label="Intent">
              <Text>{label(lead.crmIntent || lead.intent)}</Text>
            </MetadataListItem>
            <MetadataListItem label="Added">
              <Text>{date(lead.createdAt)}</Text>
            </MetadataListItem>
          </MetadataList>
        </VStack>
      </Section>
      <Section>
        <VStack gap={4}>
          <Heading level={2}>Follow through</Heading>
          <Button
            label="Schedule appointment"
            onClick={() => setSchedule("appointment")}
          />
          <Button
            label="Add follow-up task"
            onClick={() => setSchedule("call")}
          />
          <Button
            label="Messages"
            onClick={() => bridge.action("messages", id)}
          />
          <Collapsible
            defaultIsOpen={false}
            trigger={<Text weight="semibold">More contact tools</Text>}
          >
            <VStack gap={3} paddingBlock={3}>
              <Text type="supporting" color="secondary">
                Documents, agreements, relationships, campaigns and specialized
                contact actions remain available.
              </Text>
              <Button
                label="Open contact tools"
                onClick={() => bridge.action("tools", id)}
              />
            </VStack>
          </Collapsible>
        </VStack>
      </Section>
    </VStack>
  );

  const harvey = (
    <Section variant="muted">
      <VStack gap={5}>
        <HStack hAlign="between" vAlign="center" wrap="wrap">
          <VStack gap={1}>
            <Heading level={2}>Harvey</Heading>
            <Text type="supporting" color="secondary">
              A useful next step, grounded in this relationship.
            </Text>
          </VStack>
          <Button
            label={
              busy
                ? "Reviewing…"
                : brief?.brief
                  ? "Refresh brief"
                  : "Review contact"
            }
            isDisabled={busy}
            onClick={review}
          />
        </HStack>
        {brief?.brief ? (
          <VStack gap={4}>
            <Text>{brief.brief.summary}</Text>
            {brief.brief.recommendations?.map((r: Row, i: number) => (
              <VStack key={i} gap={2}>
                <Text weight="semibold">{r.action}</Text>
                <Text color="secondary">{r.reason}</Text>
                {r.evidenceIds?.length ? (
                  <Collapsible
                    defaultIsOpen={false}
                    trigger={<Text type="supporting">Supporting history</Text>}
                  >
                    <VStack gap={3} paddingBlock={3}>
                      {r.evidenceIds.map((key: string) => {
                        const e = brief.context?.evidence?.find(
                          (e: Row) => e.id === key,
                        );
                        return e ? (
                          <VStack key={key} gap={1}>
                            <Text>{e.text}</Text>
                            <Text type="supporting" color="secondary">
                              {e.source} · {date(e.at)}
                            </Text>
                          </VStack>
                        ) : null;
                      })}
                    </VStack>
                  </Collapsible>
                ) : null}
              </VStack>
            ))}
            <Text type="supporting" color="secondary">
              {brief.context?.coverage?.included || 0} synced history entries
              reviewed.{" "}
              {brief.context?.coverage?.olderOmitted
                ? `${brief.context.coverage.olderOmitted} older entries outside this brief.`
                : ""}
            </Text>
          </VStack>
        ) : (
          <Text color="secondary">
            Review the available conversation, notes and tasks to identify the
            next helpful action.
          </Text>
        )}
      </VStack>
    </Section>
  );

  return (
    <>
      <Layout
        padding={4}
        header={
          <LayoutHeader hasDivider>
            <VStack gap={6}>
              <HStack>
                <Button
                  label="Back to People"
                  variant="ghost"
                  onClick={() => bridge.openPeople()}
                />
              </HStack>
              <HStack gap={6} vAlign="center" wrap="wrap">
                <HStack gap={4} vAlign="center">
                  <Avatar
                    name={lead.name || "Unnamed contact"}
                    size="lg"
                    tooltip={false}
                  />
                  <VStack gap={2}>
                    <Heading level={1}>
                      {lead.name || "Unnamed contact"}
                    </Heading>
                    <Text color="secondary">
                      {[lead.crmIntent && label(lead.crmIntent),lead.source,lead.assignedUserName || "Unassigned"].filter(Boolean).join(" · ")}
                    </Text>
                  </VStack>
                </HStack>
                <HStack gap={2} wrap="wrap">
                  <ContactActions row={lead} facts={followUps} />
                  <Button label="Edit contact" onClick={openEdit} />
                  <Button
                    label="Schedule appointment"
                    variant="primary"
                    onClick={() => setSchedule("appointment")}
                  />
                </HStack>
              </HStack>
              <HStack gap={6} wrap="wrap">
                <VStack gap={1}><Text type="supporting" color="secondary">Pipeline stage</Text><Text weight="semibold">{stageText(lead, snapshot.stageOptions)}</Text></VStack>
                <Fact title="Last touch" value={latest ? latest.title + " · " + date(latest.at) : followUps.metrics ? "No recorded touch" : "Unavailable"} />
                <VStack gap={2}><Fact title="Next task" value={scheduleText(scheduled?.task, Boolean(followUps.schedules))} /><Button label="Add follow-up" size="sm" variant="ghost" onClick={() => setSchedule("call")} /></VStack>
                <Fact title="Upcoming appointment" value={upcomingShowing ? [showing.address,date(showing.scheduledAt)].filter(Boolean).join(" · ") : scheduleText(scheduled?.appointment, Boolean(followUps.schedules))} />
              </HStack>
            </VStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent>
            <VStack gap={6}>
              <TabList value={tab} onChange={setTab} hasDivider>
                <Tab value="activity" label="Activity" />
                <Tab value="notes" label="Notes" />
                <Tab value="details" label="Details" />
              </TabList>

            {error ? <Notice>{error}</Notice> : null}
              {notice ? <Notice>{notice}</Notice> : null}
              {loading ? <Notice>Loading contact history…</Notice> : null}
              {tab === "activity" ? (
                <>
                  <Qualification lead={lead} record={record} />
                  <Section>
                    <VStack gap={5}>
                      <HStack hAlign="between" vAlign="center" wrap="wrap">
                        <Heading level={2}>Conversation & activity</Heading>
                        <Button label="Add note" size="sm" variant="ghost" onClick={() => setTab("notes")} />
                        <Selector
                          label="Activity type"
                          isLabelHidden
                          value={activityFilter}
                          onChange={value => { setActivityFilter(value); setVisibleCount(30); }}
                          options={[
                            "history",
                            "all",
                            "text",
                            "call",
                            "email",
                            "appointment",
                            "task",
                            "note",
                            "stage",
                            "web",
                          ].map((v) => ({
                            value: v,
                            label: v === "all" ? "All activity" : v === "history" ? "Contact history" : label(v),
                          }))}
                        />
                      </HStack>
                      {historyError ? <Notice>Contact history could not load.</Notice> : loading && !shown.length ? <Notice>Loading contact history.</Notice> : shown.length ? (
                        shown.slice(0, visibleCount).map((item: Row, index: number) => (
                          <VStack key={item.id} gap={2} paddingBlock={2}>
                            {(index === 0 || new Date(item.at).toDateString() !== new Date(shown[index-1].at).toDateString()) && <Heading level={3}>{new Date(item.at).toLocaleDateString(undefined, {weekday:"short",month:"short",day:"numeric",year:"numeric"})}</Heading>}
                            <HStack hAlign="between" wrap="wrap">
                              <Text weight="semibold">
                                {item.title || label(item.category)}
                              </Text>
                              <Text type="supporting" color="secondary">
                                {label(item.category)} · {new Date(item.at).toLocaleTimeString(undefined, {hour:"numeric",minute:"2-digit"})}
                              </Text>
                            </HStack>
                            <Text color="secondary">
                              {typeof item.body === "string"
                                ? item.body
                                : item.description || ""}
                            </Text>
                            {item.category === "stage" && item.detail && <Text>{label(item.detail.From)} → {label(item.detail.To)}</Text>}
                            {(item.detail?.Outcome || item.subType) && <Text type="supporting">{label(item.detail?.Outcome || item.subType)}</Text>}
                            {item.author ? (
                              <Text type="supporting" color="secondary">
                                {item.author}
                              </Text>
                            ) : null}
                            <Divider />
                          </VStack>
                        ))
                      ) : (
                        <Text color="secondary">
                          No synced activity for this filter yet.
                        </Text>
                      )}
                      {shown.length > visibleCount ? (
                        <Button label="Show older activity" size="sm" variant="ghost" onClick={() => setVisibleCount(count => count + 30)} />
                      ) : null}
                    </VStack>
                  </Section>
                  {harvey}
                </>
              ) : null}
              {tab === "notes" ? (
                <Section>
                  <VStack gap={5}>
                    <Heading level={2}>Notes</Heading>
                    <TextArea
                      label="Add a private note"
                      placeholder="What should the team know about this person?"
                      value={draft}
                      onChange={setDraft}
                    />
                    <HStack hAlign="end">
                      <Button
                        label={busy ? "Saving…" : "Save note"}
                        variant="primary"
                        isDisabled={busy || !draft.trim()}
                        onClick={saveNote}
                      />
                    </HStack>
                    {record.notes?.map((n: Row) => (
                      <VStack key={n.id} gap={2} paddingBlock={3}>
                        <Text>{n.body}</Text>
                        <Text type="supporting" color="secondary">
                          {n.author || "Team"} · {date(n.createdAt)}
                        </Text>
                        <Divider />
                      </VStack>
                    ))}
                  </VStack>
                </Section>
              ) : null}
              {tab === "details" ? (
                <>
                {contact}
                <ContactDetails
                  record={record}
                  lead={lead}
                  base={base}
                  refresh={async () => {
                    await load();
                    await bridge.refresh();
                  }}
                />
                </>
              ) : null}

            </VStack>
          </LayoutContent>
        }
      />
      <Dialog isOpen={edit} onOpenChange={setEdit} purpose="form" width="36rem">
        <VStack gap={6}>
          <DialogHeader title="Edit contact" onOpenChange={setEdit} />
          {error ? <Notice>{error}</Notice> : null}
          <TextInput
            label="Name"
            value={form.name || ""}
            onChange={(v) => change("name", v)}
            isRequired
          />
          <TextInput
            label="Source"
            value={form.source || ""}
            onChange={(v) => change("source", v)}
          />
          <Selector
            label="Intent"
            value={form.crmIntent}
            onChange={(v) => change("crmIntent", v)}
            options={["buyer", "seller", "both"].map((v) => ({
              value: v,
              label: label(v),
            }))}
          />
          <Selector
            label="Status"
            value={form.crmStatus}
            onChange={(v) => change("crmStatus", v)}
            options={withCurrent(snapshot.statusOptions, form.crmStatus)}
          />
          <Selector
            label="Pipeline stage"
            value={form.crmStage}
            onChange={(v) => change("crmStage", v)}
            options={withCurrent(snapshot.stageOptions, form.crmStage)}
          />
          <TextInput
            label="Opportunity tags"
            description="Separate tags with commas."
            value={form.tags || ""}
            onChange={(v) => change("tags", v)}
          />
          <HStack hAlign="end" gap={3}>
            <Button label="Cancel" onClick={() => setEdit(false)} />
            <Button
              label={busy ? "Saving…" : "Save changes"}
              variant="primary"
              isDisabled={busy}
              onClick={save}
            />
          </HStack>
        </VStack>
      </Dialog>
      {schedule ? (
        <Schedule
          lead={lead}
          kind={schedule}
          close={() => setSchedule("")}
          saved={async () => {
            setSchedule("");
            followUps.refresh();
            setNotice("Saved to this contact and the team calendar.");
            await load();
            await bridge.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function ContactDetails({
  record,
  lead,
  base,
  refresh,
}: {
  record: Row;
  lead: Row;
  base: string;
  refresh: () => Promise<void>;
}) {
  const [kind, setKind] = useState(""),
    [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  const add = async () => {
    setBusy(true);
    setError("");
    try {
      await api(
        base + "/" + kind,
        "POST",
        kind === "emails"
          ? { address: value.trim(), isPrimary: !lead.email }
          : { number: value.trim(), isPrimary: !lead.phone },
      );
      setKind("");
      setValue("");
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section>
        <VStack gap={6}>
          <Heading level={2}>Contact information</Heading>
          {["emails", "phones"].map((k) => (
            <VStack key={k} gap={4}>
              <HStack hAlign="between" vAlign="center">
                <Heading level={3}>
                  {k === "emails" ? "Email addresses" : "Phone numbers"}
                </Heading>
                <Button
                  label={k === "emails" ? "Add email" : "Add phone"}
                  size="sm"
                  onClick={() => {
                    setKind(k);
                    setValue("");
                    setError("");
                  }}
                />
              </HStack>
              {record[k]?.length ? (
                record[k].map((v: Row) => (
                  <HStack key={v.id} hAlign="between" wrap="wrap">
                    <Text>{v.address || v.number}</Text>
                    <Text type="supporting" color="secondary">
                      {v.isPrimary ? "Primary · " : ""}
                      {label(v.kind)}
                      {v.dnc ? " · Do not call" : ""}
                    </Text>
                  </HStack>
                ))
              ) : (
                <Text color="secondary">
                  {k === "emails"
                    ? lead.email || "No email collected."
                    : lead.phone || "No phone collected."}
                </Text>
              )}
              <Divider />
            </VStack>
          ))}
          <Heading level={3}>Addresses</Heading>
          {record.addresses?.length ? (
            record.addresses.map((a: Row) => (
              <Text key={a.id}>
                {[a.street, a.apt, a.city, a.region, a.postalCode]
                  .filter(Boolean)
                  .join(", ")}
              </Text>
            ))
          ) : (
            <Text color="secondary">
              {lead.address || "No address provided."}
            </Text>
          )}
          <Heading level={3}>Opportunity tags</Heading>
          <Text color="secondary">
            {lead.tags?.length ? lead.tags.join(", ") : "No opportunity tags."}
          </Text>
          <Button
            label="Manage addresses, documents and relationships"
            onClick={() => bridge.action("tools", lead.id)}
          />
        </VStack>
      </Section>
      <Dialog
        isOpen={!!kind}
        onOpenChange={(open) => {
          if (!open) setKind("");
        }}
        purpose="form"
      >
        <VStack gap={5}>
          <DialogHeader
            title={kind === "emails" ? "Add email address" : "Add phone number"}
          />
          <TextInput
            label={kind === "emails" ? "Email address" : "Phone number"}
            value={value}
            onChange={setValue}
            isRequired
          />
          {error ? <Notice>{error}</Notice> : null}
          <HStack hAlign="end" gap={2}>
            <Button label="Cancel" onClick={() => setKind("")} />
            <Button
              label={busy ? "Saving…" : "Add"}
              variant="primary"
              isDisabled={busy || !value.trim()}
              onClick={add}
            />
          </HStack>
        </VStack>
      </Dialog>
    </>
  );
}

function withCurrent(
  options: { value: string; label: string }[] = [],
  value: string,
) {
  return options.some((o) => o.value === value)
    ? options
    : [...options, { value, label: label(value) }];
}

function Schedule({
  lead,
  kind,
  close,
  saved,
}: {
  lead: Row;
  kind: string;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const today = new Date();
  const initial = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");

  const [title, setTitle] = useState(""),
    [day, setDay] = useState(initial),
    [time, setTime] = useState(""),
    [location, setLocation] = useState(""),
    [notes, setNotes] = useState(""),
    [priority, setPriority] = useState("normal"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  const appointment = kind === "appointment";

  const save = async () => {
    if (!title.trim() || !day || (appointment && !time)) {
      setError("Enter a title, date" + (appointment ? " and time." : "."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/crm-tasks", "POST", {
        title: title.trim(),
        type: kind,
        priority,
        dueDate: day,
        dueTime: time || undefined,
        leadId: lead.id,
        leadName: lead.name,
        assignedUserId: lead.assignedUserId,
        assignedUserName: lead.assignedUserName,
        location: location || undefined,
        taskNotes: notes || undefined,
        ...(appointment
          ? { appointmentStatus: "scheduled", outcome: "none" }
          : {}),
      });
      await saved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      purpose="form"
      width="34rem"
    >
      <VStack gap={5}>
        <DialogHeader
          title={appointment ? "Schedule appointment" : "Add follow-up task"}
        />
        <Text color="secondary">
          {lead.name} · {lead.assignedUserName || "Unassigned"}
        </Text>
        {error ? <Notice>{error}</Notice> : null}
        <TextInput
          label={appointment ? "Appointment title" : "Task title"}
          value={title}
          onChange={setTitle}
          isRequired
        />
        <HStack gap={4} wrap="wrap">
          <DateInput
            label="Date"
            value={day as React.ComponentProps<typeof DateInput>["value"]}
            onChange={(v) => setDay(v || "")}
            isRequired
          />
          <TimeInput
            label="Time"
            value={time as React.ComponentProps<typeof TimeInput>["value"]}
            onChange={(v) => setTime(v || "")}
            isRequired={appointment}
          />
        </HStack>
        <Text type="supporting" color="secondary">
          Uses the same local date and time as your CRM calendar.
        </Text>
        {appointment ? (
          <TextInput label="Location" value={location} onChange={setLocation} />
        ) : null}
        <Selector
          label="Priority"
          value={priority}
          onChange={setPriority}
          options={["low", "normal", "high", "urgent"].map((value) => ({
            value,
            label: label(value),
          }))}
        />
        <TextArea label="Notes" value={notes} onChange={setNotes} />
        <HStack hAlign="end" gap={3}>
          <Button label="Cancel" isDisabled={busy} onClick={close} />
          <Button
            label={
              busy
                ? "Saving…"
                : appointment
                  ? "Schedule appointment"
                  : "Save task"
            }
            variant="primary"
            isDisabled={busy}
            onClick={save}
          />
        </HStack>
      </VStack>
    </Dialog>
  );
}

function App() {
  const snapshot = useSnapshot();
  const theme = useMemo(() => commandTheme(snapshot.accent), [snapshot.accent]);
  const lead = snapshot.leads.find((l: Row) => l.id === snapshot.route.id);
  return (
    <Theme theme={theme} mode={snapshot.theme === "dark" ? "dark" : "light"}>
      <VStack height="100dvh" gap={0}>
        {snapshot.route.page === "profile" && lead ? (
          <Profile key={lead.id} lead={lead} snapshot={snapshot} />
        ) : (
          <People snapshot={snapshot} />
        )}
      </VStack>
    </Theme>
  );
}

class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <Text>
        People could not load. Refresh the Command Center to try again.
      </Text>
    ) : (
      this.props.children
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
  </Boundary>,
);
