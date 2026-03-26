/**
 * Anthropic client — Claude Haiku (not Sonnet) for tone / light generation when wired in.
 */
import "dotenv/config";
import type { Lead, Conversation } from "../../core/types.js";
import type { FunnelDeterministicMeta } from "../../app/funnelDeterministic.js";
/**
 * Single user turn: system-style `prompt` + conversation/context `context`.
 */
export declare function complete(prompt: string, context: string): Promise<string>;
export declare function getAnthropicModel(): string;
/**
 * Haiku intent gate: true only when the message clearly signals buyer / property interest.
 * On missing API key or parse/API errors, returns true (fail-open so real leads are not dropped).
 */
export declare function classifyNewLeadBuyingIntent(message: string): Promise<boolean>;
export interface ConversationLike {
    messages: {
        role: "user" | "assistant";
        text: string;
    }[];
}
export interface PreflightTurnResult {
    repeatedMessage: boolean;
    coachingNote: string;
}
/**
 * Before modules/reply: full thread → repeat signal + short coaching (2+ user messages only).
 * Combined with deterministic duplicate detection in the pipeline.
 */
export declare function preflightLeadTurnReview(input: {
    conversation: Conversation;
    leadState: string;
}): Promise<PreflightTurnResult>;
/**
 * One Haiku call: full thread + funnel JSON → next Marco DM (post–opening funnel only).
 */
export declare function generateMarcoPipelineReply(input: {
    lead: Lead;
    conversation: Conversation;
    meta: FunnelDeterministicMeta;
    preflight: PreflightTurnResult;
}): Promise<string | null>;
/**
 * Rewrites a deterministic DM in Marco's tone. Model must return ONLY JSON: {"reply_text":"..."}.
 * On any failure, returns null (caller keeps deterministic reply silently).
 */
export declare function rewriteReplyWithTone(systemPrompt: string, deterministicReply: string, conversation: ConversationLike, preflightAppendix?: string): Promise<string | null>;
//# sourceMappingURL=index.d.ts.map