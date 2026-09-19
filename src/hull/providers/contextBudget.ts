/**
 * How much history is allowed into one request, and what gets cut first.
 *
 * THE ADVERTISED CONTEXT WINDOW IS NOT THE BUDGET. A million-token window does
 * not mean a million useful tokens: answer quality falls off well before the
 * limit, and every token in the prompt is billed on every turn of a tool loop.
 * So the budget is a FRACTION of the window (`HARVEY_PRE_ROT_RATIO`, default
 * 0.5) under a hard ceiling (`HARVEY_CONTEXT_CEILING_TOKENS`, default 60k),
 * with a per-job ceiling under that — a classifier has no business being
 * handed 60k tokens of chat.
 *
 * ORDER OF OPERATIONS, CHEAPEST LOSS FIRST:
 *   1. Compact OLD tool results to a pointer. Tool output is re-fetchable, so
 *      it is the least damaging thing to drop, and it is usually the biggest.
 *   2. Trim the OLDEST turns. Recent turns stay raw so the model keeps the
 *      thread and the formatting.
 *   3. Say so. When turns were dropped a one-line note goes in, because a
 *      model that silently lost the first half of a conversation confidently
 *      contradicts it.
 *
 * NEVER TOUCHED: the system prompt (it carries the standing orders and the
 * safety rules — a compaction pass must not delete "ask before sending") and
 * the last user message (that is the question).
 *
 * THE TOKEN COUNT IS AN ESTIMATE. There is no tokenizer here — that would be a
 * new dependency per vendor, and vendors disagree anyway. Characters ÷ 4 plus
 * a per-message overhead is within ~10-15% for English prose, which is the
 * right accuracy for a budget whose whole job is to stay clear of the edge.
 * The billed numbers in the usage store are the provider's, never these.
 */
import { getModelInfo } from "./catalog.js";
import type { AnthropicBlock, AnthropicMessage } from "./translate.js";
import type { ContextPlan, ModelJob } from "./types.js";

/** Characters per token. English prose averages ~4; code and JSON run denser. */
const CHARS_PER_TOKEN = 4;
/** Per-message framing (role, delimiters) the wire format adds. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/**
 * What an image costs. Anthropic's own rule of thumb is width×height/750, and
 * a screenshot from the browser tool lands around 1.1-1.6k. 1,500 is a
 * deliberate over-estimate: over-reserving trims one extra turn, while
 * under-reserving overflows the window and loses the whole request.
 */
const IMAGE_TOKENS = 1500;

const DEFAULT_PRE_ROT_RATIO = 0.5;
const DEFAULT_CEILING_TOKENS = 60_000;
/** How many of the most recent tool results stay verbatim. */
const DEFAULT_RAW_TOOL_RESULTS = 3;
/** Below this a tool result is not worth compacting; the pointer costs as much. */
const MIN_COMPACTABLE_CHARS = 400;

