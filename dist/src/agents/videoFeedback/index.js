"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateVideoImprovements = generateVideoImprovements;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const anthropic = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
async function generateVideoImprovements(video) {
    const prompt = `You are a TikTok content strategist for a real estate agent. Analyze this video's performance and give 2-4 SHORT, SPECIFIC, actionable improvement bullets.

Video caption: "${video.description}"
Views: ${video.views} | Likes: ${video.likes} | Comments: ${video.comments} | Shares: ${video.shares} | Saves: ${video.saves}
Overall score: ${video.scoreBreakdown.score}/100 (${video.scoreBreakdown.tier})
Component scores: Views ${video.scoreBreakdown.viewsScore}/100, Retention ${video.scoreBreakdown.retentionScore}/100, Saves ${video.scoreBreakdown.savesScore}/100, Shares ${video.scoreBreakdown.sharesScore}/100

Rules:
- If a component score is low (under 50), give a specific reason why and how to fix it
- If a component score is high (over 70), note what's working so it can be repeated
- Be specific to real estate content — hooks, property reveals, captions, calls to action, posting times
- Each bullet under 15 words
- Return ONLY a JSON array of strings, no markdown, no preamble

Example output:
["Strong save rate — buyers are bookmarking this, make more like it", "Hook is weak — lead with the price or wow-feature in first 2 seconds", "Low share rate — add a 'tag someone who needs this' CTA"]`;
    try {
        const response = await anthropic.messages.create({
            model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
            max_tokens: 300,
            messages: [{ role: "user", content: prompt }],
        });
        const textBlock = response.content.find((b) => b.type === "text");
        const text = textBlock && "text" in textBlock ? textBlock.text.trim() : "[]";
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        const improvements = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        return Array.isArray(improvements) ? improvements.slice(0, 4).map(String) : [];
    }
    catch (err) {
        console.error("[VideoFeedback] Generation error:", err);
        return ["Improvement analysis unavailable — try refreshing"];
    }
}
