"use strict";
/**
 * Harvey operator: chat (direct Claude + tools) and ops (perception → judgment).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHarveyOps = runHarveyOps;
exports.runHarveyChat = runHarveyChat;
exports.getHarveyModel = getHarveyModel;
require("dotenv/config");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const perception_js_1 = require("./perception.js");
const judgment_js_1 = require("./judgment.js");
const memory_js_1 = require("./memory.js");
const tools_js_1 = require("./tools.js");
const index_js_1 = require("../integrations/llm/index.js");
const episodes_js_1 = require("./memory/episodes.js");
const retrieval_js_1 = require("./memory/retrieval.js");
const panelNormalizer_js_1 = require("./panelNormalizer.js");
const noteCapture_js_1 = require("./noteCapture.js");
const HARVEY_MODEL = process.env.HARVEY_MODEL?.trim() || "claude-sonnet-4-20250514";
const MAX_TOOL_ROUNDS = 6;
const HARVEY_SYSTEM_PROMPT = `You are Harvey, an AI operations assistant built for Marco Puga, a real estate agent in San Antonio, Texas operating under Aethon Intelligence.

You have direct access to Marco's live business data through tools. Use them dynamically — if Marco asks about leads, pull the data. If he asks about a specific person, search for them. If he asks what needs attention, get hot leads and stalled leads. You decide which tool fits the question.

Marco's business context:
- Runs Instagram and TikTok DM automation — AI qualifies leads and captures phone numbers
- Two active ad campaigns: Canyon Lake (a $365k 3/2 listing) and Low Interest Rate creative
- Sendblue SMS line: +18184588632 — leads text here after phone is captured in DMs
- Brivity CRM for transaction management
- Funnel stages: new → opening_asked_first_time → opening_offered_details → phone_requested → phone_captured → property_sent → criteria_collected → email_sent
- Hot leads = phone captured but not yet texted on Sendblue

How to talk:
- Ops partner tone — direct, numeric, no filler
- Lead with the number or the answer, explain after if needed
- Short responses unless Marco needs a full breakdown
- Never say "I don't have access to that" — use your tools first
- If you don't know something after checking tools, say so plainly

Reply in plain text only (no JSON wrappers).

MARCO'S NUMBERS (answer from these when asked):
$20M Goal by Nov 30 2026: $5.96M banked (29.8%), $14.04M gap, 14 deals, avg $425K/deal
Daily targets: 7 videos + 725 calls
TikTok (174 days, 124 videos): 738K views, 3 closings, 5,957 avg views/video, 28.7s watch time
TikTok funnel: 246K views → 1,359 comments → 272 DMs → 136 phones → 7 consults → 1 closing
At 5 vids/week = 1 closing/8wks. Need 10.3 vids/week for monthly closing.
Mojo (Jan-May 2026): 26,938 calls → 846 contacts → 4 closings, 1 contact per 32 calls
Mojo funnel: 6,734 calls → 212 contacts → 9 consults → 1 closing
Cold calling is 36x more efficient per touch than TikTok`;
function getClient() {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key)
        return null;
    return new sdk_1.default({ apiKey: key });
}
function extractAssistantText(content) {
    const parts = [];
    for (const block of content) {
        if (block.type === "text" && block.text.trim()) {
            parts.push(block.text.trim());
        }
    }
    return parts.join("\n\n").trim();
}
async function runHarveyToolRound(client, messages, systemPrompt) {
    let lastPanel = null;
    let response = await client.messages.create({
        model: HARVEY_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages,
        tools: tools_js_1.HARVEY_TOOL_DEFINITIONS,
    });
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (response.stop_reason !== "tool_use") {
            const text = extractAssistantText(response.content);
            return { speech: text || "No response from Harvey.", panel: lastPanel };
        }
        const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
        const toolResults = await Promise.all(toolUseBlocks.map(async (tu) => {
            const input = tu.input && typeof tu.input === "object" && !Array.isArray(tu.input)
                ? tu.input
                : {};
            let result;
            try {
                result = await (0, tools_js_1.executeHarveyTool)(tu.name, input);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                result = { error: msg };
            }
            const normalized = (0, panelNormalizer_js_1.normalizeToolResult)(tu.name, result);
            if (normalized)
                lastPanel = normalized;
            return {
                type: "tool_result",
                tool_use_id: tu.id,
                content: JSON.stringify(result),
            };
        }));
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
        response = await client.messages.create({
            model: HARVEY_MODEL,
            max_tokens: 1024,
            system: systemPrompt,
            messages,
            tools: tools_js_1.HARVEY_TOOL_DEFINITIONS,
        });
    }
    const text = extractAssistantText(response.content);
    return {
        speech: text || "Harvey hit the tool loop limit — try a narrower question.",
        panel: lastPanel,
    };
}
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
    if (!trimmed) {
        throw new Error("Missing message");
    }
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
            metrics: {
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
            },
            reply: speech,
        };
    }
    const history = (0, memory_js_1.getSessionHistory)(sessionId);
    const sessionMemory = (0, memory_js_1.historyToAnthropicMessages)(history);
    const memories = (0, retrieval_js_1.retrieveMemories)(trimmed);
    const memoryContext = (0, retrieval_js_1.formatMemoriesForPrompt)(memories);
    const systemWithMemory = memoryContext
        ? `${HARVEY_SYSTEM_PROMPT}\n\n[RECALLED MEMORY]\n${memoryContext}`
        : HARVEY_SYSTEM_PROMPT;
    let speech;
    let ui = { panel: "ops", action: "none", data: {} };
    const client = getClient();
    const inferredPanel = (0, panelNormalizer_js_1.inferPanelFromMessage)(trimmed);
    if (!client || !(0, index_js_1.isAnthropicApiKeyConfigured)()) {
        speech =
            "Anthropic is offline — set ANTHROPIC_API_KEY in .env for full Harvey with live lead tools.";
        const inferredUi = (0, panelNormalizer_js_1.panelResultToUi)(inferredPanel);
        if (inferredUi)
            ui = inferredUi;
    }
    else {
        const userContent = memoryContext
            ? `[HARVEY MEMORY]\n${memoryContext}\n\n[USER MESSAGE]\n${trimmed}`
            : trimmed;
        const messages = [
            ...sessionMemory,
            { role: "user", content: userContent },
        ];
        try {
            const round = await runHarveyToolRound(client, messages, systemWithMemory);
            speech = round.speech;
            const toolUi = (0, panelNormalizer_js_1.panelResultToUi)(round.panel);
            const messageUi = (0, panelNormalizer_js_1.panelResultToUi)(inferredPanel);
            if (toolUi)
                ui = toolUi;
            else if (messageUi)
                ui = messageUi;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[harvey/chat]", msg);
            speech = `Hit an API error: ${msg}. Check ANTHROPIC_API_KEY and billing, then try again.`;
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
    void (0, episodes_js_1.createEpisode)(sessionId, episodeTurns);
    return {
        speech,
        sessionId,
        intent: "general",
        ui,
        directives: [],
        metrics: {
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
        },
        reply: speech,
    };
}
function getHarveyModel() {
    return HARVEY_MODEL;
}
