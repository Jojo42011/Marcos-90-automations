"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeContent = exports.CONTENT_MODELS = void 0;
exports.validateAnthropicKey = validateAnthropicKey;
exports.isRetryableClaudeError = isRetryableClaudeError;
exports.logContentAiFailure = logContentAiFailure;
/**
 * Anthropic Claude client for the Content Manager system (OpenShorts pipeline,
 * Content Brain cycles, clip enhancement, compliance-adjacent analysis).
 *
 * Scoped intentionally to content manager: Harvey (src/harvey/*) and the DM
 * agent (src/app/pipeline.ts, webhook.ts) each already construct their own
 * Anthropic client independently (see src/harvey/communication.ts,
 * src/integrations/llm/index.ts) — that's the established pattern in this
 * codebase (a thin per-subsystem client, not one shared cross-cutting
 * module), so this file follows the same shape rather than reaching into
 * either of those.
 */
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const client = new sdk_1.default({
    apiKey: process.env.ANTHROPIC_API_KEY,
});
exports.claudeContent = client;
// Model routing — match task complexity to model cost. Override via env vars
// without a code change; these are distinct from ANTHROPIC_MODEL (used by
// Harvey/the DM agent/compliance.ts/communityManager.ts for their own single
// model) so content manager's routing never collides with those.
exports.CONTENT_MODELS = {
    // Fast structured tasks: scoring, classification, metadata extraction,
    // simple summaries.
    FAST: process.env.CONTENT_MODEL_FAST || "claude-haiku-4-5-20251001",
    // Creative and reasoning tasks: hook writing, caption generation, trend
    // analysis, strategy. This is Marco's actual published content — it needs
    // to be genuinely good, not just fast.
    QUALITY: process.env.CONTENT_MODEL_QUALITY || "claude-sonnet-5",
};
/**
 * True when a non-empty, correctly-formatted ANTHROPIC_API_KEY is present.
 * Billing/quota problems can still surface at request time — this only
 * confirms the key is shaped right, not that it works.
 */
function validateAnthropicKey() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
        console.error("[content-manager] ANTHROPIC_API_KEY not set. AI analysis will not work.");
        return false;
    }
    if (!key.startsWith("sk-ant-")) {
        console.error("[content-manager] ANTHROPIC_API_KEY appears invalid (expected sk-ant-... prefix). " +
            "Check your environment variables.");
        return false;
    }
    return true;
}
function anthropicHttpStatus(err) {
    if (err && typeof err === "object" && "status" in err) {
        const s = err.status;
        return typeof s === "number" ? s : undefined;
    }
    return undefined;
}
/** True for transient errors worth a caller-side retry (rate limit / overload). */
function isRetryableClaudeError(err) {
    const status = anthropicHttpStatus(err);
    return status === 429 || status === 503 || status === 529;
}
/**
 * Phase 5b — consistent [content-ai] failure logging across every call site,
 * so a grep for that tag in Fly logs surfaces every content-AI failure with
 * which task failed, the actual error, and whether it's worth retrying.
 */
function logContentAiFailure(task, err) {
    const status = anthropicHttpStatus(err);
    const msg = err instanceof Error ? err.message : String(err);
    const retryable = isRetryableClaudeError(err) ? "retryable" : "non-retryable";
    console.error(`[content-ai] ${task} failed (${retryable}${status ? `, HTTP ${status}` : ""}): ${msg}`);
}
