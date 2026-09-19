/**
 * Which model runs which job.
 *
 * THE BIAS IS CHEAP. Harvey's traffic is overwhelmingly small work —
 * classification, memory extraction, folding a conversation, "thanks man" —
 * and the old code ran a mid-tier model for most of it because the model id was
 * a constant rather than a decision. Every job whose output is short and
 * structured defaults to the cheapest catalog entry that can still call a tool;
 * mid tier is reserved for chat with tools and long agent runs; premium is
 * never a default and only appears when an operator picks it by name.
 *
 * RESOLUTION ORDER — explicit → stored → env → built-in, then fallbacks:
 *   1. `modelOverride` on the request, i.e. the operator's pick in the picker.
 *   2. The stored per-job override in `ai_settings` (survives restarts).
 *   3. `HARVEY_MODEL_<JOB>`, the deploy-time knob.
 *   4. The built-in default below.
 * A primary whose provider has no key is never returned. Falling back to
 * something reachable and saying so beats returning a model id that cannot
 * possibly answer.
 *
 * The keyword heuristics stay in `modelRouting.ts` and are re-exported here.
 * They are the same judgement ("does this turn need tools?"), and two copies
 * would drift the first time someone adds a trigger word.
 */
import { getModelOverride } from "../../core/aiUsageStore.js";
import { isSocialTurn, needsSonnet } from "../modelRouting.js";
import {
  cheapestModel,
  configuredProviders,
  getModelInfo,
  modelIsReachable,
  toSlug,
} from "./catalog.js";
import type { ModelJob, ProviderId, ResolvedModel } from "./types.js";

export { isSocialTurn, needsSonnet };

export const MODEL_JOBS: ModelJob[] = [
  "chat_fast",
  "chat_deep",
  "agent",
  "summarize",
  "extract",
  "classify",
  "vision",
  "schedule",
];

/** What each job needs from a model, which is what makes a default defensible. */
interface JobShape {
  tier: "cheap" | "mid";
  needsTools: boolean;
  needsVision: boolean;
}

const JOB_SHAPES: Record<ModelJob, JobShape> = {
  /* No tools at all: a pleasantry that costs a tool round trip is a bug. */
  chat_fast: { tier: "cheap", needsTools: false, needsVision: false },
  chat_deep: { tier: "mid", needsTools: true, needsVision: false },
  agent: { tier: "mid", needsTools: true, needsVision: false },
  summarize: { tier: "cheap", needsTools: false, needsVision: false },
  /* Extraction and scheduling emit JSON that another function parses; a
     cheap model with tool support is exactly the right size for that. */
  extract: { tier: "cheap", needsTools: true, needsVision: false },
  classify: { tier: "cheap", needsTools: false, needsVision: false },
  vision: { tier: "cheap", needsTools: true, needsVision: true },
  schedule: { tier: "cheap", needsTools: true, needsVision: false },
};

/**
 * Built-in defaults, as slugs. Deliberately spelled out rather than computed,
 * so "what does Harvey run by default" is answerable by reading one table —
 * but validated against the catalog at resolve time, so a typo or a retired
 * model degrades to the cheapest qualifying entry instead of 404ing a turn.
 */
const DEFAULT_MODELS: Record<ModelJob, string> = {
  chat_fast: "google/gemini-3.8-flash",
  chat_deep: "anthropic/claude-sonnet-4.6",
  agent: "anthropic/claude-sonnet-4.6",
  summarize: "google/gemini-3.8-flash",
  extract: "google/gemini-3.8-flash",
  classify: "google/gemini-3.8-flash",
  vision: "google/gemini-3.8-flash",
  schedule: "google/gemini-3.8-flash",
};

const ENV_KEY: Record<ModelJob, string> = {
  chat_fast: "HARVEY_MODEL_CHAT_FAST",
  chat_deep: "HARVEY_MODEL_CHAT_DEEP",
  agent: "HARVEY_MODEL_AGENT",
  summarize: "HARVEY_MODEL_SUMMARIZE",
  extract: "HARVEY_MODEL_EXTRACT",
  classify: "HARVEY_MODEL_CLASSIFY",
  vision: "HARVEY_MODEL_VISION",
  schedule: "HARVEY_MODEL_SCHEDULE",
};

export function providerFor(model: string): ProviderId | null {
  const { openrouter, anthropic } = configuredProviders();
  if (openrouter) return "openrouter";
  if (anthropic && toSlug(model).startsWith("anthropic/")) return "anthropic";
  return null;
}

