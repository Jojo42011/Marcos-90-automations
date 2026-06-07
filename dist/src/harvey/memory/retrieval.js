"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retrieveMemories = retrieveMemories;
exports.formatMemoriesForPrompt = formatMemoriesForPrompt;
const store_js_1 = require("./store.js");
function mapSemantic(row) {
    return {
        id: row.id,
        fact: row.fact,
        category: row.category,
        tags: row.tags ? row.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        confidence: row.confidence,
        accessCount: row.access_count,
        lastAccessed: row.last_accessed,
        createdAt: row.created_at,
        supersededBy: row.superseded_by ?? undefined,
        weight: row.weight,
    };
}
function mapRelational(row) {
    return {
        id: row.id,
        entityA: row.entity_a,
        relationship: row.relationship,
        entityB: row.entity_b,
        weight: row.weight,
        createdAt: row.created_at,
        lastReinforced: row.last_reinforced,
    };
}
function mapProcedural(row) {
    return {
        id: row.id,
        trigger: row.trigger_condition,
        action: row.action,
        category: row.category,
        useCount: row.use_count,
        createdAt: row.created_at,
    };
}
function mapEpisode(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        timestamp: row.timestamp,
        summary: row.summary,
        peopleInvolved: row.people_involved ? row.people_involved.split(",").map((p) => p.trim()) : [],
        emotionalWeight: row.emotional_weight || "routine",
        topics: row.topics ? row.topics.split(",").map((t) => t.trim()) : [],
        rawTurns: row.raw_turns,
    };
}
function retrieveMemories(query, limit = 15) {
    const database = (0, store_js_1.getMemoryDb)();
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    let semanticRows = [];
    if (keywords.length > 0) {
        const semanticConditions = keywords
            .map(() => "(LOWER(fact) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(category) LIKE ?)")
            .join(" OR ");
        const semanticParams = keywords.flatMap((k) => [`%${k}%`, `%${k}%`, `%${k}%`]);
        semanticRows = database
            .prepare(`SELECT * FROM harvey_semantic
         WHERE superseded_by IS NULL
         AND (${semanticConditions})
         ORDER BY weight DESC, access_count DESC, last_accessed DESC
         LIMIT ?`)
            .all(...semanticParams, limit);
    }
    else {
        semanticRows = database
            .prepare(`SELECT * FROM harvey_semantic
         WHERE superseded_by IS NULL
         ORDER BY weight DESC, access_count DESC, last_accessed DESC
         LIMIT ?`)
            .all(limit);
    }
    let relationalRows = [];
    if (keywords.length > 0) {
        const relConditions = keywords
            .map(() => "(LOWER(entity_a) LIKE ? OR LOWER(entity_b) LIKE ?)")
            .join(" OR ");
        const relParams = keywords.flatMap((k) => [`%${k}%`, `%${k}%`]);
        relationalRows = database
            .prepare(`SELECT * FROM harvey_relational
         WHERE ${relConditions}
         ORDER BY weight DESC
         LIMIT 10`)
            .all(...relParams);
    }
    const episodeRows = database
        .prepare(`SELECT * FROM harvey_episodes ORDER BY timestamp DESC LIMIT 5`)
        .all();
    let proceduralRows = [];
    if (keywords.length > 0) {
        const procConditions = keywords.map(() => "LOWER(trigger_condition) LIKE ?").join(" OR ");
        const procParams = keywords.map((k) => `%${k}%`);
        proceduralRows = database
            .prepare(`SELECT * FROM harvey_procedural
         WHERE ${procConditions}
         ORDER BY use_count DESC
         LIMIT 5`)
            .all(...procParams);
    }
    if (semanticRows.length > 0) {
        const ids = semanticRows.map((m) => m.id);
        database
            .prepare(`UPDATE harvey_semantic
         SET access_count = access_count + 1, last_accessed = ?
         WHERE id IN (${ids.map(() => "?").join(",")})`)
            .run(new Date().toISOString(), ...ids);
    }
    const semantic = semanticRows.map(mapSemantic);
    const relational = relationalRows.map(mapRelational);
    const procedural = proceduralRows.map(mapProcedural);
    const episodes = episodeRows.map(mapEpisode);
    return {
        episodes,
        semantic,
        relational,
        procedural,
        totalScore: semantic.length + relational.length,
    };
}
function formatMemoriesForPrompt(memories) {
    const parts = [];
    if (memories.semantic.length > 0) {
        parts.push("RELEVANT FACTS:\n" + memories.semantic.map((m) => `- ${m.fact}`).join("\n"));
    }
    if (memories.relational.length > 0) {
        parts.push("CONNECTIONS:\n" +
            memories.relational.map((m) => `- ${m.entityA} ${m.relationship} ${m.entityB}`).join("\n"));
    }
    if (memories.procedural.length > 0) {
        parts.push("BUSINESS RULES:\n" +
            memories.procedural.map((m) => `- When ${m.trigger}: ${m.action}`).join("\n"));
    }
    if (memories.episodes.length > 0) {
        parts.push("RECENT SESSIONS:\n" +
            memories.episodes
                .map((m) => `- ${m.timestamp.split("T")[0]}: ${m.summary}`)
                .join("\n"));
    }
    return parts.join("\n\n");
}
