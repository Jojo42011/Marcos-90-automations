"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOOK_TYPES = void 0;
exports.classifyHook = classifyHook;
exports.classifyAndUpdateHookLibrary = classifyAndUpdateHookLibrary;
exports.getHookTypePerformanceSummary = getHookTypePerformanceSummary;
exports.getHookLibraryEntries = getHookLibraryEntries;
const contentDb_js_1 = require("../../../core/contentDb.js");
exports.HOOK_TYPES = {
    question: "question",
    shock: "shock",
    personal_story: "personal_story",
    data: "data",
    controversy: "controversy",
    local: "local",
    uncategorized: "uncategorized",
};
const LOCAL_TERMS = [
    "stone oak",
    "canyon lake",
    "new braunfels",
    "san antonio",
    "alamo heights",
    "78209",
    "78258",
    "78259",
];
function buildHookStructure(hookText) {
    return hookText
        .replace(/\$[\d,]+(?:\.\d+)?[kKmM]?/g, "[amount]")
        .replace(/\b\d+(?:\.\d+)?%/g, "[percent]")
        .replace(/\b\d{1,2}\/\d{1,2}\b/g, "[beds]/[baths]")
        .replace(/\b\d{3,}[\d,]*\b/g, "[number]")
        .replace(/\b(Stone Oak|Canyon Lake|New Braunfels|San Antonio|Alamo Heights)\b/gi, "[neighborhood]")
        .trim();
}
function classifyHook(hookText) {
    const text = hookText.trim();
    const lower = text.toLowerCase();
    const signals = [];
    if (/^(did you|what if|are you|do you|how|why|is it|can you)\b/i.test(lower) || text.endsWith("?")) {
        signals.push("question");
    }
    if (/\b(just sold|just closed|won't tell you|wont tell you|most agents|nobody tells)\b/i.test(lower)) {
        signals.push("shock");
    }
    if (/\b(last week|my client|i was|i just)\b/i.test(lower)) {
        signals.push("personal_story");
    }
    const head = text.slice(0, 30);
    if (/\$[\d,]+|\d+(?:\.\d+)?%|\d+\s*homes|\d+\s*days/i.test(head)) {
        signals.push("data");
    }
    if (/\b(stop|mistake|wrong|terrible|everyone gets|gets this wrong)\b/i.test(lower)) {
        signals.push("controversy");
    }
    if (LOCAL_TERMS.some((t) => lower.includes(t))) {
        signals.push("local");
    }
    const hookType = signals[0] ?? exports.HOOK_TYPES.uncategorized;
    const confidence = signals.length >= 2 ? 0.9 : signals.length === 1 ? 0.7 : 0.5;
    return {
        hookType,
        hookStructure: buildHookStructure(text),
        confidence,
    };
}
function classifyAndUpdateHookLibrary() {
    const database = (0, contentDb_js_1.getContentDb)();
    const rows = database
        .prepare(`SELECT id, hook_text FROM cm_hook_library
       WHERE hook_type IS NULL OR hook_type = 'uncategorized' OR classified_at IS NULL`)
        .all();
    const now = new Date().toISOString();
    let updated = 0;
    for (const row of rows) {
        const { hookType, hookStructure } = classifyHook(row.hook_text);
        database
            .prepare(`UPDATE cm_hook_library SET hook_type = ?, hook_structure = ?, classified_at = ? WHERE id = ?`)
            .run(hookType, hookStructure, now, row.id);
        updated++;
    }
    return updated;
}
function getHookTypePerformanceSummary() {
    const rows = (0, contentDb_js_1.getContentDb)()
        .prepare(`SELECT hook_type,
              AVG(avg_views_when_used) AS avg_views,
              SUM(times_used) AS sample_count,
              SUM(times_above_benchmark) AS above_count
       FROM cm_hook_library
       WHERE times_used >= 2 AND hook_type IS NOT NULL
       GROUP BY hook_type`)
        .all();
    const out = {};
    for (const r of rows) {
        const sample = Number(r.sample_count) || 0;
        const above = Number(r.above_count) || 0;
        out[r.hook_type] = {
            avg_views: Math.round(Number(r.avg_views) || 0),
            above_benchmark_rate: sample > 0 ? above / sample : 0,
            sample_count: sample,
        };
    }
    return out;
}
function getHookLibraryEntries(minUses = 1) {
    return (0, contentDb_js_1.listHookLibrary)({ minUses, limit: 500, order: "desc" });
}
