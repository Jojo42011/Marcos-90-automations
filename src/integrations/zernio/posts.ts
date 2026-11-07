/**
 * Zernio publishing — media presign + create/schedule posts.
 * Docs: POST /v1/media/presign, POST /v1/posts
 */
import { currentZernioSecrets } from "../../core/zernioOwnerConfig.js";
import { zernioBaseUrl } from "./index.js";

const TIMEOUT_MS = 60_000;

/** Update a scheduled post in-place; never create a replacement as a fallback. */
export async function updateZernioPost(postId: string, body: {
  content: string; scheduledFor: string; timezone: string;
  platforms: CreateZernioPostInput["platforms"];
}): Promise<{ok:boolean;error?:string}> {
  const r = await zernioJson("PUT", `/posts/${encodeURIComponent(postId)}`, {...body, isDraft:false});
  if (!r.ok) return {ok:false,error:(r.json as {error?:string})?.error || r.text.slice(0,400) || `HTTP ${r.status}`};
  return {ok:true};
}

function apiKey(): string {
  return currentZernioSecrets().apiKey;
}

async function zernioJson(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const key = apiKey();
  if (!key) return { ok: false, status: 0, json: null, text: "ZERNIO_DM_API_KEY is not set" };
  const res = await fetch(`${zernioBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  return { ok: res.ok, status: res.status, json, text };
}

export function mimeForFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    webm: "video/webm",
    avi: "video/x-msvideo",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext] || "video/mp4";
}

export async function presignMedia(input: {
  filename: string;
  contentType: string;
  size?: number;
}): Promise<{ ok: boolean; uploadUrl?: string; publicUrl?: string; error?: string }> {
  const r = await zernioJson("POST", "/media/presign", {
    filename: input.filename,
    contentType: input.contentType,
    ...(input.size != null ? { size: input.size } : {}),
  });
  if (!r.ok) {
    return {
      ok: false,
      error: (r.json as { error?: string } | null)?.error || r.text.slice(0, 300) || `HTTP ${r.status}`,
    };
  }
  const data = (r.json || {}) as { uploadUrl?: string; publicUrl?: string };
  if (!data.uploadUrl || !data.publicUrl) {
    return { ok: false, error: "Presign response missing uploadUrl/publicUrl" };
  }
  return { ok: true, uploadUrl: data.uploadUrl, publicUrl: data.publicUrl };
}

export async function putMedia(
  uploadUrl: string,
  bytes: Buffer,
  contentType: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Upload failed HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uploadBufferToZernio(filename: string, bytes: Buffer): Promise<{
  ok: boolean;
  publicUrl?: string;
  error?: string;
}> {
  const contentType = mimeForFilename(filename);
  const presigned = await presignMedia({ filename, contentType, size: bytes.length });
  if (!presigned.ok || !presigned.uploadUrl || !presigned.publicUrl) {
    return { ok: false, error: presigned.error || "Presign failed" };
  }
  const put = await putMedia(presigned.uploadUrl, bytes, contentType);
  if (!put.ok) return { ok: false, error: put.error };
  return { ok: true, publicUrl: presigned.publicUrl };
}

export interface CreateZernioPostInput {
  content: string;
  mediaUrl: string;
  mediaType?: "video" | "image";
  platforms: Array<{ platform: string; accountId: string; platformSpecificData?: Record<string, unknown> }>;
  scheduledFor?: string;
  timezone?: string;
  publishNow?: boolean;
  isDraft?: boolean;
  title?: string;
}

export async function createZernioPost(input: CreateZernioPostInput): Promise<{
  ok: boolean;
  postId?: string;
  status?: string;
  platformPostUrl?: string | null;
  error?: string;
  raw?: unknown;
}> {
  if (!apiKey()) return { ok: false, error: "ZERNIO_DM_API_KEY is not set" };
  if (!input.platforms.length && !input.isDraft) {
    return { ok: false, error: "At least one platform target is required" };
  }

  const body: Record<string, unknown> = {
    content: input.content,
    mediaItems: [
      {
        url: input.mediaUrl,
        type: input.mediaType || "video",
      },
    ],
    platforms: input.platforms,
    timezone: input.timezone || "America/Chicago",
  };
  if (input.title) body.title = input.title;
  if (input.isDraft) body.isDraft = true;
  else if (input.publishNow) body.publishNow = true;
  else if (input.scheduledFor) body.scheduledFor = input.scheduledFor;

  const r = await zernioJson("POST", "/posts", body);
  if (!r.ok) {
    return {
      ok: false,
      error: (r.json as { error?: string; message?: string } | null)?.error
        || (r.json as { message?: string } | null)?.message
        || r.text.slice(0, 400)
        || `HTTP ${r.status}`,
      raw: r.json,
    };
  }
  const root = (r.json || {}) as {
    post?: Record<string, unknown>;
    message?: string;
  };
  const post = root.post || (r.json as Record<string, unknown>);
  const platforms = Array.isArray(post?.platforms) ? (post.platforms as Record<string, unknown>[]) : [];
  const firstUrl =
    platforms.map((p) => String(p.platformPostUrl || p.url || "")).find(Boolean) || null;
  return {
    ok: true,
    postId: String(post?._id ?? post?.id ?? ""),
    status: String(post?.status || ""),
    platformPostUrl: firstUrl,
    raw: r.json,
  };
}
