/**
 * The model layer's front door. Everything outside `src/hull/providers/`
 * should import from HERE and from nowhere else in this folder.
 *
 * One call, `complete()`, runs the whole pipeline:
 *
 *   resolve the model  → which model for this job, with fallbacks
 *   plan the context   → trim and compact history to a pre-rot budget
 *   check the budget   → refuse, degrade, or proceed
 *   call the provider  → OpenRouter first, direct Anthropic as the backstop
 *   fall forward       → next model in the chain if one is down or parked
 *   record usage       → ALWAYS, success or failure
 *
 * WHY USAGE IS RECORDED ON FAILURES TOO. A failed call still costs latency,
 * often still costs money, and is the only evidence of an outage after the
 * fact. A row with `ok = 0` and the provider's error text is what turns "Harvey
 * was weird this afternoon" into "the 402 started at 14:05".
 *
 * NOTHING HERE LEAKS A KEY. Provider errors are wrapped in `ModelLayerError`,
 * which redacts anything key-shaped out of the message and the body before it
 * can reach SQLite, a log line or the browser.
 */
import {
  isModelPaused,
  noteFailure,
  noteSuccess,
  recordUsage,
} from "../../core/aiUsageStore.js";
import { anthropicConfigured, callAnthropic } from "./anthropicDirect.js";
import { checkBudget } from "./budget.js";
import {
  availableModels,
  catalogIsLive,
  configuredProviders,
  getModelInfo,
  refreshCatalogInBackground,
  toSlug,
} from "./catalog.js";
import { planContext } from "./contextBudget.js";
import { ModelLayerError } from "./internal.js";
import type { ProviderRequest, ProviderResponse } from "./internal.js";
import { callOpenRouter, openRouterConfigured } from "./openrouter.js";
import { resolveModel, routingTable } from "./routing.js";
import type {
  BudgetVerdict,
  CompletionRequest,
  CompletionResult,
  ContextPlan,
  ModelInfo,
  ModelJob,
  ProviderId,
  ResolvedModel,
  UsageRecord,
} from "./types.js";

export * from "./types.js";
export { ModelLayerError, redactSecrets } from "./internal.js";
export {
  availableModels,
  cheapestModel,
  getCatalog,
  getModelInfo,
  refreshCatalog,
  toSlug,
  toAnthropicId,
} from "./catalog.js";
export { planContext, estimateTokens, budgetFor } from "./contextBudget.js";
export { checkBudget } from "./budget.js";
export { classifyChatTurn, resolveModel, routingTable, MODEL_JOBS } from "./routing.js";
export { toOpenAiMessages, toOpenAiTools, fromOpenAiMessages, toolUsesFromOpenAi } from "./translate.js";

/** Raised when the spend gate refuses. Carries the verdict the UI should show. */
export class BudgetRefusedError extends ModelLayerError {
  readonly verdict: BudgetVerdict;
  constructor(verdict: BudgetVerdict) {
    super("budget", verdict.reason || "AI spend cap reached");
    this.name = "BudgetRefusedError";
    this.verdict = verdict;
  }
}

/**
 * What `complete()` returns: the contract's `CompletionResult` plus the three
 * things the chat UI has to show — how context was planned, what the budget
 * said, and how the model was chosen.
 */
export interface CompletionOutcome extends CompletionResult {
  contextPlan: ContextPlan;
  budget: BudgetVerdict;
  resolved: ResolvedModel;
  /**
   * Set when the provider ran a different model than the one asked for.
   *
   * Worth its own field because the failure it describes is invisible: the call
   * succeeds, the answer is fine, and the only trace is a different name in the
   * usage line. An operator who picked a model deserves to be told it did not
   * run, and why.
   */
  substituted?: { asked: string; ran: string };
}

/** Output reservations by job. A classifier does not need 8k tokens of room. */
const MAX_TOKENS_BY_JOB: Record<ModelJob, number> = {
  chat_fast: 1024,
  chat_deep: 8192,
  agent: 8192,
  summarize: 2048,
  extract: 2048,
  classify: 512,
  vision: 2048,
  schedule: 512,
};

function defaultMaxTokens(job: ModelJob): number {
  return MAX_TOKENS_BY_JOB[job] ?? 4096;
}