/** The chat job a turn should run as, using the existing keyword heuristics. */
export function classifyChatTurn(message: string, opts: { hasImage?: boolean } = {}): ModelJob {
  if (opts.hasImage) return "vision";
  if (isSocialTurn(message)) return "chat_fast";
  return needsSonnet(message) ? "chat_deep" : "chat_fast";
}

function storedOverride(job: ModelJob): string | null {
  try {
    return getModelOverride(job);
  } catch {
    /* The store lives on a volume that may not be writable in every context
       (a script, a cold boot). Routing must still answer. */
    return null;
  }
}

function envOverride(job: ModelJob): string | null {
  const raw = process.env[ENV_KEY[job]]?.trim();
  return raw || null;
}

/** The cheapest reachable model that satisfies the job's shape. */
function fallbackFor(job: ModelJob, exclude: string[]): string | null {
  const shape = JOB_SHAPES[job];
  const pick =
    cheapestModel({
      needsTools: shape.needsTools,
      needsVision: shape.needsVision,
      maxTier: shape.tier,
      exclude,
    }) ||
    /* Nothing in the preferred tier is reachable — widen rather than fail.
       An answer from a pricier model beats no answer. */
    cheapestModel({ needsTools: shape.needsTools, needsVision: shape.needsVision, exclude });
  return pick?.id ?? null;
}

export interface ResolveOpts {
  /** The operator's explicit pick. Beats everything else. */
  modelOverride?: string;
  /** Skip these when choosing (a model the breaker has parked, say). */
  exclude?: string[];
  /** Force the cheapest qualifying model — used when spend is near the cap. */
  forceCheap?: boolean;
}

/**
 * Resolve one job to a model, a provider and a fallback chain.
 *
 * `source` records which rung of the ladder the answer came from, so the UI can
 * say "you picked this" rather than implying Harvey chose it.
 */
export function resolveModel(job: ModelJob, opts: ResolveOpts = {}): ResolvedModel {
  const shape = JOB_SHAPES[job] || JOB_SHAPES.chat_deep;
  const exclude = (opts.exclude || []).map(toSlug);

  let source: ResolvedModel["source"] = "default";
  let candidate: string | null = null;

  if (opts.forceCheap) {
    candidate = fallbackFor(job, exclude);
    source = "fallback";
  } else if (opts.modelOverride?.trim()) {
    candidate = toSlug(opts.modelOverride.trim());
    source = "explicit";
  } else if (storedOverride(job)) {
    candidate = toSlug(storedOverride(job)!);
    source = "override";
  } else if (envOverride(job)) {
    candidate = toSlug(envOverride(job)!);
    source = "override";
  } else {
    candidate = toSlug(DEFAULT_MODELS[job] || DEFAULT_MODELS.chat_deep);
    source = "default";
  }

  /* Three ways a candidate is unusable: it is excluded, it is not in the
     catalog at all, or no configured key can reach it. All three degrade to
     the cheapest qualifying model and are reported as `fallback`, because the
     operator's pick is no longer what is running. */
  const unusable =
    !candidate ||
    exclude.includes(candidate) ||
    !getModelInfo(candidate) ||
    !modelIsReachable(candidate);
  if (unusable) {
    const alt = fallbackFor(job, exclude);
    if (alt) {
      candidate = alt;
      source = "fallback";
    }
  }

  const model = candidate || DEFAULT_MODELS[job];
  const provider = providerFor(model);

  /* The fallback chain: cheapest-first among everything else that fits the
     job, capped at two so a bad request cannot walk the whole catalog. */
  const fallbacks: string[] = [];
  const taken = [...exclude, model];
  for (let i = 0; i < 2; i++) {
    const next = fallbackFor(job, taken);
    if (!next || taken.includes(next)) break;
    fallbacks.push(next);
    taken.push(next);
  }

  return {
    job,
    provider: provider ?? "anthropic",
    model,
    fallbacks,
    source,
  };
}

/** Every job's current resolution, for the routing table in the models UI. */
export function routingTable(): Record<string, { model: string; fallbacks: string[]; source: string; provider: string }> {
  const out: Record<string, { model: string; fallbacks: string[]; source: string; provider: string }> = {};
  for (const job of MODEL_JOBS) {
    const r = resolveModel(job);
    out[job] = { model: r.model, fallbacks: r.fallbacks, source: r.source, provider: r.provider };
  }
  return out;
}
