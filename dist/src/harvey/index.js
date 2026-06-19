"use strict";
/**
 * Harvey operator — powered by Aethon Intelligence hull.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHarveyOps = runHarveyOps;
exports.runHarveyChat = runHarveyChat;
exports.getHarveyModel = getHarveyModel;
exports.runHarveyTool = runHarveyTool;
const perception_js_1 = require("./perception.js");
const judgment_js_1 = require("./judgment.js");
const memory_js_1 = require("./memory.js");
const index_js_1 = require("../integrations/llm/index.js");
const noteCapture_js_1 = require("./noteCapture.js");
const panelNormalizer_js_1 = require("./panelNormalizer.js");
const agentLoop_js_1 = require("../hull/agentLoop.js");
const extraction_js_1 = require("../hull/memory/extraction.js");
const modelRouting_js_1 = require("../hull/modelRouting.js");
const tools_js_1 = require("../hull/tools.js");
async function runHarveyOps(deps) {
    const context = await (0, perception_js_1.buildHarveyContext)(deps);
    const judgment = (0, judgment_js_1.runJudgment)(context, "");
    return {
        context,
        judgment,
        metrics: (0, perception_js_1.contextToMetricsPanel)(context),
    };
}
async function runHarveyChat(input) {
    const sessionId = (0, memory_js_1.getOrCreateSessionId)(input.sessionId);
    const trimmed = input.message.trim();
    if (!trimmed)
        throw new Error("Missing message");
    const capturedNote = (0, noteCapture_js_1.tryCaptureNote)(trimmed, "text");
    if (capturedNote) {
        const speech = "Got it — I've saved that note.";
        (0, memory_js_1.appendSessionTurn)(sessionId, "user", trimmed);
        (0, memory_js_1.appendSessionTurn)(sessionId, "assistant", speech);
        return {
            speech,
            sessionId,
            intent: "general",
            ui: { panel: "note_saved", action: "open", data: { note: capturedNote } },
            directives: [],
            metrics: emptyMetrics(),
            reply: speech,
        };
    }
    const history = (0, memory_js_1.getSessionHistory)(sessionId);
    const sessionMemory = (0, memory_js_1.historyToAnthropicMessages)(history);
    const inferredPanel = (0, panelNormalizer_js_1.inferPanelFromMessage)(trimmed);
    let ui = { panel: "ops", action: "none", data: {} };
    let speech;
    if (!(0, index_js_1.isAnthropicApiKeyConfigured)()) {
        speech =
            "Anthropic is offline — set ANTHROPIC_API_KEY in .env for full Harvey with live lead tools.";
        const inferredUi = (0, panelNormalizer_js_1.panelResultToUi)(inferredPanel);
        if (inferredUi)
            ui = inferredUi;
    }
    else {
        try {
            const result = await (0, agentLoop_js_1.runAgentLoop)({
                message: trimmed,
                history: sessionMemory,
                voiceMode: input.voiceMode,
            });
            speech = result.speech;
            const inferredUi = (0, panelNormalizer_js_1.panelResultToUi)(inferredPanel);
            if (inferredUi)
                ui = inferredUi;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[harvey/chat]", msg);
            speech = `Hit an API error: ${msg}`;
            const inferredUi = (0, panelNormalizer_js_1.panelResultToUi)(inferredPanel);
            if (inferredUi)
                ui = inferredUi;
        }
    }
    (0, memory_js_1.appendSessionTurn)(sessionId, "user", trimmed);
    (0, memory_js_1.appendSessionTurn)(sessionId, "assistant", speech);
    const episodeTurns = [
        ...history.map((t) => ({ role: t.role, text: t.content })),
        { role: "user", text: trimmed },
        { role: "assistant", text: speech },
    ];
    void (0, extraction_js_1.runPostConversationExtraction)(sessionId, episodeTurns);
    return {
        speech,
        sessionId,
        intent: "general",
        ui,
        directives: [],
        metrics: emptyMetrics(),
        reply: speech,
    };
}
function emptyMetrics() {
    return {
        totalLeads: 0,
        phonesCaptured: 0,
        emailsCaptured: 0,
        instagram: 0,
        tiktok: 0,
        canyonLakeAd: 0,
        lowInterestAd: 0,
        noInteraction: 0,
        hotNeedsSms: 0,
        phoneCaptureRatePct: 0,
        phonesLast24h: 0,
    };
}
function getHarveyModel() {
    return (0, modelRouting_js_1.getAethonModel)();
}
/** Voice / server tool execution — hull tool surface. */
async function runHarveyTool(name, input) {
    return (0, tools_js_1.executeHullTool)(name, input);
}
