/**
 * Google Drive helpers for SmartPoster inbox sync.
 * Uses the same Google OAuth app credentials as Harvey (HARVEY_GOOGLE_*),
 * with tokens stored account-locally in smartPosterStore.
 */
import {
  clearDriveAuth,
  getDriveAuth,
  readDriveTokens,
  saveDriveTokens,
} from "../../core/smartPosterStore.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const DRIVE = "https://www.googleapis.com/drive/v3/";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email";

export function googleOAuthConfigured(): boolean {
  return Boolean(
    process.env.HARVEY_GOOGLE_CLIENT_ID?.trim()
      && process.env.HARVEY_GOOGLE_CLIENT_SECRET?.trim()
      && process.env.HARVEY_PUBLIC_URL?.trim()
      && process.env.HARVEY_VAULT_KEY?.trim(),
  );
}

export function driveCallbackUrl(): string {
  const base = process.env.HARVEY_PUBLIC_URL?.trim();
  if (!base) throw new Error("HARVEY_PUBLIC_URL is not set");
  return new URL("/api/smartposter/drive/callback", base).toString();
}

export function startDriveOAuth(state: string): string {
  const clientId = process.env.HARVEY_GOOGLE_CLIENT_ID?.trim();
  if (!clientId) throw new Error("Google OAuth is not configured (HARVEY_GOOGLE_CLIENT_ID)");
  const url = new URL(AUTH);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", driveCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchange(params: Record<string, string>): Promise<Record<string, unknown>> {
  const clientId = process.env.HARVEY_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.HARVEY_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google OAuth credentials missing");
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      ...params,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || !data.access_token) {
    throw new Error(`Google auth failed: ${String(data.error || res.status)}`);
  }
  return {
    ...data,
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
  };
}

export async function finishDriveOAuth(code: string): Promise<{ email: string | null }> {
  const tokens = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: driveCallbackUrl(),
  });
  let email: string | null = null;
  try {
    const me = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (me.ok) {
      const body = (await me.json()) as { email?: string };
      email = body.email || null;
    }
  } catch {
    /* optional */
  }
  saveDriveTokens(tokens, email);
  return { email };
}

export function disconnectDrive(): void {
  clearDriveAuth();
}

async function accessToken(): Promise<string> {
  let tokens = readDriveTokens();
  if (!tokens?.access_token && !tokens?.refresh_token) {
    throw new Error("Google Drive is not connected");
  }
  if (tokens.expiresAt && Number(tokens.expiresAt) < Date.now() + 60_000) {
    if (!tokens.refresh_token) throw new Error("Drive login expired — reconnect Google Drive");
    const fresh = await exchange({
      grant_type: "refresh_token",
      refresh_token: String(tokens.refresh_token),
    });
    tokens = { ...tokens, ...fresh, refresh_token: tokens.refresh_token };
    saveDriveTokens(tokens, getDriveAuth().email);
  }
  return String(tokens.access_token);
}

export interface DriveFileRow {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
}

export async function listFolderVideos(folderId: string): Promise<DriveFileRow[]> {
  const token = await accessToken();
  const q = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
  const fields = "nextPageToken,files(id,name,mimeType,size,modifiedTime)";
  const out: DriveFileRow[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("files", DRIVE);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", fields);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Drive list failed: ${text.slice(0, 300)}`);
    const json = JSON.parse(text) as {
      files?: Array<Record<string, unknown>>;
      nextPageToken?: string;
    };
    for (const f of json.files || []) {
      const name = String(f.name || "");
      const mime = String(f.mimeType || "");
      const video =
        mime.startsWith("video/")
        || /\.(mp4|mov|m4v|webm|avi|mpeg|mpg)$/i.test(name);
      if (!video) continue;
      out.push({
        id: String(f.id),
        name,
        mimeType: mime,
        size: f.size != null ? Number(f.size) : null,
        modifiedTime: f.modifiedTime != null ? String(f.modifiedTime) : null,
      });
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const token = await accessToken();
  const url = new URL(`files/${encodeURIComponent(fileId)}`, DRIVE);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5 * 60_000),
    redirect: "follow",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive download failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function readSidecarJson(
  folderId: string,
  stem: string,
): Promise<Record<string, unknown> | null> {
  const token = await accessToken();
  const name = `${stem}.json`.replace(/'/g, "\\'");
  const q = `'${folderId.replace(/'/g, "\\'")}' in parents and name = '${name}' and trashed = false`;
  const url = new URL("files", DRIVE);
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { files?: Array<{ id: string }> };
  const id = json.files?.[0]?.id;
  if (!id) return null;
  const bytes = await downloadDriveFile(id);
  try {
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function resolveFolderName(folderId: string): Promise<string | null> {
  const token = await accessToken();
  const url = new URL(`files/${encodeURIComponent(folderId)}`, DRIVE);
  url.searchParams.set("fields", "id,name,mimeType");
  url.searchParams.set("supportsAllDrives", "true");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { name?: string };
  return json.name || null;
}
