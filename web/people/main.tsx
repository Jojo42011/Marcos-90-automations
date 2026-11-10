import React, { useEffect, useMemo, useState, useCallback } from "react";

import { createRoot } from "react-dom/client";

import { Theme } from "@astryxdesign/core/theme";

import {
  Layout,
  LayoutHeader,
  LayoutContent,
  LayoutPanel,
  VStack,
  HStack,
  StackItem,
  Section,
} from "@astryxdesign/core/Layout";

import { Text, Heading } from "@astryxdesign/core/Text";

import { Button } from "@astryxdesign/core/Button";

import { Avatar } from "@astryxdesign/core/Avatar";

import { Table, proportional } from "@astryxdesign/core/Table";

import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";

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
const peopleView = {query:'',source:'all',status:'all',sort:'az',page:1,filters:false};
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
  const narrow = useMediaQuery("(max-width: 800px)");

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
  const rows = all
    .filter(
      (r: Row) =>
        inBucket(r, bucket) &&
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

  useEffect(() => setPage(1), [bucket, query, source, status, sort]);

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      await bridge.refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      key: "name",
      header: "Person",
      width: proportional(2, { minWidth: 240 }),
      renderCell: (r: Row) => (
        <HStack gap={3} vAlign="center">
          <Avatar
            name={r.name || "Unnamed contact"}
            size="md"
            tooltip={false}
          />
          <VStack gap={1}>
            <Button
              variant="ghost"
              label={r.name || "Unnamed contact"}
              onClick={() => bridge.openLead(r.id)}
            />
            <Text type="supporting" color="secondary">
              {r.email || r.phone || "No contact details yet"}
            </Text>
          </VStack>
        </HStack>
      ),
    },

    {
      key: "status",
      header: "Status",
      renderCell: (r: Row) => <Text>{label(r.status)}</Text>,
    },

    {
      key: "stage",
      header: "Pipeline stage",
      width: proportional(1, { minWidth: 150 }),
      renderCell: (r: Row) => (
        <Text color="secondary">{stageText(r, snapshot.stageOptions)}</Text>
      ),
    },

    {
      key: "source",
      header: "Source",
      renderCell: (r: Row) => (
        <Text color="secondary">{r.source || "Unknown"}</Text>
      ),
    },

    {
      key: "assigned",
      header: "Assigned to",
      renderCell: (r: Row) => (
        <Text color="secondary">{r.assignedUserName || "Unassigned"}</Text>
      ),
    },

    {
      key: "last",
      header: "Last activity",
      width: proportional(1, { minWidth: 170 }),
      renderCell: (r: Row) => (
        <Text type="supporting" color="secondary">
          {date(r.lastActivity)}
        </Text>
      ),
    },

    {
      key: "open",
      header: "",
      renderCell: (r: Row) => (
        <Button
          label="Open profile"
          size="sm"
          variant="secondary"
          onClick={() => bridge.openLead(r.id)}
        />
      ),
    },
  ];

  const nav = (
    <VStack gap={6}>
      <Heading level={2}>People</Heading>
      <SideNav>
        {categories.map(([key, name]) => (
          <SideNavItem
            key={key}
            label={name}
            isSelected={bucket === key}
            onClick={() => setBucket(key)}
            endContent={
              <Text type="supporting" hasTabularNumbers>
                {all.filter((r: Row) => inBucket(r, key)).length}
              </Text>
            }
          />
        ))}
      </SideNav>
      <Divider />
      <Button
        label="Archived people"
        variant="ghost"
        onClick={() => setBucket("archived")}
      />
      <Text type="supporting" color="secondary">
        Your relationships, together in one place.
      </Text>
    </VStack>
  );

  return (
    <Layout
      padding={4}
      start={
        !narrow ? (
          <LayoutPanel width="15rem" hasDivider>
            {nav}
          </LayoutPanel>
        ) : undefined
      }
      header={
        <LayoutHeader hasDivider>
          <VStack gap={6}>
            <HStack hAlign="between" vAlign="center" wrap="wrap">
              <VStack gap={2}>
                <Heading level={1}>
                  {categories.find((c) => c[0] === bucket)?.[1] ||
                    "Archived people"}
                </Heading>
                <Text color="secondary">
                  {rows.length.toLocaleString()} {rows.length===1?'person':'people'}
                  {query || source !== "all" || status !== "all"
                    ? " matching your filters"
                    : " in your workspace"}
                </Text>
              </VStack>
              <HStack gap={2}>
                <Button
                  label={busy ? "Refreshing…" : "Refresh"}
                  isDisabled={busy}
                  onClick={refresh}
                />
                <Button
                  label="Import people"
                  variant="primary"
                  onClick={() => bridge.action("import", snapshot.leads[0]?.id)}
                />
              </HStack>
            </HStack>
            {narrow ? (
              <TabList value={bucket} onChange={setBucket}>
                {categories.map(([key, name]) => (
                  <Tab key={key} value={key} label={name} />
                ))}
              </TabList>
            ) : null}
            <HStack gap={3} vAlign="end" wrap="wrap">
              <StackItem size="fill">
                <TextInput
                  label="Search people"
                  isLabelHidden
                  placeholder="Search name, email, phone or address"
                  value={query}
                  onChange={setQuery}
                  hasClear
                />
              </StackItem>
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
            </HStack>
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
            {error ? <Notice>{error}</Notice> : null}
            <Table
              data={rows.slice((current - 1) * 25, current * 25)}
              columns={columns}
              idKey="id"
              density="spacious"
              dividers="rows"
              hasHover
              rowCount={rows.length}
              rowIndexStart={(current - 1) * 25 + 1}
            />
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
    [activityFilter, setActivityFilter] = useState("all"),
    [schedule, setSchedule] = useState("");

  const narrow = useMediaQuery("(max-width: 1000px)");

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError("");
      const results = await Promise.allSettled([
        api(base + "/record"),
        api(base + "/timeline"),
        api(base + "/brief"),
      ]);
      if (signal?.aborted) return;

      if (results[0].status === "fulfilled")
        setRecord(results[0].value.record || {});

      if (results[1].status === "fulfilled")
        setItems(results[1].value.items || []);

      if (results[2].status === "fulfilled") setBrief(results[2].value);

      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length)
        setError("Some contact history could not load. Refresh to try again.");
      setLoading(false);
    },
    [base],
  );

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
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

  const shown = items.filter(
    (i) => activityFilter === "all" || i.category === activityFilter,
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
              <HStack hAlign="between" vAlign="center" wrap="wrap">
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
                      {label(lead.crmIntent || lead.intent)} · {lead.source || "Unknown source"} ·{" "}
                      {label(lead.statusDisp)}
                    </Text>
                  </VStack>
                </HStack>
                <HStack gap={2}>
                  <Button label="Edit contact" onClick={openEdit} />
                  <Button
                    label="Schedule appointment"
                    variant="primary"
                    onClick={() => setSchedule("appointment")}
                  />
                </HStack>
              </HStack>
              <TabList value={tab} onChange={setTab} hasDivider>
                <Tab value="activity" label="Activity" />
                <Tab value="notes" label="Notes" />
                <Tab value="details" label="Details" />
              </TabList>
            </VStack>
          </LayoutHeader>
        }
        end={
          !narrow ? (
            <LayoutPanel width="22rem" hasDivider>
              {contact}
            </LayoutPanel>
          ) : undefined
        }
        content={
          <LayoutContent>
            <VStack gap={6}>
              {error ? <Notice>{error}</Notice> : null}
              {notice ? <Notice>{notice}</Notice> : null}
              {loading ? <Notice>Loading contact history…</Notice> : null}
              {tab === "activity" ? (
                <>
                  {harvey}
                  <Section>
                    <VStack gap={5}>
                      <HStack hAlign="between" vAlign="center" wrap="wrap">
                        <Heading level={2}>Conversation & activity</Heading>
                        <Selector
                          label="Activity type"
                          isLabelHidden
                          value={activityFilter}
                          onChange={setActivityFilter}
                          options={[
                            "all",
                            "text",
                            "call",
                            "email",
                            "appointment",
                            "task",
                            "note",
                          ].map((v) => ({
                            value: v,
                            label: v === "all" ? "All activity" : label(v),
                          }))}
                        />
                      </HStack>
                      {shown.length ? (
                        shown.slice(0, 60).map((item: Row) => (
                          <VStack key={item.id} gap={3} paddingBlock={3}>
                            <HStack hAlign="between" wrap="wrap">
                              <Text weight="semibold">
                                {item.title || label(item.category)}
                              </Text>
                              <Text type="supporting" color="secondary">
                                {date(item.at)}
                              </Text>
                            </HStack>
                            <Text color="secondary">
                              {typeof item.body === "string"
                                ? item.body
                                : item.description || ""}
                            </Text>
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
                      {shown.length > 60 ? (
                        <Text type="supporting">
                          Showing the latest 60 entries. Use the activity filter
                          to narrow the history.
                        </Text>
                      ) : null}
                    </VStack>
                  </Section>
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
                <ContactDetails
                  record={record}
                  lead={lead}
                  base={base}
                  refresh={async () => {
                    await load();
                    await bridge.refresh();
                  }}
                />
              ) : null}
              {narrow ? contact : null}
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
