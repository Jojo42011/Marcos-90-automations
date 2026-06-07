import { createNote } from "../core/harveyNotes.js";
import type { HarveyNote, HarveyNoteCategory } from "../core/types.js";

const TRIGGER_PATTERNS: RegExp[] = [
  /^note\s+that\s+(.+)$/i,
  /^make\s+a\s+note[:\s]+(.+)$/i,
  /^remember\s+this[:\s]*(.+)$/i,
  /^write\s+this\s+down[:\s]*(.+)$/i,
  /^save\s+this[:\s]*(.+)$/i,
  /^note:\s*(.+)$/i,
  /^log\s+this[:\s]*(.+)$/i,
  /^add\s+to\s+notes[:\s]*(.+)$/i,
  /^don'?t\s+forget[:\s]*(.+)$/i,
];

function inferCategory(message: string, content: string): HarveyNoteCategory {
  const t = `${message} ${content}`.toLowerCase();
  if (/\b(meeting|appointment|sync|call with)\b/.test(t)) return "meeting";
  if (/\b(follow[- ]?up|followup|check back|reach out)\b/.test(t)) return "follow_up";
  if (/\b(listing|property|house|home tour|showing)\b/.test(t)) return "listing";
  if (/\b(lead|client|buyer|seller|prospect)\b/.test(t)) return "lead";
  if (/\b(idea|thought|concept)\b/.test(t)) return "idea";
  return "general";
}

function extractContent(message: string): string | null {
  const trimmed = message.trim();
  for (const pattern of TRIGGER_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  const lower = trimmed.toLowerCase();
  const inlineTriggers = [
    "note that ",
    "make a note ",
    "remember this ",
    "write this down ",
    "save this ",
    "log this ",
    "add to notes ",
    "don't forget ",
    "dont forget ",
  ];
  for (const trigger of inlineTriggers) {
    const idx = lower.indexOf(trigger);
    if (idx >= 0) {
      const rest = trimmed.slice(idx + trigger.length).trim();
      if (rest) return rest.replace(/^[:,-]\s*/, "");
    }
  }
  if (lower.startsWith("note:")) {
    return trimmed.slice(5).trim();
  }
  return null;
}

export function isNoteTakingMessage(message: string): boolean {
  return extractContent(message) !== null;
}

export function tryCaptureNote(
  message: string,
  source: HarveyNote["source"] = "text",
): HarveyNote | null {
  const content = extractContent(message);
  if (!content) return null;

  const category = inferCategory(message, content);
  const title = content.length > 60 ? content.slice(0, 57) + "..." : content;

  return createNote({
    content,
    title,
    category,
    source,
  });
}
