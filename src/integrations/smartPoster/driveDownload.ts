import type { MediaSource } from "./mediaStream.js";

type ToolkitResult = {
  ok: boolean;
  error?: string;
  data?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Prefer an absolute download URL over opaque file payloads. */
export function driveDownloadSource(result: ToolkitResult): MediaSource {
  if (!result.ok) throw new Error(result.error || "Drive download failed");
  const data = asRecord(result.data) || {};
  const nested = asRecord(data.data) || {};
  const file = asRecord(data.file) || asRecord(nested.file) || {};
  const url = pickString(
    data.downloadUrl,
    data.download_url,
    data.webContentLink,
    data.web_content_link,
    nested.downloadUrl,
    nested.download_url,
    nested.webContentLink,
    nested.web_content_link,
    file.downloadUrl,
    file.download_url,
    file.webContentLink,
    file.web_content_link,
    data.url,
    nested.url,
    file.url,
  );
  if (url && looksLikeUrl(url)) return { url };

  const uri = pickString(data.uri, nested.uri, file.uri, data.s3url, nested.s3url);
  if (uri && looksLikeUrl(uri)) return { url: uri };

  throw new Error(
    "Drive download did not return a usable URL. Reconnect Google Drive in Composio and try again.",
  );
}
