"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTagTemplates = getTagTemplates;
exports.saveTagTemplates = saveTagTemplates;
exports.createTagTemplate = createTagTemplate;
exports.deleteTagTemplate = deleteTagTemplate;
const fs_1 = require("fs");
const path_1 = require("path");
function resolveTagTemplatesPath() {
    const explicit = process.env.TAG_TEMPLATES_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDb = "/data/db.json";
    const localDb = (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
    const dbPath = process.env.DB_JSON_PATH?.trim() || ((0, fs_1.existsSync)(flyDb) ? flyDb : localDb);
    return (0, path_1.join)((0, path_1.dirname)(dbPath), "tag-templates.json");
}
const TAG_TEMPLATES_PATH = resolveTagTemplatesPath();
function nowIso() {
    return new Date().toISOString();
}
function genId() {
    return `tag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function buildDefaultTagTemplates() {
    const ts = nowIso();
    const seeds = [
        { name: "Open House", color: "#f59e0b" },
        { name: "DNC", color: "#ef4444" },
        { name: "Investor", color: "#8b5cf6" },
        { name: "Referral", color: "#10b981" },
        { name: "1397 Canyon Lake", color: "#0ea5e9" },
    ];
    return seeds.map((s) => ({ id: genId(), name: s.name, color: s.color, createdAt: ts }));
}
function writeTagTemplatesFile(tags) {
    (0, fs_1.mkdirSync)((0, path_1.dirname)(TAG_TEMPLATES_PATH), { recursive: true });
    (0, fs_1.writeFileSync)(TAG_TEMPLATES_PATH, JSON.stringify(tags, null, 2), "utf8");
}
/** Read all tag templates. Seeds defaults on first run if the file does not exist. */
function getTagTemplates() {
    try {
        if (!(0, fs_1.existsSync)(TAG_TEMPLATES_PATH)) {
            const seeded = buildDefaultTagTemplates();
            try {
                writeTagTemplatesFile(seeded);
            }
            catch (err) {
                console.error("[tagTemplates] seed write failed:", err);
            }
            return seeded;
        }
        const raw = (0, fs_1.readFileSync)(TAG_TEMPLATES_PATH, "utf8");
        if (!raw.trim())
            return [];
        const data = JSON.parse(raw);
        if (!Array.isArray(data))
            return [];
        return data
            .filter((t) => t && typeof t === "object" && typeof t.name === "string")
            .map((t) => ({
            id: typeof t.id === "string" && t.id ? t.id : genId(),
            name: String(t.name).trim(),
            color: typeof t.color === "string" && /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : "#64748b",
            createdAt: typeof t.createdAt === "string" ? t.createdAt : nowIso(),
        }))
            .filter((t) => t.name);
    }
    catch (err) {
        console.error("[tagTemplates] getTagTemplates failed:", err);
        return [];
    }
}
function saveTagTemplates(tags) {
    try {
        writeTagTemplatesFile(tags);
    }
    catch (err) {
        console.error("[tagTemplates] saveTagTemplates failed:", err);
    }
}
function createTagTemplate(name, color) {
    const trimmed = name.trim();
    const hex = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#64748b";
    const tags = getTagTemplates();
    const created = { id: genId(), name: trimmed || "Untitled", color: hex, createdAt: nowIso() };
    tags.push(created);
    saveTagTemplates(tags);
    return created;
}
function deleteTagTemplate(id) {
    const tags = getTagTemplates();
    const next = tags.filter((t) => t.id !== id);
    if (next.length === tags.length)
        return false;
    saveTagTemplates(next);
    return true;
}
