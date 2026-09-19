/**
 * The direct-to-Anthropic path, kept so a missing OpenRouter key cannot take
 * Harvey down.
 *
 * This is what production runs on today: `ANTHROPIC_API_KEY` is already set and
 * the SDK is already a dependency, so this file adds no secret and no package.
 * It is a fallback rather than the primary for one reason — Anthropic's
 * response carries token counts but no price, so every cost recorded through
 * here is ESTIMATED from the catalog. `costEstimated: true` travels with it so
 * the dashboard can say which dollars were measured and which were computed.
 *
 * The messages need no translation: the internal format IS Anthropic's.
 */
import Anthropic from "@anthropic-ai/sdk";

import { getModelInfo, toAnthropicId } from "./catalog.js";
import { ModelLayerError } from "./internal.js";
import { withCachedHistory, withCachedSystem, withCachedTools } from "./promptCache.js";
import type { ProviderRequest, ProviderResponse } from "./internal.js";
import type { ToolUse } from "./translate.js";

export function anthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function client(timeoutMs: number): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new ModelLayerError("no_key", "ANTHROPIC_API_KEY is not set", { provider: "anthropic" });
  }
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });
}

function usageFrom(
  raw: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined,
  slug: string,
): Pick<ProviderResponse, "promptTokens" | "completionTokens" | "cachedTokens" | "costUsd" | "costEstimated"> {
  const promptTokens = Math.max(0, Math.round(Number(raw?.input_tokens) || 0));
  const completionTokens = Math.max(0, Math.round(Number(raw?.output_tokens) || 0));
  const cachedTokens = Math.max(0, Math.round(Number(raw?.cache_read_input_tokens) || 0));
  const info = getModelInfo(slug);
  const costUsd = info
    ? (promptTokens / 1e6) * info.inputPerM + (completionTokens / 1e6) * info.outputPerM
    : 0;
  return { promptTokens, completionTokens, cachedTokens, costUsd, costEstimated: true };
}

function splitContent(content: unknown[]): { text: string; toolUses: ToolUse[] } {
  const parts: string[] = [];
  const toolUses: ToolUse[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    const block = raw as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
    if (block?.type === "text" && block.text) parts.push(block.text);
    else if (block?.type === "tool_use" && block.name) {
      toolUses.push({
        id: String(block.id || ""),
        name: String(block.name),
        input:
          block.input && typeof block.input === "object" && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {},
      });
    }
  }
  return { text: parts.join("\n\n").trim(), toolUses };
}

function wrap(err: unknown, slug: string): ModelLayerError {
  if (err instanceof ModelLayerError) return err;
  const e = err as { status?: number; message?: string; error?: unknown };
  const status = Number(e?.status) || undefined;
  let body: string | undefined;
  try {
    body = e?.error ? JSON.stringify(e.error) : undefined;
  } catch {
    body = undefined;
  }
  return new ModelLayerError(
    status ? "http_error" : "network",
    `Anthropic call failed: ${e?.message || String(err)}`,
    { status, provider: "anthropic", model: slug, body },
  );
}

export async function callAnthropic(req: ProviderRequest): Promise<ProviderResponse> {
  const slug = req.model;
  const model = toAnthropicId(slug);
  const timeout = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : 120_000;
  const anthropic = client(timeout);

  /* Cache the two blocks that are byte-identical on every turn — the tool
     schemas (~14k tokens of them) and the system prompt. Without this a
     three-word answer pays for 16k tokens of preamble every time. */
  const params: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens,
    messages: withCachedHistory(req.messages as unknown[], slug),
  };
  const system = withCachedSystem(req.system, slug);
  if (system) params.system = system;
  const tools = withCachedTools(req.tools as unknown[] | undefined, slug);
  if (Array.isArray(tools) && tools.length) params.tools = tools;
  if (typeof req.temperature === "number") params.temperature = req.temperature;

  try {
    if (req.onToken) {
      const stream = anthropic.messages.stream(params as any);
      stream.on("text", (t: string) => req.onToken?.(t));
      const final = await stream.finalMessage();
      const { text, toolUses } = splitContent(final.content as unknown[]);
      return {
        text,
        toolUses,
        stopReason: final.stop_reason ?? null,
        /* Anthropic has no fallback chain of its own — what ran is what we
           asked for, reported in slug form so callers see one id space. */
        modelUsed: slug,
        ...usageFrom(final.usage as any, slug),
      };
    }

    const res = await anthropic.messages.create(params as any);
    const { text, toolUses } = splitContent((res as any).content as unknown[]);
    return {
      text,
      toolUses,
      stopReason: (res as any).stop_reason ?? null,
      modelUsed: slug,
      ...usageFrom((res as any).usage, slug),
    };
  } catch (err) {
    throw wrap(err, slug);
  }
}
