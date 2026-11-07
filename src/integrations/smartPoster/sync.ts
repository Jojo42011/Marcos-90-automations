/**
 * SmartPoster daily Drive pull → caption → slot → Zernio schedule.
 */
import { tenantOwner } from "../../core/tenantData.js";
import {
  findByDriveFileId,
  getSettings,
  listPosts,
  localDateISO,
  nextOpenSlot,
  saveSettings,
  upsertPost,
  type SmartPosterPost,
} from "../../core/smartPosterStore.js";
import { listZernioAccounts, type ZernioAccountRef } from "../zernio/index.js";
import { createZernioPost, uploadBufferToZernio } from "../zernio/posts.js";
import { draftCaption, parseVideoFileName } from "./captions.js";
import {
  downloadDriveFile,
  ensureFolderId,
  getComposioDriveStatus,
  listFolderVideos,
  readSidecarJson,
} from "./drive.js";

function smartPosterOwner(explicit?: string): string {
  return String(explicit || tenantOwner() || "operator");
}

export interface SyncResult {
  ok: boolean;
  scanned: number;
  created: number;
  scheduled: number;
  skipped: number;
  failed: number;
  note: string;
  posts: SmartPosterPost[];
}

function resolveAccounts(
  platforms: string[],
  accounts: ZernioAccountRef[],
): { platforms: string[]; accountIds: string[]; targets: Array<{ platform: string; accountId: string }> } {
  const active = accounts.filter((a) => a.active);
  const wantAll = platforms.includes("all") || !platforms.length;
  const want = wantAll
    ? active
    : active.filter((a) => platforms.includes(a.platform));
  const targets = want.map((a) => ({ platform: a.platform, accountId: a.id }));
  return {
    platforms: [...new Set(targets.map((t) => t.platform))],
    accountIds: targets.map((t) => t.accountId),
    targets,
  };
}

