"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.proposeWeeklyExperiment = proposeWeeklyExperiment;
exports.evaluateCurrentExperiment = evaluateCurrentExperiment;
exports.assignVideoToExperiment = assignVideoToExperiment;
const claude_content_js_1 = require("../../../integrations/claude-content.js");
const contentDb_js_1 = require("../../../core/contentDb.js");
const hookClassifier_js_1 = require("./hookClassifier.js");
const stats_js_1 = require("./stats.js");
function parseJson(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
        return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
async function proposeWeeklyExperiment(brain) {
    if (!(0, stats_js_1.isMonday)())
        return;
    const active = (0, contentDb_js_1.getActiveExperiment)();
    if (active && (active.status === "running" || active.status === "proposed")) {
        return;
    }
    const model = (0, contentDb_js_1.getPerformanceModel)();
    const combinations = (0, contentDb_js_1.listCombinationPatterns)({ minSamples: 2, limit: 10, order: "desc" });
    const hookSummary = (0, hookClassifier_js_1.getHookTypePerformanceSummary)();
    const prompt = `Based on this performance data: ${JSON.stringify(model)}, top combinations: ${JSON.stringify(combinations)}, hook type summary: ${JSON.stringify(hookSummary)} — propose ONE small experiment for this week. Test exactly ONE variable achievable with content in the pipeline. Return JSON only: { "hypothesis": string, "variable_tested": string, "control_description": string, "test_description": string }`;
    let raw = "";
    try {
        const response = await claude_content_js_1.claudeContent.messages.create({
            model: claude_content_js_1.CONTENT_MODELS.QUALITY,
            max_tokens: 500,
            system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
            messages: [{ role: "user", content: prompt }],
        });
        raw = response.content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
    }
    catch (err) {
        (0, claude_content_js_1.logContentAiFailure)("weekly experiment proposal", err);
    }
    const parsed = parseJson(raw);
    if (!parsed?.hypothesis)
        return;
    (0, contentDb_js_1.insertExperiment)({
        weekStart: (0, stats_js_1.getWeekStart)(),
        hypothesis: parsed.hypothesis,
        variableTested: parsed.variable_tested || "hook_type",
        controlDescription: parsed.control_description || "",
        testDescription: parsed.test_description || "",
        status: "proposed",
    });
    console.log(`[cm-brain] Weekly experiment proposed: ${parsed.hypothesis}`);
}
async function evaluateCurrentExperiment(brain) {
    const weekStart = (0, stats_js_1.getWeekStart)();
    const exp = (0, contentDb_js_1.getExperimentForWeek)(weekStart) ?? (0, contentDb_js_1.getActiveExperiment)();
    if (!exp || (exp.status !== "running" && exp.status !== "proposed"))
        return;
    const controlIds = JSON.parse(exp.controlVideoIds || "[]");
    const testIds = JSON.parse(exp.testVideoIds || "[]");
    const controlAvg = (0, contentDb_js_1.getVideoPerformanceAvg)(controlIds);
    const testAvg = (0, contentDb_js_1.getVideoPerformanceAvg)(testIds);
    if (controlIds.length < 2 || testIds.length < 2) {
        (0, contentDb_js_1.updateExperiment)(exp.id, {
            status: "abandoned",
            conclusion: "Insufficient data to evaluate.",
            evaluatedAt: new Date().toISOString(),
        });
        return;
    }
    let result = "inconclusive";
    if (testAvg > controlAvg * 1.1)
        result = "test_won";
    else if (controlAvg > testAvg * 1.1)
        result = "control_won";
    let raw = "";
    try {
        const response = await claude_content_js_1.claudeContent.messages.create({
            model: claude_content_js_1.CONTENT_MODELS.QUALITY,
            max_tokens: 400,
            system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
            messages: [{
                    role: "user",
                    content: `Experiment result: control avg ${controlAvg} vs test avg ${testAvg}. Hypothesis: ${exp.hypothesis}. Result: ${result}. Return JSON: { "conclusion": string, "learning": string }`,
                }],
        });
        raw = response.content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
    }
    catch (err) {
        (0, claude_content_js_1.logContentAiFailure)("experiment evaluation", err);
    }
    const parsed = parseJson(raw);
    (0, contentDb_js_1.updateExperiment)(exp.id, {
        controlAvgViews: controlAvg,
        testAvgViews: testAvg,
        result,
        conclusion: parsed?.conclusion || parsed?.learning || "Experiment complete.",
        status: "complete",
        evaluatedAt: new Date().toISOString(),
    });
    if (result === "test_won" && exp.variableTested === "hook_type") {
        const hooks = (0, contentDb_js_1.listHookLibrary)({ minUses: 1, limit: 50, order: "desc" });
        console.log(`[cm-brain] Experiment test won — ${hooks.length} hooks in library`);
    }
}
function assignVideoToExperiment(videoId) {
    (0, contentDb_js_1.assignVideoToExperiment)(videoId);
}