function providerChainFor(model: string): ProviderId[] {
  const chain: ProviderId[] = [];
  if (openRouterConfigured()) chain.push("openrouter");
  /* Direct Anthropic can only serve Anthropic models, but for those it is a
     genuinely independent path — a different key, a different network route —
     which is exactly what a fallback should be. */
  if (anthropicConfigured() && toSlug(model).startsWith("anthropic/")) chain.push("anthropic");
  return chain;
}

async function callProvider(provider: ProviderId, req: ProviderRequest): Promise<ProviderResponse> {
  return provider === "openrouter" ? callOpenRouter(req) : callAnthropic(req);
}

function usageRow(
  base: {
    provider: ProviderId;
    model: string;
    job: ModelJob;
    sessionId?: string;
    latencyMs: number;
  },
  res: Partial<ProviderResponse>,
  err?: string,
): UsageRecord & { modelUsed?: string } {
  return {
    provider: base.provider,
    model: base.model,
    job: base.job,
    promptTokens: res.promptTokens ?? 0,
    completionTokens: res.completionTokens ?? 0,
    cachedTokens: res.cachedTokens ?? 0,
    costUsd: res.costUsd ?? 0,
    costEstimated: res.costEstimated ?? true,
    latencyMs: base.latencyMs,
    ok: !err,
    error: err,
    sessionId: base.sessionId,
    modelUsed: res.modelUsed ?? base.model,
  };
}

/**
 * Run one completion.
 *
 * Throws `BudgetRefusedError` when the spend gate says no and
 * `ModelLayerError` when every candidate model failed. Both are typed, both
 * carry an operator-readable message, and neither can contain a key.
 */
