"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNotes = getNotes;
exports.saveNotes = saveNotes;
exports.createNote = createNote;
exports.updateNote = updateNote;
exports.deleteNote = deleteNote;
exports.getNoteById = getNoteById;
exports.searchNotes = searchNotes;
exports.filterNotes = filterNotes;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
function resolveNotesPath() {
    const base = (0, fs_1.existsSync)("/data") ? "/data" : (0, path_1.join)(process.cwd(), "data");
    return (0, path_1.join)(base, "harvey-notes.json");
}
const CATEGORIES = new Set([
    "general",
    "lead",
    "listing",
    "idea",
    "follow_up",
    "meeting",
]);
function nowIso() {
    return new Date().toISOString();
}
function normalizeNote(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const n = raw;
    const content = typeof n.content === "string" ? n.content.trim() : "";
    if (!content)
        return null;
    const category = CATEGORIES.has(n.category)
        ? n.category
        : "general";
    const source = n.source === "voice" || n.source === "text" || n.source === "auto" ? n.source : "text";
    return {
        id: typeof n.id === "string" && n.id ? n.id : (0, crypto_1.randomUUID)(),
        content,
        title: typeof n.title === "string" ? n.title : undefined,
        category,
        leadId: typeof n.leadId === "string" ? n.leadId : undefined,
        leadName: typeof n.leadName === "string" ? n.leadName : undefined,
        tags: Array.isArray(n.tags)
            ? n.tags.filter((t) => typeof t === "string")
            : undefined,
        source,
        createdAt: typeof n.createdAt === "string" ? n.createdAt : nowIso(),
        updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : nowIso(),
    };
}
function getNotes() {
    try {
        const p = resolveNotesPath();
        if (!(0, fs_1.existsSync)(p))
            return [];
        const parsed = JSON.parse((0, fs_1.readFileSync)(p, "utf8"));
        if (!Array.isArray(parsed))
            return [];
        return parsed.map(normalizeNote).filter((n) => n !== null);
    }
    catch {
        return [];
    }
}
function saveNotes(notes) {
    const p = resolveNotesPath();
    (0, fs_1.mkdirSync)((0, path_1.dirname)(p), { recursive: true });
    (0, fs_1.writeFileSync)(p, JSON.stringify(notes, null, 2), "utf8");
}
function createNote(data) {
    const note = {
        ...data,
        id: (0, crypto_1.randomUUID)(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
    const notes = getNotes();
    notes.unshift(note);
    saveNotes(notes);
    return note;
}
function updateNote(id, updates) {
    const notes = getNotes();
    const idx = notes.findIndex((n) => n.id === id);
    if (idx === -1)
        return null;
    notes[idx] = { ...notes[idx], ...updates, updatedAt: nowIso() };
    saveNotes(notes);
    return notes[idx];
}
function deleteNote(id) {
    const notes = getNotes();
    const filtered = notes.filter((n) => n.id !== id);
    if (filtered.length === notes.length)
        return false;
    saveNotes(filtered);
    return true;
}
function getNoteById(id) {
    return getNotes().find((n) => n.id === id) ?? null;
}
function searchNotes(query) {
    const q = query.trim().toLowerCase();
    if (!q)
        return getNotes();
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
function filterNotes(opts) {
    let notes = getNotes();
    if (opts.category && opts.category !== "all") {
        notes = notes.filter((n) => n.category === opts.category);
    }
    if (opts.leadId) {
        notes = notes.filter((n) => n.leadId === opts.leadId);
    }
    return notes;
}
