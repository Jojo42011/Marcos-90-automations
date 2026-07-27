import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { getAethonModel, getMaxTokens } from "./modelRouting.js";
import { getHullToolDefinitions, executeHullTool } from "./tools.js";
import { serializeToolResult } from "./agentLoop.js";
import {
  appendStep,
  createJob,
  finishJob,
  getJob,
  isCancelRequested,
  markRunning,
  type Job,
} from "../core/jobStore.js";

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

function jobSystemPrompt(): string {
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

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** Start a job and run it in the background. Returns immediately. */
export function startJob(prompt: string, createdBy = "marco"): Job {
  const job = createJob(prompt, createdBy);
  // Deliberately not awaited: the caller gets an id straight back and polls.
  void runJob(job.id).catch((err) => {
    console.error("[HarveyJob] runner crashed:", err);
    finishJob(job.id, "failed", { error: err instanceof Error ? err.message : String(err) });
  });
  return job;
}

export async function runJob(jobId: string): Promise<Job | null> {
  const job = getJob(jobId);
  if (!job) return null;
  if (!isAnthropicConfigured()) {
    return finishJob(jobId, "failed", { error: "ANTHROPIC_API_KEY is not set." });
  }

  markRunning(jobId);
  const tools = getHullToolDefinitions({});
  const messages: MessageParam[] = [{ role: "user", content: job.prompt }];
  let steps = 0;

  try {
    for (steps = 0; steps < MAX_JOB_STEPS; steps++) {
      if (isCancelRequested(jobId)) {
        appendStep(jobId, { kind: "result", text: "Cancelled by request." });
        return finishJob(jobId, "cancelled", { result: "Cancelled before completion." });
      }

      const response = await client().messages.create({
        model: getAethonModel(),
        max_tokens: getMaxTokens(),
        system: jobSystemPrompt(),
        tools,
        messages,
      });

      const text = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text.trim())
        .filter(Boolean)
        .join("\n\n");

      if (response.stop_reason !== "tool_use") {
        if (text) appendStep(jobId, { kind: "result", text });
        return finishJob(jobId, "done", { result: text || "(no output)" });
      }

      if (text) appendStep(jobId, { kind: "thought", text });

      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );
      messages.push({ role: "assistant", content: response.content });

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        let out: string;
        try {
          const raw = await executeHullTool(tu.name, (tu.input || {}) as Record<string, unknown>);
          out = serializeToolResult(raw);
        } catch (err) {
          out = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
        appendStep(jobId, {
          kind: "tool",
          tool: tu.name,
          input: JSON.stringify(tu.input ?? {}).slice(0, 600),
          output: out.slice(0, 900),
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
    appendStep(jobId, {
      kind: "error",
      text: `Stopped after ${MAX_JOB_STEPS} steps without a final answer.`,
    });
    return finishJob(jobId, "failed", {
      error: `Hit the ${MAX_JOB_STEPS}-step ceiling. The task may be too broad — try splitting it.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendStep(jobId, { kind: "error", text: msg });
    return finishJob(jobId, "failed", { error: msg });
  }
}
