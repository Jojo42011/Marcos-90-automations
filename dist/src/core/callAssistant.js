"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCallAssistantUserPrompt = buildCallAssistantUserPrompt;
exports.runCallAssistantSuggest = runCallAssistantSuggest;
exports.streamCallAssistantWords = streamCallAssistantWords;
/**
 * Real-time call assistant — Claude Sonnet (HARVEY_MODEL) for live dialer support.
 */
require("dotenv/config");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const db_js_1 = require("./db.js");
const index_js_1 = require("../harvey/index.js");
const index_js_2 = require("../integrations/llm/index.js");
const CALL_ASSISTANT_SYSTEM = `You are a real-time AI assistant supporting a real estate agent during a live phone call.
The agent needs quick, accurate talking points and answers they can use immediately.
Keep responses SHORT — 2-4 bullet points maximum.
Focus on: market data talking points, objection handling, property details, next steps.
Never suggest anything that would mislead the lead.
Format: bullet points only, no preamble, no explanations.`;
const MARCO_REAL_ESTATE_CONTEXT = `Marco Puga — San Antonio, Texas real estate agent (Aethon Intelligence).
Instagram/TikTok DM automation qualifies leads and captures phones; Twilio SMS follow-up.
Active campaigns: Canyon Lake ($365k 3/2) and low-interest-rate creative.
Funnel: DM → phone capture → property breakdown → criteria → email listings → Brivity CRM.
Hot leads = phone captured, needs timely human follow-up.`;
function getClient() {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key)
        return null;
    return new sdk_1.default({ apiKey: key });
}
function extractText(content) {
    const parts = [];
    for (const block of content) {
        if (block.type === "text" && block.text.trim())
            parts.push(block.text.trim());
    }
    return parts.join("\n").trim();
}
function leadDisplayName(lead) {
    return lead.name || lead.username || lead.phone || "Lead";
}
function criteriaSummary(lead) {
    const c = lead.criteria;
    if (!c)
        return "No criteria on file.";
    const bits = [];
    if (c.priceCap)
        bits.push(`budget up to $${c.priceCap.toLocaleString()}`);
    if (c.beds)
        bits.push(`${c.beds} bed`);
    if (c.baths)
        bits.push(`${c.baths} bath`);
    if (c.area)
        bits.push(`area: ${c.area}`);
    return bits.length ? bits.join(", ") : "No criteria on file.";
}
async function buildCallAssistantUserPrompt(leadId, question, extraContext) {
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead)
        return { prompt: "", lead: null };
    const conv = await (0, db_js_1.getConversation)(leadId);
    const recentMsgs = conv.messages.slice(-12).map((m) => `${m.role}: ${m.text}`).join("\n");
    const prompt = `${MARCO_REAL_ESTATE_CONTEXT}

Lead profile:
- Name: ${leadDisplayName(lead)}
- Phone: ${lead.phone || "—"}
- Intent: ${lead.crmIntent || "—"}
- CRM status: ${lead.crmStatus}
- Stage: ${lead.crmStage}
- Source: ${lead.source || "—"}
- Property inquired: ${lead.propertyInquired || "—"}
- Tags: ${(lead.tags || []).join(", ") || "—"}
- Funnel state: ${lead.state}
- Criteria: ${criteriaSummary(lead)}
- Notes: ${lead.crmNotes || "—"}
- Last activity: ${lead.lastActivity || "—"}

Recent conversation:
${recentMsgs || "(no messages yet)"}

Agent context (notes / what lead said):
${extraContext.trim() || "(none)"}

Agent question:
${question.trim()}`;
    return { prompt, lead };
}
async function runCallAssistantSuggest(input) {
    const { prompt, lead } = await buildCallAssistantUserPrompt(input.leadId, input.question, input.context);
    if (!lead)
        throw new Error("Lead not found");
    const timestamp = new Date().toISOString();
    if (!(0, index_js_2.isAnthropicApiKeyConfigured)()) {
        return {
            suggestions: "• Confirm their timeline and preferred areas\n• Reference Canyon Lake or similar inventory if relevant\n• Offer to email curated listings after the call",
            leadId: input.leadId,
            timestamp,
        };
    }
    const client = getClient();
    if (!client) {
        return {
            suggestions: "• API key not configured — use your standard opener and ask for timeline",
            leadId: input.leadId,
            timestamp,
        };
    }
    const response = await client.messages.create({
        model: (0, index_js_1.getHarveyModel)(),
        max_tokens: 400,
        system: CALL_ASSISTANT_SYSTEM,
        messages: [{ role: "user", content: prompt }],
    });
    const suggestions = extractText(response.content) || "• No suggestions generated.";
    return { suggestions, leadId: input.leadId, timestamp };
}
/** Yield words for SSE / WebSocket streaming. */
async function* streamCallAssistantWords(input) {
    const result = await runCallAssistantSuggest(input);
    const words = result.suggestions.split(/(\s+)/);
    for (const w of words) {
        if (w)
            yield w;
    }
}
