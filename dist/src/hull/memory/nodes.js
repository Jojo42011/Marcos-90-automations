"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findSimilarNode = findSimilarNode;
exports.upsertNode = upsertNode;
const crypto_1 = require("crypto");
const store_js_1 = require("./store.js");
function wordOverlap(a, b) {
    const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    if (wa.size === 0 || wb.size === 0)
        return 0;
    let inter = 0;
    for (const w of wa)
        if (wb.has(w))
            inter++;
    return inter / Math.max(wa.size, wb.size);
}
function findSimilarNode(name) {
    const db = (0, store_js_1.getHullDb)();
    const trimmed = name.trim();
    if (!trimmed)
        return null;
    const exact = db
        .prepare("SELECT id, name FROM nodes WHERE LOWER(name) = LOWER(?)")
        .get(trimmed);
    if (exact)
        return exact;
    const all = db.prepare("SELECT id, name FROM nodes").all();
    for (const n of all) {
        const lowerA = trimmed.toLowerCase();
        const lowerB = n.name.toLowerCase();
        if (lowerA.includes(lowerB) || lowerB.includes(lowerA))
            return n;
        if (wordOverlap(trimmed, n.name) >= 0.6)
            return n;
    }
    return null;
}
function upsertNode(name, type = "unknown", properties = {}) {
    const existing = findSimilarNode(name);
    if (existing)
        return existing.id;
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    (0, store_js_1.getHullDb)()
        .prepare("INSERT INTO nodes (id, name, type, properties, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, name.trim(), type, JSON.stringify(properties), now);
    return id;
}
