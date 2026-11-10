export type Account = {
  id: string;
  platform: string;
  username?: string;
  name?: string;
};
export type Post = {
  id: string;
  title: string;
  fileName: string;
  caption: string;
  status: string;
  accountIds: string[];
  platforms: string[];
  scheduledFor?: string | null;
  targetDate?: string | null;
  timezone?: string;
  mediaUrl?: string | null;
  platformPostUrl?: string | null;
  zernioPostId?: string | null;
  error?: string | null;
};
export type Plan = {
  title: string;
  caption: string;
  accountIds: string[];
  localDate: string;
  localTime: string;
  timezone: string;
};
export function weekDates(today: string, offset = 0) {
  const date = new Date(today + "T12:00:00Z");
  date.setUTCDate(
    date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + offset * 7,
  );
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}
export function localParts(iso: string | null | undefined, timezone: string) {
  if (!iso || !Number.isFinite(Date.parse(iso)))
    return { localDate: "", localTime: "" };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}`,
  };
}
export function matches(
  post: Post,
  account: string,
  status: string,
  accounts: Account[],
) {
  return (
    (status === "all" || post.status === status) &&
    (account === "all" ||
      (post.accountIds?.length
        ? post.accountIds.includes(account)
        : post.platforms?.includes(
            accounts.find((a) => a.id === account)?.platform || "",
          )))
  );
}
export function planFor(post: Post, timezone: string, day?: string): Plan {
  const local = localParts(post.scheduledFor, timezone);
  return {
    title: post.title || post.fileName,
    caption: post.caption || "",
    accountIds: post.accountIds || [],
    timezone,
    localDate: day || local.localDate || post.targetDate || "",
    localTime: local.localTime,
  };
}
export function payload(plan: Plan, schedule = false) {
  if (!!plan.localDate !== !!plan.localTime)
    throw Error("Choose both a day and a time.");
  if (schedule && (!plan.localDate || !plan.accountIds.length))
    throw Error(
      "Choose a day, a time and at least one account before scheduling.",
    );
  const { localDate, localTime, ...rest } = plan;
  return localDate
    ? { ...rest, localDate, localTime }
    : { ...rest, scheduledFor: null };
}
export function safeURL(value?: string | null) {
  try {
    const u = new URL(value || "");
    return ["https:", "http:"].includes(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}
export async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(result.error || `Request failed (${response.status})`);
  return result;
}
