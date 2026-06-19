"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchFacts = searchFacts;
exports.getMemoryPacket = getMemoryPacket;
exports.getRetrievalConfidence = getRetrievalConfidence;
const embeddings_js_1 = require("./embeddings.js");
const store_js_1 = require("./store.js");
function daysSince(iso) {
    if (!iso)
        return 999;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t))
        return 999;
    return (Date.now() - t) / (86400 * 1000);
}
async function searchFacts(query, limit = 8) {
    const db = (0, store_js_1.getHullDb)();
    const rows = db
        .prepare("SELECT id, content, category, strength, access_count, last_accessed, keywords, embedding FROM facts WHERE superseded_by IS NULL")
        .all();
    const qVec = await (0, embeddings_js_1.embedText)(query);
    const qLower = query.toLowerCase();
    const scored = rows.map((row) => {
        let semantic = 0;
        if (qVec && row.embedding) {
            const vec = (0, embeddings_js_1.blobToFloat32)(row.embedding);
            if (vec)
                semantic = (0, embeddings_js_1.cosineSimilarity)(qVec, vec);
        }
        const keyword = wordOverlapScore(qLower, row.content.toLowerCase()) +
            wordOverlapScore(qLower, (row.keywords || "").toLowerCase());
        const strength = row.strength ?? 1;
        const recency = 1 / (daysSince(row.last_accessed) + 1);
        const score = semantic * 0.5 + Math.min(keyword, 1) * 0.25 + strength * 0.15 + recency * 0.1;
        return { ...row, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const bump = db.prepare("UPDATE facts SET access_count = access_count + 1, last_accessed = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const f of top)
        bump.run(now, f.id);
    return top.map((f) => ({
        id: f.id,
        content: f.content,
        category: f.category,
        strength: f.strength,
        score: f.score,
    }));
}
function wordOverlapScore(a, b) {
    const wa = new Set(a.split(/\s+/).filter((w) => w.length > 2));
    const wb = new Set(b.split(/\s+/).filter((w) => w.length > 2));
    if (wa.size === 0 || wb.size === 0)
        return 0;
    let inter = 0;
    for (const w of wa)
        if (wb.has(w))
            inter++;
    return inter / Math.max(wa.size, wb.size);
}
function getMemoryPacket(query, facts) {
    const db = (0, store_js_1.getHullDb)();
    const parts = [];
    let charCount = 0;
    const cap = 2500;
    const add = (line) => {
        if (charCount + line.length + 1 > cap)
            return false;
        parts.push(line);
        charCount += line.length + 1;
        return true;
    };
    if (facts.length) {
        add("FACTS:");
        for (const f of facts) {
            if (!add(`- ${f.content}`))
                break;
        }
    }
    const rules = db
        .prepare("SELECT trigger_condition, action, confidence FROM rules ORDER BY confidence DESC LIMIT 5")
        .all();
    if (rules.length) {
        add("RULES:");
        for (const r of rules) {
            if (!add(`- IF ${r.trigger_condition} THEN ${r.action} (${Math.round(r.confidence * 100)}%)`))
                break;
        }
    }
    const episodes = db
        .prepare("SELECT summary, tone FROM episodes ORDER BY timestamp DESC LIMIT 3")
        .all();
    if (episodes.length) {
        add("RECENT EPISODES:");
        for (const e of episodes) {
            const line = e.tone ? `${e.summary} [${e.tone}]` : e.summary;
            if (!add(`- ${line}`))
                break;
        }
    }
    const synth = db
        .prepare("SELECT content FROM syntheses ORDER BY created_at DESC LIMIT 1")
        .get();
    if (synth?.content)
        add(`SYNTHESIS: ${synth.content}`);
    const identity = db
        .prepare("SELECT dimension, confidence FROM identity_dimensions ORDER BY dimension")
        .all();
    if (identity.length) {
        add("IDENTITY PROFILE:");
        for (const d of identity) {
            if (!add(`- ${d.dimension}: ${Math.round(d.confidence * 100)}%`))
                break;
        }
    }
    const entities = extractEntityHints(query);
    if (entities.length) {
        for (const ent of entities.slice(0, 3)) {
            const node = db
                .prepare("SELECT id, name FROM nodes WHERE LOWER(name) LIKE ? LIMIT 1")
                .get(`%${ent.toLowerCase()}%`);
            if (!node)
                continue;
            const edges = db
                .prepare(`SELECT e.relationship, n.name as target_name
           FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?
           UNION
           SELECT e.relationship, n.name as target_name
           FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?`)
                .all(node.id, node.id);
            if (edges.length) {
                add(`GRAPH (${node.name}):`);
                for (const edge of edges.slice(0, 5)) {
                    if (!add(`- ${node.name} ${edge.relationship} ${edge.target_name}`))
                        break;
                }
            }
        }
    }
    return parts.join("\n");
}
function extractEntityHints(query) {
    const words = query.split(/\s+/).filter((w) => w.length > 3);
    return words.slice(0, 5);
}
async function getRetrievalConfidence(query) {
    const facts = await searchFacts(query, 8);
    const topScore = facts[0]?.score ?? 0;
    return { confidence: topScore, count: facts.length };
}
