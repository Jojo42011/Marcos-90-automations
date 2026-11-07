/**
 * SmartPoster Google Drive via Composio (same managed OAuth as Harvey Plugins).
 * Operators connect with one click — no Google client IDs or pasted folder IDs.
 */
import {
  composioReady,
  connectManaged,
  connectedToolkit,
  disconnectManaged,
  executeToolkit,
  managedConnections,
} from "../../harvey/work/composio.js";

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
  const raw = await executeToolkit(owner, "GOOGLEDRIVE_FIND_FILE", {
    folderId,
    q: "trashed = false",
    pageSize: 100,
    fields: "files(id,name,mimeType,size,modifiedTime)",
  });
  const out: DriveFileRow[] = [];
  for (const f of fileRows(raw)) {
    const name = String(f.name || "");
    const mime = String(f.mimeType || "");
    const video =
      mime.startsWith("video/")
      || /\.(mp4|mov|m4v|webm|avi|mpeg|mpg)$/i.test(name);
    if (!video) continue;
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
    rec.file,
    rec.bytes,
    rec.data,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      /* Prefer base64 when it looks like it; otherwise treat as latin1 bytes. */
      const cleaned = c.replace(/^data:[^;]+;base64,/, "");
      if (/^[A-Za-z0-9+/=\r\n]+$/.test(cleaned.slice(0, 200)) && cleaned.length > 64) {
        try {
          return Buffer.from(cleaned, "base64");
        } catch {
          /* fall through */
        }
      }
      return Buffer.from(c, "binary");
    }
    if (c && typeof c === "object") {
      const nested = asRecord(c);
      if (nested && typeof nested.s3url === "string") candidates.push(nested.s3url);
      if (nested && typeof nested.url === "string") candidates.push(nested.url);
      if (nested && typeof nested.content === "string") candidates.push(nested.content);
    }
  }

  const url =
    (typeof rec.download_url === "string" && rec.download_url)
    || (typeof rec.downloadUrl === "string" && rec.downloadUrl)
    || (typeof rec.url === "string" && rec.url)
    || (typeof rec.s3url === "string" && rec.s3url)
    || null;
  return url ? null /* signal fetch below */ : null;
}

async function fetchUrlBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000), redirect: "follow" });
  if (!res.ok) throw new Error(`Drive download URL failed HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function downloadDriveFile(owner: string, fileId: string): Promise<Buffer> {
  const raw = await executeToolkit(owner, "GOOGLEDRIVE_DOWNLOAD_FILE", { fileId });
  const direct = bufferFromDownloadPayload(raw);
  if (direct && direct.length) return direct;

  const root = asRecord(unwrapData(raw)) || asRecord(raw) || {};
  const url =
    (typeof root.download_url === "string" && root.download_url)
    || (typeof root.downloadUrl === "string" && root.downloadUrl)
    || (typeof root.url === "string" && root.url)
    || (typeof root.s3url === "string" && root.s3url)
    || (typeof asRecord(root.file)?.url === "string" && String(asRecord(root.file)!.url))
    || null;
  if (url && /^https?:\/\//i.test(url)) return fetchUrlBytes(url);

  throw new Error("Composio Drive download returned no file bytes");
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

/** Ensure settings.driveFolderId matches the chosen folder name via Composio. */
export async function ensureFolderId(
  owner: string,
  folderName: string,
  cachedId?: string,
): Promise<{ id: string; name: string }> {
  const name = String(folderName || "").trim();
  if (!name) throw new Error("Pick a Drive folder name in SmartPoster settings.");
  if (cachedId?.trim()) {
    return { id: cachedId.trim(), name };
  }
  const found = await resolveFolderByName(owner, name);
  if (!found) {
    throw new Error(
      `No Drive folder named "${name}" found. Create it in Google Drive, then pick it here.`,
    );
  }
  return found;
}
