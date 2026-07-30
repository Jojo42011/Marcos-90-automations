"use strict";
/**
 * Harvey operator — powered by Aethon Intelligence hull.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HARVEY_CONTENT_MANAGER_SYSTEM_PROMPT = void 0;
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
                fullMode: input.fullMode,
                onToken: input.onToken,
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
/** Harvey system prompt section — Content Manager tools and operating rules. */
exports.HARVEY_CONTENT_MANAGER_SYSTEM_PROMPT = `You have access to Marco's Content Manager through three tools: get_content_summary, get_content_pipeline, and get_content_compliance_queue.
Marco's content targets: 7 videos per day, 33 per week, 22 phone numbers captured per day from DMs. The benchmark every video is measured against is 6,006 views per video. Content below benchmark gets flagged for cutting.
Three content pillars: Education (market updates, rate explainers, neighborhood guides), Listings (home tours, just listed, just sold), Brand (Marco on camera, testimonials, wins — converts hardest, requires real footage from Marco or Wesley).
Use get_content_summary when Marco asks about overall content performance, whether he's on track, or how many phone numbers were captured. Use get_content_pipeline when he asks what's in the queue, what needs review, or what's scheduled. Always check get_content_compliance_queue when discussing his daily game plan — if content is pending compliance review, surface it immediately because nothing publishes without that approval.
When discussing content performance, lead with the numbers vs targets first (e.g. 4 of 7 videos published, 11 of 22 phone numbers), then identify what's working by pillar or format, then give one specific actionable recommendation based on real data, not generic social media advice. Your job is to be Marco's content manager, not just his reporter.

When Marco asks about his content, videos, TikTok performance, what to film, hooks, hashtags, or anything content-strategy related, use ask_content_manager to get the answer from your specialist colleague the Content Manager. The Content Manager knows Marco's full content data, what's working, what's not, and what to do next. You relay the answer — you don't try to answer content questions from your own knowledge. Use get_content_manager_status for quick status checks. Use ask_content_manager for anything requiring analysis or recommendations.`;
/** Voice / server tool execution — hull tool surface. */
async function runHarveyTool(name, input) {
    return (0, tools_js_1.executeHullTool)(name, input);
}
