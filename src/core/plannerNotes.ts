/**
 * The Notebook — long-form writing inside the Content Planner's scratchpad.
 *
 * WHY THIS IS ITS OWN TABLE AND NOT A PLANNER ITEM. A planner item is a piece
 * of content that is intended: it has a category, platforms, owners and a date.
 * A meeting note or a quarterly brainstorm has none of those and never will, so
 * storing one as an item with every field blank would put junk on the calendar
 * the moment somebody scheduled it by accident. Notes are deliberately
 * decoupled — they carry a title and a document, nothing else.
 *
 * THE DOCUMENT IS STORED AS SANITISED HTML. There is no rich-text engine here:
 * TipTap, Quill and ProseMirror are all npm packages, and per CLAUDE.md the
 * fast overlay deploy path cannot `npm install`. The editor is the browser's
 * own contenteditable, and what it produces is scrubbed on the way IN — an
 * allow-list of tags and attributes, no scripts, no event handlers, no styles
 * — because this HTML is rendered back into the page verbatim and a note is a
 * place a person will happily paste from anywhere.
 *
 * `content_json` holds a small structural envelope rather than a second copy of
 * the document, so the two can never disagree about what the note says.
 */
import { randomUUID } from "crypto";

import { getPlannerDb } from "./contentPlanner.js";

export interface PlannerNote {
  id: string;
  workspaceId: string;
  title: string;
  contentHtml: string;
  /** { format, plainText, chars } — a summary, never a rival copy of the body. */
  contentJson: Record<string, unknown>;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Single-tenant today; the column exists so notes can be partitioned later. */
const DEFAULT_WORKSPACE = "default";

const nowIso = () => new Date().toISOString();

let ensured = false;

export function ensureNotesSchema(): void {
  if (ensured) return;
  getPlannerDb().exec(`
    CREATE TABLE IF NOT EXISTS planner_notes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL DEFAULT '',
      content_html TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{}',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_planner_notes_updated ON planner_notes(updated_at);
  `);
  ensured = true;
}

/* ────────────────────────── sanitiser ────────────────────────── */

/**
 * Tags the editor can produce and the reader may render. Everything else is
 * unwrapped to its text, so a pasted <script>, <iframe>, <img onerror> or
 * <style> cannot survive a round trip through a note.
 */
const ALLOWED_TAGS = new Set([
  "p", "br", "div", "span",
  "b", "strong", "i", "em", "u", "s", "strike", "mark",
  "h1", "h2", "h3", "blockquote", "hr",
  "ul", "ol", "li", "a", "code", "pre",
]);
/** Only the two attributes the toolbar actually needs. */
const ALLOWED_ATTRS = new Set(["href", "data-checked"]);

const VOID_TAGS = new Set(["br", "hr"]);

/**
 * A small forgiving HTML scrubber. It walks the tag stream rather than parsing
 * a tree, which is enough because the only thing it must guarantee is that no
 * disallowed tag or attribute reaches the output — text is escaped, never
 * executed.
 */
export function sanitizeNoteHtml(raw: string): string {
  const input = String(raw ?? "");
  if (!input) return "";
  let out = "";
  let i = 0;
  const openStack: string[] = [];

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(input.slice(i));
      break;
    }
    out += escapeText(input.slice(i, lt));

    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      out += escapeText(input.slice(lt));
      break;
    }
    const rawTag = input.slice(lt + 1, gt);
    i = gt + 1;

    // Comments and processing instructions are dropped whole.
    if (rawTag.startsWith("!") || rawTag.startsWith("?")) continue;

    const isClose = rawTag.startsWith("/");
    const nameMatch = /^\/?\s*([a-zA-Z0-9]+)/.exec(rawTag);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();

    if (!ALLOWED_TAGS.has(name)) {
      // Drop the tag but keep whatever text it wrapped: a pasted document
      // should lose its <font> soup, not its words. Script and style carry no
      // readable text, so their bodies go too.
      if ((name === "script" || name === "style") && !isClose) {
        const end = input.toLowerCase().indexOf(`</${name}`, i);
        i = end === -1 ? input.length : input.indexOf(">", end) + 1 || input.length;
      }
      continue;
    }

    if (isClose) {
      const idx = openStack.lastIndexOf(name);
      if (idx === -1) continue;
      openStack.splice(idx, 1);
      out += `</${name}>`;
      continue;
    }

    const attrs = collectAttrs(rawTag.slice(nameMatch[0].length));
    if (VOID_TAGS.has(name)) {
      out += `<${name}>`;
      continue;
    }
    // A self-closed non-void tag ("<p/>") would otherwise leave the stack open.
    if (/\/\s*$/.test(rawTag)) {
      out += `<${name}${attrs}></${name}>`;
      continue;
    }
    openStack.push(name);
    out += `<${name}${attrs}>`;
  }

  // Close anything left hanging so a truncated paste cannot break the page.
  for (let k = openStack.length - 1; k >= 0; k--) out += `</${openStack[k]}>`;
  return out;
}

