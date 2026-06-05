import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { TagTemplate } from "./types.js";

function resolveTagTemplatesPath(): string {
  const explicit = process.env.TAG_TEMPLATES_JSON_PATH?.trim();
  if (explicit) return explicit;
  const flyDb = "/data/db.json";
  const localDb = join(process.cwd(), "data", "local-dashboard-db.json");
  const dbPath = process.env.DB_JSON_PATH?.trim() || (existsSync(flyDb) ? flyDb : localDb);
  return join(dirname(dbPath), "tag-templates.json");
}

const TAG_TEMPLATES_PATH = resolveTagTemplatesPath();

function nowIso(): string {
  return new Date().toISOString();
}

function genId(): string {
  return `tag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildDefaultTagTemplates(): TagTemplate[] {
  const ts = nowIso();
  const seeds: Array<{ name: string; color: string }> = [
    { name: "Open House", color: "#f59e0b" },
    { name: "DNC", color: "#ef4444" },
    { name: "Investor", color: "#8b5cf6" },
    { name: "Referral", color: "#10b981" },
    { name: "1397 Canyon Lake", color: "#0ea5e9" },
  ];
  return seeds.map((s) => ({ id: genId(), name: s.name, color: s.color, createdAt: ts }));
}

function writeTagTemplatesFile(tags: TagTemplate[]): void {
  mkdirSync(dirname(TAG_TEMPLATES_PATH), { recursive: true });
  writeFileSync(TAG_TEMPLATES_PATH, JSON.stringify(tags, null, 2), "utf8");
}

/** Read all tag templates. Seeds defaults on first run if the file does not exist. */
export function getTagTemplates(): TagTemplate[] {
  try {
    if (!existsSync(TAG_TEMPLATES_PATH)) {
      const seeded = buildDefaultTagTemplates();
      try {
        writeTagTemplatesFile(seeded);
      } catch (err) {
        console.error("[tagTemplates] seed write failed:", err);
      }
      return seeded;
    }
    const raw = readFileSync(TAG_TEMPLATES_PATH, "utf8");
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((t) => t && typeof t === "object" && typeof t.name === "string")
      .map((t) => ({
        id: typeof t.id === "string" && t.id ? t.id : genId(),
        name: String(t.name).trim(),
        color: typeof t.color === "string" && /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : "#64748b",
        createdAt: typeof t.createdAt === "string" ? t.createdAt : nowIso(),
      }))
      .filter((t) => t.name);
  } catch (err) {
    console.error("[tagTemplates] getTagTemplates failed:", err);
    return [];
  }
}

export function saveTagTemplates(tags: TagTemplate[]): void {
  try {
    writeTagTemplatesFile(tags);
  } catch (err) {
    console.error("[tagTemplates] saveTagTemplates failed:", err);
  }
}

export function createTagTemplate(name: string, color: string): TagTemplate {
  const trimmed = name.trim();
  const hex = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#64748b";
  const tags = getTagTemplates();
  const created: TagTemplate = { id: genId(), name: trimmed || "Untitled", color: hex, createdAt: nowIso() };
  tags.push(created);
  saveTagTemplates(tags);
  return created;
}

export function deleteTagTemplate(id: string): boolean {
  const tags = getTagTemplates();
  const next = tags.filter((t) => t.id !== id);
  if (next.length === tags.length) return false;
  saveTagTemplates(next);
  return true;
}
