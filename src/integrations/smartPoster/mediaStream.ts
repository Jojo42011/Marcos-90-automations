export type MediaSource = {
  url: string;
  headers?: HeadersInit;
};

function requestHeaders(source: MediaSource, range?: string): Headers {
  const headers = new Headers(source.headers);
  if (range) headers.set("Range", range);
  return headers;
}

/** Open remote media with optional Range. Never follows redirects. */
export async function openMediaSource(
  source: MediaSource,
  opts?: { range?: string },
): Promise<Response> {
  const response = await fetch(source.url, {
    headers: requestHeaders(source, opts?.range),
    redirect: "error",
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Media fetch failed (${response.status})`);
  }
  if (!response.body) throw new Error("Media response has no body");
  return response;
}

export async function mediaSourceToBuffer(
  source: MediaSource,
  opts?: { maxBytes?: number },
): Promise<Buffer> {
  const response = await openMediaSource(source);
  const length = Number(response.headers.get("content-length") || 0);
  const max = opts?.maxBytes ?? 5 * 1024 * 1024 * 1024;
  if (Number.isFinite(length) && length > max) {
    throw new Error(`Media is too large to buffer (${length} bytes)`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > max) throw new Error(`Media is too large to buffer (${bytes.length} bytes)`);
  return bytes;
}
