"use strict";
/**
 * Harvey communication — Sonnet operator voice + structured response.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCommunication = runCommunication;
exports.getHarveyModel = getHarveyModel;
require("dotenv/config");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const perception_js_1 = require("./perception.js");
const memory_js_1 = require("./memory.js");
const HARVEY_MODEL = process.env.HARVEY_MODEL?.trim() || "claude-sonnet-4-6";
const REAL_ESTATE_KB = `
MARCO OPERATIONS KNOWLEDGE (static):
- Market: San Antonio TX. New construction buyers often 600k+; Marco's own listings (e.g. Canyon Lake) can be lower.
- DM funnel: comment → DM → qualify → first-time buyer (FTB) question → breakdown offer → phone capture → SMS breakdown end of day (not instant).
- Twilio SMS handles inbound lead texts and CRM outbound; proactive automation respects texting hours and unanswered limits.
- Canyon Lake listing: Marco's listing ~$365k, 3/2, goal is showing or call close. adCampaign tag: canyon_lake_ad.
- Low interest rate ad: financing-focused creative. adCampaign tag: low_interest_ad.
- West of Stone Oak = new construction reference area in DM (do not over-disclose builder in DM).
- VA loans, FTB buyers, casita questions are common lead types.
- TikTok historically converts faster than Instagram in this stack.
- Primary metric: phone capture rate. Phone on file = hot; no phone = cold.
- Brivity = external CRM; sync can error. Aethon Intelligence (Jahan) runs the automation for Marco.
- Marco phone: 210-801-2380.
`.trim();
const IDENTITY_RULES = `
You are Harvey — the AI operator for Marco Puga's real estate business (Aethon Intelligence).
You are NOT a chatbot or assistant. You are a sharp, concise business partner who knows this operation deeply.

VOICE (strict):
- 2-3 sentences max unless Marco asks for a full briefing.
- No "I'd be happy to", "certainly", "as an AI", or corporate filler.
- Use exact numbers from HARVEY_CONTEXT and JUDGMENT — never vague "your leads".
- Phone captured = hot. No phone = cold.
- Distinguish Instagram vs TikTok behavior when relevant.
- Know Canyon Lake ad vs low interest ad attribution.
- Know Twilio SMS texting rules (hours, unanswered limits).
- Know funnel stage names (opening_asked_first_time, phone_requested, phone_captured, etc.).
- Lead with the most actionable insight first when asked about performance.
- Do not repeat the same briefing you already gave this session (see SESSION_HISTORY).
- If nothing material changed, say so in one line.

OUTPUT: Reply with ONLY valid JSON (no markdown fences):
{
  "speech": "string — what Harvey says to Marco",
  "intent": "briefing|hot_leads|ads|funnel|calls|general",
  "ui": { "panel": "ops|leads|ads|calls", "action": "none|review_queue", "data": {} }
}
`.trim();
function getClient() {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key)
        return null;
    return new sdk_1.default({ apiKey: key });
}
function fallbackResponse(ctx, judgment, sessionId) {
    const speech = `${judgment.briefingSeed} Anthropic is offline — set ANTHROPIC_API_KEY for full Harvey.`;
    return {
        speech,
        intent: "briefing",
        ui: { panel: "ops", action: "none", data: {} },
        directives: judgment.directives,
        sessionId,
        metrics: (0, perception_js_1.contextToMetricsPanel)(ctx),
        reply: speech,
    };
}
function parseHarveyJson(raw) {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start)
        return null;
    try {
        return JSON.parse(trimmed.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
async function runCommunication(input) {
    const client = getClient();
    if (!client) {
        return fallbackResponse(input.ctx, input.judgment, input.sessionId);
    }
    const system = [
        IDENTITY_RULES,
        REAL_ESTATE_KB,
        `HARVEY_CONTEXT:\n${JSON.stringify(input.ctx, null, 2)}`,
        `JUDGMENT:\n${JSON.stringify({
            focus: input.judgment.focus,
            directives: input.judgment.directives,
            briefingSeed: input.judgment.briefingSeed,
        }, null, 2)}`,
    ].join("\n\n");
    const historyMsgs = (0, memory_js_1.historyToAnthropicMessages)(input.history);
    const messages = [
        ...historyMsgs,
        {
            role: "user",
            content: `Marco says: ${input.operatorMessage}\n\nRespond in JSON only.`,
        },
    ];
    try {
        const response = await client.messages.create({
            model: HARVEY_MODEL,
            max_tokens: 1024,
            system,
            messages,
        });
        const block = response.content[0];
        const text = block.type === "text" ? block.text : "";
        const parsed = parseHarveyJson(text);
        const speech = typeof parsed?.speech === "string" && parsed.speech.trim()
            ? parsed.speech.trim()
            : text.trim() || input.judgment.briefingSeed;
        const intent = typeof parsed?.intent === "string" && parsed.intent.trim()
            ? parsed.intent.trim()
            : "general";
        const ui = parsed?.ui &&
            typeof parsed.ui === "object" &&
            parsed.ui !== null &&
            !Array.isArray(parsed.ui)
            ? {
                panel: String(parsed.ui.panel || "ops"),
                action: String(parsed.ui.action || "none"),
                data: parsed.ui.data &&
                    typeof parsed.ui.data === "object"
                    ? parsed.ui.data
                    : {},
            }
            : { panel: "ops", action: "none", data: {} };
        return {
            speech,
            intent,
            ui,
            directives: input.judgment.directives,
            sessionId: input.sessionId,
            metrics: (0, perception_js_1.contextToMetricsPanel)(input.ctx),
            reply: speech,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[harvey/communication]", msg);
        const speech = `Hit an API error: ${msg}. ${input.judgment.briefingSeed}`;
        return {
            speech,
            intent: "error",
            ui: { panel: "ops", action: "none", data: { error: msg } },
            directives: input.judgment.directives,
            sessionId: input.sessionId,
            metrics: (0, perception_js_1.contextToMetricsPanel)(input.ctx),
            reply: speech,
        };
    }
}
function getHarveyModel() {
    return HARVEY_MODEL;
}
