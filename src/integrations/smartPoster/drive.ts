/**
 * SmartPoster Google Drive via Composio (same managed OAuth as Harvey Plugins).
 * Operators connect with one click, then paste a Drive folder link to sync.
 */
import {
  composioReady,
  connectManaged,
  connectedToolkit,
  disconnectManaged,
  executeToolkit,
  managedConnections,
} from "../../harvey/work/composio.js";
import { driveDownloadSource } from "./driveDownload.js";
import { driveFolderIdFromUrl, isDriveVideo } from "./driveFolderUrl.js";
import { mediaSourceToBuffer, openMediaSource } from "./mediaStream.js";

export const DRIVE_SLUG = "googledrive";

export function driveComposioReady(): boolean {
  return composioReady();
}

export async function getComposioDriveStatus(owner: string): Promise<{
  connected: boolean;
  email: string | null;
  updatedAt: string | null;
  ready: boolean;
}> {
  if (!composioReady()) {
    return { connected: false, email: null, updatedAt: null, ready: false };
  }
  try {
    const found = connectedToolkit(await managedConnections(owner), DRIVE_SLUG);
    if (!found) return { connected: false, email: null, updatedAt: null, ready: true };
    const email =
      String(
        found.connection?.connectedAccount?.meta?.email
          || found.connection?.connectedAccount?.status
          || found.name
          || "",
      ).trim() || null;
    return {
      connected: true,
      email: email && email.includes("@") ? email : "Google Drive (Composio)",
      updatedAt: found.connection?.connectedAccount?.updatedAt
        ? String(found.connection.connectedAccount.updatedAt)
        : new Date().toISOString(),
      ready: true,
    };
  } catch {
    return { connected: false, email: null, updatedAt: null, ready: true };
  }
}

export async function startComposioDriveConnect(owner: string): Promise<{ url: string }> {
  if (!composioReady()) {
    throw new Error("Composio is not configured (COMPOSIO_API_KEY).");
  }
  return connectManaged(owner, null, DRIVE_SLUG, "/smartposter?drive=connected");
}

