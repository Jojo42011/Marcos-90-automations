import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import {
  Layout,
  LayoutHeader,
  LayoutFooter,
  LayoutContent,
  LayoutPanel,
  VStack,
  HStack,
  Section,
} from "@astryxdesign/core/Layout";
import { Text, Heading } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Selector } from "@astryxdesign/core/Selector";
import { DateInput } from "@astryxdesign/core/DateInput";
import { TimeInput } from "@astryxdesign/core/TimeInput";
import {
  CheckboxList,
  CheckboxListItem,
} from "@astryxdesign/core/CheckboxList";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Table, proportional } from "@astryxdesign/core/Table";
import { Banner } from "@astryxdesign/core/Banner";
import { Divider } from "@astryxdesign/core/Divider";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { commandTheme } from "../shared/theme";
import {
  Account,
  Post,
  Plan,
  api,
  localParts,
  matches,
  payload,
  planFor,
  safeURL,
  weekDates,
} from "./model";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";

type Settings = {
  driveFolderId: string;
  driveFolderName: string;
  timezone: string;
  ingestHour: number;
  ingestIntervalMinutes: number;
  lastSuccessfulSyncAt?: string;
  lastSyncNote?: string;
};
type Overview = {
  today: string;
  posts: Post[];
  accounts: Account[];
  settings: Settings;
  drive: { connected: boolean; email?: string };
  accountsError?: string;
  composioReady?: boolean;
  googleOAuthReady?: boolean;
};
const states = [
  "inbox",
  "draft",
  "ready",
  "scheduled",
  "published",
  "failed",
  "skipped",
];
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const accountName = (a: Account) =>
  `${title(a.platform)} · ${a.username || a.name || a.id}`;
const dayLabel = (s: string, short = false) =>
  new Date(s + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: short ? "short" : undefined,
    day: "numeric",
    weekday: short ? undefined : "short",
  });
const editable = (p: Post) => p.status !== "published";
const remote = (p: Post) =>
  !!p.zernioPostId || ["scheduled", "published"].includes(p.status);

function useAppearance() {
  const read = () => ({
    mode:
      document.documentElement.dataset.theme === "dark"
        ? ("dark" as const)
        : ("light" as const),
    accent:
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim() || "#b91c1c",
  });
  const [appearance, set] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => set(read()));
    observer.observe(document.documentElement, { attributes: true });
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, []);
  return appearance;
}

