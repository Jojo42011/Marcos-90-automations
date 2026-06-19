"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeJsonParse = safeJsonParse;
exports.runPostConversationExtraction = runPostConversationExtraction;
const crypto_1 = require("crypto");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const embeddings_js_1 = require("./embeddings.js");
const store_js_1 = require("./store.js");
const nodes_js_1 = require("./nodes.js");
const ws_js_1 = require("../ws.js");
const HAIKU = "claude-haiku-4-5-20251001";
function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        /* continue */
    }
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
        try {
            return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
        }
        catch {
            /* continue */
        }
    }
    const arrStart = text.indexOf("[");
    const arrEnd = text.lastIndexOf("]");
    if (arrStart !== -1 && arrEnd > arrStart) {
        try {
            return JSON.parse(text.slice(arrStart, arrEnd + 1));
        }
        catch {
            /* continue */
        }
    }
    return null;
}
async function runPostConversationExtraction(sessionId, transcript) {
    if (transcript.length < 2)
        return;
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key)
        return;
    const client = new sdk_1.default({ apiKey: key });
    const lines = transcript.map((t) => `${t.role}: ${t.text}`).join("\n");
    const prompt = `Extract structured memory from this conversation transcript. Return ONLY valid JSON with keys:
facts (array of {content, category, keywords}),
nodes (array of {name, type}),
edges (array of {source, relationship, target}),
rules_reinforced (array of {trigger, action}),
episode ({summary, tone, decisions, entities}).

Transcript:
${lines.slice(0, 12000)}`;
    try {
        const res = await client.messages.create({
            model: HAIKU,
            max_tokens: 1500,
            messages: [{ role: "user", content: prompt }],
        });
        const text = res.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
        const parsed = safeJsonParse(text);
        if (!parsed) {
            console.warn("[hull/extraction] JSON parse failed");
            return;
        }
        await applyExtraction(sessionId, parsed);
        (0, ws_js_1.broadcastHullEvent)({ type: "memory_updated" });
    }
    catch (err) {
        console.error("[hull/extraction]", err instanceof Error ? err.message : err);
    }
}
/** SQLite bind values must be scalars — better-sqlite3 expands arrays into extra parameters. */
function sqlText(value, fallback = "") {
    if (value == null)
        return fallback;
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    if (Array.isArray(value) || typeof value === "object")
        return JSON.stringify(value);
    return String(value);
}
function sqlNullableText(value) {
    if (value == null)
        return null;
    return sqlText(value);
}
async function applyExtraction(sessionId, data) {
    const db = (0, store_js_1.getHullDb)();
    const now = new Date().toISOString();
    const facts = data.facts || [];
    for (const f of facts) {
        const content = sqlText(f.content).trim();
        if (!content)
            continue;
        const id = (0, crypto_1.randomUUID)();
        const vec = await (0, embeddings_js_1.embedText)(content);
        const category = sqlText(f.category, "general");
        db.prepare(`INSERT INTO facts (id, content, category, keywords, strength, access_count, last_accessed, created_at, embedding)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(id, content, category, sqlText(f.keywords, ""), category === "identity" ? 1.5 : 1.0, now, now, vec ? (0, embeddings_js_1.float32ToBlob)(vec) : null);
    }
    const nodes = data.nodes || [];
    const nodeIdMap = {};
    for (const n of nodes) {
        const name = sqlText(n.name).trim();
        if (!name)
            continue;
        const id = (0, nodes_js_1.upsertNode)(name, sqlText(n.type, "unknown"));
        nodeIdMap[name.toLowerCase()] = id;
    }
    const edges = data.edges || [];
    for (const e of edges) {
        const source = sqlText(e.source).trim();
        const target = sqlText(e.target).trim();
        const relationship = sqlText(e.relationship).trim();
        if (!source || !target || !relationship)
            continue;
        const srcId = nodeIdMap[source.toLowerCase()] || (0, nodes_js_1.upsertNode)(source);
        const tgtId = nodeIdMap[target.toLowerCase()] || (0, nodes_js_1.upsertNode)(target);
        db.prepare(`INSERT INTO edges (id, source_id, target_id, relationship, strength, created_at, last_reinforced)
       VALUES (?, ?, ?, ?, 1.0, ?, ?)`).run((0, crypto_1.randomUUID)(), srcId, tgtId, relationship, now, now);
    }
    const rules = data.rules_reinforced || [];
    for (const r of rules) {
        const trigger = sqlText(r.trigger).trim();
        const action = sqlText(r.action).trim();
        if (!trigger || !action)
            continue;
        const existing = db
            .prepare("SELECT id, confidence FROM rules WHERE trigger_condition = ? AND action = ?")
            .get(trigger, action);
        if (existing) {
            db.prepare("UPDATE rules SET confidence = MIN(1.0, confidence + 0.1), last_reinforced = ?, use_count = use_count + 1 WHERE id = ?").run(now, existing.id);
        }
        else {
            db.prepare(`INSERT INTO rules (id, trigger_condition, action, category, confidence, use_count, created_at, last_reinforced)
         VALUES (?, ?, ?, 'learned', 0.7, 1, ?, ?)`).run((0, crypto_1.randomUUID)(), trigger, action, now, now);
        }
    }
    const ep = data.episode;
    const summary = sqlText(ep?.summary).trim();
    if (summary) {
        db.prepare(`INSERT INTO episodes (id, session_id, summary, tone, decisions, entities, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run((0, crypto_1.randomUUID)(), sessionId, summary, sqlNullableText(ep?.tone), sqlNullableText(ep?.decisions), sqlNullableText(ep?.entities), now);
    }
}
