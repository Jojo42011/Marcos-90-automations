"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAnthropicConfigured = isAnthropicConfigured;
exports.startJob = startJob;
exports.runJob = runJob;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const modelRouting_js_1 = require("./modelRouting.js");
const tools_js_1 = require("./tools.js");
const agentLoop_js_1 = require("./agentLoop.js");
const jobStore_js_1 = require("../core/jobStore.js");
/**
 * Runs a Harvey job to completion, detached from any HTTP request.
 *
 * The interactive loop caps at 8 tool rounds and lives inside the request that
 * started it, which is right for chat and useless for real work: "go through
 * every hot seller and draft a follow-up" needs dozens of rounds and minutes of
 * wall time. This runner has a much higher ceiling, writes every step to disk as
 * it goes so progress is visible while it runs, and cannot take the HTTP
 * response down with it.
 *
 * It deliberately does NOT retry a failed job automatically. These tools send
 * email and move real records; a silent re-run could do the same thing twice.
 */
const MAX_JOB_STEPS = 40;
const MAX_TOOL_CHARS = 12000;
function jobSystemPrompt() {
    return [
        "You are Harvey, running a background job for Marco Puga's real-estate business.",
        "",
        "You are not in a conversation. Nobody will answer a follow-up question, so do",
        "not ask one — make a reasonable decision, note it, and keep going.",
        "",
        "Work the task to completion using your tools. Chain as many tool calls as you",
        "need. When you have finished, reply with a short plain-text report of what you",
        "actually did and what you found. Be specific: names, numbers, file paths.",
        "",
        "If you write anything durable, use the workspace file tools so it survives.",
        "If you genuinely cannot finish, say plainly what blocked you and what you did",
        "manage to do. Never claim an action you did not take, and never invent data —",
        "if a tool did not return it, say so.",
    ].join("\n");
}
let anthropic = null;
function client() {
    if (!anthropic)
        anthropic = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return anthropic;
}
function isAnthropicConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
/** Start a job and run it in the background. Returns immediately. */
function startJob(prompt, createdBy = "marco") {
    const job = (0, jobStore_js_1.createJob)(prompt, createdBy);
    // Deliberately not awaited: the caller gets an id straight back and polls.
    void runJob(job.id).catch((err) => {
        console.error("[HarveyJob] runner crashed:", err);
        (0, jobStore_js_1.finishJob)(job.id, "failed", { error: err instanceof Error ? err.message : String(err) });
    });
    return job;
}
async function runJob(jobId) {
    const job = (0, jobStore_js_1.getJob)(jobId);
    if (!job)
        return null;
    if (!isAnthropicConfigured()) {
        return (0, jobStore_js_1.finishJob)(jobId, "failed", { error: "ANTHROPIC_API_KEY is not set." });
    }
    (0, jobStore_js_1.markRunning)(jobId);
    const tools = (0, tools_js_1.getHullToolDefinitions)({});
    const messages = [{ role: "user", content: job.prompt }];
    let steps = 0;
    try {
        for (steps = 0; steps < MAX_JOB_STEPS; steps++) {
            if ((0, jobStore_js_1.isCancelRequested)(jobId)) {
                (0, jobStore_js_1.appendStep)(jobId, { kind: "result", text: "Cancelled by request." });
                return (0, jobStore_js_1.finishJob)(jobId, "cancelled", { result: "Cancelled before completion." });
            }
            const response = await client().messages.create({
                model: (0, modelRouting_js_1.getAethonModel)(),
                max_tokens: (0, modelRouting_js_1.getMaxTokens)(),
                system: jobSystemPrompt(),
                tools,
                messages,
            });
            const text = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text.trim())
                .filter(Boolean)
                .join("\n\n");
            if (response.stop_reason !== "tool_use") {
                if (text)
                    (0, jobStore_js_1.appendStep)(jobId, { kind: "result", text });
                return (0, jobStore_js_1.finishJob)(jobId, "done", { result: text || "(no output)" });
            }
            if (text)
                (0, jobStore_js_1.appendStep)(jobId, { kind: "thought", text });
            const toolUses = response.content.filter((b) => b.type === "tool_use");
            messages.push({ role: "assistant", content: response.content });
            const results = [];
            for (const tu of toolUses) {
                let out;
                let wrote;
                try {
                    const raw = await (0, tools_js_1.executeHullTool)(tu.name, (tu.input || {}));
                    out = (0, agentLoop_js_1.serializeToolResult)(raw);
                    /* Take the path from the tool's own RESULT, not from the truncated
                       input echo — the result is small, structured, and only present when
                       the write actually succeeded. */
                    if (raw && typeof raw === "object") {
                        const r = raw;
                        if (r.ok === true && typeof r.path === "string" && r.path)
                            wrote = r.path;
                    }
                }
                catch (err) {
                    out = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
                }
                (0, jobStore_js_1.appendStep)(jobId, {
                    kind: "tool",
                    tool: tu.name,
                    input: JSON.stringify(tu.input ?? {}).slice(0, 600),
                    output: out.slice(0, 900),
                    file: wrote,
                });
                results.push({
                    type: "tool_result",
                    tool_use_id: tu.id,
                    content: out.slice(0, MAX_TOOL_CHARS),
                });
            }
            messages.push({ role: "user", content: results });
        }
        // Ran out of steps: say so rather than pretending it finished.
        (0, jobStore_js_1.appendStep)(jobId, {
            kind: "error",
            text: `Stopped after ${MAX_JOB_STEPS} steps without a final answer.`,
        });
        return (0, jobStore_js_1.finishJob)(jobId, "failed", {
            error: `Hit the ${MAX_JOB_STEPS}-step ceiling. The task may be too broad — try splitting it.`,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, jobStore_js_1.appendStep)(jobId, { kind: "error", text: msg });
        return (0, jobStore_js_1.finishJob)(jobId, "failed", { error: msg });
    }
}