function App() {
  const appearance = useAppearance();
  const theme = useMemo(
    () => commandTheme(appearance.accent),
    [appearance.accent],
  );
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [view, setView] = useState("calendar"),
    [account, setAccount] = useState("all"),
    [status, setStatus] = useState("all"),
    [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<{ post: Post; day?: string } | null>(
      null,
    ),
    [settings, setSettings] = useState(false),
    [busy, setBusy] = useState(false);
  const narrow = useMediaQuery("(max-width: 1000px)");
  const paused = useRef(false);
  paused.current = !!selected || settings || busy;
  async function load() {
    const result = await api("GET", "/api/smartposter/overview");
    setData(result);
    setError("");
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (!document.hidden && !paused.current)
        load().catch((e) => setError(e.message));
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  async function sync() {
    setBusy(true);
    setNotice("");
    try {
      const r = await api("POST", "/api/smartposter/sync", {});
      await load();
      setNotice(r.note || "Drive sync complete. New videos are ready to plan.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const posts = (data?.posts || []).filter(
    (p) =>
      matches(p, account, status, data?.accounts || []) &&
      `${p.title} ${p.fileName} ${p.caption}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const inbox = posts.filter(
    (p) =>
      !p.scheduledFor &&
      ["inbox", "draft", "ready", "failed"].includes(p.status),
  );
  const days = data ? weekDates(data.today, offset) : [];
  const open = (post: Post, day?: string) => setSelected({ post, day });
  const library = (
    <VStack gap={5}>
      <VStack gap={2}>
        <HStack hAlign="between">
          <Heading level={2}>Video inbox</Heading>
          <Text color="secondary">{inbox.length}</Text>
        </HStack>
        <Text type="supporting" color="secondary">
          Fresh from Drive. Drag a video to a day, or open it to plan.
        </Text>
      </VStack>
      {inbox.length ? (
        inbox.map((p) => (
          <PostCard key={p.id} post={p} data={data!} open={() => open(p)} />
        ))
      ) : (
        <Section padding={4}>
          <VStack gap={3}>
            <Text weight="semibold">
              {data?.posts.length
                ? "You’re up to date"
                : "Your next week starts here"}
            </Text>
            <Text color="secondary">
              {data?.posts.length
                ? "No unplanned videos match these filters."
                : "Add finished videos to your connected Drive folder, then sync to bring them here."}
            </Text>
            <Button label="Drive settings" onClick={() => setSettings(true)} />
          </VStack>
        </Section>
      )}
      <Divider />
      <VStack gap={2}>
        <Text type="supporting" weight="semibold">
          GOOGLE DRIVE
        </Text>
        <Text>
          {data?.drive.connected
            ? data.settings.driveFolderName || "Choose a folder"
            : "Not connected"}
        </Text>
        <Text type="supporting" color="secondary">
          {data?.settings.ingestIntervalMinutes
            ? `Checks every ${data.settings.ingestIntervalMinutes < 60 ? data.settings.ingestIntervalMinutes + " minutes" : data.settings.ingestIntervalMinutes === 60 ? "hour" : data.settings.ingestIntervalMinutes / 60 + " hours"}`
            : `Daily at ${String(data?.settings.ingestHour ?? 9).padStart(2, "0")}:00`}
          {data ? " · " + data.settings.timezone : ""}
        </Text>
        <Button
          label="Manage import"
          variant="ghost"
          onClick={() => setSettings(true)}
        />
      </VStack>
    </VStack>
  );
  return (
    <Theme theme={theme} mode={appearance.mode}>
      <VStack height="100dvh" gap={0}>
        <Layout
          padding={4}
          start={
            !narrow && data ? (
              <LayoutPanel width="18rem" hasDivider>
                {library}
              </LayoutPanel>
            ) : undefined
          }
          header={
            <LayoutHeader hasDivider>
              <VStack gap={5}>
                <HStack hAlign="between" vAlign="center" wrap="wrap">
                  <VStack gap={1}>
                    <Heading level={1}>Smart Poster</Heading>
                    <Text color="secondary">
                      Your content. A clear plan. Every account.
                    </Text>
                  </VStack>
                  <HStack gap={2}>
                    <Button
                      label="Settings"
                      onClick={() => setSettings(true)}
                      isDisabled={!data}
                    />
                    <Button
                      label={busy ? "Syncing Drive…" : "Sync Drive"}
                      variant="primary"
                      isDisabled={!data || busy || !data.drive.connected}
                      onClick={sync}
                    />
                  </HStack>
                </HStack>
                <HStack hAlign="between" vAlign="center" wrap="wrap">
                  <TabList value={view} onChange={setView}>
                    <Tab value="calendar" label="Weekly planner" />
                    <Tab value="library" label="All content" />
                    {narrow && <Tab value="inbox" label="Video inbox" />}
                  </TabList>
                  <Text type="supporting" color="secondary">
                    {data?.posts.filter((p) => p.status === "scheduled")
                      .length || 0}{" "}
                    scheduled ·{" "}
                    {data?.posts.filter((p) => p.status === "published")
                      .length || 0}{" "}
                    published
                  </Text>
                </HStack>
              </VStack>
            </LayoutHeader>
          }
        >
          <LayoutContent padding={4} isScrollable>
            <VStack gap={5}>
              {error && (
                <Banner
                  status="error"
                  title="Could not complete that request"
                  description={error}
                  endContent={
                    <Button
                      label="Retry refresh"
                      onClick={() => load().catch((e) => setError(e.message))}
                    />
                  }
                />
              )}
              {notice && (
                <Banner
                  status="success"
                  title={notice}
                  isDismissable
                  onDismiss={() => setNotice("")}
                />
              )}
              {!data ? (
                <Text>Loading your publishing workspace…</Text>
              ) : (
                <>
                  {data.accountsError && (
                    <Banner
                      status="warning"
                      title="Some accounts could not load"
                      description={data.accountsError}
                    />
                  )}
                  <HStack gap={3} wrap="wrap" vAlign="end">
                    <TextInput
                      label="Search content"
                      value={query}
                      onChange={setQuery}
                      placeholder="Title or caption"
                      width="16rem"
                    />
                    <Selector
                      label="Account"
                      value={account}
                      onChange={setAccount}
                      options={[
                        { value: "all", label: "All accounts" },
                        ...data.accounts.map((a) => ({
                          value: a.id,
                          label: accountName(a),
                        })),
                      ]}
                    />
                    <Selector
                      label="Status"
                      value={status}
                      onChange={setStatus}
                      options={[
                        { value: "all", label: "All statuses" },
                        ...states.map((s) => ({ value: s, label: title(s) })),
                      ]}
                    />
                    {(query || account !== "all" || status !== "all") && (
                      <Button
                        label="Clear filters"
                        variant="ghost"
                        onClick={() => {
                          setQuery("");
                          setAccount("all");
                          setStatus("all");
                        }}
                      />
                    )}
                  </HStack>
                  {view === "inbox" ? (
                    library
                  ) : view === "library" ? (
                    <Table
                      data={posts}
                      idKey="id"
                      density="spacious"
                      dividers="rows"
                      columns={[
                        {
                          key: "title",
                          header: "Content",
                          width: proportional(3),
                          renderCell: (p: Post) => (
                            <VStack gap={1}>
                              <Button
                                variant="ghost"
                                label={p.title || p.fileName}
                                onClick={() => open(p)}
                              />
                              <Text
                                type="supporting"
                                color="secondary"
                                maxLines={1}
                              >
                                {p.caption || p.fileName}
                              </Text>
                            </VStack>
                          ),
                        },
                        {
                          key: "status",
                          header: "Status",
                          renderCell: (p: Post) => (
                            <Text>{title(p.status)}</Text>
                          ),
                        },
                        {
                          key: "accounts",
                          header: "Accounts",
                          width: proportional(2),
                          renderCell: (p: Post) => (
                            <Text type="supporting">
                              {p.accountIds
                                ?.map((id) =>
                                  data.accounts.find((a) => a.id === id),
                                )
                                .filter(Boolean)
                                .map((a) => accountName(a!))
                                .join(", ") || "Not selected"}
                            </Text>
                          ),
                        },
                        {
                          key: "date",
                          header: `Schedule · ${data.settings.timezone}`,
                          renderCell: (p: Post) => {
                            const t = localParts(
                              p.scheduledFor,
                              data.settings.timezone,
                            );
                            return (
                              <Text type="supporting">
                                {t.localDate
                                  ? `${dayLabel(t.localDate, true)} · ${t.localTime}`
                                  : p.targetDate
                                    ? dayLabel(p.targetDate, true)
                                    : p.scheduledFor
                                      ? "Schedule unavailable"
                                      : "Not planned"}
                              </Text>
                            );
                          },
                        },
                      ]}
                    />
                  ) : (
                    <VStack gap={4}>
                      <HStack hAlign="between" vAlign="center" wrap="wrap">
                        <VStack gap={1}>
                          <Heading level={2}>
                            {dayLabel(days[0], true)} –{" "}
                            {dayLabel(days[6], true)}
                          </Heading>
                          <Text type="supporting" color="secondary">
                            {data.settings.timezone} · Drop a video to review
                            its schedule.
                          </Text>
                        </VStack>
                        <HStack gap={2}>
                          <Button
                            label="Previous week"
                            onClick={() => setOffset((o) => o - 1)}
                          />
                          <Button
                            label="This week"
                            onClick={() => setOffset(0)}
                          />
                          <Button
                            label="Next week"
                            onClick={() => setOffset((o) => o + 1)}
                          />
                        </HStack>
                      </HStack>
                      <ScrollableArea
                        axis="inline"
                        label="Weekly publishing calendar"
                      >
                        <Grid
                          columns={7}
                          gap={3}
                          width={
                            narrow ? "70rem" : "max(70rem, calc(100vw - 21rem))"
                          }
                        >
                          {days.map((day) => {
                            const dayPosts = posts
                              .filter(
                                (p) =>
                                  (localParts(
                                    p.scheduledFor,
                                    data.settings.timezone,
                                  ).localDate || p.targetDate) === day,
                              )
                              .sort((a, b) =>
                                (a.scheduledFor || "").localeCompare(
                                  b.scheduledFor || "",
                                ),
                              );
                            return (
                              <Section
                                key={day}
                                padding={3}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = "move";
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const post = data.posts.find(
                                    (p) =>
                                      p.id ===
                                      e.dataTransfer.getData("text/plain"),
                                  );
                                  if (post && editable(post)) open(post, day);
                                }}
                              >
                                <VStack gap={4} minHeight="30rem">
                                  <VStack gap={1}>
                                    <Text
                                      weight="semibold"
                                      color={
                                        day === data.today
                                          ? "accent"
                                          : "primary"
                                      }
                                    >
                                      {dayLabel(day)}
                                    </Text>
                                    <Text type="supporting" color="secondary">
                                      {day === data.today ? "Today · " : ""}
                                      {dayPosts.length}{" "}
                                      {dayPosts.length === 1 ? "post" : "posts"}
                                    </Text>
                                  </VStack>
                                  <Divider />
                                  {dayPosts.map((p) => (
                                    <PostCard
                                      key={p.id}
                                      post={p}
                                      data={data}
                                      open={() => open(p)}
                                    />
                                  ))}
                                  {!dayPosts.length && (
                                    <Text type="supporting" color="secondary">
                                      Open day
                                    </Text>
                                  )}
                                </VStack>
                              </Section>
                            );
                          })}
                        </Grid>
                      </ScrollableArea>
                    </VStack>
                  )}
                </>
              )}
            </VStack>
          </LayoutContent>
        </Layout>
        {data && selected && (
          <Editor
            key={selected.post.id + (selected.day || "")}
            post={selected.post}
            day={selected.day}
            data={data}
            close={() => setSelected(null)}
            saved={async (message) => {
              setSelected(null);
              setNotice(message);
              await load().catch((e) => setError(e.message));
            }}
          />
        )}
        {data && settings && (
          <SettingsDialog
            data={data}
            close={() => setSettings(false)}
            saved={async () => {
              setSettings(false);
              setNotice("Drive import settings saved.");
              await load().catch((e) => setError(e.message));
            }}
          />
        )}
      </VStack>
    </Theme>
  );
}

function PostCard({
  post: p,
  data,
  open,
}: {
  post: Post;
  data: Overview;
  open: () => void;
}) {
  return (
    <Card
      padding={3}
      draggable={editable(p)}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", p.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <VStack gap={3}>
        <Text type="supporting" color="secondary">
          {p.scheduledFor
            ? localParts(p.scheduledFor, data.settings.timezone).localTime +
              " · "
            : ""}
          {title(p.status)}
        </Text>
        <Text weight="semibold" maxLines={3}>
          {p.title || p.fileName}
        </Text>
        {p.caption && (
          <Text type="supporting" color="secondary" maxLines={2}>
            {p.caption}
          </Text>
        )}
        <Text type="supporting" color="secondary">
          {p.accountIds?.length
            ? `${p.accountIds.length} ${p.accountIds.length === 1 ? "account" : "accounts"}`
            : "Choose accounts"}
        </Text>
        <Button
          label={p.status === "published" ? "View post" : "Plan post"}
          onClick={open}
          width="100%"
        />
      </VStack>
    </Card>
  );
}

function Editor({
  post,
  day,
  data,
  close,
  saved,
}: {
  post: Post;
  day?: string;
  data: Overview;
  close: () => void;
  saved: (message: string) => Promise<void>;
}) {
  const [plan, setPlan] = useState<Plan>(() =>
      planFor(post, data.settings.timezone, day),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [remove, setRemove] = useState(false);
  const readOnly = !editable(post);
  const update = (key: keyof Plan, value: string | string[]) =>
    setPlan((p) => ({ ...p, [key]: value }));
  async function save(schedule: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(
        schedule ? "POST" : "PATCH",
        `/api/smartposter/posts/${encodeURIComponent(post.id)}${schedule ? "/schedule" : ""}`,
        payload(plan, schedule),
      );
      await saved(
        schedule
          ? "Post scheduled."
          : remote(post)
            ? "Schedule updated."
            : "Plan saved.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deletePost() {
    setBusy(true);
    try {
      await api(
        "DELETE",
        `/api/smartposter/posts/${encodeURIComponent(post.id)}`,
      );
      await saved(
        "Video removed from Smart Poster. The Drive file is unchanged.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      isOpen
      onOpenChange={(v) => {
        if (!v && !busy) close();
      }}
      purpose="form"
      width="40rem"
      padding={0}
      maxHeight="calc(100dvh - 2rem)"
    >
      <VStack height="min(48rem, calc(100dvh - 2rem))" gap={0}>
        <Layout
          padding={4}
          header={
            <LayoutHeader hasDivider>
              {" "}
              <DialogHeader
                title={readOnly ? "Published post" : "Plan your post"}
                onOpenChange={(v) => {
                  if (!v && !busy) close();
                }}
              />
            </LayoutHeader>
          }
          footer={
            !readOnly ? (
              <LayoutFooter hasDivider label="Publishing actions">
                {" "}
                <HStack hAlign="between" wrap="wrap" gap={3}>
                  <Button
                    label="Cancel"
                    variant="ghost"
                    isDisabled={busy}
                    onClick={close}
                  />
                  <HStack gap={2}>
                    <Button
                      label={remote(post) ? "Update schedule" : "Save plan"}
                      isDisabled={busy}
                      onClick={() => save(false)}
                    />
                    {!remote(post) && (
                      <Button
                        label="Schedule post"
                        variant="primary"
                        isDisabled={busy || !data.accounts.length}
                        onClick={() => save(true)}
                      />
                    )}
                  </HStack>
                </HStack>
              </LayoutFooter>
            ) : undefined
          }
        >
          <LayoutContent isScrollable padding={4}>
            <VStack gap={5}>
              <Text color="secondary">{post.fileName}</Text>
              {(error || post.error) && (
                <Banner
                  status="error"
                  title="Needs attention"
                  description={error || post.error}
                />
              )}
              <TextInput
                label="Title"
                value={plan.title}
                onChange={(v) => update("title", v)}
                isDisabled={readOnly || busy}
              />
              <TextArea
                label="Caption"
                value={plan.caption}
                onChange={(v) => update("caption", v)}
                isDisabled={readOnly || busy}
              />
              <HStack gap={4} wrap="wrap">
                <DateInput
                  label="Publish date"
                  value={
                    plan.localDate as React.ComponentProps<
                      typeof DateInput
                    >["value"]
                  }
                  onChange={(v) => update("localDate", v || "")}
                  isDisabled={readOnly || busy}
                />
                <TimeInput
                  presentation="bottom-sheet"
                  label="Time"
                  value={
                    plan.localTime as React.ComponentProps<
                      typeof TimeInput
                    >["value"]
                  }
                  onChange={(v) => update("localTime", v || "")}
                  isDisabled={readOnly || busy}
                />
              </HStack>
              <Text type="supporting" color="secondary">
                All times use {plan.timezone}. Saving a plan does not publish
                it.
              </Text>
              <CheckboxList
                label="Publish to"
                description="Select only the accounts for this video."
                value={plan.accountIds}
                onChange={(v) => update("accountIds", v)}
                isDisabled={readOnly || busy}
                hasDividers
              >
                {data.accounts.map((a) => (
                  <CheckboxListItem
                    key={a.id}
                    value={a.id}
                    label={accountName(a)}
                  />
                ))}
              </CheckboxList>
              {!data.accounts.length && (
                <Banner
                  status="warning"
                  title="No publishing accounts available"
                  description="Connect your social accounts before scheduling."
                />
              )}
              {plan.accountIds.some(
                (id) => !data.accounts.some((a) => a.id === id),
              ) && (
                <Banner
                  status="warning"
                  title="An account is no longer available"
                  description="Select the current accounts before saving."
                />
              )}
              {(safeURL(post.mediaUrl) || safeURL(post.platformPostUrl)) && (
                <Button
                  label={
                    post.platformPostUrl
                      ? "Open published post"
                      : "Preview video"
                  }
                  onClick={() =>
                    window.open(
                      safeURL(post.platformPostUrl) || safeURL(post.mediaUrl),
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                />
              )}
              {!readOnly && (
                <>
                  <Divider />
                  {!remote(post) &&
                    (remove ? (
                      <VStack gap={2}>
                        <Text>
                          Remove this video from Smart Poster? The Drive file
                          will stay in Drive.
                        </Text>
                        <HStack gap={2}>
                          <Button
                            label="Keep video"
                            isDisabled={busy}
                            onClick={() => setRemove(false)}
                          />
                          <Button
                            label="Confirm removal"
                            isDisabled={busy}
                            onClick={deletePost}
                          />
                        </HStack>
                      </VStack>
                    ) : (
                      <Button
                        label="Remove from inbox"
                        variant="ghost"
                        isDisabled={busy}
                        onClick={() => setRemove(true)}
                      />
                    ))}
                </>
              )}
            </VStack>
          </LayoutContent>
        </Layout>
      </VStack>
    </Dialog>
  );
}

function SettingsDialog({
  data,
  close,
  saved,
}: {
  data: Overview;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [form, setForm] = useState({ ...data.settings }),
    [folders, setFolders] = useState<{ id: string; name: string }[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [disconnect, setDisconnect] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      isOpen
      onOpenChange={(v) => {
        if (!v && !busy) close();
      }}
      purpose="form"
      width="38rem"
    >
      <DialogHeader
        title="Drive & publishing settings"
        onOpenChange={(v) => {
          if (!v && !busy) close();
        }}
      />
      <VStack gap={5}>
        {error && (
          <Banner
            status="error"
            title="Settings could not be updated"
            description={error}
          />
        )}
        <VStack gap={2}>
          <Heading level={2}>Google Drive</Heading>
          <Text color="secondary">
            {data.drive.connected
              ? data.drive.email || "Connected"
              : "Connect the Drive where Carlos uploads finished videos."}
          </Text>
          {data.drive.connected ? (
            <Button
              label={disconnect ? "Confirm disconnect" : "Disconnect Drive"}
              isDisabled={busy}
              onClick={() =>
                disconnect
                  ? run(async () => {
                      await api(
                        "POST",
                        "/api/smartposter/drive/disconnect",
                        {},
                      );
                      await saved();
                    })
                  : setDisconnect(true)
              }
            />
          ) : (
            <Button
              label="Connect Google Drive"
              isDisabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await api(
                    "GET",
                    "/api/smartposter/drive/connect?redirect=0",
                  );
                  const url = safeURL(result.url);
                  if (!url)
                    throw Error(
                      "Drive connection did not return a valid authorization link.",
                    );
                  window.location.assign(url);
                })
              }
            />
          )}
        </VStack>
        <Divider />
        <TextInput
          label="Video folder"
          value={form.driveFolderName || ""}
          onChange={(v) => {
            setForm((f) => ({ ...f, driveFolderName: v, driveFolderId: "" }));
            setFolders([]);
          }}
          placeholder="Search your Drive folders"
          isDisabled={!data.drive.connected || busy}
        />
        <Button
          label="Find folders"
          isDisabled={
            !data.drive.connected || busy || !form.driveFolderName.trim()
          }
          onClick={() =>
            run(async () => {
              const r = await api(
                "GET",
                "/api/smartposter/drive/folders?q=" +
                  encodeURIComponent(form.driveFolderName),
              );
              setFolders(r.folders || []);
              if (!r.folders?.length)
                throw Error("No folders found. Try another name.");
            })
          }
        />
        {!!folders.length && (
          <Selector
            label="Choose folder"
            value={form.driveFolderId || ""}
            onChange={(id) => {
              const folder = folders.find((f) => f.id === id)!;
              setForm((f) => ({
                ...f,
                driveFolderId: id,
                driveFolderName: folder.name,
              }));
            }}
            options={folders.map((f) => ({ value: f.id, label: f.name }))}
          />
        )}
        {form.driveFolderId && (
          <Text type="supporting" color="secondary">
            Selected: {form.driveFolderName}
          </Text>
        )}
        <Selector
          label="Check for new videos"
          value={String(form.ingestIntervalMinutes || 0)}
          onChange={(v) =>
            setForm((f) => ({ ...f, ingestIntervalMinutes: Number(v) }))
          }
          options={[
            { value: "0", label: "Once a day" },
            { value: "15", label: "Every 15 minutes" },
            { value: "60", label: "Every hour" },
            { value: "240", label: "Every 4 hours" },
            { value: "720", label: "Every 12 hours" },
          ]}
        />
        {!form.ingestIntervalMinutes && (
          <Selector
            label="Daily import time"
            value={String(form.ingestHour ?? 9)}
            onChange={(v) => setForm((f) => ({ ...f, ingestHour: Number(v) }))}
            options={Array.from({ length: 24 }, (_, hour) => ({
              value: String(hour),
              label: `${String(hour).padStart(2, "0")}:00`,
            }))}
          />
        )}
        <TextInput
          label="Workspace timezone"
          value={form.timezone}
          onChange={(v) => setForm((f) => ({ ...f, timezone: v }))}
          placeholder="America/Chicago"
        />
        <Text type="supporting" color="secondary">
          New videos arrive in your inbox. Carlos chooses the day, time and
          accounts before scheduling. Ordinary filenames work;
          YYYY-MM-DD__platform__slug.mp4 is optional.
        </Text>
        <HStack hAlign="end" gap={2}>
          <Button label="Cancel" isDisabled={busy} onClick={close} />
          <Button
            label="Save settings"
            variant="primary"
            isDisabled={busy}
            onClick={() =>
              run(async () => {
                new Intl.DateTimeFormat("en-US", {
                  timeZone: form.timezone,
                }).format();
                if (data.drive.connected && !form.driveFolderId)
                  throw Error("Find and select a Drive folder first.");
                await api("PATCH", "/api/smartposter/settings", {
                  driveFolderId: form.driveFolderId,
                  driveFolderName: form.driveFolderName,
                  timezone: form.timezone,
                  ingestIntervalMinutes: Number(
                    form.ingestIntervalMinutes || 0,
                  ),
                  ingestHour: Number(form.ingestHour ?? 9),
                  autoSchedule: false,
                });
                await saved();
              })
            }
          />
        </HStack>
      </VStack>
    </Dialog>
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
      <Section padding={6}>
        <Text>Smart Poster could not load. Refresh to try again.</Text>
      </Section>
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