/** Per-job hard ceilings. A cheap structured job does not need a long memory. */
const JOB_CEILINGS: Record<ModelJob, number> = {
  chat_fast: 8_000,
  chat_deep: 60_000,
  agent: 60_000,
  summarize: 24_000,
  extract: 16_000,
  classify: 4_000,
  vision: 24_000,
  schedule: 4_000,
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Characters ÷ 4. An estimate, and called one everywhere it is used. */
export function estimateTokens(text: unknown): number {
  if (typeof text !== "string" || !text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function blockTokens(block: AnthropicBlock): number {
  if (!block || typeof block !== "object") return 0;
  switch (block.type) {
    case "text":
      return estimateTokens((block as { text?: string }).text);
    case "image":
      return IMAGE_TOKENS;
    case "tool_use": {
      let json = "";
      try {
        json = JSON.stringify((block as { input?: unknown }).input ?? {});
      } catch {
        json = "";
      }
      return estimateTokens((block as { name?: string }).name) + estimateTokens(json) + 8;
    }
    case "tool_result": {
      const content = (block as { content?: unknown }).content;
      if (typeof content === "string") return estimateTokens(content) + 8;
      if (Array.isArray(content)) {
        return content.reduce((n, b) => n + blockTokens(b as AnthropicBlock), 0) + 8;
      }
      return 8;
    }
    default: {
      /* An unknown block type still occupies room. Serialising it is a rough
         but non-zero answer, which is the safe direction to be wrong in. */
      try {
        return estimateTokens(JSON.stringify(block));
      } catch {
        return 0;
      }
    }
  }
}

export function estimateMessageTokens(message: unknown): number {
  const msg = message as AnthropicMessage;
  if (!msg || typeof msg !== "object") return 0;
  const content = msg.content;
  if (typeof content === "string") return estimateTokens(content) + MESSAGE_OVERHEAD_TOKENS;
  if (!Array.isArray(content)) return MESSAGE_OVERHEAD_TOKENS;
  return content.reduce((n, b) => n + blockTokens(b), MESSAGE_OVERHEAD_TOKENS);
}

/** Tool schemas are sent on every turn and are not small — ~120 of them here. */
export function estimateToolTokens(tools: unknown[] | undefined): number {
  if (!Array.isArray(tools) || !tools.length) return 0;
  let total = 0;
  for (const t of tools) {
    try {
      total += estimateTokens(JSON.stringify(t));
    } catch {
      total += 50;
    }
  }
  return total;
}

export interface PlanContextInput {
  job: ModelJob;
  /** Slug of the model that will run, for its context window. */
  model: string;
  system?: string;
  messages: unknown[];
  tools?: unknown[];
  /** Output reservation — the window has to hold the answer too. */
  maxTokens?: number;
}

export interface PlanContextResult {
  plan: ContextPlan;
  /** The history as it should actually be sent. Input is never mutated. */
  messages: unknown[];
}

/** The input budget for this job on this model. Exported so the UI can show it. */
export function budgetFor(job: ModelJob, model: string): number {
  const info = getModelInfo(model);
  const window = info?.contextTokens ?? 128_000;
  const ratio = envNumber("HARVEY_PRE_ROT_RATIO", DEFAULT_PRE_ROT_RATIO);
  const ceiling = envNumber("HARVEY_CONTEXT_CEILING_TOKENS", DEFAULT_CEILING_TOKENS);
  const jobCeiling = JOB_CEILINGS[job] ?? DEFAULT_CEILING_TOKENS;
  return Math.max(1_000, Math.floor(Math.min(window * ratio, ceiling, jobCeiling)));
}

function isToolResultBlock(b: unknown): boolean {
  return Boolean(b) && (b as { type?: string }).type === "tool_result";
}

/** Does this message consist only of tool results? Such a message is an orphan
 *  once the assistant turn that called the tools has been trimmed away. */
function isToolResultOnly(message: unknown): boolean {
  const content = (message as AnthropicMessage)?.content;
  return Array.isArray(content) && content.length > 0 && content.every(isToolResultBlock);
}

function firstLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** Replace a tool result's body with a pointer that says what was there. */
function compactToolResult(block: AnthropicBlock): AnthropicBlock {
  const tr = block as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
  const raw =
    typeof tr.content === "string"
      ? tr.content
      : Array.isArray(tr.content)
        ? tr.content
            .map((b) => (typeof (b as { text?: string })?.text === "string" ? (b as { text: string }).text : ""))
            .join("\n")
        : "";
  return {
    type: "tool_result",
    tool_use_id: String(tr.tool_use_id ?? ""),
    /* The pointer keeps the shape of the answer (size, opening line) so the
       model can tell whether re-running the tool is worth a round trip. */
    content: `[earlier tool result compacted to save context — ${raw.length} chars. Opening: ${firstLine(raw) || "(empty)"}. Re-run the tool if you need the detail.]`,
  } as AnthropicBlock;
}

function toolResultCount(messages: unknown[]): number {
  let n = 0;
  for (const m of messages) {
    const content = (m as AnthropicMessage)?.content;
    if (Array.isArray(content)) for (const b of content) if (isToolResultBlock(b)) n++;
  }
  return n;
}

/**
 * Fit a conversation into its budget and report what that cost.
 *
 * Pure and deterministic: same inputs, same plan, no clock and no I/O beyond
 * reading the catalog and the two env knobs.
 */
export function planContext(input: PlanContextInput): PlanContextResult {
  const source = (Array.isArray(input.messages) ? input.messages : []).filter(
    (m) => m && typeof m === "object",
  );
  const budgetTokens = budgetFor(input.job, input.model);
  const fixed =
    estimateTokens(input.system) + estimateToolTokens(input.tools) + MESSAGE_OVERHEAD_TOKENS;

  const measure = (list: unknown[]): number =>
    list.reduce<number>((n, m) => n + estimateMessageTokens(m), fixed);

  let working = source.slice();
  let compactedToolResults = 0;
  let droppedTurns = 0;
  let summaryInjected = false;

  if (measure(working) > budgetTokens) {
    /* Step 1 — compact old tool results. The most recent few stay verbatim:
       they are what the model is reasoning about right now. */
    const keepRaw = Math.max(
      0,
      Math.round(envNumber("HARVEY_RAW_TOOL_RESULTS", DEFAULT_RAW_TOOL_RESULTS)),
    );
    const total = toolResultCount(working);
    const compactBefore = Math.max(0, total - keepRaw);
    let seen = 0;
    working = working.map((m) => {
      const msg = m as AnthropicMessage;
      if (!Array.isArray(msg.content)) return m;
      let changed = false;
      const content = msg.content.map((b) => {
        if (!isToolResultBlock(b)) return b;
        const index = seen++;
        if (index >= compactBefore) return b;
        const size = blockTokens(b) * CHARS_PER_TOKEN;
        if (size < MIN_COMPACTABLE_CHARS) return b;
        changed = true;
        compactedToolResults++;
        return compactToolResult(b);
      });
      return changed ? { ...msg, content } : m;
    });
  }

  if (measure(working) > budgetTokens && working.length > 1) {
    /* Step 2 — drop from the front. The last message is the question and is
       never a candidate, however large it is. */
    let start = 0;
    while (start < working.length - 1 && measure(working.slice(start)) > budgetTokens) {
      start++;
      droppedTurns++;
      /* Dropping an assistant turn that called tools would leave its results
         behind as orphans the API rejects; take them with it. */
      while (start < working.length - 1 && isToolResultOnly(working[start])) {
        start++;
        droppedTurns++;
      }
    }
    working = working.slice(start);
  }

  if (droppedTurns > 0 && working.length) {
    const note = `[Context note: ${droppedTurns} earlier turn${droppedTurns === 1 ? "" : "s"} were trimmed to fit the context budget. If something referenced earlier is missing, ask rather than assume.]`;
    const first = working[0] as AnthropicMessage;
    if (first.role === "user") {
      /* Fold the note into the first surviving user message rather than adding
         a message: two user messages in a row is a shape some providers merge
         and others reject. */
      const content: AnthropicBlock[] = [
        { type: "text", text: note },
        ...(typeof first.content === "string"
          ? ([{ type: "text", text: first.content }] as AnthropicBlock[])
          : (first.content as AnthropicBlock[])),
      ];
      working = [{ role: "user", content }, ...working.slice(1)];
    } else {
      working = [{ role: "user", content: note } as AnthropicMessage, ...working];
    }
    summaryInjected = true;
  }

  return {
    plan: {
      budgetTokens,
      estimatedTokens: measure(working),
      droppedTurns,
      compactedToolResults,
      summaryInjected,
    },
    messages: working,
  };
}
