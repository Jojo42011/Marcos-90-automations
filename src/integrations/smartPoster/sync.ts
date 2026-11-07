import { planPatch, requireFutureSchedule, selectedTargets } from "../../core/smartPosterPlanning.js";
/**
 * SmartPoster daily Drive pull → review inbox → explicit per-account Zernio schedule.
 */
import { tenantOwner } from "../../core/tenantData.js";
import {
  findByDriveFileId,
  getPost,
  getSettings,
  listPosts,
  localDateISO,
  saveSettings,
  upsertPost,
  type SmartPosterPost,
} from "../../core/smartPosterStore.js";
import { listZernioAccounts } from "../zernio/index.js";
import { createZernioPost, updateZernioPost, uploadBufferToZernio } from "../zernio/posts.js";
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

const publishing = new Set<string>();
export function isPostBusy(id: string): boolean { return publishing.has(id); }

export async function updateSmartPosterPost(id: string, body: Record<string, unknown>, publish = false, owner = smartPosterOwner()): Promise<SmartPosterPost> {
  if (publishing.has(id)) throw new Error("This post is already being saved. Wait for it to finish.");
  publishing.add(id);
  try {
    const current = getPost(id);
    if (!current) throw new Error("Post not found");
    const next = planPatch(current, body);
    if (body.accountIds !== undefined || publish || current.zernioPostId) {
      const accounts = await listZernioAccounts();
      if (!accounts.ok) throw new Error(accounts.error || "Could not check social accounts");
      if (publish) { requireFutureSchedule(next); selectedTargets(next.accountIds, accounts.accounts); }
      if (next.accountIds.length) next.platforms = [...new Set(selectedTargets(next.accountIds, accounts.accounts).map(a => a.platform))];
      else next.platforms = [];
    }
    if (current.zernioPostId || current.status === "scheduled") {
      if (!current.zernioPostId) throw new Error("This scheduled post has no provider ID. Check it in Zernio before editing.");
      requireFutureSchedule(next);
      const accounts = await listZernioAccounts();
      if (!accounts.ok) throw new Error(accounts.error || "Could not check social accounts");
      const targets = selectedTargets(next.accountIds, accounts.accounts);
      const result = await updateZernioPost(current.zernioPostId, {
        content: next.caption || next.title, scheduledFor: next.scheduledFor!, timezone: "UTC",
        platforms: targets.map(t => ({...t, ...(t.platform === "youtube" ? {platformSpecificData:{title:next.title.slice(0,100),visibility:"public"}} : {})})),
      });
      if (!result.ok) throw new Error(result.error || "Zernio could not update this schedule; your existing schedule is unchanged locally.");
      return upsertPost({...next, status:"scheduled", error:null});
    }
    const saved = upsertPost(next);
    return publish ? await publishPost(saved, owner) : saved;
  } finally { publishing.delete(id); }
}

export async function schedulePostToZernio(post: SmartPosterPost, owner = smartPosterOwner()): Promise<SmartPosterPost> {
  // Re-read and serialize: double-clicks cannot upload/publish the same draft twice.
  if (post.zernioPostId || post.status === "scheduled" || post.status === "published") return post;
  return updateSmartPosterPost(post.id, {}, true, owner);
}

async function publishPost(
  post: SmartPosterPost,
  owner = smartPosterOwner(),
): Promise<SmartPosterPost> {
  requireFutureSchedule(post);
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
  const targets = selectedTargets(post.accountIds, accounts.accounts);
  const resolved = {targets, accountIds:targets.map(t => t.accountId), platforms:[...new Set(targets.map(t => t.platform))]};
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

    const created = await createZernioPost({
      content: post.caption || post.title || post.fileName,
      mediaUrl: uploaded.publicUrl,
      mediaType: "video",
      platforms,
      scheduledFor: post.scheduledFor,
      timezone: "UTC",
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
      error: created.postId ? null : "Zernio accepted the schedule without a post ID. Check Zernio before making further changes.",
    });
  } catch (err) {
    return upsertPost({
      ...post,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function syncInbox(opts?: {
  date?: string;
  forceSchedule?: boolean;
  owner?: string;
}): Promise<SyncResult> {
  const owner = smartPosterOwner(opts?.owner);
  const settings = getSettings();
  const drive = await getComposioDriveStatus(owner);

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

    for (const file of files) {
      const parsed = parseVideoFileName(file.name);
      // A finished-video folder is an inbox, not a date filter. Never overwrite an editor's plan.
      const existing = findByDriveFileId(file.id);
      if (existing) { skipped += 1; continue; }

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
      const post = upsertPost({
        driveFileId: file.id, fileName: file.name,
        title: sidecarTitle || parsed.slug || file.name, caption,
        platforms: [], accountIds: [], status: "inbox", targetDate: null, scheduledFor: null,
        timezone: settings.timezone, error: null,
      });
      created += 1;
      touched.push(post);
    }

    const note =
      `Checked ${scanned} finished video(s): ${created} added to inbox, ${scheduled} scheduled, `
      + `${skipped} skipped, ${failed} failed.`;
    saveSettings({ lastSyncAt: new Date().toISOString(), lastSyncNote: note });
    return { ok: failed === 0, scanned, created, scheduled, skipped, failed, note, posts: touched };
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    saveSettings({ lastSyncAt: new Date().toISOString(), lastSyncNote: note });
    return { ok: false, scanned, created, scheduled, skipped, failed: failed + 1, note, posts: touched };
  }
}

let syncInFlight: Promise<SyncResult> | null = null;
export function runSmartPosterSync(opts?: {date?:string;forceSchedule?:boolean;owner?:string}): Promise<SyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = syncInbox(opts).finally(() => { syncInFlight = null; });
  return syncInFlight;
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
  if (hour < settings.ingestHour) return;
  if (settings.lastSyncAt && localDateISO(settings.timezone, new Date(settings.lastSyncAt)) === today) return;
  if (lastAutoDate === today) return;
  lastAutoDate = today;
  await runSmartPosterSync({ date: today, owner });
}

export async function getSmartPosterOverview(owner = smartPosterOwner()) {
  const settings = getSettings();
  const drive = await getComposioDriveStatus(owner);
  const accounts = await listZernioAccounts();
  const posts = listPosts({ limit: 0 });
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
