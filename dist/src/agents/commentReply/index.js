"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCommentReply = generateCommentReply;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const socialStore_js_1 = require("../../core/socialStore.js");
const anthropic = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const MARCO_VOICE_PROMPT = `You are writing TikTok comment replies in Marco Puga's voice — a friendly, 
approachable San Antonio real estate agent. Keep replies short (1-2 sentences), warm, casual, 
and use light emoji occasionally. Never sound corporate. Examples of his voice:
"Thanks for watching! DM me for more details 🙌"
"This one's a beauty right? Let me know if you want more info!"
"Appreciate you! Yes it's still available, send me a DM"

For negative or hostile comments, still write a reply but it will be held for human review — 
keep it professional, brief, and de-escalating.`;
function classifySentiment(text) {
    const lower = text.toLowerCase();
    const negativeIndicators = [
        "scam",
        "fake",
        "overpriced",
        "ugly",
        "hate",
        "terrible",
        "worst",
        "stupid",
        "dumb",
        "rip off",
        "too expensive",
        "never",
        "awful",
    ];
    const positiveIndicators = [
        "love",
        "beautiful",
        "amazing",
        "awesome",
        "gorgeous",
        "nice",
        "great",
        "wow",
        "stunning",
        "perfect",
        "🔥",
        "😍",
        "❤️",
    ];
    const hasNegative = negativeIndicators.some((word) => lower.includes(word));
    const hasPositive = positiveIndicators.some((word) => lower.includes(word));
    if (hasNegative)
        return "negative";
    if (hasPositive)
        return "positive";
    return "neutral";
}
async function generateCommentReply(commentText, authorUsername, postId) {
    const sentiment = classifySentiment(commentText);
    const requiresApproval = sentiment === "negative";
    let generatedReply = "";
    try {
        const response = await anthropic.messages.create({
            model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
            max_tokens: 150,
            system: MARCO_VOICE_PROMPT,
            messages: [
                {
                    role: "user",
                    content: `Comment from @${authorUsername}: "${commentText}"\n\nWrite a reply in Marco's voice.`,
                },
            ],
        });
        const textBlock = response.content.find((b) => b.type === "text");
        generatedReply =
            textBlock && "text" in textBlock ? textBlock.text.trim() : "Thanks for watching! 🙌";
    }
    catch (err) {
        console.error("[CommentReply] Generation error:", err);
        generatedReply =
            sentiment === "negative"
                ? "Thanks for your feedback — happy to chat more, feel free to DM."
                : "Thanks for watching! 🙌";
    }
    const reply = (0, socialStore_js_1.createCommentReply)({
        postId,
        commentText,
        authorUsername,
        sentiment,
        generatedReply,
        status: "pending",
        requiresApproval,
    });
    console.log("[CommentReply] Generated for @" +
        authorUsername +
        " — sentiment:", sentiment, "requiresApproval:", requiresApproval);
    return reply;
}