export async function schedulePostToZernio(
  post: SmartPosterPost,
  owner = smartPosterOwner(),
): Promise<SmartPosterPost> {
  const settings = getSettings();
  if (!post.driveFileId) {
    return upsertPost({
      ...post,
      status: "failed",
      error: "Missing Drive file id — cannot upload media",
    });
  }
  if (!post.scheduledFor) {
    return upsertPost({
      ...post,
      status: "failed",
      error: "No scheduled time assigned",
    });
  }

  const accounts = await listZernioAccounts();
  if (!accounts.ok) {
    return upsertPost({
      ...post,
      status: "failed",
      error: accounts.error || "Could not list Zernio accounts",
    });
  }
  const resolved = resolveAccounts(post.platforms, accounts.accounts);
  if (!resolved.targets.length) {
    return upsertPost({
      ...post,
      status: "failed",
      error: "No matching Zernio social accounts for the requested platforms",
    });
  }

  try {
    const bytes = await downloadDriveFile(owner, post.driveFileId);
    const uploaded = await uploadBufferToZernio(post.fileName, bytes);
    if (!uploaded.ok || !uploaded.publicUrl) {
      return upsertPost({
        ...post,
        status: "failed",
        error: uploaded.error || "Media upload to Zernio failed",
      });
    }

    const platforms = resolved.targets.map((t) => {
      const entry: {
        platform: string;
        accountId: string;
        platformSpecificData?: Record<string, unknown>;
      } = { platform: t.platform, accountId: t.accountId };
      if (t.platform === "youtube") {
        entry.platformSpecificData = {
          title: (post.title || post.fileName).slice(0, 100),
          visibility: "public",
        };
      }
      return entry;
    });

    /* Zernio reads scheduledFor in `timezone` — pass wall-clock local, not UTC. */
    const tz = post.timezone || settings.timezone;
    const wall = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(post.scheduledFor));
    const part = (t: string) => wall.find((p) => p.type === t)?.value || "00";
    const scheduledLocal = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;

    const created = await createZernioPost({
      content: post.caption || post.title || post.fileName,
      mediaUrl: uploaded.publicUrl,
      mediaType: "video",
      platforms,
      scheduledFor: scheduledLocal,
      timezone: tz,
      title: post.title || undefined,
    });

    if (!created.ok) {
      return upsertPost({
        ...post,
        mediaUrl: uploaded.publicUrl,
        accountIds: resolved.accountIds,
        platforms: resolved.platforms.length ? resolved.platforms : post.platforms,
        status: "failed",
        error: created.error || "Zernio create post failed",
      });
    }

    return upsertPost({
      ...post,
      mediaUrl: uploaded.publicUrl,
      accountIds: resolved.accountIds,
      platforms: resolved.platforms.length ? resolved.platforms : post.platforms,
      status: "scheduled",
      zernioPostId: created.postId || null,
      platformPostUrl: created.platformPostUrl || null,
      error: null,
    });
  } catch (err) {
    return upsertPost({
      ...post,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runSmartPosterSync(opts?: {
  date?: string;
  forceSchedule?: boolean;
  owner?: string;
}): Promise<SyncResult> {
  const owner = smartPosterOwner(opts?.owner);
  const settings = getSettings();
  const drive = await getComposioDriveStatus(owner);
  const today = opts?.date || localDateISO(settings.timezone);

  if (!drive.connected) {
    const note = "Connect Google Drive in SmartPoster settings (Composio) first.";
    saveSettings({ lastSyncAt: new Date().toISOString(), lastSyncNote: note });
    return { ok: false, scanned: 0, created: 0, scheduled: 0, skipped: 0, failed: 0, note, posts: [] };
  }
  if (!settings.driveFolderName.trim() && !settings.driveFolderId.trim()) {
    const note = "Pick a Drive folder by name in SmartPoster settings.";
    saveSettings({ lastSyncAt: new Date().toISOString(), lastSyncNote: note });
    return { ok: false, scanned: 0, created: 0, scheduled: 0, skipped: 0, failed: 0, note, posts: [] };
  }

  let scanned = 0;
  let created = 0;
  let scheduled = 0;
  let skipped = 0;
  let failed = 0;
  const touched: SmartPosterPost[] = [];

  try {
    const folder = await ensureFolderId(
      owner,
      settings.driveFolderName || "SmartPoster",
      settings.driveFolderId || undefined,
    );
    if (folder.id !== settings.driveFolderId || folder.name !== settings.driveFolderName) {
      saveSettings({ driveFolderId: folder.id, driveFolderName: folder.name });
    }

    const files = await listFolderVideos(owner, folder.id);
    scanned = files.length;

    const accounts = await listZernioAccounts();
    const zAccounts = accounts.ok ? accounts.accounts : [];

    const occupied = listPosts()
      .filter((p) => p.scheduledFor && ["ready", "scheduled", "published"].includes(p.status))
      .map((p) => p.scheduledFor!) ;

    for (const file of files) {
      const parsed = parseVideoFileName(file.name);
      const targetDate = parsed.targetDate || today;
      /* Only auto-ingest today's dated files (or undated → today). Future dates wait. */
      if (parsed.targetDate && parsed.targetDate !== today && !opts?.date) {
        skipped += 1;
        continue;
      }
      if (opts?.date && parsed.targetDate && parsed.targetDate !== opts.date) {
        skipped += 1;
        continue;
      }

      const existing = findByDriveFileId(file.id);
      if (existing && ["scheduled", "published"].includes(existing.status)) {
        skipped += 1;
        continue;
      }

      const stem = file.name.replace(/\.[^.]+$/, "");
      const sidecar = await readSidecarJson(owner, folder.id, stem).catch(() => null);
      const sidecarCaption =
        sidecar && typeof sidecar.caption === "string" ? sidecar.caption : null;
      const sidecarTitle =
        sidecar && typeof sidecar.title === "string" ? sidecar.title : null;
      let platforms = parsed.platforms;
      if (Array.isArray(sidecar?.platforms)) {
        platforms = (sidecar!.platforms as unknown[])
          .map((p) => String(p).toLowerCase())
          .filter(Boolean);
      }

      const caption = await draftCaption({
        slug: parsed.slug,
        platforms,
        sidecarCaption,
      });
      const resolved = resolveAccounts(platforms, zAccounts);
      const slot =
        existing?.scheduledFor
        || nextOpenSlot(targetDate, occupied, settings.slots, settings.timezone);
      if (slot) occupied.push(slot);

      let post = upsertPost({
        id: existing?.id,
        driveFileId: file.id,
        fileName: file.name,
        title: sidecarTitle || parsed.slug || file.name,
        caption,
        platforms: resolved.platforms.length ? resolved.platforms : platforms,
        accountIds: resolved.accountIds,
        status: settings.autoSchedule || opts?.forceSchedule ? "ready" : "draft",
        targetDate,
        scheduledFor: slot,
        timezone: settings.timezone,
        error: null,
      });
      if (!existing) created += 1;

      if ((settings.autoSchedule || opts?.forceSchedule) && post.scheduledFor) {
        post = await schedulePostToZernio(post, owner);
        if (post.status === "scheduled") scheduled += 1;
        else if (post.status === "failed") failed += 1;
      }
      touched.push(post);
    }

    const note =
      `Synced ${scanned} video(s) for ${today}: ${created} new, ${scheduled} scheduled, `
      + `${skipped} skipped, ${failed} failed.`;
    saveSettings({ lastSyncAt: new Date().toISOString(), lastSyncNote: note });
    return { ok: failed === 0, scanned, created, scheduled, skipped, failed, note, posts: touched };
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    saveSettings({ lastSyncAt: new Date().toISOString(), lastSyncNote: note });
    return { ok: false, scanned, created, scheduled, skipped, failed: failed + 1, note, posts: touched };
  }
}

/** Tick used by the server interval — runs once in the ingest hour window. */
let lastAutoDate: string | null = null;

export async function maybeAutoSync(): Promise<void> {
  const owner = smartPosterOwner();
  const settings = getSettings();
  const drive = await getComposioDriveStatus(owner);
  if (!drive.connected || (!settings.driveFolderName && !settings.driveFolderId)) return;
  const now = new Date();
  const today = localDateISO(settings.timezone, now);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: settings.timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  if (hour !== settings.ingestHour) return;
  if (lastAutoDate === today) return;
  lastAutoDate = today;
  await runSmartPosterSync({ date: today, owner });
}

export async function getSmartPosterOverview(owner = smartPosterOwner()) {
  const settings = getSettings();
  const drive = await getComposioDriveStatus(owner);
  const accounts = await listZernioAccounts();
  const posts = listPosts({ limit: 300 });
  const today = localDateISO(settings.timezone);
  return {
    settings: {
      ...settings,
      /* UI should key off folder name; id is an internal cache after pick/sync. */
    },
    drive,
    composioReady: drive.ready,
    googleOAuthReady: drive.ready,
    zernioConfigured: accounts.ok || Boolean(accounts.error),
    accounts: accounts.ok ? accounts.accounts.filter((a) => a.active) : [],
    accountsError: accounts.ok ? null : accounts.error || null,
    today,
    counts: {
      inbox: posts.filter((p) => p.status === "inbox" || p.status === "draft").length,
      ready: posts.filter((p) => p.status === "ready").length,
      scheduled: posts.filter((p) => p.status === "scheduled").length,
      published: posts.filter((p) => p.status === "published").length,
      failed: posts.filter((p) => p.status === "failed").length,
    },
    posts,
  };
}