function escapeText(s: string): string {
  return s.replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function collectAttrs(tail: string): string {
  let out = "";
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail))) {
    const key = m[1].toLowerCase();
    if (!ALLOWED_ATTRS.has(key)) continue;
    const value = m[3] ?? m[4] ?? "";
    if (key === "href") {
      // http/https/mailto only — javascript: and data: are how a note becomes
      // an attack on whoever opens it next.
      if (!/^(https?:|mailto:)/i.test(value.trim())) continue;
    }
    out += ` ${key}="${value.replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`;
  }
  return out;
}

/** Readable text of a note, for search and for the list preview. */
export function notePlainText(html: string): string {
  return String(html || "")
    .replace(/<(br|\/p|\/h[1-3]|\/li|\/blockquote|hr)[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/* ────────────────────────── CRUD ────────────────────────── */

function rowToNote(r: Record<string, unknown>): PlannerNote {
  let json: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(r.content_json || "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
  } catch {
    json = {};
  }
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id || DEFAULT_WORKSPACE),
    title: String(r.title || ""),
    contentHtml: String(r.content_html || ""),
    contentJson: json,
    isPinned: Number(r.is_pinned) === 1,
    createdAt: String(r.created_at || ""),
    updatedAt: String(r.updated_at || ""),
  };
}

/** Pinned first, then most recently touched — the order a writer expects. */
export function listNotes(): PlannerNote[] {
  ensureNotesSchema();
  const rows = getPlannerDb()
    .prepare(`SELECT * FROM planner_notes ORDER BY is_pinned DESC, updated_at DESC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToNote);
}

export function getNote(id: string): PlannerNote | null {
  ensureNotesSchema();
  const row = getPlannerDb().prepare(`SELECT * FROM planner_notes WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToNote(row) : null;
}

function envelope(html: string): Record<string, unknown> {
  const text = notePlainText(html);
  return { format: "html", chars: text.length, preview: text.slice(0, 160) };
}

export function createNote(input: { title?: string; contentHtml?: string }): PlannerNote {
  ensureNotesSchema();
  const ts = nowIso();
  const id = randomUUID();
  const html = sanitizeNoteHtml(input.contentHtml || "");
  getPlannerDb()
    .prepare(
      `INSERT INTO planner_notes (id, workspace_id, title, content_html, content_json, is_pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(id, DEFAULT_WORKSPACE, String(input.title || "").trim() || "Untitled note", html, JSON.stringify(envelope(html)), ts, ts);
  return getNote(id)!;
}

export function updateNote(
  id: string,
  patch: { title?: string; contentHtml?: string; isPinned?: boolean },
): PlannerNote | null {
  const existing = getNote(id);
  if (!existing) return null;
  const title = patch.title === undefined ? existing.title : String(patch.title).trim() || "Untitled note";
  const html = patch.contentHtml === undefined ? existing.contentHtml : sanitizeNoteHtml(patch.contentHtml);
  const pinned = patch.isPinned === undefined ? existing.isPinned : !!patch.isPinned;
  getPlannerDb()
    .prepare(`UPDATE planner_notes SET title=?, content_html=?, content_json=?, is_pinned=?, updated_at=? WHERE id=?`)
    .run(title, html, JSON.stringify(envelope(html)), pinned ? 1 : 0, nowIso(), id);
  return getNote(id);
}

export function deleteNote(id: string): boolean {
  ensureNotesSchema();
  return getPlannerDb().prepare(`DELETE FROM planner_notes WHERE id = ?`).run(id).changes > 0;
}
