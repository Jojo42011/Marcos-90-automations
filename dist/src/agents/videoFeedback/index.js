"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateVideoImprovements = generateVideoImprovements;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const anthropic = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const PROFESSIONAL_EDITOR_SYSTEM_PROMPT = `You are a professional video editor and content strategist specializing in real estate TikTok content. You have edited thousands of high-performing short-form videos and actively study what is working on TikTok right now.

Your editing philosophy:
- The first 0-2 seconds determine everything. If the hook fails, nothing else matters.
- Pacing is emotion. Fast cuts create excitement. Slow holds create tension. Rhythm creates trust.
- Real estate content lives and dies by the property reveal — always build anticipation before showing the home.
- Viewer retention is the only metric that compounds. Every edit decision should be made asking: "Does this make someone MORE or LESS likely to keep watching?"
- Sound design (music choice, audio levels, transitions) accounts for 40% of engagement on TikTok.

You study:
- TikTok Creator Center weekly to track what formats are trending
- Top-performing real estate accounts (Glam House Hunt, luxury real estate creators) for format inspiration
- Platform algorithm patterns — how watch time, replays, shares each affect distribution
- CapCut's native transition library and which transitions perform best by content category

When reviewing a video, you provide:
1. A HOOK SCORE (0-10) with specific reasoning
2. PACING NOTES — where the video drags or rushes, with exact second markers if possible
3. THREE SPECIFIC EDITS ranked by impact (not vague suggestions — exact, actionable changes)
4. A TRANSITION RECOMMENDATION — which transition type fits between each major scene
5. A RETENTION PREDICTION — where viewers likely drop off and why

You are direct, specific, and honest. You do not give generic advice. Every note you give should be so specific that Marco could act on it in CapCut in under 5 minutes.`;
// Pull current trends — reuse the same web search from contentSuggestions to give
// the editor live context about what's working RIGHT NOW. Non-blocking: if the
// search fails (or the export is unavailable), the editor still works.
async function editorTrendContext() {
    try {
        const { fetchCurrentContentTrends } = await Promise.resolve().then(() => __importStar(require("../contentSuggestions/index.js")));
        const trends = await fetchCurrentContentTrends();
        if (!trends || !trends.trim())
            return "";
        return `\n\nCURRENT TIKTOK TRENDS (as of this week):\n${trends}\n\nFactor these trends into your editing recommendations where relevant.`;
    }
    catch {
        return "";
    }
}
/**
 * Generate a professional-editor review for one video. Returns a formatted
 * multi-section string (Hook score / Pacing / Top 3 edits / Transitions /
 * Retention prediction) — NOT a bullet array. The caller stores it as-is and the
 * dashboard renders it as a text block.
 */
async function generateVideoImprovements(video) {
    const trendContext = await editorTrendContext();
    const videoScore = video.scoreBreakdown?.score || 0;
    const avgViews = video.avgViews || 0;
    const isUnderperforming = videoScore < 40;
    const videoContext = `
VIDEO TO REVIEW:
Title/Description: "${(video.description || "").substring(0, 200)}"
Views: ${(video.views || 0).toLocaleString()}${avgViews ? ` (channel avg: ${Math.round(avgViews).toLocaleString()})` : ""}
Performance score: ${videoScore}/100 (${video.scoreBreakdown?.tier || "unknown"})
Component scores: Views ${video.scoreBreakdown?.viewsScore ?? 0}/100, Retention ${video.scoreBreakdown?.retentionScore ?? 0}/100, Saves ${video.scoreBreakdown?.savesScore ?? 0}/100, Shares ${video.scoreBreakdown?.sharesScore ?? 0}/100
Likes: ${video.likes || 0} | Shares: ${video.shares || 0} | Saves: ${video.saves || 0} | Comments: ${video.comments || 0}
${isUnderperforming ? "⚠️ UNDERPERFORMING — needs significant editing improvement" : ""}
${video.isTopPerformer ? "⭐ TOP PERFORMER — identify what's working to replicate" : ""}

CHANNEL CONTEXT:
Marco Puga is a San Antonio real estate agent. Content focus: luxury/new-construction tours,
neighborhood guides, and first-time-buyer education. Audience: 25-50 year old buyers considering
San Antonio (Stone Oak, Canyon Lake, New Braunfels, Alamo Heights). Benchmark: 6,006 views/video.`;
    const userMessage = `${videoContext}${trendContext}

Review this video as a professional editor. Give Marco specific, actionable editing notes he can implement in CapCut today. Be direct and honest — if something isn't working, say exactly why and exactly how to fix it.

Format your response EXACTLY as:

**HOOK SCORE: X/10**
[One sentence on why]

**PACING ISSUES**
[Specific seconds where pacing breaks. If you don't have timestamp data, note what type of scene likely causes the drop]

**TOP 3 EDITS (ranked by impact)**
1. [Specific edit with exact instruction]
2. [Specific edit with exact instruction]
3. [Specific edit with exact instruction]

**TRANSITION RECOMMENDATIONS**
[Which transitions between which scenes, named as they appear in CapCut]

**RETENTION PREDICTION**
[Where viewers likely drop off and one fix for each drop point]`;
    try {
        const response = await anthropic.messages.create({
            model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
            max_tokens: 1200,
            system: PROFESSIONAL_EDITOR_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage }],
        });
        const textBlock = response.content.find((b) => b.type === "text");
        return textBlock && "text" in textBlock ? textBlock.text.trim() : "Feedback unavailable";
    }
    catch (err) {
        console.error("[VideoFeedback] Generation error:", err);
        return "Feedback generation failed — try again";
    }
}
