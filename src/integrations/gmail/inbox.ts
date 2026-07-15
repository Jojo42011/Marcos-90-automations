/**
 * Gmail read API — inbox list, message detail, thread snippets.
 * Requires OAuth scope: https://www.googleapis.com/auth/gmail.readonly (or gmail.modify)
 */
import { isGmailConfigured, getGmailAccessToken } from "./index.js";

// Token refresh is centralized in ./index.js — it prefers the DB-stored
// refresh token (in-app relink) over the env one and records auth failures
// for the dashboard's sync-status banner. Keeping a second copy here is how
// the June-22 token death went unnoticed.
async function getAccessToken(): Promise<string> {
  if (!isGmailConfigured()) throw new Error("Gmail not configured");
  return getGmailAccessToken();
}

type GmailHeader = { name?: string; value?: string };
type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value?.trim() || "";
}

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function extractBody(payload: GmailPart | undefined): { text: string; html: string } {
  if (!payload) return { text: "", html: "" };
  let text = "";
  let html = "";
  const walk = (part: GmailPart) => {
    const mime = part.mimeType || "";
    const raw = part.body?.data;
    if (raw) {
      const decoded = decodeBase64Url(raw);
      if (mime.includes("text/html")) html += decoded;
      else if (mime.includes("text/plain")) text += decoded;
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  if (!text && html) text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { text: text.trim(), html: html.trim() };
}

function parseEmailAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labelIds: string[];
  direction: "inbound" | "outbound" | "unknown";
}

export interface GmailMessageDetail extends GmailMessageSummary {
  bodyText: string;
  bodyHtml: string;
}

export async function listGmailMessages(opts?: {
  maxResults?: number;
  query?: string;
}): Promise<GmailMessageSummary[]> {
  const token = await getAccessToken();
  const maxResults = Math.min(opts?.maxResults ?? 25, 50);
  const q = opts?.query ?? "in:inbox OR in:sent";
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", String(maxResults));
  listUrl.searchParams.set("q", q);

  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listData = (await listRes.json().catch(() => ({}))) as {
    messages?: { id: string; threadId: string }[];
    error?: { message?: string };
  };
  if (!listRes.ok) {
    throw new Error(listData.error?.message || `Gmail list failed HTTP ${listRes.status}`);
  }
  const ids = listData.messages || [];
  const out: GmailMessageSummary[] = [];

  for (const m of ids.slice(0, maxResults)) {
    try {
      const detail = await getGmailMessage(m.id);
      out.push(detail);
    } catch (err) {
      console.warn("[gmail/inbox] skip message", m.id, err);
    }
  }
  return out;
}

export async function getGmailMessage(messageId: string): Promise<GmailMessageDetail> {
  const token = await getAccessToken();
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    threadId?: string;
    snippet?: string;
    labelIds?: string[];
    internalDate?: string;
    payload?: GmailPart & { headers?: GmailHeader[] };
    error?: { message?: string };
  };
  if (!res.ok || !data.id) {
    throw new Error(data.error?.message || `Gmail get message failed HTTP ${res.status}`);
  }

  const headers = data.payload?.headers;
  const from = headerValue(headers, "From");
  const to = headerValue(headers, "To");
  const subject = headerValue(headers, "Subject") || "(no subject)";
  const labels = data.labelIds || [];
  const direction = labels.includes("SENT")
    ? "outbound"
    : labels.includes("INBOX")
      ? "inbound"
      : "unknown";
  const { text, html } = extractBody(data.payload);
  const date = data.internalDate
    ? new Date(Number(data.internalDate)).toISOString()
    : new Date().toISOString();

  return {
    id: data.id,
    threadId: data.threadId || "",
    from,
    to,
    subject,
    snippet: data.snippet || text.slice(0, 200),
    date,
    labelIds: labels,
    direction,
    bodyText: text,
    bodyHtml: html,
  };
}

export function extractSenderEmail(fromHeader: string): string {
  return parseEmailAddress(fromHeader);
}