export async function complete(req: CompletionRequest): Promise<CompletionOutcome> {
  const job: ModelJob = req.job || "chat_deep";
  const maxTokens = req.maxTokens && req.maxTokens > 0 ? req.maxTokens : defaultMaxTokens(job);

  let resolved = resolveModel(job, { modelOverride: req.modelOverride });
  let planned = planContext({
    job,
    model: resolved.model,
    system: req.system,
    messages: req.messages || [],
    tools: req.tools,
    maxTokens,
  });

  const verdict = checkBudget({
    job,
    model: resolved.model,
    estimatedInputTokens: planned.plan.estimatedTokens,
    maxTokens,
    maxCostUsd: req.maxCostUsd,
  });

  if (!verdict.allowed) {
    /* Record the refusal. A turn that never reached a provider still belongs
       in the log — otherwise "Harvey stopped answering at 4pm" has no row. */
    recordUsage(
      usageRow(
        { provider: resolved.provider, model: resolved.model, job, sessionId: req.sessionId, latencyMs: 0 },
        { costUsd: 0, costEstimated: true },
        `budget refused: ${verdict.reason || "cap reached"}`,
      ),
    );
    throw new BudgetRefusedError(verdict);
  }

  if (verdict.degradeToCheap) {
    const cheap = resolveModel(job, { forceCheap: true });
    if (cheap.model !== resolved.model) {
      resolved = cheap;
      planned = planContext({
        job,
        model: resolved.model,
        system: req.system,
        messages: req.messages || [],
        tools: req.tools,
        maxTokens,
      });
    }
  }

  /* Candidate order: the resolved primary, then its fallbacks. Models the
     breaker has parked are skipped — unless that would leave nothing, in
     which case trying a parked model beats refusing to answer at all. */
  const all = [resolved.model, ...resolved.fallbacks].filter((m, i, a) => m && a.indexOf(m) === i);
  const live = all.filter((m) => !safeBool(() => isModelPaused(m)));
  const candidates = live.length ? live : all.slice(0, 1);

  let lastError: ModelLayerError | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const providers = providerChainFor(model);
    if (!providers.length) {
      lastError = new ModelLayerError(
        "no_key",
        `No API key configured that can reach ${model}. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY.`,
        { model },
      );
      continue;
    }

    /* AN EXPLICIT PICK IS HONOURED OR IT FAILS. It is never quietly swapped.
     *
     * Handing OpenRouter a `models` chain lets it fail over server-side, which
     * is one round trip instead of two and is right when Harvey chose the model.
     * It is wrong when the OPERATOR chose it: OpenRouter then treats the chain
     * as permission to run something else, and the only signal is a different
     * name in the usage footer. That is how a picker set to GPT-5.1 spent an
     * afternoon answering on Mercury — a free-tier key caps prompt tokens per
     * request, the 14k tool preamble exceeded it for every mid-tier model, and
     * the cheapest entry in the chain was the only one allowed.
     *
     * So an explicit pick sends no chain. If it cannot run, the real error
     * surfaces (including the 402 that says to add credits) instead of a silent
     * downgrade nobody asked for. */
    const explicitPick = resolved.source === "explicit";
    const providerRequest: ProviderRequest = {
      model,
      fallbacks: explicitPick ? [] : candidates.slice(i + 1),
      system: req.system,
      messages: planned.messages,
      tools: req.tools,
      maxTokens,
      temperature: req.temperature,
      onToken: req.onToken,
      maxCostUsd: req.maxCostUsd,
    };

    for (const provider of providers) {
      const startedAt = Date.now();
      try {
        const res = await callProvider(provider, providerRequest);
        const latencyMs = Date.now() - startedAt;
        const usage = usageRow({ provider, model, job, sessionId: req.sessionId, latencyMs }, res);
        recordUsage(usage);
        safeVoid(() => noteSuccess(model));
        const ran = res.modelUsed || model;
        return {
          text: res.text,
          toolUses: res.toolUses,
          stopReason: res.stopReason,
          usage,
          modelUsed: ran,
          contextPlan: planned.plan,
          budget: verdict,
          resolved,
          substituted: ran !== model ? { asked: model, ran } : undefined,
        };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const wrapped =
          err instanceof ModelLayerError
            ? err
            : new ModelLayerError("network", err instanceof Error ? err.message : String(err), {
                provider,
                model,
              });
        lastError = wrapped;
        /* Same rule for our own loop: an explicit pick that fails is reported,
           not replaced. Trying the next candidate here would reintroduce the
           silent downgrade one layer down. */
        if (resolved.source === "explicit") {
          recordUsage(
            usageRow(
              { provider, model, job, sessionId: req.sessionId, latencyMs },
              { costUsd: 0, costEstimated: true },
              wrapped.summary,
            ),
          );
          safeVoid(() => noteFailure(model, wrapped.summary));
          throw wrapped;
        }
        recordUsage(
          usageRow(
            { provider, model, job, sessionId: req.sessionId, latencyMs },
            { costUsd: 0, costEstimated: true },
            wrapped.summary,
          ),
        );
        safeVoid(() => noteFailure(model, wrapped.summary));
        console.error(`[models] ${provider} ${model} failed: ${wrapped.summary}`);
      }
    }
  }

  throw new ModelLayerError(
    "all_failed",
    `Every model for this request failed. Last error: ${lastError?.summary || "unknown"}`,
    { model: resolved.model, status: lastError?.status },
  );
}

/* ────────────────────────── status surfaces ────────────────────────── */

export interface ProviderStatus {
  openrouter: boolean;
  anthropic: boolean;
  primary: ProviderId | null;
  /** True when catalog pricing has been refreshed from OpenRouter this boot. */
  catalogLive: boolean;
}

/** Which keys exist, and therefore who actually runs the tokens. */
export function providerStatus(): ProviderStatus {
  const { openrouter, anthropic } = configuredProviders();
  return {
    openrouter,
    anthropic,
    primary: openrouter ? "openrouter" : anthropic ? "anthropic" : null,
    catalogLive: catalogIsLive(),
  };
}

/**
 * The model picker's data. Kicks a live pricing refresh in the background —
 * this endpoint can afford to be a few hundred ms stale, a chat turn cannot,
 * which is why the refresh lives here and not in `complete()`.
 */
export function listModelsForUi(): { models: ModelInfo[]; routing: ReturnType<typeof routingTable>; provider: ProviderStatus } {
  refreshCatalogInBackground();
  return { models: availableModels(), routing: routingTable(), provider: providerStatus() };
}

/** Everything the models endpoint needs about one model, resolved. */
export function describeModel(model: string): ModelInfo | null {
  return getModelInfo(model);
}

function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

function safeVoid(fn: () => void): void {
  try {
    fn();
  } catch {
    /* Breaker bookkeeping is best-effort; it must not mask a real answer. */
  }
}
