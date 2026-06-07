import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { HarveyNote, HarveyNoteCategory } from "./types.js";

function resolveNotesPath(): string {
  const base = existsSync("/data") ? "/data" : join(process.cwd(), "data");
  return join(base, "harvey-notes.json");
}

const CATEGORIES = new Set<HarveyNoteCategory>([
  "general",
  "lead",
  "listing",
  "idea",
  "follow_up",
  "meeting",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeNote(raw: unknown): HarveyNote | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  const content = typeof n.content === "string" ? n.content.trim() : "";
  if (!content) return null;
  const category = CATEGORIES.has(n.category as HarveyNoteCategory)
    ? (n.category as HarveyNoteCategory)
    : "general";
  const source =
    n.source === "voice" || n.source === "text" || n.source === "auto" ? n.source : "text";
  return {
    id: typeof n.id === "string" && n.id ? n.id : randomUUID(),
    content,
    title: typeof n.title === "string" ? n.title : undefined,
    category,
    leadId: typeof n.leadId === "string" ? n.leadId : undefined,
    leadName: typeof n.leadName === "string" ? n.leadName : undefined,
    tags: Array.isArray(n.tags)
      ? n.tags.filter((t): t is string => typeof t === "string")
      : undefined,
    source,
    createdAt: typeof n.createdAt === "string" ? n.createdAt : nowIso(),
    updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : nowIso(),
  };
}

export function getNotes(): HarveyNote[] {
  try {
    const p = resolveNotesPath();
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeNote).filter((n): n is HarveyNote => n !== null);
  } catch {
    return [];
  }
}

export function saveNotes(notes: HarveyNote[]): void {
  const p = resolveNotesPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(notes, null, 2), "utf8");
}

export function createNote(
  data: Omit<HarveyNote, "id" | "createdAt" | "updatedAt">,
): HarveyNote {
  const note: HarveyNote = {
    ...data,
    id: randomUUID(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const notes = getNotes();
  notes.unshift(note);
  saveNotes(notes);
  return note;
}

export function updateNote(id: string, updates: Partial<HarveyNote>): HarveyNote | null {
  const notes = getNotes();
  const idx = notes.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  notes[idx] = { ...notes[idx], ...updates, updatedAt: nowIso() };
  saveNotes(notes);
  return notes[idx];
}

export function deleteNote(id: string): boolean {
  const notes = getNotes();
  const filtered = notes.filter((n) => n.id !== id);
  if (filtered.length === notes.length) return false;
  saveNotes(filtered);
  return true;
}

export function getNoteById(id: string): HarveyNote | null {
  return getNotes().find((n) => n.id === id) ?? null;
}

export function searchNotes(query: string): HarveyNote[] {
  const q = query.trim().toLowerCase();
  if (!q) return getNotes();
  return getNotes().filter((n) => {
    const hay = [
      n.content,
      n.title || "",
      n.leadName || "",
      ...(n.tags || []),
      n.category,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function filterNotes(opts: {
  category?: string;
  leadId?: string;
}): HarveyNote[] {
  let notes = getNotes();
  if (opts.category && opts.category !== "all") {
    notes = notes.filter((n) => n.category === opts.category);
  }
  if (opts.leadId) {
    notes = notes.filter((n) => n.leadId === opts.leadId);
  }
  return notes;
}
