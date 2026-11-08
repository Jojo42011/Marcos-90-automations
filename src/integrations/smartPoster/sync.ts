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
import { createZernioPost, getZernioPostStatus, updateZernioPost, uploadBufferToZernio } from "../zernio/posts.js";
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

  let submitted=false;
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

    // Persist before the network call: a crash must not turn an accepted schedule into a retryable draft.
    requireFutureSchedule(post); // Upload time may have consumed the original scheduling margin.
    upsertPost({...post,mediaUrl:uploaded.publicUrl,status:'scheduled',error:'Schedule confirmation pending. Check Zernio before retrying.'});
    submitted=true;
    const created = await createZernioPost({
      idempotencyKey: post.id,
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
        status: created.uncertain ? "scheduled" : "failed",
        error: created.uncertain ? "Schedule outcome unknown. Check Zernio before making changes." : created.error || "Zernio create post failed",
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
      status: submitted ? "scheduled" : "failed",
      error: submitted ? "Schedule outcome unknown. Check Zernio before making changes." : err instanceof Error ? err.message : String(err),
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
    saveSettings({ lastSyncAt: new Date().toISOString(), lastSuccessfulSyncAt: new Date().toISOString(), lastSyncNote: note });
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

/** Persistent cadence survives restarts; failures retry after 15 minutes. */
export function importDue(settings: ReturnType<typeof getSettings>, now = new Date()): boolean {
  const attempt = Date.parse(settings.lastAutoAttemptAt || '');
  if (Number.isFinite(attempt) && now.getTime()-attempt < 15*60_000) return false;
  const success = Date.parse(settings.lastSuccessfulSyncAt || '');
  if (settings.ingestIntervalMinutes > 0) return !Number.isFinite(success) || now.getTime()-success >= settings.ingestIntervalMinutes*60_000;
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:settings.timezone,hour:'numeric',hourCycle:'h23'}).format(now));
  return hour >= settings.ingestHour && (!Number.isFinite(success) || localDateISO(settings.timezone,new Date(success)) !== localDateISO(settings.timezone,now));
}
let autoRunning=false;
export async function maybeAutoSync(): Promise<void> {
  if(autoRunning) return;
  autoRunning=true;
  try {
    void reconcileScheduledPosts().catch(()=>{});
    const settings=getSettings();
    if ((!settings.driveFolderName && !settings.driveFolderId) || !importDue(settings)) return;
    saveSettings({lastAutoAttemptAt:new Date().toISOString()});
    await runSmartPosterSync({owner:smartPosterOwner()});
  } finally {autoRunning=false;}
}
let lastReconcile=0;
let reconciling:Promise<void>|null=null;
export async function reconcileScheduledPosts():Promise<void> {
  if(reconciling)return reconciling;
  if(Date.now()-lastReconcile<5*60_000)return;
  reconciling=(async()=>{
    const posts=listPosts({limit:0}).filter(p=>p.zernioPostId && p.status==='scheduled');
    for(const post of posts){
      if(publishing.has(post.id))continue;
      publishing.add(post.id);
      try{
        const result=await getZernioPostStatus(post.zernioPostId!);
        if(result.ok && result.status==='published')upsertPost({...post,status:'published',platformPostUrl:result.url||post.platformPostUrl,error:null});
        else if(result.ok && ['failed','partial','cancelled','canceled'].includes(result.status||''))upsertPost({...post,status:'failed',error:result.error||'The provider reported '+result.status+'. Review this post in Zernio before retrying.'});
      }catch{/* Provider outage is not a publishing failure; keep the known schedule. */}
      finally{publishing.delete(post.id);}
    }
    lastReconcile=Date.now();
  })().finally(()=>{reconciling=null;});
  return reconciling;
}

export async function getSmartPosterOverview(owner = smartPosterOwner()) {
  void reconcileScheduledPosts().catch(()=>{});
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
