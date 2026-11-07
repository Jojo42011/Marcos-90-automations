import type { SmartPosterPost } from "./smartPosterStore.js";
import type { ZernioAccountRef } from "../integrations/zernio/index.js";

/** Resolve a wall-clock selection in the planner's timezone, including DST. */
export function plannerTime(date: string, time: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("Choose both a day and a time.");
  const desired = `${date}T${time}:00`;
  const target = Date.parse(desired + "Z");
  if (!Number.isFinite(target)) throw new Error("Invalid scheduled date.");
  const format = new Intl.DateTimeFormat("en-CA", {timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  const wall = (stamp:number) => {
    const p = Object.fromEntries(format.formatToParts(new Date(stamp)).map(x => [x.type,x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  };
  let stamp = target;
  for (let i=0;i<4;i++) stamp += target-Date.parse(wall(stamp)+"Z");
  if (wall(stamp)!==desired) throw new Error("This time does not exist in the selected timezone. Choose another time.");
  return new Date(stamp).toISOString();
}

export function selectedTargets(ids: string[], accounts: ZernioAccountRef[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new Error("Choose at least one social account for this video.");
  return unique.map(id => {
    const account = accounts.find(a => a.id === id && a.active);
    if (!account) throw new Error("A selected account is disconnected or unavailable. Review the account selection.");
    return { accountId: account.id, platform: account.platform };
  });
}

export function planPatch(post: SmartPosterPost, body: Record<string, unknown>): SmartPosterPost {
  if (post.status === "published") throw new Error("Published posts cannot be changed here.");
  const next = { ...post };
  if (body.title !== undefined) next.title = String(body.title).trim();
  if (body.caption !== undefined) next.caption = String(body.caption);
  if (body.accountIds !== undefined) {
    if (!Array.isArray(body.accountIds) || body.accountIds.some(id => typeof id !== "string" || !id)) {
      throw new Error("Choose valid social accounts.");
    }
    next.accountIds = [...new Set(body.accountIds as string[])];
  }
  if (body.scheduledFor !== undefined) {
    if (body.scheduledFor === null || body.scheduledFor === "") next.scheduledFor = null;
    else {
      const value = String(body.scheduledFor);
      if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new Error("Choose a valid date and time with a timezone.");
      }
      next.scheduledFor = new Date(value).toISOString();
    }
  }
  if (body.timezone !== undefined) {
    const timezone = String(body.timezone);
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    next.timezone = timezone;
  }
  if (body.localDate !== undefined || body.localTime !== undefined) {
    next.scheduledFor = plannerTime(String(body.localDate || ""), String(body.localTime || ""), next.timezone);
  }
  next.targetDate = next.scheduledFor ? new Intl.DateTimeFormat("en-CA", {
    timeZone: next.timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(next.scheduledFor)) : null;
  if (!post.zernioPostId && post.status !== "scheduled") {
    next.status = next.scheduledFor && next.accountIds.length ? "ready" : "draft";
    next.error = null;
  }
  return next;
}

export function requireFutureSchedule(post: SmartPosterPost, now = Date.now()): void {
  if (!post.scheduledFor || !Number.isFinite(Date.parse(post.scheduledFor)) || Date.parse(post.scheduledFor) <= now + 60_000) {
    throw new Error("Choose a schedule at least one minute in the future.");
  }
}