export async function disconnectComposioDrive(owner: string): Promise<void> {
  await disconnectManaged(owner, null, DRIVE_SLUG);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapData(value: unknown): unknown {
  let cur: unknown = value;
  for (let i = 0; i < 4; i++) {
    const rec = asRecord(cur);
    if (!rec) break;
    if (rec.data !== undefined) {
      cur = rec.data;
      continue;
    }
    break;
  }
  return cur;
}

function fileRows(value: unknown): Array<Record<string, unknown>> {
  const root = unwrapData(value);
  const rec = asRecord(root);
  const list =
    (Array.isArray(root) ? root : null)
    || (Array.isArray(rec?.files) ? rec!.files : null)
    || (Array.isArray(rec?.items) ? rec!.items : null)
    || (Array.isArray(rec?.folders) ? rec!.folders : null)
    || [];
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

export interface DriveFileRow {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
}

export interface DriveFolderRow {
  id: string;
  name: string;
}

export async function searchDriveFolders(
  owner: string,
  query: string,
): Promise<DriveFolderRow[]> {
  const q = String(query || "").trim();
  if (!q) return [];
  const raw = await executeToolkit(owner, "GOOGLEDRIVE_FIND_FOLDER", {
    name_contains: q.slice(0, 120),
    page_size: 25,
  });
  return fileRows(raw)
    .map((f) => ({
      id: String(f.id || ""),
      name: String(f.name || ""),
    }))
    .filter((f) => f.id && f.name);
}

export async function resolveFolderByName(
  owner: string,
  folderName: string,
): Promise<DriveFolderRow | null> {
  const name = String(folderName || "").trim();
  if (!name) return null;
  const exact = await executeToolkit(owner, "GOOGLEDRIVE_FIND_FOLDER", {
    name_exact: name,
    page_size: 10,
  });
  const exactHits = fileRows(exact)
    .map((f) => ({ id: String(f.id || ""), name: String(f.name || "") }))
    .filter((f) => f.id);
  const hit = exactHits.find((f) => f.name === name) || exactHits[0];
  if (hit) return hit;

  const fuzzy = await searchDriveFolders(owner, name);
  return fuzzy.find((f) => f.name.toLowerCase() === name.toLowerCase()) || fuzzy[0] || null;
}

export async function listFolderVideos(
  owner: string,
  folderId: string,
): Promise<DriveFileRow[]> {
  const rows: Array<Record<string, unknown>> = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const raw = await executeToolkit(owner, "GOOGLEDRIVE_FIND_FILE", {
      folderId, q: "trashed = false", pageSize: 100,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
      ...(pageToken ? {pageToken} : {}),
    });
    rows.push(...fileRows(raw));
    const next = asRecord(unwrapData(raw))?.nextPageToken;
    pageToken = typeof next === "string" && next ? next : undefined;
    if (pageToken) {
      if (seenTokens.has(pageToken)) throw new Error("Drive returned a repeated page token. Retry the import.");
      seenTokens.add(pageToken);
    }
  } while (pageToken);
  const out: DriveFileRow[] = [];
  for (const f of rows) {
    const name = String(f.name || "");
    const mime = String(f.mimeType || "");
    if (!isDriveVideo(name, mime)) continue;
    out.push({
      id: String(f.id || ""),
      name,
      mimeType: mime,
      size: f.size != null ? Number(f.size) : null,
      modifiedTime: f.modifiedTime != null ? String(f.modifiedTime) : null,
    });
  }
  return out.filter((f) => f.id);
}

function bufferFromDownloadPayload(payload: unknown): Buffer | null {
  const root = unwrapData(payload);
  const rec = asRecord(root) || {};
  const candidates: unknown[] = [
    rec.downloaded_file_content,
    rec.downloadedFileContent,
    rec.content,
    rec.bytes,
  ];
  for (const c of candidates) {
    if (typeof c !== "string" || !c.trim()) continue;
    if (/^https?:\/\//i.test(c)) continue;
    const cleaned = c.replace(/^data:[^;]+;base64,/, "");
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(cleaned.slice(0, 200)) && cleaned.length > 64) {
      try {
        return Buffer.from(cleaned, "base64");
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

async function driveFileDownloadResult(owner: string, fileId: string): Promise<{
  ok: boolean;
  error?: string;
  data?: unknown;
}> {
  const raw = await executeToolkit(owner, "GOOGLEDRIVE_DOWNLOAD_FILE", {
    file_id: fileId,
    fileId,
  });
  if (raw && typeof raw === "object" && "ok" in (raw as object)) {
    return raw as { ok: boolean; error?: string; data?: unknown };
  }
  return { ok: true, data: raw };
}

/** Stream a Drive video (supports Range) for in-app preview. */
export async function openDriveVideo(
  owner: string,
  fileId: string,
  opts?: { range?: string },
): Promise<Response> {
  const raw = await driveFileDownloadResult(owner, fileId);
  const source = driveDownloadSource(raw);
  return openMediaSource(source, { range: opts?.range });
}

export async function downloadDriveFile(owner: string, fileId: string): Promise<Buffer> {
  const raw = await driveFileDownloadResult(owner, fileId);
  const direct = bufferFromDownloadPayload(raw.data ?? raw);
  if (direct?.length) return direct;
  return mediaSourceToBuffer(driveDownloadSource(raw));
}

/** Bind settings to a pasted Drive folder link (or keep a resolved id). */
export async function resolveFolderFromLink(
  owner: string,
  folderUrlOrId: string,
): Promise<{ id: string; name: string }> {
  const raw = String(folderUrlOrId || "").trim();
  if (!raw) throw new Error("Paste a Google Drive folder link in SmartPoster settings.");
  const fromUrl = driveFolderIdFromUrl(raw);
  const id = fromUrl || (/^[A-Za-z0-9_-]{10,200}$/.test(raw) ? raw : null);
  if (!id) {
    throw new Error(
      "Paste a full Google Drive folder link (drive.google.com/drive/folders/…).",
    );
  }
  try {
    const meta = await executeToolkit(owner, "GOOGLEDRIVE_FIND_FILE", {
      q: `'${id.replace(/'/g, "\\'")}' in parents and trashed = false`,
      pageSize: 1,
      fields: "files(id,name)",
    });
    void meta;
  } catch {
    /* Listing parents is enough validation when FIND_FILE by id is unavailable. */
  }
  return { id, name: "Drive folder" };
}

export async function readSidecarJson(
  owner: string,
  folderId: string,
  stem: string,
): Promise<Record<string, unknown> | null> {
  const name = `${stem}.json`;
  const raw = await executeToolkit(owner, "GOOGLEDRIVE_FIND_FILE", {
    folderId,
    q: `name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    pageSize: 1,
    fields: "files(id,name)",
  });
  const id = fileRows(raw)[0] && String(fileRows(raw)[0].id || "");
  if (!id) return null;
  const bytes = await downloadDriveFile(owner, id);
  try {
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Prefer a pasted folder link / cached id. Fall back to folder-name search only
 * when no id is available (legacy settings).
 */
export async function ensureFolderId(
  owner: string,
  folderName: string,
  cachedId?: string,
  folderUrl?: string,
): Promise<{ id: string; name: string }> {
  const link = String(folderUrl || "").trim();
  if (link) {
    const resolved = await resolveFolderFromLink(owner, link);
    return { id: resolved.id, name: String(folderName || resolved.name).trim() || resolved.name };
  }
  if (cachedId?.trim()) {
    return { id: cachedId.trim(), name: String(folderName || "Drive folder").trim() || "Drive folder" };
  }
  const name = String(folderName || "").trim();
  if (!name) {
    throw new Error("Paste a Google Drive folder link in SmartPoster settings.");
  }
  const found = await resolveFolderByName(owner, name);
  if (!found) {
    throw new Error(
      `No Drive folder named "${name}" found. Paste the folder link instead.`,
    );
  }
  return found;
}
