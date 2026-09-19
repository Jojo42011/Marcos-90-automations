/**
 * The contract for Harvey's model-provider layer.
 *
 * WHY THIS FILE EXISTS FIRST. Everything under Harvey used to call the
 * Anthropic SDK directly, with model ids hardcoded in `modelRouting.ts`. That
 * makes "switch to Gemini for this turn" a code change and makes cost invisible.
 * This layer puts one seam between Harvey and whoever actually runs the tokens,
 * so the model becomes data (a picker in the UI, a row in a table) instead of a
 * deploy.
 *
 * THE INTERNAL MESSAGE FORMAT STAYS ANTHROPIC-SHAPED. ~120 tool definitions,
 * the agent loop, the memory extractor and the job runner are all written
 * against Anthropic's `MessageParam` / `Tool` types. Rewriting them to a new
 * neutral format would be a large, risky change for no user-visible gain, so
 * translation happens at the boundary (`translate.ts`) and the rest of the
 * codebase does not move.
 *
 * ONE KEY, MANY MODELS. OpenRouter is the primary provider because it is
 * OpenAI-compatible, exposes 400+ models behind a single `OPENROUTER_API_KEY`,
 * returns real cost per request in the response body (so spend is measured, not
 * estimated), and supports a model fallback chain server-side. Direct Anthropic
 * stays wired as a fallback so an absent OpenRouter key cannot take Harvey down.
 */

/** Which upstream actually ran the tokens. */
export type ProviderId = "openrouter" | "anthropic";

/**
 * The jobs Harvey runs. Model choice is per JOB, not per call site, so "which
 * model answers chat" is one row of config instead of a grep across the repo.
 */
export type ModelJob =
  /** Pleasantries and one-liners. No tools. Must be the cheapest thing available. */
  | "chat_fast"
  /** Normal operator chat with tools. The workhorse. */
  | "chat_deep"
  /** Long autonomous tool runs (background jobs, cron tasks). */
  | "agent"
  /** Conversation folding and compaction. Cheap by definition. */
  | "summarize"
  /** Post-conversation memory extraction into JSON. Cheap, structured. */
  | "extract"
  /** Short classification / routing decisions. Cheapest. */
  | "classify"
  /** Anything with an image in it (screenshots, reels, documents). */
  | "vision"
  /** Turning an operator sentence into a cron schedule. Cheap, structured. */
  | "schedule";

/** A model as Harvey knows it: what it costs, how much it can hold, what it can do. */
export interface ModelInfo {
  /** Provider-qualified slug, e.g. `anthropic/claude-sonnet-4.6`. */
  id: string;
  /** What the operator sees in the picker, e.g. "Claude Sonnet 4.6". */
  label: string;
  /** Vendor family for grouping in the UI: anthropic | openai | google | meta | other. */
  family: string;
  /** Real context window in tokens, from the catalog. */
  contextTokens: number;
  /** USD per million input tokens. */
  inputPerM: number;
  /** USD per million output tokens. */
  outputPerM: number;
  supportsTools: boolean;
  supportsVision: boolean;
  /** Rough speed/cost tier, used for defaults and for the picker's ordering. */
  tier: "cheap" | "mid" | "premium";
  /** True when this model is reachable with the keys actually configured. */
  available: boolean;
}

/** A resolved decision: this model, on this provider, with these fallbacks. */
export interface ResolvedModel {
  job: ModelJob;
  provider: ProviderId;
  /** The model that will be attempted first. */
  model: string;
  /** Tried in order if the primary fails (context length, rate limit, outage). */
  fallbacks: string[];
  /** Where the choice came from, so the UI can say why. */
  source: "explicit" | "override" | "default" | "fallback";
}

/** What a completion actually cost, read from the provider rather than guessed. */
export interface UsageRecord {
  provider: ProviderId;
  model: string;
  job: ModelJob;
  promptTokens: number;
  completionTokens: number;
  /** Cached-read tokens when the provider reports them. Cheap tokens still count. */
  cachedTokens: number;
  /**
   * USD. Authoritative when the provider returns it (OpenRouter does), estimated
   * from the catalog only when it does not. `costEstimated` says which.
   */
  costUsd: number;
  costEstimated: boolean;
  latencyMs: number;
  ok: boolean;
  error?: string;
  sessionId?: string;
  requestId?: string;
}

/** One assistant turn, normalised back into the Anthropic-ish shape callers expect. */
export interface CompletionResult {
  /** Plain text the model produced. */
  text: string;
  /** Tool calls, already translated back to Anthropic's `tool_use` shape. */
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string | null;
  usage: UsageRecord;
  /** The model that actually ran, which may be a fallback rather than the ask. */
  modelUsed: string;
}

/**
 * The budget verdict. Checked BEFORE the network call, because the only reliable
 * way not to spend money is not to make the request.
 */
export interface BudgetVerdict {
  allowed: boolean;
  /** Operator-readable reason when refused. Surfaced in the UI verbatim. */
  reason?: string;
  spentTodayUsd: number;
  spentMonthUsd: number;
  dailyCapUsd: number;
  monthlyCapUsd: number;
  /** True when the caller should downgrade to a cheaper model instead of refusing. */
  degradeToCheap?: boolean;
}

/**
 * The context plan for one call: what we are allowed to send, and what got cut.
 *
 * Context is regulated on a PRE-ROT budget, not the model's advertised window.
 * Published context windows are far larger than the range where models actually
 * stay sharp, and filling one both degrades the answer and bills for the
 * privilege. So the budget is a fraction of the window with a hard ceiling, and
 * history is trimmed to fit before the request is built.
 */
export interface ContextPlan {
  /** Tokens we will allow into this request, input side. */
  budgetTokens: number;
  /** Estimated tokens in the request as actually assembled. */
  estimatedTokens: number;
  /** Turns dropped from the front of the history. */
  droppedTurns: number;
  /** Tool results replaced with a pointer/summary rather than raw text. */
  compactedToolResults: number;
  /** True when a summary of the dropped turns was injected. */
  summaryInjected: boolean;
}

/** Everything a caller can ask the layer for. */
export interface CompletionRequest {
  job: ModelJob;
  /** Anthropic-shaped messages. Translated at the boundary. */
  messages: unknown[];
  system?: string;
  /** Anthropic-shaped tool definitions. Translated at the boundary. */
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  /** Operator's explicit pick from the model picker. Beats routing defaults. */
  modelOverride?: string;
  sessionId?: string;
  /** Streaming sink. When present the layer streams and still reports usage. */
  onToken?: (chunk: string) => void;
  /** Refuse rather than silently spend more than this on one call. */
  maxCostUsd?: number;
}
