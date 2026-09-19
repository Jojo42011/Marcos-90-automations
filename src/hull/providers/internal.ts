/**
 * The surface every provider implements, and the error type they all raise.
 *
 * This is deliberately NOT in `types.ts`: that file is the contract Harvey's
 * callers see (jobs, messages, budgets), while this is the plumbing between
 * `index.ts` and one upstream. Keeping them apart means a second provider can
 * be added without the rest of the codebase learning anything new.
 */
import type { ProviderId } from "./types.js";
import type { ToolUse } from "./translate.js";

export interface ProviderRequest {
  /** Slug form (`vendor/model`); each provider translates to its own id space. */
  model: string;
  /** Model-level fallback chain. OpenRouter handles this server-side. */
  fallbacks?: string[];
  system?: string;
  /** Anthropic-shaped, always. Translation happens inside the provider. */
  messages: unknown[];
  tools?: unknown[];
  maxTokens: number;
  temperature?: number;
  /** When present the provider streams and calls this per text delta. */
  onToken?: (chunk: string) => void;
  timeoutMs?: number;
  /** Hard ceiling for this one call, passed through as a routing constraint. */
  maxCostUsd?: number;
}

export interface ProviderResponse {
  text: string;
  toolUses: ToolUse[];
  stopReason: string | null;
  /** What actually ran. Differs from the ask when a fallback fired. */
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** True when `costUsd` came from the catalog rather than the provider. */
  costEstimated: boolean;
}

export type ModelErrorCode =
  | "no_key"
  | "http_error"
  | "network"
  | "timeout"
  | "bad_response"
  | "budget"
  | "no_model"
  | "all_failed";

/**
 * Every failure this layer raises, with the upstream status and body attached.
 *
 * "The model call failed" is useless at 11pm. The status code and the first
 * few hundred characters of the provider's own error text are what turn it
 * into "402, insufficient credits" — so they travel with the error, redacted
 * so a key echoed back in an error body cannot reach a log or a browser.
 */
export class ModelLayerError extends Error {
  readonly code: ModelErrorCode;
  readonly status?: number;
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly body?: string;

  constructor(
    code: ModelErrorCode,
    message: string,
    extra: { status?: number; provider?: ProviderId; model?: string; body?: string } = {},
  ) {
    super(redactSecrets(message));
    this.name = "ModelLayerError";
    this.code = code;
    this.status = extra.status;
    this.provider = extra.provider;
    this.model = extra.model;
    this.body = extra.body ? redactSecrets(extra.body).slice(0, 600) : undefined;
  }

  /** One line for the usage log and for the operator. Never contains a key. */
  get summary(): string {
    const bits = [this.provider, this.model, this.status ? `HTTP ${this.status}` : null]
      .filter(Boolean)
      .join(" ");
    return `${bits ? bits + ": " : ""}${this.message}${this.body ? ` — ${this.body}` : ""}`.slice(0, 1000);
  }
}

/**
 * Strip anything that looks like a credential.
 *
 * Providers do echo request headers back in some error bodies, and those
 * bodies end up in SQLite and on screen. Matching on the known key shapes
 * (`sk-…`, `Bearer …`) is cheap insurance against writing a live key into a
 * table anyone with the dashboard can read.
 */
export function redactSecrets(text: string): string {
  return String(text ?? "")
    .replace(/\b(sk|sk-or-v1|sk-ant)-[A-Za-z0-9._\-]{8,}/g, "[redacted-key]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer [redacted]");
}
